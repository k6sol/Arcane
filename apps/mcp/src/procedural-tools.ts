import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Json } from '../../../packages/protocol/src/studio.js';
import { BridgeError, type CommandOutcome, type DaemonClient } from './daemon-client.js';
import { assetSlug, boundedVector } from './assembly-schemas.js';
import { assetJobId, nativeAssetJobId } from './asset-schemas.js';
import { id, ref } from './schemas.js';
import { COLUMN_BASES, COLUMN_CAPITALS, FOLIAGE_STYLES, PROCEDURAL_FINISHES, PROCEDURAL_LIMITS as L, TREE_SPECIES } from '../../../packages/asset-pipeline/src/procedural.js';

/** Procedural Blender meshes: start (assets_procedural), look (assets_preview) and, for native
 * sessions, place the reconstructed meshes as MeshParts (assets_place_studio_import). */
export const PROCEDURAL_TOOLS = ['assets_procedural', 'assets_preview'] as const;
export const NATIVE_PROCEDURAL_TOOLS = ['assets_place_studio_import'] as const;
/** Plugin feature flag advertised by plugins that can turn retained EditableMeshes into MeshParts. */
export const MESH_PARTS_CAPABILITY = 'asset.mesh_parts';

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const n = z.number().finite();
const between = (low: number, high: number) => n.min(low).max(high);
const wait = (fallback: number) => z.number().int().min(1000).max(60_000).default(fallback).describe('Total wait for this tool call (ms).');
const color = boundedVector(0, 1);
const finish = z.enum(PROCEDURAL_FINISHES).default('natural').describe('Original 256px opaque UV/PBR finish; flat uses solid material factors.');

const tree = z.strictObject({ kind: z.literal('tree'), finish, species: z.enum(TREE_SPECIES).default('oak'),
  height: between(...L.treeHeight).default(9).describe('Metres (1 m ≈ 3.57 studs).'),
  trunkTaper: between(0.2, 0.95).optional().describe('Top/base trunk radius ratio (default 0.55).'),
  branchLevels: z.number().int().min(1).max(3).optional().describe('Branch recursion depth (palm ignores).'),
  leafDensity: between(0, 1).optional(), trunkRadius: between(...L.trunkRadius).optional().describe('Metres; default from species and height.'),
  secondaryColor: color.optional().describe('Leaf colour, linear RGB 0..1 (default per species).') });
const rock = z.strictObject({ kind: z.literal('rock'), finish, size: z.tuple([between(...L.rockSize), between(...L.rockSize), between(...L.rockSize)]).default([1.6, 1.2, 0.9]).describe('[x,y,z] metres; z is height.'),
  roughness: between(0, 1).optional().describe('0 smooth boulder .. 1 jagged, faceted crag.') });
const column = z.strictObject({ kind: z.literal('column'), finish, radius: between(...L.columnRadius).default(0.35), height: between(...L.columnHeight).default(4),
  flutes: z.number().int().min(0).max(L.flutes[1]).optional().describe('0 smooth or 8..32 flutes (default 20).'),
  base: z.enum(COLUMN_BASES).optional(), capital: z.enum(COLUMN_CAPITALS).optional() });
const foliage = z.strictObject({ kind: z.literal('foliage'), finish, style: z.enum(FOLIAGE_STYLES).default('bush'),
  radius: between(...L.foliageRadius).default(0.8), height: between(...L.foliageHeight).default(0.9), density: between(0, 1).optional() });

export const proceduralInput = z.strictObject({
  name: assetSlug.describe('Lowercase slug, e.g. "oak-large".'),
  generator: z.discriminatedUnion('kind', [tree, rock, column, foliage]),
  seed: z.number().int().min(0).max(2147483647).optional().describe('Same seed + parameters = identical mesh; vary for variants.'),
  color: color.optional().describe('Primary colour (bark/rock/stone/foliage), linear RGB 0..1.'),
  triangleBudget: z.number().int().min(L.minTriangles).max(L.maxTriangles).optional().describe('Whole asset, 2500..20000 (defaults: tree 16000, rock 6000, column 12000, foliage 8000).'),
  renderResolution: z.number().int().min(128).max(768).optional().describe('Preview PNG size (default 512).'),
  timeoutMs: wait(20_000),
});
export const previewInput = z.strictObject({ jobId: assetJobId, view: z.enum(['hero', 'side', 'both']).default('hero'), timeoutMs: wait(20_000) });

const n3 = z.tuple([n.min(-100000).max(100000), n.min(-100000).max(100000), n.min(-100000).max(100000)]);
export const placeInput = z.strictObject({
  jobId: nativeAssetJobId, sessionId: id.describe('The paired Studio session that ran assets_reconstruct_studio_import.'),
  parent: ref.describe('Container ref: a Workspace Model/Folder, or a hidden Folder for scatter templates.'),
  name: id.max(100), position: n3.describe('Bottom-centre [x,y,z] studs; ground snaps y to the surface below.'),
  yaw: z.number().min(-360).max(360).default(0),
  maxSize: z.tuple([n.min(0.2).max(2048), n.min(0.2).max(2048), n.min(0.2).max(2048)]).optional().describe('Uniformly fit inside this [x,y,z] studs box. Omit for true size (metres × 3.57).'),
  ground: z.boolean().default(true), anchor: z.boolean().default(true), timeoutMs: wait(45_000),
});

const PROCEDURAL = 'Write: generate an original bounded mesh in the local Blender worker from a bundled parameterised generator (no code accepted): ' +
  'tree (species pine/oak/birch/palm, height, trunkTaper, branchLevels 1-3, leafDensity; tapered branching limbs and thin curved closed leaves), rock (size, roughness; noise + chiselled facets, flat base), ' +
  'column (radius, height, 0/8-32 flutes with entasis, base none/plinth/attic, capital none/doric/ionic/corinthian) or foliage clump (bush/grass/fern). ' +
  'Output: one optimised GLB, one mesh per material (≤20,000 triangles total, analytic UV0, original 256px opaque colour/normal/roughness/metalness maps; finish flat selects solid materials), a box/trunk collision proxy, and two preview renders. Deterministic per seed. ' +
  'Use for original hero/organic assets. Toolbox models require an explicit user request; inspect the actual preview before calling any result realistic. Returns a job acknowledgement: poll assets_jobs until succeeded (usually 15-90 s), then assets_preview to look at it. ' +
  'Open the 3D preview for human Approve; agents cannot approve. Studio delivery (native sessions): assets_prepare_studio_import → assets_stage_studio_import → assets_reconstruct_studio_import → assets_place_studio_import. Never auto-retry; on timeout inspect assets_jobs.';
const PREVIEW = 'Read: see the Blender review render(s) of a completed asset job as PNG (hero three-quarter and/or side view, ortho camera, studio lighting). ' +
  'Critique silhouette, proportions, density and colour, then regenerate with adjusted parameters or a new seed if needed. A render is not Studio evidence.';
const PLACE = 'Write: turn the reconstructed meshes of this exact job (after assets_reconstruct_studio_import succeeded in the same Studio session) into MeshParts via AssetService:CreateMeshPartAsync, ' +
  'then adopt them like studio_asset_insert in one undo step: authored UV0 and bounded embedded PNG colour, tangent normal, roughness and metalness through SurfaceAppearance, plus flat material factors when no maps were authored; invisible collision proxy, ' +
  'anchored, fitted (maxSize) or true scale (1 m ≈ 3.57 studs), bottom-centre pivot, grounded, parented; returns a receipt (receipt_restore removes it). ' +
  'For scattering, place ONE copy into a hidden template Folder, then scene_build templates + clone items/scatter. No upload, publication or asset ID: the meshes live in this Studio Edit session ' +
  '(they vanish on reconnect, Play or reopening; to keep them the user clicks Keep this mesh on the asset card, confirms in an Arcane dialog and it uploads geometry to their own Roblox account; PBR maps remain session-only. You can suggest that button but can never upload). Never auto-retry.';

function ok(client: DaemonClient, value: Record<string, unknown>, failed = false): CallToolResult {
  const data = client.redact(value);
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(failed ? { isError: true } : {}) };
}
function failure(client: DaemonClient, error: unknown): CallToolResult {
  const known = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code);
  const detail = client.redact(known ? { code: (error as Error & { code: string }).code, message: (error as Error).message.slice(0, 2048) }
    : { code: 'LOCAL_ERROR', message: 'The procedural asset operation failed locally. Check daemon availability.' });
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: detail }) }], structuredContent: { error: detail } };
}
function receipt(outcome: CommandOutcome): Record<string, unknown> {
  const result = (outcome.command?.result ?? null) as Record<string, Json> | null;
  return { commandId: outcome.commandId, requestId: outcome.requestId, state: outcome.state, terminal: outcome.terminal, ambiguous: outcome.ambiguous,
    ...(result ? { result } : {}), ...(outcome.command?.error ? { error: outcome.command.error } : {}), ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.nextStep ? { nextStep: outcome.nextStep } : {}) };
}

/** Pure mapping, exported for tests: typed tool input -> shared assets_start body. */
export function proceduralStartBody(input: z.output<typeof proceduralInput>): Record<string, unknown> {
  const { timeoutMs: _wait, generator, ...rest } = input;
  const drop = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  return drop({ template: 'procedural', ...rest, procedural: drop(generator as Record<string, unknown>) });
}

export function registerProceduralTools(server: McpServer, client: DaemonClient, scope = ''): void {
  const scopedJob = client.assetAudience === 'native-session' ? nativeAssetJobId : assetJobId;
  const preview = previewInput.extend({ jobId: scopedJob });
  server.registerTool<z.ZodRawShape, typeof proceduralInput>('assets_procedural', { description: PROCEDURAL + scope, inputSchema: proceduralInput, annotations: WRITE }, async (input, extra) => {
    try {
      const a = input as z.output<typeof proceduralInput>;
      const started = await client.assetsStart(proceduralStartBody(a) as never, { timeoutMs: a.timeoutMs, signal: extra.signal });
      return ok(client, { ...(started as Record<string, unknown>), nextStep: 'Poll assets_jobs until this job succeeds, then call assets_preview with its jobId and critique the render.' });
    } catch (error) { return failure(client, error); }
  });

  server.registerTool<z.ZodRawShape, typeof preview>('assets_preview', { description: PREVIEW + scope, inputSchema: preview, annotations: READ }, async (input, extra) => {
    try {
      const a = input as z.output<typeof preview>;
      const paths = a.view === 'both' ? ['preview-hero.png', 'preview-side.png'] as const : [a.view === 'side' ? 'preview-side.png' : 'preview-hero.png'] as const;
      const images: { path: string; bytes: Buffer }[] = [];
      for (const path of paths) images.push({ path, bytes: await client.assetsPreview(a.jobId, path, { timeoutMs: a.timeoutMs, signal: extra.signal }) });
      const total = images.reduce((sum, image) => sum + image.bytes.length, 0);
      if (total > 1_500_000) throw new BridgeError('RESPONSE_LIMIT', 'Previews exceed the image budget; request one view or a lower renderResolution.');
      const summary = { jobId: a.jobId, previews: images.map(image => ({ path: image.path, bytes: image.bytes.length, sha256: createHash('sha256').update(image.bytes).digest('hex') })),
        evidence: 'blender-review-render' };
      return { content: [{ type: 'text', text: JSON.stringify(summary) }, ...images.map(image => ({ type: 'image' as const, data: image.bytes.toString('base64'), mimeType: 'image/png' }))],
        structuredContent: summary };
    } catch (error) { return failure(client, error); }
  });

}

/** Native-only: registered after the native import tools so the catalogue keeps the reviewed order. */
export function registerProceduralPlaceTool(server: McpServer, client: DaemonClient, scope = ''): void {
  if (client.assetAudience !== 'native-session') return;
  server.registerTool<z.ZodRawShape, typeof placeInput>('assets_place_studio_import', { description: PLACE + scope, inputSchema: placeInput, annotations: WRITE }, async (input, extra) => {
    try {
      const a = input as z.output<typeof placeInput>, started = Date.now(), left = () => Math.max(5000, a.timeoutMs - (Date.now() - started));
      const status = await client.assetsStudioReconstructionStatus(a.jobId, { timeoutMs: Math.min(15_000, left()), signal: extra.signal });
      const digest = status.reconstruction?.state === 'succeeded' ? status.reconstruction.receipt?.transferDigest : undefined;
      if (!digest) return ok(client, { jobId: a.jobId, reconstruction: status.reconstruction?.state ?? null,
        nextStep: 'No succeeded reconstruction is recorded for this job. Run assets_prepare_studio_import, assets_stage_studio_import and assets_reconstruct_studio_import first.' }, true);
      const sessions = await client.sessions({ timeoutMs: Math.min(10_000, left()), signal: extra.signal });
      const session = sessions.sessions.find(s => s.id === a.sessionId);
      if (!session) throw new BridgeError('SESSION', 'Unknown Studio session; use sessions to pick the live session that ran the reconstruction.');
      if (!session.capabilities.includes(MESH_PARTS_CAPABILITY)) throw new BridgeError('PLUGIN_UPDATE_REQUIRED', 'The connected Arcane Studio plugin cannot create MeshParts from reconstructed meshes. Update the Studio plugin from Arcane, restart Studio and reconnect (then stage and reconstruct again).');
      const args: Record<string, Json> = { watch: 'editable-' + digest, parent: a.parent as unknown as Json, name: a.name, position: a.position, yaw: a.yaw,
        ground: a.ground, anchor: a.anchor, allowScripts: false, ...(a.maxSize ? { maxSize: a.maxSize } : {}) };
      const outcome = await client.execute(a.sessionId, 'scene.place_asset', args, { timeoutMs: left(), signal: extra.signal });
      const failed = !outcome.terminal || outcome.state !== 'succeeded';
      return ok(client, { jobId: a.jobId, transferDigest: digest, placement: receipt(outcome), uploaded: false,
        persistence: 'studio-session-only',
        nextStep: failed ? 'Placement did not succeed; inspect Workspace (scene_search or studio_viewport_capture) before trying again. Never repeat automatically.'
          : 'Check it with studio_viewport_capture framed on the ref. For many copies use this model as a scene_build template (clone/scatter). Tell the user these MeshParts are session-only; to keep them they can click Keep this mesh on the asset card (uploads to their own Roblox account after they confirm). Never claim it was kept.' }, failed);
    } catch (error) { return failure(client, error); }
  });
}
