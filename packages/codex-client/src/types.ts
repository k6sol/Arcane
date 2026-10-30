export const CODEX_LIMITS = Object.freeze({
  requestTimeoutMs: 15_000, approvalTimeoutMs: 60_000, maxFrameBytes: 1_048_576,
  maxPendingRequests: 16, maxQueuedBytes: 2_097_152, maxOutputBytes: 268_435_456,
  maxStderrBytes: 1_048_576, maxEvents: 256, maxEventBytes: 1_048_576,
  maxApprovals: 16, maxServerRequests: 4096, maxOperations: 128,
  maxCatalogPages: 16, maxModels: 512, maxInputBytes: 131_072,
});
export type Limits = typeof CODEX_LIMITS;
export type LimitOptions = Partial<{ [K in keyof Limits]: number }>;
export type LocalUse = 'personal-local' | 'open-source-local';
/** Trusted host-code only; never derive this object from browser or MCP input. */
export interface ArcaneMcpLaunchProfile {
  nodeExecutable: string; serverEntry: string; projectRoot: string; daemonUrl: string; agentToken: string;
}
/** Host-only local dispatch intent, never provider-origin attribution or RPC input. */
export interface NativeAssetIntent {
  readonly connectionId: string; readonly threadId: string; readonly operationId: string;
}
/** Supply an exact frozen object with four own data callbacks from trusted host code. */
export interface NativeAssetHooks {
  finalCredential(): string;
  dispatched(intent: NativeAssetIntent): void;
  ended(intent: NativeAssetIntent): void;
  retired(): void;
}
export interface ConnectOptions {
  command: string; cwd: string; use: LocalUse; limits?: LimitOptions; arcaneMcp?: ArcaneMcpLaunchProfile; nativeAssetHooks?: NativeAssetHooks;
  /** Host callback: text appended after the fixed task instructions on each Arcane thread start/resume (project memory). */
  projectInstructions?: (cwd: string) => Promise<string> | string;
}
export interface HumanAction { initiatedBy: 'human' }
/** Append human input to the exact existing turn; no policy/model/grant overrides. */
export interface SteerTurnAction extends HumanAction {
  threadId: string; expectedTurnId: string; text: string; clientUserMessageId: string;
}
export interface SteerTurnAck { turnId: string }
/** Host-only continuation token. Session object identity, not this JSON shape,
 * binds one additional turn to the original human task and its local policy. */
export interface NativeTaskContinuation { readonly kind: 'native-task-continuation' }
/** Host-only bounded chain of parent incorporation turns, separate from the single repair continuation.
 * Chains and permits are opaque objects compared by identity; structural copies are never accepted. */
export interface NativeIncorporationChain { readonly kind: 'native-incorporation-chain' }
export interface NativeIncorporationPermit { readonly kind: 'native-incorporation-permit' }
export interface ManagedTaskStart { thread: ThreadState; continuation: NativeTaskContinuation }
export interface Selection { model: string; effort: string }
export interface Model {
  model: string; id: string; displayName: string; efforts: string[];
  defaultEffort: string | null; entitlement: 'unverified';
  inputModalities?: ('text'|'image'|'audio')[];
  inputModalitiesSource?: 'reported'|'compatibility-default';
}
export interface Account {
  auth: 'subscription' | 'signed-out' | 'unsupported';
  plan: string | null; requiresOpenaiAuth: boolean;
}
export type OperationState = 'pending' | 'acknowledged' | 'rejected' | 'unknown' | 'not-sent';
export interface Operation {
  operationId: string; method: 'thread/start' | 'thread/resume' | 'turn/start' | 'turn/steer' | 'turn/interrupt';
  requestId: number | null; threadId: string | null; turnId: string | null;
  state: OperationState; errorCode: string | null;
}
export interface ThreadState {
  threadId: string; sessionId: string | null; selection: Selection; configured: boolean;
  writeGranted: boolean; turnId: string | null;
  turnStatus: 'idle' | 'starting' | 'inProgress' | 'cancelling' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  /** Native turn duration when explicitly reported; never derived from wall timestamps. */
  durationMs?: number;
}
export type ApprovalMethod = 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval';
export interface FileChangePreview { path: string; kind: 'add' | 'delete' | 'update'; movePath: string | null; diff: string }
export interface Approval {
  handle: string; connectionId: string; serverRequestId: string | number;
  method: ApprovalMethod; threadId: string; turnId: string; itemId: string;
  reason: string | null; command: string | null; cwd: string | null;
  changes: FileChangePreview[] | null; canAccept: boolean; expiresAt: number;
}
/** Native counts, not monetary charges. `last` is not a turn total. */
export interface TokenUsageBreakdown {
  totalTokens: number; inputTokens: number; cachedInputTokens: number;
  outputTokens: number; reasoningOutputTokens: number;
  /** Older protocol versions omit this count; omission is not zero. */
  cacheWriteInputTokens?: number;
}
export interface NativeTokenUsage {
  source: 'thread/tokenUsage/updated';
  total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null;
  /** A decrease cannot distinguish a reset from a delayed native update. */
  continuity: 'reported' | 'uncertain';
}
export interface TokenUsageReport extends NativeTokenUsage { threadId: string; turnId: string; seq: number }
/** Display-only Studio reference: root plus display path segments. */
export interface McpToolCallRef { root: string; pathSegments: string[] }
/** Allowlisted, bounded display arguments of an Arcane tool call (never sources, values or credentials). */
export interface McpToolCallArgs {
  ref?: McpToolCallRef; parent?: McpToolCallRef; root?: string; query?: string; name?: string; className?: string; kind?: string;
  enabled?: boolean; properties?: Record<string, true>;
}
/** Public identity of a live native MCP tool call item; args only for the Arcane server. */
export type McpFailureTool = 'skills_recommend'|'skills_list'|'skills_get'|'studio_viewport_capture'|'scene_build'
  |'studio_asset_generate'|'assets_place_studio_import'|null;
export type McpToolFailureCode = 'BUNDLE_INTEGRITY'|'INTEGRITY'|'REGISTRY'|'FRONTMATTER'|'DESCRIPTION'|'LICENCE'|'FILE_LIMIT'|'INVALID_PATH'|'PATH_ESCAPE'
  |'BUDGET_EXCEEDED'|'UNKNOWN_SKILL'|'UNAPPROVED'|'REFERENCES'|'SKILL_ROUTE_INPUT'|'SKILL_CATALOGUE_LIMIT'
  |'VIEWPORT_TOOL_UNSUPPORTED'|'VIEWPORT_INVALID'|'VIEWPORT_FAILED'|'VIEWPORT_CAMERA_UNKNOWN'|'BUSY'|'STALE_PROOF'|'BINDING_CHANGED'|'MODE_MISMATCH'
  |'DISCONNECTED'|'TIMEOUT'|'FENCED'|'SDK_CUSTODY_UNCONFIRMED'|'FOREST_SOURCES_REQUIRED'
  |'BLENDER_REQUIRED'|'STUDIO_RECONSTRUCTION_REQUIRED'|'PLUGIN_UPDATE_REQUIRED'|'SESSION';
export interface McpToolFailureSummary {
  readonly schemaVersion:1;readonly kind:'arcane-code'|'mcp-error'|'details-unavailable';readonly tool:McpFailureTool;readonly code:McpToolFailureCode|null;
}
export interface McpToolCallSummary { server: string; tool: string; args: McpToolCallArgs | null; failure?:McpToolFailureSummary }
export type SessionEventValue =
  | { type: 'thread'; threadId: string }
  | { type: 'turn'; threadId: string; turnId: string; status: string; durationMs?: number }
  | { type: 'delta'; threadId: string; turnId: string; itemId: string; text: string }
  | { type: 'item'; threadId: string; turnId: string; itemId: string; itemType: string; status: string | null; tool?: McpToolCallSummary }
  | { type: 'approval'; handle: string; threadId: string; turnId: string }
  | { type: 'approval-cleared'; handle: string }
  | { type: 'account-changed' }
  | { type: 'usage'; threadId: string; turnId: string; usage: NativeTokenUsage }
  | { type: 'error'; threadId: string | null; turnId: string | null; code: string };
export type SessionEvent = SessionEventValue & { seq: number };
export interface Snapshot {
  connectionId: string; provenance: 'installed-cli' | 'spawned-node-fixture';
  mcpIsolation?: 'native-config'|'arcane-only-pending'|'arcane-only-verified'|'proposal-pending'|'proposal-verified';
  connected: boolean; ready: boolean; account: Account | null; models: Model[];
  selection: Selection | null; thread: ThreadState | null; operations: Operation[];
  approvals: Approval[]; events: SessionEvent[]; droppedEvents: number; lastEventSeq: number;
  failureCode: string | null;
  /** Absent until a supported, bounded native usage notification is received. */
  usage?: TokenUsageReport;
  /** Last account-scoped native observation; not a permission or price estimate. */
  rateLimits?: import('./rate-limits.js').NativeRateLimits;
}
export class CodexClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly dispatched = false, public readonly remoteCode: number | null = null) {
    super(message); this.name = 'CodexClientError';
  }
}
/** Internal construction validation; deliberately not exported by the public index. */
export function validateNativeAssetHooks(value: unknown): NativeAssetHooks {
  const names = ['finalCredential', 'dispatched', 'ended', 'retired'];
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.isFrozen(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new CodexClientError('ARGUMENTS', 'Native asset hooks must be an exact frozen own-data callback object.');
  }
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key)) ||
      names.some(name => !Object.hasOwn(descriptors, name) || !Object.hasOwn(descriptors[name]!, 'value') || typeof descriptors[name]!.value !== 'function')) {
    throw new CodexClientError('ARGUMENTS', 'Native asset hooks must be an exact frozen own-data callback object.');
  }
  return value as NativeAssetHooks;
}
