/// <reference lib="dom" />
import type { ProviderConnectionStatus } from './codex-chat.js';

export type SetupProvider = 'codex' | 'claude';
export interface ProviderSetupState {
  version: 1; provider: SetupProvider; installed: boolean;
  auth: 'unknown' | 'signed-out' | 'subscription' | 'api-or-cloud';
  cliVersion: string | null; busy: boolean; message: string | null;
}
export interface ProviderSetupBridge {
  version: 1;
  status(provider: SetupProvider): Promise<unknown>;
  login(provider: SetupProvider): Promise<unknown>;
  install(provider: SetupProvider): Promise<unknown>;
  launch(provider: SetupProvider): Promise<unknown>;
}
export interface ProviderSetupOptions {
  chat: { providerConnectionStatus(): ProviderConnectionStatus | null; subscribeProviderStateChange(listener: () => void): () => void };
  nativeBridge?: unknown;
}
export interface ProviderSetupController {
  /** Selected provider's fresh native sign-in evidence; grants no native authority. */
  isSignedIn(): boolean;
  /** Boolean transitions only; read isSignedIn() once when subscribing. */
  subscribeSignInChange(listener: () => void): () => void;
  stop(): void;
  resume(): void;
  cleanup(): void;
}
// Origin-local presentation only. Never persist native status, accounts or authority.
export const PROVIDER_PRESENTATION_KEY = 'arcane.provider-presentation.v1';
export const PROVIDER_PREFERENCE_EVENT = 'workspace:providerpreference';
const providers = (value: unknown): value is SetupProvider => value === 'codex' || value === 'claude';
function data(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    }
    return value as Record<string, unknown>;
  } catch { return null; }
}
export function readProviderSetupState(value: unknown, provider: SetupProvider): ProviderSetupState {
  const state = data(value, ['version', 'provider', 'installed', 'auth', 'cliVersion', 'busy', 'message']);
  const bounded = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);
  if (!state || state.version !== 1 || state.provider !== provider || typeof state.installed !== 'boolean' || typeof state.busy !== 'boolean' ||
      typeof state.auth !== 'string' || !['unknown', 'signed-out', 'subscription', 'api-or-cloud'].includes(state.auth) ||
      !(state.cliVersion === null || bounded(state.cliVersion, 100)) || !(state.message === null || bounded(state.message, 2048)) ||
      (!state.installed && (state.cliVersion !== null || state.auth !== 'unknown'))) throw Error('Native provider status unavailable.');
  return Object.freeze({ ...state }) as unknown as ProviderSetupState;
}
function bridge(doc: Document, options: ProviderSetupOptions): ProviderSetupBridge | null {
  try {
    let value = options.nativeBridge;
    if (!Object.hasOwn(options, 'nativeBridge')) {
      const window = doc.defaultView;
      if (!window) return null;
      const root = Object.getOwnPropertyDescriptor(window, 'arcaneDesktop');
      if (!root || !Object.hasOwn(root, 'value')) return null;
      const descriptor = Object.getOwnPropertyDescriptor(root.value, 'providerSetup');
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      value = descriptor.value;
    }
    const state = data(value, ['version', 'status', 'login', 'install', 'launch']);
    return state && Object.isFrozen(value) && state.version === 1 && ['status', 'login', 'install', 'launch'].every(key => typeof state[key] === 'function') ? value as ProviderSetupBridge : null;
  } catch { return null; }
}
export function readProviderPresentation(value: unknown): SetupProvider | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  try {
    const state = data(JSON.parse(value), ['version', 'provider']);
    return state?.version === 1 && providers(state.provider) ? state.provider : null;
  } catch { return null; }
}
function presentationStorage(doc: Document): Storage | null {
  try {
    const window = doc.defaultView;
    return window && ['http:', 'https:'].includes(window.location.protocol) && window.location.origin !== 'null' ? window.localStorage : null;
  } catch { return null; }
}
/** Mount, selection and resume never probe, log in, connect, install or launch. */
export function startProviderSetup(doc: Document, options: ProviderSetupOptions): ProviderSetupController {
  const panel = doc.getElementById('provider-setup-panel'), gate = doc.getElementById('provider-login-gate');
  const select = doc.getElementById('provider-setup-provider') as HTMLSelectElement | null;
  if (!panel || !gate || !select) return {
    isSignedIn: () => false, subscribeSignInChange: (_listener: () => void) => () => {},
    stop() {}, resume() {}, cleanup() {},
  };
  const native = bridge(doc, options), storage = presentationStorage(doc);
  const states = new Map<SetupProvider, { state: ProviderSetupState; observed: number }>(), awaitingStatus = new Set<SetupProvider>();
  const removers: (() => void)[] = [];
  let provider: SetupProvider = 'codex', epoch = 0, stopped = false, disposed = false, busy = false, actionError: string | null = null;
  let loginWatch: { provider: SetupProvider; epoch: number; remaining: number } | null = null;
  let loginTimer: ReturnType<typeof setTimeout> | null = null;
  let signInTimer: ReturnType<typeof setTimeout> | null = null, lastSignedIn = false;
  let claudeSignInObserved: number | null = null;
  const signInListeners = new Set<() => void>();
  const clearSignInTimer = () => { if (signInTimer !== null) clearTimeout(signInTimer); signInTimer = null; };
  const clearLoginWatch = () => { if (loginTimer !== null) clearTimeout(loginTimer); loginTimer = null; loginWatch = null; };
  try { provider = readProviderPresentation(storage?.getItem(PROVIDER_PRESENTATION_KEY)) ?? 'codex'; } catch { /* Storage denial cannot block setup. */ }
  const el = (id: string) => doc.getElementById(id), button = (id: string) => el(id) as HTMLButtonElement | null;
  const set = (id: string, value: string) => { const node = el(id); if (node) node.textContent = value; };
  const status = () => {
    const entry = states.get(provider), age = entry ? Date.now() - entry.observed : -1;
    return entry && age >= 0 && age <= 60000 ? entry.state : undefined;
  };
  const needsDisconnect = () => {
    const connection = options.chat.providerConnectionStatus();
    return provider === 'codex' && connection?.fresh && connection.connected && (connection.auth !== 'subscription' || !connection.ready) && status()?.auth === 'subscription';
  };
  const connected = () => {
    const connection = options.chat.providerConnectionStatus();
    return provider === 'codex' && connection?.fresh && connection.ready && connection.connected && connection.auth === 'subscription';
  };
  const isSignedIn = (): boolean => {
    if (stopped || disposed) return false;
    if (provider === 'codex') return !!connected();
    const age = claudeSignInObserved === null ? -1 : Date.now() - claudeSignInObserved;
    return age >= 0 && age <= 60000 && status()?.auth === 'subscription';
  };
  const notifySignInChange = () => {
    const signedIn = isSignedIn();
    if (signedIn === lastSignedIn) return;
    lastSignedIn = signedIn;
    for (const listener of [...signInListeners]) {
      try { listener(); } catch { /* Presentation observers cannot interrupt native setup. */ }
    }
  };
  const nextAction = (): 'disconnect' | 'connect' | 'status' | 'login' | 'launch' => {
    if (needsDisconnect()) return 'disconnect';
    const state = status(), connection = options.chat.providerConnectionStatus();
    if (provider === 'codex' && (state?.auth === 'subscription' || connection?.fresh && connection.auth === 'subscription')) return 'connect';
    if (provider === 'claude' && state?.auth === 'subscription') return 'launch';
    return awaitingStatus.has(provider) ? 'status' : 'login';
  };
  const render = () => {
    const state = status(), connection = options.chat.providerConnectionStatus(), name = provider === 'codex' ? 'ChatGPT' : 'Claude Code';
    select.value = provider;
    panel.setAttribute('aria-busy', String(busy)); gate.setAttribute('aria-busy', String(busy));
    for (const [id, value] of [['provider-login-codex', 'codex'], ['provider-login-claude', 'claude']] as const) button(id)?.setAttribute('aria-pressed', String(provider === value));
    gate.hidden = !!connected(); el('workspace-stage')?.classList.toggle('provider-required', !gate.hidden);
    const text = connected() ? 'Codex connected.' : state?.auth === 'subscription' ? name + ' signed in.' :
      state?.auth === 'signed-out' || provider === 'codex' && connection?.fresh && connection.auth === 'signed-out' ? 'Sign in with ' + name + '.' :
      state?.auth === 'api-or-cloud' ? 'API or cloud account.' : state && !state.installed ? 'CLI unavailable.' : native ? 'Sign-in not checked.' : 'Desktop setup unavailable.';
    set('provider-setup-status', actionError ?? text);
    set('provider-setup-details', (actionError ?? state?.message ?? (native ? provider === 'codex' ? 'Sign in with ChatGPT in your browser. Arcane reuses an existing native ChatGPT sign-in.' :
      'Claude Code sign-in opens in its native terminal. Check status after signing in.' : 'Native sign-in requires the Arcane desktop app.')) +
      (state?.cliVersion ? ' Version ' + state.cliVersion + '.' : '') + (state?.auth === 'api-or-cloud' ? ' API or cloud billing was reported; no request was started.' : ''));
    set('provider-login-message', actionError ?? (!native ? 'Open the desktop app to sign in.' : needsDisconnect() ? 'Reconnect to use your signed-in account.' :
      state?.message ?? (
      provider === 'claude' ? 'Claude Code opens in its native terminal.' : awaitingStatus.has(provider) ? 'Finish native sign-in, then check status.' :
      state?.auth === 'subscription' || connection?.fresh && connection.auth === 'subscription' ? 'Use your signed-in ChatGPT account.' : 'Sign in with ChatGPT in your browser.')));
    set('provider-setup-login', 'Sign in with ' + name);
    for (const id of ['provider-setup-refresh', 'provider-setup-login', 'provider-setup-install', 'provider-setup-launch']) {
      const control = button(id); if (control) control.disabled = stopped || disposed || busy || !native;
    }
    const launch = button('provider-setup-launch'); if (launch) launch.hidden = provider !== 'claude';
    const login = button('provider-login-start');
    if (login) {
      const action = nextAction(); login.hidden = false;
      login.textContent = busy ? 'Please wait…' : action === 'disconnect' ? 'Disconnect old session' : action === 'connect' ? 'Connect Codex' :
        action === 'status' ? 'Check sign-in' : action === 'launch' ? 'Open Claude Code' : 'Sign in with ' + name;
      login.disabled = stopped || disposed || busy || !native || state?.installed === false;
    }
    // Keep the integration hook; the card offers status through its one primary action.
    const refresh = button('provider-login-refresh'); if (refresh) { refresh.hidden = true; refresh.disabled = stopped || disposed || busy || !native; }
    clearSignInTimer();
    if (provider === 'claude' && isSignedIn() && claudeSignInObserved !== null) {
      // Freshness expiry is a local presentation change, never a native probe.
      signInTimer = setTimeout(() => { signInTimer = null; render(); }, Math.max(1, claudeSignInObserved + 60001 - Date.now()));
    }
    notifySignInChange();
  };
  const requestSettings = (target: string) => { const Event = doc.defaultView?.CustomEvent; if (Event) doc.dispatchEvent(new Event('workspace:settingsrequest', { detail: { target } })); };
  const choose = (next: SetupProvider, publish = true) => {
    if (next !== provider) clearLoginWatch();
    if (stopped || disposed) return;
    if (next !== provider) { provider = next; epoch++; actionError = null; }
    try { storage?.setItem(PROVIDER_PRESENTATION_KEY, JSON.stringify({ version: 1, provider })); } catch { /* Only presentation is lost. */ }
    render();
    const Event = doc.defaultView?.CustomEvent;
    if (publish && Event) doc.dispatchEvent(new Event(PROVIDER_PREFERENCE_EVENT, { detail: { provider } }));
  };
  const listen = (target: EventTarget, event: string, handler: (event: Event) => void) => { target.addEventListener(event, handler); removers.push(() => target.removeEventListener(event, handler)); };
  const trusted = (event: Event) => { const mouse = event as MouseEvent; return event.isTrusted === true && !event.defaultPrevented && !mouse.altKey && !mouse.ctrlKey && !mouse.metaKey && !mouse.shiftKey; };
  const invoke = async (action: 'status' | 'login' | 'install' | 'launch') => {
    if (!native || busy || stopped || disposed) return;
    const target = provider, generation = epoch; busy = true; actionError = null; render();
    let connectAfterLogin = false;
    try {
      const value = readProviderSetupState(await native[action](target), target);
      if (!stopped && !disposed && generation === epoch) {
        states.set(target, { state: value, observed: Date.now() });
        if (target === 'claude') {
          if (value.auth !== 'subscription') claudeSignInObserved = null;
          else if (action === 'status' && !value.busy) claudeSignInObserved = Date.now();
          // Install/launch snapshots and busy replies may contain cached auth.
          // They cannot renew evidence from an actual native status check.
        }
        if (action === 'login' && value.installed && value.auth === 'unknown') awaitingStatus.add(target);
        else if (action === 'status' && !value.busy) awaitingStatus.delete(target);
        if (target === 'codex' && action === 'login' && value.busy) loginWatch = { provider: target, epoch: generation, remaining: 450 };
        const watching = loginWatch?.provider === target && loginWatch.epoch === generation;
        connectAfterLogin = target === 'codex' && value.auth === 'subscription' && !value.busy && (action === 'login' || watching);
        if (watching && !value.busy) clearLoginWatch();
      }
    } catch {
      if (!stopped && !disposed && generation === epoch) { clearLoginWatch(); states.delete(target); if (target === 'claude') claudeSignInObserved = null; awaitingStatus.delete(target); actionError = 'Setup unavailable. Try again in Settings.'; }
    } finally {
      busy = false; if (!disposed) render();
      if (!stopped && !disposed && generation === epoch && target === provider) {
        // This follows only the user's explicit sign-in intent, not startup or
        // cached preferences. Connecting reads account/models, never a turn.
        if (connectAfterLogin && !needsDisconnect() && !connected()) {
          const connect = button('codex-connect'); if (connect && !connect.disabled) connect.click();
        }
        if (loginWatch?.provider === target && loginWatch.epoch === epoch && loginWatch.remaining > 0) {
          if (loginTimer !== null) clearTimeout(loginTimer);
          loginWatch.remaining--;
          loginTimer = setTimeout(() => { loginTimer = null; void invoke('status'); }, 2000);
        } else if (loginWatch && loginWatch.remaining <= 0) clearLoginWatch();
      }
    }
  };
  for (const [id, action] of [['provider-setup-refresh', 'status'], ['provider-setup-login', 'login'], ['provider-setup-install', 'install'], ['provider-setup-launch', 'launch'], ['provider-login-refresh', 'status']] as const) {
    const control = button(id); if (control) listen(control, 'click', event => { if (trusted(event) && !control.disabled) void invoke(action); });
  }
  for (const [id, next] of [['provider-login-codex', 'codex'], ['provider-login-claude', 'claude']] as const) {
    const control = button(id); if (control) listen(control, 'click', event => { if (trusted(event)) choose(next); });
  }
  listen(select, 'change', event => { if (event.isTrusted && providers(select.value)) choose(select.value); });
  const login = button('provider-login-start');
  if (login) listen(login, 'click', event => {
    if (!trusted(event) || login.disabled || busy || stopped || disposed || !native || status()?.installed === false) return;
    const action = nextAction();
    if (action === 'disconnect') { const disconnect = button('codex-disconnect'); if (disconnect && !disconnect.disabled) disconnect.click(); return; }
    if (action === 'connect') { const connect = button('codex-connect'); if (connect && !connect.disabled) connect.click(); else requestSettings('native-conversation-settings'); }
    else void invoke(action);
  });
  // Exact presentation event only. This never grants native authority or probes status.
  // The chat preference owner restores this event and saves the whole native payload.
  // Do not read/save workspacePreferences here: independent saves would clobber tabs.
  listen(doc, PROVIDER_PREFERENCE_EVENT, event => {
    const value = data((event as CustomEvent).detail, ['provider']);
    if (value && providers(value.provider)) choose(value.provider, false);
  });
  listen(doc, 'workspace:providersetup', event => {
    const value = data((event as CustomEvent).detail, ['provider']);
    if (value && providers(value.provider)) {
      choose(value.provider);
      let parent: HTMLElement | null = panel.parentElement;
      while (parent) { if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true; parent = parent.parentElement; }
      requestSettings('provider-setup-panel'); if (!panel.closest('dialog:not([open])')) select.focus();
    }
  });
  removers.push(options.chat.subscribeProviderStateChange(render)); render();
  return {
    isSignedIn,
    subscribeSignInChange(listener: () => void) {
      if (disposed) return () => {};
      signInListeners.add(listener);
      return () => { signInListeners.delete(listener); };
    },
    stop() { stopped = true; epoch++; clearLoginWatch(); states.clear(); claudeSignInObserved = null; awaitingStatus.clear(); render(); },
    resume() { if (disposed) return; stopped = false; epoch++; render(); },
    cleanup() { if (disposed) return; disposed = true; stopped = true; epoch++; clearLoginWatch(); clearSignInTimer(); states.clear(); claudeSignInObserved = null; awaitingStatus.clear(); notifySignInChange(); signInListeners.clear(); for (const remove of removers.splice(0)) remove(); },
  };
}
