#!/usr/bin/env node
/**
 * Docs Audit on Release
 *
 * Runs after release notes are generated to cross-check the documentation
 * against what shipped. Checks:
 *
 * 1. Guides — do any release notes reference endpoints, params, or features
 *    that aren't documented yet (or that have been removed)?
 * 2. Third-party integrations — do release notes mention new providers,
 *    renamed services, or deprecated integrations?
 * 3. API Reference (openapi.json) — do release notes reference new or
 *    renamed endpoints that aren't in the OpenAPI spec?
 * 4. Field dictionary — are new response fields mentioned in the release
 *    that aren't listed in the field dictionary?
 *
 * Output: A markdown checklist written to `audit-report.md` in the repo root,
 * and a GitHub Actions job summary (when running in CI).
 *
 * Usage:
 *   node scripts/audit-docs-on-release.mjs [--release-file release-notes/may-2026.mdx]
 *
 * Environment:
 *   GITHUB_STEP_SUMMARY — if set, appends the report to the GH Actions summary
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let releaseFile = path.join(ROOT, 'release-notes.mdx');

const fileIdx = args.indexOf('--release-file');
if (fileIdx !== -1 && args[fileIdx + 1]) {
  releaseFile = path.resolve(ROOT, args[fileIdx + 1]);
}

// ---------------------------------------------------------------------------
// Load documentation sources
// ---------------------------------------------------------------------------
function readMdx(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function loadAllGuides() {
  const dir = path.join(ROOT, 'guides');
  if (!fs.existsSync(dir)) return {};
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mdx'));
  const guides = {};
  for (const f of files) {
    guides[f.replace('.mdx', '')] = readMdx(path.join(dir, f));
  }
  return guides;
}

function loadAllIntegrations() {
  const dir = path.join(ROOT, 'third-party-integrations');
  if (!fs.existsSync(dir)) return {};
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mdx'));
  const integrations = {};
  for (const f of files) {
    integrations[f.replace('.mdx', '')] = readMdx(path.join(dir, f));
  }
  return integrations;
}

function loadOpenAPIEndpoints() {
  const specPath = path.join(ROOT, 'openapi.json');
  if (!fs.existsSync(specPath)) return new Set();
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const endpoints = new Set();
  for (const [pathStr, methods] of Object.entries(spec.paths || {})) {
    for (const method of Object.keys(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        endpoints.add(`${method.toUpperCase()} ${pathStr}`);
      }
    }
  }
  return endpoints;
}

function loadFieldDictionary() {
  const dictPath = path.join(ROOT, 'guides', 'field-dictionary.mdx');
  if (!fs.existsSync(dictPath)) return new Set();
  const content = readMdx(dictPath);
  // Extract field names from inline code blocks
  const fields = new Set();
  const matches = content.matchAll(/`([a-zA-Z_][a-zA-Z0-9_]*)`/g);
  for (const m of matches) fields.add(m[1]);
  return fields;
}

// ---------------------------------------------------------------------------
// Extract signals from release notes
// ---------------------------------------------------------------------------
function extractEndpointRefs(text) {
  // Match patterns like: POST /v1/something, GET /v1/something/{id}
  const pattern = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/v\d+\/[^\s,.)]+)/gi;
  const refs = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    refs.push(`${match[1].toUpperCase()} ${match[2].replace(/\{[^}]+\}/g, '{param}')}`);
  }
  return [...new Set(refs)];
}

function extractFieldRefs(text) {
  // Match backticked field names that look like API fields
  const pattern = /`([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*)`/g;
  const fields = new Set();
  let match;
  while ((match = pattern.exec(text)) !== null) {
    // Filter out common non-field references
    const val = match[1];
    if (val.includes('.') || /^[a-z]/.test(val)) {
      fields.add(val);
    }
  }
  return fields;
}

function extractIntegrationRefs(text) {
  // Known integration keywords to check for
  const keywords = [
    'HubSpot', 'PandaDoc', 'Firebase', 'Stripe', 'Twilio', 'SendGrid',
    'Google Maps', 'Google Tag', 'GTM', 'Sentry', 'Datadog', 'Segment',
    'AnyProp', 'ATTOM', 'CoreLogic', 'SmartyStreets', 'Plaid',
    'Mailchimp', 'Intercom', 'Calendly',
  ];
  const found = [];
  for (const kw of keywords) {
    if (text.toLowerCase().includes(kw.toLowerCase())) {
      found.push(kw);
    }
  }
  return found;
}

function extractGuideRefs(text) {
  // Look for internal links to guides
  const pattern = /\[([^\]]+)\]\(\/(guides\/[^)]+)\)/g;
  const refs = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    refs.push({ label: match[1], path: match[2] });
  }
  return refs;
}

function extractNewFeatureKeywords(text) {
  // Extract key feature keywords from "### New" sections
  const features = [];
  const newSectionPattern = /### New\n([\s\S]*?)(?=###|<\/Update>|$)/g;
  let match;
  while ((match = newSectionPattern.exec(text)) !== null) {
    const section = match[1];
    // Extract bold items
    const boldPattern = /\*\*([^*]+)\*\*/g;
    let boldMatch;
    while ((boldMatch = boldPattern.exec(section)) !== null) {
      features.push(boldMatch[1].replace(/\.$/, ''));
    }
  }
  return features;
}

// ---------------------------------------------------------------------------
// Audit checks
// ---------------------------------------------------------------------------
function auditEndpoints(releaseText, openapiEndpoints) {
  const issues = [];
  const refs = extractEndpointRefs(releaseText);

  for (const ref of refs) {
    // Normalize the OpenAPI endpoints for comparison
    const normalized = ref.replace(/\{param\}/g, '{param}');
    // Check if any OpenAPI endpoint matches the pattern
    let found = false;
    for (const ep of openapiEndpoints) {
      const epNormalized = ep.replace(/\{[^}]+\}/g, '{param}');
      if (epNormalized === normalized) {
        found = true;
        break;
      }
    }
    if (!found) {
      issues.push({
        type: 'missing_endpoint',
        detail: `Endpoint \`${ref}\` mentioned in release notes but not found in \`openapi.json\`. May need to be added to the API reference.`,
        endpoint: ref,
      });
    }
  }
  return issues;
}

function auditGuides(releaseText, guides) {
  const issues = [];
  const features = extractNewFeatureKeywords(releaseText);
  const guideRefs = extractGuideRefs(releaseText);

  // Check that linked guides actually exist
  for (const ref of guideRefs) {
    // Strip anchors (e.g. guides/intake-url-parameters#section → intake-url-parameters)
    const guideName = ref.path.replace('guides/', '').split('#')[0];
    if (!guides[guideName]) {
      issues.push({
        type: 'broken_guide_link',
        detail: `Release notes link to \`/${ref.path}\` ("${ref.label}") but that guide doesn't exist.`,
      });
    }
  }

  // Suggest guides that might need updating based on feature keywords
  const guideKeywordMap = {
    'intake-url-parameters': ['intake', 'URL parameter', 'showcalendar', 'intake URL'],
    'webhooks': ['webhook', 'event', 'notification', 'dispatch'],
    'ai-weekly-updates': ['weekly update', 'scope item', 'scope picker', 'weekly'],
    'pagination-and-rate-limits': ['rate limit', 'pagination', 'per_page', 'cursor'],
    'error-handling': ['error', '400', '401', '403', '404', '500', 'validation'],
    'field-dictionary': ['field', 'response field', 'new field'],
  };

  for (const [guide, keywords] of Object.entries(guideKeywordMap)) {
    for (const kw of keywords) {
      if (releaseText.toLowerCase().includes(kw.toLowerCase())) {
        // Check if the guide already references this feature context
        const guideContent = guides[guide] || '';
        const needsReview = features.some((f) =>
          f.toLowerCase().includes(kw.toLowerCase()) &&
          !guideContent.toLowerCase().includes(f.toLowerCase().slice(0, 20))
        );
        if (needsReview) {
          issues.push({
            type: 'guide_may_need_update',
            detail: `Guide \`guides/${guide}.mdx\` may need updating — release mentions "${kw}" in a new feature context.`,
            guide,
          });
          break; // one issue per guide is enough
        }
      }
    }
  }

  return issues;
}

function auditIntegrations(releaseText, integrations) {
  const issues = [];
  const refs = extractIntegrationRefs(releaseText);

  for (const provider of refs) {
    // Map provider names to integration doc slugs
    const slugMap = {
      'HubSpot': 'hubspot',
      'PandaDoc': 'pandadoc',
      'Firebase': 'firebase',
      'Stripe': 'payments',
      'Google Maps': 'maps-and-geocoding',
      'Google Tag': 'analytics-and-monitoring',
      'GTM': 'analytics-and-monitoring',
      'Sentry': 'analytics-and-monitoring',
      'Datadog': 'analytics-and-monitoring',
      'Segment': 'analytics-and-monitoring',
      'Twilio': 'communications',
      'SendGrid': 'communications',
      'AnyProp': 'property-data',
      'ATTOM': 'property-data',
      'CoreLogic': 'property-data',
      'SmartyStreets': 'address-verification',
      'Mailchimp': 'marketing-attribution',
    };

    const slug = slugMap[provider];
    if (slug && integrations[slug]) {
      // Check if the integration doc mentions the specific context from release notes
      const integrationContent = integrations[slug];
      // Look for new features related to this provider
      const providerPattern = new RegExp(provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const releaseLines = releaseText.split('\n').filter((l) => providerPattern.test(l));

      for (const line of releaseLines) {
        // Extract the bold feature name
        const boldMatch = line.match(/\*\*([^*]+)\*\*/);
        if (boldMatch) {
          const featureName = boldMatch[1].slice(0, 30);
          if (!integrationContent.toLowerCase().includes(featureName.toLowerCase().slice(0, 15))) {
            issues.push({
              type: 'integration_may_need_update',
              detail: `Integration doc \`third-party-integrations/${slug}.mdx\` may need updating — release mentions "${provider}" in: "${boldMatch[1]}"`,
              provider,
              slug,
            });
            break;
          }
        }
      }
    } else if (!slug) {
      issues.push({
        type: 'undocumented_integration',
        detail: `Release notes reference "${provider}" but no integration doc covers it. Consider adding documentation.`,
        provider,
      });
    }
  }

  return issues;
}

function auditFields(releaseText, knownFields) {
  const issues = [];
  const refs = extractFieldRefs(releaseText);

  for (const field of refs) {
    const baseName = field.split('.').pop();
    if (!knownFields.has(baseName) && !knownFields.has(field)) {
      // Only flag fields that look "new" — mentioned alongside "new" or "added"
      const context = releaseText.substring(
        Math.max(0, releaseText.indexOf(field) - 100),
        releaseText.indexOf(field) + field.length + 100
      );
      if (/\b(new|added|now\s+include|now\s+return)/i.test(context)) {
        issues.push({
          type: 'field_not_in_dictionary',
          detail: `Field \`${field}\` appears to be new in this release but isn't in the field dictionary. Consider adding it to \`guides/field-dictionary.mdx\`.`,
          field,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Generate report
// ---------------------------------------------------------------------------
function generateReport(allIssues) {
  const lines = [];
  lines.push('# 📋 Docs Audit Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString().slice(0, 16)} UTC`);
  lines.push('');

  if (allIssues.length === 0) {
    lines.push('✅ **All clear!** No documentation gaps detected for this release.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`Found **${allIssues.length}** item(s) to review:`);
  lines.push('');

  // Group by type
  const groups = {
    'API Reference (openapi.json)': allIssues.filter((i) => i.type === 'missing_endpoint'),
    'Guides': allIssues.filter((i) => i.type === 'guide_may_need_update' || i.type === 'broken_guide_link'),
    'Third-party integrations': allIssues.filter((i) => i.type === 'integration_may_need_update' || i.type === 'undocumented_integration'),
    'Field dictionary': allIssues.filter((i) => i.type === 'field_not_in_dictionary'),
  };

  for (const [section, issues] of Object.entries(groups)) {
    if (issues.length === 0) continue;
    lines.push(`## ${section}`);
    lines.push('');
    for (const issue of issues) {
      lines.push(`- [ ] ${issue.detail}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('**Next steps:** Review each item above. For each:');
  lines.push('1. If the feature is genuinely new, update the relevant docs page.');
  lines.push('2. If the endpoint is in the OpenAPI spec under a different path, no action needed — just verify.');
  lines.push('3. If a guide reference is outdated or a provider has been removed, update or remove the reference.');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log('🔍 Running docs audit...');
  console.log(`  Release file: ${releaseFile}`);

  if (!fs.existsSync(releaseFile)) {
    console.error(`❌ Release file not found: ${releaseFile}`);
    process.exit(1);
  }

  const releaseText = readMdx(releaseFile);
  const guides = loadAllGuides();
  const integrations = loadAllIntegrations();
  const openapiEndpoints = loadOpenAPIEndpoints();
  const knownFields = loadFieldDictionary();

  console.log(`  Loaded ${Object.keys(guides).length} guide(s)`);
  console.log(`  Loaded ${Object.keys(integrations).length} integration doc(s)`);
  console.log(`  Loaded ${openapiEndpoints.size} OpenAPI endpoint(s)`);
  console.log(`  Loaded ${knownFields.size} known field(s)`);
  console.log('');

  const rawIssues = [
    ...auditEndpoints(releaseText, openapiEndpoints),
    ...auditGuides(releaseText, guides),
    ...auditIntegrations(releaseText, integrations),
    ...auditFields(releaseText, knownFields),
  ];

  // Deduplicate by detail string
  const seen = new Set();
  const allIssues = rawIssues.filter((i) => {
    if (seen.has(i.detail)) return false;
    seen.add(i.detail);
    return true;
  });

  const report = generateReport(allIssues);
  console.log(report);

  // Write report to file
  const reportPath = path.join(ROOT, 'audit-report.md');
  fs.writeFileSync(reportPath, report);
  console.log(`\n📄 Report written to: ${reportPath}`);

  // Write to GitHub Actions summary if available
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
    console.log('📄 Report appended to GitHub Actions job summary.');
  }

  // Exit with code 0 always (audit is informational, not blocking)
  // Teams can change this to exit(1) if they want to enforce zero audit issues
  process.exit(0);
}

main();
