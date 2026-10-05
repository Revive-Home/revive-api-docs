// Picks customer-facing highlights from a release with Claude, appends them to
// latest-features/feed.json, and renders latest-features.mdx from the feed.
//
// Usage:
//   node scripts/curate-latest-features.mjs                # curate + render
//   node scripts/curate-latest-features.mjs --dry-run      # curate, print, write nothing
//   node scripts/curate-latest-features.mjs --render-only  # re-render the MDX page from feed.json
//
// Env (curate mode): ANTHROPIC_API_KEY, GITHUB_TOKEN, RELEASE_CONTEXT_FILE, RELEASE_VERSION
// Optional: LATEST_FEATURES_MODEL, RELEASE_DATE (YYYY-MM-DD), GITHUB_OUTPUT
import fs from 'node:fs';
import path from 'node:path';
import { makeGhJson, getTouchedAreas, formatAreas, cleanPrBody } from './lib/github.mjs';
import { callClaude, escapeMdx, DEFAULT_MODEL } from './lib/claude.mjs';

const ROOT = process.cwd();
const FEED_PATH = path.join(ROOT, 'latest-features', 'feed.json');
const ROUTES_PATH = path.join(ROOT, 'latest-features', 'routes.json');
const PAGE_PATH = path.join(ROOT, 'latest-features.mdx');

const MODEL = process.env.LATEST_FEATURES_MODEL || DEFAULT_MODEL;
const MAX_NEW_ITEMS = 2;
const MAX_FEED_ITEMS = 50;
const LIMITS = { title: 60, summary: 260, ctaLabel: 30 };
const AUDIENCES = ['Realtor', 'Homeowner', 'Service Provider', 'Loan Officer'];
const AUDIENCE_NAMES = { Realtor: 'agent', Homeowner: 'homeowner', 'Service Provider': 'contractor', 'Loan Officer': 'loan officer' };
const BUILD_LOG_RE = /^(added|introduced|enhanced|improved|implemented|now supports|users can)\b/i;
const HYPE_RE = /\b(powerful|seamless(ly)?|revolutionary|game[- ]chang\w*|cutting[- ]edge)\b/i;
const BANNED_TEXT_RE = /\b(TEC-\d+|PR\s*#?\d+|#\d+|v\d+\.\d+|HubSpot|Bannerbear|Firestore|Firebase|CodeRabbit|AnyProp|Atlist|Sentry|Vercel|Heroku)\b/i;

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const renderOnly = args.has('--render-only');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const isPossiblyCustomerFacing = (a) => a.dashboard + a.mobile + a.shared + a.api > 0;

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You curate the "Latest features" feed shown inside the Revive dashboard and mobile app.

Revive is a real estate renovation platform. Real estate agents (user type "Realtor") and homeowners use the dashboard to run Revive AI property reports, start and track renovation projects, generate marketing materials, and refer friends. Contractors ("Service Provider") and loan officers ("Loan Officer") also log in. Revive's internal team uses a separate admin app that customers never see.

Your job: from the pull requests in one release, pick at most ${MAX_NEW_ITEMS} changes worth announcing to customers. Most releases contain nothing announcement-worthy. Returning zero items is the expected, correct answer for most releases. Only announce something a customer would be glad to hear about.

Include a change only if ALL of these are true:
- A customer can see or use it in the dashboard or mobile app.
- It is a new capability, a new page or workflow, or a change big enough that a regular user would notice and care.
- You can explain the benefit in plain words, without technical detail.

Always exclude:
- Bug fixes, performance work, refactors, dependency or build changes, monitoring, logging, and security hardening.
- Small copy, style, icon, spacing, loading-state, or accessibility tweaks.
- Internal admin-app tools: finance, RMAs, vendor payments, contractor document management, CRM syncing, Slack notifications, scheduled jobs, map syncing, underwriting, and anything else only Revive staff use.
- Backend or API changes that customers don't directly experience.
- Early, partial, or "initial version" work that isn't finished for customers.
- Anything already covered by an existing feed item.

Group related PRs into one item. Never invent details that the PR text doesn't support.

How to write each item:
These appear in a "Latest features" panel inside the customer dashboard. Write like a product marketer who respects the reader's time. Lead with the result for the customer, not the feature. The reader should finish the item knowing what they can now do, and why it's good for their business, their clients, or their home.

Think about what each audience cares about:
- Agents want to win listings, look professional, stay top of mind with clients, and save time.
- Homeowners want to know what's happening with their renovation, feel in control, and avoid surprises.
- Contractors and loan officers want less back-and-forth and clearer information.

- title: sentence case, ${LIMITS.title} characters or fewer, no trailing period. State the outcome or the new thing they can do, in their words. Good: "See your whole renovation in one place". Bad: "New project dashboard with tabs".
- summary: two short sentences, ${LIMITS.summary} characters or fewer, second person ("you"), active voice. Sentence one says what you can now do, concretely. Sentence two gives the payoff: the time saved, the hassle removed, or the moment it helps with.
- Use concrete, specific details from the PR (what they see, what gets filled in, what they no longer have to do). Specific beats generic.
- Sound warm and confident. Quiet excitement is good; hype is not.
- Never claim results the PRs don't support. No invented numbers, time savings, or guarantees.
- Don't start with or lean on build-log verbs like "Added", "Introduced", "Enhanced", "Improved", "Now supports", or "Users can".
- Never mention PR numbers, ticket IDs, version numbers, or internal vendor and tool names (for example HubSpot, Bannerbear, Firestore, Firebase, CodeRabbit, AnyProp, Atlist).
- No hype words (powerful, seamless, revolutionary, game-changing, cutting-edge), no exclamation marks, no emojis.

Example of a strong item:
  title: "Your projects now market themselves"
  summary: "When a project breaks ground, Revive turns its photos into branded marketing pieces with your name on them. Show clients your work and stay top of mind without opening a design tool."

- cta_path: the single most relevant dashboard page from the provided list, or "none" if no page fits. Never guess.
- cta_label: two to four words starting with a verb, for example "Open Marketing Center". Use an empty string when cta_path is "none".
- audience: the user types who can use the feature. Use an empty array if every user type can. Use the page audience as a guide.
- source_prs: the refs of the PRs the item is based on.
- reasoning: one sentence explaining why customers will care.
- skipped_reason: one sentence on why you didn't pick anything else.`;

function buildSchema(routePaths, prRefs) {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            reasoning: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            cta_path: { type: 'string', enum: [...routePaths, 'none'] },
            cta_label: { type: 'string' },
            audience: { type: 'array', items: { type: 'string', enum: AUDIENCES } },
            source_prs: { type: 'array', items: { type: 'string', enum: prRefs } },
          },
          required: ['reasoning', 'title', 'summary', 'cta_path', 'cta_label', 'audience', 'source_prs'],
          additionalProperties: false,
        },
      },
      skipped_reason: { type: 'string' },
    },
    required: ['items', 'skipped_reason'],
    additionalProperties: false,
  };
}

function buildUserPrompt({ version, candidates, routes, feed }) {
  const routeLines = routes.routes.map((r) =>
    `- ${r.path} (${r.page}): ${r.description} Audience: ${r.audience.length ? r.audience.join(', ') : 'everyone'}.`);
  const recent = feed.items.slice(0, 15).map((i) =>
    `- [${i.date}] ${i.title}: ${i.summary} (from ${i.source?.prs?.join(', ') || 'unknown'})`);
  const prBlocks = candidates.map((c) => [
    `### ${c.ref}: ${c.title}`,
    `Merged: ${c.merged_at?.slice(0, 10)}`,
    `Files changed by area: ${formatAreas(c.areas)}`,
    '',
    cleanPrBody(c.body) || '(no description)',
  ].join('\n'));

  return [
    `Release: ${version}`,
    '',
    '## Dashboard pages you can link to',
    ...routeLines,
    '',
    '## Existing feed items (do not repeat; match this tone and length)',
    ...(recent.length ? recent : ['(none)']),
    '',
    `## Pull requests in this release (${candidates.length})`,
    '',
    prBlocks.join('\n\n---\n\n'),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Validation + feed updates
// ---------------------------------------------------------------------------
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function validateItem(item, featured) {
  const problems = [];
  const title = item.title.trim();
  const summary = item.summary.trim();
  if (!title || title.length > LIMITS.title) problems.push(`title length ${title.length}`);
  if (!summary || summary.length > LIMITS.summary) problems.push(`summary length ${summary.length}`);
  if (/[.!]$/.test(title)) problems.push('title ends with punctuation');
  if (/!/.test(summary)) problems.push('summary has exclamation mark');
  if (BANNED_TEXT_RE.test(`${title} ${summary}`)) problems.push('mentions internal names, IDs, or versions');
  if (BUILD_LOG_RE.test(title) || BUILD_LOG_RE.test(summary)) problems.push('reads like a changelog, not a benefit');
  if (HYPE_RE.test(`${title} ${summary}`)) problems.push('uses hype words');
  if (item.cta_path !== 'none' && (!item.cta_label.trim() || item.cta_label.length > LIMITS.ctaLabel)) problems.push('bad cta_label');
  if (!item.source_prs.length) problems.push('no source PRs');
  if (item.source_prs.some((ref) => featured.has(ref))) problems.push('source PR already featured');
  return problems;
}

function toFeedItem(item, { date, version, routes, existingIds }) {
  let id = `${date}-${slugify(item.title)}`;
  for (let n = 2; existingIds.has(id); n++) id = `${date}-${slugify(item.title)}-${n}`;
  existingIds.add(id);
  return {
    id,
    date,
    title: item.title.trim(),
    summary: item.summary.trim(),
    cta: item.cta_path === 'none' ? null : { label: item.cta_label.trim(), url: `${routes.base_url}${item.cta_path}` },
    audience: [...new Set(item.audience)],
    source: { releases: [version], prs: item.source_prs, curated_by: MODEL },
  };
}

// ---------------------------------------------------------------------------
// MDX rendering
// ---------------------------------------------------------------------------
function formatDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function renderPage(feed) {
  const byDate = new Map();
  for (const item of feed.items) {
    if (!byDate.has(item.date)) byDate.set(item.date, []);
    byDate.get(item.date).push(item);
  }

  const blocks = [...byDate].map(([date, items]) => {
    const body = items.map((i) => {
      const lines = [`### ${escapeMdx(i.title)}`, '', escapeMdx(i.summary)];
      if (i.audience.length) lines.push('', `_For ${i.audience.map((a) => AUDIENCE_NAMES[a] || a).join(' and ')} accounts._`);
      if (i.cta) lines.push('', `[${escapeMdx(i.cta.label)} →](${i.cta.url})`);
      return lines.join('\n');
    }).join('\n\n');
    return `<Update label="${formatDate(date)}">\n\n${body}\n\n</Update>`;
  });

  return [
    '---',
    'title: "Latest features"',
    'description: "The biggest updates to the Revive dashboard, newest first, in plain English."',
    '---',
    '',
    '{/* Generated from latest-features/feed.json by scripts/curate-latest-features.mjs. Edit the JSON, then run the script with --render-only. */}',
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
}

function writeOutputs(newItems) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const lines = newItems.map((i) => `• *${i.title}* — ${i.summary}`).join('\n');
  fs.appendFileSync(out, `new_count=${newItems.length}\nhighlights<<__EOF__\n${lines}\n__EOF__\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function curate(feed) {
  const version = requiredEnv('RELEASE_VERSION');
  const context = readJson(requiredEnv('RELEASE_CONTEXT_FILE'));
  const routes = readJson(ROUTES_PATH);
  const featured = new Set(feed.items.flatMap((i) => i.source?.prs || []));

  const ghJson = makeGhJson(requiredEnv('GITHUB_TOKEN'));
  const seen = new Set();
  const candidates = [];
  for (const pr of context.prs) {
    const ref = `${pr.repo}#${pr.number}`;
    if (seen.has(ref) || featured.has(ref)) continue;
    seen.add(ref);
    const areas = pr.areas || await getTouchedAreas(ghJson, pr.repo, pr.number);
    if (!isPossiblyCustomerFacing(areas)) {
      console.log(`  Skipping ${ref} (admin/internal only)`);
      continue;
    }
    candidates.push({ ...pr, ref, areas });
  }

  if (candidates.length === 0) {
    console.log('No customer-facing PR candidates in this release.');
    return [];
  }

  console.log(`Asking ${MODEL} to review ${candidates.length} PR(s) from ${version}...`);
  const result = await callClaude({
    model: MODEL,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt({ version, candidates, routes, feed }),
    schema: buildSchema(routes.routes.map((r) => r.path), candidates.map((c) => c.ref)),
  });

  const date = process.env.RELEASE_DATE || new Date().toISOString().slice(0, 10);
  const existingIds = new Set(feed.items.map((i) => i.id));
  const accepted = [];
  for (const item of result.items) {
    const problems = validateItem(item, featured);
    if (problems.length) {
      console.warn(`  Rejected "${item.title}": ${problems.join('; ')}`);
      continue;
    }
    item.source_prs.forEach((ref) => featured.add(ref));
    accepted.push(toFeedItem(item, { date, version, routes, existingIds }));
    console.log(`  Accepted "${item.title}" — ${item.reasoning}`);
    if (accepted.length === MAX_NEW_ITEMS) break;
  }
  console.log(`Skipped the rest: ${result.skipped_reason}`);
  return accepted;
}

async function main() {
  const feed = readJson(FEED_PATH);
  let newItems = [];

  if (!renderOnly) {
    newItems = await curate(feed);
    if (dryRun) {
      console.log(JSON.stringify(newItems, null, 2));
      return;
    }
    if (newItems.length) {
      feed.items = [...newItems, ...feed.items].slice(0, MAX_FEED_ITEMS);
      feed.updated_at = new Date().toISOString();
      fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2) + '\n');
      console.log(`Added ${newItems.length} item(s) to latest-features/feed.json`);
    }
  }

  fs.writeFileSync(PAGE_PATH, renderPage(feed));
  console.log('Rendered latest-features.mdx');
  writeOutputs(newItems);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
