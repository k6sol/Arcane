import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, ToolSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { bounded, fail, identifier, parse, systemScheduler, type Scheduler } from './contracts.js';
import { boundViewportPng, VIEWPORT_LIMITS, type ViewportImage } from './viewport-image.js';

export { VIEWPORT_LIMITS } from './viewport-image.js';

const coordinate = z.number().finite().min(-VIEWPORT_LIMITS.coordinate).max(VIEWPORT_LIMITS.coordinate);
const vector = z.tuple([coordinate, coordinate, coordinate]);
/** Optional framing: where the camera sits and what it looks at, in studs. */
export const viewportCameraSchema = z.strictObject({ position: vector, lookAt: vector }).refine(({ position, lookAt }) => {
  const distance = Math.hypot(position[0] - lookAt[0], position[1] - lookAt[1], position[2] - lookAt[2]);
  return distance >= VIEWPORT_LIMITS.minCameraDistance && distance <= VIEWPORT_LIMITS.maxCameraDistance;
}, 'Camera position and lookAt must be 0.5 to 5000 studs apart.');
export type ViewportCamera = z.infer<typeof viewportCameraSchema>;
export const viewportRequestSchema = z.strictObject({
  sessionId: identifier, nativeStudioId: identifier.optional(),
  maxDimension: z.number().int().min(VIEWPORT_LIMITS.minDimension).max(VIEWPORT_LIMITS.maxDimension).default(VIEWPORT_LIMITS.defaultDimension),
  camera: viewportCameraSchema.optional(),
});
export type ViewportRequest = z.infer<typeof viewportRequestSchema>;
export type ViewportCameraOutcome = 'not_requested' | 'unchanged' | 'restored' | 'restore_failed';
export interface ViewportCapture extends ViewportImage { camera: ViewportCameraOutcome }

export interface ViewportCaptureOptions {
  client: Client; nativeStudioId: string; captureId: string; maxDimension: number; camera?: ViewportCamera;
  /** Trusted host check that the exact paired session still maps to this native
   * Studio in Edit mode. Returns a stable evidence digest; throws on any change. */
  verifyBinding(signal: AbortSignal): Promise<string>;
  /** Verified native get_studio_state decoder. */
  decodeMode(result: CallToolResult): { mode: 'Edit' | 'Play' };
  scheduler?: Scheduler; requestTimeoutMs?: number; captureTimeoutMs?: number;
}

type CameraState = { cframe: number[]; focus: number[] };
const components = z.array(z.number().finite()).length(12);
const cameraStateSchema = z.strictObject({ cframe: components, focus: components });
const CAMERA_READ = 'local camera = workspace.CurrentCamera\nassert(camera, "Arcane viewport camera unavailable")\n' +
  'return {cframe = {camera.CFrame:GetComponents()}, focus = {camera.Focus:GetComponents()}}';
function luaNumber(value: number): string {
  if (!Number.isFinite(value)) fail('INVALID_REQUEST');
  return Object.is(value, -0) ? '0' : String(value);
}
/** Fixed restore program: only numbers produced by the host's own camera read are interpolated. */
export function cameraRestoreProgram(state: CameraState): string {
  const parsed = parse(cameraStateSchema, state);
  return 'local camera = workspace.CurrentCamera\nassert(camera, "Arcane viewport camera unavailable")\n' +
    `camera.CFrame = CFrame.new(${parsed.cframe.map(luaNumber).join(', ')})\n` +
    `camera.Focus = CFrame.new(${parsed.focus.map(luaNumber).join(', ')})\nreturn {restored = true}`;
}
export const VIEWPORT_CAMERA_READ_PROGRAM = CAMERA_READ;
const sameCamera = (a: CameraState, b: CameraState) =>
  [...a.cframe, ...a.focus].every((value, index) => Math.abs(value - [...b.cframe, ...b.focus][index]!) <= 1e-3);

function schemaType(tool: Tool, key: string): unknown {
  return (tool.inputSchema.properties?.[key] as { type?: unknown } | undefined)?.type;
}
/** The reviewed native screen_capture shape (recorded inventory): required
 * studio_id/capture_id strings, optional numeric camera_position/look_at_position
 * arrays, advertised read-only. Anything wider is refused. */
export function assertReviewedScreenCapture(tool: Tool | undefined, framing: boolean): void {
  if (!tool || tool.inputSchema.type !== 'object' || tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) fail('UNSUPPORTED_TOOL');
  const required = [...(tool.inputSchema.required ?? [])].sort(), keys = Object.keys(tool.inputSchema.properties ?? {});
  if (required.join(',') !== 'capture_id,studio_id' || keys.some(key => !['studio_id', 'capture_id', 'camera_position', 'look_at_position'].includes(key)) ||
      schemaType(tool, 'studio_id') !== 'string' || schemaType(tool, 'capture_id') !== 'string') fail('UNSUPPORTED_TOOL');
  if (framing && (schemaType(tool, 'camera_position') !== 'array' || schemaType(tool, 'look_at_position') !== 'array')) fail('UNSUPPORTED_TOOL');
}

/** Capture the exact paired Studio's Edit-mode viewport through the built-in
 * Studio MCP screen_capture tool. Never starts Play, sends input, or runs caller
 * Luau. With optional framing, the host reads the Edit camera first and restores
 * it afterwards with a fixed program if the native capture moved it. */
export async function captureEditViewport(options: ViewportCaptureOptions, signal: AbortSignal): Promise<ViewportCapture> {
  parse(identifier, options.nativeStudioId); parse(identifier, options.captureId);
  const camera = options.camera === undefined ? undefined : parse(viewportCameraSchema, options.camera);
  const scheduler = options.scheduler ?? systemScheduler, timeout = options.requestTimeoutMs ?? 5000, captureTimeout = options.captureTimeoutMs ?? 10_000;
  for (const value of [timeout, captureTimeout]) if (!Number.isInteger(value) || value < 1 || value > 30_000) fail('INVALID_REQUEST');
  const studio = options.nativeStudioId, client = options.client;
  const call = async (name: string, args: Record<string, unknown>, local: AbortSignal, limitMs = timeout): Promise<CallToolResult> =>
    parse(CallToolResultSchema, await bounded(scheduler, limitMs, local, inner => client.callTool({ name, arguments: args }, CallToolResultSchema,
      { signal: inner, timeout: limitMs, maxTotalTimeout: limitMs, resetTimeoutOnProgress: false })), 'BAD_NATIVE_RESPONSE');
  const text = (result: CallToolResult): string => {
    const item = result.content[0];
    if (result.isError || result.content.length !== 1 || item?.type !== 'text' || Buffer.byteLength(item.text) > 4096) fail('BAD_NATIVE_RESPONSE');
    return item.text;
  };

  // Reviewed inventory first; nothing is called before every needed tool matches.
  const tools: Tool[] = []; let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 4) fail('UNSUPPORTED_TOOL');
    const listed = await bounded(scheduler, timeout, signal, local => client.listTools(cursor ? { cursor } : {}, { signal: local, timeout, maxTotalTimeout: timeout }));
    for (const raw of listed.tools) { if (tools.length >= 128) fail('UNSUPPORTED_TOOL'); tools.push(parse(ToolSchema, raw, 'UNSUPPORTED_TOOL')); }
    if (!listed.nextCursor) break;
    if (listed.nextCursor === cursor || listed.nextCursor.length > 1024) fail('UNSUPPORTED_TOOL');
    cursor = listed.nextCursor;
  }
  const tool = (name: string) => { const found = tools.filter(item => item.name === name); if (found.length > 1) fail('UNSUPPORTED_TOOL'); return found[0]; };
  assertReviewedScreenCapture(tool('screen_capture'), camera !== undefined);
  const state = tool('get_studio_state');
  if (!state || state.annotations?.readOnlyHint !== true || schemaType(state, 'studio_id') !== 'string') fail('UNSUPPORTED_TOOL');
  if (camera) {
    const execute = tool('execute_luau'), contexts = (execute?.inputSchema.properties?.datamodel_type as { enum?: unknown } | undefined)?.enum;
    if (!execute || !['studio_id', 'datamodel_type', 'code'].every(key => execute.inputSchema.required?.includes(key)) ||
        !Array.isArray(contexts) || !contexts.includes('Edit')) fail('UNSUPPORTED_TOOL');
  }
  const editMode = async (local: AbortSignal) => {
    if (options.decodeMode(await call('get_studio_state', { studio_id: studio }, local)).mode !== 'Edit') fail('MODE_MISMATCH');
  };
  const readCamera = async (local: AbortSignal): Promise<CameraState> => {
    let value: unknown;
    try { value = JSON.parse(text(await call('execute_luau', { studio_id: studio, datamodel_type: 'Edit', code: CAMERA_READ }, local))); }
    catch (error) { if (error instanceof Error && error.name === 'StudioTestError') throw error; fail('BAD_NATIVE_RESPONSE'); }
    return parse(cameraStateSchema, value, 'BAD_NATIVE_RESPONSE');
  };

  const before = await options.verifyBinding(signal);
  await editMode(signal);
  let original: CameraState | null = null, outcome: ViewportCameraOutcome = 'not_requested', bytes: Buffer | null = null, failure: unknown = null;
  try {
    if (camera) original = await readCamera(signal);
    const result = await call('screen_capture', { studio_id: studio, capture_id: options.captureId,
      ...(camera ? { camera_position: [...camera.position], look_at_position: [...camera.lookAt] } : {}) }, signal, captureTimeout);
    const images = result.content.filter(item => item.type === 'image'), others = result.content.filter(item => item.type !== 'image');
    const image = images[0];
    if (result.isError || images.length !== 1 || image?.type !== 'image' || image.mimeType !== 'image/png' || others.length > 2 ||
        others.some(item => item.type !== 'text' || Buffer.byteLength(item.text) > 2048)) fail('BAD_NATIVE_RESPONSE');
    if (image.data.length > Math.ceil(VIEWPORT_LIMITS.inputBytes / 3) * 4) fail('BAD_NATIVE_RESPONSE');
    bytes = Buffer.from(image.data, 'base64');
    if (bytes.toString('base64') !== image.data) fail('BAD_NATIVE_RESPONSE');
  } catch (error) { failure = error; }
  if (original) {
    // Restoration is independent of caller cancellation once the camera may have moved.
    const independent = new AbortController().signal;
    try {
      const now = await readCamera(independent);
      if (sameCamera(now, original)) outcome = 'unchanged';
      else {
        text(await call('execute_luau', { studio_id: studio, datamodel_type: 'Edit', code: cameraRestoreProgram(original) }, independent));
        outcome = sameCamera(await readCamera(independent), original) ? 'restored' : 'restore_failed';
      }
    } catch { outcome = 'restore_failed'; }
  }
  if (failure) { if (outcome === 'restore_failed') fail('EFFECT_UNKNOWN'); throw failure; }
  await editMode(signal);
  if (await options.verifyBinding(signal) !== before) fail('BINDING_CHANGED');
  let image: ViewportImage;
  try { image = boundViewportPng(bytes!, options.maxDimension); } catch { fail('BAD_NATIVE_RESPONSE'); }
  return Object.freeze({ ...image, camera: outcome });
}
