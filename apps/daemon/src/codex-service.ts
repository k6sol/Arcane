import type { NativeWorkflowModelProof } from '../../../packages/protocol/src/workflow-model.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { connectCodexClient, CodexClientError, type CodexClient, type Snapshot, type ArcaneMcpLaunchProfile } from '../../../packages/codex-client/src/index.js';
import { locateNativeCli } from '../../../packages/model-adapters/src/process.js';
import { HISTORY_GAP_MARKER, NATIVE_HISTORY_LIMITS, redactNativeHistoryText, type NativeHistoryResult } from '../../../packages/codex-client/src/history.js';

const uuid = z.string().uuid();
const identifier = z.string().min(1).max(256).refine(value => !/[\x00-\x1f]/.test(value));
const common = { requestId: uuid, connectionId: uuid };
export const codexActionInput = z.discriminatedUnion('action', [
  z.strictObject({ requestId: uuid, connectionId: z.null(), action: z.literal('connect') }),
  z.strictObject({ ...common, action: z.literal('disconnect') }),
  z.strictObject({ ...common, action: z.literal('select'), model: identifier, effort: identifier.max(64) }),
  z.strictObject({ ...common, action: z.literal('thread-start') }),
  z.strictObject({ ...common, action: z.literal('thread-resume'), threadId: identifier }),
  z.strictObject({ ...common, action: z.literal('history-load'), threadId: identifier }),
  z.strictObject({ ...common, action: z.literal('grant-writes'), threadId: identifier }),
  z.strictObject({ ...common, action: z.literal('revoke-writes'), threadId: identifier }),
  z.strictObject({ ...common, action: z.literal('turn-start'), threadId: identifier, text: z.string().min(1).refine(value => Buffer.byteLength(value) <= 131072) }),
  z.strictObject({ ...common, action: z.literal('turn-interrupt'), threadId: identifier, turnId: identifier }),
  z.strictObject({ ...common, action: z.literal('approval'), threadId: identifier, turnId: identifier, handle: identifier, decision: z.enum(['accept','decline','cancel']) }),
]);
export type CodexAction = z.infer<typeof codexActionInput>;
export interface CodexActionRecord {
  requestId: string; action: CodexAction['action']; connectionId: string | null;
  state: 'pending' | 'acknowledged' | 'rejected' | 'unknown'; errorCode: string | null;
  threadId: string | null; turnId: string | null; model: string | null; effort: string | null;
  createdAt: string; finishedAt: string | null;
}
export interface CodexRecordedHistory {
  requestId: string; connectionId: string; provenance: Snapshot['provenance']; loadedAt: string;
  result: NativeHistoryResult;
}
export interface CodexHistoryState {
  projectPath: string; threadId: string; sessionId: string | null;
  recorded: CodexRecordedHistory | null;
}
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
  workflowModel?: NativeWorkflowModelProof | null; actions: CodexActionRecord[]; nativeHistory?: CodexHistoryState | null; displayLimited?: true; nativeTools: { configured: boolean; verified: false };
}
export interface CodexActionOutcome { record: CodexActionRecord; replayed: boolean; state: CodexProductState }
export type CodexHostClient = Pick<CodexClient, 'snapshot'|'selectModel'|'startThread'|'resumeThread'|'grantThreadWrites'|'revokeThreadWrites'|'startTurn'|'interruptTurn'|'respondApproval'|'close'> & Partial<Pick<CodexClient,'readThreadHistory'>>;
export interface CodexServiceOptions {
  directory: string; projectPath: string;
  /** Parent-controlled client factory. Tests use a labelled fixture; never accept it from HTTP input. */
  connect?: () => Promise<CodexHostClient>;
  nativeToolsConfigured?: boolean;
  /** Trusted application callback; never use browser supplied paths/tokens. */
  arcaneMcp?: () => ArcaneMcpLaunchProfile;
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
/** Durable human action receipts; native conversations remain owned by the actual CLI. */
export function createCodexService(options: CodexServiceOptions) {
  const directory = safeDirectory(options.directory), projectPath = realpathSync(options.projectPath);
  const filename = join(directory, 'codex-actions.sqlite');
  try { const stat = lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new CodexClientError('PATH', 'Unsafe native action journal.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(filename, { timeout: 2000, allowExtension: false });
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version > 2) { db.close(); throw new CodexClientError('MIGRATION', 'Native journal is newer than this build.'); }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS native_history(
      id INTEGER PRIMARY KEY CHECK(id=1), project_path TEXT NOT NULL, thread_id TEXT NOT NULL, session_id TEXT,
      payload TEXT CHECK(payload IS NULL OR length(CAST(payload AS BLOB))<=2113536)
    ) STRICT;
    PRAGMA user_version=2;`);
  // A provider handle cannot survive daemon restart. Never redispatch a pending model action.
  for (const row of db.prepare("SELECT id,payload FROM actions WHERE json_extract(payload,'$.state')='pending'").all() as {id:string;payload:string}[]) {
    const record = JSON.parse(row.payload) as CodexActionRecord; record.state = 'unknown'; record.errorCode = 'DAEMON_RESTART'; record.finishedAt = new Date().toISOString();
    db.prepare('UPDATE actions SET payload=? WHERE id=?').run(JSON.stringify(record), row.id);
  }
  let client: CodexHostClient | null = null, lastSnapshot: Snapshot | null = null;
  let connecting = false, closing = false, busy = false, closed = false, generation = 0;
  let pendingConnect: Promise<CodexHostClient> | null = null;
  let saturatedClose: Promise<void> | null = null;
  const factory = options.connect ?? (async () => {
    const command = await locateNativeCli('codex');
    if (!command) throw new CodexClientError('CLI_MISSING', 'The native Codex executable is unavailable.');
    return connectCodexClient({ command, cwd: projectPath, use: 'personal-local', ...(options.arcaneMcp ? { arcaneMcp: options.arcaneMcp() } : {}) });
  });
  const history = (): CodexActionRecord[] => (db.prepare('SELECT payload FROM actions ORDER BY rowid DESC LIMIT 100').all() as {payload:string}[]).map(row => JSON.parse(row.payload) as CodexActionRecord);
  function nativeHistory(): CodexHistoryState | null {
    const row = db.prepare('SELECT thread_id,session_id,payload FROM native_history WHERE id=1 AND project_path=?').get(projectPath) as {thread_id:string;session_id:string|null;payload:string|null}|undefined;
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
  function state(): CodexProductState {
    if (closed) throw new CodexClientError('CLOSED', 'Native workflow is closed.');
    return { provider:'codex', use:'personal-local', projectPath, connecting, closing, busy,
      snapshot:client?.snapshot() ?? null, lastSnapshot:lastSnapshot ? structuredClone(lastSnapshot) : null,
      actions:history(), nativeHistory:nativeHistory(), nativeTools:{configured:options.arcaneMcp !== undefined || options.nativeToolsConfigured === true,verified:false} };
  }
  const save = (record: CodexActionRecord) => { db.prepare('UPDATE actions SET payload=? WHERE id=?').run(JSON.stringify(record),record.requestId); };
  const exactClient = (connectionId: string): CodexHostClient => {
    if (!client || client.snapshot().connectionId !== connectionId) throw new CodexClientError('STALE_CONNECTION','Choose the exact current native connection.');
    return client;
  };
  const inFlight = new Set<Promise<CodexActionOutcome>>();
  async function runAction(input: unknown): Promise<CodexActionOutcome> {
    if (closed) throw new CodexClientError('CLOSED','Native workflow is closed.');
    const parsed = codexActionInput.safeParse(input);
    if (!parsed.success) throw new CodexClientError('ARGUMENTS','Supply an exact bounded native action envelope.');
    const value = parsed.data;
    const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const prior = db.prepare('SELECT hash,payload FROM actions WHERE id=?').get(value.requestId) as {hash:string;payload:string}|undefined;
    if (prior) {
      if (prior.hash !== hash) throw new CodexClientError('IDEMPOTENCY','This request ID already identifies a different action.');
      return {record:JSON.parse(prior.payload) as CodexActionRecord,replayed:true,state:state()};
    }
    if (Number((db.prepare('SELECT count(*) AS n FROM actions').get() as {n:number}).n) >= 4096) {
      // Exhaustion cannot leave a write-granted client running without stop controls.
      // Fence immediately, preserve existing request identities, and dispatch no
      // refused model action. Further work needs offline journal reconciliation.
      saturatedClose ??= (async () => {
        generation++; closing = true;
        const owned = client; client = null;
        try { if (owned) { lastSnapshot = owned.snapshot(); await owned.close(); lastSnapshot = owned.snapshot(); } }
        finally { closing = false; }
      })();
      await saturatedClose;
      throw new CodexClientError('JOURNAL_LIMIT','The full native journal fenced the connection. Stop Arcane and archive its journal before reconnecting; old requests were not discarded or replayed.');
    }
    const record: CodexActionRecord = {requestId:value.requestId,action:value.action,connectionId:value.connectionId,state:'pending',errorCode:null,
      threadId:'threadId' in value ? value.threadId:null,turnId:'turnId' in value ? value.turnId:null,
      model:value.action==='select'?value.model:null,effort:value.action==='select'?value.effort:null,createdAt:new Date().toISOString(),finishedAt:null};
    db.prepare('INSERT INTO actions(id,hash,payload) VALUES(?,?,?)').run(record.requestId,hash,JSON.stringify(record));
    const epoch = generation;
    let stagedHistory: CodexHistoryState | null = null;
    let ownsBusy = false; const existingOperations = new Set<string>();
    let actionClient: CodexHostClient | null = null;
    const operationMethod = ({ 'thread-start':'thread/start', 'thread-resume':'thread/resume', 'turn-start':'turn/start', 'turn-interrupt':'turn/interrupt' } as Record<string,string>)[value.action] ?? null;
    try {
      if (value.action === 'connect') {
        if (client || connecting || closing) throw new CodexClientError('BUSY','Disconnect the previous native connection before connecting.');
        connecting = true;
        try {
          pendingConnect = factory(); const connected = await pendingConnect;
          if (closed || generation !== epoch) { await connected.close(); throw new CodexClientError('STALE_CONNECTION','Connection was cancelled before acknowledgement.'); }
          client = connected; lastSnapshot = null; record.connectionId = connected.snapshot().connectionId;
        } finally { connecting = false; pendingConnect = null; }
      } else {
        const selected = exactClient(value.connectionId); actionClient = selected;
        for (const operation of selected.snapshot().operations) existingOperations.add(operation.operationId);
        if (value.action === 'disconnect') {
          generation++; closing = true; lastSnapshot = selected.snapshot(); client = null;
          try { await selected.close(); lastSnapshot = selected.snapshot(); } finally { closing = false; }
        } else {
          // Cancellation and revocation fence immediately even while a normal request awaits its acknowledgement.
          const safety = value.action === 'turn-interrupt' || value.action === 'revoke-writes' || value.action === 'approval';
          if (closing || connecting || (busy && !safety)) throw new CodexClientError('BUSY','A native action is still awaiting acknowledgement.');
          if (!safety) { busy = true; ownsBusy = true; }
          switch (value.action) {
            case 'select': selected.selectModel({initiatedBy:'human',model:value.model,effort:value.effort}); break;
            case 'thread-start': await selected.startThread({initiatedBy:'human'}); break;
            case 'thread-resume': await selected.resumeThread({initiatedBy:'human',threadId:value.threadId}); break;
            case 'history-load': {
              const binding = nativeHistory(), current = selected.snapshot().thread;
              if (!binding || binding.threadId !== value.threadId || (current && (current.threadId !== binding.threadId || (binding.sessionId !== null && current.sessionId !== binding.sessionId)))) throw new CodexClientError('HISTORY_SCOPE','Choose only the recorded current native thread for this project.');
              if (!selected.readThreadHistory) throw new CodexClientError('HISTORY_UNAVAILABLE','This native client has no public history reader.');
              const result = sanitizeHistory(await selected.readThreadHistory({ initiatedBy:'human', threadId:binding.threadId, ...(binding.sessionId === null ? {} : {sessionId:binding.sessionId}) }), binding);
              stagedHistory = { ...binding, recorded: { requestId:value.requestId, connectionId:value.connectionId, provenance:selected.snapshot().provenance, loadedAt:new Date().toISOString(), result } };
              break;
            }
            case 'grant-writes': selected.grantThreadWrites({initiatedBy:'human',threadId:value.threadId}); break;
            case 'revoke-writes': selected.revokeThreadWrites({initiatedBy:'human',threadId:value.threadId}); break;
            case 'turn-start': await selected.startTurn({initiatedBy:'human',threadId:value.threadId,text:value.text}); break;
            case 'turn-interrupt': await selected.interruptTurn({initiatedBy:'human',threadId:value.threadId,turnId:value.turnId}); break;
            case 'approval': selected.respondApproval({initiatedBy:'human',connectionId:value.connectionId,threadId:value.threadId,turnId:value.turnId,handle:value.handle,decision:value.decision}); break;
          }
          if (closed || generation !== epoch) throw new CodexClientError('STALE_CONNECTION','Native lifecycle changed while awaiting acknowledgement.',true);
          const snapshot = selected.snapshot(); const thread = snapshot.thread;
          record.threadId = thread?.threadId ?? record.threadId; record.turnId = thread?.turnId ?? record.turnId;
          record.model = snapshot.selection?.model ?? null; record.effort = snapshot.selection?.effort ?? null;
          if (value.action === 'thread-start' || value.action === 'thread-resume') {
            if (!thread?.configured || !snapshot.connected || !snapshot.ready || !historyIdentifier.safeParse(thread.threadId).success || (thread.sessionId !== null && !historyIdentifier.safeParse(thread.sessionId).success)) throw new CodexClientError('HISTORY_SCOPE','Native acknowledgement lacks a valid durable binding.');
            const previous = nativeHistory();
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
      // Never borrow another action's unknown operation or overwrite refused scope.
      if (uncertain) {
        record.threadId = pending?.threadId ?? snapshot?.thread?.threadId ?? record.threadId;
        record.turnId = pending?.turnId ?? snapshot?.thread?.turnId ?? record.turnId;
        record.model = snapshot?.selection?.model ?? record.model; record.effort = snapshot?.selection?.effort ?? record.effort;
      }
    } finally {
      if (ownsBusy) busy = false;
      record.finishedAt = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        if (record.state === 'acknowledged' && stagedHistory) db.prepare('INSERT INTO native_history(id,project_path,thread_id,session_id,payload) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_path=excluded.project_path,thread_id=excluded.thread_id,session_id=excluded.session_id,payload=excluded.payload').run(projectPath,stagedHistory.threadId,stagedHistory.sessionId,stagedHistory.recorded === null ? null : JSON.stringify(stagedHistory.recorded));
        save(record); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    return {record,replayed:false,state:state()};
  }
  function action(input: unknown): Promise<CodexActionOutcome> {
    const promise = runAction(input); inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise)).catch(() => {}); return promise;
  }
  return { state, action, async close() {
    if (closed) return; generation++; closed = true;
    try {
      if (pendingConnect) { try { await (await pendingConnect).close(); } catch { /* Init failure already closed its native child. */ } }
      if (client) await client.close();
    } finally { client = null; await Promise.allSettled([...inFlight]); db.close(); }
  } };
}
export type CodexService = ReturnType<typeof createCodexService>;


