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
  Object.assign(allPaths, data);
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
