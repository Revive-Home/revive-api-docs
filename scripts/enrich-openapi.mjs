#!/usr/bin/env node
/**
 * Post-processes openapi.json by merging enrichments from openapi-enrichments.json.
 *
 * Enrichments can add/override:
 *   - Tag descriptions (shown as group headers in Mintlify)
 *   - Endpoint summary, description
 *   - Parameter descriptions
 *   - Response descriptions and examples
 *
 * Usage:
 *   node scripts/enrich-openapi.mjs
 *
 * Reads:  openapi.json + scripts/openapi-enrichments*.json
 * Writes: openapi.json (in-place)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const specPath = path.join(ROOT, 'openapi.json');
const scriptsDir = path.join(ROOT, 'scripts');

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

// Load main enrichments file (tags)
const enrichments = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'openapi-enrichments.json'), 'utf8'));

// Load all path enrichment files and merge into a single paths object
const allPaths = { ...enrichments.paths };
const pathFiles = fs.readdirSync(scriptsDir)
  .filter((f) => (f.startsWith('openapi-enrichments-paths') || f.startsWith('openapi-enrichments-responses')) && f.endsWith('.json'))
  .sort();

for (const file of pathFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(scriptsDir, file), 'utf8'));
  for (const [key, val] of Object.entries(data)) {
    if (!allPaths[key]) {
      allPaths[key] = val;
    } else {
      // Deep merge: only overwrite fields that are actually defined
      for (const [field, fieldVal] of Object.entries(val)) {
        if (fieldVal !== undefined && fieldVal !== null) {
          allPaths[key][field] = fieldVal;
        }
      }
    }
  }
  console.log(`  Loaded ${Object.keys(data).length} path(s) from ${file}`);
}

let enrichedCount = 0;

// --- Enrich tag descriptions ---
if (enrichments.tags) {
  if (!spec.tags) spec.tags = [];

  const existingTags = new Map(spec.tags.map((t) => [t.name, t]));

  for (const [tagName, tagInfo] of Object.entries(enrichments.tags)) {
    if (existingTags.has(tagName)) {
      Object.assign(existingTags.get(tagName), tagInfo);
    } else {
      spec.tags.push({ name: tagName, ...tagInfo });
    }
  }

  // Collect all tags used in paths and ensure they appear in spec.tags
  const usedTags = new Set();
  for (const methods of Object.values(spec.paths || {})) {
    for (const op of Object.values(methods)) {
      (op.tags || []).forEach((t) => usedTags.add(t));
    }
  }

  const specTagNames = new Set(spec.tags.map((t) => t.name));
  for (const t of usedTags) {
    if (!specTagNames.has(t)) {
      spec.tags.push({ name: t });
    }
  }
}

// --- Enrich paths ---
if (Object.keys(allPaths).length > 0) {
  for (const [key, overlay] of Object.entries(allPaths)) {
    // key format: "METHOD /path"
    const spaceIdx = key.indexOf(' ');
    if (spaceIdx === -1) continue;

    const method = key.slice(0, spaceIdx).toLowerCase();
    const pathStr = key.slice(spaceIdx + 1);

    const pathObj = spec.paths?.[pathStr];
    if (!pathObj || !pathObj[method]) {
      console.warn(`  ⚠ Path not found in spec: ${key}`);
      continue;
    }

    const operation = pathObj[method];

    // Merge summary
    if (overlay.summary) {
      operation.summary = overlay.summary;
    }

    // Merge description
    if (overlay.description) {
      operation.description = overlay.description;
    }

    // Merge parameter descriptions
    if (overlay.parameters && operation.parameters) {
      for (const param of operation.parameters) {
        if (overlay.parameters[param.name]) {
          param.description = overlay.parameters[param.name];
        }
      }
    }

    // Merge request body parameter descriptions
    if (overlay.parameters) {
      const schema = operation.requestBody?.content?.['application/json']?.schema;
      if (schema?.properties) {
        for (const [propName, desc] of Object.entries(overlay.parameters)) {
          if (schema.properties[propName] && typeof desc === 'string') {
            schema.properties[propName].description = desc;
          }
        }
      }
    }

    // Merge per-property examples into request body schema
    if (overlay.requestExample) {
      const schema = operation.requestBody?.content?.['application/json']?.schema;
      if (schema?.properties) {
        for (const [propName, exValue] of Object.entries(overlay.requestExample)) {
          if (schema.properties[propName] && schema.properties[propName].example === undefined) {
            schema.properties[propName].example = exValue;
          }
        }
      }
    }

    // Merge full request body example
    if (overlay.requestExample) {
      if (!operation.requestBody) {
        operation.requestBody = { required: true, content: { 'application/json': { schema: { type: 'object' } } } };
      }
      const jsonContent = operation.requestBody.content?.['application/json'] || {};
      jsonContent.example = overlay.requestExample;
      if (operation.requestBody.content) {
        operation.requestBody.content['application/json'] = jsonContent;
      }
    }

    // Merge response descriptions and examples
    if (overlay.responses) {
      for (const [status, responseOverlay] of Object.entries(overlay.responses)) {
        if (!operation.responses) operation.responses = {};
        if (!operation.responses[status]) {
          operation.responses[status] = {};
        }

        const resp = operation.responses[status];

        if (responseOverlay.description) {
          resp.description = responseOverlay.description;
        }

        if (responseOverlay.example) {
          if (!resp.content) {
            resp.content = { 'application/json': {} };
          }
          const jsonContent = resp.content['application/json'] || (resp.content['application/json'] = {});
          jsonContent.example = responseOverlay.example;
        }
      }
    }

    enrichedCount++;
  }
}

// --- Inject enum values from enrichment parameter descriptions ---
// Parses patterns like "'value1', 'value2', 'value3'" from descriptions
for (const [pathStr, methods] of Object.entries(spec.paths || {})) {
  for (const [method, operation] of Object.entries(methods)) {
    const schema = operation.requestBody?.content?.['application/json']?.schema;
    if (!schema?.properties) continue;
    for (const [propName, prop] of Object.entries(schema.properties)) {
      if (prop.enum || !prop.description || prop.type !== 'string') continue;
      const enumMatch = prop.description.match(/^'([^']+)'(?:,\s*'([^']+)')+\.?$/);
      if (!enumMatch) {
        // Try matching inline: "Filter: 'A', 'B', or 'C'."
        const inlineMatch = prop.description.match(/'([^']+)'/g);
        if (inlineMatch && inlineMatch.length >= 2 && inlineMatch.length <= 8) {
          prop.enum = inlineMatch.map((m) => m.replace(/'/g, ''));
        }
      }
    }
  }
}

// --- Inject standard error responses and upgrade POST creates to 201 ---
const errorResponses = {
  '400': {
    description: 'Bad request — invalid or missing parameters.',
    content: { 'application/json': { example: { status: 'error', message: 'Validation failed.', errors: [{ field: 'email', message: 'Email is required.' }] } } }
  },
  '401': {
    description: 'Unauthorized — missing or invalid Bearer token.',
    content: { 'application/json': { example: { status: 'error', message: 'Authentication required. Provide a valid Firebase JWT in the Authorization header.' } } }
  },
  '403': {
    description: 'Forbidden — you do not have permission to access this resource.',
    content: { 'application/json': { example: { status: 'error', message: 'Insufficient permissions.' } } }
  },
  '404': {
    description: 'Not found — the requested resource does not exist.',
    content: { 'application/json': { example: { status: 'error', message: 'Resource not found.' } } }
  },
  '422': {
    description: 'Unprocessable entity — request was understood but contains semantic errors.',
    content: { 'application/json': { example: { status: 'error', message: 'Unprocessable entity.', errors: [{ field: 'dealId', message: 'Deal is already closed.' }] } } }
  },
  '500': {
    description: 'Internal server error.',
    content: { 'application/json': { example: { status: 'error', message: 'An unexpected error occurred. Please try again later.' } } }
  }
};

// Keywords in path/summary that indicate a create operation (should be 201)
const createPatterns = [/\/create/, /\/register/, /\/import/];

for (const [pathStr, methods] of Object.entries(spec.paths || {})) {
  for (const [method, operation] of Object.entries(methods)) {
    if (!operation.responses) operation.responses = {};

    // Upgrade POST endpoints that create resources from 200 → 201
    const isCreate = method === 'post' && (
      createPatterns.some((p) => p.test(pathStr)) ||
      (operation.summary || '').toLowerCase().includes('create') ||
      // POST to a collection root (e.g. POST /v1/contacts/) that isn't search/webhook
      (pathStr.endsWith('/') && !pathStr.includes('search') && !pathStr.includes('webhook'))
    );

    if (isCreate && operation.responses['200'] && !operation.responses['201']) {
      operation.responses['201'] = { ...operation.responses['200'] };
      operation.responses['201'].description = (operation.responses['200'].description || 'Created.').replace(/^(.)/,  (_, c) => c.toUpperCase());
      delete operation.responses['200'];
    }

    // Upgrade DELETE endpoints — add 204 if not present
    if (method === 'delete' && !operation.responses['204']) {
      operation.responses['204'] = { description: 'No content — resource deleted successfully.' };
    }

    // Add standard error responses if missing
    const needsAuth = pathStr !== '/health';
    for (const [code, resp] of Object.entries(errorResponses)) {
      if (operation.responses[code]) continue;
      // Skip 401/403 for unauthenticated endpoints
      if ((code === '401' || code === '403') && !needsAuth) continue;
      // Skip 404 for list/search/webhook endpoints
      if (code === '404' && (pathStr.endsWith('/') || pathStr.includes('search') || pathStr.includes('webhook'))) continue;
      // Skip 422 for GET/DELETE (they don't send bodies)
      if (code === '422' && (method === 'get' || method === 'delete')) continue;
      operation.responses[code] = { ...resp };
    }
  }
}

// --- Clean up path-based summaries (sidebar labels) ---
for (const [pathStr, methods] of Object.entries(spec.paths || {})) {
  for (const [method, operation] of Object.entries(methods)) {
    const summary = operation.summary || '';
    // If summary looks like a path (contains /v1/ or /v2/ or starts with v1/ v2/), clean it
    if (/(?:^|\/)v[12]\//.test(summary)) {
      // Strip version prefix and convert path segments to readable text
      const cleaned = summary
        .replace(/^\/?(v[12]\/)?/, '')     // strip leading /v2/
        .replace(/\/\{[^}]+\}/g, '')       // remove path params like /{id}
        .replace(/\//g, ' ')               // slashes to spaces
        .replace(/-/g, ' ')                // hyphens to spaces
        .replace(/\s+/g, ' ')             // collapse whitespace
        .trim();
      // Build a readable label: "METHOD resource" e.g. "Create calendar"
      const methodLabels = { get: 'Get', post: 'Create', patch: 'Update', put: 'Update', delete: 'Delete' };
      const verb = methodLabels[method] || method.toUpperCase();
      const noun = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
      operation.summary = `${verb} ${noun}`.replace(/\s+/g, ' ').trim();
    }
  }
}

// v1 endpoints are kept — the API still uses v1 for most routes

// --- Prepend endpoint path to every description for visibility ---
for (const [pathStr, methods] of Object.entries(spec.paths || {})) {
  for (const [method, operation] of Object.entries(methods)) {
    const badge = `\`${method.toUpperCase()} ${pathStr}\``;
    const desc = operation.description || '';
    if (!desc.startsWith('`')) {
      operation.description = desc ? `${badge}\n\n${desc}` : badge;
    }
  }
}

fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
console.log(`\nEnriched ${enrichedCount} endpoint(s) and ${Object.keys(enrichments.tags || {}).length} tag(s) in openapi.json`);
