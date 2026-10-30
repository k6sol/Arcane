import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Json } from '../../../packages/protocol/src/studio.js';
import { BridgeError, type CommandOutcome, type DaemonClient } from './daemon-client.js';
import { assetSlug, boundedVector } from './assembly-schemas.js';
import { assetJobId, nativeAssetJobId } from './asset-schemas.js';
import { id, ref } from './schemas.js';
import { COLUMN_BASES, COLUMN_CAPITALS, DEADWOOD_SPECIES, FOLIAGE_STYLES, LOG_ENDS, PROCEDURAL_FINISHES, PROCEDURAL_LIMITS as L, PROCEDURAL_VARIANTS, ROCK_FORMS, STUMP_TOPS, TREE_SPECIES } from '../../../packages/asset-pipeline/src/procedural.js';
import { MODEL_FINISHES, MODEL_LIMITS } from '../../../packages/asset-pipeline/src/model-spec.js';
import type { LearnedDefaults } from './learned-defaults.js';

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
  roughness: between(0, 1).optional().describe('0 smooth boulder .. 1 jagged, faceted crag.'),
  form: z.enum(ROCK_FORMS).default('boulder').describe('boulder; outcrop: steep stratified cliff face (front -Y); cave: outcrop with a recessed cave mouth.'),
  moss: z.boolean().optional().describe('Moss cap on the upper sky-facing rock (default false).') });
const column = z.strictObject({ kind: z.literal('column'), finish, radius: between(...L.columnRadius).default(0.35), height: between(...L.columnHeight).default(4),
  flutes: z.number().int().min(0).max(L.flutes[1]).optional().describe('0 smooth or 8..32 flutes (default 20).'),
  base: z.enum(COLUMN_BASES).optional(), capital: z.enum(COLUMN_CAPITALS).optional() });
const foliage = z.strictObject({ kind: z.literal('foliage'), finish, style: z.enum(FOLIAGE_STYLES).default('bush'),
  radius: between(...L.foliageRadius).default(0.8), height: between(...L.foliageHeight).default(0.9), density: between(0, 1).optional() });
const moss = z.boolean().optional().describe('Moss band along the top (default false).');
const log = z.strictObject({ kind: z.literal('log'), finish, species: z.enum(DEADWOOD_SPECIES).default('oak'), length: between(...L.logLength).default(3),
  radius: between(...L.logRadius).default(0.25), ends: z.enum(LOG_ENDS).optional().describe('Sawn, snapped or mixed (default) ends.'), moss });
const stump = z.strictObject({ kind: z.literal('stump'), finish, species: z.enum(DEADWOOD_SPECIES).default('oak'), radius: between(...L.stumpRadius).default(0.35),
  height: between(...L.stumpHeight).default(0.5), top: z.enum(STUMP_TOPS).optional(), moss });
// Model spec: the part graph is validated in full by the host (packages/asset-pipeline/src/model-spec.ts), so the advertised schema stays compact.
const unit = between(0, 1).optional();
const spec = z.strictObject({ kind: z.literal('spec'), finish, size: z.tuple([between(...MODEL_LIMITS.size), between(...MODEL_LIMITS.size), between(...MODEL_LIMITS.size)]).describe('Real-world [x,y,z] metres; Z up, front -Y.'),
  materials: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9]{0,15}$/), finish: z.enum(MODEL_FINISHES), color: color.optional(), roughness: unit, metallic: unit, wear: unit, cavity: unit,
    library: z.string().regex(/^[a-z][a-z-]{1,31}$/).optional().describe('Library family; omitted = inferred from ids, context and shape (see review.materials); "none" = plain finish.'),
    glow: between(0, 10).optional(), moss: unit, age: unit })).min(1).max(3),
  parts: z.array(z.record(z.string(), z.unknown())).min(1).max(MODEL_LIMITS.parts).describe('Part graph {id, op, material, at, rot, ...}; format: skills_get arcane-blender-props reference model-spec.'),
  pivot: z.enum(['base', 'origin']).optional(), smoothAngle: between(0, 180).optional(), autoDetail: z.boolean().optional(),
  context: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,23}$/)).max(8).optional().describe('Scene tags steering inferred materials/weathering, e.g. ["outdoor","ancient","swamp"]; "new" = clean.') });

export const proceduralInput = z.strictObject({
  name: assetSlug.describe('Lowercase slug, e.g. "oak-large".'),
  generator: z.discriminatedUnion('kind', [tree, rock, column, foliage, log, stump, spec]),
  seed: z.number().int().min(0).max(2147483647).optional().describe('Same seed + parameters = identical mesh; vary for variants.'),
  // Identical members keep the advertised schema a compact [int x2]; n >= 2 and i <= n are checked by normalizeProcedural.
  variant: z.tuple([z.number().int().min(1).max(PROCEDURAL_VARIANTS), z.number().int().min(1).max(PROCEDURAL_VARIANTS)]).optional()
    .describe('[i,n]: member i of the n-member variant family of this seed+params: evenly spread, correlated (older = taller, mossier), never near-duplicates; i=1 youngest. Not column.'),
  color: color.optional().describe('Primary colour (bark/rock/stone/foliage), linear RGB 0..1.'),
  triangleBudget: z.number().int().min(L.minTriangles).max(L.maxTriangles).optional().describe('Whole asset, 2500..20000 (defaults: tree 16000, rock 6000, column 12000, foliage 8000, log/stump 4000, spec 8000).'),
  renderResolution: z.number().int().min(128).max(768).optional().describe('Preview PNG size (default 512).'),
  renderSamples: z.number().int().min(4).max(64).optional().describe('Preview render samples (default 16). Use 4 with a smaller renderResolution for draft look development; UV, PBR and export checks still run.'),
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
  'tree (species pine/oak/birch/palm, height, trunkTaper, branchLevels 1-3, leafDensity; tapered branching limbs and thin curved closed leaves), rock (size, roughness, form boulder/outcrop/cave, moss; noise, bevelled fracture planes, strata, flat base, ≤6,000 triangles), ' +
  'column (radius, height, 0/8-32 flutes with entasis, base none/plinth/attic, capital none/doric/ionic/corinthian), foliage clump (bush/grass/fern), ' +
  'fallen log (oak/birch, length, radius, sawn/broken ends, moss) or stump (oak/birch, root flare, cut/broken top, moss; log/stump ≤4,000 triangles). ' +
  'spec: original objects faithfully expressible as a bounded declarative part graph (box/cylinder/sphere/revolve/extrude/loft/sweep/sdf parts; mirror/radial/array/scatter; csg weld/cut; noise; ≤3 materials wood/stone/metal/... with edge wear and cavity); load the model-spec reference first with its explicit experimental opt-in. ' +
  'It compiles to a watertight, budgeted, auto-smoothed, base-pivoted mesh with a packed UV0 atlas and baked PBR; assets_preview then returns review metrics (size vs spec, watertight, thickness, silhouette, floating parts, hints): build, look, adjust the spec. ' +
  'Output: one optimised GLB, one mesh per material (≤20,000 triangles total, analytic UV0, original 256px opaque colour/normal/roughness/metalness maps; finish flat selects solid materials), a box/trunk collision proxy, and two preview renders. Deterministic per seed. ' +
  'Choose this route only when it faithfully represents the brief. Original Blender authoring and owned project-relative embedded GLB adoption/conversion require actual native filesystem/process capabilities, current workspace permission and advertised native GLB tools; otherwise report the capability limit, never substitute a different asset. Preserve unsupported-conversion refusals and original scopes. Toolbox models require an explicit user request; inspect the actual preview before calling any result realistic. Returns a job acknowledgement: poll assets_jobs until succeeded (usually 15-90 s), then assets_preview to look at it. ' +
  'Open the 3D preview for human Approve; agents cannot approve. Studio delivery (native sessions): assets_prepare_studio_import → assets_stage_studio_import → assets_reconstruct_studio_import → assets_place_studio_import. Never auto-retry; on timeout inspect assets_jobs.';
const PREVIEW = 'Read: see the Blender review render(s) of a completed asset job as PNG (hero three-quarter and/or side view, ortho camera, studio lighting). ' +
  'Critique silhouette, proportions, density and colour, then regenerate with adjusted parameters or a new seed if needed. A render is not Studio evidence. ' +
  'Spec jobs: side is a 2x2 sheet (front, right, top, wireframe) and the result includes measured review metrics and hints.';
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

/** Model spec self-check (audit.json review) for the spec loop; absent for other jobs. Compact: no per-candidate UV detail. */
const REVIEW_KEYS = ['size', 'triangles', 'watertight', 'thickness', 'silhouette', 'floating', 'uv', 'surfaces', 'lod', 'parts', 'warnings', 'hints'] as const;
export async function specReview(client: Pick<DaemonClient, 'assetsManifest'>, jobId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<Record<string, unknown> | undefined> {
  try {
    const { manifest } = await client.assetsManifest(jobId, options);
    const review = 'validation' in manifest ? (manifest.validation as { review?: Record<string, unknown> }).review : undefined;
    if (!review || typeof review !== 'object') return undefined;
    const out: Record<string, unknown> = Object.fromEntries(REVIEW_KEYS.filter(key => key in review).map(key => [key, review[key]]));
    if (out.uv && typeof out.uv === 'object') { const { candidates: _c, quality: _q, ...uv } = out.uv as Record<string, unknown>; out.uv = uv; }
    return out;
  } catch { return undefined; }
}

/** Pure mapping, exported for tests: typed tool input -> shared assets_start body. */
export function proceduralStartBody(input: z.output<typeof proceduralInput>): Record<string, unknown> {
  const { timeoutMs: _wait, generator, variant, ...rest } = input;
  const drop = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  return drop({ template: 'procedural', ...rest, procedural: drop({ ...generator, variant }) });
}

export function registerProceduralTools(server: McpServer, client: DaemonClient, scope = '', learned: LearnedDefaults | null = null): void {
  const scopedJob = client.assetAudience === 'native-session' ? nativeAssetJobId : assetJobId;
  const preview = previewInput.extend({ jobId: scopedJob });
  server.registerTool<z.ZodRawShape, typeof proceduralInput>('assets_procedural', { description: PROCEDURAL + scope, inputSchema: proceduralInput, annotations: WRITE }, async (input, extra) => {
    try {
      // Learned preferences fill only omitted generator fields (explicit arguments win); notes are returned as `learned`.
      const biased = learned ? await learned.apply('assets_procedural', input as z.output<typeof proceduralInput>) : { input: input as z.output<typeof proceduralInput>, learned: [] as string[] };
      const a = biased.input;
      const started = await client.assetsStart(proceduralStartBody(a) as never, { timeoutMs: a.timeoutMs, signal: extra.signal });
      return ok(client, { ...(started as Record<string, unknown>), nextStep: 'Poll assets_jobs until this job succeeds, then call assets_preview with its jobId and critique the render.', ...(biased.learned.length ? { learned: biased.learned } : {}) });
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
      const review = await specReview(client, a.jobId, { timeoutMs: a.timeoutMs, signal: extra.signal });
      const summary = { jobId: a.jobId, previews: images.map(image => ({ path: image.path, bytes: image.bytes.length, sha256: createHash('sha256').update(image.bytes).digest('hex') })),
        evidence: 'blender-review-render', ...(review ? { review } : {}) };
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
        error: { code: 'STUDIO_RECONSTRUCTION_REQUIRED', message: 'No completed mesh reconstruction is recorded for this asset. Prepare, stage and reconstruct the reviewed asset before placement.' },
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
