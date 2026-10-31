/// <reference lib="dom" />
import type { ProviderConnectionStatus } from './codex-chat.js';
import { userError, userErrorText } from './user-errors.js';

export type SetupProvider = 'codex' | 'claude';
/** 'arcane' is the Arcane Credits chat: it owns the surface only while the user chose it and it reports availability. */
export type ChatSurface = 'codex' | 'claude' | 'arcane';
/**
 * All providers share one chat surface (tabs strip, transcript, composer and model picker). Only these
 * provider-specific nodes swap: Codex's are hidden (never removed) while the Claude or Arcane chat owns the surface.
 */
export const CODEX_SURFACE_SELECTORS = ['#codex-notice', '#codex-status', '#workspace-chat-tabs', '#workspace-saved-chats'] as const;
/** Claude's counterparts, shown while the Claude chat (or the Arcane chat, which renders into the same nodes) owns the shared surface. */
export const CLAUDE_SURFACE_SELECTORS = ['#claude-chat-notice', '#claude-chat-status', '#claude-chat-tabs', '#claude-saved-chats'] as const;
export interface ClaudeSetupChoices {
  cliVersion: string; aliases: readonly string[]; efforts: readonly string[];
}
export interface ProviderSetupState {
  version: 1; provider: SetupProvider; installed: boolean;
  auth: 'unknown' | 'signed-out' | 'subscription' | 'api-or-cloud';
  cliVersion: string | null; busy: boolean; message: string | null;
  /** Native CLI help metadata; aliases do not establish model entitlement. */
  claudeChoices?: ClaudeSetupChoices | null;
}
export interface ProviderSetupBridge {
  version: 1;
  status(provider: SetupProvider): Promise<unknown>;
  login(provider: SetupProvider): Promise<unknown>;
  install(provider: SetupProvider): Promise<unknown>;
  launch(provider: SetupProvider): Promise<unknown>;
}
export interface ProviderSetupOptions {
  /** Sign in once: at startup, use the other provider when it already reports a saved sign-in and the selected one does not. */
  autoSelectSignedIn?: boolean;
  chat: {
    providerConnectionStatus(): ProviderConnectionStatus | null;
    subscribeProviderStateChange(listener: () => void): () => void;
    /** Refresh native API state and connect metadata only; never create a thread or turn. */
    connectForSavedLogin?(isCurrent?: () => boolean): Promise<void>;
  };
  nativeBridge?: unknown;
  /**
   * First-launch sign-in page (presentation only, never authority). Until this profile has shown a usable sign-in, a
   * saved native login alone does not open the workspace: the page stays (or 'checking' while metadata connects). The page
   * offers Continue without signing in (remembered); signInSkipped()/showSignIn() let the checklist reopen it.
   */
  signInPage?: boolean;
}
/**
 * What the chat already knows about the chosen provider: `signedIn` when its own fresh status lists models for a signed-in
 * account (the model list only offers those). Presentation only: it keeps that chat on screen instead of flashing the
 * sign-in card while native status is read again; a signed-out reply still shows the card. It grants no authority.
 */
export interface ProviderChoiceHint { signedIn?: boolean }
export interface ProviderSetupController {
  /** Selected provider's fresh native sign-in evidence; grants no native authority. */
  isSignedIn(): boolean;
  /** Boolean transitions only; read isSignedIn() once when subscribing. */
  subscribeSignInChange(listener: () => void): () => void;
  /** Current Claude CLI choices; null when status, sign-in or provider selection is stale. */
  handoffChoices(): ClaudeSetupChoices | null;
  subscribeHandoffChoices(listener: () => void): () => void;
  /** Which provider owns the shared in-app chat surface: Codex, Claude after a signed-in Claude status, or Arcane Credits. */
  chatSurface(): ChatSurface;
  subscribeChatSurface(listener: () => void): () => void;
  /**
   * Explicit provider choice from in-app UI (the composer model list): persists it like the Settings choice, ends
   * startup auto-selection and reads that provider's native status. It grants no authority; the Claude surface still
   * waits for a signed-in Claude status. Returns false when setup is stopped.
   */
  requestProvider(next: SetupProvider | 'arcane', hint?: ProviderChoiceHint): boolean;
  /**
   * The Arcane Credits chat reports whether it can be used (gateway configured, account connected, models listed).
   * Until it says true, choosing Arcane is refused and the surface never becomes 'arcane'.
   */
  setArcaneAvailable(available: boolean): void;
  /**
   * Presentation only: why Arcane Credits are not usable yet ('none': no Arcane Credits service is configured for this
   * copy of Arcane; 'signed-out': it is, but no Arcane account is connected). The sign-in card explains the next step.
   */
  setArcaneSetup?(state: ArcaneCreditsSetup): void;
  /** The currently selected provider (not proof of sign-in). */
  selectedProvider(): SetupProvider;
  /** Presentation only: the user chose Continue without signing in on the sign-in page (cleared by a usable sign-in). */
  signInSkipped?(): boolean;
  /** Reopens the sign-in page after Continue without signing in; true when the page is now showing. Grants nothing. */
  showSignIn?(): boolean;
  stop(): void;
  resume(): void;
  cleanup(): void;
}
// Origin-local presentation only. Never persist native status, accounts or authority.
export const PROVIDER_PRESENTATION_KEY = 'arcane.provider-presentation.v1';
/** Presentation only: the first-launch sign-in page ended with a usable sign-in, or the user chose to explore without one. */
export const SIGN_IN_PAGE_KEY = 'arcane.sign-in-page.v1';
export type SignInPageMemory = 'none' | 'signed-in' | 'skipped';
export function readSignInPage(value: unknown): SignInPageMemory {
  if (typeof value !== 'string' || value.length > 80) return 'none';
  try {
    const state = data(JSON.parse(value), ['version', 'state']);
    const memory = state?.version === 1 ? state.state : null;
    return memory === 'signed-in' || memory === 'skipped' ? memory : 'none';
  } catch { return 'none'; }
}
export const PROVIDER_PREFERENCE_EVENT = 'workspace:providerpreference';
/** Presentation only: the user last chose the Arcane Credits chat (no account data, no authority). */
export const ARCANE_SURFACE_KEY = 'arcane.chat-surface.v1';
export type ArcaneCreditsSetup = 'none' | 'signed-out';
/** The sign-in card's line for people without a ChatGPT or Claude subscription, by Arcane Credits readiness. */
export const ARCANE_CREDITS_OFFER = Object.freeze({
  ready: { note: 'No ChatGPT or Claude subscription? Build with Arcane Credits instead.', action: 'Use Arcane Credits' },
  'signed-out': { note: 'No ChatGPT or Claude subscription? Connect your Arcane account to build with Arcane Credits.', action: 'Connect Arcane account' },
  none: { note: 'No ChatGPT or Claude subscription? Arcane Credits can stand in, but this copy of Arcane is not connected to an Arcane Credits service yet.', action: 'What Arcane Credits need' },
});
/** Where Settings opens for the Arcane Credits card (Plans & credits). */
export const ARCANE_CREDITS_TARGET = 'plans-credits-heading';
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
  const keys = ['version', 'provider', 'installed', 'auth', 'cliVersion', 'busy', 'message'];
  const state = data(value, keys) ?? (provider === 'claude' ? data(value, [...keys, 'claudeChoices']) : null);
  const bounded = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);
  if (!state || state.version !== 1 || state.provider !== provider || typeof state.installed !== 'boolean' || typeof state.busy !== 'boolean' ||
      typeof state.auth !== 'string' || !['unknown', 'signed-out', 'subscription', 'api-or-cloud'].includes(state.auth) ||
      !(state.cliVersion === null || bounded(state.cliVersion, 100)) || !(state.message === null || bounded(state.message, 2048)) ||
      (!state.installed && (state.cliVersion !== null || state.auth !== 'unknown'))) throw Error('Native provider status unavailable.');
  let choices: ClaudeSetupChoices | null = null;
  if (Object.hasOwn(state, 'claudeChoices') && state.claudeChoices !== null) {
    const raw = data(state.claudeChoices, ['cliVersion', 'aliases', 'efforts']);
    const list = (value: unknown, max: number): readonly string[] => {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !value.length || value.length > max ||
          Reflect.ownKeys(value).length !== value.length + 1) throw Error('Native provider status unavailable.');
      const output: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const field = Object.getOwnPropertyDescriptor(value, String(index));
        if (!field?.enumerable || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(field.value) || output.includes(field.value)) throw Error('Native provider status unavailable.');
        output.push(field.value);
      }
      return Object.freeze(output);
    };
    if (!raw || !state.installed || raw.cliVersion !== state.cliVersion || typeof raw.cliVersion !== 'string' ||
        !/^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[A-Za-z0-9.-]{1,32})?$/.test(raw.cliVersion)) throw Error('Native provider status unavailable.');
    choices = Object.freeze({ cliVersion: raw.cliVersion, aliases: list(raw.aliases, 32), efforts: list(raw.efforts, 16) });
  }
  return Object.freeze({ ...state, ...(Object.hasOwn(state, 'claudeChoices') ? { claudeChoices: choices } : {}) }) as unknown as ProviderSetupState;
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
const STATUS_FRESH_MS = 60000;
// The host bounds each CLI command to 15 seconds; status can run two commands.
const STATUS_TIMEOUT_MS = 35000;
/** Only already-public host/preload details cross this boundary; never coerce native output or inspect causes. */
function providerFailureText(action:'status'|'login'|'install'|'launch'|'connect',failure:unknown):string {
  let detail:unknown=failure;
  if(failure&&typeof failure==='object')try{detail=Object.getOwnPropertyDescriptor(failure,'message')?.value;}catch{detail=null;}
  const safe=typeof detail==='string'&&detail.length>0&&detail.length<=2048&&!/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(detail)?detail:null;
  const message=userErrorText(userError(action==='login'?'LOGIN_UNCONFIRMED':action==='connect'?'CONNECTION_UNAVAILABLE':'UNKNOWN'));
  return safe?message+' Details: '+safe:message;
}
/** Mount, provider changes and resume read status once. Only observed saved login may connect metadata. */
export function startProviderSetup(doc: Document, options: ProviderSetupOptions): ProviderSetupController {
  const panel = doc.getElementById('provider-setup-panel'), gate = doc.getElementById('provider-login-gate');
  const select = doc.getElementById('provider-setup-provider') as HTMLSelectElement | null;
  if (!panel || !gate || !select) return {
    isSignedIn: () => false, subscribeSignInChange: (_listener: () => void) => () => {},
    handoffChoices: () => null, subscribeHandoffChoices: (_listener: () => void) => () => {},
    chatSurface: () => 'codex', subscribeChatSurface: (_listener: () => void) => () => {},
    requestProvider: (_next: SetupProvider | 'arcane', _hint?: ProviderChoiceHint) => false, selectedProvider: () => 'codex', setArcaneAvailable: (_available: boolean) => {}, setArcaneSetup: (_state: ArcaneCreditsSetup) => {},
    stop() {}, resume() {}, cleanup() {},
  };
  const native = bridge(doc, options), storage = presentationStorage(doc);
  const states = new Map<SetupProvider, { state: ProviderSetupState; observed: number }>(), awaitingStatus = new Set<SetupProvider>();
  const removers: (() => void)[] = [];
  let provider: SetupProvider = 'codex', epoch = 0, stopped = false, disposed = false, busy = false, actionError: string | null = null;
  let connectionNotice: string | null = null;
  let connectionEpoch=0;
  let loginWatch: { provider: SetupProvider; epoch: number; remaining: number } | null = null;
  let loginTimer: ReturnType<typeof setTimeout> | null = null;
  let signInTimer: ReturnType<typeof setTimeout> | null = null, lastSignedIn = false;
  let claudeSignInObserved: number | null = null;
  let pendingStatus = false, cancelStatus: (() => void) | null = null;
  let activeAction: 'status' | 'login' | 'install' | 'launch' | null = null;
  let savedConnectionPending = false, savedLoginObserved = false, reconnectAllowed = true;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null, recoveryAttempt = 0;
  const clearRecovery = () => { if(recoveryTimer!==null)clearTimeout(recoveryTimer);recoveryTimer=null; };
  // Sign in once: until the human explicitly picks a provider, a startup status that finds the selected provider
  // signed out may switch to the other provider when that one already reports a saved subscription sign-in.
  let autoSelect = options.autoSelectSignedIn === true;
  let fallbackCheck: { provider: SetupProvider; epoch: number } | null = null;
  let cancelFallback: (() => void) | null = null;
  const retireFallback = () => { fallbackCheck = null; const cancel = cancelFallback; cancelFallback = null; cancel?.(); };
  const savedLoginConnections = new Set<string>();
  const signInListeners = new Set<() => void>();
  const choiceListeners = new Set<() => void>();
  let lastChoices = '';
  // Claude chat evidence: a non-busy subscription status ACK for the selected Claude provider.
  // Unlike isSignedIn() it does not expire on the 60s presentation clock (an open chat must not
  // re-lock mid-conversation); any non-subscription status, failure or stop clears it.
  let codexChatEvidence = false, claudeChatEvidence = false, surface: ChatSurface = 'codex';
  // Last-known chat evidence per provider for this session. A provider change restores it, so a provider already seen
  // signed in keeps its chat (no sign-in gate flash) while its status is read again in the background; only a refresh
  // that reports signed out, a failure, a disconnect or a stop clears it. Presentation only: never native or task authority.
  const knownSignedIn: Record<SetupProvider, boolean> = { codex: false, claude: false };
  const rememberEvidence = () => { knownSignedIn[provider] = provider === 'codex' ? codexChatEvidence : claudeChatEvidence; };
  const surfaceListeners = new Set<() => void>();
  const claudeChatActive = () => provider === 'claude' && claudeChatEvidence && !!native && !stopped && !disposed;
  // Arcane Credits chat: the user's explicit choice plus the chat's own availability report (no native CLI involved).
  let arcaneChosen = false, arcaneAvailable = false, arcaneSetup: ArcaneCreditsSetup = 'none';
  // Providers whose official install steps were opened from the sign-in card: the card then offers Check sign-in.
  const installOpened = new Set<SetupProvider>();
  const arcaneChatActive = () => arcaneChosen && arcaneAvailable && !stopped && !disposed;
  const applySurface = () => {
    const next: ChatSurface = arcaneChatActive() ? 'arcane' : claudeChatActive() ? 'claude' : 'codex';
    if (next === surface) return;
    surface = next;
    const claude = next !== 'codex';
    for (const [selectors, hidden] of [[CODEX_SURFACE_SELECTORS, claude], [CLAUDE_SURFACE_SELECTORS, !claude]] as const) for (const selector of selectors) {
      let node: HTMLElement | null = null;
      try { node = doc.getElementById(selector.slice(1)); } catch { node = null; }
      if (node) node.hidden = hidden;
    }
    for (const listener of [...surfaceListeners]) { try { listener(); } catch { /* Observers cannot interrupt setup. */ } }
  };
  const clearSignInTimer = () => { if (signInTimer !== null) clearTimeout(signInTimer); signInTimer = null; };
  const clearLoginWatch = () => { if (loginTimer !== null) clearTimeout(loginTimer); loginTimer = null; loginWatch = null; };
  provider = providers(select.value) ? select.value : 'codex';
  try { provider = readProviderPresentation(storage?.getItem(PROVIDER_PRESENTATION_KEY)) ?? provider; } catch { /* Storage denial cannot block setup. */ }
  try { arcaneChosen = storage?.getItem(ARCANE_SURFACE_KEY) === '{"version":1,"chosen":true}'; } catch { arcaneChosen = false; }
  const chooseArcane = (chosen: boolean) => {
    if (arcaneChosen === chosen) return;
    arcaneChosen = chosen;
    try { if (chosen) storage?.setItem(ARCANE_SURFACE_KEY, '{"version":1,"chosen":true}'); else storage?.removeItem(ARCANE_SURFACE_KEY); } catch { /* Only presentation is lost. */ }
  };
  // First-launch sign-in page (presentation only). Without the option the memory is 'signed-in', so every view rule below
  // is exactly the previous one.
  const pageEnabled = options.signInPage === true;
  let pageMemory: SignInPageMemory = 'signed-in';
  if (pageEnabled) { try { pageMemory = readSignInPage(storage?.getItem(SIGN_IN_PAGE_KEY)); } catch { pageMemory = 'none'; } }
  // pageShown: the page was on screen once (later re-checks keep it rather than swapping to the splash).
  // sawPending: the saved-login metadata connection started; once it settles unusable, the page shows.
  let pageShown = false, sawPending = false;
  const rememberPage = (next: SignInPageMemory) => {
    if (!pageEnabled || pageMemory === next) return;
    pageMemory = next;
    try { if (next === 'none') storage?.removeItem(SIGN_IN_PAGE_KEY); else storage?.setItem(SIGN_IN_PAGE_KEY, JSON.stringify({ version: 1, state: next })); } catch { /* Only presentation is lost. */ }
  };
  const el = (id: string) => doc.getElementById(id), button = (id: string) => el(id) as HTMLButtonElement | null;
  const set = (id: string, value: string) => { const node = el(id); if (node) node.textContent = value; };
  const status = () => {
    const entry = states.get(provider), age = entry ? Date.now() - entry.observed : -1;
    return entry && age >= 0 && age <= STATUS_FRESH_MS ? entry.state : undefined;
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
    return age >= 0 && age <= STATUS_FRESH_MS && status()?.auth === 'subscription' && !status()?.busy;
  };
  const notifySignInChange = () => {
    const signedIn = isSignedIn();
    if (signedIn === lastSignedIn) return;
    lastSignedIn = signedIn;
    for (const listener of [...signInListeners]) {
      try { listener(); } catch { /* Presentation observers cannot interrupt native setup. */ }
    }
  };
  const handoffChoices = (): ClaudeSetupChoices | null => provider === 'claude' && isSignedIn() && !busy && !stopped && !disposed ? status()?.claudeChoices ?? null : null;
  const notifyChoices = () => {
    const signature = JSON.stringify(handoffChoices());
    if (signature === lastChoices) return;
    lastChoices = signature;
    for (const listener of [...choiceListeners]) { try { listener(); } catch { /* Observers cannot interrupt setup. */ } }
  };
  const nextAction = (): 'disconnect' | 'connect' | 'status' | 'login' | 'launch' | 'install' => {
    if (actionError) return 'status';
    if (needsDisconnect()) return 'disconnect';
    const state = status(), connection = options.chat.providerConnectionStatus();
    if (provider === 'codex' && (state?.auth === 'subscription' || connection?.fresh && connection.auth === 'subscription')) return 'connect';
    if (provider === 'claude' && state?.auth === 'subscription') return 'launch';
    // Not installed: the card opens the official install steps once, then checks again.
    if (state && !state.installed) return installOpened.has(provider) ? 'status' : 'install';
    // An API-key or cloud sign-in is not a subscription: offer the subscription sign-in instead of re-checking forever.
    return awaitingStatus.has(provider) || !state || (state.auth !== 'signed-out' && state.auth !== 'api-or-cloud') ? 'status' : 'login';
  };
  const cliName = () => provider === 'codex' ? 'Codex' : 'Claude Code';
  /** Plain next-step guidance for the sign-in card where native status alone would leave a new user stuck. */
  const guidance = (state: ProviderSetupState | undefined): string | null => {
    if (state && !state.installed && !installOpened.has(provider)) return cliName() + ' is not installed on this PC yet. Click Get ' + cliName() + ' for the official install steps, then come back and sign in.';
    if (state?.auth === 'api-or-cloud') return 'This ' + cliName() + ' sign-in uses an API key or cloud account. Arcane builds with your ' + (provider === 'codex' ? 'ChatGPT' : 'Claude') + ' subscription: sign in with it, or use Arcane Credits.';
    return null;
  };
  const render = () => {
    const state = status(), connection = options.chat.providerConnectionStatus(), name = provider === 'codex' ? 'ChatGPT' : 'Claude Code';
    const connectingSavedLogin = provider === 'codex' && savedConnectionPending;
    select.value = provider;
    panel.setAttribute('aria-busy', String(busy || connectingSavedLogin)); gate.setAttribute('aria-busy', String(busy || connectingSavedLogin));
    for (const [id, value] of [['provider-login-codex', 'codex'], ['provider-login-claude', 'claude']] as const) button(id)?.setAttribute('aria-pressed', String(provider === value));
    // Keep an authenticated workspace visible during a failed read. Native actions still require fresh state.
    // Conversation visibility survives native task cancellation/model handoff.
    // This volatile evidence never grants fresh native/task authority.
    if(provider==='codex') {
      if(connection?.fresh&&connection.connected&&connection.ready)connectionNotice=null;
      if(connection?.fresh&&connection.auth==='subscription'&&connection.connected&&connection.ready&&reconnectAllowed)codexChatEvidence=true;
      else if(connection?.fresh&&(connection.auth==='signed-out'||connection.auth==='unsupported'))codexChatEvidence=false;
      else if(!connection?.connected&&(state?.auth==='signed-out'||state?.auth==='api-or-cloud'))codexChatEvidence=false;
    }
    rememberEvidence();
    const evidence = (provider === 'codex' && codexChatEvidence && reconnectAllowed) || claudeChatActive() || arcaneChatActive();
    // A usable sign-in (Claude or Arcane chat, or a fresh ready Codex connection) ends the first-launch page for good.
    if (evidence && (claudeChatActive() || arcaneChatActive() || connected())) rememberPage('signed-in');
    const workspace = evidence && pageMemory === 'signed-in';
    // First launch: a saved login whose metadata is still connecting shows 'checking', never the page or the workspace.
    if (savedConnectionPending) sawPending = true;
    const connecting = evidence && !workspace && !pageShown && !needsDisconnect() && (savedConnectionPending || !sawPending);
    const firstCheck = !!native && !stopped && !disposed && !actionError && (!states.has(provider) || fallbackCheck !== null || connecting);
    const view = workspace || pageMemory === 'skipped' ? 'workspace' : firstCheck ? 'checking' : 'setup';
    if (view === 'setup') pageShown = true;
    gate.hidden = view !== 'setup';
    const stage = el('workspace-stage');
    stage?.classList.toggle('provider-required', view !== 'workspace');
    stage?.setAttribute('data-provider-view', view);
    doc.documentElement?.setAttribute('data-provider-view', view);
    // The static document is the signed-out page; this marks that setup now decides the view (CSS keeps the page back until then).
    doc.documentElement?.setAttribute('data-provider-ready', 'true');
    const checking = busy && activeAction === 'status' || pendingStatus;
    const text = connected() ? 'Codex connected.' : checking ? 'Checking ' + name + ' sign-in…' : connectingSavedLogin ? 'Connecting Codex…' : state?.auth === 'subscription' && !state.busy ? name + ' signed in.' :
      state?.auth === 'signed-out' || provider === 'codex' && connection?.fresh && connection.auth === 'signed-out' ? 'Sign in with ' + name + '.' :
      state?.auth === 'api-or-cloud' ? 'API or cloud account.' : state && !state.installed ? 'CLI unavailable.' : native ? 'Sign-in not checked.' : 'Desktop setup unavailable.';
    const currentConnectionNotice=provider==='codex'&&!stopped&&!disposed&&!arcaneChosen&&state?.auth==='subscription'?connectionNotice:null;
    set('provider-setup-status', actionError ?? currentConnectionNotice ?? text);
    set('provider-setup-details', (actionError ?? state?.message ?? (native ? provider === 'codex' ? 'Sign in with ChatGPT in your browser. Arcane reuses an existing native ChatGPT sign-in.' :
      'Claude Code sign-in opens in its native terminal. Check status after signing in.' : 'Native sign-in requires the Arcane desktop app.')) +
      (state?.cliVersion ? ' Version ' + state.cliVersion + '.' : '') + (state?.auth === 'api-or-cloud' ? ' API or cloud billing was reported; no request was started.' : ''));
    set('provider-login-message', actionError ?? currentConnectionNotice ?? (!native ? 'Open the desktop app to sign in.' : checking ? 'Checking your saved ' + name + ' sign-in…' : needsDisconnect() ? 'Reconnect to use your signed-in account.' :
      guidance(state) ?? state?.message ?? (
      provider === 'claude' ? 'Claude Code opens in its native terminal.' : awaitingStatus.has(provider) ? 'Finish native sign-in, then check status.' :
      state?.auth === 'subscription' || connection?.fresh && connection.auth === 'subscription' ? 'Use your signed-in ChatGPT account.' : 'Sign in with ChatGPT in your browser.')));
    set('provider-setup-login', 'Sign in with ' + name);
    for (const id of ['provider-setup-refresh', 'provider-setup-login', 'provider-setup-install', 'provider-setup-launch']) {
      const control = button(id); if (control) control.disabled = stopped || disposed || busy || !native;
    }
    const setupLogin = button('provider-setup-login'); if (setupLogin) setupLogin.hidden = !native || state?.installed !== true || state.auth === 'subscription';
    const install = button('provider-setup-install'); if (install) install.hidden = !native || state?.installed !== false;
    const launch = button('provider-setup-launch'); if (launch) launch.hidden = !native || provider !== 'claude' || state?.installed !== true || state.auth !== 'subscription' || state.busy;
    const login = button('provider-login-start');
    if (login) {
      const action = nextAction(); login.hidden = false;
      login.textContent = checking ? 'Checking sign-in…' : connectingSavedLogin ? 'Connecting Codex…' : busy ? 'Please wait…' : action === 'disconnect' ? 'Disconnect old session' : action === 'connect' ? 'Connect Codex' :
        action === 'status' ? 'Check sign-in' : action === 'launch' ? 'Open Claude Code' : action === 'install' ? 'Get ' + cliName() : 'Sign in with ' + name;
      login.disabled = stopped || disposed || busy || connectingSavedLogin || !native;
    }
    // No subscription: Arcane Credits when they are ready, otherwise a plain line about what they still need.
    const offer = arcaneAvailable ? 'ready' : arcaneSetup;
    set('provider-login-credits-note', ARCANE_CREDITS_OFFER[offer].note);
    const credits = button('provider-login-credits');
    if (credits) { credits.textContent = ARCANE_CREDITS_OFFER[offer].action; credits.disabled = stopped || disposed; credits.setAttribute('data-offer', offer); }
    // Keep the integration hook; the card offers status through its one primary action.
    const refresh = button('provider-login-refresh'); if (refresh) { refresh.hidden = true; refresh.disabled = stopped || disposed || busy || !native; }
    // Terminal handoff stays available as a secondary action beside the embedded Claude chat.
    const terminal = button('claude-chat-terminal'); if (terminal) { terminal.hidden = !claudeChatActive(); terminal.disabled = stopped || disposed || busy || !native; }
    const skip = button('provider-login-skip'); if (skip) { skip.hidden = !pageEnabled; skip.disabled = stopped || disposed; }
    applySurface();
    clearSignInTimer();
    const entry = states.get(provider);
    if (entry && !stopped && !disposed && status()) {
      // Freshness expiry is a local presentation change, never a native probe.
      const observed = provider === 'claude' && isSignedIn() && claudeSignInObserved !== null ? Math.min(entry.observed, claudeSignInObserved) : entry.observed;
      signInTimer = setTimeout(() => { signInTimer = null; render(); }, Math.max(1, observed + STATUS_FRESH_MS + 1 - Date.now()));
    }
    notifySignInChange();
    notifyChoices();
    scheduleRecovery();
  };
  const requestSettings = (target: string) => { const Event = doc.defaultView?.CustomEvent; if (Event) doc.dispatchEvent(new Event('workspace:settingsrequest', { detail: { target } })); };
  const choose = (next: SetupProvider, publish = true) => {
    if (next !== provider) {
      // A late successful account check stays saved, but cannot revive this retired manual connection intent.
      if(loginWatch||activeAction==='login'){connectionEpoch++;reconnectAllowed=false;}
      clearLoginWatch();
    }
    if (stopped || disposed) return;
    // An explicit ChatGPT/Claude choice leaves the Arcane chat; a restored preference (publish false) does not.
    if (publish) { retireFallback(); chooseArcane(false); }
    const changed = next !== provider;
    if (changed) { retireFallback();clearRecovery();recoveryAttempt=0;savedLoginObserved=false;savedLoginConnections.clear(); rememberEvidence(); provider = next; codexChatEvidence = next === 'codex' && knownSignedIn.codex; epoch++; actionError = null; connectionNotice=null; states.delete(next); claudeChatEvidence = next === 'claude' && knownSignedIn.claude; if (next === 'claude') claudeSignInObserved = null; }
    try { storage?.setItem(PROVIDER_PRESENTATION_KEY, JSON.stringify({ version: 1, provider })); } catch { /* Only presentation is lost. */ }
    render();
    const Event = doc.defaultView?.CustomEvent;
    if (publish && Event) doc.dispatchEvent(new Event(PROVIDER_PREFERENCE_EVENT, { detail: { provider } }));
    if (changed) requestStatus();
  };
  const listen = (target: EventTarget, event: string, handler: (event: Event) => void, capture = false) => { target.addEventListener(event, handler, capture); removers.push(() => target.removeEventListener(event, handler, capture)); };
  const trusted = (event: Event) => { const mouse = event as MouseEvent; return event.isTrusted === true && !event.defaultPrevented && !mouse.altKey && !mouse.ctrlKey && !mouse.metaKey && !mouse.shiftKey; };
  const invoke = async (action: 'status' | 'login' | 'install' | 'launch') => {
    if (!native || busy || stopped || disposed) return;
    const target = provider, generation = epoch,connectionGeneration=connectionEpoch; busy = true; activeAction = action; actionError = null; connectionNotice=null; render();
    let connectAfterLogin = false, connectSavedLogin = false, observed: ProviderSetupState | null = null;
    try {
      const request = native[action](target);
      const result = action === 'status' ? await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Native provider status timed out.')), STATUS_TIMEOUT_MS);
        cancelStatus = () => { clearTimeout(timer); reject(Error('Native provider status cancelled.')); };
        Promise.resolve(request).then(resolve, reject).finally(() => clearTimeout(timer));
      }) : await request;
      const value = readProviderSetupState(result, target);
      if (!stopped && !disposed && generation === epoch) {
        observed = value;
        states.set(target, { state: value, observed: Date.now() });
        if(target==='codex'&&action==='status'&&!value.busy){
          if(value.auth==='subscription') {
            savedLoginObserved=true;
            // A checked saved sign-in can restore the workspace while metadata connects.
            // This does not make isSignedIn() true or grant native actions.
            if (reconnectAllowed && options.chat.connectForSavedLogin) codexChatEvidence = true;
          }
          else if(value.auth==='signed-out'||value.auth==='api-or-cloud'||!value.installed)savedLoginObserved=false;
        }
        if (target === 'claude') {
          if (value.auth === 'signed-out' || value.auth === 'api-or-cloud' || !value.installed) claudeChatEvidence = false;
          else if (value.auth === 'subscription' && action === 'status' && !value.busy) claudeChatEvidence = true;
          if (value.auth !== 'subscription') claudeSignInObserved = null;
          else if (action === 'status' && !value.busy) claudeSignInObserved = Date.now();
          // Install/launch snapshots and busy replies may contain cached auth.
          // They cannot renew evidence from an actual native status check.
        }
        if (action === 'install') installOpened.add(target);
        else if (value.installed || action === 'status') installOpened.delete(target);
        if (action === 'login' && value.installed && value.auth === 'unknown') awaitingStatus.add(target);
        else if (action === 'status' && !value.busy) awaitingStatus.delete(target);
        if (target === 'codex' && action === 'login' && value.busy) loginWatch = { provider: target, epoch: generation, remaining: 450 };
        const watching = loginWatch?.provider === target && loginWatch.epoch === generation;
        // This exact host-owned notice can only DENY a handoff; text never grants account or connection authority.
        const cancelledLogin=target==='codex'&&(action==='login'||watching)&&value.message==='Native browser sign-in was cancelled.';
        if(cancelledLogin){connectionEpoch++;reconnectAllowed=false;clearRecovery();clearLoginWatch();}
        if((action==='login'||watching)&&!value.busy&&value.auth!=='subscription'&&!cancelledLogin)actionError=providerFailureText('login',value.message);
        connectAfterLogin = target === 'codex' && value.auth === 'subscription' && !value.busy && (action === 'login' || watching)&&!cancelledLogin;
        connectSavedLogin = target === 'codex' && action === 'status' && value.auth === 'subscription' && !value.busy && !watching;
        if (watching && !value.busy) clearLoginWatch();
      }
    } catch(error) {
      if (!stopped && !disposed && generation === epoch) { clearLoginWatch(); states.delete(target); if (target === 'claude') { claudeSignInObserved = null; } awaitingStatus.delete(target); actionError = providerFailureText(action,error); }
    } finally {
      const checkOther = !stopped && !disposed && generation === epoch && target === provider && action === 'status' &&
        observed && !observed.busy && (observed.auth === 'signed-out' || observed.auth === 'api-or-cloud') && autoSelect;
      if (checkOther) fallbackCheck = { provider: target, epoch: generation };
      busy = false; activeAction = null; cancelStatus = null; if (!disposed) render();
      if (!stopped && !disposed && generation === epoch && target === provider) {
        // This follows only the user's explicit sign-in intent, not startup or
        // cached preferences. Connecting reads account/models, never a turn.
        if(connectAfterLogin)reconnectAllowed=true;
        if (connectAfterLogin && !options.chat.connectForSavedLogin && !needsDisconnect() && !connected()) {
          const connect = button('codex-connect'); if (connect && !connect.disabled) connect.click();
        }
        if ((connectAfterLogin || connectSavedLogin) && reconnectAllowed && options.chat.connectForSavedLogin && !needsDisconnect() && !connected() && !savedConnectionPending) {
          const connection = options.chat.providerConnectionStatus();
          const snapshot = connection ? JSON.stringify([connection.connected, connection.ready, connection.fresh, connection.auth]) : 'none';
          if (connectAfterLogin || !savedLoginConnections.has(snapshot)) {
            savedLoginConnections.add(snapshot);
            savedConnectionPending = true;
            render();
            // Only this validated native status ACK permits the metadata hook.
            // Its implementation owns API freshness and native session authority.
            const current=()=>!stopped&&!disposed&&generation===epoch&&connectionGeneration===connectionEpoch&&reconnectAllowed&&provider===target&&!arcaneChosen;
            try {
              void options.chat.connectForSavedLogin(current).then(()=>{
                if(current()&&connectAfterLogin&&!connected())connectionNotice='ChatGPT sign-in was verified. Codex is not connected. Review the connection notice for details; no message was sent again.';
              }).catch(error => {
                if (current()) { actionError = providerFailureText('connect',error); render(); }
              }).finally(() => { savedConnectionPending = false; if (!disposed) render(); });
            } catch(error) {
              savedConnectionPending = false;
              if (current()) { actionError = providerFailureText('connect',error); render(); }
            }
          }
        }
        if (loginWatch?.provider === target && loginWatch.epoch === epoch && loginWatch.remaining > 0) {
          if (loginTimer !== null) clearTimeout(loginTimer);
          loginWatch.remaining--;
          loginTimer = setTimeout(() => { loginTimer = null; void invoke('status'); }, 2000);
        } else if (loginWatch && loginWatch.remaining <= 0) clearLoginWatch();
      }
      if (pendingStatus && !stopped && !disposed) requestStatus();
      if (checkOther && fallbackCheck?.provider === target && fallbackCheck.epoch === generation) void preferSignedIn(target, generation);
    }
  };
  const preferSignedIn = async (from: SetupProvider, generation: number) => {
    autoSelect = false;
    const other: SetupProvider = from === 'codex' ? 'claude' : 'codex';
    const check = fallbackCheck;
    if (!native || !check || check.provider !== from || check.epoch !== generation || stopped || disposed || provider !== from || generation !== epoch) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancel: (() => void) | null = null;
    try {
      const request = native.status(other);
      const result = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => reject(Error('Native provider status timed out.')), STATUS_TIMEOUT_MS);
        cancel = () => reject(Error('Native provider status cancelled.'));
        cancelFallback = cancel;
        Promise.resolve(request).then(resolve, reject);
      });
      const value = readProviderSetupState(result, other);
      if (fallbackCheck === check && value.auth === 'subscription' && !value.busy && !stopped && !disposed && provider === from && generation === epoch && !busy) choose(other);
    } catch { /* The selected provider keeps its own sign-in prompt. */ }
    finally {
      if (timer !== null) clearTimeout(timer);
      if (cancelFallback === cancel) cancelFallback = null;
      if (fallbackCheck === check) {
        fallbackCheck = null;
        if (!disposed) render();
      }
    }
  };
  const requestStatus = () => {
    if (!native || stopped || disposed) return;
    if (busy) { pendingStatus = true; render(); return; }
    pendingStatus = false;
    void invoke('status');
  };
  // Recovery checks native saved login again before each metadata connection. It never sends a prompt or starts login.
  const scheduleRecovery = () => {
    if(!native||!options.chat.connectForSavedLogin||stopped||disposed||provider!=='codex'||!savedLoginObserved||!reconnectAllowed||connected()){
      clearRecovery();if(connected())recoveryAttempt=0;return;
    }
    if(busy||savedConnectionPending||pendingStatus||recoveryTimer!==null)return;
    const delay=Math.min(30000,5000*2**Math.min(recoveryAttempt++,3));
    recoveryTimer=setTimeout(()=>{
      recoveryTimer=null;
      if(stopped||disposed||provider!=='codex'||!savedLoginObserved||!reconnectAllowed||connected())return;
      if(doc.hidden){scheduleRecovery();return;}
      savedLoginConnections.clear();requestStatus();
    },delay);
  };
  const checkOnReturn = () => {
    if(!stopped&&!disposed&&!doc.hidden&&!connected()&&states.get(provider)?.state.auth!=='signed-out')requestStatus();
  };
  listen(doc,'visibilitychange',checkOnReturn);
  if(typeof doc.defaultView?.addEventListener==='function')listen(doc.defaultView,'focus',checkOnReturn);
  const disconnectIntent = () => { connectionEpoch++;reconnectAllowed=false;codexChatEvidence=false;knownSignedIn.codex=false;clearRecovery();render(); };
  const disconnect = button('codex-disconnect');
  if(disconnect)listen(disconnect,'click',event=>{if(trusted(event)&&!disconnect.disabled)disconnectIntent();},true);
  const connect = button('codex-connect');
  if(connect)listen(connect,'click',event=>{if(trusted(event)&&!connect.disabled)reconnectAllowed=true;},true);
  for (const [id, action] of [['provider-setup-refresh', 'status'], ['provider-setup-login', 'login'], ['provider-setup-install', 'install'], ['provider-setup-launch', 'launch'], ['claude-chat-terminal', 'launch'], ['provider-login-refresh', 'status']] as const) {
    const control = button(id); if (control) listen(control, 'click', event => { if (trusted(event) && !control.disabled) void invoke(action); });
  }
  for (const [id, next] of [['provider-login-codex', 'codex'], ['provider-login-claude', 'claude']] as const) {
    const control = button(id); if (control) listen(control, 'click', event => { if (trusted(event)) { autoSelect = false; choose(next); } });
  }
  listen(select, 'change', event => { if (event.isTrusted && providers(select.value)) { autoSelect = false; choose(select.value); } });
  const login = button('provider-login-start');
  if (login) listen(login, 'click', event => {
    if (!trusted(event) || login.disabled || busy || stopped || disposed || !native) return;
    const action = nextAction();
    if (action === 'disconnect') { disconnectIntent(); const disconnect = button('codex-disconnect'); if (disconnect && !disconnect.disabled) disconnect.click(); return; }
    if (action === 'connect') { reconnectAllowed=true; void invoke('login'); }
    else void invoke(action);
  });
  const credits = button('provider-login-credits');
  if (credits) listen(credits, 'click', event => {
    if (!trusted(event) || credits.disabled || stopped || disposed) return;
    // Ready: switch to the Arcane Credits chat (the gate then hides). Otherwise show what is still needed in Plans & credits.
    if (arcaneAvailable) { autoSelect = false; retireFallback(); chooseArcane(true); render(); }
    else requestSettings(ARCANE_CREDITS_TARGET);
  });
  // Continue without signing in: presentation only. The workspace shows; every native action still needs its own fresh state.
  const skip = button('provider-login-skip');
  if (skip) listen(skip, 'click', event => {
    if (!trusted(event) || skip.disabled || !pageEnabled || stopped || disposed) return;
    rememberPage('skipped'); render();
    try { const composer = el('codex-composer') as HTMLTextAreaElement | null; if (composer && !composer.disabled && !composer.hidden) composer.focus(); else el('codex-heading')?.focus(); } catch { /* Focus is optional. */ }
  });
  // Exact presentation event only. A changed preference requests native status,
  // but its payload never supplies authentication or native session authority.
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
  removers.push(options.chat.subscribeProviderStateChange(render)); render(); requestStatus();
  return {
    isSignedIn,
    handoffChoices,
    subscribeHandoffChoices(listener: () => void) {
      if (disposed) return () => {};
      choiceListeners.add(listener);
      return () => { choiceListeners.delete(listener); };
    },
    chatSurface: () => surface,
    requestProvider(next: SetupProvider | 'arcane', hint?: ProviderChoiceHint) {
      if (stopped || disposed) return false;
      if (providers(next) && hint?.signedIn === true && next !== provider) knownSignedIn[next] = true;
      if (next === 'arcane') {
        if (!arcaneAvailable) return false;
        autoSelect = false; retireFallback(); chooseArcane(true); render();
        return true;
      }
      if (!providers(next)) return false;
      autoSelect = false; retireFallback();
      if (next !== provider) choose(next);
      else { chooseArcane(false); render(); if (next === 'claude' && !claudeChatEvidence) requestStatus(); }
      return true;
    },
    setArcaneAvailable(available: boolean) {
      if (disposed || arcaneAvailable === (available === true)) return;
      arcaneAvailable = available === true; render();
    },
    setArcaneSetup(state: ArcaneCreditsSetup) {
      const next: ArcaneCreditsSetup = state === 'signed-out' ? 'signed-out' : 'none';
      if (disposed || arcaneSetup === next) return;
      arcaneSetup = next; render();
    },
    selectedProvider: () => provider,
    signInSkipped: () => pageMemory === 'skipped',
    showSignIn() {
      if (disposed || pageMemory !== 'skipped') return false;
      rememberPage('none'); render();
      return !gate.hidden;
    },
    subscribeChatSurface(listener: () => void) {
      if (disposed) return () => {};
      surfaceListeners.add(listener);
      return () => { surfaceListeners.delete(listener); };
    },
    subscribeSignInChange(listener: () => void) {
      if (disposed) return () => {};
      signInListeners.add(listener);
      return () => { signInListeners.delete(listener); };
    },
    stop() { retireFallback();clearRecovery();savedLoginObserved=false;savedLoginConnections.clear();recoveryAttempt=0; stopped = true; epoch++; pendingStatus = false; cancelStatus?.(); clearLoginWatch(); states.clear(); claudeSignInObserved = null; claudeChatEvidence = false; codexChatEvidence=false; knownSignedIn.codex = knownSignedIn.claude = false; awaitingStatus.clear(); render(); },
    resume() { if (disposed || !stopped) return; stopped = false; epoch++; render(); requestStatus(); },
    cleanup() { if (disposed) return; retireFallback();clearRecovery();savedLoginObserved=false;savedLoginConnections.clear(); disposed = true; stopped = true; epoch++; pendingStatus = false; cancelStatus?.(); clearLoginWatch(); clearSignInTimer(); states.clear(); claudeSignInObserved = null; claudeChatEvidence = false; codexChatEvidence = false; knownSignedIn.codex = knownSignedIn.claude = false; awaitingStatus.clear(); notifySignInChange(); notifyChoices(); applySurface(); signInListeners.clear(); choiceListeners.clear(); surfaceListeners.clear(); for (const remove of removers.splice(0)) remove(); },
  };
}
