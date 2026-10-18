/// <reference lib="dom" />

/** Metadata comes from the daemon. Native storage never grants Studio access. */
export interface SettingsKeyRecord {
  keyId: string; allowedRoots: readonly string[]; allowWrites: boolean;
  issuedAt: string; lastUsedAt: string | null; revokedAt: string | null;
}
interface StudioKeyBridge {
  version: 1;
  list(): Promise<unknown>;
  remember(input: { keyId: string; apiKey: string }): Promise<unknown>;
  reveal(input: { keyId: string }): Promise<unknown>;
  forget(input: { keyId: string }): Promise<unknown>;
  copy?(input: { keyId: string }): Promise<unknown>;
  replace?(input: { keyId: string; apiKey: string }): Promise<unknown>;
}
const MASK = '••••••••••••••••••••••••';
// Recovery guidance only. Nothing here regenerates, rereads or rewrites a saved key on its own.
const UNREADABLE = 'The saved key cannot be read on this desktop. Use Regenerate API key to create a new connection key.';
const COPY_FAILED = 'The saved key could not be copied. Use Show to view it, or Regenerate API key to create a new connection key.';
const keyIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

// Do not run accessors when checking a page-supplied bridge or response.
function fields(value: unknown, names: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== names.length || names.some(name => !descriptors[name]?.enumerable || !Object.hasOwn(descriptors[name]!, 'value'))) return null;
    return Object.fromEntries(names.map(name => [name, descriptors[name]!.value]));
  } catch { return null; }
}

export function readStudioKeyBridge(doc: Document): StudioKeyBridge | null {
  try {
    const root = doc.defaultView && Object.getOwnPropertyDescriptor(doc.defaultView, 'arcaneDesktop');
    if (!root || !Object.hasOwn(root, 'value') || !root.value) return null;
    const entry = Object.getOwnPropertyDescriptor(root.value, 'studioKeys');
    if (!entry || !Object.hasOwn(entry, 'value')) return null;
    const hasCopy = Object.hasOwn(entry.value, 'copy'), hasReplace = Object.hasOwn(entry.value, 'replace');
    const bridge = fields(entry.value, ['version', 'list', 'remember', 'reveal', 'forget', ...(hasCopy ? ['copy'] : []), ...(hasReplace ? ['replace'] : [])]);
    return bridge?.version === 1 && Object.isFrozen(entry.value) && ['list', 'remember', 'reveal', 'forget'].every(name => typeof bridge[name] === 'function')
      && (!hasCopy || typeof bridge.copy === 'function')
      && (!hasReplace || typeof bridge.replace === 'function')
      ? entry.value as StudioKeyBridge : null;
  } catch { return null; }
}

export function trustedKeyAction(event: Event): boolean {
  const click = event as MouseEvent;
  return event.isTrusted === true && !event.defaultPrevented && !click.altKey && !click.ctrlKey && !click.metaKey && !click.shiftKey;
}

export class StudioKeySettings {
  private readonly native: StudioKeyBridge | null;
  private readonly removers: (() => void)[] = [];
  private records: readonly SettingsKeyRecord[] = [];
  private saved = new Set<string>();
  private forgotten = new Set<string>();
  private selected = '';
  private projectId: string | null = null;
  private fresh: { keyId: string; apiKey: string } | null = null;
  private secret = '';
  private available = false;
  private busy = false;
  private epoch = 0;
  private listEpoch = 0;
  private stopped = false;
  private readonly observer: MutationObserver | null;

  constructor(private readonly doc: Document, private readonly origin: string) {
    this.native = readStudioKeyBridge(doc);
    // Older pages and focused controller fixtures may omit this optional card.
    if (!doc.getElementById('settings-key-select')) { this.observer = null; return; }
    const listen = (target: EventTarget | null, type: string, fn: (event: Event) => void) => {
      if (!target || typeof target.addEventListener !== 'function') return; target.addEventListener(type, fn); this.removers.push(() => target.removeEventListener(type, fn));
    };
    const show = this.button('settings-key-show');
    listen(show, 'click', event => { if (trustedKeyAction(event) && !show?.disabled) void this.show(); });
    const copy = this.button('settings-key-copy');
    listen(copy, 'click', event => { if (trustedKeyAction(event) && !copy?.disabled) void this.copy(); });
    const select = this.select();
    listen(select, 'change', event => {
      if (!event.isTrusted || !select) return;
      this.hide(); this.selected = this.records.some(key => key.keyId === select.value && !key.revokedAt) ? select.value : ''; this.render();
    });
    const dialog = this.doc.getElementById('settings-drawer');
    listen(dialog, 'close', () => this.hide());
    listen(doc.defaultView, 'pagehide', () => this.hide());
    listen(doc, STUDIO_PAIRED_EVENT, () => this.render());
    const Observer = doc.defaultView?.MutationObserver;
    this.observer = Observer && dialog ? new Observer(() => { if (this.open()) void this.readSaved(); else this.hide(); }) : null;
    this.observer?.observe(dialog!, { attributes: true, attributeFilter: ['open'] });
    this.render();
  }

  private button(id: string) { return this.doc.getElementById(id) as HTMLButtonElement | null; }
  private select() { return this.doc.getElementById('settings-key-select') as HTMLSelectElement | null; }
  private text(id: string, value: string) { const element = this.doc.getElementById(id); if (element) element.textContent = value; }
  private notice(value: string) { this.text('settings-key-notice', value); }
  private open() { return !this.stopped && (this.doc.getElementById('settings-drawer') as HTMLDialogElement | null)?.open === true; }
  private active() { return this.records.find(key => key.keyId === this.selected && !key.revokedAt); }
  private validSecret(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 128) return false;
    const match = /^arcane_local_v1_([1-9][0-9]{0,4})_[a-f0-9]{64}$/.exec(value);
    try { const url = new URL(this.origin); return !!match && match[0] === value && Number(match[1]) <= 65535 && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === match[1]; }
    catch { return false; }
  }

  setProject(projectId: string | null): void {
    if (projectId === this.projectId) return;
    this.hide(); this.projectId = projectId; this.records = []; this.saved.clear(); this.forgotten.clear(); this.available = false; this.selected = ''; this.render();
    if (this.open()) void this.readSaved();
  }

  setRecords(records: readonly SettingsKeyRecord[]): void {
    this.records = records;
    for (const key of records) if (key.revokedAt && !this.forgotten.has(key.keyId)) void this.forget(key.keyId);
    if (!this.active()) { this.hide(); this.selected = records.find(key => !key.revokedAt)?.keyId ?? ''; }
    if (this.fresh && !records.some(key => key.keyId === this.fresh?.keyId && !key.revokedAt)) this.fresh = null;
    this.render();
    if (this.open()) void this.readSaved();
  }

  metadataUnavailable(): void { this.hide(); this.records = []; this.selected = ''; this.render(); this.notice('Key records are unavailable. Refresh in Advanced.'); }

  /** Called only with a validated successful response to the trusted human key form. */
  async rememberIssuedKey(key: { keyId: string; apiKey: string }): Promise<void> {
    if (this.stopped || !keyIdValid(key.keyId) || !this.validSecret(key.apiKey)) return;
    const generation = this.epoch, project = this.projectId;
    this.fresh = { keyId: key.keyId, apiKey: key.apiKey }; this.selected = key.keyId; this.render();
    if (!this.native || !project) return;
    try {
      const response = fields(await (this.native.replace ?? this.native.remember)({ keyId: key.keyId, apiKey: key.apiKey }), ['remembered']);
      if (generation !== this.epoch || project !== this.projectId || this.stopped) return;
      if (response?.remembered !== true) throw new Error();
      this.available = true; if (this.native.replace) this.saved.clear(); this.saved.add(key.keyId); this.render();
    } catch {
      if (generation === this.epoch && project === this.projectId) { this.notice('Desktop storage unavailable. This fresh key is temporary.'); this.render(); }
    }
  }

  hide(): void {
    this.epoch++; this.listEpoch++; this.secret = ''; this.fresh = null; this.busy = false; this.notice(''); this.render();
  }

  async forget(keyId: string): Promise<void> {
    if (!keyIdValid(keyId)) return;
    if (this.forgotten.has(keyId)) return;
    this.forgotten.add(keyId);
    if (this.selected === keyId || this.fresh?.keyId === keyId) this.hide();
    this.saved.delete(keyId); this.render();
    if (!this.native || !this.projectId) return;
    const project = this.projectId;
    try {
      const response = fields(await this.native.forget({ keyId }), ['forgotten']);
      if (project === this.projectId && response?.forgotten !== true) this.notice('Key revoked. Desktop removal was not confirmed.');
    } catch { if (project === this.projectId) this.notice('Key revoked. Desktop removal was not confirmed.'); }
  }

  private async readSaved(): Promise<void> {
    if (!this.native || !this.projectId || !this.open()) return;
    const generation = ++this.listEpoch, project = this.projectId;
    try {
      const response = fields(await this.native.list(), ['available', 'items']);
      if (generation !== this.listEpoch || project !== this.projectId || !this.open()) return;
      if (!response || typeof response.available !== 'boolean' || !Array.isArray(response.items) || response.items.length > 32) throw new Error();
      const ids = response.items.map(value => { const row = fields(value, ['keyId']); if (!row || !keyIdValid(row.keyId)) throw new Error(); return row.keyId; });
      if (new Set(ids).size !== ids.length || (!response.available && ids.length)) throw new Error();
      this.saved = new Set(ids); this.available = response.available; this.render();
    } catch {
      if (generation === this.listEpoch && project === this.projectId) { this.saved.clear(); this.available = false; this.render(); }
    }
  }

  private async show(): Promise<void> {
    const key = this.active();
    if (!this.open() || !key || this.busy) return;
    if (this.secret) { this.secret = ''; this.epoch++; this.render(); return; }
    const generation = ++this.epoch, project = this.projectId;
    if (this.fresh?.keyId === key.keyId) { this.secret = this.fresh.apiKey; this.render(); return; }
    if (!this.native || !project || !this.available || !this.saved.has(key.keyId)) return;
    this.busy = true; this.notice(''); this.render();
    try {
      const response = fields(await this.native.reveal({ keyId: key.keyId }), ['apiKey']);
      if (generation !== this.epoch || project !== this.projectId || !this.open() || this.active()?.keyId !== key.keyId) return;
      if (!response || !this.validSecret(response.apiKey)) throw new Error();
      this.secret = response.apiKey;
    } catch {
      if (generation === this.epoch) this.notice(UNREADABLE);
    } finally { if (generation === this.epoch) { this.busy = false; this.render(); } }
  }

  private async copy(): Promise<void> {
    const key = this.active();
    if (!this.open() || !key || this.busy) return;
    const generation = this.epoch, project = this.projectId;
    // Which step failed decides the guidance: the saved key (native copy or read) versus the browser clipboard.
    let stage: 'native' | 'read' | 'clipboard' = 'native';
    try {
      if (this.native?.copy && this.available && this.saved.has(key.keyId)) {
        const result = fields(await this.native.copy({ keyId: key.keyId }), ['copied']);
        if (generation !== this.epoch || project !== this.projectId || !this.open()) return;
        if (result?.copied !== true) throw new Error();
        this.notice('API key copied.'); return;
      }
      stage = 'read';
      let value = this.secret || (this.fresh?.keyId === key.keyId ? this.fresh.apiKey : '');
      if (!this.validSecret(value)) {
        if (!this.native || !this.available || !this.saved.has(key.keyId)) throw new Error();
        const response = fields(await this.native.reveal({ keyId: key.keyId }), ['apiKey']);
        if (!response || !this.validSecret(response.apiKey)) throw new Error();
        value = response.apiKey;
      }
      if (generation !== this.epoch || project !== this.projectId || !this.open() || this.active()?.keyId !== key.keyId) return;
      stage = 'clipboard';
      const clipboard = this.doc.defaultView?.navigator.clipboard;
      if (!clipboard) throw new Error();
      await clipboard.writeText(value);
      if (generation === this.epoch) this.notice('API key copied.');
    } catch {
      if (generation !== this.epoch) return;
      this.notice(stage === 'native' ? COPY_FAILED : stage === 'read' ? UNREADABLE
        : this.secret ? 'Clipboard unavailable. Select the shown key to copy it.' : 'Clipboard unavailable. Use Show, then select the key to copy it.');
    }
  }

  private render(): void {
    const active = this.active(), select = this.select();
    if (select) {
      select.replaceChildren();
      for (const [index, key] of this.records.filter(key => !key.revokedAt).entries()) {
        const option = this.doc.createElement('option'); option.value = key.keyId;
        option.textContent = 'Studio key ' + (index + 1) + ' · ' + (key.allowWrites ? 'Editing' : 'Read-only'); select.append(option);
      }
      if (!select.options.length) { const option = this.doc.createElement('option'); option.value = ''; option.textContent = 'No active keys'; select.append(option); }
      select.value = this.selected; select.disabled = this.busy || !active;
    }
    this.text('settings-key-status', active ? 'Active' : 'No active key');
    this.text('settings-key-metadata', active ? (active.allowWrites ? 'Writes allowed' : 'Read-only') + ' · ' + active.allowedRoots.join(', ') + ' · Issued ' + new Date(active.issuedAt).toLocaleDateString() : 'Issue a key in Advanced to connect the Arcane plugin.');
    this.text('settings-key-secret', this.secret || MASK);
    this.doc.getElementById('settings-key-secret')?.setAttribute('aria-label', this.secret ? 'API key' : 'Masked API key');
    const show = this.button('settings-key-show');
    if (show) { show.textContent = this.secret ? 'Hide' : this.busy ? 'Showing…' : 'Show'; show.setAttribute('aria-pressed', String(!!this.secret)); show.disabled = !this.open() || !active || this.busy || !(this.fresh?.keyId === active.keyId || this.available && this.saved.has(active.keyId)); }
    const copy = this.button('settings-key-copy'); if (copy) copy.disabled = !this.open() || !active || this.busy || !(this.secret || this.fresh?.keyId === active.keyId || this.available && this.saved.has(active.keyId));
    this.text('settings-key-storage', active && this.available && this.saved.has(active.keyId) ? 'Saved in this project’s encrypted desktop vault.'
      : active && PAIRED_KEYS.has(active.keyId) ? 'Saved in Roblox Studio by one-click pairing. Arcane keeps no copy; Studio reconnects on its own.' : this.fresh?.keyId === active?.keyId && this.fresh ? 'Fresh key. Closing or navigating clears it.' : !this.native ? 'Browser keys are temporary. Existing secrets cannot be recovered here.' : !this.available ? (active ? UNREADABLE : 'Desktop key storage is unavailable.')
      : active ? 'This key is not saved on this desktop. Use Regenerate API key to create a new connection key.' : 'This key is not saved on this desktop.');
  }

  stop(): void { this.stopped = true; this.hide(); }
  resume(): void { this.stopped = false; this.render(); }
  cleanup(): void { this.stop(); this.observer?.disconnect(); for (const remove of this.removers.splice(0)) remove(); }
}

// ---------------------------------------------------------------------------------------------
// Two-sided Studio pairing (docs/studio-pairing.md). A trusted click asks the daemon for a short-lived,
// single-use offer with a 6-digit code that the user types into the Arcane plugin. The plugin checks that
// this Arcane knows the code before it trusts it, and the key is issued only after the user clicks Approve
// here for the place that asked. This page only ever sees the code, the asking place and, once claimed, the
// place that claimed it. The ticket and the issued key go from the daemon to the plugin and never reach it.
// ---------------------------------------------------------------------------------------------
export type PairingPhase = 'idle' | 'starting' | 'waiting' | 'busy' | 'approval' | 'approved' | 'claimed' | 'expired' | 'failed' | 'error';
export interface PairingClaimView { placeName: string; placeId: number; keyId: string }
export interface PairingRequestView { placeName: string; placeId: number; universeId: number }
export interface PairingView { phase: PairingPhase; code: string | null; expiresAt: string | null; claim: PairingClaimView | null; request: PairingRequestView | null; message: string }
export interface PairingReply {
  offer: { offerId: string; code: string; expiresAt: string; state: 'pending' | 'awaiting-approval' | 'claimed' | 'expired' | 'cancelled' | 'failed'; claim: PairingClaimView | null;
    request: (PairingRequestView & { approved: boolean }) | null } | null;
  discovery: 'idle' | 'listening' | 'unavailable';
}
const PAIRING_ROOTS = ['Workspace', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPlayer', 'Lighting'] as const;
const OFFER_STATES = ['pending', 'awaiting-approval', 'claimed', 'expired', 'cancelled', 'failed'] as const;
const IDLE_PAIRING: PairingView = Object.freeze({ phase: 'idle', code: null, expiresAt: null, claim: null, request: null, message: '' }) as PairingView;
export const PAIRING_MESSAGES = Object.freeze({
  idle: 'Click Connect Studio, then type the code it shows into the Arcane plugin in Roblox Studio.',
  approved: 'Approved. Finishing the connection in Studio…',
  denied: 'Denied. That Studio connection was refused and its code no longer works.',
  starting: 'Preparing a Studio connection…',
  busy: 'Another Arcane window is already waiting for Studio. Finish there, or use your API key instead.',
  expired: 'The Studio code expired. Click Connect Studio for a new one.',
  failed: 'Studio could not finish connecting. Click Connect Studio to try again.',
  error: 'Studio pairing is unavailable right now. Use your API key instead.',
});
/** Key IDs this page saw issued by one-click pairing; the key itself lives only in Studio's plugin settings. */
const PAIRED_KEYS = new Set<string>();
export const STUDIO_PAIRED_EVENT = 'arcane:studio-paired';
/** The code is grouped 3+3 for reading; the plugin accepts it with or without the space. */
export function spacedCode(code: string): string { return code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code; }
export function waitingText(code: string): string { return 'Waiting for Studio… In Roblox Studio, type ' + spacedCode(code) + ' into the Arcane plugin and click Connect.'; }
export function approvalText(request: PairingRequestView): string {
  return 'Roblox Studio place “' + request.placeName + '”' + (request.placeId ? ' (place ' + request.placeId + ')' : '') +
    ' wants to connect. Approve only if this is your place and Studio shows “Approve in Arcane”.';
}

const plainText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));

/** Copies a daemon pairing reply into fixed fields. Anything unexpected throws. */
export function readPairingReply(value: unknown): PairingReply {
  const reply = fields(value, ['offer', 'discovery']);
  if (!reply) throw new Error('Invalid pairing reply.');
  const discovery = fields(reply.discovery, ['state', 'port']);
  if (!discovery || !['idle', 'listening', 'unavailable'].includes(discovery.state as string) || !(discovery.port === null || Number.isInteger(discovery.port))) throw new Error('Invalid pairing discovery.');
  if (reply.offer === null) return { offer: null, discovery: discovery.state as PairingReply['discovery'] };
  const offer = fields(reply.offer, ['offerId', 'code', 'issuedAt', 'expiresAt', 'state', 'allowedRoots', 'allowWrites', 'claim', 'request']);
  if (!offer || !keyIdValid(offer.offerId) || typeof offer.code !== 'string' || !/^[0-9]{6}$/.test(offer.code) || !timestamp(offer.issuedAt) || !timestamp(offer.expiresAt)
    || !OFFER_STATES.includes(offer.state as typeof OFFER_STATES[number]) || typeof offer.allowWrites !== 'boolean' || !Array.isArray(offer.allowedRoots)) throw new Error('Invalid pairing offer.');
  let claim: PairingClaimView | null = null;
  if (offer.claim !== null) {
    const c = fields(offer.claim, ['placeName', 'placeId', 'universeId', 'sessionId', 'keyId', 'claimedAt']);
    if (!c || !plainText(c.placeName, 200) || !Number.isSafeInteger(c.placeId) || (c.placeId as number) < 0 || !keyIdValid(c.keyId)) throw new Error('Invalid pairing claim.');
    claim = { placeName: c.placeName, placeId: c.placeId as number, keyId: c.keyId };
  }
  if ((offer.state === 'claimed') !== (claim !== null)) throw new Error('Invalid pairing claim state.');
  let request: (PairingRequestView & { approved: boolean }) | null = null;
  if (offer.request !== null) {
    const r = fields(offer.request, ['placeName', 'placeId', 'universeId', 'requestedAt', 'approved']);
    if (!r || !plainText(r.placeName, 200) || !Number.isSafeInteger(r.placeId) || (r.placeId as number) < 0 || !Number.isSafeInteger(r.universeId) || typeof r.approved !== 'boolean') throw new Error('Invalid pairing request.');
    request = { placeName: r.placeName, placeId: r.placeId as number, universeId: r.universeId as number, approved: r.approved };
  }
  if ((offer.state === 'awaiting-approval') !== (request !== null)) throw new Error('Invalid pairing request state.');
  return { offer: { offerId: offer.offerId, code: offer.code, expiresAt: offer.expiresAt, state: offer.state as typeof OFFER_STATES[number], claim, request }, discovery: discovery.state as PairingReply['discovery'] };
}

/** Pure: what the Settings card and the checklist show for a reply. */
export function pairingView(reply: PairingReply): PairingView {
  const offer = reply.offer;
  if (!offer || offer.state === 'cancelled') return IDLE_PAIRING;
  if (offer.state === 'pending') return reply.discovery === 'unavailable'
    ? { phase: 'busy', code: null, expiresAt: offer.expiresAt, claim: null, request: null, message: PAIRING_MESSAGES.busy }
    : { phase: 'waiting', code: offer.code, expiresAt: offer.expiresAt, claim: null, request: null, message: waitingText(offer.code) };
  if (offer.state === 'awaiting-approval' && offer.request) {
    const request = { placeName: offer.request.placeName, placeId: offer.request.placeId, universeId: offer.request.universeId };
    return offer.request.approved
      ? { phase: 'approved', code: null, expiresAt: offer.expiresAt, claim: null, request, message: PAIRING_MESSAGES.approved }
      : { phase: 'approval', code: null, expiresAt: offer.expiresAt, claim: null, request, message: approvalText(request) };
  }
  if (offer.state === 'claimed' && offer.claim) return { phase: 'claimed', code: offer.code, expiresAt: null, claim: offer.claim, request: null,
    message: 'Connected to ' + offer.claim.placeName + (offer.claim.placeId ? ' (place ' + offer.claim.placeId + ')' : '') + '. Not you? Revoke it.' };
  return { phase: offer.state === 'expired' ? 'expired' : 'failed', code: null, expiresAt: null, claim: null, request: null, message: offer.state === 'expired' ? PAIRING_MESSAGES.expired : PAIRING_MESSAGES.failed };
}

export class StudioPairing {
  private current: PairingView = IDLE_PAIRING;
  private offerId: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly removers: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private busy = false;
  private stopped = false;

  constructor(private readonly doc: Document, private readonly origin: string, private readonly token: string,
    private readonly fetcher: (input: string, init: RequestInit) => Promise<Response> = (input, init) => doc.defaultView!.fetch(input, init)) {
    const listen = (id: string, fn: () => void) => {
      const target = doc.getElementById(id); if (!target) return;
      const handler = (event: Event) => { if (trustedKeyAction(event) && !(target as HTMLButtonElement).disabled) fn(); };
      target.addEventListener('click', handler); this.removers.push(() => target.removeEventListener('click', handler));
    };
    listen('studio-pair-start', () => void this.start());
    listen('key-setup-pair', () => void this.start());
    listen('studio-pair-cancel', () => void this.cancel());
    listen('studio-pair-revoke', () => void this.revokeClaim());
    listen('studio-pair-approve', () => void this.decide(true));
    listen('studio-pair-deny', () => void this.decide(false));
    this.render();
  }

  view(): PairingView { return { ...this.current, claim: this.current.claim ? { ...this.current.claim } : null, request: this.current.request ? { ...this.current.request } : null }; }
  available(): boolean { return !!this.token && !this.stopped; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  private async call(path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit',
      headers: { Authorization: 'Bearer ' + this.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetcher(this.origin + path, init);
    if (!response.ok) throw new Error('Pairing request failed.');
    return response.json();
  }
  private set(next: PairingView): void {
    this.current = next;
    if (next.claim && !PAIRED_KEYS.has(next.claim.keyId)) {
      PAIRED_KEYS.add(next.claim.keyId);
      const Custom = this.doc.defaultView?.CustomEvent; if (Custom) this.doc.dispatchEvent(new Custom(STUDIO_PAIRED_EVENT));
    }
    this.render();
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* Observers cannot break pairing. */ } }
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || !['waiting', 'busy', 'approval', 'approved'].includes(this.current.phase)) return;
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, 2000);
  }

  /** Trusted human intent only (Connect Studio, or right after a plugin install). Replaces any older offer. */
  async start(): Promise<void> {
    if (!this.available() || this.busy) return;
    const generation = ++this.epoch; this.busy = true;
    this.set({ ...IDLE_PAIRING, phase: 'starting', message: PAIRING_MESSAGES.starting });
    try {
      const reply = readPairingReply(await this.call('/v1/studio/pairing-offer', { allowedRoots: [...PAIRING_ROOTS], allowWrites: true }));
      if (generation === this.epoch && !this.stopped) { this.offerId = reply.offer?.offerId ?? null; this.set(pairingView(reply)); }
    } catch { if (generation === this.epoch && !this.stopped) this.set({ ...IDLE_PAIRING, phase: 'error', message: PAIRING_MESSAGES.error }); }
    finally { if (generation === this.epoch) { this.busy = false; this.render(); this.schedule(); } }
  }
  async refresh(): Promise<void> {
    if (!this.available()) return;
    const generation = this.epoch;
    try {
      const reply = readPairingReply(await this.call('/v1/studio/pairing-offer'));
      if (generation === this.epoch && !this.stopped && !this.busy) { this.offerId = reply.offer?.offerId ?? null; this.set(pairingView(reply)); }
    } catch { /* A missed read keeps the last view; the next poll retries. */ }
    finally { if (generation === this.epoch) this.schedule(); }
  }
  async cancel(): Promise<void> {
    if (!this.available() || this.busy || !['waiting', 'busy', 'approval', 'approved'].includes(this.current.phase)) return;
    const generation = ++this.epoch; this.busy = true; this.render();
    try { await this.call('/v1/studio/pairing-offer/cancel', {}); if (generation === this.epoch) this.set(IDLE_PAIRING); }
    catch { if (generation === this.epoch) this.set({ ...this.current, message: 'The Studio code could not be cancelled. It expires on its own within 10 minutes.' }); }
    finally { if (generation === this.epoch) { this.busy = false; this.render(); this.schedule(); } }
  }
  /** Trusted human click only: Approve or Deny the place now waiting on this exact offer. The key is issued only after Approve. */
  async decide(approve: boolean): Promise<void> {
    const offerId = this.offerId;
    if (!this.available() || this.busy || this.current.phase !== 'approval' || !offerId) return;
    const generation = ++this.epoch; this.busy = true; this.render();
    try {
      const reply = readPairingReply(await this.call('/v1/studio/pairing-offer/decide', { offerId, approve }));
      if (generation === this.epoch) { this.offerId = reply.offer?.offerId ?? null; this.set(approve ? pairingView(reply) : { ...IDLE_PAIRING, message: PAIRING_MESSAGES.denied }); }
    } catch { if (generation === this.epoch) this.set({ ...this.current, message: 'That decision could not be saved. The Studio connection was not approved.' }); }
    finally { if (generation === this.epoch) { this.busy = false; this.render(); this.schedule(); } }
  }
  /** Not you? Revokes the key the claim created, which also revokes its Studio session. */
  async revokeClaim(): Promise<void> {
    const claim = this.current.claim;
    if (!this.available() || this.busy || !claim) return;
    const generation = ++this.epoch; this.busy = true; this.render();
    try {
      const reply = fields(await this.call('/v1/studio/keys/revoke', { keyId: claim.keyId }), ['revoked']);
      if (reply?.revoked !== true) throw new Error();
      if (generation === this.epoch) this.set({ ...IDLE_PAIRING, message: 'That Studio connection was revoked. Its key no longer works.' });
    } catch { if (generation === this.epoch) this.set({ ...this.current, message: 'The revocation could not be confirmed. Check the Studio keys in Advanced.' }); }
    finally { if (generation === this.epoch) { this.busy = false; this.render(); } }
  }

  private render(): void {
    const view = this.current, waiting = ['waiting', 'busy', 'approval', 'approved'].includes(view.phase);
    const start = this.doc.getElementById('studio-pair-start') as HTMLButtonElement | null;
    if (start) { start.disabled = !this.available() || this.busy; start.textContent = waiting ? 'New code' : 'Connect Studio'; }
    const setupPair = this.doc.getElementById('key-setup-pair') as HTMLButtonElement | null;
    if (setupPair) setupPair.disabled = !this.available() || this.busy;
    const cancel = this.doc.getElementById('studio-pair-cancel') as HTMLButtonElement | null;
    if (cancel) { cancel.hidden = !waiting; cancel.disabled = this.busy; }
    const revoke = this.doc.getElementById('studio-pair-revoke') as HTMLButtonElement | null;
    if (revoke) { revoke.hidden = view.phase !== 'claimed'; revoke.disabled = this.busy; }
    for (const id of ['studio-pair-approve', 'studio-pair-deny']) {
      const button = this.doc.getElementById(id) as HTMLButtonElement | null;
      if (button) { button.hidden = view.phase !== 'approval'; button.disabled = this.busy || !this.available(); }
    }
    const code = this.doc.getElementById('studio-pair-code');
    if (code) {
      const shown = view.phase === 'waiting' && !!view.code; code.hidden = !shown; code.textContent = shown && view.code ? spacedCode(view.code) : '';
      const row = code.closest('.settings-secret-row') as HTMLElement | null; if (row) row.hidden = !shown;
    }
    const status = this.doc.getElementById('studio-pair-status');
    if (status) status.textContent = view.message || (this.available() ? PAIRING_MESSAGES.idle : '');
  }

  stop(): void { this.stopped = true; this.epoch++; this.busy = false; if (this.timer) clearTimeout(this.timer); this.timer = null; this.render(); }
  resume(): void { if (!this.stopped) return; this.stopped = false; this.render(); void this.refresh(); }
  cleanup(): void { this.stop(); this.listeners.clear(); for (const remove of this.removers.splice(0)) remove(); }
}
