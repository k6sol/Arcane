import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { workflowProjectIdentity } from '../../../packages/storage/src/workflow-store.js';

/** Host-only, in-memory credentials for a future human-launched external native client (for example an
 * unmodified Claude Code terminal with Arcane MCP). Never the generic core agent token. A credential is
 * returned once, in the trusted begin receipt; only its SHA-256 is retained. It authenticates only after
 * the host seals it on a genuine launch acknowledgement, only for the original project identity and only
 * until it expires (no renewal), is revoked, the project changes or the registry closes. There is no
 * restart persistence: every credential dies with this instance. Recognition returns detached display
 * metadata that grants nothing by itself; routes must consult the live registry on every request and
 * again after every await. No asset, bound-task, human-review, Studio grant/revoke or provider-login
 * authority is ever expressed here. */
export const NATIVE_HANDOFF_LIMITS = Object.freeze({ active: 8, retained: 256, lifetimeMs: 30 * 60_000, minLifetimeMs: 1000, credentialBytes: 32 } as const);
export const NATIVE_HANDOFF_AUDIENCE = 'external-handoff';
export const NATIVE_HANDOFF_SCOPES = Object.freeze(['work-coordination', 'studio-granted-commands'] as const);
export type NativeHandoffState = 'pending' | 'sealed' | 'expired' | 'revoked' | 'project_changed' | 'closed';
export type NativeHandoffErrorCode = 'INPUT' | 'LEASE' | 'STATE' | 'CAPACITY' | 'RETENTION' | 'CLOCK' | 'PROJECT' | 'CLOSED';
export class NativeHandoffError extends Error {
  constructor(readonly code: NativeHandoffErrorCode, message: string) { super(message); this.name = 'NativeHandoffError'; }
}
/** Registry-owned opaque identity. Its contents are empty; only WeakMap identity in its issuing registry counts. */
export interface NativeHandoffLease { readonly __nativeHandoffLease: never }
export interface NativeHandoffStatus {
  readonly handoffId: string; readonly state: NativeHandoffState; readonly projectId: string;
  readonly createdAt: string; readonly expiresAt: string; readonly sealedAt: string | null; readonly endedAt: string | null;
}
export interface NativeHandoffBeginReceipt extends NativeHandoffStatus {
  /** Non-enumerable: present once here, never in JSON, inspection, status, list or errors. */
  readonly credential: string; readonly lease: NativeHandoffLease;
}
export interface NativeHandoffAuthorization {
  readonly handoffId: string; readonly audience: typeof NATIVE_HANDOFF_AUDIENCE; readonly scopes: typeof NATIVE_HANDOFF_SCOPES;
  readonly projectId: string; readonly expiresAt: string;
}
interface Entry {
  readonly handoffId: string; readonly digest: string; readonly projectId: string; readonly createdMs: number; readonly expiresMs: number;
  state: NativeHandoffState; sealedMs: number | null; endedMs: number | null;
}
const fail = (code: NativeHandoffErrorCode, message: string): never => { throw new NativeHandoffError(code, message); };
const digest = (credential: string) => createHash('sha256').update('arcane-native-handoff\0' + credential).digest('hex');
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const MAX_DATE_MS = 8_640_000_000_000_000; // ECMAScript time value bound; toISOString() throws beyond it
const iso = (ms: number) => new Date(ms).toISOString();
/** Plain own data fields only: a proxy is refused before any trap; accessors are never invoked. */
function fields(value: unknown, optional: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail('INPUT', 'Expected exact plain registry options.');
  const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value as object);
  if (prototype !== Object.prototype && prototype !== null || keys.some(key => typeof key !== 'string' || !optional.includes(key as string)))
    fail('INPUT', 'Unexpected registry option.');
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) fail('INPUT', 'Registry options must be plain data.');
    Object.defineProperty(out, key, { value: field!.value, enumerable: true });
  }
  return out;
}

export class NativeHandoffRegistry {
  readonly #now: () => number;
  readonly #lifetimeMs: number;
  readonly #entries = new Map<string, Entry>();
  readonly #byDigest = new Map<string, Entry>();
  readonly #leases = new WeakMap<object, Entry>();
  #projectId: string;
  #observed: number;
  #closed = false;

  constructor(options: unknown) {
    const o = fields(options, ['projectPath', 'now', 'lifetimeMs']);
    if (typeof o.projectPath !== 'string') fail('INPUT', 'Expected the original project path.');
    if (o.now !== undefined && (typeof o.now !== 'function' || types.isProxy(o.now))) fail('INPUT', 'Expected a trusted clock function.');
    const lifetime = o.lifetimeMs ?? NATIVE_HANDOFF_LIMITS.lifetimeMs;
    if (!Number.isSafeInteger(lifetime) || (lifetime as number) < NATIVE_HANDOFF_LIMITS.minLifetimeMs || (lifetime as number) > NATIVE_HANDOFF_LIMITS.lifetimeMs)
      fail('INPUT', 'Handoff lifetime must be bounded.');
    this.#now = (o.now as (() => number) | undefined) ?? Date.now;
    this.#lifetimeMs = lifetime as number;
    this.#projectId = this.#identity(o.projectPath as string);
    this.#observed = this.#read();
  }
  #identity(projectPath: string): string {
    try { return workflowProjectIdentity(projectPath).projectId; } catch { return fail('PROJECT', 'The project identity is unavailable.'); }
  }
  #read(): number {
    let value: unknown;
    try { value = this.#now(); } catch { return fail('CLOCK', 'The trusted clock is unavailable.'); }
    // A real (including cross-realm) promise is observed before refusal; arbitrary thenables are never inspected.
    if (types.isPromise(value)) void Promise.prototype.catch.call(value, () => {});
    // Time plus the full lifetime must stay a valid Date, so begin() never admits an entry it cannot describe.
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS - this.#lifetimeMs)
      fail('CLOCK', 'The trusted clock returned an invalid time.');
    return value as number;
  }
  /** Monotonic observed time: a clock moving backward never revives an expired record. */
  #time(): number { this.#observed = Math.max(this.#observed, this.#read()); return this.#observed; }
  #end(entry: Entry, state: Exclude<NativeHandoffState, 'pending' | 'sealed'>, at: number): void {
    if (entry.state !== 'pending' && entry.state !== 'sealed') return;
    entry.state = state; entry.endedMs = at; this.#byDigest.delete(entry.digest);
  }
  #sweep(at: number): void { for (const entry of this.#entries.values()) if (at >= entry.expiresMs) this.#end(entry, 'expired', at); }
  #lease(lease: unknown): Entry {
    if (!lease || typeof lease !== 'object') fail('LEASE', 'Expected a lease issued by this registry.');
    const entry = this.#leases.get(lease as object);
    return entry ?? fail('LEASE', 'Expected a lease issued by this registry.');
  }
  #status(entry: Entry): NativeHandoffStatus {
    return Object.freeze({ handoffId: entry.handoffId, state: entry.state, projectId: entry.projectId, createdAt: iso(entry.createdMs), expiresAt: iso(entry.expiresMs),
      sealedAt: entry.sealedMs === null ? null : iso(entry.sealedMs), endedAt: entry.endedMs === null ? null : iso(entry.endedMs) });
  }
  #open(): void { if (this.#closed) fail('CLOSED', 'The handoff registry is closed.'); }

  /** Host-only. Mint one pending credential for the current original project; capacity is refused before minting. */
  begin(): NativeHandoffBeginReceipt {
    this.#open(); const at = this.#time(); this.#sweep(at);
    let active = 0; for (const entry of this.#entries.values()) if (entry.state === 'pending' || entry.state === 'sealed') active++;
    if (active >= NATIVE_HANDOFF_LIMITS.active) fail('CAPACITY', 'Too many native handoffs are active. Revoke one first.');
    if (this.#entries.size >= NATIVE_HANDOFF_LIMITS.retained) fail('RETENTION', 'The handoff record limit is reached. Restart the registry to clear it.');
    const credential = randomBytes(NATIVE_HANDOFF_LIMITS.credentialBytes).toString('base64url');
    const entry: Entry = { handoffId: randomUUID(), digest: digest(credential), projectId: this.#projectId, createdMs: at, expiresMs: at + this.#lifetimeMs,
      state: 'pending', sealedMs: null, endedMs: null };
    const lease = Object.freeze(Object.create(null)) as NativeHandoffLease;
    this.#entries.set(entry.handoffId, entry); this.#byDigest.set(entry.digest, entry); this.#leases.set(lease, entry);
    const receipt = { ...this.#status(entry) } as Record<string, unknown>;
    Object.defineProperty(receipt, 'credential', { value: credential, enumerable: false });
    Object.defineProperty(receipt, 'lease', { value: lease, enumerable: false });
    return Object.freeze(receipt) as unknown as NativeHandoffBeginReceipt;
  }
  /** Host-only, after a genuine launch acknowledgement. Exactly once; a revoked, expired or ended lease never revives. */
  seal(lease: NativeHandoffLease): NativeHandoffStatus {
    this.#open(); const entry = this.#lease(lease), at = this.#time(); this.#sweep(at);
    if (entry.state !== 'pending') fail('STATE', 'Only a pending handoff can be sealed.');
    if (entry.projectId !== this.#projectId) { this.#end(entry, 'project_changed', at); fail('PROJECT', 'The original project changed.'); }
    entry.state = 'sealed'; entry.sealedMs = at;
    return this.#status(entry);
  }
  /** Host-only explicit revoke; idempotent for an already ended record, which keeps its first terminal state. */
  revoke(lease: NativeHandoffLease): NativeHandoffStatus {
    this.#open(); const entry = this.#lease(lease), at = this.#time(); this.#sweep(at);
    this.#end(entry, 'revoked', at);
    return this.#status(entry);
  }
  /** Live authentication for one request. Returns detached metadata only; it grants nothing by itself. */
  recognize(bearer: unknown): NativeHandoffAuthorization | null {
    if (this.#closed || typeof bearer !== 'string' || !CREDENTIAL.test(bearer)) return null;
    const entry = this.#byDigest.get(digest(bearer)); if (!entry) return null;
    let at: number; try { at = this.#time(); } catch { return null; } // an invalid clock fails closed without mutation
    this.#sweep(at);
    if (entry.state !== 'sealed' || entry.projectId !== this.#projectId || at >= entry.expiresMs) return null;
    return Object.freeze({ handoffId: entry.handoffId, audience: NATIVE_HANDOFF_AUDIENCE, scopes: NATIVE_HANDOFF_SCOPES, projectId: entry.projectId, expiresAt: iso(entry.expiresMs) });
  }
  status(lease: NativeHandoffLease): NativeHandoffStatus {
    const entry = this.#lease(lease); if (!this.#closed) this.#sweep(this.#time()); return this.#status(entry);
  }
  list(): readonly NativeHandoffStatus[] {
    if (!this.#closed) this.#sweep(this.#time());
    return Object.freeze([...this.#entries.values()].map(entry => this.#status(entry)));
  }
  /** Host-only. A different canonical project identity ends every live credential immediately. */
  transitionProject(projectPath: unknown): void {
    this.#open(); if (typeof projectPath !== 'string') fail('INPUT', 'Expected a project path.');
    const next = this.#identity(projectPath as string), at = this.#time();
    if (next === this.#projectId) return;
    this.#projectId = next;
    for (const entry of this.#entries.values()) this.#end(entry, 'project_changed', at);
  }
  /** Ends every live credential. Idempotent; nothing persists. */
  close(): void {
    if (this.#closed) return;
    let at = this.#observed; try { at = this.#time(); } catch { /* close still ends every credential */ }
    for (const entry of this.#entries.values()) this.#end(entry, 'closed', at);
    this.#closed = true;
  }
  toJSON(): { closed: boolean; records: number } { return { closed: this.#closed, records: this.#entries.size }; }
}
