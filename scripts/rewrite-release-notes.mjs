// Rewrites existing monthly release-notes pages in the AI style: one block per release
// date, PRs listed once (in the first release they shipped in), grouped by app.
// Also replaces the matching blocks in release-notes.mdx.
//
// Usage: node scripts/rewrite-release-notes.mjs [--months july-2026,august-2026,september-2026] [--dry-run]
// Env: GITHUB_TOKEN, ANTHROPIC_API_KEY
import fs from 'node:fs';
import path from 'node:path';
import { ORG, makeGhJson, getTouchedAreas, extractPrRefs } from './lib/github.mjs';
import { writeReleaseBlock } from './lib/release-writer.mjs';

const ROOT = process.cwd();
const MAIN_PAGE = path.join(ROOT, 'release-notes.mdx');
const BLOCK_RE = /^<Update[^>]*>[\s\S]*?^<\/Update>/gm;

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const monthsArg = argv[argv.indexOf('--months') + 1];
const months = (argv.includes('--months') ? monthsArg : 'july-2026,august-2026,september-2026').split(',').map((m) => m.trim());

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('Missing required env var: GITHUB_TOKEN');
const ghJson = makeGhJson(token);

const labelDate = (label) => new Date(label.replace(/^Week of /, ''));
const monthKey = (d) => `${d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase()}-${d.getUTCFullYear()}`;

function parseBlocks(mdx) {
  return [...mdx.matchAll(BLOCK_RE)].map((m) => {
    const head = m[0].match(/^<Update label="([^"]+)"(?: description="([^"]*)")?/);
    return { raw: m[0], label: head[1], description: head[2] || '', date: labelDate(head[1]), refs: extractPrRefs(m[0]) };
  });
}

const splitFrontmatter = (mdx) => {
  const end = mdx.indexOf('---', mdx.indexOf('---') + 3) + 3;
  return [mdx.slice(0, end), mdx.slice(end)];
};

async function loadPr(ref) {
  const [repo, number] = ref.split('#');
  const pr = await ghJson(`https://api.github.com/repos/${ORG}/${repo}/pulls/${number}`);
  return { ref, repo, number: Number(number), title: pr.title || '', body: pr.body || '', areas: await getTouchedAreas(ghJson, repo, number) };
}

async function main() {
  const mainMdx = fs.readFileSync(MAIN_PAGE, 'utf8');
  const target = new Set(months);
  const monthPaths = months.map((m) => path.join(ROOT, 'release-notes', `${m}.mdx`));
  for (const p of monthPaths) if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);

  // Releases from the target months, oldest first, grouped by date
  const releases = monthPaths.flatMap((p) => parseBlocks(fs.readFileSync(p, 'utf8'))).sort((a, b) => a.date - b.date);
  const earliest = Math.min(...releases.map((r) => r.date));

  // PRs already listed before the rewrite window don't get repeated
  const seen = new Set(parseBlocks(mainMdx).filter((b) => b.date < earliest).flatMap((b) => [...b.refs]));

  const byLabel = new Map();
  for (const r of releases) {
    if (!byLabel.has(r.label)) byLabel.set(r.label, { label: r.label, date: r.date, versions: [], refs: [] });
    const group = byLabel.get(r.label);
    for (const v of r.description.split(', ').filter(Boolean)) if (!group.versions.includes(v)) group.versions.push(v);
    for (const ref of r.refs) if (!seen.has(ref)) { seen.add(ref); group.refs.push(ref); }
  }

  const written = [];
  for (const group of byLabel.values()) {
    if (!group.refs.length) {
      console.log(`${group.label} (${group.versions.join(', ')}): no new PRs, skipped`);
      continue;
    }
    console.log(`${group.label} (${group.versions.join(', ')}): ${group.refs.length} PR(s)`);
    const prs = [];
    for (const ref of group.refs) prs.push(await loadPr(ref));
    const block = await writeReleaseBlock({ dateLabel: group.label, versions: group.versions, prs });
    written.push({ ...group, block });
  }

  if (dryRun) {
    console.log(written.map((w) => w.block).join('\n\n'));
    return;
  }

  // Monthly pages: newest first
  for (const [i, p] of monthPaths.entries()) {
    const [frontmatter] = splitFrontmatter(fs.readFileSync(p, 'utf8'));
    const blocks = written.filter((w) => monthKey(w.date) === months[i]).sort((a, b) => b.date - a.date).map((w) => w.block);
    fs.writeFileSync(p, `${frontmatter}\n\n${blocks.join('\n\n')}\n`);
    console.log(`Rewrote ${path.relative(ROOT, p)} with ${blocks.length} block(s)`);
  }

  // Main page: swap the target-month blocks for the new ones, in place
  const [frontmatter, body] = splitFrontmatter(mainMdx);
  const newBlocks = written.sort((a, b) => b.date - a.date).map((w) => w.block).join('\n\n');
  const matches = [...body.matchAll(BLOCK_RE)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    isTarget: target.has(monthKey(labelDate(m[0].match(/^<Update label="([^"]+)"/)[1]))),
  }));
  const first = matches.findIndex((m) => m.isTarget);
  const last = matches.findLastIndex((m) => m.isTarget);
  if (first === -1) {
    fs.writeFileSync(MAIN_PAGE, `${frontmatter}\n\n${newBlocks}\n${body}`);
  } else {
    if (matches.slice(first, last + 1).some((m) => !m.isTarget)) {
      throw new Error('release-notes.mdx has other months mixed into the rewrite range; rewrite contiguous months only');
    }
    fs.writeFileSync(MAIN_PAGE, frontmatter + body.slice(0, matches[first].start) + newBlocks + body.slice(matches[last].end));
  }
  console.log('Updated release-notes.mdx');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
