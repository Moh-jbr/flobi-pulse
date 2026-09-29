import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The browser preview (src/lib/browser-bridge.js) runs the demo engine inside the
// page, so nothing it imports, directly or through other modules, may use Node APIs.
// (A Node import there breaks the renderer build, not just the preview.)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function importsOf(file) {
  // Comments out first: JSDoc types like `import('../sources/logging.mjs')` aren't imports.
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  return [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm), ...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

test('everything the browser preview imports from electron/ stays free of Node APIs', () => {
  const start = path.join(root, 'src/lib/browser-bridge.js');
  const seen = new Set();
  const offenders = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith('node:') || ['fs', 'path', 'os', 'http', 'https', 'http2', 'crypto', 'child_process', 'electron'].includes(spec)) offenders.push(`${path.relative(root, file)} imports ${spec}`);
      else if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
    }
  };
  walk(start);
  assert.ok([...seen].some((f) => f.includes(`${path.sep}electron${path.sep}core${path.sep}engine${path.sep}pipeline.mjs`)), 'walks into the engine');
  assert.deepEqual(offenders, []);
});
