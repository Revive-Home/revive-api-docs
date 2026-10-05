import fs from 'node:fs';
import path from 'node:path';
import { extractPrRefs, getTouchedAreas } from './lib/github.mjs';
import { writeReleaseBlock } from './lib/release-writer.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ORG = 'Revive-Home';
const MONOREPO = 'revive-apps';
const APPS = ['dashboard', 'admin', 'api'];
const STANDALONE_REPOS = ['revive-mobile'];
const ALL_APPS = [...APPS, ...STANDALONE_REPOS];

// PRs whose title matches any of these are silently skipped
const EXCLUDE_TITLE_PATTERNS = [
  /\bstaging\b/i,
  /^update staging\b/i,
  /^staging\b/i,
  /^merge\b/i,
  /^chore\(release\)/i,
  /^ci[:(]/i,
  /^build[:(]/i,
];

// CodeRabbit "Summary by CodeRabbit" marker
const CODERABBIT_MARKER_RE = /^(?:[*_#]*\s*)*summary\s+by\s+coderabbit\s*(?:[*_]*\s*)$/i;

// CodeRabbit section names → which release-note bucket they belong to
const SECTION_TO_BUCKET = {
  'New Features':      'new',
  'Enhancements':      'new',
  'Bug Fixes':         'fixed',
  'Improvements':      'improved',
  'Refactor':          'improved',
  'Performance':       'improved',
  'Validation':        'improved',
  'Breaking Changes':  'action',
};

// Sections we skip entirely (internal noise)
const SKIP_SECTIONS = new Set([
  'Chores', 'Documentation', 'Tests', 'Style', 'Data', 'Other Changes',
]);

// All known section names (for parsing)
const ALL_SECTION_NAMES = new Set([
  ...Object.keys(SECTION_TO_BUCKET),
  ...SKIP_SECTIONS,
]);

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const token   = requiredEnv('GITHUB_TOKEN');
const version = requiredEnv('RELEASE_VERSION');
const since   = process.env.RELEASE_SINCE || '';
const label   = process.env.RELEASE_LABEL || 'released';

// Which repo triggered this run — if set, only generate notes for that repo
const sourceRepo = process.env.SOURCE_REPO || '';

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------
async function ghJson(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status} for ${url}: ${text}`);
  }
  return res.json();
}

async function getPreviousReleaseDate(appName) {
  // For monorepo apps, releases use tags like api-v3.2.0, dashboard-v2.2.0
  const isMonorepo = APPS.includes(appName);
  const repoName = isMonorepo ? MONOREPO : appName;
  const url = `https://api.github.com/repos/${ORG}/${repoName}/releases?per_page=20`;
  const releases = await ghJson(url);
  const published = releases.filter((r) => {
    if (r.draft || r.prerelease) return false;
    // For monorepo, only match releases tagged for this app (e.g. api-v)
    if (isMonorepo) return r.tag_name?.startsWith(`${appName}-v`);
    return true;
  });
  // The first is the current release (just published), the second is the previous one
  const prev = published.length > 1 ? published[1] : published[0];
  if (!prev) return null;
  return (prev.published_at || prev.created_at || '').slice(0, 10);
}

// For monorepo apps: use the GitHub compare API to find PRs between two release tags
async function getMonorepoPRsBetweenTags(appName, currentTag) {
  // Find the previous release tag for this app
  const url = `https://api.github.com/repos/${ORG}/${MONOREPO}/releases?per_page=30`;
  const releases = await ghJson(url);
  const appReleases = releases.filter((r) => {
    if (r.draft || r.prerelease) return false;
    return r.tag_name?.startsWith(`${appName}-v`);
  });

  // Find the current and previous tags
  const currentIdx = appReleases.findIndex((r) => r.tag_name === currentTag);
  const prevTag = currentIdx >= 0 && currentIdx < appReleases.length - 1
    ? appReleases[currentIdx + 1].tag_name
    : null;

  if (!prevTag) {
    console.log(`  No previous tag found for ${appName} before ${currentTag}, using all commits`);
  }

  // Get commits between tags (or all commits up to current tag)
  let compareUrl;
  if (prevTag) {
    compareUrl = `https://api.github.com/repos/${ORG}/${MONOREPO}/compare/${prevTag}...${currentTag}`;
    console.log(`  Comparing ${prevTag}...${currentTag}`);
  } else {
    // Fallback: get commits for the current tag
    compareUrl = `https://api.github.com/repos/${ORG}/${MONOREPO}/commits?sha=${currentTag}&per_page=100`;
  }

  const data = await ghJson(compareUrl);
  const commits = data.commits || data;

  // Extract PR numbers from merge commit messages
  const prNumbers = new Set();
  for (const commit of commits) {
    const msg = commit.commit?.message || '';
    // Match "Merge pull request #N" or "(#N)" patterns
    const mergeMatch = msg.match(/Merge pull request #(\d+)/);
    if (mergeMatch) prNumbers.add(parseInt(mergeMatch[1]));
    const inlineMatch = msg.match(/\(#(\d+)\)/);
    if (inlineMatch) prNumbers.add(parseInt(inlineMatch[1]));
  }

  console.log(`  Found ${prNumbers.size} PR(s) between ${prevTag || 'start'}...${currentTag}`);

  // Fetch full PR details
  const prs = [];
  for (const num of prNumbers) {
    try {
      const pr = await fetchPull(MONOREPO, num);
      if (pr.merged_at) prs.push(pr);
    } catch (e) {
      console.warn(`  ⚠ Could not fetch PR #${num}: ${e.message}`);
    }
  }
  return prs;
}

async function searchMergedPRs(targetApps, sinceDate) {
  // Determine which GitHub repos to search
  const searchRepos = new Set();
  for (const app of targetApps) {
    if (APPS.includes(app)) searchRepos.add(MONOREPO);
    else searchRepos.add(app); // standalone repos like revive-mobile
  }
  const repoQuery = [...searchRepos].map((r) => `repo:${ORG}/${r}`).join(' ');
  const parts = [repoQuery, 'is:pr', 'is:merged'];
  if (label) parts.push(`label:${label}`);
  if (sinceDate) parts.push(`merged:>=${sinceDate}`);
  const q = parts.join(' ');
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100`;
  console.log(`  Search query: ${q}`);
  const data = await ghJson(url);

  // If label filter returned 0 results and a label was specified, retry without it
  if (data.total_count === 0 && label) {
    console.log(`  No PRs found with label "${label}", retrying without label filter...`);
    const fallbackParts = [repoQuery, 'is:pr', 'is:merged'];
    if (sinceDate) fallbackParts.push(`merged:>=${sinceDate}`);
    const fallbackQ = fallbackParts.join(' ');
    const fallbackUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(fallbackQ)}&per_page=100`;
    console.log(`  Fallback query: ${fallbackQ}`);
    const fallbackData = await ghJson(fallbackUrl);
    console.log(`  Found ${fallbackData.total_count} PR(s)`);
    return fallbackData.items || [];
  }

  console.log(`  Found ${data.total_count} PR(s)`);
  return data.items || [];
}

async function fetchPull(repoSlug, number) {
  return ghJson(`https://api.github.com/repos/${ORG}/${repoSlug}/pulls/${number}`);
}

// Determine which app a monorepo PR belongs to based on labels or file paths
function classifyMonorepoPR(pr) {
  const labels = (pr.labels || []).map((l) => l.name.toLowerCase());
  for (const app of APPS) {
    // Check for labels like "revive-api", "revive-dashboard", "api", "dashboard"
    const short = app.replace('revive-', '');
    if (labels.includes(app) || labels.includes(short)) return app;
  }
  // Fallback: check PR title for app hints
  const title = (pr.title || '').toLowerCase();
  for (const app of APPS) {
    const short = app.replace('revive-', '');
    if (title.includes(`(${short})`) || title.includes(`[${short}]`)) return app;
  }
  return null; // could not classify
}

// ---------------------------------------------------------------------------
// Title cleaning
// ---------------------------------------------------------------------------
function cleanPRTitle(raw) {
  let t = raw.trim();

  // Strip conventional-commit prefix
  t = t.replace(/^(?:feat|fix|chore|refactor|docs|ci|style|perf|test|build)\s*(?:\([^)]*\))?\s*:\s*/i, '');

  // Branch-name style: TEC-1234/some-feature/Author-Name → some feature
  if (/^[A-Z]{2,}-\d+\//.test(t)) {
    const segs = t.split('/');
    const meaningful = segs.filter((s, i) => {
      if (/^[A-Z]{2,}-\d+$/.test(s)) return false;
      if (i === segs.length - 1 && /^[A-Z][a-z]+-[A-Z][a-z]+$/.test(s)) return false;
      return true;
    });
    if (meaningful.length > 0) t = meaningful.join(' ');
  }

  t = t.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

// ---------------------------------------------------------------------------
// CodeRabbit summary parsing — returns categorized bullet items
// ---------------------------------------------------------------------------
function isKnownSection(line) {
  let cleaned = line.replace(/^[\s*_#-]+/, '').replace(/[\s*_#]+$/, '');
  return ALL_SECTION_NAMES.has(cleaned) ? cleaned : null;
}

function parseCodeRabbitSummary(body) {
  if (!body) return null;

  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const startIdx = lines.findIndex((l) => CODERABBIT_MARKER_RE.test(l.trim()));
  if (startIdx === -1) return null;

  // Collect lines until boundary
  const blockLines = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('<!--') && t.includes('end of auto-generated')) break;
    if (t.startsWith('<!--')) continue;
    if (CODERABBIT_MARKER_RE.test(t)) break;
    if (/^#{2,6}\s+/.test(t) && !isKnownSection(t)) break;
    if (t.toLowerCase() === 'image') break;
    blockLines.push(lines[i]);
  }

  if (blockLines.length === 0) return null;

  // Parse into section → items[]
  const result = { new: [], improved: [], fixed: [], action: [] };
  let currentSection = null;
  let hasSections = false;

  for (const raw of blockLines) {
    const line = raw.trim();
    if (!line) continue;

    const sectionName = isKnownSection(line);
    if (sectionName) {
      currentSection = sectionName;
      hasSections = true;
      continue;
    }
    if (!currentSection) continue;
    if (SKIP_SECTIONS.has(currentSection)) continue;

    // Clean the bullet text
    let text = line
      .replace(/^[\s*_-]+/, '')   // strip leading bullet/bold markers
      .replace(/[\s*_]+$/, '')    // strip trailing
      .replace(/<\/?[^>]+>/g, '') // strip HTML tags
      .replace(/!?\[!?\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '') // strip nested markdown image/badge links
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, '') // strip markdown images/links
      .trim();

    if (!text) continue;

    // Sentence case
    text = text.charAt(0).toUpperCase() + text.slice(1);
    // Ensure ends with a period
    if (!/[.!?]$/.test(text)) text += '.';

    const bucket = SECTION_TO_BUCKET[currentSection];
    if (bucket && result[bucket]) {
      result[bucket].push(text);
    }
  }

  if (!hasSections) return null;

  const total = result.new.length + result.improved.length + result.fixed.length + result.action.length;
  return total > 0 ? result : null;
}

// ---------------------------------------------------------------------------
// Build the <Update> block for one repo
// ---------------------------------------------------------------------------
function buildUpdateBlock(repo, entries, dateLabel, versionLabel) {
  // Merge all entries into combined buckets
  const buckets = { new: [], improved: [], fixed: [], action: [] };

  for (const entry of entries) {
    for (const bucket of ['new', 'improved', 'fixed', 'action']) {
      for (const item of entry[bucket]) {
        buckets[bucket].push(`- ${item} ${entry.link}`);
      }
    }
  }

  const lines = [];
  lines.push(`<Update label="${dateLabel}" description="${versionLabel}" tags={["${repo}"]}>`);
  lines.push('');

  lines.push('### New');
  lines.push('');
  if (buckets.new.length > 0) buckets.new.forEach((e) => lines.push(e));
  else lines.push('No new features in this release.');
  lines.push('');

  lines.push('### Improved');
  lines.push('');
  if (buckets.improved.length > 0) buckets.improved.forEach((e) => lines.push(e));
  else lines.push('No improvements in this release.');
  lines.push('');

  lines.push('### Fixed');
  lines.push('');
  if (buckets.fixed.length > 0) buckets.fixed.forEach((e) => lines.push(e));
  else lines.push('No bug fixes in this release.');
  lines.push('');

  lines.push('### Action required');
  lines.push('');
  if (buckets.action.length > 0) buckets.action.forEach((e) => lines.push(e));
  else lines.push('No action required for existing integrations.');
  lines.push('');
  lines.push('</Update>');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Prepend to release-notes.mdx (with duplicate guard)
// ---------------------------------------------------------------------------
function prependUpdateToReleaseNotes(releaseNotesPath, blocks) {
  let content = fs.readFileSync(releaseNotesPath, 'utf8');
  const frontmatterEnd = content.indexOf('---', content.indexOf('---') + 3);
  if (frontmatterEnd === -1) return;

  const newBlocks = blocks.filter((block) => {
    const descMatch = block.match(/description="([^"]+)"/);
    const tagMatch = block.match(/tags=\{(\[[^\]]*\])\}/);
    if (descMatch && tagMatch) {
      const needle = `description="${descMatch[1]}" tags={${tagMatch[1]}}`;
      if (content.includes(needle)) {
        console.log(`  Skipping ${descMatch[1]} ${tagMatch[1]} — already present.`);
        return false;
      }
    }
    return true;
  });

  if (newBlocks.length === 0) {
    console.log('All blocks already present — nothing to prepend.');
    return;
  }

  const insertAt = frontmatterEnd + 3;
  const combined = newBlocks.join('\n\n');
  content = content.slice(0, insertAt) + '\n\n' + combined + '\n' + content.slice(insertAt);
  fs.writeFileSync(releaseNotesPath, content);
}

// ---------------------------------------------------------------------------
// Prepend to monthly release-notes file (e.g. release-notes/may-2026.mdx)
// ---------------------------------------------------------------------------
function monthlyFilePath(date = new Date()) {
  const monthName = date.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
  return path.join(process.cwd(), 'release-notes', `${monthName}-${date.getFullYear()}.mdx`);
}

// Adds a version to the description of an existing block with the same date label.
function addVersionToDateBlock(filePath, dateLabel, version) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`(<Update label="${dateLabel}" description=")([^"]*)(")`);
  const match = content.match(re);
  if (!match || match[2].split(', ').includes(version)) return false;
  fs.writeFileSync(filePath, content.replace(re, `$1$2, ${version}$3`));
  return true;
}

// New monthly pages must be in docs.json or they never show in the sidebar.
function ensureMonthInNav(fileName) {
  const docsPath = path.join(process.cwd(), 'docs.json');
  const docs = JSON.parse(fs.readFileSync(docsPath, 'utf8'));
  const page = `release-notes/${fileName.replace(/\.mdx$/, '')}`;
  const group = docs.navigation.tabs.flatMap((t) => t.groups || []).find((g) => g.pages.includes('release-notes'));
  if (!group || group.pages.includes(page)) return;
  group.pages.splice(group.pages.indexOf('release-notes') + 1, 0, page);
  fs.writeFileSync(docsPath, JSON.stringify(docs, null, 2) + '\n');
  console.log(`Added ${page} to docs.json navigation.`);
}

function prependToMonthlyFile(blocks) {
  const now = new Date();
  const monthName = now.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
  const year = now.getFullYear();
  const monthlyPath = monthlyFilePath(now);
  const fileName = path.basename(monthlyPath);
  const monthlyDir = path.dirname(monthlyPath);

  if (!fs.existsSync(monthlyDir)) {
    fs.mkdirSync(monthlyDir, { recursive: true });
  }

  const titleCase = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  const frontmatter = `---\ntitle: "${titleCase} ${year}"\ndescription: "${titleCase} ${year} release notes for the Revive platform — features, improvements, bug fixes, and breaking changes shipped across the API and frontend apps."\n---\n`;

  if (!fs.existsSync(monthlyPath)) {
    fs.writeFileSync(monthlyPath, frontmatter + '\n' + blocks.join('\n\n') + '\n');
    console.log(`Created ${fileName} with ${blocks.length} block(s).`);
    ensureMonthInNav(fileName);
    return fileName;
  }

  // File exists — prepend after frontmatter (reuse same logic)
  prependUpdateToReleaseNotes(monthlyPath, blocks);
  console.log(`Prepended ${blocks.length} block(s) to ${fileName}.`);
  return fileName;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Determine which apps to search
  const targetApps = sourceRepo && ALL_APPS.includes(sourceRepo) ? [sourceRepo] : ALL_APPS;

  // Resolve since date: use env var if provided, otherwise auto-detect from previous release
  let sinceDate = since.length > 0 ? (since.length > 10 ? since.slice(0, 10) : since) : '';
  if (!sinceDate && sourceRepo) {
    sinceDate = await getPreviousReleaseDate(sourceRepo) || '';
    if (sinceDate) console.log(`  Auto-detected since date from previous release: ${sinceDate}`);
  }

  console.log(`\nGenerating release notes for ${version}`);
  console.log(`  Source app: ${sourceRepo || '(all apps)'}`);
  console.log(`  Target apps: ${targetApps.join(', ')}`);
  console.log(`  Label: ${label} | Since: ${sinceDate || '(all time)'}\n`);

  // Group PRs by app and process each
  const grouped = Object.fromEntries(targetApps.map((r) => [r, []]));

  // For monorepo apps: use tag comparison to find PRs (much more accurate)
  const monorepoApps = targetApps.filter((a) => APPS.includes(a));
  const standaloneApps = targetApps.filter((a) => !APPS.includes(a));

  // Fetch monorepo PRs via tag comparison
  for (const app of monorepoApps) {
    const prs = await getMonorepoPRsBetweenTags(app, version);
    for (const pr of prs) {
      grouped[app].push(pr);
    }
  }

  // Fetch standalone PRs via search (existing logic)
  let standaloneItems = [];
  if (standaloneApps.length > 0) {
    standaloneItems = await searchMergedPRs(standaloneApps, sinceDate);
  }

  // Process standalone items
  for (const item of standaloneItems) {
    const fullRepo = item.repository_url?.split('/repos/')[1];
    if (!fullRepo) continue;
    const [org, repoSlug] = fullRepo.split('/');
    if (org !== ORG) continue;

    const pr = await fetchPull(repoSlug, item.number);
    if (!pr.merged_at) continue;
    const app = repoSlug;
    if (!grouped[app]) continue;
    grouped[app].push(pr);
  }

  const releaseNotesPath = path.join(process.cwd(), 'release-notes.mdx');
  if (!fs.existsSync(releaseNotesPath)) {
    throw new Error(`Release notes page not found: ${releaseNotesPath}`);
  }

  // The monorepo tag compare returns every commit between two tags, so the same PR
  // shows up in the api, admin, and dashboard releases. Only list each PR once.
  const alreadyListed = extractPrRefs(fs.readFileSync(releaseNotesPath, 'utf8'));

  // Now process all collected PRs into release note entries
  const processed = Object.fromEntries(targetApps.map((r) => [r, []]));
  const contextPrs = [];

  for (const app of targetApps) {
    for (const pr of grouped[app]) {
      const title = pr.title || '';
      if (EXCLUDE_TITLE_PATTERNS.some((re) => re.test(title))) {
        console.log(`  Skipping PR #${pr.number}: "${title}" (excluded pattern)`);
        continue;
      }

      const repo = APPS.includes(app) ? MONOREPO : app;
      const ref = `${repo}#${pr.number}`;
      if (alreadyListed.has(ref)) {
        console.log(`  Skipping PR #${pr.number}: already in an earlier release`);
        continue;
      }
      alreadyListed.add(ref);

      contextPrs.push({
        repo,
        ref,
        app,
        number: pr.number,
        title,
        url: pr.html_url,
        merged_at: pr.merged_at,
        body: pr.body || '',
      });

      // Try CodeRabbit structured summary first
      const codeRabbit = parseCodeRabbitSummary(pr.body);
      const link = `([#${pr.number}](${pr.html_url}))`;

      if (codeRabbit) {
        // Each CodeRabbit bullet is already categorized
        console.log(`  PR #${pr.number} → ${app}: ${codeRabbit.new.length} new, ${codeRabbit.improved.length} improved, ${codeRabbit.fixed.length} fixed, ${codeRabbit.action.length} action`);
        processed[app].push({ ...codeRabbit, link, mergedAt: pr.merged_at });
      } else {
        // Fallback: use cleaned title as a single entry
        const cleaned = cleanPRTitle(title);
        let text = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
        if (!/[.!?]$/.test(text)) text += '.';

        // Categorize from title keywords
        const bucket =
          /^fix/i.test(title) || /\bfix(es|ed)?\b/i.test(title) ? 'fixed' :
          /\bbreaking\b/i.test(title) ? 'action' :
          /^(refactor|improve|perf|chore|update|bump)/i.test(title) ? 'improved' :
          'new';

        console.log(`  PR #${pr.number} → ${app}: "${text}" → ${bucket} (no CodeRabbit)`);
        processed[app].push({
          new: bucket === 'new' ? [text] : [],
          improved: bucket === 'improved' ? [text] : [],
          fixed: bucket === 'fixed' ? [text] : [],
          action: bucket === 'action' ? [text] : [],
          link,
          mergedAt: pr.merged_at,
        });
      }
    }
  }

  const today = new Date();
  const dateLabel = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Try the AI writer first: one clean block for the whole release
  let blocks = [];
  if (contextPrs.length > 0 && process.env.ANTHROPIC_API_KEY) {
    try {
      for (const pr of contextPrs) pr.areas = await getTouchedAreas(ghJson, pr.repo, pr.number);
      blocks = [await writeReleaseBlock({ dateLabel, versions: [version], prs: contextPrs })];
    } catch (e) {
      console.warn(`  ⚠ AI release notes failed, falling back to PR summaries: ${e.message}`);
    }
  }

  // Hand the shipped PRs to scripts/curate-latest-features.mjs
  if (process.env.RELEASE_CONTEXT_FILE) {
    fs.writeFileSync(process.env.RELEASE_CONTEXT_FILE, JSON.stringify({ version, prs: contextPrs }, null, 2));
    console.log(`Wrote ${contextPrs.length} PR(s) to ${process.env.RELEASE_CONTEXT_FILE}`);
  }

  if (blocks.length === 0) {
    // Sort entries within each app by merge date (newest first)
    for (const app of targetApps) {
      processed[app].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
      if (processed[app].length > 0) blocks.push(buildUpdateBlock(app, processed[app], dateLabel, version));
    }
  }

  if (blocks.length === 0) {
    // Same-day releases of other apps usually ship PRs we already listed; note the version on that block.
    const added = [releaseNotesPath, monthlyFilePath()].filter((p) => addVersionToDateBlock(p, dateLabel, version));
    console.log(added.length
      ? `\nNo new PRs — added ${version} to the ${dateLabel} entry.`
      : '\nNo new PRs found — nothing to generate.');
    return;
  }

  prependUpdateToReleaseNotes(releaseNotesPath, blocks);
  console.log(`\nPrepended ${blocks.length} block(s) for ${version} to release-notes.mdx`);

  // Also write to the monthly file (e.g. release-notes/may-2026.mdx)
  const monthlyFileName = prependToMonthlyFile(blocks);
  console.log(`Monthly file: release-notes/${monthlyFileName}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
