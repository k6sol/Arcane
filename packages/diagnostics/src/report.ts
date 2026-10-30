/** Shared wire contract. Never pass raw exception messages, paths, prompts or source here. */
export const DIAGNOSTIC_REASONS = {
  PORT_IN_USE: 'Another local process already owns the saved runtime port.',
  PROJECT_IN_USE: 'Another running Arcane process owns this project workspace.',
  STATE_NEWER: 'Saved runtime state requires a newer Arcane build.',
  STATE_UNSAFE: 'The runtime state directory failed its direct private storage checks.',
  RESOURCE_UNAVAILABLE: 'The installed application resources could not be verified or opened.',
  OPERATION_CANCELLED: 'The operation was cancelled before it completed.',
  SUPERVISION_LOST: 'Worker closure could not be verified; retained records require reconciliation.',
  REQUEST_PROVENANCE: 'Request bytes failed their size or SHA-256 provenance check.',
  WINDOWS_PATH_LIMIT: 'The installed worker cannot use the asset path without a verified short directory alias.',
  MESH_REPAIR: 'Generated mesh required structural repair and was rejected.',
  MESH_AUDIT: 'Structural mesh validation rejected the generated geometry.',
  RENDER_CONTENT: 'The review render was empty, uniform or contained nonfinite pixels.',
  SCENE_REOPEN: 'Reopened scene geometry differs from the validated scene.',
  EXPORT_ROUNDTRIP: 'Reimported geometry failed triangle-count or finite-position validation.',
  IMPORT_IDENTITY: 'Exported object or anchor identities failed verification.',
  PROCEDURAL_LIMIT: 'Procedural parameters cannot produce valid geometry within the dimensions or triangle budget.',
  FILE_MISSING: 'A required local input or artifact was not found.',
  FILE_ACCESS: 'A required local input or artifact could not be accessed.',
  MEMORY_LIMIT: 'The process ran out of memory while performing this operation.',
  BLENDER_API: 'The installed Blender API lacks a required property, module or operation.',
  BLENDER_CONTEXT: 'A Blender operator rejected the current scene or object context.',
  BLENDER_OPERATION: 'Blender rejected an operation in this stage.',
  INVALID_DATA: 'Geometry or parameter data was rejected in this stage.',
  INTERNAL_TYPE: 'An incompatible value or missing data member prevented this operation.',
  WORKER_EXIT: 'The worker exited without a valid structured result.',
  HOST_FAILURE: 'The host rejected this operation in this stage.',
  PROCESS_LAUNCH: 'The required local process could not start.',
  PROCESS_PIPE: 'The local process communication channel closed or failed.',
  REQUEST_TIMEOUT: 'The operation exceeded its configured time limit.',
  REQUEST_REJECTED: 'The remote service rejected the request.',
  APPROVAL_REJECTED: 'The tool approval layer refused this operation.',
  AUTH_REQUIRED: 'The required account session is absent or expired.',
  CONNECTION_UNAVAILABLE: 'The required connection is unavailable.',
  STORAGE_UNAVAILABLE: 'The operation could not save or recover its local state.',
  PERMISSION_DENIED: 'The required filesystem or tool permission was refused.',
  IMPORT_FAILED: 'Studio could not import the generated asset.',
  STUDIO_STAGE_CONTINUITY: 'Studio staging continuity could not be confirmed; inspect the recorded check without repeating the request.',
  UPDATE_FAILED: 'The desktop update could not complete this stage.',
  INTERNAL_ERROR: 'An unexpected exception prevented this operation; its safe exception class is recorded when known.',
} as const;
export type DiagnosticCode = keyof typeof DIAGNOSTIC_REASONS;
export const DIAGNOSTIC_COMPONENTS = ['desktop', 'daemon', 'blender', 'studio', 'chat', 'gateway'] as const;
export const DIAGNOSTIC_STAGES = ['startup', 'authenticate', 'account-refresh', 'request-submit', 'request-stream',
  'tool-dispatch', 'tool-approval', 'history-load', 'preferences-save', 'preview-load', 'studio-connect', 'studio-import',
  'studio-place', 'studio-delete', 'playtest', 'update-check', 'update-install', 'update-restart', 'prepare-output', 'probe',
  'generate', 'request-validation', 'blockout', 'identity', 'checkpoint-save', 'mesh-validation', 'texture-authoring',
  'review-render', 'scene-save', 'export', 'export-identity', 'export-roundtrip', 'scene-reopen', 'audit-write', 'host-validation'] as const;
export const DIAGNOSTIC_EXCEPTIONS = ['Error', 'AbortError', 'RangeError', 'SyntaxError', 'ValueError', 'RuntimeError',
  'TypeError', 'AttributeError', 'KeyError', 'IndexError', 'FileNotFoundError', 'PermissionError', 'OSError', 'MemoryError',
  'ImportError', 'ModuleNotFoundError', 'ZeroDivisionError', 'NotImplementedError', 'Exception'] as const;
const SIGNALS = ['SIGABRT', 'SIGINT', 'SIGKILL', 'SIGTERM', 'SIGSEGV', 'SIGPIPE'] as const;
const NUMERIC = ['elapsedMs', 'attempt', 'renderTriangles', 'triangleBudget', 'collisionTriangles', 'invalidMeshes', 'errorCount'] as const;
// This schema is also consumed directly by the gateway. Keep its closed wire
// boundary standalone; do not import the desktop/asset-pipeline runtime here.
const STAGING_PHASES = ['prior-attempt-check', 'target-check', 'admission', 'packet-enqueue', 'packet-receipt', 'seal-check'] as const;
const STAGING_REASONS = ['proof-missing', 'plugin-lifetime-changed', 'plugin-artifact-changed', 'edit-epoch-changed', 'not-edit', 'disconnected', 'continuity-unsupported', 'proof-expired'] as const;
export const DIAGNOSTIC_MAX_BYTES = 8192;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface DiagnosticContext {
  jobId?: string; operationId?: string;
  exceptionType?: typeof DIAGNOSTIC_EXCEPTIONS[number]; signal?: typeof SIGNALS[number];
  exitCode?: number; httpStatus?: number; elapsedMs?: number; attempt?: number;
  renderTriangles?: number; triangleBudget?: number; collisionTriangles?: number; invalidMeshes?: number; errorCount?: number;
  stagingPhase?: typeof STAGING_PHASES[number]; stagingReason?: typeof STAGING_REASONS[number]; packetOrdinal?: number;
}
export interface DiagnosticEvent {
  schemaVersion: 1; eventId: string; occurredAt: number;
  component: typeof DIAGNOSTIC_COMPONENTS[number]; stage: typeof DIAGNOSTIC_STAGES[number];
  code: DiagnosticCode; reason: string; release?: string; platform?: 'win32' | 'darwin' | 'linux'; context?: DiagnosticContext;
}
export class DiagnosticValidationError extends Error { constructor() { super('Invalid diagnostic report.'); } }
const fail = (): never => { throw new DiagnosticValidationError(); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  return value as Record<string, unknown>;
}
export const diagnosticEventId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
/** Strict projection, not a regex promise: all arbitrary text and unknown fields are refused. */
export function diagnosticEvent(value: unknown): DiagnosticEvent {
  const v = record(value);
  if (Object.keys(v).some(key => !['schemaVersion', 'eventId', 'occurredAt', 'component', 'stage', 'code', 'reason', 'release', 'platform', 'context'].includes(key)) ||
      v.schemaVersion !== 1 || !diagnosticEventId(v.eventId) || !Number.isSafeInteger(v.occurredAt) || Number(v.occurredAt) < 0 ||
      !DIAGNOSTIC_COMPONENTS.includes(v.component as DiagnosticEvent['component']) || !DIAGNOSTIC_STAGES.includes(v.stage as DiagnosticEvent['stage']) ||
      typeof v.code !== 'string' || !Object.hasOwn(DIAGNOSTIC_REASONS, v.code)) fail();
  const reason = DIAGNOSTIC_REASONS[v.code as DiagnosticCode];
  if (v.reason !== undefined && v.reason !== reason) fail();
  if (v.release !== undefined && (typeof v.release !== 'string' || !/^[a-f0-9]{40}$/.test(v.release))) fail();
  if (v.platform !== undefined && !['win32', 'darwin', 'linux'].includes(v.platform as string)) fail();
  const staging = v.code === 'STUDIO_STAGE_CONTINUITY';
  if (staging && (v.component !== 'studio' || v.stage !== 'studio-import' || v.context === undefined)) fail();
  let context: DiagnosticContext | undefined;
  if (v.context !== undefined) {
    const raw = record(v.context); const clean: Record<string, string | number> = {};
    if (staging) {
      const keys = Reflect.ownKeys(raw);
      if (keys.some(key => typeof key !== 'string' || !['stagingPhase', 'stagingReason', 'packetOrdinal'].includes(key) ||
        !Object.getOwnPropertyDescriptor(raw,key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw,key) ?? {},'value')) ||
        !Object.hasOwn(raw,'stagingPhase') || !Object.hasOwn(raw,'stagingReason')) fail();
      const packet = raw.stagingPhase === 'packet-enqueue' || raw.stagingPhase === 'packet-receipt';
      if (packet ? !Object.hasOwn(raw,'packetOrdinal') : Object.hasOwn(raw,'packetOrdinal')) fail();
    }
    for (const key of Object.keys(raw).sort()) {
      const entry = raw[key];
      if (key === 'stagingPhase') { if (!staging || !(STAGING_PHASES as readonly unknown[]).includes(entry)) fail(); }
      else if (key === 'stagingReason') { if (!staging || !(STAGING_REASONS as readonly unknown[]).includes(entry)) fail(); }
      else if (key === 'packetOrdinal') { if (!staging || !Number.isSafeInteger(entry) || Number(entry) < 0 || Number(entry) > 511) fail(); }
      else if (key === 'jobId') { if (!diagnosticEventId(entry)) fail(); }
      else if (key === 'operationId') {
        // Correlation only: native action UUIDs also admit the two reserved RFC forms.
        if (!diagnosticEventId(entry) && entry !== '00000000-0000-0000-0000-000000000000' && entry !== 'ffffffff-ffff-ffff-ffff-ffffffffffff') fail();
      }
      else if (key === 'exceptionType') { if (!DIAGNOSTIC_EXCEPTIONS.includes(entry as typeof DIAGNOSTIC_EXCEPTIONS[number])) fail(); }
      else if (key === 'signal') { if (!SIGNALS.includes(entry as typeof SIGNALS[number])) fail(); }
      else if (key === 'exitCode') { if (!Number.isSafeInteger(entry) || Number(entry) < -2147483648 || Number(entry) > 4294967295) fail(); }
      else if (key === 'httpStatus') { if (!Number.isSafeInteger(entry) || Number(entry) < 100 || Number(entry) > 599) fail(); }
      else if ((NUMERIC as readonly string[]).includes(key)) { if (!Number.isSafeInteger(entry) || Number(entry) < 0 || Number(entry) > 1_000_000_000) fail(); }
      else fail();
      clean[key] = entry as string | number;
    }
    context = clean as DiagnosticContext;
  }
  return {schemaVersion: 1, eventId: v.eventId as string, occurredAt: v.occurredAt as number,
    component: v.component as DiagnosticEvent['component'], stage: v.stage as DiagnosticEvent['stage'], code: v.code as DiagnosticCode, reason,
    ...(v.release !== undefined ? {release: v.release as string} : {}), ...(v.platform !== undefined ? {platform: v.platform as NonNullable<DiagnosticEvent['platform']>} : {}),
    ...(context ? {context} : {})};
}
