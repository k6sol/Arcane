import type { NativeWorkflowModelProof } from '../../../packages/protocol/src/workflow-model.js';
import { DatabaseSync } from 'node:sqlite';
import { sqliteTransportPath } from '../../../packages/storage/src/sqlite-path.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { connectCodexClient, connectCodexProposalWorker, CodexClientError, type CodexClient, type Snapshot, type ArcaneMcpLaunchProfile, type NativeAssetHooks } from '../../../packages/codex-client/src/index.js';
import type { NativeAssetRegistry, NativeAssetIncarnation } from './native-asset-authority.js';
import { locateNativeCli } from '../../../packages/model-adapters/src/process.js';
import { projectMemorySection, readProjectMemory } from '../../../packages/core/src/project-memory.js';
import { learnedPreferenceSection } from '../../../packages/core/src/preference-learning.js';
import { HISTORY_GAP_MARKER, NATIVE_HISTORY_LIMITS, redactNativeHistoryText, type NativeHistoryResult } from '../../../packages/codex-client/src/history.js';
import { ChatTaskCoordinator, ChatTaskProposalError, type ChatTaskProposalFactory } from './chat-task-coordinator.js';
import type { ChatTaskProposalRecord } from '../../../packages/storage/src/chat-task-store.js';
import type { NativeTaskContinuation } from '../../../packages/codex-client/src/types.js';
import type { StudioTestTaskCancellation, StudioTestTaskSettled } from '../../../packages/protocol/src/chat-task-playtest.js';
import {snapshotReferenceImages,referenceImageMetadata,type ReferenceImageMetadata} from '../../../packages/codex-client/src/reference-images.js';
import { WorkStore, type WorkTaskBinding } from '../../../packages/storage/src/work-store.js';
import { CHAT_TASK_PLAN_INPUT_BYTES } from './chat-task-plan-runner.js';
import { createChatTaskNativePlan, type NativePlanClient } from './chat-task-native-plan.js';
import { createTaskAcceptancePort } from './chat-task-acceptance.js';
import { SubmittedChatStore, type SubmittedChatTranscript } from '../../../packages/storage/src/submitted-chat-store.js';
import { TASK_PLAN_REVIEW_TASK_STATES, type TaskPlanView, type TaskPlanReviewView, type TaskPlanReviewTaskState } from '../../../packages/protocol/src/chat-task-plan.js';
import {codexActionFailureEvent,type FailureReporter} from './diagnostic-reporter.js';

const uuid = z.string().uuid();
const identifier = z.string().min(1).max(256).refine(value => !/[\x00-\x1f]/.test(value));
const common = { requestId: uuid, connectionId: uuid };
const imageReferences=z.unknown().transform((value,context)=>{try{return snapshotReferenceImages(value);}catch{context.addIssue({code:'custom',message:'Invalid bounded PNG reference images.'});return z.NEVER;}});
export const codexActionInput = z.discriminatedUnion('action', [
  z.strictObject({ requestId: uuid, connectionId: z.null(), action: z.literal('connect') }),
  z.strictObject({ ...common, action: z.literal('disconnect'), preserveAssetWork: z.boolean().optional() }),
  z.strictObject({ ...common, action: z.literal('select'), model: identifier, effort: identifier.max(64) }),
  z.strictObject({ ...common, action: z.literal('thread-start') }),
  z.strictObject({ ...common, action: z.literal('thread-resume'), threadId: identifier }),
  z.strictObject({ ...common, action: z.literal('history-load'), threadId: identifier }),
  z.strictObject({ ...common, action: z.literal('grant-assets'), threadId: identifier }),
  z.strictObject({ ...common, action: z.literal('revoke-assets'), threadId: identifier }),
  z.strictObject({ ...common, action: z.literal('grant-writes'), threadId: identifier }),
  z.strictObject({ ...common, action: z.literal('revoke-writes'), threadId: identifier }),
  z.strictObject({ ...common, action: z.literal('turn-start'), threadId: identifier, text: z.string().min(1).refine(value => Buffer.byteLength(value) <= 131072), displayText:z.string().min(1).refine(value=>Buffer.byteLength(value)<=131072).optional(), allowAssets: z.boolean().optional(), allowWorkspaceWrites: z.boolean().optional(),references:imageReferences.optional() }),
  z.strictObject({ ...common, action:z.literal('turn-steer'),threadId:identifier,expectedTurnId:identifier,
    text:z.string().min(1).refine(value=>!value.includes('\0')&&Buffer.byteLength(value)<=131072) }),
  z.strictObject({ ...common, action: z.literal('turn-interrupt'), threadId: identifier, turnId: identifier }),
  z.strictObject({ ...common, action: z.literal('task-stop'), threadId: identifier, taskId: uuid }),
  z.strictObject({ ...common, action: z.literal('task-focus'), threadId: identifier, taskId: uuid }),
  // Display-only proposal for the exact owned parent task. Never applied, approved or continued.
  z.strictObject({ ...common, action: z.literal('proposal-start'), threadId: identifier, taskId: uuid, text: z.string().min(1).refine(value => Buffer.byteLength(value) <= 16384) }),
  z.strictObject({ ...common, action: z.literal('approval'), threadId: identifier, turnId: identifier, handle: identifier, decision: z.enum(['accept','decline','cancel']) }),
]);
export type CodexAction = z.infer<typeof codexActionInput>;
export interface CodexActionRecord {
  requestId: string; action: CodexAction['action']; connectionId: string | null;
  state: 'pending' | 'acknowledged' | 'rejected' | 'unknown'; errorCode: string | null;
  threadId: string | null; turnId: string | null; model: string | null; effort: string | null;
  createdAt: string; finishedAt: string | null;
  nextConnectionId?: string;
  references?:readonly ReferenceImageMetadata[];
  /** proposal-start only; such receipts are never listed in the desktop action history. */
  proposalId?: string;
}
/** Display data only: never an acceptance receipt, approval, grant or parent continuation. */
export interface CodexProposalView {
  proposalId: string; requestId: string; state: ChatTaskProposalRecord['state']; reason: ChatTaskProposalRecord['reason'];
  text: string | null; textSha256: string | null; textBytes: number | null; createdAt: string; updatedAt: string;
}
export interface CodexProposalList { taskId: string; display: 'proposal_not_applied'; proposals: CodexProposalView[] }
export interface CodexRecordedHistory {
  requestId: string; connectionId: string; provenance: Snapshot['provenance']; loadedAt: string;
  result: NativeHistoryResult;
}
export interface CodexHistoryState {
  projectPath: string; threadId: string; sessionId: string | null;
  recorded: CodexRecordedHistory | null;
}
export interface CodexSavedThread {
  provider: 'codex'; projectPath: string; threadId: string; sessionId: string | null;
  selection: { model: string; effort: string } | null;
}
export const CODEX_SAVED_THREAD_LIMIT = 256;
const historyIdentifier = identifier.refine(value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) && redactNativeHistoryText(value) === value);
const historyResultSchema = z.strictObject({
  entries: z.array(z.strictObject({ role: z.enum(['user','assistant','tool']), text: z.string().max(NATIVE_HISTORY_LIMITS.maxBytes),
    ids: z.strictObject({ threadId: historyIdentifier, sessionId: historyIdentifier.nullable(), turnId: historyIdentifier, itemId: historyIdentifier }) })).max(NATIVE_HISTORY_LIMITS.maxItems),
  completeness: z.enum(['complete','incomplete','rejected']),
  gaps: z.array(z.strictObject({ reason: z.enum([
    'malformed-response','rpc-error','unsupported-envelope','scope-mismatch','unsupported-history-mode','ephemeral-thread','turns-not-requested',
    'missing-turns','malformed-turn','malformed-item','items-not-full','unsupported-item','non-text-content','context-compaction',
    'unfinished-turn','failed-turn','duplicate-turn','conflicting-item','byte-limit','turn-limit','item-limit',
  ]), turnId: historyIdentifier.optional(), itemId: historyIdentifier.optional() })).max(NATIVE_HISTORY_LIMITS.maxItems + NATIVE_HISTORY_LIMITS.maxTurns + 8),
  truncated: z.boolean(), marker: z.literal(HISTORY_GAP_MARKER).nullable(),
  excludedItems: z.number().int().min(0).max(NATIVE_HISTORY_LIMITS.maxItems), droppedGaps: z.number().int().min(0).max(1_000_000), redacted: z.boolean(),
});
function sanitizeHistory(value: unknown, binding: Pick<CodexHistoryState,'threadId'|'sessionId'>): NativeHistoryResult {
  const parsed = historyResultSchema.safeParse(value);
  if (!parsed.success) throw new CodexClientError('HISTORY_INVALID', 'Invalid bounded native history projection.');
  const result = parsed.data;
  if (result.completeness === 'rejected') throw new CodexClientError('HISTORY_REJECTED', 'Native history scope or contract could not be verified.');
  for (const entry of result.entries) {
    if (entry.ids.threadId !== binding.threadId || (binding.sessionId !== null && entry.ids.sessionId !== binding.sessionId)) throw new CodexClientError('HISTORY_SCOPE','Native history changed its exact binding.');
    const text = redactNativeHistoryText(entry.text); result.redacted ||= text !== entry.text; entry.text = text;
  }
  if (result.completeness === 'incomplete' || result.truncated || result.gaps.length || result.droppedGaps) {
    result.completeness = 'incomplete'; result.marker = HISTORY_GAP_MARKER;
  } else result.marker = null;
  if (Buffer.byteLength(JSON.stringify(result)) > NATIVE_HISTORY_LIMITS.maxBytes) throw new CodexClientError('HISTORY_LIMIT','Native history projection exceeds its storage bound.');
  return result as NativeHistoryResult;
}
export interface CodexProductState {
  provider: 'codex'; use: 'personal-local'; projectPath: string;
  connecting: boolean; closing: boolean; busy: boolean; snapshot: Snapshot | null; lastSnapshot: Snapshot | null;
  nativeAssets?: { available: boolean; sealed: boolean; granted: boolean; admissionOpen: boolean };
  /** Durable local Send receipts. Separate from provider-reported history; never replayed automatically. */
  submittedMessages?: SubmittedChatTranscript;
  workflowModel?: NativeWorkflowModelProof | null; actions: CodexActionRecord[]; nativeHistory?: CodexHistoryState | null; nativeThreads?: CodexSavedThread[]; displayLimited?: true; nativeTools: { configured: boolean; verified: false };
  chatTasks?: { taskId: string; threadId: string; sessionId: string | null; connectionId: string;
    state: string; round: 0 | 1; reason: string | null; reportDigest: string | null;retained?:boolean }[];
}
export interface CodexActionOutcome { record: CodexActionRecord; replayed: boolean; state: CodexProductState }
export type CodexHostClient = Pick<CodexClient, 'snapshot'|'selectModel'|'startThread'|'resumeThread'|'grantThreadWrites'|'revokeThreadWrites'|'startTurn'|'interruptTurn'|'respondApproval'|'close'> & Partial<Pick<CodexClient,'steerTurn'|'readRateLimits'|'readThreadHistory'|'startManagedTask'|'continueTask'|'revokeTaskContinuation'|'taskAccountIdentity'|'openIncorporationChain'|'issueIncorporationPermit'|'continueIncorporation'>>;
export interface CodexServiceOptions {
  directory: string; projectPath: string;
  /** Parent-controlled client factory. Tests use a labelled fixture; never accept it from HTTP input. */
  connect?: (nativeAssetHooks?: NativeAssetHooks) => Promise<CodexHostClient>;
  /** Private project registry only; never accepted from an action envelope. */
  assetRegistry?: NativeAssetRegistry;
  nativeToolsConfigured?: boolean;
  /** Trusted application callback; never use browser supplied paths/tokens. */
  arcaneMcp?: () => ArcaneMcpLaunchProfile;
  /** Trusted composition/fixture proposal worker factory. Injected legacy clients without it gain no proposal authority. */
  proposalWorker?: ChatTaskProposalFactory;
  /** Explicit host opt-in for multi-round planning. Standard chat keeps suggestions on request. */
  automaticTaskPlanning?: boolean;
  /** Borrowed original-project evidence store; never accepted from an action envelope. */
  workStore?: WorkStore;
  /** Trusted host callback: the learned-preference block (<= 600 chars) appended after project memory; never HTTP input. */
  learnedContext?: () => Promise<string>;
  /** Trusted owned-host diagnostics only; never an action envelope or native/agent callback. */
  reportFailure?: FailureReporter;
}
function safeDirectory(path: string): string {
  if (!isAbsolute(path)) throw new CodexClientError('PATH', 'Trusted runtime paths must be absolute.');
  let current = resolve(path);
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) throw new CodexClientError('PATH', 'Runtime paths cannot use links.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  mkdirSync(path, { recursive: true }); return realpathSync(path);
}
function repairPrompt(report: StudioTestTaskSettled): string {
  return `Continue this same human task with one bounded repair attempt. The approved gameplay scenario failed.\n`+
    `Read playtest_status for job ${report.jobId}; settled report digest ${report.reportDigest}; scenario ${report.scenarioDigest}; subjects ${report.subjectDigest}.\n`+
    `Inspect the measured failure and current project before making a focused repair. Then prepare the same bounded scenario once for verification. `+
    `Keep the original model, workspace and permissions. Existing native and playtest approvals still apply. `+
    `Do not publish, upload, purchase, change account settings or request wider permissions. `+
    `If evidence or cleanup is uncertain, explain the remaining issue and stop. This is the only automatic repair attempt.`;
}
/** Durable human action receipts; native conversations remain owned by the actual CLI. */
export function createCodexService(options: CodexServiceOptions) {
  const reportFailure=options.reportFailure;
  const projectPath = realpathSync(options.projectPath);
  if (options.workStore && (!(options.workStore instanceof WorkStore) ||
      (process.platform==='win32'?options.workStore.projectPath.toLowerCase()!==projectPath.toLowerCase():options.workStore.projectPath!==projectPath)))
    throw new CodexClientError('TASK_SCOPE','Task evidence must use the original project WorkStore.');
  const directory = safeDirectory(options.directory);
  const filename = join(directory, 'codex-actions.sqlite');
  try { const stat = lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new CodexClientError('PATH', 'Unsafe native action journal.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(sqliteTransportPath(filename), { timeout: 2000, allowExtension: false });
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version > 3) { db.close(); throw new CodexClientError('MIGRATION', 'Native journal is newer than this build.'); }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS native_history(
      id INTEGER PRIMARY KEY CHECK(id=1), project_path TEXT NOT NULL, thread_id TEXT NOT NULL, session_id TEXT,
      payload TEXT CHECK(payload IS NULL OR length(CAST(payload AS BLOB))<=2113536)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS native_threads(
      project_path TEXT NOT NULL, thread_id TEXT NOT NULL, session_id TEXT, selection TEXT,
      payload TEXT CHECK(payload IS NULL OR length(CAST(payload AS BLOB))<=2113536),
      PRIMARY KEY(project_path,thread_id)
    ) STRICT;
    INSERT OR IGNORE INTO native_threads(project_path,thread_id,session_id,payload)
      SELECT project_path,thread_id,session_id,payload FROM native_history;
    PRAGMA user_version=3;`);
  if(version<3)db.exec(`UPDATE native_threads SET selection=(
    SELECT json_object('model',json_extract(a.payload,'$.model'),'effort',json_extract(a.payload,'$.effort'))
    FROM actions a WHERE json_extract(a.payload,'$.state')='acknowledged'
      AND json_extract(a.payload,'$.threadId')=native_threads.thread_id
      AND json_extract(a.payload,'$.action') IN ('thread-start','thread-resume','select')
      AND json_extract(a.payload,'$.model') IS NOT NULL AND json_extract(a.payload,'$.effort') IS NOT NULL
    ORDER BY a.rowid DESC LIMIT 1) WHERE selection IS NULL;`);
  const submitted = new SubmittedChatStore(db, projectPath, 'codex');
  // A provider handle cannot survive daemon restart. Never redispatch a pending model action.
  for (const row of db.prepare("SELECT id,payload FROM actions WHERE json_extract(payload,'$.state')='pending'").all() as {id:string;payload:string}[]) {
    const record = JSON.parse(row.payload) as CodexActionRecord; record.state = 'unknown'; record.errorCode = 'DAEMON_RESTART'; record.finishedAt = new Date().toISOString();
    db.prepare('UPDATE actions SET payload=? WHERE id=?').run(JSON.stringify(record), row.id);
  }
  submitted.recoverPending(new Date().toISOString());
  let client: CodexHostClient | null = null, lastSnapshot: Snapshot | null = null;
  let connecting = false, closing = false, busy = false, closed = false, generation = 0;
  let pendingTaskBinding=false;
  const planInputs = new Map<string,{objective:string;inputSha256:string}>();
  let pendingConnect: Promise<CodexHostClient> | null = null;
  let tasks:ChatTaskCoordinator|null;
  try{tasks=options.assetRegistry?new ChatTaskCoordinator({directory:join(directory,'chat-tasks'),projectPath}):null;}
  catch(error){db.close();throw error;}
  let saturatedClose: Promise<void> | null = null;
  let journalFault: Promise<void> | null = null;
  const factory = async (nativeAssetHooks?: NativeAssetHooks) => {
    if (options.connect) return options.connect(nativeAssetHooks);
    const command = await locateNativeCli('codex');
    if (!command) throw new CodexClientError('CLI_MISSING', 'The native Codex executable is unavailable.');
    return connectCodexClient({ command, cwd: projectPath, use: 'personal-local', ...(options.arcaneMcp ? { arcaneMcp: options.arcaneMcp() } : {}), ...(nativeAssetHooks ? {nativeAssetHooks} : {}),
      // Project memory (ARCANE.md) is read fresh per thread start/resume and follows the fixed task instructions.
      projectInstructions: async (cwd: string) => projectMemorySection((await readProjectMemory(cwd)).text) + learnedPreferenceSection(await options.learnedContext?.().catch(() => '')) });
  };
  const proposalFactory: ChatTaskProposalFactory | null = options.proposalWorker ?? (options.connect ? null : async input => {
    const command = await locateNativeCli('codex');
    if (!command) throw new CodexClientError('CLI_MISSING', 'The native Codex executable is unavailable.');
    return connectCodexProposalWorker({ command, cwd: projectPath, use: 'personal-local', accountIdentity: input.accountIdentity,
      selection: { model: input.selection.model, effort: input.selection.effort }, owner: input.owner });
  });
  interface HumanAssetIntent { connectionId:string; threadId:string; sessionId:string|null; operationId:string|null }
  interface AssetContext { handle: NativeAssetIncarnation | null; retired: boolean; hooks: NativeAssetHooks; nextIntent:HumanAssetIntent|null;
    actorId: string | null; taskId: string | null; ownerClient: CodexHostClient | null;manualAssets:boolean;manualWrites:boolean }
  let currentAssets: AssetContext | null = null;
  const taskContexts=new Map<string,AssetContext>();
  const retireAssets = (context: AssetContext | null = currentAssets): void => {
    if (!context || context.retired) return; context.nextIntent=null; context.retired = true; context.handle?.retire();
  };
  function newAssets(): AssetContext | null {
    if (!options.assetRegistry) return null;
    const context = {handle:null,retired:false,nextIntent:null,actorId:null,taskId:null,ownerClient:null,manualAssets:false,manualWrites:false} as AssetContext;
    context.hooks = Object.freeze({
      finalCredential(): string {
        if (context.retired || context.handle) throw new CodexClientError('ASSET_AUTHORITY','Native asset launch authority is unavailable.');
        context.handle = options.assetRegistry!.issue();
        const credential = context.handle.credential(); context.actorId = 'agent-'+createHash('sha256').update(credential).digest('hex');
        return credential;
      },
      dispatched(intent) {
        if (!context.handle || context.retired) throw new CodexClientError('ASSET_AUTHORITY','Native asset authority is unavailable.');
        const permission=context.nextIntent;context.nextIntent=null;
        if (context.taskId) tasks!.dispatched(context.taskId, intent.operationId);
        if(permission){
          const snapshot=context.ownerClient?.snapshot(),thread=snapshot?.thread;
          if(currentAssets!==context && !context.taskId || !snapshot || !assetState(snapshot,context).sealed || snapshot.connectionId!==permission.connectionId ||
            intent.connectionId!==permission.connectionId || intent.threadId!==permission.threadId || thread?.threadId!==permission.threadId || thread.sessionId!==permission.sessionId)
            throw new CodexClientError('ASSET_AUTHORITY','Human Send asset scope changed before actual dispatch.');
          context.handle.grantNextIntent({connectionId:permission.connectionId,threadId:permission.threadId,sessionId:permission.sessionId});
        }
        context.handle.dispatched(intent);
        if(permission)permission.operationId=intent.operationId;
      },
      ended(intent) { context.handle?.ended(intent.operationId); if(context.taskId)tasks!.ended(context.taskId,intent.operationId); },
      retired() { retireAssets(context); if(context.taskId)tasks!.uncertain(context.taskId,'native_incarnation_retired'); },
    } satisfies NativeAssetHooks);
    return context;
  }
  function assetState(snapshot: Snapshot | null, context = currentAssets): NonNullable<CodexProductState['nativeAssets']> {
    const status = context?.handle?.status();
    const live = !!status && !status.retired && !context?.retired && snapshot?.connected === true && snapshot.ready === true && snapshot.thread?.configured === true && snapshot.account?.auth === 'subscription' && snapshot.mcpIsolation === 'arcane-only-verified';
    return {available:options.assetRegistry!==undefined,sealed:live&&status!.sealed,granted:live&&status!.granted,admissionOpen:live&&status!.granted&&status!.admissionOpen};
  }
  const history = (): CodexActionRecord[] => (db.prepare("SELECT payload FROM actions WHERE json_extract(payload,'$.action') IS NOT 'proposal-start' ORDER BY rowid DESC LIMIT 100").all() as {payload:string}[]).map(row => JSON.parse(row.payload) as CodexActionRecord);
  function nativeHistory(threadId?: string): CodexHistoryState | null {
    const row = (threadId === undefined
      ? db.prepare('SELECT thread_id,session_id,payload FROM native_history WHERE id=1 AND project_path=?').get(projectPath)
      : db.prepare('SELECT thread_id,session_id,payload FROM native_threads WHERE project_path=? AND thread_id=?').get(projectPath,threadId)) as {thread_id:string;session_id:string|null;payload:string|null}|undefined;
    if (!row) return null;
    if (!historyIdentifier.safeParse(row.thread_id).success || (row.session_id !== null && !historyIdentifier.safeParse(row.session_id).success)) throw new CodexClientError('HISTORY_INVALID','Invalid recorded native binding.');
    const binding = { projectPath, threadId: row.thread_id, sessionId: row.session_id };
    if (row.payload === null) return { ...binding, recorded: null };
    if (Buffer.byteLength(row.payload) > NATIVE_HISTORY_LIMITS.maxBytes + 16384) throw new CodexClientError('HISTORY_LIMIT','Recorded native history exceeds its bound.');
    let raw: unknown; try { raw = JSON.parse(row.payload); } catch { throw new CodexClientError('HISTORY_INVALID','Invalid recorded native history.'); }
    const parsed = z.strictObject({ requestId: uuid, connectionId: uuid, provenance: z.enum(['installed-cli','spawned-node-fixture']), loadedAt: z.string().datetime(), result: z.unknown() }).safeParse(raw);
    if (!parsed.success) throw new CodexClientError('HISTORY_INVALID','Invalid recorded native history metadata.');
    return { ...binding, recorded: { ...parsed.data, result: sanitizeHistory(parsed.data.result, binding) } };
  }
  function savedThreads(): CodexSavedThread[] {
    const rows = db.prepare('SELECT thread_id,session_id,selection FROM native_threads WHERE project_path=? ORDER BY rowid DESC LIMIT ?').all(projectPath,CODEX_SAVED_THREAD_LIMIT+1) as {thread_id:string;session_id:string|null;selection:string|null}[];
    if (rows.length > CODEX_SAVED_THREAD_LIMIT) throw new CodexClientError('HISTORY_LIMIT','Saved chat catalogue exceeds its bound.');
    return rows.map(row => {
      if (!historyIdentifier.safeParse(row.thread_id).success || row.session_id !== null && !historyIdentifier.safeParse(row.session_id).success) throw new CodexClientError('HISTORY_INVALID','Invalid saved chat identity.');
      let selection: CodexSavedThread['selection'] = null;
      if (row.selection !== null) {
        try { selection = z.strictObject({model:identifier.refine(value=>redactNativeHistoryText(value)===value),effort:identifier.max(64).refine(value=>redactNativeHistoryText(value)===value)}).parse(JSON.parse(row.selection)); }
        catch { throw new CodexClientError('HISTORY_INVALID','Invalid saved chat selection.'); }
      }
      return {provider:'codex',projectPath,threadId:row.thread_id,sessionId:row.session_id,selection};
    });
  }
  function state(): CodexProductState {
    if (closed) throw new CodexClientError('CLOSED', 'Native workflow is closed.');
    const snapshot=client?.snapshot()??null;
    const recordedHistory=nativeHistory(), submittedScope=snapshot?.thread?.configured?snapshot.thread:recordedHistory;
    return { provider:'codex', use:'personal-local', projectPath, connecting, closing, busy,
      snapshot, lastSnapshot:lastSnapshot ? structuredClone(lastSnapshot) : null,
      ...(options.assetRegistry ? {nativeAssets:assetState(snapshot)} : {}),
      ...(tasks?.configured() ? {chatTasks:tasks.summaries().map(({id,...task})=>{const context=taskContexts.get(id);return{taskId:id,...task,retained:!!context?.ownerClient&&!context.retired};})} : {}),
      actions:history(), nativeHistory:recordedHistory, nativeThreads:savedThreads(), ...(submittedScope?{submittedMessages:submitted.read(submittedScope)}:{}), nativeTools:{configured:options.arcaneMcp !== undefined || options.nativeToolsConfigured === true,verified:false} };
  }
  const save = (record: CodexActionRecord) => {
    db.prepare('UPDATE actions SET payload=? WHERE id=?').run(JSON.stringify(record),record.requestId);
    if(record.action==='turn-start'||record.action==='turn-steer')submitted.finish(record.requestId,{turnId:record.turnId,model:record.model,effort:record.effort,
      state:record.state,finishedAt:record.finishedAt,errorCode:record.errorCode});
  };
  const exactClient = (connectionId: string): CodexHostClient => {
    if (!client || client.snapshot().connectionId !== connectionId) throw new CodexClientError('STALE_CONNECTION','Choose the exact current native connection.');
    return client;
  };
  /** Fence before fallible cleanup: a broken journal cannot leave live native authority. */
  function fenceJournalFailure(): Promise<void> {
    tasks?.fence();try{retireAssets();}catch{/* Still stop every owned native client. */}
    if (journalFault) return journalFault;
    generation++; closing = true;
    const owned = client; client = null;
    journalFault = (async () => {
      try { await tasks?.stopAll('native_journal_failure'); }
      catch { /* Authority is already retired; cleanup cannot restore it. */ }
      finally { try{if(owned){try{lastSnapshot=owned.snapshot();}catch{/* No trusted snapshot. */}await owned.close();}}finally{closing=false;} }
    })();
    return journalFault;
  }
  const inFlight = new Set<Promise<CodexActionOutcome>>();
  async function runAction(input: unknown): Promise<CodexActionOutcome> {
    if (closed) throw new CodexClientError('CLOSED','Native workflow is closed.');
    if (journalFault) throw new CodexClientError('JOURNAL_FAILURE','Native journal failed. Restart only after reviewing retained receipts; no action was retried.');
    const parsed = codexActionInput.safeParse(input);
    if (!parsed.success) throw new CodexClientError('ARGUMENTS','Supply an exact bounded native action envelope.');
    const value = parsed.data;
    const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    let prior: {hash:string;payload:string}|undefined, count: number;
    try { prior = db.prepare('SELECT hash,payload FROM actions WHERE id=?').get(value.requestId) as typeof prior; count = Number((db.prepare('SELECT count(*) AS n FROM actions').get() as {n:number}).n); }
    catch { await fenceJournalFailure(); throw new CodexClientError('JOURNAL_FAILURE','Native journal read failed. Authority retired; inspect retained receipts.',true); }
    if (prior) {
      if (prior.hash !== hash) throw new CodexClientError('IDEMPOTENCY','This request ID already identifies a different action.');
      return {record:JSON.parse(prior.payload) as CodexActionRecord,replayed:true,state:state()};
    }
    if (count >= 4096) {
      if(value.action==='turn-steer')throw new CodexClientError('JOURNAL_LIMIT','The steering journal is full. No amendment was dispatched; the original turn remains active.');
      // Exhaustion cannot leave a write-granted client running without stop controls.
      // Fence immediately, preserve existing request identities, and dispatch no
      // refused model action. Further work needs offline journal reconciliation.
      saturatedClose ??= (async () => {
        generation++; closing = true;tasks?.fence();try{retireAssets();}catch{/* Still stop every owned native client. */}
        const owned = client; client = null;
        try { await tasks?.stopAll('native_journal_limit'); }
        finally {try{if(owned){lastSnapshot=owned.snapshot();await owned.close();lastSnapshot=owned.snapshot();}}finally{closing=false;} }
      })();
      await saturatedClose;
      throw new CodexClientError('JOURNAL_LIMIT','The full native journal fenced the connection. Stop Arcane and archive its journal before reconnecting; old requests were not discarded or replayed.');
    }
    const record: CodexActionRecord = {requestId:value.requestId,action:value.action,connectionId:value.connectionId,state:'pending',errorCode:null,
      threadId:'threadId' in value ? value.threadId:null,turnId:value.action==='turn-steer'?value.expectedTurnId:'turnId' in value ? value.turnId:null,
      model:value.action==='select'?value.model:null,effort:value.action==='select'?value.effort:null,createdAt:new Date().toISOString(),finishedAt:null};
    if(value.action==='turn-start'&&value.references)record.references=referenceImageMetadata(value.references);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO actions(id,hash,payload) VALUES(?,?,?)').run(record.requestId,hash,JSON.stringify(record));
      const thread=client?.snapshot().thread;
      if(value.action==='turn-start'&&thread?.configured&&thread.threadId===value.threadId)
        submitted.put(thread,{requestId:value.requestId,turnId:null,text:value.displayText??value.text,model:thread.selection.model,effort:thread.selection.effort,
          state:'pending',createdAt:record.createdAt,finishedAt:null,errorCode:null,contextIncluded:value.displayText!==undefined&&value.displayText!==value.text,transmittedBytes:Buffer.byteLength(value.text)});
      if(value.action==='turn-steer'&&client?.snapshot().connectionId===value.connectionId&&thread?.configured&&thread.threadId===value.threadId&&thread.turnId===value.expectedTurnId)
        submitted.put(thread,{kind:'steer',requestId:value.requestId,turnId:value.expectedTurnId,text:value.text,model:thread.selection.model,effort:thread.selection.effort,
          state:'pending',createdAt:record.createdAt,finishedAt:null,errorCode:null,contextIncluded:false,transmittedBytes:Buffer.byteLength(value.text)});
      db.exec('COMMIT');
    } catch { try{db.exec('ROLLBACK');}catch{/* The original journal failure remains authoritative. */}
      await fenceJournalFailure(); throw new CodexClientError('JOURNAL_FAILURE','Native action receipt could not be persisted. Authority retired; no retry.',true); }
    let epoch = generation;
    let stagedHistory: CodexHistoryState | null = null;
    let ownsBusy = false,ownsTaskBinding=false; const existingOperations = new Set<string>();
    let actionClient: CodexHostClient | null = null;
    let grantAssetsAfterCommit: (() => void) | null = null;
    let taskAfterCommit: string | null = null;
    const operationMethod = ({ 'thread-start':'thread/start', 'thread-resume':'thread/resume', 'turn-start':'turn/start', 'turn-steer':'turn/steer', 'turn-interrupt':'turn/interrupt' } as Record<string,string>)[value.action] ?? null;
    try {
      if(tasks?.configured()&&!tasks.available()&&!['disconnect','task-stop','turn-interrupt','revoke-writes','revoke-assets'].includes(value.action)&&!(value.action==='approval'&&value.decision!=='accept'))
        throw new CodexClientError('CLOSED','Managed task admission has been fenced. No new native work was sent.');
      if (value.action === 'connect') {
        if (client || connecting || closing || busy || pendingConnect) throw new CodexClientError('BUSY','Disconnect the previous native connection before connecting.');
        connecting = true;
        try {
          const context = newAssets();
          pendingConnect = factory(context?.hooks);
          let connected: CodexHostClient;
          try { connected = await pendingConnect; } catch(error) { retireAssets(context); throw error; }
          if (closed || generation !== epoch) { retireAssets(context); await connected.close(); throw new CodexClientError('STALE_CONNECTION','Connection was cancelled before acknowledgement.'); }
          client = connected; currentAssets = context; lastSnapshot = null; record.connectionId = connected.snapshot().connectionId;
          if(context)context.ownerClient=connected;
        } finally { connecting = false; pendingConnect = null; }
      } else {
        let selected = exactClient(value.connectionId); actionClient = selected;
        for (const operation of selected.snapshot().operations) existingOperations.add(operation.operationId);
        if (value.action === 'disconnect') {
          // Chat navigation retires the provider connection while preserving
          // already accepted asynchronous asset jobs. The explicit Disconnect
          // gesture (absent/false flag) stops owned work as well.
          const context=currentAssets,taskId=context?.taskId,thread=selected.snapshot().thread,preserve=value.preserveAssetWork===true&&!!taskId&&tasks!.owns(taskId);
          generation++; closing = true; lastSnapshot = selected.snapshot(); client = null;
          if(preserve){currentAssets=null;closing=false;} // Task retains its exact client; no new tab can borrow it.
          else try {if(value.preserveAssetWork!==true&&thread)await tasks?.cancelFor(thread.threadId,thread.sessionId,'human_disconnected');}
          finally {try{if(value.preserveAssetWork!==true)context?.handle?.cancelWork('incarnation');}
            finally{try{retireAssets(context);}finally{try{await selected.close();lastSnapshot=selected.snapshot();}finally{currentAssets=null;closing=false;}}}}
        } else {
          // Cancellation and revocation fence immediately even while a normal request awaits its acknowledgement.
          const safety = value.action === 'turn-interrupt' || value.action === 'task-stop' || value.action === 'revoke-writes' || value.action === 'revoke-assets' || value.action === 'approval';
          if (closing || connecting || (busy && !safety)) throw new CodexClientError('BUSY','A native action is still awaiting acknowledgement.');
          if (!safety) { busy = true; ownsBusy = true; }
          if (value.action === 'thread-start' || value.action === 'thread-resume') {
            const snapshot = selected.snapshot();
            if (!snapshot.connected || !snapshot.ready || snapshot.thread || snapshot.approvals.length || snapshot.operations.some(op=>op.state==='pending'||op.state==='unknown')) throw new CodexClientError('BUSY','Opening a chat requires an idle connection with no thread, approvals or unresolved operation.');
          }
          switch (value.action) {
            case 'task-focus': {
              const binding=nativeHistory(value.threadId),context=taskContexts.get(value.taskId),owned=context?.ownerClient,snapshot=owned?.snapshot(),current=selected.snapshot();
              if(!tasks?.available()||!binding||!context||context.retired||!owned||!snapshot?.connected||!snapshot.ready||!snapshot.thread?.configured||
                !tasks.belongs(value.taskId,binding.threadId,binding.sessionId)||snapshot.thread.threadId!==binding.threadId||snapshot.thread.sessionId!==binding.sessionId)
                throw new CodexClientError('TASK_SCOPE','Focus only the exact retained native task in this saved conversation.');
              if(owned!==selected){
                if(current.approvals.length||current.operations.some(op=>op.state==='pending'||op.state==='unknown')||current.thread&&(!['idle','completed','failed','interrupted'].includes(current.thread.turnStatus)||current.thread.writeGranted)||assetState(current).granted)
                  throw new CodexClientError('BUSY','The selected conversation must settle before focusing another task.');
                pendingTaskBinding=true;ownsTaskBinding=true;
                record.nextConnectionId=snapshot.connectionId;try{save(record);}catch{await fenceJournalFailure();throw new CodexClientError('JOURNAL_FAILURE','Task selection could not be recorded. No task was dispatched.');}
                const previous=currentAssets;
                if(!previous?.taskId){try{retireAssets(previous);}finally{await selected.close();}}
                const stillOwned=owned.snapshot();
                if(closed||generation!==epoch||!tasks.available()||context.retired||!stillOwned.connected||!stillOwned.ready||stillOwned.connectionId!==snapshot.connectionId||stillOwned.thread?.threadId!==binding.threadId||stillOwned.thread.sessionId!==binding.sessionId)
                  throw new CodexClientError('STALE_CONNECTION','Task focus was cancelled before exact selection.');
                client=owned;currentAssets=context;selected=owned;actionClient=owned;lastSnapshot=null;
              }
              stagedHistory=binding;
              break;
            }
            case 'select': {
              selected.selectModel({initiatedBy:'human',model:value.model,effort:value.effort});
              const thread=selected.snapshot().thread;if(thread)await tasks?.cancelFor(thread.threadId,thread.sessionId,'human_changed_model');break;
            }
            case 'thread-start': {
              if (savedThreads().length >= CODEX_SAVED_THREAD_LIMIT) throw new CodexClientError('HISTORY_LIMIT','Saved chats are full; retained history was not deleted.');
              await selected.startThread({initiatedBy:'human'}); break;
            }
            case 'thread-resume': {
              const owned = nativeHistory(value.threadId);
              if (!owned) throw new CodexClientError('HISTORY_SCOPE','Resume only a saved native thread owned by this project.');
              await selected.resumeThread({initiatedBy:'human',threadId:owned.threadId});
              const resumed = selected.snapshot().thread;
              if (!resumed || resumed.threadId !== owned.threadId || resumed.sessionId !== owned.sessionId || resumed.writeGranted) {
                retireAssets();
                await selected.close();
                throw new CodexClientError('HISTORY_SCOPE','Resumed native identity or permissions changed; inspect recorded state.',true);
              }
              break;
            }
            case 'history-load': {
              const binding = nativeHistory(), current = selected.snapshot().thread;
              if (!binding || binding.threadId !== value.threadId || (current && (current.threadId !== binding.threadId || (binding.sessionId !== null && current.sessionId !== binding.sessionId)))) throw new CodexClientError('HISTORY_SCOPE','Choose only the recorded current native thread for this project.');
              if (!selected.readThreadHistory) throw new CodexClientError('HISTORY_UNAVAILABLE','This native client has no public history reader.');
              const result = sanitizeHistory(await selected.readThreadHistory({ initiatedBy:'human', threadId:binding.threadId, ...(binding.sessionId === null ? {} : {sessionId:binding.sessionId}) }), binding);
              stagedHistory = { ...binding, recorded: { requestId:value.requestId, connectionId:value.connectionId, provenance:selected.snapshot().provenance, loadedAt:new Date().toISOString(), result } };
              break;
            }
            case 'grant-assets': {
              const snapshot = selected.snapshot(), thread = snapshot.thread, authority = currentAssets?.handle;
              if (!authority || currentAssets?.retired || !authority.status().sealed || !snapshot.connected || !snapshot.ready || snapshot.account?.auth !== 'subscription' || !thread?.configured || thread.threadId !== value.threadId)
                throw new CodexClientError('ASSET_AUTHORITY','Choose the exact live sealed native asset chat.');
              // Permission is applied only after the human action's durable commit.
              const context=currentAssets;
              grantAssetsAfterCommit = () => {authority.grant({connectionId:value.connectionId,threadId:value.threadId});if(context)context.manualAssets=true;}; break;
            }
            case 'revoke-assets': {
              const snapshot = selected.snapshot();
              if (!currentAssets?.handle || snapshot.thread?.threadId !== value.threadId) throw new CodexClientError('ASSET_AUTHORITY','Choose the exact native asset chat.');
              if(pendingTaskBinding)epoch=++generation;
              const context=currentAssets,stopped=tasks?.cancelFor(snapshot.thread.threadId,snapshot.thread.sessionId,'human_revoked_assets');
              try{context.nextIntent=null;context.manualAssets=false;context.handle!.cancelWork('incarnation');context.handle!.revokeGrant();}
              finally{if(stopped)await stopped;}break;
            }
            case 'grant-writes': selected.grantThreadWrites({initiatedBy:'human',threadId:value.threadId});if(currentAssets)currentAssets.manualWrites=true; break;
            case 'revoke-writes': {
              // Validate scope before touching owned workers. Cancellation must
              // precede fallible native cleanup, including approval-delivery IO.
              if (selected.snapshot().thread?.threadId!==value.threadId) throw new CodexClientError('THREAD','Choose the exact native chat to revoke.');
              if(pendingTaskBinding)epoch=++generation;
              const context=currentAssets;if(context){context.nextIntent=null;context.manualWrites=false;}
              const thread=selected.snapshot().thread!;
              const stopped=tasks?.cancelFor(thread.threadId,thread.sessionId,'human_revoked_writes');
              try {context?.handle?.cancelWork('incarnation');if(!stopped||selected.snapshot().connected)selected.revokeThreadWrites({initiatedBy:'human',threadId:value.threadId});}
              finally {if(stopped)await stopped;}
              break;
            }
            case 'turn-start': {
              // Explicit trusted test/host injections may implement the legacy
              // client only. They gain no managed task origin or repair claim.
              const injectedLegacy=options.connect!==undefined&&(!selected.startManagedTask||!selected.continueTask||!selected.revokeTaskContinuation||!selected.taskAccountIdentity);
              const managed = tasks?.available() === true&&!injectedLegacy;
              let allowWrites = value.allowWorkspaceWrites === true;
              let allowAssets=value.allowAssets===true;
              let taskAccount:string|null=null;
              if(managed) {
                const original=selected.snapshot(),thread=original.thread,context=currentAssets;
                if(!thread?.configured || thread.threadId!==value.threadId || !original.connected || !original.ready || original.approvals.length ||
                  original.operations.some(op=>op.state==='unknown') || !context?.handle || !context.actorId || !assetState(original,context).sealed ||
                  !selected.startManagedTask || !selected.continueTask || !selected.revokeTaskContinuation)
                  throw new CodexClientError('TASK_SCOPE','Managed Send requires the exact attested native chat.');
                allowWrites ||= context.manualWrites;allowAssets ||= context.manualAssets;
                const rotate=!!context.taskId || original.operations.some(op=>op.method==='turn/start');
                const identity=selected.taskAccountIdentity?.()??null;
                if(!identity)throw new CodexClientError('ACCOUNT_IDENTITY','Native account identity is unavailable for an exact managed task.');
                taskAccount=identity;
                pendingTaskBinding=true;ownsTaskBinding=true;
                await tasks!.cancelFor(thread.threadId,thread.sessionId,'human_followup_superseded');
                if(closed||generation!==epoch)throw new CodexClientError('STALE_CONNECTION','Human task was cancelled before dispatch.');
                if(rotate) {
                  // Fresh process/profile, never assumed MCP hot reload. Resume
                  // uses the exact acknowledged native thread under this Send.
                  context.nextIntent=null;context.handle.cancelWork('incarnation');retireAssets(context);await selected.close();
                  if(closed||generation!==epoch)throw new CodexClientError('STALE_CONNECTION','Human task was cancelled before fresh initialization.');
                  const freshContext=newAssets()!;
                  let fresh:CodexHostClient|null=null;
                  try {
                    pendingConnect=factory(freshContext.hooks);fresh=await pendingConnect;freshContext.ownerClient=fresh;
                    if(closed || generation!==epoch || fresh.taskAccountIdentity?.()!==identity)throw new CodexClientError('ACCOUNT_IDENTITY','Fresh task account changed or its identity is unavailable.');
                    fresh.selectModel({initiatedBy:'human',...thread.selection});
                    await fresh.resumeThread({initiatedBy:'human',threadId:thread.threadId});
                    if(closed||generation!==epoch||!tasks!.available())throw new CodexClientError('STALE_CONNECTION','Human task was cancelled before resumed authority binding.');
                    const resumed=fresh.snapshot(),binding=resumed.thread;
                    if(!resumed.connected || !resumed.ready || resumed.mcpIsolation!=='arcane-only-verified' || !binding?.configured || binding.threadId!==thread.threadId || binding.sessionId!==thread.sessionId || binding.writeGranted ||
                      binding.selection.model!==thread.selection.model || binding.selection.effort!==thread.selection.effort)
                      throw new CodexClientError('TASK_SCOPE','Fresh task resume changed its native identity or policy.',true);
                    freshContext.handle!.seal({connectionId:resumed.connectionId,provider:'codex',threadId:binding.threadId,sessionId:binding.sessionId});
                    record.nextConnectionId=resumed.connectionId;
                    try{save(record);}catch{await fenceJournalFailure();throw new CodexClientError('JOURNAL_FAILURE','Fresh task binding could not be persisted. No task turn was sent.');}
                    client=fresh;currentAssets=freshContext;selected=fresh;actionClient=fresh;
                    if(context.manualAssets){freshContext.handle!.grant({connectionId:resumed.connectionId,threadId:thread.threadId});freshContext.manualAssets=true;}
                    if(context.manualWrites){fresh.grantThreadWrites({initiatedBy:'human',threadId:thread.threadId});freshContext.manualWrites=true;}
                  } catch(error) {retireAssets(freshContext);if(fresh)await fresh.close();throw error;}
                  finally {pendingConnect=null;}
                }
              }
              const context=currentAssets,authority=context?.handle;
              let permission:HumanAssetIntent|null=null,accepted=false;
              // Only this existing human-control action can arm the next actual
              // dispatch. Never forward allowAssets to the provider/model API.
              if((managed?allowAssets:value.allowAssets===true) && options.assetRegistry){
                const snapshot=selected.snapshot(),thread=snapshot.thread;
                if(!context || !authority || !assetState(snapshot).sealed || !thread?.configured || thread.threadId!==value.threadId)
                  throw new CodexClientError('ASSET_AUTHORITY','Choose the exact live sealed native asset chat.');
                permission={connectionId:snapshot.connectionId,threadId:value.threadId,sessionId:thread.sessionId,operationId:null};
                context.nextIntent=permission;
              }
              try {if(managed) {
                const owned=selected,ownedContext=context!,taskId=randomUUID();let continuation:NativeTaskContinuation|null=null;
                // identity was captured before any fresh-process rotation; the getter reads the exact owned client live.
                const origin=tasks!.begin({id:taskId,actorId:ownedContext.actorId!,snapshot:owned.snapshot(),allowWorkspaceWrites:allowWrites,allowAssets,accountIdentity:taskAccount!,
                  owner:{snapshot:()=>owned.snapshot(),accountIdentity:()=>owned.taskAccountIdentity?.()??null,revoke:()=>{ownedContext.nextIntent=null;owned.revokeTaskContinuation!();},
                    plan:scope=>{
                      if(!continuation||!owned.openIncorporationChain||!owned.issueIncorporationPermit||!owned.continueIncorporation)throw new CodexClientError('TASK_SCOPE','Original native parent planning is unavailable.');
                      const task=tasks!.list().find(value=>value.id===taskId)!;
                      if(!task.operationId||!task.turnId||!task.acknowledged)throw new CodexClientError('TASK_SCOPE','The original task acknowledgement is unavailable.');
                      const native=createChatTaskNativePlan({client:owned as NativePlanClient,continuation,owner:scope,original:{connectionId:task.connectionId,
                        threadId:task.threadId,sessionId:task.sessionId,accountIdentity:taskAccount!,model:task.model,effort:task.effort,
                        allowWorkspaceWrites:task.allowWorkspaceWrites,operationId:task.operationId,turnId:task.turnId}});
                      return Object.freeze({waitForInitial:()=>native.waitForInitial(),incorporate:async(text:string,acknowledge:(value:{operationId:string;turnId:string})=>void)=>{
                        scope.assertActive();const snapshot=owned.snapshot(),thread=snapshot.thread!;
                        if(!task.allowAssets&&ownedContext.manualAssets)throw new CodexClientError('TASK_SCOPE','Task asset scope cannot expand after the original Send.');
                        if(task.allowAssets)ownedContext.nextIntent={connectionId:snapshot.connectionId,threadId:thread.threadId,sessionId:thread.sessionId,operationId:null};
                        try{return await native.incorporate(text,acknowledge);}finally{ownedContext.nextIntent=null;}
                      }});
                    },
                    repair:async(report:StudioTestTaskSettled)=>{
                      if(!continuation)throw new CodexClientError('TASK_SCOPE','Original task continuation is unavailable.');
                      const snapshot=owned.snapshot(),thread=snapshot.thread!;
                      if(!allowAssets&&ownedContext.manualAssets)throw new CodexClientError('TASK_SCOPE','Task asset scope cannot expand after the original Send.');
                      if(allowAssets)ownedContext.nextIntent={connectionId:snapshot.connectionId,threadId:thread.threadId,sessionId:thread.sessionId,operationId:null};
                      try {await owned.continueTask!({continuation,text:repairPrompt(report)});}
                      finally {ownedContext.nextIntent=null;}
                    },cancel:async()=>{ownedContext.nextIntent=null;
                      try{ownedContext.handle?.cancelWork('incarnation');}
                      finally{try{retireAssets(ownedContext);}finally{
                        if(client===owned&&!busy){lastSnapshot=owned.snapshot();client=null;currentAssets=null;}await owned.close();}}
                    }
                  }});
                ownedContext.taskId=origin.taskId;taskContexts.set(origin.taskId,ownedContext);taskAfterCommit=taskId;
                if(options.automaticTaskPlanning===true&&options.workStore&&proposalFactory&&owned.openIncorporationChain&&owned.issueIncorporationPermit&&owned.continueIncorporation&&Buffer.byteLength(value.text)<=CHAT_TASK_PLAN_INPUT_BYTES)
                  planInputs.set(taskId,{objective:value.text,inputSha256:createHash('sha256').update(JSON.stringify({text:value.text,
                    references:value.references?referenceImageMetadata(value.references):[],allowWorkspaceWrites:allowWrites,allowAssets})).digest('hex')});
                try {const started=await owned.startManagedTask!({initiatedBy:'human',threadId:value.threadId,text:value.text,allowWorkspaceWrites:allowWrites,...(value.references?{references:value.references}:{})});continuation=started.continuation;accepted=true;}
                catch(error){const uncertain=error instanceof CodexClientError&&error.dispatched&&error.code!=='REMOTE_REJECTED'||owned.snapshot().operations.some(op=>op.method==='turn/start'&&op.state==='unknown');
                  tasks!.uncertain(taskId,'initial_turn_not_replayed',uncertain);throw error;}
              } else {await selected.startTurn({initiatedBy:'human',threadId:value.threadId,text:value.text,
                ...(value.allowWorkspaceWrites===undefined?{}:{allowWorkspaceWrites:value.allowWorkspaceWrites}),...(value.references?{references:value.references}:{})});accepted=true;}}
              finally {
                if(permission && context?.nextIntent===permission)context.nextIntent=null;
                if(!accepted && permission?.operationId && authority){
                  try {authority.ended(permission.operationId);} catch {retireAssets(context);}
                }
              }
              break;
            }
            case 'turn-steer': {
              const snapshot=selected.snapshot(),thread=snapshot.thread;
              if(!snapshot.connected||!snapshot.ready||!thread?.configured||thread.threadId!==value.threadId||thread.turnId!==value.expectedTurnId||thread.turnStatus!=='inProgress'||
                snapshot.operations.some(operation=>operation.state==='pending'||operation.state==='unknown'))
                throw new CodexClientError('STATE','Steer only the exact active acknowledged native turn.');
              if(!selected.steerTurn)throw new CodexClientError('STEER_UNSUPPORTED','This native client does not expose turn steering. No new turn was started.');
              const sessionId=thread.sessionId,selection={...thread.selection};
              const acknowledgement=await selected.steerTurn({initiatedBy:'human',threadId:value.threadId,expectedTurnId:value.expectedTurnId,text:value.text,clientUserMessageId:value.requestId});
              const current=selected.snapshot(),active=current.thread;
              if(client!==selected||generation!==epoch||current.connectionId!==value.connectionId||!current.connected||!current.ready||!active?.configured||
                active.threadId!==value.threadId||active.sessionId!==sessionId||active.turnId!==value.expectedTurnId||active.turnStatus!=='inProgress'||
                active.selection.model!==selection.model||active.selection.effort!==selection.effort||acknowledgement.turnId!==value.expectedTurnId)
                throw new CodexClientError('STEER_SCOPE_CHANGED','The original native turn changed before the steering acknowledgement could be committed.',true);
              record.turnId=acknowledgement.turnId;break;
            }
            case 'turn-interrupt': {
              const snapshot=selected.snapshot(),thread=snapshot.thread;
              if (!snapshot.connected || !snapshot.ready || !thread?.configured || thread.threadId!==value.threadId ||
                thread.turnId!==value.turnId || !['starting','inProgress'].includes(thread.turnStatus))
                throw new CodexClientError('STATE','Select the exact active native turn to stop.');
              if(pendingTaskBinding)epoch=++generation;
              const context=currentAssets,stopped=context?.taskId?tasks!.cancel(context.taskId,'human_interrupted'):null;
              try{context?.handle?.cancelWork('active-operation');if(!stopped)await selected.interruptTurn({initiatedBy:'human',threadId:value.threadId,turnId:value.turnId});}
              finally{if(stopped)await stopped;}break;
            }
            case 'task-stop': {
              const thread=selected.snapshot().thread;
              if(!thread || thread.threadId!==value.threadId || !tasks?.belongs(value.taskId,thread.threadId,thread.sessionId))
                throw new CodexClientError('TASK_SCOPE','Stop only the owned task in this exact native conversation.');
              await tasks.cancel(value.taskId,'human_stopped_task');break;
            }
            case 'proposal-start': {
              const thread=selected.snapshot().thread;
              if(!proposalFactory || !thread?.configured || thread.threadId!==value.threadId || !tasks?.belongs(value.taskId,thread.threadId,thread.sessionId))
                throw new CodexClientError('TASK_SCOPE','Propose only for the owned task in this exact native conversation.');
              try {record.proposalId=tasks.startProposal({taskId:value.taskId,requestId:value.requestId,text:value.text,factory:proposalFactory}).id;}
              catch(error){if(error instanceof ChatTaskProposalError)throw new CodexClientError(error.code,error.message);throw error;}
              break;
            }
            case 'approval': selected.respondApproval({initiatedBy:'human',connectionId:value.connectionId,threadId:value.threadId,turnId:value.turnId,handle:value.handle,decision:value.decision}); break;
          }
          if (closed || generation !== epoch) throw new CodexClientError('STALE_CONNECTION','Native lifecycle changed while awaiting acknowledgement.',true);
          const snapshot = selected.snapshot(); const thread = snapshot.thread;
          if(value.action!=='turn-steer'){record.threadId = thread?.threadId ?? record.threadId; record.turnId = thread?.turnId ?? record.turnId;}
          record.model = snapshot.selection?.model ?? null; record.effort = snapshot.selection?.effort ?? null;
          if (value.action === 'thread-start' || value.action === 'thread-resume') {
            if (!thread?.configured || thread.writeGranted || !snapshot.connected || !snapshot.ready || !historyIdentifier.safeParse(thread.threadId).success || (thread.sessionId !== null && !historyIdentifier.safeParse(thread.sessionId).success)) throw new CodexClientError('HISTORY_SCOPE','Native acknowledgement lacks a valid read-only durable binding.',true);
            const previous = nativeHistory(thread.threadId);
            if (previous && previous.sessionId !== thread.sessionId) throw new CodexClientError('HISTORY_SCOPE','Native thread acknowledgement changed its saved session identity.',true);
            stagedHistory = { projectPath, threadId:thread.threadId, sessionId:thread.sessionId,
              recorded:previous?.threadId === thread.threadId && previous.sessionId === thread.sessionId ? previous.recorded : null };
          }
        }
      }
      record.state = 'acknowledged';
    } catch (error) {
      const known = error instanceof CodexClientError;
      record.errorCode = known ? error.code : 'NATIVE_ERROR';
      const snapshot = actionClient?.snapshot();
      const pending = operationMethod ? snapshot?.operations.findLast(operation => operation.method===operationMethod && !existingOperations.has(operation.operationId) && operation.state==='unknown') : undefined;
      const uncertain = value.action !== 'history-load' && ((known && error.dispatched && error.code!=='REMOTE_REJECTED') || pending !== undefined);
      record.state = uncertain ? 'unknown':'rejected';
      if (uncertain&&value.action!=='turn-steer') retireAssets();
      // Never borrow another action's unknown operation or overwrite refused scope.
      if (uncertain&&value.action!=='turn-steer') {
        record.threadId = pending?.threadId ?? snapshot?.thread?.threadId ?? record.threadId;
        record.turnId = pending?.turnId ?? snapshot?.thread?.turnId ?? record.turnId;
        record.model = snapshot?.selection?.model ?? record.model; record.effort = snapshot?.selection?.effort ?? record.effort;
      }
    } finally {
      if(ownsTaskBinding)pendingTaskBinding=false;
      if (ownsBusy) {busy = false;if(client&&currentAssets?.taskId&&currentAssets.retired&&!client.snapshot().connected){lastSnapshot=client.snapshot();client=null;currentAssets=null;}}
      record.finishedAt = new Date().toISOString();
      let transaction = false;
      try {
        db.exec('BEGIN IMMEDIATE'); transaction = true;
        if (record.state === 'acknowledged' && stagedHistory) {
          const payload = stagedHistory.recorded === null ? null : JSON.stringify(stagedHistory.recorded);
          db.prepare('INSERT INTO native_history(id,project_path,thread_id,session_id,payload) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_path=excluded.project_path,thread_id=excluded.thread_id,session_id=excluded.session_id,payload=excluded.payload').run(projectPath,stagedHistory.threadId,stagedHistory.sessionId,payload);
          const pair = actionClient?.snapshot().thread?.selection;
          const selection = pair ? JSON.stringify(pair) : null;
          db.prepare('INSERT INTO native_threads(project_path,thread_id,session_id,selection,payload) VALUES(?,?,?,?,?) ON CONFLICT(project_path,thread_id) DO UPDATE SET session_id=excluded.session_id,selection=COALESCE(excluded.selection,native_threads.selection),payload=excluded.payload').run(projectPath,stagedHistory.threadId,stagedHistory.sessionId,selection,payload);
        }
        if (record.state === 'acknowledged' && value.action === 'select') {
          const thread = actionClient?.snapshot().thread;
          if (thread?.configured) db.prepare('UPDATE native_threads SET selection=? WHERE project_path=? AND thread_id=? AND session_id IS ?').run(JSON.stringify(thread.selection),projectPath,thread.threadId,thread.sessionId);
        }
        save(record); db.exec('COMMIT');
      } catch {
        const fenced = fenceJournalFailure(); // Always before rollback, even if BEGIN or rollback fails.
        if (transaction) { try { db.exec('ROLLBACK'); } catch { /* Retain uncertain journal; never retry. */ } }
        await fenced; throw new CodexClientError('JOURNAL_FAILURE','Native acknowledgement could not be committed. Authority retired; no retry.',true);
      }
      if (record.state === 'acknowledged' && (value.action === 'thread-start' || value.action === 'thread-resume') && currentAssets?.handle) {
        const snapshot = actionClient?.snapshot(), thread = snapshot?.thread;
        try {
          if (!snapshot?.ready || !snapshot.connected || snapshot.mcpIsolation !== 'arcane-only-verified' || snapshot.account?.auth !== 'subscription' || !thread?.configured || !stagedHistory || thread.threadId!==stagedHistory.threadId || thread.sessionId!==stagedHistory.sessionId)
            throw new CodexClientError('ASSET_AUTHORITY','Native asset identity is not attested.');
          currentAssets.handle.seal({connectionId:snapshot.connectionId,provider:'codex',threadId:thread.threadId,sessionId:thread.sessionId});
        } catch { retireAssets(); } // Native ACK remains real; asset permission stays unavailable.
      }
      if (record.state === 'acknowledged' && grantAssetsAfterCommit) {
        try { grantAssetsAfterCommit(); }
        catch { retireAssets(); record.state='unknown'; record.errorCode='ASSET_AUTHORITY';
          try { save(record); } catch { await fenceJournalFailure(); throw new CodexClientError('JOURNAL_FAILURE','Asset permission acknowledgement could not be persisted. Authority retired; no retry.',true); }
        }
      }
      if(reportFailure&&(record.state==='rejected'||record.state==='unknown')){
        // Both the primary transition and any asset-grant conversion are durable before reporting.
        // Detached reporting never delays, retries or changes a native action or its receipt.
        try{
          const event=codexActionFailureEvent(record.requestId,record.action,record.errorCode);
          void Promise.resolve().then(()=>reportFailure(event)).catch(()=>{});
        }catch{/* A diagnostic cannot change the recorded native outcome. */}
      }
      if(taskAfterCommit && record.state==='acknowledged') {
        try {tasks!.acknowledged(taskAfterCommit);}
        catch(error) {
          // The native ACK remains real even when its separate task journal
          // fails. Retire that exact owner and join cleanup before reporting it.
          try {tasks!.uncertain(taskAfterCommit,'initial_acknowledgement_journal_failure');}
          catch {/* uncertain still starts owned cleanup when its journal write fails. */}
          await tasks!.drain();throw error;
        }
        const planned=planInputs.get(taskAfterCommit);planInputs.delete(taskAfterCommit);
        if(planned&&options.workStore&&proposalFactory){
          try{tasks!.startPlan({taskId:taskAfterCommit,...planned,factory:proposalFactory,evidence:async(plan,owner)=>{
            const port=createTaskAcceptancePort({work:options.workStore!,owner});
            const base='arcane-evidence/'+plan.taskId;
            const created=await port.request({taskId:plan.taskId,planId:plan.id,objectiveSha256:plan.objectiveSha256,original:plan.binding,
              run:{title:'Review task result',objective:'Review actual implementation and verification evidence for the original chat task '+plan.taskId+'.',
                tasks:[{key:'implementation',title:'Review implementation',instructions:'Inspect the original chat task and its actual changed project files. Submit current file evidence; native prose is not proof of success.',
                  acceptance:'A human reviewed actual implementation evidence for this original task.',scope:[base+'/implementation'],dependencies:[]},
                  {key:'verification',title:'Review verification',instructions:'Submit actual current test reports, measured results or other relevant local artifacts. State unsupported or missing checks explicitly.',
                    acceptance:'A human reviewed actual verification evidence. Syntax or generated summaries alone do not establish gameplay correctness.',scope:[base+'/verification'],dependencies:[]}]}});
            return{runId:created.runId};
          }});}catch{try{tasks!.uncertain(taskAfterCommit,'task_plan_admission_not_replayed');}catch{/* The original native acknowledgement remains real; no replay. */}}
        }
      }
    }
    if(taskAfterCommit)planInputs.delete(taskAfterCommit);
    return {record,replayed:false,state:state()};
  }
  function action(input: unknown): Promise<CodexActionOutcome> {
    const promise = runAction(input); inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise)).catch(() => {}); return promise;
  }
  /** Read-only proposal display for the exact selected conversation; never journals, dispatches or applies. */
  function proposals(input: unknown): CodexProposalList {
    if (closed) throw new CodexClientError('CLOSED','Native workflow is closed.');
    if (journalFault) throw new CodexClientError('JOURNAL_FAILURE','Review the retained native journal before reading proposals.');
    const parsed = z.strictObject({connectionId:uuid,threadId:identifier,taskId:uuid}).safeParse(input);
    if (!parsed.success) throw new CodexClientError('ARGUMENTS','Proposal listing requires the exact connection, conversation and task.');
    const thread = exactClient(parsed.data.connectionId).snapshot().thread;
    const task = tasks?.list().find(entry => entry.id === parsed.data.taskId);
    if (!tasks || !thread?.configured || thread.threadId !== parsed.data.threadId || !task || task.threadId !== thread.threadId || task.sessionId !== thread.sessionId)
      throw new CodexClientError('TASK_SCOPE','List proposals only for a task in this exact native conversation.');
    return { taskId: task.id, display: 'proposal_not_applied', proposals: tasks.proposals(task.id).map(entry => ({ proposalId: entry.id, requestId: entry.requestId,
      state: entry.state, reason: entry.reason, text: entry.result?.text ?? null, textSha256: entry.result?.textSha256 ?? null, textBytes: entry.result?.textBytes ?? null,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt })) };
  }
  const taskPlanReads = new Set<Promise<TaskPlanView>>();
  /** Bounded display-only read. A browser can observe a plan and a human review,
   * never create a binding, restart a step or obtain any native capability. */
  async function readTaskPlan(input: unknown): Promise<TaskPlanView> {
    if(closed||journalFault)throw new CodexClientError('CLOSED','Native task observation is unavailable.');
    const parsed=z.strictObject({connectionId:uuid,threadId:identifier,taskId:uuid}).safeParse(input);
    if(!parsed.success)throw new CodexClientError('ARGUMENTS','Choose one exact native task.');
    const scope=parsed.data,selected=exactClient(scope.connectionId),epoch=generation;
    const assertScope=()=>{
      if(closed||generation!==epoch||exactClient(scope.connectionId)!==selected)throw new CodexClientError('STALE_CONNECTION','Task view belongs to an earlier connection.');
      const thread=selected.snapshot().thread,task=tasks?.list().find(value=>value.id===scope.taskId);
      if(!thread?.configured||thread.threadId!==scope.threadId||!task||task.threadId!==thread.threadId||task.sessionId!==thread.sessionId)
        throw new CodexClientError('TASK_SCOPE','Read only a task in this exact conversation.');
      const plan=tasks!.plan(task.id);
      if(plan&&selected.taskAccountIdentity?.()!==plan.binding.accountIdentity)throw new CodexClientError('TASK_SCOPE','The original task account changed.');
      return{task,plan};
    };
    const initial=assertScope();if(!initial.plan)return{taskId:scope.taskId,plan:null};
    let steps=tasks!.planSteps(initial.plan.id),reference=steps.find(step=>step.kind==='evidence'),review:TaskPlanReviewView|null=null;
    if(reference&&options.workStore){
      let runId=reference.evidence?.runId??null;
      try{
        const mapped=options.workStore.bindingFor(scope.taskId,initial.plan.id);
        if(mapped&&isDeepStrictEqual(mapped.binding.original,initial.plan.binding)&&mapped.binding.objectiveSha256===initial.plan.objectiveSha256){
          if(runId&&runId!==mapped.run.id)throw new Error('Review mapping changed.');
          runId=mapped.run.id;
        }else if(runId)throw new Error('Review binding is unavailable.');
        if(runId){
          if(reference.state!=='acknowledged')review={runId,state:'unavailable',reason:'request_uncertain',tasks:[]};
          else{
            const owner=tasks!.planObservationOwner(scope.taskId),port=createTaskAcceptancePort({work:options.workStore,owner});
            const status=await port.status({taskId:scope.taskId,planId:initial.plan.id,runId});
            if(!status.tasks.every(task=>TASK_PLAN_REVIEW_TASK_STATES.some(state=>state===task.state)))throw new Error('Invalid task review state.');
            review={runId,state:status.state,reason:status.reason,tasks:status.tasks.map(task=>({key:task.key,state:task.state as TaskPlanReviewTaskState}))};
          }
        }
      }catch{if(runId)review={runId,state:'unavailable',reason:'owner_or_evidence_unavailable',tasks:[]};}
    }else if(reference?.evidence)review={runId:reference.evidence.runId,state:'unavailable',reason:'store_unavailable',tasks:[]};
    const fresh=assertScope();
    if(fresh.plan?.id!==initial.plan.id)throw new CodexClientError('TASK_SCOPE','The task plan changed during observation.');
    steps=tasks!.planSteps(fresh.plan.id);reference=steps.find(step=>step.kind==='evidence');
    if(review&&reference?.state==='acknowledged'&&reference.evidence?.runId!==review.runId)throw new CodexClientError('TASK_SCOPE','The evidence reference changed during observation.');
    const lastParent=steps.filter(step=>step.kind==='incorporation').at(-1);
    if(review?.state==='accepted'&&(fresh.plan.state!=='awaiting_review'||reference?.state!=='acknowledged'||lastParent?.state!=='completed'||lastParent.terminal!=='completed'))
      review={...review,state:'unavailable',reason:'native_work_pending'};
    return{taskId:scope.taskId,plan:{planId:fresh.plan.id,state:fresh.plan.state,reason:fresh.plan.reason,review,
      steps:steps.map(step=>({seq:step.seq,kind:step.kind,round:step.round as 1|2,index:step.index as 0|1|2,state:step.state,terminal:step.terminal,reason:step.reason}))}};
  }
  function taskPlan(input:unknown):Promise<TaskPlanView>{
    const pending=readTaskPlan(input);taskPlanReads.add(pending);void pending.finally(()=>taskPlanReads.delete(pending)).catch(()=>{});return pending;
  }
  const usageReads = new Set<Promise<CodexProductState>>();
  async function readUsage(input: unknown): Promise<CodexProductState> {
    if (closed) throw new CodexClientError('CLOSED','Native workflow is closed.');
    if (journalFault) throw new CodexClientError('JOURNAL_FAILURE','Review the retained native journal before refreshing account usage.');
    const parsed = z.strictObject({connectionId:uuid}).safeParse(input);
    if (!parsed.success) throw new CodexClientError('ARGUMENTS','Usage refresh requires the exact current connection ID.');
    if (connecting || closing) throw new CodexClientError('BUSY','Wait for the current connection to settle.');
    const selected = exactClient(parsed.data.connectionId), epoch = generation;
    if (!selected.readRateLimits) throw new CodexClientError('RATE_LIMITS_UNAVAILABLE','This native client does not report account usage.');
    await selected.readRateLimits({initiatedBy:'human'});
    if (closed || client !== selected || generation !== epoch) throw new CodexClientError('STALE_CONNECTION','Usage refresh belongs to the previous native connection state.');
    return state();
  }
  function refreshUsage(input: unknown): Promise<CodexProductState> {
    const promise = readUsage(input); usageReads.add(promise);
    void promise.finally(() => usageReads.delete(promise)).catch(() => {}); return promise;
  }
  return { state, action, refreshUsage, proposals, taskPlan,
    authorizeBoundWork(actorId:string,binding:WorkTaskBinding){if(!tasks)throw new Error('Native work authority is unavailable.');tasks.authorizeBoundWork(actorId,binding);},
    playtestTasks:tasks?.playtests??null,
    attachPlaytestCancellation(port:StudioTestTaskCancellation){if(!tasks)throw new Error('Native task authority is unavailable.');tasks.attachCancellation(port);}, async close() {
    if (closed) return; generation++; closed = true;tasks?.fence();
    try{retireAssets();}catch{/* Native task closure must still run after registry retirement. */}
    try {
      if (pendingConnect) { try { await (await pendingConnect).close(); } catch { /* Init failure already closed its native child. */ } }
      try{await tasks?.close();}finally{if(client)await client.close();}
      if (journalFault) await journalFault;
    } finally { client = null; planInputs.clear();await Promise.allSettled([...inFlight,...usageReads,...taskPlanReads]); db.close(); }
  },fenceTaskAdmission(){generation++;tasks?.fence();} };
}
export type CodexService = Pick<ReturnType<typeof createCodexService>, 'state'|'action'|'close'> &
  Partial<Pick<ReturnType<typeof createCodexService>, 'refreshUsage'|'proposals'|'taskPlan'|'authorizeBoundWork'|'playtestTasks'|'attachPlaytestCancellation'|'fenceTaskAdmission'>>;


