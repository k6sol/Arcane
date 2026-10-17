/**
 * Local Arcane actions ledger: an append-only, hash-chained JSONL file in the daemon state directory.
 *
 * One Arcane action = one finished build turn (Codex or Claude chat) or one applied Studio change (a succeeded
 * Studio write command). The ledger is informational: it never blocks work and it never represents purchased balance.
 * Each line carries the hash of the previous line, so edits, deletions and reordering are detectable on load
 * ("tamper-evident enough" for a local usage meter, not a security boundary against the machine owner).
 * The file is bounded: past MAX_ENTRIES the oldest entries fold into one checkpoint line with per-month totals.
 */
import { appendFileSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type ActionKind = 'build-turn' | 'studio-change';
export type ActionSource = 'codex' | 'claude' | 'studio';
export interface ActionEntry {
  type: 'action'; v: 1; seq: number; at: string; kind: ActionKind; source: ActionSource;
  /** sha256 of source + external id; dedups replays without storing raw ids. */
  ref: string;
  /** Conversation, thread or Studio session id when known. */
  conversation: string | null;
  prev: string; hash: string;
}
export interface CheckpointEntry {
  type: 'checkpoint'; v: 1; seq: number; at: string;
  /** Actions folded out of the file, by 'YYYY-MM' and by 'YYYY-MM-DD'. */
  months: Record<string, number>; days: Record<string, number>;
  /** Folded refs kept for dedup (bounded). */
  refs: string[];
  prev: string; hash: string;
}
type Line = ActionEntry | CheckpointEntry;
export interface RecordInput { kind: ActionKind; source: ActionSource; id: string; conversation?: string | null; at?: Date }
export interface ActionsSummary {
  unit: 'action'; month: { key: string; used: number }; today: { key: string; used: number };
  byKind: Record<ActionKind, number>; bySource: Record<ActionSource, number>;
  days: { key: string; used: number }[];
  conversations: { conversation: string; used: number }[];
  integrity: 'verified' | 'mismatch' | 'empty';
  entries: number;
  /** Local usage never blocks; only a configured plan service could change this. */
  enforced: false;
}

export const LEDGER_FILE = 'actions-ledger.v1.jsonl';
const GENESIS = '0'.repeat(64);
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const MAX_LINE_BYTES = 4096, MAX_FILE_BYTES = 8 * 1024 * 1024, MAX_REFS = 4000;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const body = (line: Omit<Line, 'hash'>) => JSON.stringify(line);
const monthKey = (date: Date) => date.toISOString().slice(0, 7);
const dayKey = (date: Date) => date.toISOString().slice(0, 10);

export class ActionsLedger {
  readonly file: string;
  #entries: ActionEntry[] = [];
  #checkpoint: CheckpointEntry | null = null;
  #refs = new Set<string>();
  #head = GENESIS; #seq = 0; #integrity: 'verified' | 'mismatch' = 'verified';
  #loaded = false;
  readonly #maxEntries: number;

  constructor(readonly directory: string, options: { maxEntries?: number } = {}) {
    this.file = join(directory, LEDGER_FILE);
    this.#maxEntries = Math.max(10, Math.min(options.maxEntries ?? 20000, 50000));
  }

  #ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Actions ledger directory is not a plain directory.');
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    let text = '';
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES * 2) { this.#integrity = 'mismatch'; return; }
      text = readFileSync(this.file, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; this.#integrity = 'mismatch'; return; }
    let prev = GENESIS;
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      let line: Line;
      try { line = JSON.parse(raw) as Line; } catch { this.#integrity = 'mismatch'; continue; }
      if (!line || typeof line !== 'object' || typeof line.hash !== 'string') { this.#integrity = 'mismatch'; continue; }
      const { hash, ...rest } = line;
      if (line.prev !== prev || sha(body(rest)) !== hash) this.#integrity = 'mismatch';
      prev = hash;
      this.#seq = Math.max(this.#seq, Number.isSafeInteger(line.seq) ? line.seq : this.#seq);
      if (line.type === 'checkpoint') {
        this.#checkpoint = line;
        for (const ref of Array.isArray(line.refs) ? line.refs : []) this.#refs.add(String(ref));
      } else if (line.type === 'action' && typeof line.ref === 'string' && !Number.isNaN(Date.parse(line.at))) {
        this.#entries.push(line); this.#refs.add(line.ref);
      } else this.#integrity = 'mismatch';
    }
    this.#head = prev;
  }

  /** Records one action once. Returns false for a duplicate or an invalid id; never throws for usage metering. */
  record(input: RecordInput): boolean {
    if (!['build-turn', 'studio-change'].includes(input.kind) || !['codex', 'claude', 'studio'].includes(input.source)) return false;
    if (typeof input.id !== 'string' || !SAFE_ID.test(input.id)) return false;
    const conversation = typeof input.conversation === 'string' && SAFE_ID.test(input.conversation) ? input.conversation : null;
    const at = input.at && !Number.isNaN(input.at.getTime()) ? input.at : new Date();
    this.#load();
    const ref = sha(input.source + '\u0000' + input.id);
    if (this.#refs.has(ref)) return false;
    this.#ensureDirectory();
    const entry = this.#seal<ActionEntry>({ type: 'action', v: 1, seq: this.#seq + 1, at: at.toISOString(), kind: input.kind, source: input.source, ref, conversation, prev: this.#head });
    const text = JSON.stringify(entry) + '\n';
    if (Buffer.byteLength(text) > MAX_LINE_BYTES) return false;
    appendFileSync(this.file, text, { mode: 0o600 });
    this.#seq = entry.seq; this.#head = entry.hash; this.#entries.push(entry); this.#refs.add(ref);
    if (this.#entries.length > this.#maxEntries) this.#compact();
    return true;
  }

  #seal<T extends Line>(line: Omit<T, 'hash'>): T {
    return { ...line, hash: sha(body(line as Omit<Line, 'hash'>)) } as T;
  }

  /** Folds the oldest half into a checkpoint and rewrites the file atomically with a fresh chain. */
  #compact(): void {
    const keep = Math.floor(this.#maxEntries / 2);
    const folded = this.#entries.slice(0, this.#entries.length - keep), kept = this.#entries.slice(-keep);
    const months = { ...(this.#checkpoint?.months ?? {}) }, days = { ...(this.#checkpoint?.days ?? {}) };
    for (const entry of folded) {
      const date = new Date(entry.at);
      months[monthKey(date)] = (months[monthKey(date)] ?? 0) + 1;
      days[dayKey(date)] = (days[dayKey(date)] ?? 0) + 1;
    }
    // Keep day totals for roughly the last 400 days only.
    for (const key of Object.keys(days).sort().slice(0, -400)) delete days[key];
    const refs = [...(this.#checkpoint?.refs ?? []), ...folded.map(entry => entry.ref)].slice(-MAX_REFS);
    let prev = GENESIS, seq = this.#seq;
    const checkpoint = this.#seal<CheckpointEntry>({ type: 'checkpoint', v: 1, seq: ++seq, at: new Date().toISOString(), months, days, refs, prev });
    prev = checkpoint.hash;
    const rechained: ActionEntry[] = [];
    for (const entry of kept) {
      const { hash: _old, ...rest } = entry;
      const next = this.#seal<ActionEntry>({ ...rest, seq: ++seq, prev });
      rechained.push(next); prev = next.hash;
    }
    const temporary = this.file + '.compact';
    const fd = openSync(temporary, 'w', 0o600);
    try { writeSync(fd, [checkpoint, ...rechained].map(line => JSON.stringify(line)).join('\n') + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, this.file);
    this.#checkpoint = checkpoint; this.#entries = rechained; this.#head = prev; this.#seq = seq;
    this.#refs = new Set([...refs, ...rechained.map(entry => entry.ref)]);
  }

  summary(now = new Date()): ActionsSummary {
    this.#load();
    const month = monthKey(now), today = dayKey(now);
    const byKind: Record<ActionKind, number> = { 'build-turn': 0, 'studio-change': 0 };
    const bySource: Record<ActionSource, number> = { codex: 0, claude: 0, studio: 0 };
    const days = new Map<string, number>(), conversations = new Map<string, number>();
    let monthUsed = this.#checkpoint?.months[month] ?? 0;
    for (const [key, value] of Object.entries(this.#checkpoint?.days ?? {})) days.set(key, value);
    for (const entry of this.#entries) {
      const date = new Date(entry.at), day = dayKey(date);
      days.set(day, (days.get(day) ?? 0) + 1);
      if (monthKey(date) !== month) continue;
      monthUsed++; byKind[entry.kind]++; bySource[entry.source]++;
      if (entry.conversation) conversations.set(entry.conversation, (conversations.get(entry.conversation) ?? 0) + 1);
    }
    const recent: { key: string; used: number }[] = [];
    for (let offset = 13; offset >= 0; offset--) {
      const key = dayKey(new Date(now.getTime() - offset * 86400000));
      recent.push({ key, used: days.get(key) ?? 0 });
    }
    return {
      unit: 'action', month: { key: month, used: monthUsed }, today: { key: today, used: days.get(today) ?? 0 },
      byKind, bySource, days: recent,
      conversations: [...conversations].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([conversation, used]) => ({ conversation, used })),
      integrity: this.#entries.length || this.#checkpoint ? this.#integrity : this.#integrity === 'mismatch' ? 'mismatch' : 'empty',
      entries: this.#entries.length, enforced: false,
    };
  }
}
