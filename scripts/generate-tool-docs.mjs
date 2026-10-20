/**
 * Regenerate docs/TOOLS.md from the Arcane MCP server's own tool list.
 *
 *   npm run build && node scripts/generate-tool-docs.mjs          # write docs/TOOLS.md
 *   npm run build && node scripts/generate-tool-docs.mjs --check  # exit 1 when the doc is stale
 *
 * The server is created twice in memory (generic and native-session audiences) with a client that
 * points at an unreachable daemon. Only tools/list is called, so no daemon, Studio, Blender or
 * provider is contacted.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TOOLS_DOC = join(ROOT, 'docs', 'TOOLS.md');
const DIST = join(ROOT, 'dist', 'apps', 'mcp', 'src');

async function listTools(assetAudience) {
  const { createMcpServer } = await import(pathToFileURL(join(DIST, 'server.js')).href);
  const { DaemonClient } = await import(pathToFileURL(join(DIST, 'daemon-client.js')).href);
  const server = createMcpServer({ projectRoot: ROOT,
    client: new DaemonClient({ url: 'http://127.0.0.1:1', token: 'a'.repeat(64), assetAudience }) });
  const client = new Client({ name: 'arcane-tool-docs', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools); cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    try { await client.close(); } finally { await server.close(); }
  }
}

const GROUPS = [
  ['Studio connection and reading', ['sessions', 'scene_children', 'scene_inspect', 'scene_search', 'selection_read', 'script_read', 'script_search', 'studio_output_read', 'studio_viewport_capture']],
  ['Studio building and editing', ['scene_create', 'scene_update', 'scene_build', 'environment_apply', 'terrain_generate', 'scene_delete', 'script_update', 'script_set_enabled']],
  ['Receipts and undo', ['receipt_status', 'receipt_restore']],
  ['Playtests', ['playtest_request', 'playtest_status', 'playtest_cancel']],
  ['Creator Store and Roblox AI generation', ['studio_asset_search', 'studio_asset_insert', 'studio_asset_generate']],
  ['Blender assets', ['assets_probe', 'assets_jobs', 'assets_start', 'assets_cancel', 'assets_manifest', 'assets_procedural', 'assets_preview']],
  ['Bundled skills', ['skills_recommend', 'skills_list', 'skills_get']],
  ['Work graph', ['work_runs', 'work_ready', 'work_create', 'work_claim', 'work_progress', 'work_submit']],
];

const cell = text => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const resolveRef = (schema, root) => {
  if (!schema || typeof schema.$ref !== 'string') return schema;
  const path = schema.$ref.replace(/^#\//, '').split('/');
  let node = root;
  for (const key of path) node = node?.[key];
  return node ? { ...node, ...(schema.description ? { description: schema.description } : {}) } : schema;
};

function typeOf(schema, root) {
  schema = resolveRef(schema, root) ?? {};
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.length <= 8 ? schema.enum.map(v => JSON.stringify(v)).join(' / ') : `enum (${schema.enum.length} values)`;
  const options = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(options)) return [...new Set(options.map(option => typeOf(option, root)))].join(' or ');
  if (schema.type === 'array') return `${typeOf(schema.items, root)}[]`;
  if (Array.isArray(schema.type)) return schema.type.join(' or ');
  if (schema.type === 'object' && schema.properties && ['instanceId', 'sessionId', 'className'].every(key => key in schema.properties)) return 'instance ref';
  return schema.type ?? 'any';
}

function limitsOf(schema, root) {
  schema = resolveRef(schema, root) ?? {};
  const out = [];
  if (schema.minimum !== undefined || schema.maximum !== undefined) out.push(`${schema.minimum ?? '…'}–${schema.maximum ?? '…'}`);
  if (schema.maxLength !== undefined) out.push(`≤ ${schema.maxLength} chars`);
  if (schema.minItems !== undefined && schema.minItems === schema.maxItems) out.push(`exactly ${schema.minItems} items`);
  else if (schema.minItems !== undefined || schema.maxItems !== undefined) out.push(`${schema.minItems ?? 0}–${schema.maxItems ?? '…'} items`);
  if (schema.default !== undefined) out.push(`default ${JSON.stringify(schema.default)}`);
  return out.join(', ');
}

function safety(tool) {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint) return 'Read-only';
  return a.destructiveHint ? 'Writes (may change or remove existing state)' : 'Writes (additive)';
}

function renderTool(tool) {
  const schema = tool.inputSchema ?? {}, required = new Set(schema.required ?? []);
  const lines = [`### \`${tool.name}\``, '', `**Safety:** ${safety(tool)}`, '', tool.description.trim(), ''];
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length) {
    lines.push('| Parameter | Type | Required | Limits |', '|---|---|---|---|');
    for (const [name, property] of properties) {
      lines.push(`| \`${name}\` | ${cell(typeOf(property, schema))} | ${required.has(name) ? 'yes' : 'no'} | ${cell(limitsOf(property, schema))} |`);
    }
  } else lines.push('No parameters.');
  lines.push('');
  return lines.join('\n');
}

export async function renderToolDocs() {
  const generic = await listTools('generic');
  const native = await listTools('native-session');
  const genericNames = new Set(generic.map(tool => tool.name));
  const nativeOnly = native.filter(tool => !genericNames.has(tool.name));
  const byName = new Map(generic.map(tool => [tool.name, tool]));
  const grouped = new Set(GROUPS.flatMap(([, names]) => names));
  const other = generic.filter(tool => !grouped.has(tool.name)).map(tool => tool.name);

  const out = [
    '<!-- Generated by scripts/generate-tool-docs.mjs from the Arcane MCP server tool list. Do not edit by hand. -->',
    '',
    '# Arcane MCP tools',
    '',
    `Arcane's MCP server (\`arcane-studio\`) exposes ${generic.length} tools to every connected client. Arcane's in-app ChatGPT chat also gets ${nativeOnly.length} asset-delivery tools (${native.length} in total). This reference is generated from the tool definitions in \`apps/mcp/src\`; descriptions are the exact text the model receives.`,
    '',
    'Regenerate after changing any tool:',
    '',
    '```sh',
    'npm run build',
    'node scripts/generate-tool-docs.mjs',
    '```',
    '',
    '`node scripts/generate-tool-docs.mjs --check` (also run by `tests/release/tools-doc.test.mjs`) fails when this file is out of date.',
    '',
    '## Safety model',
    '',
    '- **Read-only** tools never edit the place, project files or jobs.',
    '- **Studio writes** need a live paired session that grants writes to the target root, with Studio in Edit mode. Each returns a receipt. `receipt_restore` undoes a receipt while the changed state is untouched; `environment_apply` and `terrain_generate` are undone with Studio Undo instead.',
    '- A timed-out write is ambiguous. Check `receipt_status`, `assets_jobs`, `playtest_status` or `work_runs` instead of retrying.',
    '- Instance refs are opaque. Copy them from results; never construct them.',
    '- No tool buys, publishes or uploads assets. Creator Store results are free items only, and scripts in inserted assets are removed unless the user asks to keep them.',
    '- `playtest_request` only prepares a playtest; a person approves it in Arcane.',
    '',
    '## Contents',
    '',
  ];
  const sections = [...GROUPS.map(([title, names]) => [title, names.filter(name => byName.has(name))]), ...(other.length ? [['Other', other]] : [])]
    .filter(([, names]) => names.length);
  for (const [title, names] of sections) out.push(`- **${title}:** ${names.map(name => `\`${name}\``).join(', ')}`);
  if (nativeOnly.length) out.push(`- **In-app asset delivery:** ${nativeOnly.map(tool => `\`${tool.name}\``).join(', ')}`);
  out.push('');
  for (const [title, names] of sections) {
    out.push(`## ${title}`, '');
    for (const name of names) out.push(renderTool(byName.get(name)));
  }
  if (nativeOnly.length) {
    out.push('## In-app asset delivery', '', "These tools exist only in Arcane's in-app ChatGPT chat. They are scoped to that exact project and conversation and need explicit asset permission. Meshes placed this way live only in the current Studio Edit session.", '');
    for (const tool of nativeOnly) out.push(renderTool(tool));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = await renderToolDocs();
  if (process.argv.includes('--check')) {
    const current = await readFile(TOOLS_DOC, 'utf8').catch(() => '');
    if (current.replace(/\r\n/g, '\n') !== text) {
      process.stderr.write('docs/TOOLS.md is out of date. Run: npm run build && node scripts/generate-tool-docs.mjs\n');
      process.exit(1);
    }
    process.stdout.write('docs/TOOLS.md is current.\n');
  } else {
    await writeFile(TOOLS_DOC, text);
    process.stdout.write(`Wrote ${TOOLS_DOC}\n`);
  }
}
