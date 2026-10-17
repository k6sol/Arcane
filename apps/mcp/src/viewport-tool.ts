import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DaemonClient } from './daemon-client.js';
import { id, timeoutMs } from './schemas.js';
import { viewportCameraSchema, VIEWPORT_LIMITS } from '../../../packages/studio-test-controller/src/viewport.js';

export const STUDIO_VIEWPORT_TOOL = 'studio_viewport_capture';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const viewportCaptureInput = z.strictObject({
  sessionId: id, nativeStudioId: id.optional(),
  maxDimension: z.number().int().min(VIEWPORT_LIMITS.minDimension).max(VIEWPORT_LIMITS.maxDimension).default(VIEWPORT_LIMITS.defaultDimension),
  camera: viewportCameraSchema.optional(),
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

const DESCRIPTION = 'Read: see the exact paired Studio session\'s current Edit-mode 3D viewport as a PNG image (longest side maxDimension 256–1024, default 768; at most 600 KiB, downscaled if needed). ' +
  'Uses the built-in Studio screen capture only; never starts Play, sends input or edits the place. Optional camera {position,lookAt} (studs) frames a specific area; ' +
  'the host restores the previous Edit camera afterwards and reports camera unchanged/restored/restore_failed. Requires a live, unpublished, write-granted pairing in Edit mode; refuses while a playtest runs. ' +
  'Use it after major build steps to check composition, scale, spacing, colour and gaps against the request, then fix what you see. Keep it to 2–3 captures per task; an image is visual context, not gameplay or playtest evidence.';

/** Registers the viewport tool with MCP image content plus a small JSON summary. */
export function registerViewportTool(server: McpServer, client: DaemonClient): void {
  const schema = viewportCaptureInput.extend({ timeoutMs });
  server.registerTool<z.ZodRawShape, typeof schema>(STUDIO_VIEWPORT_TOOL, { description: DESCRIPTION, inputSchema: schema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async (input, extra): Promise<CallToolResult> => {
    try {
      const { timeoutMs: wait, ...request } = input as z.output<typeof schema>;
      const result = await client.viewportCapture(request, { timeoutMs: wait, signal: extra.signal });
      const summary = client.redact({ viewport: result.viewport });
      return { content: [{ type: 'text', text: JSON.stringify(summary) }, { type: 'image', data: result.data, mimeType: 'image/png' }], structuredContent: summary };
    } catch (error) {
      const known = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code);
      const detail = client.redact(known ? { code: (error as Error & { code: string }).code, message: (error as Error).message.slice(0, 2048) }
        : { code: 'LOCAL_ERROR', message: 'The viewport capture failed. Check daemon availability.' });
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: detail }) }], structuredContent: { error: detail } };
    }
  });
}
