#!/usr/bin/env node
/**
 * Fetches the latest push/release dates for each Revive repo
 * and updates the "Platform pulse" section on index.mdx.
 *
 * Requires GITHUB_TOKEN env var with read access to Revive-Home repos.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

const headers = {
  Authorization: `token ${TOKEN}`,
  Accept: 'application/vnd.github+json',
};

function formatDate(isoDate) {
  const d = new Date(isoDate);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

async function getLatestPush(owner, repo) {
  // Use latest commit on the default branch (not pushed_at which fires on any branch)
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`, { headers });
  if (!res.ok) {
    console.warn(`  ⚠ Could not fetch commits for ${owner}/${repo}: ${res.status}`);
    return null;
  }
  const data = await res.json();
  if (!data.length) return null;
  return data[0].commit.committer.date;
}

async function getLatestRelease(owner, repo, tagPrefix) {
  // Fetch recent releases and find the first that is published (non-draft, non-prerelease)
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`, { headers });
  if (!res.ok) {
    console.warn(`  ⚠ Could not fetch releases for ${owner}/${repo}: ${res.status}`);
    return null;
  }
  const releases = await res.json();
  const published = releases.find((r) => {
    if (r.draft || r.prerelease) return false;
    // If a tag prefix is specified, only match releases for that app (e.g. revive-api@)
    if (tagPrefix && !r.tag_name?.startsWith(tagPrefix)) return false;
    return true;
  });
  if (!published) {
    console.warn(`  ⚠ No published release found for ${owner}/${repo}${tagPrefix ? ` (prefix: ${tagPrefix})` : ''}`);
    return null;
  }
  return published.published_at || published.created_at;
}

async function main() {
  console.log('Fetching latest dates from GitHub...');

  // API Reference version + date from openapi.json
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'openapi.json'), 'utf8'));
  const apiVersion = spec.info?.version || 'unknown';

  const [apiDate, dashboardDate, adminDate, mobileDate, docsDate] = await Promise.all([
    getLatestRelease('Revive-Home', 'revive-apps', 'revive-api@'),
    getLatestRelease('Revive-Home', 'revive-apps', 'revive-dashboard@'),
    getLatestRelease('Revive-Home', 'revive-apps', 'revive-admin@'),
    getLatestRelease('Revive-Home', 'revive-mobile'),
    getLatestPush('Revive-Home', 'revive-api-docs'),
  ]);

  const dates = {
    apiRef: apiDate ? formatDate(apiDate) : null,
    apiVersion,
    dashboard: dashboardDate ? formatDate(dashboardDate) : null,
    admin: adminDate ? formatDate(adminDate) : null,
    mobile: mobileDate ? formatDate(mobileDate) : null,
    docs: docsDate ? formatDate(docsDate) : null,
  };

  console.log('  API Reference:', dates.apiVersion, '—', dates.apiRef);
  console.log('  revive-dashboard:', dates.dashboard);
  console.log('  revive-admin:', dates.admin);
  console.log('  revive-mobile:', dates.mobile);
  console.log('  Docs site:', dates.docs);

  // Update index.mdx
  const indexPath = path.join(ROOT, 'index.mdx');
  let content = fs.readFileSync(indexPath, 'utf8');

  // Replace each card's date line — only update if we got a valid date
  if (dates.apiRef) {
    content = content.replace(
      /(<Card title="API Reference" icon="terminal">\n\s+)\*\*.*?\*\* — updated .+/,
      `$1**${dates.apiVersion}** — updated ${dates.apiRef}`
    );
    content = content.replace(
      /(<Card title="revive-api" icon="server">\n\s+)Last deploy: \*\*.+?\*\*/,
      `$1Last deploy: **${dates.apiRef}**`
    );
  }
  if (dates.dashboard) {
    content = content.replace(
      /(<Card title="revive-dashboard" icon="browser">\n\s+)Last deploy: \*\*.+?\*\*/,
      `$1Last deploy: **${dates.dashboard}**`
    );
  }
  if (dates.admin) {
    content = content.replace(
      /(<Card title="revive-admin" icon="shield">\n\s+)Last deploy: \*\*.+?\*\*/,
      `$1Last deploy: **${dates.admin}**`
    );
  }
  if (dates.mobile) {
    content = content.replace(
      /(<Card title="revive-mobile" icon="mobile">\n\s+)Last deploy: \*\*.+?\*\*/,
      `$1Last deploy: **${dates.mobile}**`
    );
  }
  if (dates.docs) {
    content = content.replace(
      /(<Card title="This docs site" icon="book">\n\s+)Last updated: \*\*.+?\*\*/,
      `$1Last updated: **${dates.docs}**`
    );
  }

  // Also update the api-reference/introduction.mdx banner
  const introPath = path.join(ROOT, 'api-reference', 'introduction.mdx');
  let introContent = fs.readFileSync(introPath, 'utf8');
  if (dates.apiRef) {
    introContent = introContent.replace(
      /\*\*API spec version:\*\* .+/,
      `**API spec version:** ${dates.apiVersion} — auto-synced from \`revive-api\` on every production release. Last updated ${dates.apiRef}.`
    );
  }

  fs.writeFileSync(indexPath, content);
  fs.writeFileSync(introPath, introContent);

  console.log('\nUpdated index.mdx and api-reference/introduction.mdx');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
