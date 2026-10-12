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
export interface ConnectOptions {
  command: string; cwd: string; use: LocalUse; limits?: LimitOptions; arcaneMcp?: ArcaneMcpLaunchProfile;
}
export interface HumanAction { initiatedBy: 'human' }
export interface Selection { model: string; effort: string }
export interface Model {
  model: string; id: string; displayName: string; efforts: string[];
  defaultEffort: string | null; entitlement: 'unverified';
}
export interface Account {
  auth: 'subscription' | 'signed-out' | 'unsupported';
  plan: string | null; requiresOpenaiAuth: boolean;
}
export type OperationState = 'pending' | 'acknowledged' | 'rejected' | 'unknown' | 'not-sent';
export interface Operation {
  operationId: string; method: 'thread/start' | 'thread/resume' | 'turn/start' | 'turn/interrupt';
  requestId: number | null; threadId: string | null; turnId: string | null;
  state: OperationState; errorCode: string | null;
}
export interface ThreadState {
  threadId: string; sessionId: string | null; selection: Selection; configured: boolean;
  writeGranted: boolean; turnId: string | null;
  turnStatus: 'idle' | 'starting' | 'inProgress' | 'cancelling' | 'completed' | 'failed' | 'interrupted' | 'unknown';
}
export type ApprovalMethod = 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval';
export interface FileChangePreview { path: string; kind: 'add' | 'delete' | 'update'; movePath: string | null; diff: string }
export interface Approval {
  handle: string; connectionId: string; serverRequestId: string | number;
  method: ApprovalMethod; threadId: string; turnId: string; itemId: string;
  reason: string | null; command: string | null; cwd: string | null;
  changes: FileChangePreview[] | null; canAccept: boolean; expiresAt: number;
}
export type SessionEventValue =
  | { type: 'thread'; threadId: string }
  | { type: 'turn'; threadId: string; turnId: string; status: string }
  | { type: 'delta'; threadId: string; turnId: string; itemId: string; text: string }
  | { type: 'item'; threadId: string; turnId: string; itemId: string; itemType: string; status: string | null }
  | { type: 'approval'; handle: string; threadId: string; turnId: string }
  | { type: 'approval-cleared'; handle: string }
  | { type: 'account-changed' }
  | { type: 'error'; threadId: string | null; turnId: string | null; code: string };
export type SessionEvent = SessionEventValue & { seq: number };
export interface Snapshot {
  connectionId: string; provenance: 'installed-cli' | 'spawned-node-fixture';
  mcpIsolation?: 'native-config'|'arcane-only-pending'|'arcane-only-verified';
  connected: boolean; ready: boolean; account: Account | null; models: Model[];
  selection: Selection | null; thread: ThreadState | null; operations: Operation[];
  approvals: Approval[]; events: SessionEvent[]; droppedEvents: number; lastEventSeq: number;
  failureCode: string | null;
}
export class CodexClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly dispatched = false, public readonly remoteCode: number | null = null) {
    super(message); this.name = 'CodexClientError';
  }
}
