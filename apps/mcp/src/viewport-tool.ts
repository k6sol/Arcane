import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BridgeError, type DaemonClient } from './daemon-client.js';
import { id, ref, timeoutMs } from './schemas.js';
import { round3 } from './token-lean.js';
import { frameCamera, viewportBoundsSchema, viewportCameraSchema, viewportSheetSchema, VIEWPORT_LIMITS, VIEWPORT_VIEWS } from '../../../packages/studio-test-controller/src/viewport.js';

export const STUDIO_VIEWPORT_TOOL = 'studio_viewport_capture';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const viewportCaptureInput = z.strictObject({
  sessionId: id, nativeStudioId: id.optional(),
  maxDimension: z.number().int().min(VIEWPORT_LIMITS.minDimension).max(VIEWPORT_LIMITS.maxDimension).default(VIEWPORT_LIMITS.defaultDimension),
  camera: viewportCameraSchema.optional(), sheet: viewportSheetSchema.optional(),
});
/** Model-facing framing: an opaque ref plus one named view, or 2–4 views composed into one sheet image. */
export const viewportFrameInput = z.strictObject({
  ref, view: z.enum(VIEWPORT_VIEWS).default('three_quarter'),
  views: z.array(z.enum(VIEWPORT_VIEWS)).min(2).max(4).optional().describe('2–4 views in one small-tile sheet image (one capture call).'),
  padding: z.number().min(1).max(3).optional(),
});
export type ViewportCaptureInput = z.input<typeof viewportCaptureInput>;
const base64Limit = Math.ceil(VIEWPORT_LIMITS.outputBytes / 3) * 4;
export const viewportCaptureResponse = (sessionId: string) => z.strictObject({
  viewport: z.strictObject({
    sessionId: z.literal(sessionId), nativeStudioId: id, mode: z.literal('Edit'), mimeType: z.literal('image/png'),
    width: z.number().int().min(1).max(VIEWPORT_LIMITS.maxDimension), height: z.number().int().min(1).max(VIEWPORT_LIMITS.maxDimension),
    originalWidth: z.number().int().min(1).max(VIEWPORT_LIMITS.inputDimension), originalHeight: z.number().int().min(1).max(VIEWPORT_LIMITS.inputDimension),
    downscaled: z.boolean(), bytes: z.number().int().min(1).max(VIEWPORT_LIMITS.outputBytes), sha256: hash,
    camera: z.enum(['not_requested', 'unchanged', 'restored', 'restore_failed']), evidence: z.enum(['native', 'fixture']),
  }),
  data: z.string().min(1).max(base64Limit).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).refine(value => Buffer.from(value.data, 'base64').length === value.viewport.bytes, 'Viewport bytes mismatch.');

const DESCRIPTION = 'Read: capture the exact paired session’s Edit-mode 3D viewport as a PNG (longest side maxDimension 256–1024, default 768; ≤600 KiB). Built-in screen capture only: never starts Play, sends input or edits. Aim with camera {position,lookAt} (studs) or frame {ref, view front/three_quarter/top/low_angle, or views:[2–4] for one sheet}, which fits the camera to the ref’s world bounds; the previous camera is then restored (camera unchanged/restored/restore_failed). Needs a live, unpublished, write-granted pairing in Edit mode; refused during a playtest. ' +
  'Use it after major build steps to check composition, scale, spacing, colour and gaps against the request, then fix what you see. Keep it to 2–3 captures per task; an image is visual context, not gameplay or playtest evidence.';

/** Registers the viewport tool with MCP image content plus a small JSON summary. */
export function registerViewportTool(server: McpServer, client: DaemonClient): void {
  const schema = viewportCaptureInput.extend({ timeoutMs, frame: viewportFrameInput.optional() });
  server.registerTool<z.ZodRawShape, typeof schema>(STUDIO_VIEWPORT_TOOL, { description: DESCRIPTION, inputSchema: schema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async (input, extra): Promise<CallToolResult> => {
    try {
      const { timeoutMs: wait, frame, ...request } = input as z.output<typeof schema>;
      let framing: Record<string, unknown> | undefined;
      if (frame) {
        if (request.camera || request.sheet) throw new BridgeError('INPUT', 'Use frame, camera or sheet, not several.');
        const outcome = await client.execute(request.sessionId, 'scene.inspect', { ref: frame.ref, bounds: true }, { timeoutMs: wait, signal: extra.signal });
        const result = outcome.command?.result as { bounds?: unknown } | null | undefined;
        if (outcome.state !== 'succeeded' || !result || typeof result !== 'object') throw new BridgeError(outcome.state === 'failed' ? 'BOUNDS' : 'BOUNDS_UNKNOWN', outcome.command?.error ?? 'The plugin did not report bounds for this ref.');
        const parsed = viewportBoundsSchema.safeParse(result.bounds);
        if (!parsed.success) throw new BridgeError('PLUGIN_UPDATE_REQUIRED', 'The connected Studio plugin did not report bounds. Update the Studio plugin from Arcane, or pass camera {position,lookAt}.');
        const views = frame.views ?? [frame.view];
        const cameras = views.map(view => frameCamera(parsed.data, view, frame.padding));
        if (cameras.length > 1) request.sheet = cameras; else request.camera = cameras[0];
        framing = { views, bounds: { center: parsed.data.center.map(round3), size: parsed.data.size.map(round3) } };
      }
      const result = await client.viewportCapture(request, { timeoutMs: wait, signal: extra.signal });
      // The model already knows its session, and the image block carries the PNG type; Edit is the only mode.
      const { sessionId: _session, mimeType: _mime, mode: _mode, ...viewport } = result.viewport;
      const summary = client.redact({ viewport, ...(framing ? { framing } : {}) });
      return { content: [{ type: 'text', text: JSON.stringify(summary) }, { type: 'image', data: result.data, mimeType: 'image/png' }], structuredContent: summary };
    } catch (error) {
      const known = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code);
      const detail = client.redact(known ? { code: (error as Error & { code: string }).code, message: (error as Error).message.slice(0, 2048) }
        : { code: 'LOCAL_ERROR', message: 'The viewport capture failed. Check daemon availability.' });
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: detail }) }], structuredContent: { error: detail } };
    }
  });
}
