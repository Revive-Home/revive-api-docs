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
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!res.ok) {
    console.warn(`  ⚠ Could not fetch ${owner}/${repo}: ${res.status}`);
    return null;
  }
  const data = await res.json();
  return data.pushed_at;
}

async function getLatestRelease(owner, repo) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { headers });
  if (!res.ok) {
    // Fall back to latest push if no releases
    return getLatestPush(owner, repo);
  }
  const data = await res.json();
  return data.published_at || data.created_at;
}

async function main() {
  console.log('Fetching latest dates from GitHub...');

  // API Reference version + date from openapi.json
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'openapi.json'), 'utf8'));
  const apiVersion = spec.info?.version || 'unknown';

  const [apiDate, dashboardDate, adminDate, mobileDate, docsDate] = await Promise.all([
    getLatestRelease('Revive-Home', 'revive-api'),
    getLatestRelease('Revive-Home', 'revive-dashboard'),
    getLatestRelease('Revive-Home', 'revive-admin'),
    getLatestRelease('Revive-Home', 'revive-mobile'),
    getLatestPush('Revive-Home', 'revive-api-docs'),
  ]);

  const dates = {
    apiRef: formatDate(apiDate || new Date().toISOString()),
    apiVersion,
    dashboard: formatDate(dashboardDate || new Date().toISOString()),
    admin: formatDate(adminDate || new Date().toISOString()),
    mobile: formatDate(mobileDate || new Date().toISOString()),
    docs: formatDate(docsDate || new Date().toISOString()),
  };

  console.log('  API Reference:', dates.apiVersion, '—', dates.apiRef);
  console.log('  revive-dashboard:', dates.dashboard);
  console.log('  revive-admin:', dates.admin);
  console.log('  revive-mobile:', dates.mobile);
  console.log('  Docs site:', dates.docs);

  // Update index.mdx
  const indexPath = path.join(ROOT, 'index.mdx');
  let content = fs.readFileSync(indexPath, 'utf8');

  // Replace each card's date line using sed-style replacements
  content = content.replace(
    /(<Card title="API Reference" icon="terminal">\n\s+)\*\*.*?\*\* — updated .+/,
    `$1**${dates.apiVersion}** — updated ${dates.apiRef}`
  );
  content = content.replace(
    /(<Card title="revive-api" icon="server">\n\s+)Last deploy: \*\*.+?\*\*/,
    `$1Last deploy: **${dates.apiRef}**`
  );
  content = content.replace(
    /(<Card title="revive-dashboard" icon="browser">\n\s+)Last deploy: \*\*.+?\*\*/,
    `$1Last deploy: **${dates.dashboard}**`
  );
  content = content.replace(
    /(<Card title="revive-admin" icon="shield">\n\s+)Last deploy: \*\*.+?\*\*/,
    `$1Last deploy: **${dates.admin}**`
  );
  content = content.replace(
    /(<Card title="revive-mobile" icon="mobile">\n\s+)Last deploy: \*\*.+?\*\*/,
    `$1Last deploy: **${dates.mobile}**`
  );
  content = content.replace(
    /(<Card title="This docs site" icon="book">\n\s+)Last updated: \*\*.+?\*\*/,
    `$1Last updated: **${dates.docs}**`
  );

  // Also update the api-reference/introduction.mdx banner
  const introPath = path.join(ROOT, 'api-reference', 'introduction.mdx');
  let introContent = fs.readFileSync(introPath, 'utf8');
  introContent = introContent.replace(
    /\*\*API spec version:\*\* .+/,
    `**API spec version:** ${dates.apiVersion} — auto-synced from \`revive-api\` on every production release. Last updated ${dates.apiRef}.`
  );

  fs.writeFileSync(indexPath, content);
  fs.writeFileSync(introPath, introContent);

  console.log('\nUpdated index.mdx and api-reference/introduction.mdx');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
