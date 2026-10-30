import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { CODEX_LIMITS } from '../../packages/codex-client/src/types.js';
import { ARCANE_TOOL_NAMES, ARCANE_NATIVE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';

// Exact inspected .protocol fields, kept local because generated TS files use
// extensionless imports and are source-reference material, not NodeNext modules.
// The source anchors below fail if this pinned boundary changes.
type JsonValue = number | string | boolean | JsonValue[] | { [key: string]: JsonValue | undefined } | null;
interface Tool {
  name: string; title?: string; description?: string; inputSchema: JsonValue;
  outputSchema?: JsonValue; annotations?: JsonValue; icons?: JsonValue[]; _meta?: JsonValue;
}
interface McpServerStatus {
  name: string; runtimeStatus: 'connected'; pluginId: null; httpOrigin: null;
  serverInfo: { name: string; title: string | null; version: string; description: string | null;
    icons: JsonValue[] | null; websiteUrl: string | null };
  serverCapabilities: JsonValue; tools: { [key: string]: Tool | undefined }; toolsError: null;
  resources: []; resourceTemplates: []; authStatus: 'unsupported';
}
interface ListMcpServerStatusResponse { data: McpServerStatus[]; nextCursor: null }

// Real server metadata over the official SDK's in-memory pair only. No tool is
// called, no native CLI/provider is opened, and the daemon fetch port must stay unused.
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && Object.values(value).every(isJsonValue);
}
function wireJson(value: unknown): JsonValue {
  const wire = JSON.stringify(value); assert.ok(typeof wire === 'string', 'catalogue metadata must have a JSON encoding');
  const detached: unknown = JSON.parse(wire);
  assert.ok(isJsonValue(detached), 'catalogue metadata must be JSON-representable');
  return detached;
}
function isSupportedExecution(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== 'taskSupport') return false;
  const field = Object.getOwnPropertyDescriptor(value, 'taskSupport');
  return field?.enumerable === true && Object.hasOwn(field, 'value') && field.value === 'forbidden';
}
function pinnedTool(tool: SdkTool): Tool {
  // These are the exact fields of the committed .protocol/Tool type. Preserve
  // complete actual schemas/annotations; never replace schemas with tool names.
  // SDK registerTool adds this exact default. Codex's inspected ToolSerde
  // projects only the pinned fields below; execution is not a native Tool field.
  // Required/optional task execution and unfamiliar metadata are not inferred.
  assert.ok(isSupportedExecution(tool.execution), 'unsupported SDK execution metadata requires an explicit pinned-protocol review');
  const value: Tool = { name: tool.name, inputSchema: wireJson(tool.inputSchema) };
  if (tool.title !== undefined) value.title = tool.title;
  if (tool.description !== undefined) value.description = tool.description;
  if (tool.outputSchema !== undefined) value.outputSchema = wireJson(tool.outputSchema);
  if (tool.annotations !== undefined) value.annotations = wireJson(tool.annotations);
  if (tool.icons !== undefined) value.icons = tool.icons.map(wireJson);
  if (tool._meta !== undefined) value._meta = wireJson(tool._meta);
  return value;
}

test('actual native managed MCP catalogue fits the unchanged Codex status-frame budget', { timeout: CODEX_LIMITS.requestTimeoutMs }, async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Catalogue evidence must not contact a daemon or provider.'); });
  t.after(() => { assert.equal(network.mock.callCount(), 0); });
  assert.ok(isSupportedExecution(undefined));
  assert.ok(isSupportedExecution({ taskSupport: 'forbidden' }));
  for (const execution of [{ taskSupport: 'required' }, { taskSupport: 'optional' },
    { taskSupport: 'forbidden', extra: true }, {}, null, ['forbidden']])
    assert.equal(isSupportedExecution(execution), false);
  let executionReads = 0;
  assert.equal(isSupportedExecution({ get taskSupport() { executionReads++; return 'forbidden'; } }), false);
  assert.equal(executionReads, 0);
  assert.equal(isSupportedExecution(Object.defineProperty({}, 'taskSupport', { value: 'forbidden' })), false);
  assert.equal(isSupportedExecution({ taskSupport: 'forbidden', [Symbol('extra')]: true }), false);
  const pinnedRoot = resolve(process.cwd(), 'packages/codex-client/.protocol');
  const [toolType, statusType, responseType] = await Promise.all([
    readFile(resolve(pinnedRoot, 'Tool.ts'), 'utf8'), readFile(resolve(pinnedRoot, 'v2/McpServerStatus.ts'), 'utf8'),
    readFile(resolve(pinnedRoot, 'v2/ListMcpServerStatusResponse.ts'), 'utf8'),
  ]);
  for (const field of ['name: string', 'title?: string', 'description?: string', 'inputSchema: JsonValue',
    'outputSchema?: JsonValue', 'annotations?: JsonValue', 'icons?: Array<JsonValue>', '_meta?: JsonValue'])
    assert.ok(toolType.includes(field), 'pinned Tool field contract changed');
  for (const field of ['name: string', 'runtimeStatus: McpServerConnectionStatus | null', 'pluginId: string | null',
    'httpOrigin: string | null', 'serverInfo: McpServerInfo | null', 'serverCapabilities: JsonValue | null',
    'tools: { [key in string]?: Tool }', 'toolsError: string | null', 'resources: Array<Resource>',
    'resourceTemplates: Array<ResourceTemplate>', 'authStatus: McpAuthStatus'])
    assert.ok(statusType.includes(field), 'pinned McpServerStatus field contract changed');
  assert.ok(responseType.includes('data: Array<McpServerStatus>') && responseType.includes('nextCursor: string | null'),
    'pinned status response pagination contract changed');
  const measurements: { toolCount: number; frameBytes: number }[] = [];
  for (const native of [false, true]) {
    const daemon = new DaemonClient({ url: 'http://127.0.0.1:1', token: 'synthetic-catalogue-only-bearer', assetAudience: native ? 'native-session' : 'generic' });
    const server = createMcpServer({ client: daemon, projectRoot: resolve(process.cwd()) });
    const client = new Client({ name: 'catalogue-frame-evidence', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const listed = await client.listTools(undefined, { timeout: CODEX_LIMITS.requestTimeoutMs });
      assert.ok(listed.nextCursor == null, 'the actual local server catalogue must be complete in this response');
      const expected = native ? ARCANE_NATIVE_TOOL_NAMES : ARCANE_TOOL_NAMES;
      assert.equal(listed.tools.length, expected.length);
      assert.ok(listed.tools.every((tool, index) => tool.name === expected[index]), 'actual catalogue must match the reviewed selected inventory');
      // Existing native inventory bound in session.ts/#inventory; not a new cap.
      assert.ok(listed.tools.length <= 2048, 'catalogue must respect the existing native inventory bound');
      const tools: McpServerStatus['tools'] = {};
      for (const tool of listed.tools) {
        assert.ok(!Object.hasOwn(tools, tool.name), 'catalogue tool names must be unique');
        tools[tool.name] = pinnedTool(tool);
      }
      const info = client.getServerVersion(), capabilities = client.getServerCapabilities();
      assert.ok(info && capabilities, 'actual SDK initialization metadata must be present');
      const status: McpServerStatus = {
        name: 'arcane', runtimeStatus: 'connected', pluginId: null, httpOrigin: null,
        serverInfo: { name: info.name, title: info.title ?? null, version: info.version,
          description: info.description ?? null, icons: info.icons?.map(wireJson) ?? null, websiteUrl: info.websiteUrl ?? null },
        serverCapabilities: wireJson(capabilities), tools, toolsError: null,
        resources: [], resourceTemplates: [], authStatus: 'unsupported',
      };
      const result: ListMcpServerStatusResponse = { data: [status], nextCursor: null };
      // Codex's actual stdio response envelope is {id,result}; the delimiter is
      // excluded by its inbound frame parser. A largest safe numeric ID avoids
      // understating the envelope. No request/config/history/token is included.
      const frameBytes = Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, result }), 'utf8');
      assert.ok(Number.isSafeInteger(frameBytes) && frameBytes > 0);
      measurements.push({ toolCount: listed.tools.length, frameBytes });
    } finally {
      try { await client.close(); } finally { await server.close(); }
    }
  }
  const full = measurements[0], native = measurements[1]; assert.ok(full && native);
  // Only finite counts/byte totals are emitted, even when the native assertion
  // fails. Full standalone catalogue size is observational: it has no asserted
  // Codex transport relationship. Current data cannot diagnose an older app run.
  t.diagnostic(JSON.stringify({ fullToolCount: full.toolCount, fullFrameBytes: full.frameBytes,
    nativeToolCount: native.toolCount, nativeFrameBytes: native.frameBytes, maxFrameBytes: CODEX_LIMITS.maxFrameBytes }));
  assert.equal(network.mock.callCount(), 0);
  assert.ok(native.frameBytes <= CODEX_LIMITS.maxFrameBytes,
    `native managed status frame is ${native.frameBytes} bytes; unchanged bound is ${CODEX_LIMITS.maxFrameBytes}`);
});
