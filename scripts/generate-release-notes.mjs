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

const CODERABBIT_MARKER_RE = /^summary\s+by\s+coderabbit\s*$/i;
const CODERABBIT_SECTION_TITLES = new Set([
  'New Features',
  'Bug Fixes',
  'Improvements',
  'Refactor',
  'Chores',
  'Data',
]);

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
  const lines = [];
  lines.push('---');
  lines.push(`title: "${version}"`);
  lines.push('description: "Revive platform production release"');
  lines.push('---');
  lines.push('');
  lines.push('## Highlights');
  lines.push('');
  lines.push('- ');
  lines.push('');
  lines.push('## Changes shipped to production');
  lines.push('');

  for (const repo of REPOS) {
    const prs = grouped[repo] || [];
    lines.push(`### ${repo}`);
    lines.push('');

    if (prs.length === 0) {
      lines.push('- No production changes recorded.');
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
  lines.push('- ');
  lines.push('');
  lines.push('## Breaking changes');
  lines.push('');
  lines.push('- None.');
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
  const insertion = `\n${cardLine}\n    Production release notes.\n  </Card>`;
  current = current.slice(0, insertAt) + insertion + current.slice(insertAt);
  fs.writeFileSync(indexPath, current);
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
  const hasKnownSection = Array.from(CODERABBIT_SECTION_TITLES).some((s) =>
    blockLines.some((l) => l.trim() === s)
  );
  if (!hasKnownSection) return normalizeSummaryText(block);

  const items = [];
  let currentSection = null;

  for (const raw of blockLines) {
    const line = raw.trim();
    if (!line) continue;

    if (CODERABBIT_SECTION_TITLES.has(line)) {
      currentSection = line;
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
    'Bug Fixes': 1,
    Improvements: 2,
    Refactor: 3,
    Chores: 4,
    Data: 5,
  };

  items.sort((a, b) => (sectionPriority[a.section] ?? 99) - (sectionPriority[b.section] ?? 99));

  const selected = [];
  const seenSections = new Set();
  for (const item of items) {
    if (selected.length >= 3) break;
    // At most 2 items per section to keep it concise.
    const key = item.section;
    const countInSection = selected.filter((s) => s.section === key).length;
    if (countInSection >= 2) continue;
    selected.push(item);
    seenSections.add(key);
  }

  const rendered = selected
    .map((i) => `${i.section}: ${i.text}`)
    .join('; ');

  return normalizeSummaryText(rendered);
}

function toSingleLineSummary(text, maxLen = 140) {
  const oneLine = normalizeSummaryText(text).replace(/\s+/g, ' ');
  if (!oneLine) return '';
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
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

    const preferredSummary = extractPreferredSummaryFromBody(pr.body);
    const displaySummary = toSingleLineSummary(preferredSummary) || pr.title;

    grouped[repo].push({
      number: pr.number,
      title: displaySummary,
      url: pr.html_url,
      mergedAt: pr.merged_at,
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

  console.log(`Generated: ${mdxPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
