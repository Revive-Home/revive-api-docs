#!/usr/bin/env node
/**
 * Backfill release notes for all versions found via GitHub releases/tags.
 *
 * Usage:
 *   GITHUB_TOKEN=<token> node scripts/backfill-releases.mjs
 *
 * This script:
 * 1. Fetches all GitHub releases from revive-api (the source of version truth)
 * 2. For each release, finds merged PRs labeled "released" between that release
 *    and the previous one
 * 3. Generates an MDX file per version
 * 4. Updates docs.json with all versions grouped by year
 */

import fs from 'node:fs';
import path from 'node:path';

const ORG = 'Revive-Home';
const VERSION_SOURCE_REPO = 'revive-api'; // repo that has release tags
const REPOS = ['revive-dashboard', 'revive-admin', 'revive-mobile', 'revive-api'];
const LABEL = 'released';

// ── Reuse helpers from generate-release-notes.mjs ──────────────────────

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

const CODERABBIT_MARKER_RE = /^(?:[*_#]*\s*)*summary\s+by\s+coderabbit\s*(?:[*_]*\s*)$/i;
const CODERABBIT_SECTION_TITLES_LIST = [
  'New Features', 'Bug Fixes', 'Improvements', 'Refactor', 'Chores', 'Data',
  'Validation', 'Documentation', 'Tests', 'Style', 'Performance',
  'Other Changes', 'Enhancements', 'Breaking Changes',
];
const CODERABBIT_SECTION_TITLES = new Set(CODERABBIT_SECTION_TITLES_LIST);

function isCodeRabbitSectionTitle(line) {
  let cleaned = line;
  cleaned = cleaned.replace(/^[\s*_#-]+/, '');
  cleaned = cleaned.replace(/[\s*_#]+$/, '');
  return CODERABBIT_SECTION_TITLES.has(cleaned) ? cleaned : null;
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
    if (headingMatchFn(lines[i].trim())) { start = i + 1; break; }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^#{2,6}\s+/.test(lines[i].trim())) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

function extractCodeRabbitSummary(body) {
  if (!body) return '';
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const startIdx = lines.findIndex((l) => CODERABBIT_MARKER_RE.test(l.trim()));
  if (startIdx === -1) return '';

  const blockLines = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { blockLines.push(''); continue; }
    if (t.startsWith('<!--') && t.includes('end of auto-generated')) break;
    if (t.startsWith('<!--')) continue;
    if (CODERABBIT_MARKER_RE.test(t)) break;
    if (/^#{2,6}\s+/.test(t)) break;
    if (t.toLowerCase() === 'image') break;
    blockLines.push(lines[i]);
  }

  const block = blockLines.join('\n').trim();
  if (!block) return '';

  const hasKnownSection = blockLines.some((l) => isCodeRabbitSectionTitle(l.trim()));
  if (!hasKnownSection) return normalizeSummaryText(block);

  const items = [];
  let currentSection = null;
  for (const raw of blockLines) {
    const line = raw.trim();
    if (!line) continue;
    const sectionMatch = isCodeRabbitSectionTitle(line);
    if (sectionMatch) { currentSection = sectionMatch; continue; }
    if (!currentSection) continue;
    const itemText = line.replace(/^[\s*_-]+/, '').replace(/[\s*_]+$/, '').trim();
    if (itemText) items.push({ section: currentSection, text: itemText });
  }
  if (items.length === 0) return '';

  const sectionPriority = {
    'New Features': 0, 'Enhancements': 0, 'Bug Fixes': 1, 'Improvements': 2,
    'Validation': 3, 'Refactor': 4, 'Performance': 4, 'Chores': 5, 'Data': 6,
    'Documentation': 7, 'Tests': 7, 'Style': 8, 'Other Changes': 9, 'Breaking Changes': 0,
  };
  items.sort((a, b) => (sectionPriority[a.section] ?? 99) - (sectionPriority[b.section] ?? 99));

  const selected = [];
  for (const item of items) {
    if (selected.length >= 4) break;
    const countInSection = selected.filter((s) => s.section === item.section).length;
    if (countInSection >= 2) continue;
    selected.push(item);
  }

  const parts = [];
  for (const item of selected) {
    let text = item.text.charAt(0).toLowerCase() + item.text.slice(1);
    if (text.length > 80) {
      const cut = text.lastIndexOf(' ', 77);
      text = text.slice(0, cut > 40 ? cut : 77) + '...';
    }
    switch (item.section) {
      case 'New Features': case 'Enhancements': parts.push(text); break;
      case 'Bug Fixes': parts.push(`fixed ${text}`); break;
      case 'Improvements': parts.push(`improved ${text}`); break;
      case 'Validation': parts.push(`added validation for ${text}`); break;
      default: parts.push(text); break;
    }
  }

  let rendered;
  if (parts.length === 1) rendered = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  else if (parts.length === 2) rendered = parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ' and ' + parts[1];
  else rendered = parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ', ' + parts.slice(1, -1).join(', ') + ', and ' + parts[parts.length - 1];

  return normalizeSummaryText(rendered);
}

function extractPreferredSummaryFromBody(body) {
  if (!body) return '';
  const cr = extractCodeRabbitSummary(body);
  if (cr) return cr;
  for (const re of SUMMARY_HEADING_PATTERNS) {
    const section = extractSectionUnderHeading(body, (line) => re.test(line));
    const normalized = normalizeSummaryText(section);
    if (normalized) return normalized;
  }
  return '';
}

function toSingleLineSummary(text, maxLen = 200) {
  const oneLine = normalizeSummaryText(text).replace(/\s+/g, ' ');
  if (!oneLine) return '';
  if (oneLine.length <= maxLen) return oneLine;
  const truncated = oneLine.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.6) return truncated.slice(0, lastSpace) + '…';
  return truncated.slice(0, maxLen - 1) + '…';
}

function cleanPRTitle(raw) {
  let t = raw.trim();
  t = t.replace(/^(?:feat|fix|chore|refactor|docs|ci|style|perf|test|build)\s*(?:\([^)]*\))?\s*:\s*/i, '');
  if (/^[A-Z]{2,}-\d+\//.test(t)) {
    const segments = t.split('/');
    const meaningful = segments.filter((s) => {
      if (/^[A-Z]{2,}-\d+$/.test(s)) return false;
      if (segments.indexOf(s) === segments.length - 1 && /^[A-Z][a-z]+-[A-Z][a-z]+$/.test(s)) return false;
      return true;
    });
    if (meaningful.length > 0) t = meaningful.join(' ');
  }
  t = t.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (t === t.toUpperCase() && t.length > 3) t = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  else t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

function shouldExcludePRTitle(title) {
  return EXCLUDE_TITLE_PATTERNS.some((re) => re.test(title));
}

// ── GitHub API helpers ─────────────────────────────────────────────────

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error('Set GITHUB_TOKEN env var'); process.exit(1); }

async function ghJson(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (res.ok) return res.json();

    // Handle rate limiting — wait until reset
    if (res.status === 403 || res.status === 429) {
      const resetHeader = res.headers.get('x-ratelimit-reset');
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (resetHeader && (remaining === '0' || remaining === null)) {
        const resetTime = parseInt(resetHeader, 10) * 1000;
        const waitMs = Math.max(resetTime - Date.now(), 0) + 5000; // 5s buffer
        const waitMin = Math.ceil(waitMs / 60000);
        console.log(`  ⏳ Rate limited. Waiting ${waitMin} min until reset...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue; // retry
      }
      // Secondary rate limit — exponential backoff
      const backoff = Math.pow(2, attempt) * 10000;
      console.log(`  ⏳ Rate limited (no reset header). Waiting ${Math.ceil(backoff / 1000)}s...`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    const text = await res.text();
    throw new Error(`GitHub API error ${res.status} for ${url}: ${text}`);
  }
  throw new Error(`GitHub API failed after ${retries} retries for ${url}`);
}

// Fetch all pages of results
async function ghJsonPaginated(baseUrl) {
  let page = 1;
  const all = [];
  while (true) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const data = await ghJson(`${baseUrl}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return all;
}

// ── Main logic ─────────────────────────────────────────────────────────

async function getAllReleases() {
  console.log(`Fetching releases from ${ORG}/${VERSION_SOURCE_REPO}...`);
  const releases = await ghJsonPaginated(
    `https://api.github.com/repos/${ORG}/${VERSION_SOURCE_REPO}/releases`
  );

  // Also try tags if no releases found
  if (releases.length === 0) {
    console.log('No releases found, trying tags...');
    const tags = await ghJsonPaginated(
      `https://api.github.com/repos/${ORG}/${VERSION_SOURCE_REPO}/tags`
    );
    return tags
      .filter((t) => /^v?\d+\.\d+\.\d+/.test(t.name))
      .map((t) => ({ tag: t.name, date: null }));
  }

  return releases
    .filter((r) => !r.draft)
    .map((r) => ({
      tag: r.tag_name,
      date: r.published_at || r.created_at,
    }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function getPRsForRelease(sinceDate, untilDate) {
  const repoQueryParts = REPOS.map((r) => `repo:${ORG}/${r}`).join(' ');
  const qParts = [repoQueryParts, 'is:pr', 'is:merged', `label:${LABEL}`];

  if (sinceDate) qParts.push(`merged:>=${sinceDate.slice(0, 10)}`);
  if (untilDate) qParts.push(`merged:<=${untilDate.slice(0, 10)}`);

  const query = encodeURIComponent(qParts.join(' '));
  const url = `https://api.github.com/search/issues?q=${query}&per_page=100`;

  const data = await ghJson(url);
  return data.items || [];
}

async function fetchPull(repo, number) {
  return ghJson(`https://api.github.com/repos/${ORG}/${repo}/pulls/${number}`);
}

function buildGrouped(prs) {
  const grouped = Object.fromEntries(REPOS.map((r) => [r, []]));

  for (const pr of prs) {
    const originalTitle = pr.title || '';
    const isFix = /^fix/i.test(originalTitle) || /\bfix\b/i.test(originalTitle);
    const isSprint = /^sprint\s+\d+/i.test(originalTitle);

    const preferredSummary = extractPreferredSummaryFromBody(pr.body);
    let displaySummary = toSingleLineSummary(preferredSummary) || cleanPRTitle(originalTitle);

    if (isSprint && /^Sprint\s+\d+$/i.test(displaySummary)) {
      displaySummary = `${displaySummary} release bundle`;
    }

    grouped[pr._repo].push({
      number: pr.number,
      title: displaySummary,
      url: pr.html_url,
      mergedAt: pr.merged_at,
      isFix,
      isSprint,
    });
  }

  for (const repo of REPOS) {
    grouped[repo].sort((a, b) => (b.mergedAt || '').localeCompare(a.mergedAt || ''));
  }

  return grouped;
}

function toReleaseNotesMdx(version, grouped) {
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
    for (const pr of features.slice(0, 6)) lines.push(`- ${pr.title}`);
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
    if (prs.length === 0) { lines.push('No updates in this release.'); lines.push(''); continue; }
    for (const pr of prs) lines.push(`- ${pr.title} ([#${pr.number}](${pr.url}))`);
    lines.push('');
  }

  lines.push('## Fixes');
  lines.push('');
  if (fixes.length > 0) {
    for (const pr of fixes) lines.push(`- ${pr.title} ([#${pr.number}](${pr.url}))`);
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

function updateDocsJson(docsJsonPath, versions) {
  const raw = fs.readFileSync(docsJsonPath, 'utf8');
  const config = JSON.parse(raw);

  const tabs = config.navigation?.tabs || [];
  let releasesGroup = null;
  for (const tab of tabs) {
    for (const group of tab.groups || []) {
      if (group.group === 'Releases') { releasesGroup = group; break; }
    }
    if (releasesGroup) break;
  }
  if (!releasesGroup) {
    console.error('Could not find "Releases" group in docs.json');
    return;
  }

  // Group versions by year
  const byYear = {};
  for (const { version, date } of versions) {
    const year = date ? new Date(date).getFullYear().toString() : 'Unknown';
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(`release-notes/${version}`);
  }

  // Rebuild pages: keep non-object entries, replace year groups
  const nonGroupPages = releasesGroup.pages.filter((p) => typeof p === 'string');
  const yearGroups = Object.entries(byYear)
    .sort(([a], [b]) => b.localeCompare(a)) // newest year first
    .map(([year, pages]) => ({
      group: `${year} Release Notes`,
      pages, // newest version first (already sorted)
    }));

  releasesGroup.pages = [...nonGroupPages, ...yearGroups];
  fs.writeFileSync(docsJsonPath, JSON.stringify(config, null, 2) + '\n');
}

function updateIndexMdx(indexPath, versions) {
  const cards = versions
    .slice(0, 10) // show last 10 in "Latest"
    .map((v) => `  <Card title="${v.version}" icon="rocket" href="/release-notes/${v.version}">\n    See what shipped in ${v.version}.\n  </Card>`)
    .join('\n');

  const content = `---
title: "Releases"
description: "What changed across the Revive platform"
---

Track changes shipped to **Production** across the Revive platform:

- **revive-dashboard**
- **revive-admin**
- **revive-mobile**
- **revive-api**

Release notes are generated automatically from merged pull requests labeled \`released\`. Each entry is a versioned page created by the **Generate release notes** GitHub Action.

## Latest

<CardGroup cols={1}>
${cards}
</CardGroup>
`;

  fs.writeFileSync(indexPath, content);
}

// ── Run ────────────────────────────────────────────────────────────────

async function main() {
  const releases = await getAllReleases();
  console.log(`Found ${releases.length} releases`);

  // Filter to 2025 and 2026 only
  const targetReleases = releases.filter((r) => {
    if (!r.date) return true; // include if no date (we'll try anyway)
    const year = new Date(r.date).getFullYear();
    return year >= 2025 && year <= 2026;
  });

  console.log(`Processing ${targetReleases.length} releases from 2025-2026`);

  const outDir = path.join(process.cwd(), 'release-notes');
  fs.mkdirSync(outDir, { recursive: true });

  const generatedVersions = [];

  let skippedCount = 0;

  for (let i = 0; i < targetReleases.length; i++) {
    const release = targetReleases[i];
    const version = release.tag.replace(/^v/, 'v'); // normalize
    const untilDate = release.date;
    const mdxPath = path.join(outDir, `${version}.mdx`);

    // Skip releases that already have a generated file
    if (fs.existsSync(mdxPath)) {
      generatedVersions.push({ version, date: untilDate });
      skippedCount++;
      continue;
    }

    // Previous release date is the "since" boundary
    const prevRelease = targetReleases[i + 1] || releases[releases.indexOf(release) + 1];
    const sinceDate = prevRelease?.date || null;

    console.log(`\n── ${version} (${untilDate?.slice(0, 10) || 'unknown date'}) ──`);
    console.log(`  PRs merged: ${sinceDate?.slice(0, 10) || 'beginning'} → ${untilDate?.slice(0, 10) || 'now'}`);

    try {
      const items = await getPRsForRelease(sinceDate, untilDate);
      console.log(`  Found ${items.length} PRs`);

      // Fetch full PR details and group by repo
      const enriched = [];
      for (const item of items) {
        const fullRepo = item.repository_url?.split('/repos/')[1];
        if (!fullRepo) continue;
        const [org, repo] = fullRepo.split('/');
        if (org !== ORG || !REPOS.includes(repo)) continue;

        try {
          const pr = await fetchPull(repo, item.number);
          if (!pr.merged_at) continue;
          if (shouldExcludePRTitle(pr.title)) continue;
          enriched.push({ ...pr, _repo: repo });
        } catch (e) {
          console.warn(`  Warning: failed to fetch ${repo}#${item.number}: ${e.message}`);
        }

        // Small delay between individual PR fetches to stay under rate limit
        await new Promise((r) => setTimeout(r, 150));
      }

      const grouped = buildGrouped(enriched);
      const mdxContent = toReleaseNotesMdx(version, grouped);
      fs.writeFileSync(mdxPath, mdxContent);
      console.log(`  Generated: ${mdxPath}`);

      generatedVersions.push({ version, date: untilDate });
    } catch (e) {
      console.error(`  Error processing ${version}: ${e.message}`);
    }

    // Delay between releases
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (skippedCount > 0) {
    console.log(`\nSkipped ${skippedCount} releases (already generated)`);
  }

  // Sort by date descending (newest first)
  generatedVersions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Update docs.json and index
  const docsJsonPath = path.join(process.cwd(), 'docs.json');
  updateDocsJson(docsJsonPath, generatedVersions);
  console.log('\nUpdated docs.json');

  const indexPath = path.join(outDir, 'index.mdx');
  updateIndexMdx(indexPath, generatedVersions);
  console.log('Updated release-notes/index.mdx');

  console.log(`\nDone! Generated ${generatedVersions.length} release notes.`);
  console.log('Run: git add -A && git commit -m "docs: backfill 2025-2026 release notes" && git push');
}

main().catch((err) => { console.error(err); process.exit(1); });
