// Turns the PRs in a release into one clean, team-readable <Update> block.
import { callClaude, escapeMdx } from './claude.mjs';
import { cleanPrBody, formatAreas, prUrl } from './github.mjs';

const AREAS = ['Dashboard', 'Mobile', 'Admin', 'API', 'Platform'];
const AREA_TAGS = { Dashboard: 'dashboard', Mobile: 'mobile', Admin: 'admin', API: 'api', Platform: 'platform' };
const TYPES = [['new', 'New'], ['improved', 'Improved'], ['fixed', 'Fixed']];
const LIMITS = { title: 60, text: 300, highlights: 320 };
const BANNED_RE = /\b(TEC-\d+|CU-\w+|Sprint \d+)\b/i;

const SYSTEM_PROMPT = `You write the release notes for Revive's internal team. They're published on Revive's tech docs site and read by sales, operations, construction managers, product, and engineering.

Revive is a real estate renovation platform with these apps:
- Dashboard: the customer app used by agents, homeowners, contractors, and loan officers.
- Mobile: the customer mobile app.
- Admin: the internal app Revive staff use for sales, operations, construction, and finance.
- API: the backend that powers both apps and integrations.
- Platform: infrastructure, monitoring, security, deployments, and developer tooling.

Your job: turn the pull requests in one release into release notes that someone outside engineering can skim in under a minute and understand what changed and how it affects their work.

What to include:
- Every meaningful change, including bug fixes and small improvements. The team wants to know about fixes.
- Group related bullets and related PRs into a single item. One item per change a person would notice. A large PR usually becomes two to five items, not ten.
- Put each item in the area where people experience it. Use the "files changed by area" counts and the PR text to decide. A backend change that customers see in the dashboard belongs under Dashboard; a change only staff see belongs under Admin. Use API only for changes to endpoints, integrations, or data that aren't better described from an app's point of view.
- Platform items (monitoring, error tracking, deployments, security rules, build changes): keep them short and combine them into one or two items.

What to leave out entirely:
- Dependency bumps, lint, formatting, tests, CI, merge commits, and code moves with no behavior change.
- Umbrella titles with no content of their own ("Sprint 17", "Platform Changes", "UI/UX Improvements", "Accessibility").
- Anything you can't explain from the PR text. Never invent details.

How to write:
- Plain English, active voice, present tense. Short sentences. No jargon, file names, function names, or component names.
- new and improved items: a short title (sentence case, ${LIMITS.title} characters or fewer, no trailing period) that names the thing, plus one or two sentences of text saying what you can now do or what's different, and why it helps.
- fixed items: no title. One sentence describing the problem that's gone, from the user's point of view. For example "Closing a photo gallery clears it, so photos from an earlier listing no longer reappear." Don't start with "Fixed".
- Each text is ${LIMITS.text} characters or fewer.
- Third-party names (HubSpot, PandaDoc, HouseCanary, Google Maps) are fine when they help the team understand the change.
- Never include ticket IDs, PR numbers, or author names in the text. Links are added for you from source_prs.
- highlights: one or two sentences naming the most important changes in the release. Use an empty string if the release is only small fixes.
- action_required: only real breaking changes or things a person must do (update an integration, re-run a setup step). Usually empty.
- Every item needs source_prs listing the PR refs it came from.`;

function buildSchema(prRefs) {
  const item = {
    type: 'object',
    properties: {
      area: { type: 'string', enum: AREAS },
      type: { type: 'string', enum: TYPES.map(([t]) => t) },
      title: { type: 'string' },
      text: { type: 'string' },
      source_prs: { type: 'array', items: { type: 'string', enum: prRefs } },
    },
    required: ['area', 'type', 'title', 'text', 'source_prs'],
    additionalProperties: false,
  };
  const action = {
    type: 'object',
    properties: { text: { type: 'string' }, source_prs: { type: 'array', items: { type: 'string', enum: prRefs } } },
    required: ['text', 'source_prs'],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      highlights: { type: 'string' },
      items: { type: 'array', items: item },
      action_required: { type: 'array', items: action },
    },
    required: ['highlights', 'items', 'action_required'],
    additionalProperties: false,
  };
}

function buildUserPrompt(versions, prs) {
  const blocks = prs.map((pr) => [
    `### ${pr.ref}: ${pr.title}`,
    `Files changed by area: ${formatAreas(pr.areas)}`,
    '',
    cleanPrBody(pr.body) || '(no description)',
  ].join('\n'));
  return [`Release: ${versions.join(', ')}`, `Pull requests (${prs.length}):`, '', blocks.join('\n\n---\n\n')].join('\n');
}

function validate(result, prRefs) {
  const refs = new Set(prRefs);
  const ok = (list) => list.length > 0 && list.every((r) => refs.has(r));
  const items = result.items.filter((i) => {
    const problems = [];
    const needsTitle = i.type !== 'fixed';
    if (needsTitle && (!i.title.trim() || i.title.length > LIMITS.title)) problems.push(`title length ${i.title.length}`);
    if (!i.text.trim() || i.text.length > LIMITS.text) problems.push(`text length ${i.text.length}`);
    if (BANNED_RE.test(`${i.title} ${i.text}`)) problems.push('ticket IDs or sprint names');
    if (!ok(i.source_prs)) problems.push('missing source PRs');
    if (problems.length) console.warn(`  Dropped item "${i.title || i.text.slice(0, 50)}": ${problems.join('; ')}`);
    return problems.length === 0;
  });
  const action = result.action_required.filter((a) => a.text.trim() && ok(a.source_prs));
  const highlights = result.highlights.trim().slice(0, LIMITS.highlights);
  return { highlights, items, action };
}

const prLinks = (refs) =>
  `(${refs.map((r) => `[${r.startsWith('revive-apps#') ? r.slice('revive-apps'.length) : r.replace('revive-', '')}](${prUrl(r)})`).join(', ')})`;

export function renderReleaseBlock({ dateLabel, versions, highlights, items, action }) {
  const areas = AREAS.filter((a) => items.some((i) => i.area === a));
  const lines = [`<Update label="${dateLabel}" description="${versions.join(', ')}" tags={${JSON.stringify(areas.map((a) => AREA_TAGS[a]))}}>`, ''];
  if (highlights) lines.push(`**Highlights:** ${escapeMdx(highlights)}`, '');

  for (const area of areas) {
    lines.push(`### ${area}`, '');
    for (const [type, heading] of TYPES) {
      const group = items.filter((i) => i.area === area && i.type === type);
      if (!group.length) continue;
      lines.push(`**${heading}**`, '');
      for (const i of group) {
        const text = escapeMdx(i.text.trim());
        lines.push(type === 'fixed'
          ? `- ${text} ${prLinks(i.source_prs)}`
          : `- **${escapeMdx(i.title.trim())}:** ${text} ${prLinks(i.source_prs)}`);
      }
      lines.push('');
    }
  }

  if (action.length) {
    lines.push('### Action required', '');
    for (const a of action) lines.push(`- ${escapeMdx(a.text.trim())} ${prLinks(a.source_prs)}`);
    lines.push('');
  }
  lines.push('</Update>');
  return lines.join('\n');
}

// prs: [{ ref, title, body, areas }]. Throws if Claude fails or returns nothing usable.
export async function writeReleaseBlock({ dateLabel, versions, prs }) {
  const prRefs = prs.map((p) => p.ref);
  console.log(`  Writing release notes for ${versions.join(', ')} from ${prs.length} PR(s)...`);
  const raw = await callClaude({ system: SYSTEM_PROMPT, user: buildUserPrompt(versions, prs), schema: buildSchema(prRefs) });
  const result = validate(raw, prRefs);
  if (!result.items.length) throw new Error('Claude returned no usable release-note items');

  const cited = new Set(result.items.flatMap((i) => i.source_prs));
  const uncited = prRefs.filter((r) => !cited.has(r));
  if (uncited.length) console.log(`  Left out as noise: ${uncited.join(', ')}`);
  return renderReleaseBlock({ dateLabel, versions, ...result });
}
