import { AssetError, type AssetFailureDiagnostic, type AssetJobError } from './types.js';
import type { CommandResult } from './process.js';
import { RUNTIME_PROBE_REASONS } from './probe-diagnostics.js';

/** Staging facts are separate from generated-job failures and confer no authority. */
export const STUDIO_STAGING_PHASES = ['prior-attempt-check','target-check','admission','packet-enqueue','packet-receipt','seal-check'] as const;
export const STUDIO_STAGING_REASONS = ['proof-missing','plugin-lifetime-changed','plugin-artifact-changed','edit-epoch-changed','not-edit','disconnected','continuity-unsupported','proof-expired'] as const;
export interface StudioStagingDiagnostic {
  readonly schemaVersion:1;readonly operation:'stage';readonly phase:typeof STUDIO_STAGING_PHASES[number];
  readonly reason:typeof STUDIO_STAGING_REASONS[number];readonly packetOrdinal:number|null;
}
/** Exact data only; unknown fields, accessors, proxies and free text are refused. */
export function readStudioStagingDiagnostic(value:unknown):StudioStagingDiagnostic|null {
  try {
    if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
    const fields=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(fields);
    if(keys.length!==5||keys.some(key=>typeof key!=='string'||!['schemaVersion','operation','phase','reason','packetOrdinal'].includes(key)))return null;
    if(Object.values(fields).some(field=>!field.enumerable||!Object.hasOwn(field,'value')))return null;
    const version=fields.schemaVersion!.value,operation=fields.operation!.value,phase=fields.phase!.value,reason=fields.reason!.value,ordinal=fields.packetOrdinal!.value;
    if(version!==1||operation!=='stage'||!STUDIO_STAGING_PHASES.includes(phase)||!STUDIO_STAGING_REASONS.includes(reason))return null;
    const packet=phase==='packet-enqueue'||phase==='packet-receipt';
    if(packet?!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>511:ordinal!==null)return null;
    // The bounded fields are primitives. Clone also rejects otherwise convincing proxies.
    structuredClone(value);
    return Object.freeze({schemaVersion:1,operation:'stage',phase,reason,packetOrdinal:ordinal});
  } catch {return null;}
}
const STAGING_PHASE_TEXT:Record<StudioStagingDiagnostic['phase'],string>={
  'prior-attempt-check':'Previous attempt check','target-check':'Target check',admission:'Admission',
  'packet-enqueue':'Packet enqueue','packet-receipt':'Packet receipt','seal-check':'Final seal check',
};
const STAGING_REASON_TEXT:Record<StudioStagingDiagnostic['reason'],string>={
  'proof-missing':'no current Studio connection check was available',
  'plugin-lifetime-changed':'the Studio plugin connection changed',
  'plugin-artifact-changed':'the loaded Studio plugin changed',
  'edit-epoch-changed':'the Studio editing session changed',
  'not-edit':'Studio was outside Edit mode',disconnected:'the Studio connection was disconnected',
  'continuity-unsupported':'the Studio connection could not establish continuity',
  'proof-expired':'the Studio connection check expired',
};
export function studioStagingDiagnosticMessage(value:StudioStagingDiagnostic):string {
  const diagnostic=readStudioStagingDiagnostic(value);
  if(!diagnostic)return 'Studio staging outcome is unconfirmed. Inspect the original staging status; do not repeat automatically.';
  return 'Studio staging outcome is unconfirmed. '+STAGING_PHASE_TEXT[diagnostic.phase]+
    (diagnostic.packetOrdinal===null?'':', packet '+(diagnostic.packetOrdinal+1))+': '+STAGING_REASON_TEXT[diagnostic.reason]+'.';
}

const STAGES = new Set(['prepare-output', 'probe', 'generate', 'request-validation', 'blockout', 'identity', 'checkpoint-save',
  'mesh-validation', 'texture-authoring', 'review-render', 'scene-save', 'export', 'export-identity', 'export-roundtrip', 'scene-reopen', 'audit-write', 'host-validation']);
const CONVERSION_STAGES = new Set(['input', 'source-import', 'source-map', 'collision', 'scene-save', 'export',
  'scene-reopen', 'export-roundtrip', 'review-render', 'audit-write']);
for (const stage of CONVERSION_STAGES) STAGES.add(stage);
const CONVERSION_REASONS = new Set(['INPUT', 'SOURCE', 'MAP', 'FEATURE', 'GEOMETRY', 'MATERIAL', 'COLLISION', 'EXPORT', 'REOPEN', 'RENDER', 'IO', 'NATIVE', 'IO_PATH', 'IO_LINK', 'IO_TYPE', 'IO_SIZE', 'IO_IDENTITY', 'IO_READ', 'IO_CHANGED', 'IO_EXISTS', 'IO_ACCESS', 'GEOMETRY_COUNTS', 'GEOMETRY_TRANSFORM', 'GEOMETRY_DIRECTION', 'GEOMETRY_TOPOLOGY', 'GEOMETRY_AREA', 'GEOMETRY_UV', 'GEOMETRY_TRIANGLES', 'GEOMETRY_HASH', 'GEOMETRY_HASH_POSITION', 'GEOMETRY_HASH_NORMAL', 'GEOMETRY_HASH_TANGENT', 'GEOMETRY_HASH_UV', 'GEOMETRY_HASH_COLOR', 'GEOMETRY_HASH_CORNER_ASSOCIATION', 'FIDELITY_POSITION', 'FIDELITY_NORMAL', 'FIDELITY_TANGENT', 'FIDELITY_UV', 'FIDELITY_COLOR', 'FIDELITY_TRANSFORM', 'FIDELITY_CONDITION', 'FIDELITY_CORRESPONDENCE', 'FIDELITY_HIERARCHY', 'OPERATOR_ARGUMENT', 'OPERATOR_RUNTIME', 'OPERATOR_CANCELLED', 'OPERATOR_RESULT', 'OPERATOR_EXCEPTION', 'OPERATOR_DIRECTORY_MISSING', 'OPERATOR_DIRECTORY_ACCESS', 'OPERATOR_DIRECTORY_IO', 'OPERATOR_DIRECTORY_ARGUMENT', 'OPERATOR_DIRECTORY_OTHER', 'OPERATOR_WRITE_MISSING', 'OPERATOR_WRITE_ACCESS', 'OPERATOR_WRITE_IO', 'OPERATOR_WRITE_ARGUMENT', 'OPERATOR_WRITE_OTHER', 'OPERATOR_SAVE_MISSING', 'OPERATOR_SAVE_ACCESS', 'OPERATOR_SAVE_IO', 'OPERATOR_SAVE_ARGUMENT', 'OPERATOR_SAVE_OTHER', 'OPERATOR_BEFORE_SAVE', 'OPERATOR_AFTER_SAVE', 'OPERATOR_OBSERVER_VERSION', 'OPERATOR_OBSERVER_ROOT', 'OPERATOR_OBSERVER_SOURCE_ROOT', 'OPERATOR_OBSERVER_SOURCE_BLENDER', 'OPERATOR_OBSERVER_SOURCE_IO', 'OPERATOR_OBSERVER_SOURCE_EXPORT', 'OPERATOR_OBSERVER_SOURCE_WRITER', 'OPERATOR_OBSERVER_PACKAGE_PRE', 'OPERATOR_OBSERVER_IMPORT', 'OPERATOR_OBSERVER_PACKAGE_POST', 'OPERATOR_OBSERVER_FUNCTION', 'OPERATOR_OBSERVER_SITE']);
const TYPES = new Set(['ValueError', 'RuntimeError', 'TypeError', 'AttributeError', 'KeyError', 'IndexError', 'FileNotFoundError',
  'PermissionError', 'OSError', 'MemoryError', 'ImportError', 'ModuleNotFoundError', 'ZeroDivisionError', 'NotImplementedError', 'Exception']);
const REASONS: Record<string, string> = {
  ...RUNTIME_PROBE_REASONS,
  CONVERSION_INPUT: 'Conversion input bytes or request fields failed validation.',
  CONVERSION_SOURCE: 'The original source or marked import copy failed its integrity or fidelity check.',
  CONVERSION_MAP: 'Imported objects could not be matched to the source primitive map.',
  CONVERSION_FEATURE: 'The source contains a feature this fixed conversion worker cannot preserve.',
  CONVERSION_GEOMETRY: 'Measured conversion geometry failed its finite-position, face-area, attribute or UV checks.',
  CONVERSION_GEOMETRY_COUNTS: 'The converted mesh vertex, triangle or UV-layer count is outside the supported bounds.',
  CONVERSION_GEOMETRY_TRANSFORM: 'The converted mesh transform cannot be inverted safely for geometry verification.',
  CONVERSION_GEOMETRY_DIRECTION: 'A converted surface direction cannot be normalized for comparison.',
  CONVERSION_GEOMETRY_TOPOLOGY: 'The converted mesh contains vertices or edges that are not used by its faces.',
  CONVERSION_GEOMETRY_AREA: 'The converted mesh contains a triangle below the permitted world-space face area.',
  CONVERSION_GEOMETRY_UV: 'A converted UV coordinate is nonfinite or outside the permitted range.',
  CONVERSION_GEOMETRY_TRIANGLES: 'The converted mesh triangle count differs from its retained source primitive.',
  CONVERSION_GEOMETRY_HASH: 'The converted geometry comparison digest does not match its retained source digest.',
  CONVERSION_GEOMETRY_HASH_POSITION: 'The refused full geometry comparison also differs in its world-position projection.',
  CONVERSION_GEOMETRY_HASH_NORMAL: 'The refused full geometry comparison also differs in its surface-normal projection.',
  CONVERSION_GEOMETRY_HASH_TANGENT: 'The refused full geometry comparison also differs in its surface-tangent projection.',
  CONVERSION_GEOMETRY_HASH_UV: 'The refused full geometry comparison also differs in its texture-coordinate projections.',
  CONVERSION_GEOMETRY_HASH_COLOR: 'The refused full geometry comparison also differs in its vertex-color projections.',
  CONVERSION_GEOMETRY_HASH_CORNER_ASSOCIATION: 'The full geometry comparison differs despite matching attribute projections; their corner association remains unverified.',
  CONVERSION_FIDELITY_POSITION: 'A measured vertex exceeded the fixed physical precision limit in local, source or world space.',
  CONVERSION_FIDELITY_NORMAL: 'A measured surface normal exceeded the fixed angular precision limit.',
  CONVERSION_FIDELITY_TANGENT: 'A measured tangent exceeded the fixed angular limit or changed handedness.',
  CONVERSION_FIDELITY_UV: 'A measured UV component exceeded the fixed texture-coordinate precision limit.',
  CONVERSION_FIDELITY_COLOR: 'A measured color or alpha component exceeded the fixed linear color precision limit.',
  CONVERSION_FIDELITY_TRANSFORM: 'A measured local transform exceeded its fixed precision limit or changed handedness.',
  CONVERSION_FIDELITY_CONDITION: 'The model transform exceeds the supported numerical conditioning limit.',
  CONVERSION_FIDELITY_CORRESPONDENCE: 'The model lost exact source vertex correspondence, oriented face coverage or multiplicity.',
  CONVERSION_FIDELITY_HIERARCHY: 'The model changed its exact selected node or parent correspondence.',
  CONVERSION_MATERIAL: 'Source material or image data could not be preserved through conversion.',
  CONVERSION_COLLISION: 'The requested collision hull failed its geometry or closed-volume checks.',
  CONVERSION_EXPORT: 'The exported model failed its measured geometry, identity or hierarchy checks.',
  CONVERSION_REOPEN: 'The saved Blender scene changed when reopened for verification.',
  CONVERSION_RENDER: 'The conversion preview failed its content or image checks.',
  CONVERSION_IO: 'A required conversion input or artifact could not be read or written safely.',
  CONVERSION_IO_PATH: 'A conversion file check requires an absolute owned path.',
  CONVERSION_IO_LINK: 'A conversion file or ancestor is linked, reparsed or has multiple hard links.',
  CONVERSION_IO_TYPE: 'A conversion path is not the required ordinary file or directory.',
  CONVERSION_IO_SIZE: 'A conversion input or artifact is outside its allowed byte range.',
  CONVERSION_IO_IDENTITY: 'The opened conversion file metadata differs from the checked path metadata.',
  CONVERSION_IO_READ: 'A conversion file ended early or contained unexpected extra bytes.',
  CONVERSION_IO_CHANGED: 'A conversion file changed while its bytes were being read or rechecked.',
  CONVERSION_IO_EXISTS: 'A new conversion artifact already exists and will not be overwritten.',
  CONVERSION_IO_ACCESS: 'The operating system refused a conversion file or directory operation.',
  CONVERSION_NATIVE: 'Blender stopped unexpectedly during this conversion stage.',
  CONVERSION_OPERATOR_ARGUMENT: 'The export operator raised an argument or value error.',
  CONVERSION_OPERATOR_RUNTIME: 'The export operator reported a runtime failure.',
  CONVERSION_OPERATOR_CANCELLED: 'The export operator returned CANCELLED without a completed export.',
  CONVERSION_OPERATOR_RESULT: 'The export operator returned an unsupported completion status.',
  CONVERSION_OPERATOR_EXCEPTION: 'The export operator raised an unclassified exception.',
  CONVERSION_OPERATOR_DIRECTORY_MISSING: 'An observed exporter exception escaped output-directory handling: a file or directory was not found.',
  CONVERSION_OPERATOR_DIRECTORY_ACCESS: 'An observed exporter exception escaped output-directory handling: access was denied.',
  CONVERSION_OPERATOR_DIRECTORY_IO: 'An observed exporter exception escaped output-directory handling: an operating-system I/O exception occurred.',
  CONVERSION_OPERATOR_DIRECTORY_ARGUMENT: 'An observed exporter exception escaped output-directory handling: an argument or value exception occurred.',
  CONVERSION_OPERATOR_DIRECTORY_OTHER: 'An observed exporter exception escaped output-directory handling: another exception occurred.',
  CONVERSION_OPERATOR_WRITE_MISSING: 'An observed exporter exception escaped final GLB writing: a file or directory was not found.',
  CONVERSION_OPERATOR_WRITE_ACCESS: 'An observed exporter exception escaped final GLB writing: access was denied.',
  CONVERSION_OPERATOR_WRITE_IO: 'An observed exporter exception escaped final GLB writing: an operating-system I/O exception occurred.',
  CONVERSION_OPERATOR_WRITE_ARGUMENT: 'An observed exporter exception escaped final GLB writing: an argument or value exception occurred.',
  CONVERSION_OPERATOR_WRITE_OTHER: 'An observed exporter exception escaped final GLB writing: another exception occurred.',
  CONVERSION_OPERATOR_SAVE_MISSING: 'An observed exporter exception escaped save orchestration: a file or directory was not found.',
  CONVERSION_OPERATOR_SAVE_ACCESS: 'An observed exporter exception escaped save orchestration: access was denied.',
  CONVERSION_OPERATOR_SAVE_IO: 'An observed exporter exception escaped save orchestration: an operating-system I/O exception occurred.',
  CONVERSION_OPERATOR_SAVE_ARGUMENT: 'An observed exporter exception escaped save orchestration: an argument or value exception occurred.',
  CONVERSION_OPERATOR_SAVE_OTHER: 'An observed exporter exception escaped save orchestration: another exception occurred.',
  CONVERSION_OPERATOR_BEFORE_SAVE: 'The export operator reported failure before entering the observed save function.',
  CONVERSION_OPERATOR_AFTER_SAVE: 'The export operator reported failure after the observed save function returned.',
  CONVERSION_OPERATOR_OBSERVER_VERSION: 'Export failed while detailed diagnostics were unavailable at runtime version recognition. The underlying export cause is not established.',
  CONVERSION_OPERATOR_OBSERVER_ROOT: 'Export failed while detailed diagnostics were unavailable at bundled runtime directory recognition. The underlying export cause is not established.',
  CONVERSION_OPERATOR_OBSERVER_SOURCE_ROOT: 'Export failed while detailed diagnostics were unavailable at bundled operator source verification. The underlying export cause is not established.',
  CONVERSION_OPERATOR_OBSERVER_SOURCE_BLENDER: 'Export failed while detailed diagnostics were unavailable at bundled Blender package source verification. The underlying export cause is not established.',
  CONVERSION_OPERATOR_OBSERVER_SOURCE_IO: 'Export failed while detailed diagnostics were unavailable at bundled I/O package source verification. The underlying export cause is not established.',
  CONVERSION_OPERATOR_OBSERVER_SOURCE_EXPORT: 'Export failed while detailed diagnostics were unavailable at bundled exporter source verification. The underlying export cause is not established.',
  CONVERSION_OPERATOR_OBSERVER_SOURCE_WRITER: 'Export failed while detailed diagnostics were unavailable at bundled GLB writer source verification. The underlying export cause is not established.',
  CONVERSION_OPERATOR_OBSERVER_PACKAGE_PRE: 'Export failed while detailed diagnostics were unavailable at loaded package recognition before import. The underlying export cause is not established.',
  CONVERSION_OPERATOR_OBSERVER_IMPORT: 'Export failed while detailed diagnostics were unavailable at fixed bundled exporter import. The underlying export cause is not established.',
  CONVERSION_OPERATOR_OBSERVER_PACKAGE_POST: 'Export failed while detailed diagnostics were unavailable at loaded package recognition after import. The underlying export cause is not established.',
  CONVERSION_OPERATOR_OBSERVER_FUNCTION: 'Export failed while detailed diagnostics were unavailable at bundled exporter function recognition. The underlying export cause is not established.',
  CONVERSION_OPERATOR_OBSERVER_SITE: 'Export failed while detailed diagnostics were unavailable at recognizing the escaping save call site. The underlying export cause is not established.',
  REQUEST_PROVENANCE: 'Request bytes failed their size or SHA-256 provenance check.',
  WINDOWS_PATH_LIMIT: 'The installed Blender cannot use this long Windows asset path because no verified short directory alias is available; choose a shorter asset output directory.',
  MESH_REPAIR: 'Generated mesh required structural repair and was rejected.',
  MESH_AUDIT: 'Structural mesh validation rejected the generated geometry; inspect the per-mesh audit.',
  MESH_MATERIAL_NODE: 'A generated mesh has a missing or incorrectly named material, or a material without shader nodes.',
  MESH_MATERIAL_LINK: 'A generated mesh material has an invalid connection between shader nodes.',
  MESH_MATERIAL_SURFACE: 'A generated mesh material has no connected active surface output.',
  MESH_MATERIAL_PBR: 'A generated mesh material is missing its PBR shader or has an invalid metallic or roughness value.',
  RENDER_CONTENT: 'Review render was empty, uniform or contained nonfinite pixels.',
  FOLIAGE_ATTACHMENT: 'Foliage could not remain attached to the final emitted branch surface.',
  FOLIAGE_SCALE: 'Oak foliage texture scale or density failed its bounded authoring checks.',
  SCENE_REOPEN: 'Reopened scene geometry differs from the validated generated scene.',
  EXPORT_ROUNDTRIP: 'Reimported export geometry failed triangle-count or finite-position validation.',
  IMPORT_IDENTITY: 'Exported object or anchor identities failed verification.',
  PROCEDURAL_LIMIT: 'Procedural parameters cannot produce valid geometry within the requested dimensions or triangle budget.',
  FILE_MISSING: 'A required local worker input or artifact was not found.',
  FILE_ACCESS: 'The worker could not access a required local input or artifact.',
  MEMORY_LIMIT: 'The worker ran out of memory while building or reviewing the asset.',
  BLENDER_API: 'The installed Blender API lacks a property, module or operation required by the bundled worker.',
  BLENDER_CONTEXT: 'A Blender operator rejected the current scene or object context.',
  BLENDER_OPERATION: 'Blender rejected an operation in this stage.',
  INVALID_DATA: 'The bundled worker rejected invalid geometry or parameter data in this stage.',
  INTERNAL_TYPE: 'The bundled worker encountered an incompatible value or missing data member in this stage.',
  WORKER_EXIT: 'The worker exited without a valid structured failure report.',
  HOST_FAILURE: 'The host rejected the asset operation in this stage.',
};
const METRICS = new Set(['renderTriangles', 'triangleBudget', 'collisionTriangles', 'invalidMeshes', 'errorCount']);
const MATERIAL_REASONS = new Set(['MESH_MATERIAL_NODE', 'MESH_MATERIAL_LINK', 'MESH_MATERIAL_SURFACE', 'MESH_MATERIAL_PBR']);
const ARTIFACTS = new Set(['request.json', 'blockout.blend', 'asset.blend', 'asset.glb', 'asset.fbx', 'collision.glb',
  'asset-lod1.glb', 'preview-hero.png', 'preview-side.png', 'preview-structure.png', 'audit.json', 'assembly.json']);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetError('RECOVERY', 'Invalid failure diagnostic.');
  return value as Record<string, unknown>;
}
export const failureStage = (value: string): string => STAGES.has(value) ? value : 'generate';
function reason(code: string, metrics?: Record<string, number>): string {
  if (code === 'MESH_AUDIT' && metrics?.renderTriangles !== undefined && metrics.triangleBudget !== undefined &&
      (metrics.renderTriangles === 0 || metrics.renderTriangles > metrics.triangleBudget)) {
    return `Render triangle count ${metrics.renderTriangles} is outside 1..${metrics.triangleBudget}; inspect the per-mesh audit.`;
  }
  return REASONS[code]!;
}
/** Wire reports contain enum tokens and bounded numbers only. Arbitrary exception text is never accepted. */
function wireDiagnostic(value: unknown): AssetFailureDiagnostic {
  const v = object(value);
  if (Object.keys(v).some(k => !['schemaVersion', 'stage', 'reasonCode', 'exceptionType', 'metrics', 'artifactPath', 'auditPath'].includes(k)) ||
      v.schemaVersion !== 1 || typeof v.stage !== 'string' || !STAGES.has(v.stage) ||
      typeof v.reasonCode !== 'string' || !Object.hasOwn(REASONS, v.reasonCode) || v.reasonCode === 'HOST_FAILURE' ||
      (v.exceptionType !== null && (typeof v.exceptionType !== 'string' || !TYPES.has(v.exceptionType))) ||
      (v.auditPath !== undefined && v.auditPath !== 'audit.json') ||
      (v.artifactPath !== undefined && (typeof v.artifactPath !== 'string' || !ARTIFACTS.has(v.artifactPath)))) throw new AssetError('RECOVERY', 'Invalid failure diagnostic.');
  if (v.reasonCode.startsWith('CONVERSION_') &&
      (!CONVERSION_REASONS.has(v.reasonCode.slice(11)) || !CONVERSION_STAGES.has(v.stage) || v.exceptionType !== null ||
       Object.keys(v).sort().join(',') !== 'exceptionType,reasonCode,schemaVersion,stage')) {
    throw new AssetError('RECOVERY', 'Invalid conversion failure diagnostic.');
  }
  if (v.reasonCode.startsWith('RUNTIME_') &&
      (v.stage !== 'probe' || v.exceptionType !== null ||
       Object.keys(v).sort().join(',') !== 'exceptionType,reasonCode,schemaVersion,stage')) {
    throw new AssetError('RECOVERY', 'Invalid runtime probe diagnostic.');
  }
  let metrics: Record<string, number> | undefined;
  if (v.metrics !== undefined) {
    const values = object(v.metrics); metrics = {};
    for (const [key, n] of Object.entries(values)) {
      if (!METRICS.has(key) || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000) throw new AssetError('RECOVERY', 'Invalid failure metrics.');
      metrics[key] = n;
    }
  }
  if (MATERIAL_REASONS.has(v.reasonCode) && (v.stage !== 'mesh-validation' || v.exceptionType !== 'ValueError' || v.auditPath !== 'audit.json' ||
      !metrics || Object.keys(metrics).length !== METRICS.size || !metrics.errorCount || !metrics.invalidMeshes || metrics.invalidMeshes > metrics.errorCount ||
      !metrics.renderTriangles || !metrics.triangleBudget || metrics.renderTriangles > metrics.triangleBudget || !metrics.collisionTriangles))
    throw new AssetError('RECOVERY', 'Invalid measured material failure diagnostic.');
  return { schemaVersion: 1, stage: v.stage, reasonCode: v.reasonCode, reason: reason(v.reasonCode, metrics), exceptionType: v.exceptionType as string | null,
    ...(metrics ? { metrics } : {}), ...(v.artifactPath ? { artifactPath: v.artifactPath as string } : {}), ...(v.auditPath ? { auditPath: 'audit.json' } : {}) };
}
export function workerFailure(result: CommandResult, stage: string): AssetError {
  let diagnostic: AssetFailureDiagnostic = { schemaVersion: 1, stage: failureStage(stage), reasonCode: 'WORKER_EXIT', reason: REASONS.WORKER_EXIT!, exceptionType: null };
  const lines = result.stdout.split(/\r?\n/).filter(line => line.startsWith('ARCANE_FAILURE '));
  if (lines.length === 1 && lines[0]!.length <= 2048) {
    try { diagnostic = wireDiagnostic(JSON.parse(lines[0]!.slice(15))); } catch { /* untrusted report falls back to host-observed exit */ }
  }
  const exit = result.signal ? ` Signal: ${result.signal}.` : ` Exit code: ${result.exitCode ?? 'unknown'}.`;
  const classification = diagnostic.exceptionType ? ` (${diagnostic.exceptionType}; ${diagnostic.reasonCode}).` : '';
  return new AssetError('BLENDER_FAILED', `${diagnostic.reason}${classification}${exit}`, diagnostic);
}
/** Conversion workers emit a separate closed enum-only protocol. This is a failure
 * description, never evidence that a native process closed or that retry is safe. */
export function conversionWorkerFailure(result: CommandResult, stage: string): AssetError {
  let diagnostic: AssetFailureDiagnostic = { schemaVersion: 1, stage: failureStage(stage),
    reasonCode: 'WORKER_EXIT', reason: REASONS.WORKER_EXIT!, exceptionType: null };
  const lines = result.stdout.split(/\r?\n/).filter(line => line.startsWith('ARCANE_FAILURE '));
  if (lines.length === 1 && lines[0]!.length <= 512) {
    try {
      const value = object(JSON.parse(lines[0]!.slice(15)));
      if (Object.keys(value).sort().join(',') !== 'reason,stage,type' || value.type !== 'conversion-refused' ||
          typeof value.stage !== 'string' || !CONVERSION_STAGES.has(value.stage) ||
          typeof value.reason !== 'string' || !CONVERSION_REASONS.has(value.reason)) throw new Error('Invalid conversion report.');
      diagnostic = wireDiagnostic({ schemaVersion: 1, stage: value.stage,
        reasonCode: 'CONVERSION_' + value.reason, exceptionType: null });
    } catch { /* untrusted output remains a host-observed exit without a claimed cause */ }
  }
  const exit = result.signal ? ` Signal: ${result.signal}.` : ` Exit code: ${result.exitCode ?? 'unknown'}.`;
  return new AssetError('BLENDER_FAILED', `${diagnostic.reason}${exit}`, diagnostic);
}
export function hostFailure(stage: string): AssetFailureDiagnostic {
  return { schemaVersion: 1, stage: failureStage(stage), reasonCode: 'HOST_FAILURE', reason: REASONS.HOST_FAILURE!, exceptionType: null };
}
export function failureMessage(message: string, diagnostic: AssetFailureDiagnostic): string {
  const reference = diagnostic.logPath ? ` See ${diagnostic.logPath}${diagnostic.auditPath ? ` and ${diagnostic.auditPath}` : ''}.` : '';
  return `Asset failed at ${diagnostic.stage}${diagnostic.artifactPath ? ` (${diagnostic.artifactPath})` : ''}: ${message}${reference}`.slice(0, 1024);
}
/** Shared by journal recovery and MCP response decoding, so neither strips diagnostic evidence. */
export function decodeAssetJobError(value: unknown): AssetJobError {
  const error = object(value);
  if (typeof error.code !== 'string' || !/^[A-Z_]{1,64}$/.test(error.code) || typeof error.message !== 'string' || error.message.length > 1024 ||
      Object.keys(error).some(k => !['code', 'message', 'diagnostic'].includes(k))) throw new AssetError('RECOVERY', 'Invalid terminal journal error.');
  let diagnostic: AssetFailureDiagnostic | undefined;
  if (error.diagnostic !== undefined) {
    const raw = object(error.diagnostic), { reason: savedReason, logPath, ...wire } = raw;
    if (logPath !== undefined && logPath !== 'failure.json') throw new AssetError('RECOVERY', 'Invalid failure log reference.');
    if (wire.reasonCode === 'HOST_FAILURE') {
      if (Object.keys(wire).sort().join(',') !== 'exceptionType,reasonCode,schemaVersion,stage' || wire.schemaVersion !== 1 || wire.exceptionType !== null ||
          typeof wire.stage !== 'string' || !STAGES.has(wire.stage)) throw new AssetError('RECOVERY', 'Invalid host failure diagnostic.');
      diagnostic = hostFailure(wire.stage);
    } else diagnostic = wireDiagnostic(wire);
    if (savedReason !== diagnostic.reason) throw new AssetError('RECOVERY', 'Invalid failure reason.');
    if (logPath) diagnostic.logPath = 'failure.json';
  }
  return { code: error.code, message: error.message, ...(diagnostic ? { diagnostic } : {}) };
}
