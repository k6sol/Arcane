import type { DatabaseSync } from 'node:sqlite';
import { redactNativeHistoryText } from '../../codex-client/src/history.js';

export type SubmittedChatProvider = 'codex' | 'claude' | 'arcane';
export type SubmittedChatState = 'pending' | 'acknowledged' | 'rejected' | 'unknown';
/** A local Send receipt, never a native history item or permission to replay it. */
export interface SubmittedChatMessage {
  /** Absent means a legacy new-turn Send. Steering receipts are keyed by requestId, never turnId. */
  kind?: 'steer';
  requestId: string; turnId: string | null; text: string;
  model: string | null; effort: string | null; state: SubmittedChatState;
  createdAt: string; finishedAt: string | null; errorCode: string | null;
  contextIncluded:boolean; transmittedBytes:number;
}
export interface SubmittedChatTranscript {
  provider: SubmittedChatProvider; projectPath: string; threadId: string; sessionId: string | null;
  earlierCount: number; messages: SubmittedChatMessage[];
}
const DISPLAY_MESSAGES = 64, DISPLAY_BYTES = 512 * 1024;
const identifier = (value: string) => value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);

/** Shares the action journal's transaction: the prompt is saved before dispatch and its outcome commits with the ACK. */
export class SubmittedChatStore {
  constructor(private readonly db: DatabaseSync, private readonly projectPath: string, private readonly provider: SubmittedChatProvider) {
    db.exec(`CREATE TABLE IF NOT EXISTS submitted_chat_messages(
      request_id TEXT PRIMARY KEY, provider TEXT NOT NULL, project_path TEXT NOT NULL,
      thread_id TEXT NOT NULL, session_id TEXT, payload TEXT NOT NULL
        CHECK(length(CAST(payload AS BLOB))<=140288)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS submitted_chat_scope ON submitted_chat_messages(provider,project_path,thread_id,session_id);`);
  }
  put(binding: { threadId: string; sessionId: string | null }, message: SubmittedChatMessage): void {
    if (!identifier(binding.threadId) || binding.sessionId !== null && !identifier(binding.sessionId) ||
        !identifier(message.requestId) || Buffer.byteLength(message.text) > 131072 || message.state !== 'pending' ||
        message.kind !== undefined && message.kind !== 'steer')
      throw new Error('Invalid submitted chat message.');
    const safe: SubmittedChatMessage = { ...message, text: redactNativeHistoryText(message.text) };
    this.db.prepare('INSERT INTO submitted_chat_messages(request_id,provider,project_path,thread_id,session_id,payload) VALUES(?,?,?,?,?,?)')
      .run(message.requestId, this.provider, this.projectPath, binding.threadId, binding.sessionId, JSON.stringify(safe));
  }
  finish(requestId: string, outcome: Pick<SubmittedChatMessage, 'turnId' | 'model' | 'effort' | 'state' | 'finishedAt' | 'errorCode'>): void {
    const row = this.db.prepare('SELECT payload FROM submitted_chat_messages WHERE request_id=? AND provider=? AND project_path=?')
      .get(requestId, this.provider, this.projectPath) as { payload: string } | undefined;
    if (!row) return;
    const message = JSON.parse(row.payload) as SubmittedChatMessage;
    // An absent model report does not erase the exact choice captured before Send.
    const next = { ...message, ...outcome, model: outcome.model ?? message.model, effort: outcome.effort ?? message.effort };
    this.db.prepare('UPDATE submitted_chat_messages SET payload=? WHERE request_id=?').run(JSON.stringify(next), requestId);
  }
  recoverPending(at: string): void {
    const rows = this.db.prepare("SELECT request_id,payload FROM submitted_chat_messages WHERE provider=? AND project_path=? AND json_extract(payload,'$.state')='pending'")
      .all(this.provider, this.projectPath) as { request_id: string; payload: string }[];
    for (const row of rows) {
      const message = JSON.parse(row.payload) as SubmittedChatMessage;
      this.finish(row.request_id, { turnId: message.turnId, model: message.model, effort: message.effort,
        state: 'unknown', finishedAt: at, errorCode: 'DAEMON_RESTART' });
    }
  }
  read(binding: { threadId: string; sessionId: string | null }): SubmittedChatTranscript {
    const args = [this.provider, this.projectPath, binding.threadId, binding.sessionId] as const;
    const total = Number((this.db.prepare('SELECT count(*) AS n FROM submitted_chat_messages WHERE provider=? AND project_path=? AND thread_id=? AND session_id IS ?')
      .get(...args) as { n: number }).n);
    const rows = this.db.prepare('SELECT payload FROM submitted_chat_messages WHERE provider=? AND project_path=? AND thread_id=? AND session_id IS ? ORDER BY rowid DESC LIMIT ?')
      .all(...args, DISPLAY_MESSAGES) as { payload: string }[];
    const messages: SubmittedChatMessage[] = []; let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(row.payload);
      if (bytes + size > DISPLAY_BYTES) break;
      bytes += size; messages.unshift(JSON.parse(row.payload) as SubmittedChatMessage);
    }
    return { provider: this.provider, projectPath: this.projectPath, threadId:binding.threadId,sessionId:binding.sessionId,earlierCount: total - messages.length, messages };
  }
}
