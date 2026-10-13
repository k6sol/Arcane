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
}
const MASK = '••••••••••••••••••••••••';
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
    const hasCopy = Object.hasOwn(entry.value, 'copy');
    const bridge = fields(entry.value, ['version', 'list', 'remember', 'reveal', 'forget', ...(hasCopy ? ['copy'] : [])]);
    return bridge?.version === 1 && Object.isFrozen(entry.value) && ['list', 'remember', 'reveal', 'forget'].every(name => typeof bridge[name] === 'function')
      && (!hasCopy || typeof bridge.copy === 'function')
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
      if (!target) return; target.addEventListener(type, fn); this.removers.push(() => target.removeEventListener(type, fn));
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
      const response = fields(await this.native.remember({ keyId: key.keyId, apiKey: key.apiKey }), ['remembered']);
      if (generation !== this.epoch || project !== this.projectId || this.stopped) return;
      if (response?.remembered !== true) throw new Error();
      this.available = true; this.saved.add(key.keyId); this.render();
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
      if (generation === this.epoch) this.notice('This key could not be shown. Check desktop storage or issue a new key.');
    } finally { if (generation === this.epoch) { this.busy = false; this.render(); } }
  }

  private async copy(): Promise<void> {
    const key = this.active();
    if (!this.open() || !key || this.busy) return;
    const generation = this.epoch, project = this.projectId;
    try {
      if (this.native?.copy && this.available && this.saved.has(key.keyId)) {
        const result = fields(await this.native.copy({ keyId: key.keyId }), ['copied']);
        if (generation !== this.epoch || project !== this.projectId || !this.open()) return;
        if (result?.copied !== true) throw new Error();
        this.notice('API key copied.'); return;
      }
      const value = this.secret || (this.fresh?.keyId === key.keyId ? this.fresh.apiKey : '');
      if (!this.validSecret(value)) { await this.show(); if (!this.validSecret(this.secret)) throw new Error(); }
      if (generation !== this.epoch || project !== this.projectId || !this.open() || this.active()?.keyId !== key.keyId) return;
      const clipboard = this.doc.defaultView?.navigator.clipboard;
      if (!clipboard) throw new Error();
      await clipboard.writeText(value || this.secret);
      if (generation === this.epoch) this.notice('API key copied.');
    } catch { if (generation === this.epoch) this.notice('Clipboard unavailable. Select the shown key to copy it.'); }
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
    this.text('settings-key-storage', active && this.available && this.saved.has(active.keyId) ? 'Saved in this project’s encrypted desktop vault.' : this.fresh?.keyId === active?.keyId && this.fresh ? 'Fresh key. Closing or navigating clears it.' : !this.native ? 'Browser keys are temporary. Existing secrets cannot be recovered here.' : !this.available ? 'Desktop key storage is unavailable.' : 'This key is not saved on this desktop.');
  }

  stop(): void { this.stopped = true; this.hide(); }
  resume(): void { this.stopped = false; this.render(); }
  cleanup(): void { this.stop(); this.observer?.disconnect(); for (const remove of this.removers.splice(0)) remove(); }
}
