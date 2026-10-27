import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, ToolSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { bounded, fail, identifier, parse, systemScheduler, type Scheduler } from './contracts.js';
import { boundViewportPng, decodeViewportPng, downscaleRgb, encodeRgbPng, VIEWPORT_LIMITS, type ViewportImage } from './viewport-image.js';

export { VIEWPORT_LIMITS } from './viewport-image.js';

const coordinate = z.number().finite().min(-VIEWPORT_LIMITS.coordinate).max(VIEWPORT_LIMITS.coordinate);
const vector = z.tuple([coordinate, coordinate, coordinate]);
/** Optional framing: where the camera sits and what it looks at, in studs. */
export const viewportCameraSchema = z.strictObject({ position: vector, lookAt: vector }).refine(({ position, lookAt }) => {
  const distance = Math.hypot(position[0] - lookAt[0], position[1] - lookAt[1], position[2] - lookAt[2]);
  return distance >= VIEWPORT_LIMITS.minCameraDistance && distance <= VIEWPORT_LIMITS.maxCameraDistance;
}, 'Camera position and lookAt must be 0.5 to 5000 studs apart.');
export type ViewportCamera = z.infer<typeof viewportCameraSchema>;
/** Multi-view contact sheet: 2–4 framed cameras captured in one call, composed into one bounded PNG. */
export const viewportSheetSchema = z.array(viewportCameraSchema).min(2).max(4);
export const viewportRequestSchema = z.strictObject({
  sessionId: identifier, nativeStudioId: identifier.optional(),
  maxDimension: z.number().int().min(VIEWPORT_LIMITS.minDimension).max(VIEWPORT_LIMITS.maxDimension).default(VIEWPORT_LIMITS.defaultDimension),
  camera: viewportCameraSchema.optional(), sheet: viewportSheetSchema.optional(),
}).refine(value => !(value.camera && value.sheet), 'Use camera or sheet, not both.');

/** Named framing views around an instance's world bounding box (Roblox Front is -Z). */
export const VIEWPORT_VIEWS = ['front', 'three_quarter', 'top', 'low_angle'] as const;
export type ViewportView = typeof VIEWPORT_VIEWS[number];
const extent = z.number().finite().min(0).max(2 * VIEWPORT_LIMITS.coordinate);
/** Plugin scene.inspect bounds (world axis-aligned box). */
export const viewportBoundsSchema = z.strictObject({ center: vector, size: z.tuple([extent, extent, extent]), space: z.literal('world-aabb') });
export type ViewportBounds = z.infer<typeof viewportBoundsSchema>;
/** Studio default vertical field of view; the vertical half-angle is the tighter one for landscape viewports. */
export const VIEWPORT_FRAMING = Object.freeze({ fovDegrees: 70, padding: 1.15, minDistance: 2 });
const DIRECTIONS: Record<Exclude<ViewportView, 'low_angle'>, [number, number, number]> = {
  front: [0, 0.18, -1], three_quarter: [0.7, 0.55, -0.7], top: [0, 1, -0.08],
};
/** Pure framing math: a camera whose view cone contains the bounding sphere of bounds, from a named view. */
export function frameCamera(input: ViewportBounds, view: ViewportView, padding: number = VIEWPORT_FRAMING.padding): ViewportCamera {
  const bounds = parse(viewportBoundsSchema, input);
  if (!VIEWPORT_VIEWS.includes(view) || !Number.isFinite(padding) || padding < 1 || padding > 3) fail('INVALID_REQUEST');
  const [cx, cy, cz] = bounds.center, [sx, sy, sz] = bounds.size;
  const radius = Math.max(0.25, Math.hypot(sx, sy, sz) / 2);
  const distance = Math.max(VIEWPORT_FRAMING.minDistance, radius * padding / Math.sin(VIEWPORT_FRAMING.fovDegrees / 2 * Math.PI / 180));
  if (distance > VIEWPORT_LIMITS.maxCameraDistance) fail('INVALID_REQUEST');
  const round = (value: number) => Math.round(value * 1000) / 1000;
  let position: number[], lookAt: number[];
  if (view === 'low_angle') {
    // Eye just above the bottom face, looking slightly up at the upper half.
    position = [cx + 0.34 * distance, cy - sy / 2 + Math.max(0.5, 0.05 * sy), cz - 0.94 * distance];
    lookAt = [cx, cy + 0.15 * sy, cz];
  } else {
    const d = DIRECTIONS[view], length = Math.hypot(...d);
    position = [cx + d[0] / length * distance, cy + d[1] / length * distance, cz + d[2] / length * distance];
    lookAt = [cx, cy, cz];
  }
  return parse(viewportCameraSchema, { position: position.map(round), lookAt: lookAt.map(round) });
}
/** Compose 2–4 captures into one 2-column sheet whose longest side is maxDimension, within the output byte bound. */
export function composeViewportSheet(pngs: Buffer[], maxDimension: number): ViewportImage {
  if (pngs.length < 2 || pngs.length > 4) fail('INVALID_REQUEST');
  const frames = pngs.map(png => decodeViewportPng(png));
  const columns = 2, rows = Math.ceil(frames.length / columns), gap = 2;
  const aspect = frames[0]!.width / frames[0]!.height;
  const tileWidth = Math.max(32, Math.floor((maxDimension - gap) / columns));
  const tileHeight = Math.max(18, Math.min(Math.floor(tileWidth / aspect), Math.floor((maxDimension - gap * (rows - 1)) / rows)));
  const width = tileWidth * columns + gap, height = tileHeight * rows + gap * (rows - 1);
  const sheet = Buffer.alloc(width * height * 3, 24);
  frames.forEach((frame, index) => {
    const tile = downscaleRgb(frame.rgb, frame.width, frame.height, tileWidth, tileHeight);
    const x0 = (index % columns) * (tileWidth + gap), y0 = Math.floor(index / columns) * (tileHeight + gap);
    for (let y = 0; y < tileHeight; y++) tile.copy(sheet, ((y0 + y) * width + x0) * 3, y * tileWidth * 3, (y + 1) * tileWidth * 3);
  });
  return boundViewportPng(encodeRgbPng(sheet, width, height), maxDimension);
}
export type ViewportRequest = z.infer<typeof viewportRequestSchema>;
export type ViewportCameraOutcome = 'not_requested' | 'unchanged' | 'restored' | 'restore_failed';
export interface ViewportCapture extends ViewportImage { camera: ViewportCameraOutcome; views: number }

export interface ViewportCaptureOptions {
  client: Client; nativeStudioId: string; captureId: string; maxDimension: number; camera?: ViewportCamera; sheet?: ViewportCamera[];
  /** Trusted host check that the exact paired session still maps to this native
   * Studio in Edit mode. Returns a stable evidence digest; throws on any change. */
  verifyBinding(signal: AbortSignal): Promise<string>;
  /** Verified native get_studio_state decoder. */
  decodeMode(result: CallToolResult): { mode: 'Edit' | 'Play' };
  /** Host-only effect admission immediately before each native capture. Camera
   * observation/restoration remains available under its original ownership. */
  admissionGuard?: () => void;
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
  const sheet = options.sheet === undefined ? undefined : parse(viewportSheetSchema, options.sheet);
  if (camera && sheet) fail('INVALID_REQUEST');
  const framing = camera !== undefined || sheet !== undefined, shots: (ViewportCamera | undefined)[] = sheet ?? [camera];
  const scheduler = options.scheduler ?? systemScheduler, timeout = options.requestTimeoutMs ?? 5000, captureTimeout = options.captureTimeoutMs ?? 10_000;
  for (const value of [timeout, captureTimeout]) if (!Number.isInteger(value) || value < 1 || value > 30_000) fail('INVALID_REQUEST');
  const studio = options.nativeStudioId, client = options.client;
  const call = async (name: string, args: Record<string, unknown>, local: AbortSignal, limitMs = timeout): Promise<CallToolResult> =>
    parse(CallToolResultSchema, await bounded(scheduler, limitMs, local, inner => {
      if (name === 'screen_capture') options.admissionGuard?.();
      return client.callTool({ name, arguments: args }, CallToolResultSchema,
        { signal: inner, timeout: limitMs, maxTotalTimeout: limitMs, resetTimeoutOnProgress: false });
    }), 'BAD_NATIVE_RESPONSE');
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
  assertReviewedScreenCapture(tool('screen_capture'), framing);
  const state = tool('get_studio_state');
  if (!state || state.annotations?.readOnlyHint !== true || schemaType(state, 'studio_id') !== 'string') fail('UNSUPPORTED_TOOL');
  if (framing) {
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
  let original: CameraState | null = null, outcome: ViewportCameraOutcome = 'not_requested', failure: unknown = null;
  const captured: Buffer[] = [];
  try {
    if (framing) original = await readCamera(signal);
    for (const [index, shot] of shots.entries()) {
    const result = await call('screen_capture', { studio_id: studio, capture_id: sheet ? options.captureId.slice(0, 120) + '_v' + index : options.captureId,
      ...(shot ? { camera_position: [...shot.position], look_at_position: [...shot.lookAt] } : {}) }, signal, captureTimeout);
    const images = result.content.filter(item => item.type === 'image'), others = result.content.filter(item => item.type !== 'image');
    const image = images[0];
    if (result.isError || images.length !== 1 || image?.type !== 'image' || image.mimeType !== 'image/png' || others.length > 2 ||
        others.some(item => item.type !== 'text' || Buffer.byteLength(item.text) > 2048)) fail('BAD_NATIVE_RESPONSE');
    if (image.data.length > Math.ceil(VIEWPORT_LIMITS.inputBytes / 3) * 4) fail('BAD_NATIVE_RESPONSE');
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.toString('base64') !== image.data) fail('BAD_NATIVE_RESPONSE');
    captured.push(bytes);
    }
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
  try { image = sheet ? composeViewportSheet(captured, options.maxDimension) : boundViewportPng(captured[0]!, options.maxDimension); } catch { fail('BAD_NATIVE_RESPONSE'); }
  return Object.freeze({ ...image, camera: outcome, views: captured.length });
}
