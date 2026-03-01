import fs from 'node:fs';
import path from 'node:path';

const ORG = 'Revive-Home';
const REPOS = ['revive-dashboard', 'revive-admin', 'revive-mobile', 'revive-api'];

const EXCLUDE_TITLE_PATTERNS = [
  /\bstaging\b/i,
  /^update staging\b/i,
  /^staging\b/i,
];

const SUMMARY_HEADING_PATTERNS = [
  /^#{2,3}\s*summary\s*$/i,
  /^#{2,3}\s*tldr\s*$/i,
  /^#{2,3}\s*tl;dr\s*$/i,
  /^#{2,3}\s*overview\s*$/i,
];

// Match "Summary by CodeRabbit" in various markdown formats:
// plain text, bold (**...**), heading (## ...), or inside HTML comments
const CODERABBIT_MARKER_RE = /^(?:[*_#]*\s*)*summary\s+by\s+coderabbit\s*(?:[*_]*\s*)$/i;
const CODERABBIT_SECTION_TITLES_LIST = [
  'New Features',
  'Bug Fixes',
  'Improvements',
  'Refactor',
  'Chores',
  'Data',
  'Validation',
  'Documentation',
  'Tests',
  'Style',
  'Performance',
  'Other Changes',
  'Enhancements',
  'Breaking Changes',
];
const CODERABBIT_SECTION_TITLES = new Set(CODERABBIT_SECTION_TITLES_LIST);

// Also match bold variants like **New Features** or ### New Features
function isCodeRabbitSectionTitle(line) {
  const cleaned = line.replace(/^[*_#]+\s*/, '').replace(/\s*[*_]+$/, '').trim();
  return CODERABBIT_SECTION_TITLES.has(cleaned) ? cleaned : null;
}

/**
 * Convert raw branch-name-style PR titles into human-readable text.
 * Examples:
 *   "TEC-7097/Weekly-Update-Character-Limit/Carlo-Sanchez" → "Weekly update character limit"
 *   "feat(TEC-6520): Allow deleting L4 items in change orders" → "Allow deleting L4 items in change orders"
 *   "Sprint 3" → "Sprint 3" (unchanged)
 */
function cleanPRTitle(raw) {
  let t = raw.trim();

  // Strip conventional-commit prefixes: feat(...): fix(...): chore(...):
  t = t.replace(/^(?:feat|fix|chore|refactor|docs|ci|style|perf|test|build)\s*(?:\([^)]*\))?\s*:\s*/i, '');

  // If it looks like a branch name (has slashes), take the descriptive middle segment
  if (/^[A-Z]{2,}-\d+\//.test(t)) {
    const segments = t.split('/');
    // Remove ticket prefix segment and author suffix segment
    const meaningful = segments.filter((s) => {
      if (/^[A-Z]{2,}-\d+$/.test(s)) return false; // ticket id
      if (segments.indexOf(s) === segments.length - 1 && /^[A-Z][a-z]+-[A-Z][a-z]+$/.test(s)) return false; // Author-Name
      return true;
    });
    if (meaningful.length > 0) t = meaningful.join(' ');
  }

  // Replace hyphens with spaces, collapse whitespace
  t = t.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

  // Sentence case: capitalize first letter, lowercase the rest only if ALL CAPS
  if (t === t.toUpperCase() && t.length > 3) {
    t = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  } else {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }

  return t;
}

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const token = requiredEnv('GITHUB_TOKEN');
const version = requiredEnv('RELEASE_VERSION');

const label = process.env.RELEASE_LABEL || 'released';
const since = process.env.RELEASE_SINCE; // optional; ISO date or YYYY-MM-DD
const overwrite = (process.env.RELEASE_OVERWRITE || '').toLowerCase() === 'true';

const repoQueryParts = REPOS.map((r) => `repo:${ORG}/${r}`).join(' ');

const qParts = [
  repoQueryParts,
  'is:pr',
  'is:merged',
  `label:${label}`,
];

if (since) {
  const sinceDate = since.length > 10 ? since.slice(0, 10) : since;
  qParts.push(`merged:>=${sinceDate}`);
}

const query = qParts.join(' ');

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

async function searchMergedPRs() {
  const encoded = encodeURIComponent(query);
  const url = `https://api.github.com/search/issues?q=${encoded}&per_page=100`;
  const data = await ghJson(url);
  return data.items || [];
}

async function fetchPull(repo, number) {
  const url = `https://api.github.com/repos/${ORG}/${repo}/pulls/${number}`;
  return ghJson(url);
}

function toReleaseNotesMdx(grouped) {
  // Collect all PRs for highlights and fixes
  const allPRs = REPOS.flatMap((r) => (grouped[r] || []));
  const fixes = allPRs.filter((pr) => pr.isFix);
  const features = allPRs.filter((pr) => !pr.isFix && !pr.isSprint);

  const lines = [];
  lines.push('---');
  lines.push(`title: "${version}"`);
  lines.push('description: "Revive platform production release"');
  lines.push('---');
  lines.push('');
  lines.push('## Highlights');
  lines.push('');
  if (features.length > 0) {
    for (const pr of features.slice(0, 6)) {
      lines.push(`- ${pr.title}`);
    }
  } else if (fixes.length > 0) {
    lines.push('- Bug fixes and stability improvements');
  } else {
    lines.push('- Routine maintenance release');
  }
  lines.push('');
  lines.push('## Changes shipped to production');
  lines.push('');

  for (const repo of REPOS) {
    const prs = grouped[repo] || [];
    lines.push(`### ${repo}`);
    lines.push('');

    if (prs.length === 0) {
      lines.push('No updates in this release.');
      lines.push('');
      continue;
    }

    for (const pr of prs) {
      lines.push(`- ${pr.title} ([#${pr.number}](${pr.url}))`);
    }

    lines.push('');
  }

  lines.push('## Fixes');
  lines.push('');
  if (fixes.length > 0) {
    for (const pr of fixes) {
      lines.push(`- ${pr.title} ([#${pr.number}](${pr.url}))`);
    }
  } else {
    lines.push('No bug fixes in this release.');
  }
  lines.push('');
  lines.push('## Breaking changes');
  lines.push('');
  lines.push('No breaking changes.');
  lines.push('');

  return lines.join('\n');
}

function updateIndexMdx(indexPath) {
  const href = `/release-notes/${version}`;
  const cardLine = `  <Card title="${version}" icon="rocket" href="${href}">`;

  let current = fs.readFileSync(indexPath, 'utf8');
  if (current.includes(`href="${href}"`)) return;

  const groupTag = '<CardGroup cols={1}>';
  const idx = current.indexOf(groupTag);
  if (idx === -1) {
    throw new Error(`Could not find ${groupTag} in ${indexPath}`);
  }

  const insertAt = idx + groupTag.length;
  const insertion = `\n${cardLine}\n    See what shipped in ${version}.\n  </Card>`;
  current = current.slice(0, insertAt) + insertion + current.slice(insertAt);
  fs.writeFileSync(indexPath, current);
}

function updateDocsJson(docsJsonPath) {
  const pagePath = `release-notes/${version}`;
  const raw = fs.readFileSync(docsJsonPath, 'utf8');
  const config = JSON.parse(raw);

  // Determine the year from the version or fall back to current year
  const year = new Date().getFullYear().toString();
  const yearGroupName = `${year} Release Notes`;

  // Find the Releases group in navigation
  const tabs = config.navigation?.tabs || [];
  let releasesGroup = null;
  for (const tab of tabs) {
    for (const group of tab.groups || []) {
      if (group.group === 'Releases') {
        releasesGroup = group;
        break;
      }
    }
    if (releasesGroup) break;
  }

  if (!releasesGroup) return;

  // Find or create the year subgroup
  let yearGroup = releasesGroup.pages.find(
    (p) => typeof p === 'object' && p.group === yearGroupName
  );

  if (!yearGroup) {
    yearGroup = { group: yearGroupName, pages: [] };
    releasesGroup.pages.push(yearGroup);
  }

  // Add the page if not already present
  if (!yearGroup.pages.includes(pagePath)) {
    // Insert at the beginning so newest is first
    yearGroup.pages.unshift(pagePath);
  }

  fs.writeFileSync(docsJsonPath, JSON.stringify(config, null, 2) + '\n');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function byMergedAtDesc(a, b) {
  return b.mergedAt.localeCompare(a.mergedAt);
}

function shouldExcludePRTitle(title) {
  return EXCLUDE_TITLE_PATTERNS.some((re) => re.test(title));
}

function normalizeSummaryText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractSectionUnderHeading(body, headingMatchFn) {
  if (!body) return '';
  const lines = body.replace(/\r\n/g, '\n').split('\n');

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (headingMatchFn(line)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{2,6}\s+/.test(line)) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

function extractPreferredSummaryFromBody(body) {
  if (!body) return '';

  const codeRabbitSummary = extractCodeRabbitSummary(body);
  if (codeRabbitSummary) return codeRabbitSummary;

  for (const re of SUMMARY_HEADING_PATTERNS) {
    const section = extractSectionUnderHeading(body, (line) => re.test(line));
    const normalized = normalizeSummaryText(section);
    if (normalized) return normalized;
  }

  return '';
}

function extractCodeRabbitSummary(body) {
  if (!body) return '';

  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const startIdx = lines.findIndex((l) => CODERABBIT_MARKER_RE.test(l.trim()));
  if (startIdx === -1) return '';

  // Capture until the next obvious boundary.
  const blockLines = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) {
      // allow internal blank lines; keep them but stop if we already collected enough content
      blockLines.push('');
      continue;
    }

    // Stop if we hit another CodeRabbit marker or a markdown heading (people often paste other sections after).
    if (CODERABBIT_MARKER_RE.test(t)) break;
    if (/^#{2,6}\s+/.test(t)) break;

    // A common copy/paste artifact in the UI.
    if (t.toLowerCase() === 'image') break;

    blockLines.push(lines[i]);
  }

  const block = blockLines.join('\n').trim();
  if (!block) return '';

  // If the block isn't sectioned, just return it.
  const hasKnownSection = blockLines.some((l) => isCodeRabbitSectionTitle(l.trim()));
  if (!hasKnownSection) return normalizeSummaryText(block);

  const items = [];
  let currentSection = null;

  for (const raw of blockLines) {
    const line = raw.trim();
    if (!line) continue;

    const sectionMatch = isCodeRabbitSectionTitle(line);
    if (sectionMatch) {
      currentSection = sectionMatch;
      continue;
    }

    // Ignore sectionless lines before the first section header.
    if (!currentSection) continue;

    // Treat any non-empty line under a section as an item.
    items.push({ section: currentSection, text: line.replace(/^[-*]\s+/, '').trim() });
  }

  if (items.length === 0) return '';

  // Prefer New Features and Bug Fixes first.
  const sectionPriority = {
    'New Features': 0,
    'Enhancements': 0,
    'Bug Fixes': 1,
    'Improvements': 2,
    'Validation': 3,
    'Refactor': 4,
    'Performance': 4,
    'Chores': 5,
    'Data': 6,
    'Documentation': 7,
    'Tests': 7,
    'Style': 8,
    'Other Changes': 9,
    'Breaking Changes': 0,
  };

  items.sort((a, b) => (sectionPriority[a.section] ?? 99) - (sectionPriority[b.section] ?? 99));

  const selected = [];
  const seenSections = new Set();
  for (const item of items) {
    if (selected.length >= 4) break;
    // At most 2 items per section to keep it concise.
    const key = item.section;
    const countInSection = selected.filter((s) => s.section === key).length;
    if (countInSection >= 2) continue;
    selected.push(item);
    seenSections.add(key);
  }

  // Build a natural, conversational summary instead of "Section: text; Section: text"
  const parts = [];
  for (const item of selected) {
    // Lowercase the text start to flow naturally in a sentence
    // Trim individual items so one long bullet doesn't dominate
    let text = item.text.charAt(0).toLowerCase() + item.text.slice(1);
    if (text.length > 80) {
      const cut = text.lastIndexOf(' ', 77);
      text = text.slice(0, cut > 40 ? cut : 77) + '...';
    }
    switch (item.section) {
      case 'New Features':
      case 'Enhancements':
        parts.push(text);
        break;
      case 'Bug Fixes':
        parts.push(`fixed ${text}`);
        break;
      case 'Improvements':
        parts.push(`improved ${text}`);
        break;
      case 'Validation':
        parts.push(`added validation for ${text}`);
        break;
      case 'Performance':
        parts.push(`performance: ${text}`);
        break;
      default:
        parts.push(text);
        break;
    }
  }

  // Join into a natural sentence
  let rendered;
  if (parts.length === 1) {
    rendered = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  } else if (parts.length === 2) {
    rendered = parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ' and ' + parts[1];
  } else {
    rendered = parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ', ' + parts.slice(1, -1).join(', ') + ', and ' + parts[parts.length - 1];
  }

  return normalizeSummaryText(rendered);
}

function toSingleLineSummary(text, maxLen = 200) {
  const oneLine = normalizeSummaryText(text).replace(/\s+/g, ' ');
  if (!oneLine) return '';
  if (oneLine.length <= maxLen) return oneLine;
  // Truncate at word boundary to avoid cutting mid-word
  const truncated = oneLine.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.6) {
    return truncated.slice(0, lastSpace) + '…';
  }
  return truncated.slice(0, maxLen - 1) + '…';
}

async function main() {
  const items = await searchMergedPRs();

  const grouped = Object.fromEntries(REPOS.map((r) => [r, []]));

  for (const item of items) {
    const fullRepo = item.repository_url?.split('/repos/')[1];
    if (!fullRepo) continue;

    const [org, repo] = fullRepo.split('/');
    if (org !== ORG) continue;

    const prNumber = item.number;
    const pr = await fetchPull(repo, prNumber);

    if (!pr.merged_at) continue;

    if (shouldExcludePRTitle(pr.title)) continue;

    // Detect fix/sprint from the ORIGINAL title before any cleaning
    const originalTitle = pr.title || '';
    const isFix = /^fix/i.test(originalTitle) || /\bfix\b/i.test(originalTitle);
    const isSprint = /^sprint\s+\d+/i.test(originalTitle);

    const preferredSummary = extractPreferredSummaryFromBody(pr.body);
    let displaySummary = toSingleLineSummary(preferredSummary) || cleanPRTitle(originalTitle);

    // Make sprint PRs more descriptive
    if (isSprint && /^Sprint\s+\d+$/i.test(displaySummary)) {
      displaySummary = `${displaySummary} release bundle`;
    }

    grouped[repo].push({
      number: pr.number,
      title: displaySummary,
      url: pr.html_url,
      mergedAt: pr.merged_at,
      isFix,
      isSprint,
    });
  }

  for (const repo of REPOS) grouped[repo].sort(byMergedAtDesc);

  const outDir = path.join(process.cwd(), 'release-notes');
  ensureDir(outDir);

  const mdxPath = path.join(outDir, `${version}.mdx`);
  if (fs.existsSync(mdxPath) && !overwrite) {
    throw new Error(`Release notes already exist: ${mdxPath}. Set RELEASE_OVERWRITE=true to regenerate.`);
  }

  fs.writeFileSync(mdxPath, toReleaseNotesMdx(grouped));

  const indexPath = path.join(outDir, 'index.mdx');
  updateIndexMdx(indexPath);

  const docsJsonPath = path.join(process.cwd(), 'docs.json');
  updateDocsJson(docsJsonPath);

  console.log(`Generated: ${mdxPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
