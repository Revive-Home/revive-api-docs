import fs from 'node:fs';
import path from 'node:path';

const ORG = 'Revive-Home';
const REPOS = ['revive-dashboard', 'revive-admin', 'revive-mobile', 'revive-api'];

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

    grouped[repo].push({
      number: pr.number,
      title: pr.title,
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
