export const ORG = 'Revive-Home';

export function makeGhJson(token) {
  return async function ghJson(url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`GitHub API error ${res.status} for ${url}: ${await res.text()}`);
    return res.json();
  };
}

// Pre-monorepo repos map to a single area
const STANDALONE_AREAS = { 'revive-mobile': 'mobile', 'revive-api': 'api', 'revive-dashboard': 'dashboard', 'revive-admin': 'admin' };

export function guessAreas(repo) {
  const areas = { dashboard: 0, mobile: 0, shared: 0, api: 0, admin: 0, other: 0 };
  areas[STANDALONE_AREAS[repo] || 'other'] = 1;
  return areas;
}

// Counts changed files per app area so we know where a PR actually landed.
export async function getTouchedAreas(ghJson, repo, number) {
  const areas = { dashboard: 0, mobile: 0, shared: 0, api: 0, admin: 0, other: 0 };
  for (let page = 1; page <= 3; page++) {
    const files = await ghJson(`https://api.github.com/repos/${ORG}/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    for (const { filename } of files) {
      const area =
        STANDALONE_AREAS[repo] ||
        filename.startsWith('apps/dashboard/') ? 'dashboard' :
        filename.startsWith('apps/admin/') ? 'admin' :
        filename.startsWith('apps/api/') ? 'api' :
        filename.startsWith('packages/') ? 'shared' : 'other';
      areas[area]++;
    }
    if (files.length < 100) break;
  }
  return areas;
}

export const formatAreas = (areas) =>
  Object.entries(areas).filter(([, n]) => n).map(([a, n]) => `${a}=${n}`).join(', ') || 'none';

export const prUrl = (ref) => {
  const [repo, number] = ref.split('#');
  return `https://github.com/${ORG}/${repo}/pull/${number}`;
};

// Every "repo#number" already linked from a release notes page.
export function extractPrRefs(mdx) {
  const refs = new Set();
  for (const m of mdx.matchAll(/github\.com\/Revive-Home\/([\w.-]+)\/pull\/(\d+)/g)) refs.add(`${m[1]}#${m[2]}`);
  return refs;
}

export function cleanPrBody(body = '') {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}
