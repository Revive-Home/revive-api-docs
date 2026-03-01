import fs from 'node:fs';

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('Set GITHUB_TOKEN env var');
  process.exit(1);
}

const repo = process.argv[2] || 'revive-api';
const pr = process.argv[3] || '1861';

const url = `https://api.github.com/repos/Revive-Home/${repo}/pulls/${pr}`;
const res = await fetch(url, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

if (!res.ok) {
  console.error(`Error ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const data = await res.json();
const body = data.body || '(empty body)';

console.log('=== PR TITLE ===');
console.log(data.title);
console.log('\n=== PR BODY (first 3000 chars) ===');
console.log(body.slice(0, 3000));
console.log('\n=== SEARCHING FOR CODERABBIT MARKERS ===');

const lines = body.split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim().toLowerCase();
  if (line.includes('coderabbit') || line.includes('summary') || line.includes('release notes')) {
    console.log(`Line ${i}: ${lines[i].trim().slice(0, 200)}`);
  }
}
