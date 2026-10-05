# Claude Code instructions — revive-api-docs

## About this project

This is the **Revive API documentation site** built on [Mintlify](https://mintlify.com). It covers:
- API reference (auto-generated from `openapi.json`)
- Third-party integration guides
- Release notes (auto-generated from GitHub PRs)

Content lives in `.mdx` files. Site configuration lives in `docs.json`.

## Local development

```bash
mint dev          # Preview on http://localhost:3000 (or next available port)
mint broken-links # Check for broken links
```

Requires Mintlify CLI: `npm i -g mint`

Install the Mintlify skill for component/config knowledge:
```bash
npx skills add https://mintlify.com/docs
```

## Project structure

| Path | Purpose |
|---|---|
| `docs.json` | Site config — navigation, colors, logos, theme |
| `openapi.json` | OpenAPI 3.0 spec (source of truth for API reference) |
| `index.mdx` | Homepage |
| `quickstart.mdx` | Quick start guide |
| `api-reference/` | API reference pages (intro + endpoints) |
| `third-party-integrations/` | One MDX per integration category |
| `release-notes/` | Versioned release notes (80+ files) |
| `scripts/` | Node.js automation scripts |
| `.github/workflows/` | GitHub Actions (release note generation) |

## Content format

Pages are MDX with YAML frontmatter:

```mdx
---
title: "Page title"
description: "Short description shown in meta and cards"
---
```

No build step — Mintlify renders MDX directly. Changes to `docs.json` navigation require a page reload in the dev server.

## Navigation

Navigation is defined entirely in `docs.json`. Three tabs:
- **Guides** — getting started, releases
- **Third-party integrations** — grouped by category
- **API Reference** — auto-generated from `openapi.json`

When adding a new page, you must add it to the appropriate `pages` array in `docs.json` or it will not appear in the sidebar.

## Release notes

Release notes are auto-generated via GitHub Actions (`.github/workflows/generate-release-notes.yml`). The workflow:
1. Is triggered by a `repository_dispatch` when a release is published in `revive-apps` (tags like `admin-v3.17.2`) or a `v*` tag is pushed in `revive-mobile`. It can also be run manually.
2. Runs `scripts/generate-release-notes.mjs`. It collects the release's PRs, skips PRs already listed in an earlier release, and attributes each PR to Dashboard, Mobile, Admin, API, or Platform by its changed files.
3. Claude Sonnet (`scripts/lib/release-writer.mjs`) writes one plain-English `<Update>` block per release: highlights, then New / Improved / Fixed per app. If the AI step fails, it falls back to the older per-app CodeRabbit bullets.
4. Prepends the block to `release-notes.mdx` and the monthly file in `release-notes/`, adds new months to `docs.json`, and commits directly to `main`.
5. Runs `scripts/curate-latest-features.mjs` (see below), the docs audit, and posts to Slack with the release highlights.

To rewrite past months in the new style, run the **Rewrite release notes** workflow (`scripts/rewrite-release-notes.mjs`). It opens a PR for review.

## Latest features feed

`latest-features/feed.json` powers the **Latest Features** panel in the customer dashboard. It's published to GitHub Pages at `https://revive-home.github.io/revive-api-docs/latest-features.json` by `.github/workflows/publish-latest-features.yml`.

- On each release, Claude picks at most two customer-facing highlights and writes them in an outcome-focused voice. Most releases add nothing.
- CTA links can only point to pages in `latest-features/routes.json`. Add new dashboard pages there.
- To edit or remove an entry, change `feed.json` and run `node scripts/curate-latest-features.mjs --render-only` to regenerate `latest-features.mdx`.

Required secrets: `ANTHROPIC_API_KEY`, `RELEASE_NOTES_GITHUB`, `SLACK_RELEASE_NOTES_WEBHOOK`.

## Style rules

- Active voice and second person ("you")
- Sentence case for headings
- One idea per sentence
- Bold for UI elements: Click **Settings**
- Code formatting for file names, commands, paths, and inline code references
- Do not document internal admin features

## Key files to know

- `scripts/generate-release-notes.mjs` — main release note generator (ES module)
- `scripts/lib/release-writer.mjs` — AI prompt and rendering for release notes
- `scripts/curate-latest-features.mjs` — AI curation for the customer Latest Features feed
- `api-reference/introduction.mdx` — authentication, base URLs, quick-start
- `third-party-integrations.mdx` — overview page with architecture diagram

## Deployment

Deploys automatically on push to `main` via Mintlify's GitHub app. No manual steps needed.
