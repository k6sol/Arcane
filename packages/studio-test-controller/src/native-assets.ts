import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, ToolSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { bounded, fail, identifier, parse, systemScheduler, StudioTestError, type Scheduler } from './contracts.js';

/** Built-in Studio MCP asset tools, mapped from the recorded inventory
 * (docs/research/native-studio-checks.json): search_asset, insert_asset, generate_mesh,
 * generate_material, generate_texture and wait_job_finished. Only reviewed argument shapes are
 * sent; any advertised required field Arcane does not supply makes the tool unsupported. */
export const NATIVE_ASSET_TOOLS = ['search_asset', 'insert_asset', 'generate_mesh', 'generate_material', 'generate_texture', 'wait_job_finished'] as const;
export type NativeAssetTool = typeof NATIVE_ASSET_TOOLS[number];
export const NATIVE_ASSET_LIMITS = Object.freeze({
  queryChars: 100, pageSize: 10, pages: 3, promptChars: 400, nameChars: 100, creatorChars: 64,
  meshExtent: 256, minTriangles: 500, maxTriangles: 20_000, responseBytes: 64 * 1024, jobWaitSeconds: 15,
});
export const NATIVE_ASSET_CATEGORIES = ['Model', 'MeshPart'] as const;
/** Searchable categories. Audio results are ids for Sound.SoundId only; they are never inserted. */
export const NATIVE_SEARCH_CATEGORIES = [...NATIVE_ASSET_CATEGORIES, 'Audio'] as const;
export type NativeSearchCategory = typeof NATIVE_SEARCH_CATEGORIES[number];
export const GENERATION_KINDS = ['mesh', 'material', 'texture'] as const;
export const GENERATED_BASE_MATERIALS = ['Plastic', 'SmoothPlastic', 'Wood', 'WoodPlanks', 'Marble', 'Basalt', 'Slate', 'CrackedLava', 'Concrete', 'Limestone',
  'Granite', 'Pavement', 'Brick', 'Pebble', 'Cobblestone', 'Rock', 'Sandstone', 'CorrodedMetal', 'DiamondPlate', 'Foil', 'Metal', 'Grass', 'LeafyGrass', 'Sand',
  'Fabric', 'Snow', 'Mud', 'Ground', 'Asphalt', 'Salt', 'Ice', 'Glacier', 'Cardboard', 'Carpet', 'CeramicTiles', 'ClayRoofTiles', 'RoofShingles', 'Leather',
  'Plaster', 'Rubber'] as const;
const ROOTS = ['Workspace', 'ReplicatedStorage', 'ServerStorage'] as const;

const line = (max: number, min = 1) => z.string().min(min).max(max).refine(value => !/[\x00-\x1f\x7f]/.test(value) && value.trim().length >= min, 'Use one printable line.');
const extent = z.number().finite().min(0.5).max(NATIVE_ASSET_LIMITS.meshExtent);
const segment = z.string().regex(/^[A-Za-z0-9_]{1,100}$/);
export const nativeAssetSearchSchema = z.strictObject({
  sessionId: identifier, nativeStudioId: identifier.optional(), query: line(NATIVE_ASSET_LIMITS.queryChars),
  category: z.enum(NATIVE_SEARCH_CATEGORIES).default('Model'), page: z.number().int().min(1).max(NATIVE_ASSET_LIMITS.pages).default(1),
  pageSize: z.number().int().min(1).max(NATIVE_ASSET_LIMITS.pageSize).default(8), verifiedOnly: z.boolean().default(false),
});
export const nativeAssetInsertSchema = z.strictObject({
  sessionId: identifier, nativeStudioId: identifier.optional(), assetId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  category: z.enum(NATIVE_ASSET_CATEGORIES).default('Model'), watch: identifier,
});
export const nativeAssetGenerateSchema = z.strictObject({
  sessionId: identifier, nativeStudioId: identifier.optional(), kind: z.enum(GENERATION_KINDS), prompt: line(NATIVE_ASSET_LIMITS.promptChars, 3),
  size: z.tuple([extent, extent, extent]).optional(), maxTriangles: z.number().int().min(NATIVE_ASSET_LIMITS.minTriangles).max(NATIVE_ASSET_LIMITS.maxTriangles).optional(),
  baseMaterial: z.enum(GENERATED_BASE_MATERIALS).optional(), pattern: z.enum(['Regular', 'Organic']).optional(),
  target: z.strictObject({ root: z.enum(ROOTS), path: z.array(segment).min(1).max(32) }).optional(), watch: identifier.optional(),
}).superRefine((value, context) => {
  const missing = (field: string) => context.addIssue({ code: z.ZodIssueCode.custom, message: `${value.kind} generation needs ${field}.` });
  const extra = (field: string) => context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} does not apply to ${value.kind} generation.` });
  if (value.kind === 'mesh') { if (!value.watch) missing('watch'); if (value.baseMaterial || value.pattern) extra('baseMaterial/pattern'); if (value.target) extra('target'); }
  if (value.kind === 'material') { if (!value.baseMaterial) missing('baseMaterial'); if (value.size || value.maxTriangles) extra('size/maxTriangles'); if (value.target || value.watch) extra('target/watch'); }
  if (value.kind === 'texture') { if (!value.target) missing('target'); if (value.size || value.maxTriangles || value.baseMaterial || value.pattern || value.watch) extra('mesh/material fields'); }
});
export type NativeAssetSearchRequest = z.output<typeof nativeAssetSearchSchema>;
export type NativeAssetInsertRequest = z.output<typeof nativeAssetInsertSchema>;
export type NativeAssetGenerateRequest = z.output<typeof nativeAssetGenerateSchema>;

export interface NativeAssetResult { id: string; name: string; creator: string | null; type: string | null; verifiedCreator: boolean | null;
  price: 'free' | 'unknown'; thumbnailId: string | null; thumbnailUrl: string | null; source: string | null;
  /** Audio only, when the native result carries it: length in seconds. */
  durationSeconds?: number }
export type JobState = 'running' | 'completed' | 'failed';
/** Fixed, actionable refusal reasons. Native text is classified, never relayed. */
export type NativeRefusal = 'sign_in' | 'quota' | 'unavailable' | 'rejected';
export const NATIVE_REFUSAL_CODES = Object.freeze({ sign_in: 'NATIVE_SIGN_IN', quota: 'NATIVE_QUOTA', unavailable: 'NATIVE_UNAVAILABLE', rejected: 'NATIVE_REJECTED' } as const);
/** A definite native refusal. Its code maps to a fixed host message; native text is never carried. */
export class NativeAssetRefusal extends Error {
  readonly code: typeof NATIVE_REFUSAL_CODES[NativeRefusal] | 'ASSET_INSERT_REFUSED';
  constructor(code: NativeAssetRefusal['code']) { super(code); this.name = 'NativeAssetRefusal'; this.code = code; }
}

// ---- Reviewed schema checks (recorded inventory; descriptions are not trusted). ----
type Field = 'string' | 'number' | 'boolean' | 'object' | 'array';
const SPECS: Readonly<Record<NativeAssetTool, { required: string[]; send: Record<string, Field>; enums?: Record<string, readonly string[]>; readOnly?: boolean }>> = Object.freeze({
  search_asset: { required: ['studio_id'], send: { studio_id: 'string', query: 'string', assetType: 'string', priceFilter: 'string', maxResults: 'number', verifiedCreatorsOnly: 'boolean' },
    enums: { assetType: NATIVE_SEARCH_CATEGORIES, priceFilter: ['free'] }, readOnly: true },
  insert_asset: { required: ['assetId', 'studio_id'], send: { studio_id: 'string', assetId: 'string', assetName: 'string', assetType: 'string' }, enums: { assetType: NATIVE_ASSET_CATEGORIES } },
  generate_mesh: { required: ['textPrompt', 'studio_id'], send: { studio_id: 'string', textPrompt: 'string', size: 'object', maxTriangles: 'number', async: 'boolean' } },
  generate_material: { required: ['materialPattern', 'materialId', 'baseMaterial', 'materialDescription', 'studio_id'],
    send: { studio_id: 'string', materialId: 'string', baseMaterial: 'string', materialPattern: 'string', materialDescription: 'string', async: 'boolean' },
    enums: { baseMaterial: GENERATED_BASE_MATERIALS, materialPattern: ['Regular', 'Organic'] } },
  generate_texture: { required: ['textPrompt', 'studio_id'], send: { studio_id: 'string', textPrompt: 'string', instance_path: 'string' } },
  wait_job_finished: { required: ['jobId', 'studio_id'], send: { studio_id: 'string', jobId: 'string', timeout: 'number' } },
});
export function assertReviewedAssetTool(tool: Tool | undefined, name: NativeAssetTool): void {
  const spec = SPECS[name], schema = tool?.inputSchema;
  if (!tool || !schema || schema.type !== 'object' || tool.annotations?.destructiveHint === true) fail('UNSUPPORTED_TOOL');
  if (spec.readOnly && tool.annotations?.readOnlyHint !== true) fail('UNSUPPORTED_TOOL');
  const required = schema.required ?? [], properties = (schema.properties ?? {}) as Record<string, { type?: unknown; enum?: unknown }>;
  // Every advertised required field must be one Arcane supplies, and Arcane's own required fields must be advertised.
  if (required.some(key => !Object.hasOwn(spec.send, key)) || spec.required.some(key => !Object.hasOwn(properties, key))) fail('UNSUPPORTED_TOOL');
  for (const [key, type] of Object.entries(spec.send)) {
    const property = properties[key];
    if (!property || property.type !== type) fail('UNSUPPORTED_TOOL');
    const wanted = spec.enums?.[key];
    if (wanted && (!Array.isArray(property.enum) || wanted.some(value => !(property.enum as unknown[]).includes(value)))) fail('UNSUPPORTED_TOOL');
  }
}

// ---- Native response decoding: bounded, defensive and never relayed verbatim. ----
export function resultText(result: CallToolResult): string {
  if (result.content.length > 8) fail('BAD_NATIVE_RESPONSE');
  const text = result.content.filter(item => item.type === 'text').map(item => (item as { text: string }).text).join('\n');
  if (Buffer.byteLength(text) > NATIVE_ASSET_LIMITS.responseBytes) fail('BAD_NATIVE_RESPONSE');
  return text;
}
function parseLoose(text: string): unknown {
  try { return JSON.parse(text); } catch { /* look for an embedded JSON value */ }
  // Try the outermost container first: whichever of '{' or '[' opens earlier.
  const pairs = ([['{', '}'], ['[', ']']] as const).map(([open, close]) => ({ open, close, at: text.indexOf(open) })).filter(item => item.at >= 0).sort((a, b) => a.at - b.at);
  for (const { open, close } of pairs) {
    const start = text.indexOf(open), end = text.lastIndexOf(close);
    if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch { /* next */ } }
  }
  return undefined;
}
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // \s also matches the U+2028/U+2029 line separators.
  const text = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return text.length ? text : null;
}
function digits(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' ? value.trim() : '';
  const match = /^(?:rbxassetid:\/\/)?([1-9][0-9]{0,18})$/.exec(text);
  return match ? match[1]! : null;
}
function firstArray(value: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(value)) return value;
  const object = record(value);
  if (!object || depth > 2) return null;
  for (const key of ['results', 'assets', 'items', 'data', 'Results', 'Assets', 'result']) {
    const found = firstArray(object[key], depth + 1);
    if (found) return found;
  }
  return null;
}
const ASSET_TYPE_IDS: Record<string, string> = { 3: 'Audio', 4: 'Mesh', 10: 'Model', 40: 'MeshPart' };
function seconds(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim().length > 0 && value.length <= 12 ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 && number <= 86_400 ? Math.round(number * 100) / 100 : undefined;
}
/** Decode free search results. Paid results (price above zero or isFree false) are dropped; with audio, results
 * explicitly marked unlicensed or not public are dropped too, and a duration is kept when provided. */
export function decodeAssetSearch(text: string, limit: number, audio = false): { results: NativeAssetResult[]; returned: number } {
  const items = firstArray(parseLoose(text));
  if (!items) fail('BAD_NATIVE_RESPONSE');
  const results: NativeAssetResult[] = [], seen = new Set<string>();
  for (const raw of items.slice(0, 200)) {
    const item = record(raw); if (!item) continue;
    const asset = record(item.asset), creatorRecord = record(item.creator) ?? record(item.Creator);
    const id = digits(item.assetId ?? item.id ?? item.AssetId ?? asset?.id);
    if (!id || seen.has(id)) continue;
    const price = [item.price, item.priceInRobux, item.priceCents, record(item.product)?.price].find(value => typeof value === 'number');
    const isFree = typeof item.isFree === 'boolean' ? item.isFree : typeof item.free === 'boolean' ? item.free : undefined;
    if ((typeof price === 'number' && price > 0) || isFree === false) continue;
    if (audio && [item.isLicensed, item.licensed, item.isPublic, item.public, item.isPublicDomain, record(item.audio)?.isPublic].some(value => value === false)) continue;
    const durationSeconds = audio ? seconds(item.duration ?? item.audioDuration ?? item.durationSeconds ?? item.length ?? record(item.audio)?.duration ?? asset?.duration) : undefined;
    const rawType = item.assetType ?? item.type ?? item.AssetType ?? asset?.assetTypeId;
    const type = typeof rawType === 'number' ? ASSET_TYPE_IDS[rawType] ?? null : clean(rawType, 32);
    const thumbnail = item.thumbnailUrl ?? item.thumbnailURL ?? item.thumbnail;
    const url = typeof thumbnail === 'string' && /^https:\/\/[a-z0-9.-]+\.(?:rbxcdn\.com|roblox\.com)\/[^\s"'<>]{1,400}$/i.test(thumbnail) ? thumbnail : null;
    const verified = [item.creatorVerified, item.hasVerifiedBadge, item.verified, creatorRecord?.hasVerifiedBadge].find(value => typeof value === 'boolean') as boolean | undefined;
    const source = clean(item.source, 20);
    seen.add(id);
    results.push({ id, name: clean(item.name ?? item.assetName ?? item.title ?? asset?.name, NATIVE_ASSET_LIMITS.nameChars) ?? 'Untitled asset',
      creator: clean(item.creatorName ?? creatorRecord?.name ?? creatorRecord?.Name ?? (typeof item.creator === 'string' ? item.creator : undefined), NATIVE_ASSET_LIMITS.creatorChars),
      type, verifiedCreator: verified ?? null, price: price === 0 || isFree === true ? 'free' : 'unknown',
      thumbnailId: digits(item.thumbnailAssetId ?? item.thumbnailId ?? (url ? undefined : thumbnail)), thumbnailUrl: url,
      source: source && ['user', 'group', 'universe', 'creator_store'].includes(source) ? source : null, ...(durationSeconds !== undefined ? { durationSeconds } : {}) });
    if (results.length >= limit) break;
  }
  return { results, returned: items.length };
}
export function decodeJobId(text: string): string | null {
  const value = record(parseLoose(text));
  const direct = value ? value.jobId ?? value.job_id ?? record(value.job)?.id ?? value.id : undefined;
  const candidate = typeof direct === 'string' || typeof direct === 'number' ? String(direct) : /\bjob[ _-]?id\b["'\s:=]+["']?([A-Za-z0-9_-]{1,128})/i.exec(text)?.[1];
  return candidate && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : null;
}
export function classifyJobState(text: string, isError: boolean): JobState {
  const value = record(parseLoose(text));
  const status = String(value?.status ?? value?.state ?? record(value?.job)?.status ?? '').toLowerCase();
  const subject = status || text.toLowerCase();
  if (/timed? ?out|timeout|still (?:running|pending|in progress)|not (?:yet )?(?:finished|complete)/.test(subject)) return 'running';
  if (isError || /fail|error|cancel|reject|denied|unable/.test(subject)) return 'failed';
  if (/complet|succe|finished|done|ready/.test(subject)) return 'completed';
  return 'running';
}
export function classifyRefusal(text: string): NativeRefusal {
  const subject = text.toLowerCase();
  if (/sign(?:ed)? ?in|log(?:ged)? ?in|authenticat|unauthori[sz]ed|401/.test(subject)) return 'sign_in';
  if (/quota|rate ?limit|too many|limit (?:reached|exceeded)|429/.test(subject)) return 'quota';
  if (/not (?:enabled|available|eligible|supported)|unavailable|terms|consent|beta|permission|forbidden|403/.test(subject)) return 'unavailable';
  return 'rejected';
}
/** An insert acknowledgement that lapsed or says to verify is unconfirmed, not refused. */
export function insertOutcome(text: string, isError: boolean): 'acknowledged' | 'unconfirmed' | 'refused' {
  const subject = text.toLowerCase();
  if (/timed? ?out|timeout|probably|may have|verify|check (?:whether|if)/.test(subject)) return 'unconfirmed';
  return isError ? 'refused' : 'acknowledged';
}

// ---- Exact-session native calls. ----
export interface NativeAssetContext {
  client: Client; nativeStudioId: string;
  /** Trusted host check that the exact paired session still maps to this native Studio in Edit mode. */
  verifyBinding(signal: AbortSignal): Promise<string>;
  decodeMode(result: CallToolResult): { mode: 'Edit' | 'Play' };
  /** Host-owned model-source choice, checked immediately before dispatch and after the call. */
  authorize?:()=>void;
  /** Internal effect-boundary observation only; never supplied by model JSON. */
  dispatched?:()=>void;
  scheduler?: Scheduler; requestTimeoutMs?: number;
}
export interface NativeAssetCall { result: CallToolResult | null; text: string; outcome: 'ok' | 'error' | 'timeout' }

async function listTools(context: NativeAssetContext, signal: AbortSignal): Promise<Tool[]> {
  const scheduler = context.scheduler ?? systemScheduler, timeout = context.requestTimeoutMs ?? 5000, tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 4) fail('UNSUPPORTED_TOOL');
    const listed = await bounded(scheduler, timeout, signal, local => context.client.listTools(cursor ? { cursor } : {}, { signal: local, timeout, maxTotalTimeout: timeout }));
    for (const raw of listed.tools) { if (tools.length >= 128) fail('UNSUPPORTED_TOOL'); tools.push(parse(ToolSchema, raw, 'UNSUPPORTED_TOOL')); }
    if (!listed.nextCursor) return tools;
    if (listed.nextCursor === cursor || listed.nextCursor.length > 1024) fail('UNSUPPORTED_TOOL');
    cursor = listed.nextCursor;
  }
}
/** One reviewed native call inside an exact-binding, Edit-mode bracket. A mutation that
 * times out is reported as 'timeout' (effect unknown) instead of being retried. */
export async function callNativeAssetTool(context: NativeAssetContext, name: NativeAssetTool, args: Record<string, unknown>,
  signal: AbortSignal, options: { mutation: boolean; timeoutMs: number }): Promise<NativeAssetCall> {
  parse(identifier, context.nativeStudioId);
  const scheduler = context.scheduler ?? systemScheduler, timeout = context.requestTimeoutMs ?? 5000;
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000) fail('INVALID_REQUEST');
  const tools = await listTools(context, signal), found = tools.filter(tool => tool.name === name);
  if (found.length !== 1) fail('UNSUPPORTED_TOOL');
  assertReviewedAssetTool(found[0], name);
  const state = tools.find(tool => tool.name === 'get_studio_state');
  if (!state || state.annotations?.readOnlyHint !== true) fail('UNSUPPORTED_TOOL');
  const editMode = async (local: AbortSignal) => {
    const result = parse(CallToolResultSchema, await bounded(scheduler, timeout, local, inner => context.client.callTool({ name: 'get_studio_state', arguments: { studio_id: context.nativeStudioId } },
      CallToolResultSchema, { signal: inner, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false })), 'BAD_NATIVE_RESPONSE');
    if (context.decodeMode(result).mode !== 'Edit') fail('MODE_MISMATCH');
  };
  const before = await context.verifyBinding(signal);
  await editMode(signal);
  let call: NativeAssetCall;
  try {
    const raw = await bounded(scheduler, options.timeoutMs, signal, inner => {
      // bounded schedules its action in a microtask: retain fresh authority
      // here, at the actual call boundary rather than before scheduling it.
      context.authorize?.();
      if(options.mutation)context.dispatched?.();
      return context.client.callTool({ name, arguments: { ...args, studio_id: context.nativeStudioId } },
        CallToolResultSchema, { signal: inner, timeout: options.timeoutMs, maxTotalTimeout: options.timeoutMs, resetTimeoutOnProgress: false });
    });
    const result = parse(CallToolResultSchema, raw, 'BAD_NATIVE_RESPONSE');
    call = { result, text: resultText(result), outcome: result.isError ? 'error' : 'ok' };
  } catch (error) {
    if (!options.mutation || !(error instanceof StudioTestError) || !['TIMEOUT', 'CANCELLED'].includes(error.code)) throw error;
    call = { result: null, text: '', outcome: 'timeout' };
  }
  // The bracket closes even after an uncertain mutation; caller cancellation no longer applies.
  const independent = options.mutation ? new AbortController().signal : signal;
  try {
    await editMode(independent);
    if (await context.verifyBinding(independent) !== before) fail('BINDING_CHANGED');
    context.authorize?.();
  } catch(error) { if(options.mutation)fail('EFFECT_UNKNOWN');throw error; }
  return call;
}

export async function searchNativeAssets(context: NativeAssetContext, request: NativeAssetSearchRequest, signal: AbortSignal) {
  const wanted = request.page * request.pageSize;
  const call = await callNativeAssetTool(context, 'search_asset', { query: request.query, assetType: request.category, priceFilter: 'free', maxResults: wanted,
    ...(request.verifiedOnly ? { verifiedCreatorsOnly: true } : {}) }, signal, { mutation: false, timeoutMs: 15_000 });
  if (call.outcome !== 'ok') throw new NativeAssetRefusal(NATIVE_REFUSAL_CODES[classifyRefusal(call.text)]);
  const decoded = decodeAssetSearch(call.text, wanted, request.category === 'Audio');
  return { results: decoded.results.slice((request.page - 1) * request.pageSize, wanted), hasMore: decoded.returned >= wanted && request.page < NATIVE_ASSET_LIMITS.pages };
}

/** The adoption name lets the paired plugin pick the inserted instance even beside other edits. */
export const insertedAssetName = (watch: string) => 'ArcaneAsset_' + watch.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64);
export async function insertNativeAsset(context: NativeAssetContext, request: NativeAssetInsertRequest, signal: AbortSignal) {
  const assetName = insertedAssetName(request.watch);
  const call = await callNativeAssetTool(context, 'insert_asset', { assetId: request.assetId, assetName, assetType: request.category }, signal, { mutation: true, timeoutMs: 12_000 });
  const outcome = call.outcome === 'timeout' ? 'unconfirmed' : insertOutcome(call.text, call.outcome === 'error');
  if (outcome === 'refused') throw new NativeAssetRefusal('ASSET_INSERT_REFUSED');
  return { assetName, outcome };
}

export const generatedMaterialName = (prompt: string, nonce: string) =>
  'Arcane_' + (prompt.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').slice(0, 3).map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('') || 'Material').slice(0, 40) + '_' + nonce.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
export function nativeInstancePath(target: { root: string; path: string[] }): string {
  return ['game', target.root, ...target.path].join('.');
}
export interface GenerationStart { state: JobState; nativeJobId: string | null; refusal: NativeRefusal | null; materialVariant: string | null }
export async function startNativeGeneration(context: NativeAssetContext, request: NativeAssetGenerateRequest, nonce: string, signal: AbortSignal): Promise<GenerationStart> {
  const materialVariant = request.kind === 'material' ? generatedMaterialName(request.prompt, nonce) : null;
  const [tool, args]: [NativeAssetTool, Record<string, unknown>] = request.kind === 'mesh'
    ? ['generate_mesh', { textPrompt: request.prompt, async: true, ...(request.size ? { size: { x: request.size[0], y: request.size[1], z: request.size[2] } } : {}),
      ...(request.maxTriangles ? { maxTriangles: request.maxTriangles } : {}) }]
    : request.kind === 'material'
      ? ['generate_material', { materialId: materialVariant, baseMaterial: request.baseMaterial, materialPattern: request.pattern ?? 'Regular', materialDescription: request.prompt, async: true }]
      : ['generate_texture', { textPrompt: request.prompt, instance_path: nativeInstancePath(request.target!) }];
  const call = await callNativeAssetTool(context, tool, args, signal, { mutation: true, timeoutMs: 20_000 });
  if (call.outcome === 'timeout') fail('EFFECT_UNKNOWN');
  if (call.outcome === 'error') return { state: 'failed', nativeJobId: null, refusal: classifyRefusal(call.text), materialVariant };
  const nativeJobId = decodeJobId(call.text);
  const state = nativeJobId ? classifyJobState(call.text, false) === 'failed' ? 'failed' : 'running' : classifyJobState(call.text, false);
  return { state: state === 'running' && !nativeJobId ? 'completed' : state, nativeJobId, refusal: state === 'failed' ? classifyRefusal(call.text) : null, materialVariant };
}
/** One bounded wait. wait_job_finished's timeout is sent in seconds; a shorter native return is polled again. */
export async function waitNativeJob(context: NativeAssetContext, nativeJobId: string, budgetMs: number, signal: AbortSignal): Promise<{ state: JobState; refusal: NativeRefusal | null }> {
  const scheduler = context.scheduler ?? systemScheduler, deadline = scheduler.now() + budgetMs;
  for (let attempt = 0; attempt < 8; attempt++) {
    const remaining = deadline - scheduler.now();
    if (remaining < 1000) break;
    const seconds = Math.max(1, Math.min(NATIVE_ASSET_LIMITS.jobWaitSeconds, Math.floor(remaining / 1000) - 1));
    const call = await callNativeAssetTool(context, 'wait_job_finished', { jobId: nativeJobId, timeout: seconds }, signal, { mutation: false, timeoutMs: Math.min(30_000, seconds * 1000 + 5000) });
    const state = classifyJobState(call.text, call.outcome === 'error');
    if (state !== 'running') return { state, refusal: state === 'failed' ? classifyRefusal(call.text) : null };
    if (deadline - scheduler.now() > 2500) await new Promise<void>(resolve => scheduler.schedule(2000, resolve));
  }
  return { state: 'running', refusal: null };
}
