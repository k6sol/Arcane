import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Token-lean model surface. Every tool list and result is paid on every turn, so the serialized
// form drops what the model never needs. Nothing here changes validation: each call is still
// parsed by the tool's strict zod schema, and the daemon and plugin keep their own checks.

type Node = Record<string, unknown>;
const REF_KEYS = ['instanceId', 'sessionId', 'root', 'pathSegments', 'className'];
const isNode = (value: unknown): value is Node => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isTagged = (value: unknown) => isNode(value) && isNode(value.properties) && Object.keys(value.properties).join() === 'type,value'
  && isNode(value.properties.type) && typeof value.properties.type.const === 'string';

/** Compact one advertised JSON Schema node: same accepted shape for the model, fewer tokens. */
export function compactToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactToolSchema);
  if (!isNode(value)) return value;
  const node: Node = {};
  for (const [key, item] of Object.entries(value)) node[key] = key === 'enum' || key === 'required' || key === 'const' || key === 'default' ? item : compactToolSchema(item);
  delete node.$schema;
  // "default" is an annotation (never validated); false and [] are what an omitted flag or list already means.
  if (node.default === false || (Array.isArray(node.default) && !node.default.length)) delete node.default;
  // .describe('') clears an inherited description where the tool text already covers the field.
  if (node.description === '') delete node.description;
  // A string enum or const already fixes the type.
  if (node.type === 'string' && ((Array.isArray(node.enum) && node.enum.length && node.enum.every(item => typeof item === 'string')) || typeof node.const === 'string')) delete node.type;
  // Property names are always strings, and an empty additionalProperties schema allows anything anyway.
  if (isNode(node.propertyNames) && node.propertyNames.type === 'string') {
    if (Object.keys(node.propertyNames).join() === 'type') delete node.propertyNames; else { const { type: _type, ...names } = node.propertyNames; node.propertyNames = names; }
  }
  if (isNode(node.additionalProperties) && !Object.keys(node.additionalProperties).length) delete node.additionalProperties;
  if (node.type === 'string') {
    if (node.minLength === 1) delete node.minLength;
    if (typeof node.maxLength === 'number' && node.maxLength >= 256) delete node.maxLength;
  }
  // Fixed tuples with identical members, e.g. [x,y,z]: one item schema plus the exact length.
  const items = node.items;
  if (node.type === 'array' && Array.isArray(items) && items.length && items.every(item => same(item, items[0]))
      && node.minItems === items.length && node.maxItems === items.length) { node.items = items[0]; delete node.additionalItems; }
  // Where a compact form ([x,y,z], "#rrggbb") is accepted, advertise only it; tagged {type,value} still validates.
  if (Array.isArray(node.anyOf) && node.anyOf.length > 1) {
    const kept = node.anyOf.filter(option => !isTagged(option));
    if (kept.length) node.anyOf = kept;
  }
  if (Array.isArray(node.anyOf) && node.anyOf.length === 1 && isNode(node.anyOf[0]) && !Object.keys(node.anyOf[0]).some(key => key in node)) {
    const [only] = node.anyOf as Node[]; delete node.anyOf; Object.assign(node, only);
  }
  // Opaque instance refs are copied from results unchanged, in the compact form results use (no
  // sessionId; path string). serveCompactRefs re-expands them per call before strict validation.
  if (node.type === 'object' && isNode(node.properties) && same(Object.keys(node.properties), REF_KEYS)) {
    // Full refs (sessionId, pathSegments) stay accepted; extra keys are still refused.
    node.properties = { instanceId: { type: 'string' }, root: { type: 'string' }, path: { type: 'string' }, className: { type: 'string' },
      sessionId: { type: 'string' }, pathSegments: { type: 'array', items: { type: 'string' } } };
    node.required = ['instanceId', 'root', 'className'];
  }
  return node;
}

const HOIST_MIN_CHARS = 48;
/** Child schema positions only (never property-name maps, enums or defaults). */
function childSchemas(node: Node): { holder: Node | unknown[]; key: string | number; name: string }[] {
  const out: { holder: Node | unknown[]; key: string | number; name: string }[] = [];
  if (isNode(node.properties)) for (const key of Object.keys(node.properties)) out.push({ holder: node.properties, key, name: key });
  if (isNode(node.additionalProperties)) out.push({ holder: node, key: 'additionalProperties', name: 'value' });
  if (isNode(node.items)) out.push({ holder: node, key: 'items', name: 'item' });
  for (const list of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const) {
    const options = node[list];
    if (Array.isArray(options)) options.forEach((_, index) => out.push({ holder: options, key: index, name: 'option' }));
  }
  return out;
}
const read = (slot: { holder: Node | unknown[]; key: string | number }) => (slot.holder as Record<string | number, unknown>)[slot.key];
const write = (slot: { holder: Node | unknown[]; key: string | number }, value: unknown) => { (slot.holder as Record<string | number, unknown>)[slot.key] = value; };
const withoutDescription = (node: Node) => { const { description: _description, ...rest } = node; return JSON.stringify(rest); };

/**
 * Hoist subschemas repeated within one tool (shared property sets, colour/vector unions) into
 * definitions with $ref, as the SDK already does for recursive JSON values. Equivalent schema.
 */
export function hoistRepeatedSchemas(schema: Node): Node {
  const root: Node = structuredClone(schema), definitions: Node = isNode(root.definitions) ? root.definitions : {};
  for (let round = 0; round < 16; round++) {
    const groups = new Map<string, { slots: { holder: Node | unknown[]; key: string | number; name: string }[] }>();
    const visit = (node: Node) => {
      for (const slot of childSchemas(node)) {
        const child = read(slot);
        if (!isNode(child) || typeof child.$ref === 'string') continue;
        const text = withoutDescription(child);
        if (text.length >= HOIST_MIN_CHARS) { const group = groups.get(text) ?? { slots: [] }; group.slots.push(slot); groups.set(text, group); }
        visit(child);
      }
    };
    visit(root);
    for (const definition of Object.values(definitions)) if (isNode(definition)) visit(definition);
    let text = '', saving = 0;
    for (const [candidate, group] of groups) {
      // Each use becomes a ~35-character {"$ref":"#/definitions/name"} plus one definitions entry; hoist only for a real saving.
      const gain = (group.slots.length - 1) * candidate.length - group.slots.length * 35 - 24;
      if (group.slots.length > 1 && gain > saving) { text = candidate; saving = gain; }
    }
    if (!saving) break;
    const { slots } = groups.get(text)!;
    const descriptions = new Set(slots.map(slot => (read(slot) as Node).description));
    const counts = new Map<string, number>();
    for (const slot of slots) if (!['option', 'item', 'value'].includes(slot.name)) counts.set(slot.name, (counts.get(slot.name) ?? 0) + 1);
    const common = [...counts].sort((a, b) => b[1] - a[1])[0];
    const base = text.includes('"pathSegments"') && text.includes('"instanceId"') ? 'ref' : common && common[1] > 1 ? common[0]
      : text.includes('[0-9a-fA-F]') && text.length < 200 ? 'color' : text.includes('"minItems":3,"maxItems":3') && text.length < 200 ? 'vector3' : common ? common[0] : 'shared';
    let name = base;
    for (let suffix = 2; name in definitions; suffix++) name = base + suffix;
    const shared = descriptions.size === 1 ? [...descriptions][0] : undefined;
    definitions[name] = { ...(JSON.parse(text) as Node), ...(typeof shared === 'string' ? { description: shared } : {}) };
    for (const slot of slots) {
      const description = (read(slot) as Node).description;
      write(slot, { $ref: '#/definitions/' + name, ...(shared === undefined && typeof description === 'string' ? { description } : {}) });
    }
  }
  // Identical definitions (e.g. the SDK's per-use recursive JSON value schemas) collapse into one.
  const canonical = new Map<string, string>(), renamed = new Map<string, string>();
  for (const name of Object.keys(definitions)) {
    const key = JSON.stringify(definitions[name]).split('"#/definitions/' + name + '"').join('"#/definitions/\u0000"');
    const kept = canonical.get(key);
    if (kept) renamed.set(name, kept); else canonical.set(key, name);
  }
  if (renamed.size) {
    const relink = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(relink); return; }
      if (!isNode(value)) return;
      if (typeof value.$ref === 'string') { const target = renamed.get(value.$ref.replace('#/definitions/', '')); if (target) value.$ref = '#/definitions/' + target; }
      for (const [key, item] of Object.entries(value)) if (key !== 'enum' && key !== 'const' && key !== 'default') relink(item);
    };
    for (const name of renamed.keys()) delete definitions[name];
    relink(root); relink(definitions);
  }
  if (Object.keys(definitions).length) root.definitions = definitions;
  return root;
}

/** Serve tools/list with compact input schemas. Registration and call validation are untouched. */
export function serveCompactToolList(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
  if (!(handlers instanceof Map)) return;
  const list = handlers.get('tools/list') as ((request: unknown, extra: unknown) => Promise<{ tools: Node[] }>) | undefined;
  if (typeof list !== 'function') return;
  handlers.set('tools/list', async (request: unknown, extra: unknown) => {
    const result = await list(request, extra);
    return { ...result, tools: result.tools.map(tool => ({ ...tool, inputSchema: hoistRepeatedSchemas(compactToolSchema(tool.inputSchema) as Node) })) };
  });
}

// ---- Tool results ----

const BULKY_ARGS_BYTES = 200, BULKY_TEXT_CHARS = 512, BULKY_ARRAY_ITEMS = 32, SNAPSHOT_HEAD = 8;
const isRef = (value: unknown): value is Node => isNode(value) && typeof value.instanceId === 'string' && typeof value.className === 'string' && Array.isArray(value.pathSegments);

/** A scene node repeats its ref's last path segment and class name; keep only what differs. */
function compactNode(value: unknown): unknown {
  if (!isNode(value) || !isRef(value.ref)) return value;
  const { name, className, ...rest } = value;
  const segments = value.ref.pathSegments as unknown[];
  return { ...rest, ...(name !== segments.at(-1) ? { name } : {}), ...(className !== value.ref.className ? { className } : {}) };
}
/** Receipt payloads echo text the model just sent (script sources); summarise long strings by size. */
function compactSnapshot(value: unknown): unknown {
  if (typeof value === 'string') return value.length > BULKY_TEXT_CHARS ? { omitted: 'text', bytes: Buffer.byteLength(value, 'utf8') } : value;
  // Long arrays (e.g. many restored refs) keep a head plus the count of what was left out.
  if (Array.isArray(value)) return value.length > BULKY_ARRAY_ITEMS ? [...value.slice(0, SNAPSHOT_HEAD).map(compactSnapshot), { omitted: 'items', count: value.length - SNAPSHOT_HEAD }] : value.map(compactSnapshot);
  if (!isNode(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactSnapshot(item)]));
}
/**
 * The shortest decimal that parses back to the same float32. Engine Vector3/Color3/Vector2 channels
 * are float32, so 12.300000190734863 -> 12.3 is lossless: sending it back as an exact baseline
 * rebuilds the identical engine value. Anything that is not exactly a float32 is returned unchanged.
 */
export function float32Text(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value) || Math.fround(value) !== value) return value;
  for (let digits = 1; digits <= 9; digits++) { const short = Number(value.toPrecision(digits)); if (Math.fround(short) === value) return short; }
  return value;
}
/** Informational measurements only (never edit baselines): 3 decimal places. */
export const round3 = (value: number) => Number.isFinite(value) && !Number.isInteger(value) ? Math.round(value * 1000) / 1000 || 0 : value;
const FLOAT32_TAGS = new Set(['Vector3', 'Color3', 'Vector2']);
function compactFloats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactFloats);
  if (!isNode(value)) return value;
  if (typeof value.type === 'string' && FLOAT32_TAGS.has(value.type) && Array.isArray(value.value) && Object.keys(value).length === 2)
    return { type: value.type, value: value.value.map(item => typeof item === 'number' ? float32Text(item) : item) };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactFloats(item)]));
}

// script.search reports constant scan metadata and one full ref per matching line; group lines per script.
const SEARCH_CONSTANTS: Node = { literal: true, sourceKind: 'editor', columnEncoding: 'utf8-bytes', atomicSnapshot: false, skippedScripts: 0 };
function compactScriptSearch(result: Node): Node {
  if (!Array.isArray(result.items) || !result.items.every(item => isNode(item) && isRef(item.ref))) return result;
  const scripts: Node[] = [];
  for (const item of result.items as Node[]) {
    const { ref, line, column, excerpt, excerptStartColumn, excerptTruncated, childCount: _childCount, ...rest } = compactNode(item) as Node;
    const hit: Node = { line, column, excerpt, ...(excerptStartColumn !== 1 ? { excerptStartColumn } : {}), ...(excerptTruncated !== false ? { excerptTruncated } : {}) };
    const last = scripts.at(-1);
    if (last && same(last.ref, ref) && Object.keys(rest).length === 0) (last.hits as Node[]).push(hit);
    else scripts.push({ ref, ...rest, hits: [hit] });
  }
  const out: Node = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === 'items') out.items = scripts;
    else if (!(key in SEARCH_CONSTANTS && same(SEARCH_CONSTANTS[key], value)) && !(key === 'reasons' && Array.isArray(value) && !value.length)) out[key] = value;
  }
  return out;
}

// output.read: one "seq level: text" string per line ("…" marks a clipped line); zero counters and a false gap are dropped.
function compactOutput(result: Node): Node {
  const entries = result.entries;
  if (!Array.isArray(entries) || !entries.every(entry => isNode(entry) && Number.isSafeInteger(entry.seq) && typeof entry.level === 'string' && typeof entry.message === 'string')) return result;
  const out: Node = { lines: (entries as Node[]).map(entry => `${entry.seq} ${entry.level}: ${entry.message}${entry.truncated === true ? '…' : ''}`), latest: result.latest };
  if (result.omitted !== 0) out.omitted = result.omitted;
  if (result.gap !== false) out.gap = result.gap;
  return out;
}

function compactResult(method: unknown, result: unknown): unknown {
  if (!isNode(result)) return result;
  if (method === 'script.search') return compactScriptSearch(result);
  if (method === 'output.read') return compactOutput(result);
  const out = compactFloats(result) as Node;
  if (Array.isArray(out.items)) out.items = out.items.map(compactNode);
  if (Array.isArray(out.children)) out.children = out.children.map(compactNode);
  if (isNode(out.mutation)) {
    const mutation: Node = { ...out.mutation };
    if (same(mutation.ref, out.ref)) delete mutation.ref;
    if (same(mutation.after, out.created)) delete mutation.after;
    for (const key of ['before', 'after']) if (key in mutation) mutation[key] = compactSnapshot(mutation[key]);
    out.mutation = mutation;
  }
  return out;
}

/**
 * Compact a Studio command outcome for the model. The command record's per-session metadata
 * (protocol, lease, grants, timestamps, client lifetime) never changes what the model should do
 * and is repeated on every call; bulky echoed arguments are what the model just sent. State,
 * ids, ambiguity, errors and the plugin result are kept exactly (receipt snapshots summarise
 * long text by size; the daemon keeps the full immutable receipt for receipt_restore).
 */
export function compactOutcome<T>(data: T): T {
  if (!isNode(data) || !isNode(data.command) || !('protocolVersion' in data.command)) return data;
  const command = data.command;
  const args = command.args, argsBytes = args === undefined ? 0 : Buffer.byteLength(JSON.stringify(args));
  // The command id and state repeat the outcome's commandId/state; keep them only when they differ.
  return { ...data, command: {
    ...(command.id !== data.commandId ? { id: command.id } : {}), method: command.method, ...(command.state !== data.state ? { state: command.state } : {}),
    ...(args !== undefined && argsBytes <= BULKY_ARGS_BYTES ? { args } : {}),
    result: compactResult(command.method, command.result),
    ...(command.error !== null && command.error !== undefined ? { error: command.error } : {}),
  } } as T;
}

// ---- Compact opaque refs ----
//
// Results carry refs as {instanceId, root, path, className}: the sessionId is the call's own and
// pathSegments become one "a/b/c" string whenever that is lossless (the plugin resolves by
// instanceId only; pathSegments are display and root-depth data). On every tools/call the server
// re-attaches the call's sessionId (and expands path) BEFORE the tool's strict zod validation, so
// the daemon and plugin receive exactly the full refs they did before. A compact ref can therefore
// only ever address the call's own session; an explicit ref sessionId must still match it exactly.

const FULL_REF_KEYS = new Set(REF_KEYS);
const INPUT_REF_KEYS = new Set([...REF_KEYS, 'path']);
const isText = (value: unknown): value is string => typeof value === 'string';
/** A ref-shaped object as the model may send it (full or compact). */
const isInputRef = (value: unknown): value is Node => isNode(value) && isText(value.instanceId) && isText(value.root) && isText(value.className)
  && Object.keys(value).every(key => INPUT_REF_KEYS.has(key)) && (Array.isArray(value.pathSegments) || isText(value.path));
/** pathSegments become one string only when splitting it back is exact. */
const joinable = (segments: unknown[]) => segments.every(segment => isText(segment) && !segment.includes('/')) && !(segments.length === 1 && segments[0] === '');

export class RefSessionError extends Error {
  readonly code = 'REFERENCE_SESSION';
  constructor() { super('Reference must belong to the exact selected session and root.'); }
}

/** Expand compact refs in tool arguments for the call's sessionId. Throws on an explicit foreign sessionId. */
export function expandRefs(value: unknown, sessionId: string | undefined): unknown {
  if (Array.isArray(value)) return value.map(item => expandRefs(item, sessionId));
  if (!isNode(value)) return value;
  if (isInputRef(value)) {
    if (sessionId === undefined) return value; // No call session: strict validation refuses a compact ref.
    if ('sessionId' in value && value.sessionId !== sessionId) throw new RefSessionError();
    if ('path' in value && 'pathSegments' in value) return value; // Ambiguous; strict validation refuses it.
    const { path, ...rest } = value;
    return { ...rest, sessionId, ...(isText(path) ? { pathSegments: path === '' ? [] : path.split('/') } : {}) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandRefs(item, sessionId)]));
}

/** Compact every full ref of sessionId in a result; refs of any other session stay whole. */
export function compactRefs(value: unknown, sessionId: string): unknown {
  if (Array.isArray(value)) return value.map(item => compactRefs(item, sessionId));
  if (!isNode(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === FULL_REF_KEYS.size && keys.every(key => FULL_REF_KEYS.has(key)) && value.sessionId === sessionId
      && isText(value.instanceId) && Array.isArray(value.pathSegments)) {
    const segments = value.pathSegments;
    return { instanceId: value.instanceId, root: value.root, ...(joinable(segments) ? { path: segments.join('/') } : { pathSegments: segments }), className: value.className };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactRefs(item, sessionId)]));
}

type ToolCall = { method: string; params?: Node & { arguments?: unknown } };
type ToolResult = Node & { content?: { type: string; text?: string }[]; structuredContent?: unknown };
/** Wrap tools/call for every tool: expand compact refs before validation and compact refs in results. */
export function serveCompactRefs(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
  if (!(handlers instanceof Map)) return;
  const call = handlers.get('tools/call') as ((request: ToolCall, extra: unknown) => Promise<ToolResult>) | undefined;
  if (typeof call !== 'function') return;
  handlers.set('tools/call', async (request: ToolCall, extra: unknown) => {
    const args = request?.params?.arguments;
    const sessionId = isNode(args) && isText(args.sessionId) ? args.sessionId : undefined;
    let expanded: unknown;
    try { expanded = expandRefs(args, sessionId); } catch (error) {
      if (!(error instanceof RefSessionError)) throw error;
      const detail = { code: error.code, message: error.message };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: detail }) }], structuredContent: { error: detail } };
    }
    const result = await call(isNode(args) ? { ...request, params: { ...request.params, arguments: expanded } } : request, extra);
    const data = result?.structuredContent;
    const session = sessionId ?? (isNode(data) && isText(data.sessionId) ? data.sessionId : undefined);
    if (!isNode(data) || session === undefined || !Array.isArray(result.content)) return result;
    const original = JSON.stringify(data), compact = compactRefs(data, session), text = JSON.stringify(compact);
    if (text === original) return result;
    return { ...result, structuredContent: compact, content: result.content.map(item => item.type === 'text' && item.text === original ? { ...item, text } : item) };
  });
}

// ---- Asset history ----
//
// A full job record repeats its output directory, manifest path, every lifecycle event and the
// whole normalized request (defaults included), about 1.4 KB per job. A history poll only needs
// what decides the next step; assets_jobs {detail:true} still returns the full records.

const JOB_MESSAGE_CHARS = 160;
const jobKind = (request: Node): string => {
  const spec = isNode(request.procedural) ? request.procedural : undefined;
  if (request.template !== 'procedural' || !spec) return String(request.template);
  const variant = spec.species ?? spec.style;
  return typeof variant === 'string' ? spec.kind + ':' + variant : String(spec.kind);
};
/** One job as {jobId, name, kind, seed, state, stage (while unfinished), triangleBudget, at, error, archived}. */
export function compactAssetJob(job: unknown): unknown {
  if (!isNode(job) || !isText(job.jobId) || !isText(job.state) || !isNode(job.request)) return job;
  const request = job.request, error = isNode(job.error) ? job.error : undefined;
  const message = error && isText(error.message) ? error.message : undefined;
  const reason = error && isNode(error.diagnostic) && isText(error.diagnostic.reasonCode) ? error.diagnostic.reasonCode : undefined;
  return {
    jobId: job.jobId, name: request.name, kind: jobKind(request), ...(typeof request.seed === 'number' ? { seed: request.seed } : {}), state: job.state,
    ...(job.state !== 'succeeded' && isText(job.stage) ? { stage: job.stage } : {}),
    ...(typeof request.triangleBudget === 'number' ? { triangleBudget: request.triangleBudget } : {}),
    at: job.finishedAt ?? job.updatedAt,
    // A succeeded job has its manifest; say so only when that does not hold.
    ...(job.manifestAvailable !== (job.state === 'succeeded') ? { manifest: job.manifestAvailable } : {}),
    ...(error ? { error: { code: error.code, ...(message !== undefined ? { message: message.length > JOB_MESSAGE_CHARS ? message.slice(0, JOB_MESSAGE_CHARS - 1) + '…' : message } : {}),
      ...(reason ? { reason } : {}) } } : {}),
    ...(isNode(job.retention) ? { archived: true } : {}),
  };
}
/** A history page with compact jobs; the constant schemaVersion and byteLimit are dropped. Cursor, total, scope and unavailable stay. */
export function compactAssetJobPage<T>(page: T): T {
  if (!isNode(page) || !Array.isArray(page.jobs)) return page;
  const { schemaVersion: _schemaVersion, byteLimit: _byteLimit, ...rest } = page;
  return { ...rest, jobs: page.jobs.map(compactAssetJob) } as T;
}
