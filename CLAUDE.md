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
1. Is triggered manually with a `release_version` input (e.g. `v1.146.0`)
2. Runs `scripts/generate-release-notes.mjs` — pulls PRs labeled `released` from repos: `revive-dashboard`, `revive-admin`, `revive-mobile`, `revive-api`
3. Creates a PR with the new MDX file in `release-notes/`

After merging a generated PR, add the new page to the `docs.json` navigation under the correct year group.

## Style rules

- Active voice and second person ("you")
- Sentence case for headings
- One idea per sentence
- Bold for UI elements: Click **Settings**
- Code formatting for file names, commands, paths, and inline code references
- Do not document internal admin features

## Key files to know

- `scripts/generate-release-notes.mjs` — main release note generator (~1000+ lines, ES module)
- `api-reference/introduction.mdx` — authentication, base URLs, quick-start
- `third-party-integrations.mdx` — overview page with architecture diagram

## Deployment

Deploys automatically on push to `main` via Mintlify's GitHub app. No manual steps needed.
