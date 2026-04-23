import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ORG = 'Revive-Home';
const REPOS = ['revive-dashboard', 'revive-admin', 'revive-mobile', 'revive-api'];

// PRs whose title matches any of these are silently skipped
const EXCLUDE_TITLE_PATTERNS = [
  /\bstaging\b/i,
  /^update staging\b/i,
  /^staging\b/i,
  /^merge\b/i,
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
const since   = requiredEnv('RELEASE_SINCE');
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

async function searchMergedPRs(repos) {
  const repoQuery = repos.map((r) => `repo:${ORG}/${r}`).join(' ');
  const sinceDate = since.length > 10 ? since.slice(0, 10) : since;
  const q = [repoQuery, 'is:pr', 'is:merged', `label:${label}`, `merged:>=${sinceDate}`].join(' ');
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100`;
  console.log(`  Search query: ${q}`);
  const data = await ghJson(url);
  console.log(`  Found ${data.total_count} PR(s)`);
  return data.items || [];
}

async function fetchPull(repo, number) {
  return ghJson(`https://api.github.com/repos/${ORG}/${repo}/pulls/${number}`);
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
    const tagMatch = block.match(/tags={\["([^"]+)"\]}/);
    if (descMatch && tagMatch) {
      const needle = `description="${descMatch[1]}" tags={["${tagMatch[1]}"]}`;
      if (content.includes(needle)) {
        console.log(`  Skipping ${descMatch[1]} [${tagMatch[1]}] — already present.`);
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
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Determine which repos to search
  const targetRepos = sourceRepo && REPOS.includes(sourceRepo) ? [sourceRepo] : REPOS;
  console.log(`\nGenerating release notes for ${version}`);
  console.log(`  Source repo: ${sourceRepo || '(all repos)'}`);
  console.log(`  Target repos: ${targetRepos.join(', ')}`);
  console.log(`  Label: ${label} | Since: ${since}\n`);

  const items = await searchMergedPRs(targetRepos);

  // Group PRs by repo and process each
  const grouped = Object.fromEntries(targetRepos.map((r) => [r, []]));

  for (const item of items) {
    const fullRepo = item.repository_url?.split('/repos/')[1];
    if (!fullRepo) continue;
    const [org, repo] = fullRepo.split('/');
    if (org !== ORG || !grouped[repo]) continue;

    const pr = await fetchPull(repo, item.number);
    if (!pr.merged_at) continue;

    const title = pr.title || '';
    if (EXCLUDE_TITLE_PATTERNS.some((re) => re.test(title))) {
      console.log(`  Skipping PR #${pr.number}: "${title}" (excluded pattern)`);
      continue;
    }

    // Try CodeRabbit structured summary first
    const codeRabbit = parseCodeRabbitSummary(pr.body);
    const link = `([#${pr.number}](${pr.html_url}))`;

    if (codeRabbit) {
      // Each CodeRabbit bullet is already categorized
      console.log(`  PR #${pr.number}: ${codeRabbit.new.length} new, ${codeRabbit.improved.length} improved, ${codeRabbit.fixed.length} fixed, ${codeRabbit.action.length} action`);
      grouped[repo].push({ ...codeRabbit, link, mergedAt: pr.merged_at });
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

      console.log(`  PR #${pr.number}: "${text}" → ${bucket} (no CodeRabbit)`);
      grouped[repo].push({
        new: bucket === 'new' ? [text] : [],
        improved: bucket === 'improved' ? [text] : [],
        fixed: bucket === 'fixed' ? [text] : [],
        action: bucket === 'action' ? [text] : [],
        link,
        mergedAt: pr.merged_at,
      });
    }
  }

  // Sort entries within each repo by merge date (newest first)
  for (const repo of targetRepos) {
    grouped[repo].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  }

  // Build blocks
  const today = new Date();
  const dateLabel = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const blocks = [];
  for (const repo of targetRepos) {
    const entries = grouped[repo];
    if (entries.length === 0) continue;
    blocks.push(buildUpdateBlock(repo, entries, dateLabel, version));
  }

  if (blocks.length === 0) {
    console.log('\nNo PRs found — nothing to generate.');
    return;
  }

  const releaseNotesPath = path.join(process.cwd(), 'release-notes.mdx');
  if (!fs.existsSync(releaseNotesPath)) {
    throw new Error(`Release notes page not found: ${releaseNotesPath}`);
  }

  prependUpdateToReleaseNotes(releaseNotesPath, blocks);
  console.log(`\nPrepended ${blocks.length} block(s) for ${version} to release-notes.mdx`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
