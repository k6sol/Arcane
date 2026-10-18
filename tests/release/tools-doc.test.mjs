import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ARCANE_NATIVE_TOOL_NAMES, ARCANE_TOOL_NAMES } from '../../dist/packages/protocol/src/arcane-tools.js';
import { renderToolDocs, TOOLS_DOC } from '../../scripts/generate-tool-docs.mjs';

// Requires `npm run build` first (npm test builds before running this suite).
test('docs/TOOLS.md matches the MCP server tool list', async () => {
  const expected = await renderToolDocs();
  const actual = (await readFile(TOOLS_DOC, 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(actual, expected, 'docs/TOOLS.md is stale. Run: npm run build && node scripts/generate-tool-docs.mjs');
});

test('docs/TOOLS.md documents every reviewed tool name', async () => {
  const doc = await readFile(TOOLS_DOC, 'utf8');
  for (const name of new Set([...ARCANE_TOOL_NAMES, ...ARCANE_NATIVE_TOOL_NAMES])) {
    assert.ok(doc.includes('### `' + name + '`'), name + ' is missing from docs/TOOLS.md');
  }
});
