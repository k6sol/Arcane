/// <reference lib="dom" />
// Claude chat controller for the shared workspace chat surface. While the Claude provider is active it renders into
// the same nodes as the Codex chat (tabs strip, Saved chats, #codex-messages transcript, composer and the composer
// model picker) using the same markup classes, so both providers present one chat experience. It talks exclusively to
// the Electron preload bridge `window.arcaneDesktop.claudeChat` and writes model output with textContent only.
import {
  composerMenuOpen, composerPickerCheck, crossProviderRows, describeToolActivity, fillModelOptions, firstModelRow, installComposerCommands, modelListEntry,
  modelListMove, parseToolDetail, positionComposerPopover, prependProviderLogo, renderChangeCard, renderMessageText, renderToolActivity, toolDetailText,
} from './codex-chat.js';
import type { ComposerModelGroup, ComposerProvider, CrossProviderModels, ProviderUsageLimit, ToolChange } from './codex-chat.js';

export type ClaudeChatRole = 'user' | 'assistant' | 'tool' | 'error';
export type ClaudeToolStatus = 'started' | 'finished' | 'failed';
/** input/result are the engine's bounded display details (JSON or a short excerpt); older engines omit them. */
export interface ClaudeChatTool { name: string; status: ClaudeToolStatus; input?: string; result?: string }
export interface ClaudeChatMessage { id: string; role: ClaudeChatRole; text: string; at: string; tool?: ClaudeChatTool }
export interface ClaudeChatStatus {
  installed: boolean; signedIn: boolean; cliVersion: string | null; models: string[]; efforts: string[];
  defaultModel: string | null; message: string | null;
  /** Concrete model id per CLI alias, as resolved by the desktop engine (e.g. opus -> claude-opus-5-5). */
  resolved: Record<string, string>;
}
export interface ClaudeChatConversation { conversationId: string; title: string; updatedAt: string; model: string; effort: string }
export interface ClaudeChatUsage { inputTokens: number; outputTokens: number; costUsd: number | null }
export interface ClaudeChatBridge {
  version: 1;
  status(): Promise<unknown>;
  list(): Promise<unknown>;
  history(conversationId: string): Promise<unknown>;
  send(request: { conversationId: string | null; text: string; model: string; effort: string }): Promise<unknown>;
  stop(turnId: string): Promise<unknown>;
  remove(conversationId: string): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
}
export interface ClaudeChatOptions {
  /** Test seam. When omitted the bridge is read from the document's window. */
  bridge?: unknown;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export const CLAUDE_CHAT_CHOICE_KEY = 'arcane.claude-chat.choice.v1';
/** Presentation only: which saved Claude conversations are open as tabs. Never message text or authority. */
export const CLAUDE_CHAT_TABS_KEY = 'arcane.claude-chat.tabs.v1';
export const CLAUDE_CHAT_EMPTY_TEXT = 'New Claude chat. Your first message starts the conversation.';
export const CLAUDE_CHAT_NO_BRIDGE_TEXT = 'Claude chat requires the Arcane desktop app.';
export const CLAUDE_CHAT_TAB_LIMIT = 16;
/** The engine's one fixed usage-limit message (claude-chat.cjs MESSAGES.usageLimit). */
export const CLAUDE_CHAT_USAGE_LIMIT_TEXT = 'Claude usage limit reached. This message was not answered; try again after the limit resets.';
const MAX_TEXT = 1024 * 1024, MAX_INPUT = 100000, MAX_BUFFERED = 2000, DEFAULT_EFFORT = 'high';
const SEND_PATH = 'M12 19V5m-6 6 6-6 6 6', STOP_PATH = 'M7 7h10v10H7Z';
// Fixed, already-safe messages the preload bridge may reject with; anything else is replaced by a generic message.
const KNOWN_BRIDGE_ERRORS = new Set(['Claude chat is unavailable.', 'Another Claude chat reply is still running in this conversation.',
  'Too many Claude chat replies are running. Wait for one to finish.', 'This conversation no longer exists.', 'Message is empty or too long.']);
const bridgeError = (error: unknown, fallback: string) => { try { const message = (error as Error)?.message; return typeof message === 'string' && KNOWN_BRIDGE_ERRORS.has(message) ? message : fallback; } catch { return fallback; } };
const BRIDGE_KEYS = ['status', 'list', 'history', 'send', 'stop', 'remove', 'onEvent'] as const;

export function readClaudeChatBridge(win: unknown): ClaudeChatBridge | null {
  try {
    const root = (win as { arcaneDesktop?: unknown } | null | undefined)?.arcaneDesktop as { claudeChat?: unknown } | undefined;
    const value = root?.claudeChat as Record<string, unknown> | undefined;
    if (!value || typeof value !== 'object' || value.version !== 1) return null;
    return BRIDGE_KEYS.every(key => typeof value[key] === 'function') ? value as unknown as ClaudeChatBridge : null;
  } catch { return null; }
}

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = MAX_TEXT): string => typeof value === 'string' ? value.slice(0, max) : '';
const nullableText = (value: unknown, max: number): string | null => typeof value === 'string' && value.length ? value.slice(0, max) : null;
const names = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 128))].slice(0, 64) : [];
const ROLES: readonly ClaudeChatRole[] = ['user', 'assistant', 'tool', 'error'];
const TOOL_STATES: readonly ClaudeToolStatus[] = ['started', 'finished', 'failed'];

/** A concrete Claude model id: 'claude-' then lowercase family/version parts. */
export const CLAUDE_MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{0,62}$/;
/** Engine-resolved alias ids; only reported aliases with a concrete id are kept. Older engines send none. */
function readResolved(value: unknown, models: readonly string[]): Record<string, string> {
  const map = record(value), output: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!map) return output;
  for (const alias of models) { const id = Object.hasOwn(map, alias) ? map[alias] : undefined; if (typeof id === 'string' && CLAUDE_MODEL_ID.test(id)) output[alias] = id; }
  return output;
}
export function readClaudeChatStatus(value: unknown): ClaudeChatStatus {
  const state = record(value);
  if (!state || typeof state.installed !== 'boolean' || typeof state.signedIn !== 'boolean') throw Error('Claude status unavailable.');
  return {
    installed: state.installed, signedIn: state.installed && state.signedIn, cliVersion: nullableText(state.cliVersion, 100),
    models: names(state.models), efforts: names(state.efforts), defaultModel: nullableText(state.defaultModel, 128), message: nullableText(state.message, 2048),
    resolved: readResolved(state.resolved, names(state.models)),
  };
}
export function readClaudeChatMessage(value: unknown): ClaudeChatMessage | null {
  const message = record(value);
  if (!message || typeof message.role !== 'string' || !ROLES.includes(message.role as ClaudeChatRole)) return null;
  const output: ClaudeChatMessage = { id: text(message.id, 256), role: message.role as ClaudeChatRole, text: text(message.text), at: text(message.at, 64) };
  const tool = record(message.tool);
  if (tool && typeof tool.status === 'string' && TOOL_STATES.includes(tool.status as ClaudeToolStatus)) {
    output.tool = { name: text(tool.name, 256) || 'Tool', status: tool.status as ClaudeToolStatus };
    for (const key of ['input', 'result'] as const) if (typeof tool[key] === 'string' && (tool[key] as string).length <= 4096) output.tool[key] = tool[key] as string;
  }
  return output;
}
function readConversations(value: unknown): ClaudeChatConversation[] {
  const list = record(value)?.conversations;
  if (!Array.isArray(list)) throw Error('Claude conversations unavailable.');
  const seen = new Set<string>(), output: ClaudeChatConversation[] = [];
  for (const item of list) {
    const row = record(item), id = text(row?.conversationId, 256);
    if (!row || !id || seen.has(id)) continue;
    seen.add(id);
    output.push({ conversationId: id, title: text(row.title, 200), updatedAt: text(row.updatedAt, 64), model: text(row.model, 128), effort: text(row.effort, 64) });
  }
  return sortConversations(output);
}
const time = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
const sortConversations = (rows: ClaudeChatConversation[]) => rows.sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
/** A done event's usage-limit evidence: the engine's structured field, or its fixed message. */
function readUsageLimit(value: unknown, error: string | null): ProviderUsageLimit | null {
  const limit = record(value), reset = limit?.resetsAt;
  if (limit) return { resetsAt: typeof reset === 'number' && Number.isSafeInteger(reset) && reset >= 1e9 && reset < 1e11 ? reset : null };
  return error === CLAUDE_CHAT_USAGE_LIMIT_TEXT ? { resetsAt: null } : null;
}
export function formatClaudeUsage(value: unknown): string | null {
  const usage = record(value); if (!usage) return null;
  const input = finite(usage.inputTokens), output = finite(usage.outputTokens), cost = finite(usage.costUsd);
  const parts: string[] = [];
  if (input !== null) parts.push(Math.round(input) + ' input tokens');
  if (output !== null) parts.push(Math.round(output) + ' output tokens');
  if (cost !== null) parts.push('$' + cost.toFixed(4));
  return parts.length ? 'Done · ' + parts.join(' · ') : null;
}
/** Tokens reported by finished replies in one conversation during this app session (presentation only). */
export interface ClaudeConversationUsage { inputTokens: number; outputTokens: number; costUsd: number | null; replies: number }
/** Compact token count: 950, 12.3k, 1.2M. */
export function compactTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1e6) return (value / 1000).toFixed(value < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (value / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}
/** The meter's accessible description and tooltip. */
export function usageMeterText(usage: ClaudeConversationUsage): string {
  const total = usage.inputTokens + usage.outputTokens, format = (n: number) => Math.round(n).toLocaleString('en-US');
  return 'Tokens used in this conversation: ' + format(total) + ' (' + format(usage.inputTokens) + ' input, ' + format(usage.outputTokens) + ' output' +
    (usage.costUsd !== null ? ', $' + usage.costUsd.toFixed(4) : '') + ') across ' + usage.replies + (usage.replies === 1 ? ' reply' : ' replies') +
    ' since Arcane opened. The red arc is the output share.';
}
/** At most this many messages wait in the queue while a reply runs. */
export const CLAUDE_CHAT_QUEUE_LIMIT = 5;
export const CLAUDE_CHAT_QUEUE_RETURNED_TEXT = 'Queued messages were not sent because the reply did not finish. They are back in the message box.';

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
/**
 * Friendly Claude model names derived from CLI aliases or versioned ids, e.g. 'opus' -> Opus, 'claude-opus-4-1-20250805'
 * -> Opus 4.1, 'claude-fable-5-1' -> Fable 5.1, 'claude-3-5-haiku-20241022' -> Haiku 3.5, 'sonnet[1m]' -> Sonnet (1M context).
 * Unknown ids stay verbatim. A bare alias has no version: see claudeModelLabel for the resolved name.
 */
export function claudeModelName(id: string): { short: string; full: string } {
  const raw = id.trim().toLowerCase();
  let rest = raw, context = '';
  const size = /\[(\d+)([km])\]$/.exec(rest);
  if (size) { context = ' (' + size[1] + size[2]!.toUpperCase() + ' context)'; rest = rest.slice(0, size.index); }
  rest = rest.replace(/^(?:anthropic\.|us\.anthropic\.)/, '').replace(/^claude-/, '').replace(/-\d{8}(?:-v\d+(?::\d+)?)?$/, '').replace(/-latest$/, '');
  const parts = rest.split(/[-_.]/).filter(Boolean);
  const family = parts.find(part => (FAMILIES as readonly string[]).includes(part));
  let short: string;
  if (family) {
    const version = parts.filter(part => /^\d{1,2}$/.test(part)).join('.');
    short = title(family) + (version ? ' ' + version : '');
  } else if (rest === 'opusplan') short = 'Opus Plan';
  else if (rest === 'default') short = 'Default';
  else return { short: id, full: id };
  return { short: short + context, full: 'Claude ' + short + context };
}
/**
 * Display name for a model choice. An alias shows the version of the concrete model the engine resolved it to
 * (opus + {opus: 'claude-opus-5-5'} -> Opus 5.5); without a resolution it shows the bare family, never a guessed version.
 */
export function claudeModelLabel(model: string, resolved: Readonly<Record<string, string>> = {}): { short: string; full: string; id: string } {
  const id = Object.hasOwn(resolved, model) && CLAUDE_MODEL_ID.test(resolved[model]!) ? resolved[model]! : model;
  return { ...claudeModelName(id), id };
}
const EFFORT_LABELS: Record<string, string> = { xhigh: 'Extra high', max: 'Max' };
export function claudeEffortLabel(effort: string): string { return EFFORT_LABELS[effort] ?? title(effort); }

interface Turn {
  turnId: string | null; conversationId: string | null; tabKey: string; stopping: boolean;
  bubble: HTMLElement | null; text: string; echo: string | null; prompt: string;
}
interface Tab { key: string; conversationId: string | null; model: string; effort: string; draft: string }
type El = HTMLElement;
/** Claude-only composer nodes created on first activation (studio.html stays provider-neutral). */
const QUEUE_ID = 'claude-chat-queue', METER_ID = 'claude-usage-meter';
const SVG_NS = 'http://www.w3.org/2000/svg', RING = 2 * Math.PI * 7;

export class ClaudeChat {
  private readonly bridge: ClaudeChatBridge | null;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private state: ClaudeChatStatus | null = null;
  private statusError: string | null = null;
  private conversations: ClaudeChatConversation[] = [];
  private listed = false;
  private tabs: Tab[] = [];
  private activeKey: string | null = null;
  private tabSeq = 0;
  private turn: Turn | null = null;
  private buffered: Record<string, unknown>[] = [];
  private notice = '';
  private messageCount = 0;
  private loading = false;
  private viewEpoch = 0;
  private refreshing: Promise<void> | null = null;
  private started = false;
  private active = false;
  private removers: (() => void)[] = [];
  private tools = new Map<string, { article: HTMLElement; tool: ClaudeChatTool; text: string }>();
  /** Studio changes reported by the visible turn's tools; shown as one card when the turn ends. */
  private turnChanges: ToolChange[] = [];
  /** Messages typed while a reply runs; sent one by one after each reply finishes successfully. */
  private queue: { id: number; text: string; tabKey: string }[] = [];
  private queueSeq = 0;
  private usage = new Map<string, ClaudeConversationUsage>();
  private confirmingDelete = false;
  private deleting = new Set<string>();
  private pickerModels = false;
  private reasoningOpen = false;
  private restoreAttach: boolean | null = null;
  private crossProvider: CrossProviderModels | null = null;
  private crossSignature = '';
  private pendingChoice: { model: string; effort: string | null } | null = null;
  private readonly modelListeners = new Set<() => void>();
  private limit: ProviderUsageLimit | null = null;
  private readonly usageListeners = new Set<() => void>();

  constructor(readonly doc: Document, options: ClaudeChatOptions = {}) {
    this.bridge = Object.hasOwn(options, 'bridge') ? readClaudeChatBridge({ arcaneDesktop: { claudeChat: options.bridge } }) : readClaudeChatBridge(doc?.defaultView);
    let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
    if (Object.hasOwn(options, 'storage')) storage = options.storage ?? null;
    else { try { storage = doc?.defaultView?.localStorage ?? null; } catch { storage = null; } }
    this.storage = storage;
    this.restoreTabs();
  }

  /** True when the preload bridge is present; otherwise the surface explains it needs the desktop app. */
  available(): boolean { return !!this.bridge; }
  /** True while this controller owns the shared chat surface. */
  isActive(): boolean { return this.active; }
  activeConversation(): string | null { return this.activeTab()?.conversationId ?? null; }
  running(): boolean { return !!this.turn; }
  openTabs(): readonly { key: string; conversationId: string | null; model: string; effort: string }[] {
    return this.tabs.map(tab => ({ key: tab.key, conversationId: tab.conversationId, model: tab.model, effort: tab.effort }));
  }

  private el<T extends El = El>(id: string): T | null { return this.doc.getElementById?.(id) as T | null ?? null; }
  private make<K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, className?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node;
  }
  private activeTab(): Tab | null { return this.tabs.find(tab => tab.key === this.activeKey) ?? null; }
  private input(): HTMLTextAreaElement | null { return this.el<HTMLTextAreaElement>('codex-composer'); }

  /** Binds listeners once. Every handler is inert unless this controller owns the shared surface. */
  start(): void {
    if (this.started) { this.render(); return; }
    this.started = true;
    const listen = (target: EventTarget | null, name: string, handler: (event: Event) => void, capture = false) => {
      if (!target) return;
      const fn = (event: Event) => { if (this.active) handler(event); };
      target.addEventListener(name, fn, capture); this.removers.push(() => target.removeEventListener(name, fn, capture));
    };
    const input = this.input();
    installComposerCommands(this.doc);
    listen(this.el('codex-compose'), 'submit', event => { event.preventDefault(); this.submit(); });
    listen(this.el('codex-submit'), 'click', event => { if (this.turnOwnsActiveTab()) { event.preventDefault(); void this.stopTurn(); } });
    listen(input, 'keydown', event => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Enter' || key.shiftKey || key.isComposing || key.altKey || key.ctrlKey || key.metaKey) return;
      // While the "/" or "@" menu is open, Enter picks from it instead of sending.
      if (event.defaultPrevented || composerMenuOpen(this.doc)) return;
      event.preventDefault(); this.submit();
    });
    listen(input, 'input', () => { const tab = this.activeTab(); if (tab && input) tab.draft = input.value; this.renderControls(); });
    // Model picker: the same popover and controls as Codex, backed by Claude Code's reported aliases and efforts.
    listen(this.el('codex-model-trigger'), 'click', () => { if (this.pickerOpen()) this.closePicker(true); else this.openPicker(); });
    listen(this.el('codex-picker-current-model'), 'click', () => { if (this.pickerOpen()) { this.showModels(true); this.el('codex-model-search')?.focus({ preventScroll: true }); } });
    listen(this.el('codex-picker-back'), 'click', () => { this.showModels(false); this.el('codex-picker-current-model')?.focus({ preventScroll: true }); });
    listen(this.el('codex-model-search'), 'input', () => this.renderPicker());
    const slider = this.el<HTMLInputElement>('codex-picker-effort-slider');
    listen(slider, 'input', () => {
      const efforts = this.efforts(), index = Number(slider?.value);
      if (!this.pickerOpen() || !Number.isInteger(index) || index < 0 || index >= efforts.length) return;
      this.chooseEffort(efforts[index]!);
    });
    listen(this.el('codex-picker-reset'), 'click', () => { if (this.pickerOpen() && this.efforts().includes(DEFAULT_EFFORT)) this.chooseEffort(DEFAULT_EFFORT); });
    // The Codex chat may create the reasoning trigger after this binds, so delegate from the popover.
    listen(this.el('codex-model-popover'), 'click', event => {
      const target = event.target as Element | null;
      if (this.pickerOpen() && target?.closest?.('#codex-picker-reasoning-trigger')) { this.reasoningOpen = !this.reasoningOpen; this.renderPicker(); }
    });
    listen(this.el('codex-model-popover'), 'keydown', event => this.pickerKey(event as KeyboardEvent));
    const outside = (event: Event) => {
      const target = event.target as Node | null, popover = this.el('codex-model-popover'), trigger = this.el('codex-model-trigger');
      if (this.pickerOpen() && target && !popover?.contains(target) && !trigger?.contains(target)) this.closePicker();
    };
    listen(this.doc, 'pointerdown', outside); listen(this.doc, 'focusin', outside);
    const reposition = () => this.positionPicker();
    listen(this.doc, 'scroll', reposition, true);
    if (this.doc.defaultView) listen(this.doc.defaultView, 'resize', reposition);
    const strip = this.el('claude-chat-tabs');
    listen(strip, 'keydown', event => {
      const key = event as KeyboardEvent, target = (key.target as HTMLElement | null)?.dataset?.chatKey;
      if (!target || key.altKey || key.ctrlKey || key.metaKey || key.shiftKey) return;
      const index = this.tabs.findIndex(tab => tab.key === target); if (index < 0) return;
      if (key.key === 'Delete') { event.preventDefault(); this.closeTab(target); return; }
      const next = key.key === 'Home' ? 0 : key.key === 'End' ? this.tabs.length - 1 : key.key === 'ArrowRight' ? (index + 1) % this.tabs.length : key.key === 'ArrowLeft' ? (index + this.tabs.length - 1) % this.tabs.length : -1;
      if (next < 0) return;
      event.preventDefault(); const nextKey = this.tabs[next]!.key; this.selectTab(nextKey);
      Array.from(strip?.querySelectorAll<HTMLElement>('[role=tab]') ?? []).find(node => node.dataset.chatKey === nextKey)?.focus();
    });
    if (this.bridge) {
      try {
        const remove = this.bridge.onEvent(event => { try { this.onEvent(event); } catch { /* A malformed event cannot break the chat. */ } });
        if (typeof remove === 'function') this.removers.push(() => { try { remove(); } catch { /* Already detached. */ } });
      } catch { this.statusError = 'Claude events are unavailable. Restart Arcane to chat with Claude.'; }
    }
    this.render();
  }

  stop(): void {
    this.deactivate();
    this.started = false;
    for (const remove of this.removers.splice(0)) remove();
  }

  /** Takes over the shared transcript, composer and picker. The caller first pauses Codex drawing there. */
  activate(): void {
    if (this.active) return;
    if (!this.started) this.start();
    this.active = true;
    if (!this.tabs.length) this.createTab(null);
    if (!this.activeTab()) this.activeKey = this.tabs[0]!.key;
    const input = this.input(); if (input) input.value = this.activeTab()?.draft ?? '';
    const attach = this.el('workspace-add-context');
    if (attach) { this.restoreAttach = attach.hidden === true; attach.hidden = true; }
    for (const id of ['welcome-connect', 'codex-conversation-start', 'codex-attachments', 'codex-draft-review']) { const node = this.el(id); if (node) node.hidden = true; }
    this.showTab(this.activeKey!);
  }

  /** Returns the shared surface to Codex, keeping Claude tabs, drafts and any running turn. */
  deactivate(): void {
    if (!this.active) return;
    const tab = this.activeTab(), input = this.input();
    if (tab && input) tab.draft = input.value;
    this.closePicker();
    const attach = this.el('workspace-add-context'); if (attach && this.restoreAttach !== null) attach.hidden = this.restoreAttach;
    this.restoreAttach = null;
    this.el('codex-messages')?.removeAttribute('aria-busy');
    for (const id of [QUEUE_ID, METER_ID]) { const node = this.el(id); if (node) node.hidden = true; }
    this.active = false; this.tools.clear(); this.messageCount = 0; this.turnChanges = [];
    if (this.turn) { this.turn.bubble = null; }
  }

  /** Reads status and the conversation list. Concurrent calls share one read. */
  refresh(): Promise<void> {
    if (!this.started) this.start();
    if (!this.bridge) { this.render(); return Promise.resolve(); }
    if (this.refreshing) return this.refreshing;
    const bridge = this.bridge;
    this.refreshing = (async () => {
      try { this.state = readClaudeChatStatus(await bridge.status()); this.statusError = null; }
      catch { this.state = null; this.statusError = 'Claude Code status is unavailable. Reopen the chat to try again.'; }
      this.applyDefaults();
      this.applyPendingChoice();
      for (const listener of [...this.modelListeners]) { try { listener(); } catch { /* Observers cannot break the chat. */ } }
      await this.reloadList();
    })().finally(() => { this.refreshing = null; this.render(); });
    this.render();
    return this.refreshing;
  }

  // ---- Cross-provider model list (presentation only; switching provider is the link's explicit choice) ----
  /** The other provider's section of the shared model list (null hides it). */
  setCrossProviderModels(source: CrossProviderModels | null): void { this.crossProvider = source; this.crossSignature = ''; this.crossProviderChanged(); }
  /** The other provider's models or sign-in changed: redraw an open list when its section differs. */
  crossProviderChanged(): void {
    let signature = '';
    try { signature = JSON.stringify(this.crossProvider?.group() ?? null); } catch { signature = ''; }
    if (signature === this.crossSignature) return;
    this.crossSignature = signature;
    if (this.active && this.pickerOpen()) this.renderPicker();
  }
  /** Claude's section for the other provider's model list; null without the desktop bridge or an installed CLI. */
  modelGroup(): ComposerModelGroup | null {
    if (!this.bridge || this.state && !this.state.installed) return null;
    const ready = this.ready();
    return { provider: 'claude', label: 'Claude', available: ready, hint: !this.state ? (this.refreshing ? 'Checking Claude Code…' : 'Sign in to use') : ready ? 'Choose a model' : 'Sign in to use',
      models: ready ? this.models().map(id => { const name = this.modelLabel(id); return { id, label: name.short, title: name.id === id ? id : id + ' → ' + name.id }; }) : [] };
  }
  /** Reads Claude Code status once so another provider's model list can show Claude models. */
  loadModels(): Promise<void> { return this.state || !this.bridge ? Promise.resolve() : this.refresh(); }
  /** Status (models, efforts, sign-in) was read. */
  subscribeModels(listener: () => void): () => void { this.modelListeners.add(listener); return () => { this.modelListeners.delete(listener); }; }
  /** The last Claude reply ended at the account's usage limit (cleared by the next completed reply). Presentation only. */
  usageLimit(): ProviderUsageLimit | null { return this.limit ? { ...this.limit } : null; }
  /** Usage-limit evidence changed. */
  subscribeUsageLimit(listener: () => void): () => void { this.usageListeners.add(listener); return () => { this.usageListeners.delete(listener); }; }
  private setUsageLimit(next: ProviderUsageLimit | null): void {
    if (JSON.stringify(next) === JSON.stringify(this.limit)) return;
    this.limit = next;
    for (const listener of [...this.usageListeners]) { try { listener(); } catch { /* Observers cannot break the chat. */ } }
  }
  /** Effort of the active Claude tab, carried to the other provider when the user switches from the model list. */
  currentEffort(): string | null { return this.activeTab()?.effort || null; }
  /** Moves the unsent composer text out of Claude for a provider switch; the Claude tab keeps an empty draft. */
  takeComposerDraft(): string {
    const input = this.input(), tab = this.activeTab();
    if (!this.active || !input || !input.value) return '';
    const value = input.value; input.value = ''; if (tab) tab.draft = '';
    this.renderControls();
    return value;
  }
  /**
   * Receives a provider switch from the model list: the carried draft becomes the composer text and the chosen model
   * is selected with the carried effort when Claude Code reports it (otherwise its default). Nothing is sent.
   */
  receiveHandoff(handoff: { draft: string; model: string | null; effort: string | null }): void {
    if (!this.active) this.activate();
    const tab = this.activeTab(), input = this.input();
    if (handoff.draft && tab) { tab.draft = handoff.draft; if (input) input.value = handoff.draft; }
    this.pendingChoice = handoff.model ? { model: handoff.model, effort: handoff.effort } : null;
    this.applyPendingChoice();
    this.render();
  }
  private applyPendingChoice(): void {
    const pending = this.pendingChoice, tab = this.activeTab();
    if (!pending || !tab || !this.state) return;
    this.pendingChoice = null;
    if (!this.models().includes(pending.model)) return;
    tab.model = pending.model;
    if (pending.effort && this.efforts().includes(pending.effort)) tab.effort = pending.effort;
    this.applyDefaultsTo(tab); this.saveChoice(tab);
  }

  /** New chat: reuses an empty draft tab, otherwise opens a new one. */
  newChat(): void {
    if (this.turn && this.turn.turnId === null) return;
    this.saveDraft();
    const empty = this.tabs.find(tab => tab.conversationId === null && !tab.draft.trim());
    if (!empty && this.tabs.length >= CLAUDE_CHAT_TAB_LIMIT) { this.notice = 'Close a tab before opening another chat.'; this.render(); return; }
    const tab = empty ?? this.createTab(null);
    this.showTab(tab.key);
    try { this.input()?.focus(); } catch { /* Focus is presentation only. */ }
  }

  /** Opens a saved conversation as a tab (or switches to its existing tab). */
  async open(conversationId: string): Promise<void> {
    if (!this.bridge || this.turn && this.turn.turnId === null) return;
    this.saveDraft();
    let tab = this.tabs.find(row => row.conversationId === conversationId);
    if (!tab) {
      const reusable = this.activeTab()?.conversationId === null && !this.activeTab()!.draft.trim() ? this.activeTab() : null;
      if (!reusable && this.tabs.length >= CLAUDE_CHAT_TAB_LIMIT) { this.notice = 'Close a tab before opening another chat.'; this.render(); return; }
      tab = reusable ?? this.createTab(conversationId);
      tab.conversationId = conversationId;
      const row = this.conversations.find(item => item.conversationId === conversationId);
      if (row) this.applyChoice(tab, row.model, row.effort);
    }
    await this.showTab(tab.key);
  }

  selectTab(key: string): void {
    if (key === this.activeKey || this.turn && this.turn.turnId === null || !this.tabs.some(tab => tab.key === key)) return;
    this.saveDraft(); void this.showTab(key);
  }

  closeTab(key: string): void {
    const index = this.tabs.findIndex(tab => tab.key === key);
    if (index < 0 || this.turn && this.turn.turnId === null && this.turn.tabKey === key) return;
    this.saveDraft();
    this.tabs.splice(index, 1);
    if (!this.tabs.length) this.createTab(null);
    if (this.activeKey === key) void this.showTab(this.tabs[Math.max(0, index - 1)]!.key);
    else { this.persistTabs(); this.render(); }
  }

  /** Enter or Send: sends now, or queues the message while a reply is running. */
  submit(): void {
    if (this.turn) this.enqueue(); else void this.send();
  }

  /** Queues the composer text to send after the running reply finishes successfully. */
  enqueue(): boolean {
    const input = this.input(), tab = this.activeTab();
    if (!this.active || !input || !tab || !this.turn || !this.ready()) return false;
    const message = input.value.trim();
    if (!message) return false;
    if (message.length > MAX_INPUT) { this.notice = 'This message is too long for Claude. Shorten it to 100,000 characters.'; this.render(); return false; }
    if (this.queue.length >= CLAUDE_CHAT_QUEUE_LIMIT) { this.notice = 'Up to ' + CLAUDE_CHAT_QUEUE_LIMIT + ' messages can wait. Remove one or wait for the reply.'; this.render(); return false; }
    this.queue.push({ id: ++this.queueSeq, text: message, tabKey: tab.key });
    input.value = ''; tab.draft = '';
    this.notice = '';
    this.render();
    return true;
  }
  /** Queued messages (presentation and tests). */
  queued(): readonly { id: number; text: string }[] { return this.queue.map(item => ({ id: item.id, text: item.text })); }
  /** Removes one queued message without sending it. */
  dequeue(id: number): void {
    const before = this.queue.length;
    this.queue = this.queue.filter(item => item.id !== id);
    if (this.queue.length !== before) this.render();
  }
  /** The reply did not finish: every queued message goes back to its chat's draft. Nothing is sent. */
  private returnQueue(): void {
    if (!this.queue.length) return;
    const input = this.input();
    for (const item of this.queue.splice(0)) {
      const tab = this.tabs.find(row => row.key === item.tabKey); if (!tab) continue;
      const shown = this.active && tab.key === this.activeKey && input;
      const current = (shown ? input!.value : tab.draft).replace(/\s+$/, '');
      const next = current ? current + '\n\n' + item.text : item.text;
      tab.draft = next; if (shown) input!.value = next;
    }
    this.notice = CLAUDE_CHAT_QUEUE_RETURNED_TEXT;
  }
  /** After a successful reply: sends the next queued message when its chat is the one shown; otherwise returns it. */
  private drainQueue(): void {
    const head = this.queue[0];
    if (!head || this.turn) return;
    if (!this.active || head.tabKey !== this.activeKey || !this.canSend()) { this.returnQueue(); this.render(); return; }
    this.queue.shift();
    void this.send(head.text);
  }

  /** Sends the composer text, or one queued message (which leaves the composer untouched). */
  async send(queued?: string): Promise<void> {
    const bridge = this.bridge, input = this.input(), tab = this.activeTab();
    if (!this.active || !bridge || !input || !tab || !this.canSend() || this.turn) return;
    const message = (queued ?? input.value).trim();
    if (!message) return;
    if (message.length > MAX_INPUT) { this.notice = 'This message is too long for Claude. Shorten it to 100,000 characters.'; this.render(); return; }
    const { model, effort } = tab, epoch = this.viewEpoch, conversationId = tab.conversationId;
    const turn: Turn = this.turn = { turnId: null, conversationId, tabKey: tab.key, stopping: false, bubble: null, text: '', echo: message, prompt: message };
    this.buffered = []; this.notice = '';
    if (queued === undefined) { input.value = ''; tab.draft = ''; }
    this.appendMessage({ id: '', role: 'user', text: message, at: new Date().toISOString() }, true);
    this.render();
    let reply: Record<string, unknown> | null, failure = 'Claude could not start this message. Try again.';
    try { reply = record(await bridge.send({ conversationId, text: message, model, effort })); }
    catch (error) { reply = null; failure = bridgeError(error, failure); }
    const turnId = text(reply?.turnId, 256), nextConversation = text(reply?.conversationId, 256);
    if (!turnId || !nextConversation) {
      this.turn = null; this.buffered = [];
      const visible = this.active && epoch === this.viewEpoch;
      if (visible) this.appendMessage({ id: '', role: 'error', text: failure, at: '' }, true);
      if (queued !== undefined) this.queue.unshift({ id: ++this.queueSeq, text: message, tabKey: tab.key });
      else if (visible && !input.value) input.value = message; else if (!tab.draft) tab.draft = message;
      this.returnQueue();
      this.render(); return;
    }
    turn.turnId = turnId; turn.conversationId = nextConversation;
    if (this.tabs.includes(tab) && tab.conversationId === null) tab.conversationId = nextConversation;
    if (!this.conversations.some(row => row.conversationId === nextConversation)) {
      this.conversations.unshift({ conversationId: nextConversation, title: message.split('\n')[0]!.slice(0, 80), updatedAt: new Date().toISOString(), model, effort });
    }
    this.persistTabs();
    const pending = this.buffered.splice(0);
    this.render();
    for (const event of pending) this.onEvent(event);
  }

  async stopTurn(): Promise<void> {
    const turn = this.turn;
    if (!this.bridge || !turn?.turnId || turn.stopping) return;
    turn.stopping = true; this.render();
    let stopped = false;
    try { stopped = (await this.bridge.stop(turn.turnId)) !== false; } catch { stopped = false; }
    if (!stopped && this.turn === turn) { turn.stopping = false; this.notice = 'Claude could not stop this turn.'; this.render(); }
  }

  /** Deletes a saved conversation. A conversation with a running turn cannot be deleted. */
  async deleteConversation(conversationId: string): Promise<void> {
    const bridge = this.bridge;
    if (!bridge || this.deleting.has(conversationId) || !this.canDelete(conversationId)) return;
    this.confirmingDelete = false; this.deleting.add(conversationId); this.render();
    try { await bridge.remove(conversationId); }
    catch (error) {
      this.deleting.delete(conversationId);
      this.notice = bridgeError(error, 'This conversation could not be deleted. Try again.'); this.render(); return;
    }
    this.deleting.delete(conversationId);
    this.conversations = this.conversations.filter(row => row.conversationId !== conversationId);
    const tab = this.tabs.find(row => row.conversationId === conversationId);
    if (tab) { tab.draft = ''; this.closeTab(tab.key); }
    await this.reloadList();
    this.render();
  }

  private canDelete(conversationId: string): boolean {
    const turn = this.turn;
    return !!this.bridge && !this.deleting.has(conversationId) && !(turn && (turn.turnId === null || turn.conversationId === conversationId));
  }
  private ready(): boolean { return !!this.bridge && !!this.state?.installed && !!this.state.signedIn && !this.statusError; }
  private modelLabel(model: string): { short: string; full: string; id: string } { return claudeModelLabel(model, this.state?.resolved); }
  private models(): string[] { const state = this.state; return state ? state.models.length ? state.models : state.defaultModel ? [state.defaultModel] : [] : []; }
  private efforts(): string[] { return this.state?.efforts ?? []; }
  private canSend(): boolean { const tab = this.activeTab(); return this.ready() && !!tab && this.models().includes(tab.model) && this.efforts().includes(tab.effort); }
  private turnOwnsActiveTab(): boolean { return !!this.turn && this.turn.tabKey === this.activeKey; }

  private createTab(conversationId: string | null): Tab {
    const saved = this.readChoice();
    const tab: Tab = { key: 'claude-tab-' + (++this.tabSeq), conversationId, model: saved.model, effort: saved.effort, draft: '' };
    this.tabs.push(tab); this.applyDefaultsTo(tab);
    return tab;
  }
  private saveDraft(): void { const tab = this.activeTab(), input = this.input(); if (this.active && tab && input) tab.draft = input.value; }

  private async showTab(key: string): Promise<void> {
    const tab = this.tabs.find(row => row.key === key); if (!tab) return;
    this.activeKey = key; this.confirmingDelete = false; this.persistTabs();
    if (!this.active) { this.render(); return; }
    const epoch = ++this.viewEpoch;
    const input = this.input(); if (input) input.value = tab.draft;
    if (this.turn) { this.turn.bubble = null; this.turn.text = ''; }
    this.closePicker();
    this.loading = !!tab.conversationId; this.clearMessages();
    this.render();
    if (!tab.conversationId || !this.bridge) return;
    try {
      const value = record(await this.bridge.history(tab.conversationId));
      if (epoch !== this.viewEpoch || !this.active) return;
      const messages = Array.isArray(value?.messages) ? value.messages : null;
      if (!messages) throw Error('history');
      this.loading = false; this.clearMessages();
      for (const item of messages) { const message = readClaudeChatMessage(item); if (message) this.appendMessage(message, false); }
      // The last saved turn's changes; a turn still running in this chat shows its card when it finishes.
      if (this.turn?.conversationId !== tab.conversationId) this.flushChanges();
      this.scrollToBottom();
    } catch (error) {
      if (epoch !== this.viewEpoch || !this.active) return;
      this.loading = false; this.clearMessages();
      this.notice = bridgeError(error, 'This conversation could not be loaded. Try again.');
    }
    this.render();
  }

  private async reloadList(): Promise<void> {
    if (!this.bridge) return;
    const previous = this.conversations;
    let ok = false;
    try { this.conversations = readConversations(await this.bridge.list()); ok = true; this.listed = true; }
    catch { if (!this.statusError) this.notice = 'Saved Claude conversations could not be read.'; }
    // Keep open or just-started conversations visible until the engine lists them.
    for (const id of [...this.tabs.map(tab => tab.conversationId), this.turn?.conversationId ?? null]) {
      if (!id || this.conversations.some(row => row.conversationId === id)) continue;
      const row = previous.find(item => item.conversationId === id);
      if (row) this.conversations.unshift(row);
    }
    if (!ok) return;
    // Tabs restored from presentation storage close when their conversation no longer exists.
    const known = new Set(this.conversations.map(row => row.conversationId));
    const gone = this.tabs.filter(tab => tab.conversationId !== null && !known.has(tab.conversationId) && tab.conversationId !== this.turn?.conversationId);
    if (!gone.length) return;
    const activeGone = gone.some(tab => tab.key === this.activeKey);
    this.tabs = this.tabs.filter(tab => !gone.includes(tab));
    if (!this.tabs.length) this.createTab(null);
    if (activeGone) await this.showTab(this.tabs[0]!.key); else this.persistTabs();
  }

  private onEvent(value: unknown): void {
    const event = record(value);
    if (!event || typeof event.turnId !== 'string' || typeof event.type !== 'string') return;
    const turn = this.turn;
    if (turn && turn.turnId === null) { if (this.buffered.length < MAX_BUFFERED) this.buffered.push(event); return; }
    if (!turn || event.turnId !== turn.turnId) {
      if (event.type === 'done') void this.reloadList().then(() => this.render());
      return;
    }
    const visible = this.active && turn.conversationId !== null && turn.conversationId === this.activeTab()?.conversationId && !this.loading;
    switch (event.type) {
      case 'delta': {
        turn.text = (turn.text + text(event.text)).slice(-MAX_TEXT);
        if (!visible) return;
        const near = this.nearBottom();
        if (!turn.bubble) { turn.bubble = this.appendMessage({ id: '', role: 'assistant', text: '', at: '' }, false); turn.bubble.setAttribute('aria-busy', 'true'); }
        this.setText(turn.bubble, turn.text);
        if (near) this.scrollToBottom();
        return;
      }
      case 'message': case 'tool': {
        const message = readClaudeChatMessage(event.message);
        if (!message) return;
        if (message.role === 'user' && turn.echo !== null && message.text.trim() === turn.echo) { turn.echo = null; return; }
        if (!visible) { if (message.role === 'assistant') { turn.bubble = null; turn.text = ''; } return; }
        if (message.role === 'assistant' && turn.bubble) {
          this.setText(turn.bubble, message.text || turn.text);
          turn.bubble.setAttribute('aria-busy', 'false');
          turn.bubble = null; turn.text = ''; return;
        }
        if (message.role === 'assistant') { turn.bubble = null; turn.text = ''; }
        const near = this.nearBottom();
        this.appendMessage(message, false);
        if (near) this.scrollToBottom();
        return;
      }
      case 'done': {
        turn.bubble?.setAttribute('aria-busy', 'false');
        const ok = event.ok === true, error = nullableText(event.error, 2048), limited = ok ? null : readUsageLimit(event.usageLimit, error);
        this.turn = null;
        // At the usage limit the unanswered message returns to an empty composer so it can move to the other provider.
        // It is never resent automatically.
        if (limited) {
          const tab = this.tabs.find(row => row.key === turn.tabKey), input = this.input(), shown = this.active && tab?.key === this.activeKey;
          if (tab && !tab.draft.trim() && !(shown && input?.value.trim())) { tab.draft = turn.prompt; if (shown && input) input.value = turn.prompt; }
        }
        if (visible) this.flushChanges();
        if (visible && !ok && !(turn.stopping && !error)) this.appendMessage({ id: '', role: 'error', text: error ?? 'Claude stopped before finishing.', at: '' }, true);
        this.notice = turn.stopping && !ok ? 'Stopped.' : formatClaudeUsage(event.usage) ?? (ok ? 'Done.' : '');
        this.addUsage(turn.conversationId, event.usage);
        if (limited) this.setUsageLimit(limited); else if (ok) this.setUsageLimit(null);
        // The queue continues only after a reply that finished; a failure, Stop or usage limit returns it to the draft.
        if (ok) this.drainQueue(); else this.returnQueue();
        this.render();
        void this.reloadList().then(() => this.render());
        return;
      }
    }
  }

  /** Accumulates a finished reply's reported tokens for its conversation's meter. */
  private addUsage(conversationId: string | null, value: unknown): void {
    const usage = record(value); if (!conversationId || !usage) return;
    const input = finite(usage.inputTokens), output = finite(usage.outputTokens), cost = finite(usage.costUsd);
    if (input === null && output === null) return;
    const row = this.usage.get(conversationId) ?? { inputTokens: 0, outputTokens: 0, costUsd: null, replies: 0 };
    row.inputTokens += input ?? 0; row.outputTokens += output ?? 0; row.replies++;
    if (cost !== null) row.costUsd = (row.costUsd ?? 0) + cost;
    this.usage.set(conversationId, row);
  }
  /** Token totals for a conversation reported during this app session; null before its first finished reply. */
  conversationUsage(conversationId: string | null = this.activeConversation()): ClaudeConversationUsage | null {
    const row = conversationId ? this.usage.get(conversationId) : undefined; return row ? { ...row } : null;
  }
  /** Shows the visible turn's Studio changes as one card after its messages. */
  private flushChanges(): void {
    const changes = this.turnChanges; this.turnChanges = [];
    const box = this.el('codex-messages'); if (!box || !this.active || !changes.length) return;
    const card = renderChangeCard(this.doc, changes); if (!card) return;
    const near = this.nearBottom(); box.append(card); if (near) this.scrollToBottom();
  }
  private toolArticle(message: ClaudeChatMessage, tool: ClaudeChatTool, extra: string): HTMLElement {
    const article = this.make('article', undefined, 'codex-message tool');
    article.setAttribute('data-role', 'tool'); article.setAttribute('aria-label', 'Tool activity'); article.dataset.toolState = tool.status;
    const activity = describeToolActivity(tool.name, parseToolDetail(tool.input), parseToolDetail(tool.result), tool.status);
    if (activity.change && !this.turnChanges.some(change => change.receipt === activity.change!.receipt)) this.turnChanges.push(activity.change);
    const scope = 'Claude · ' + (this.activeTab()?.conversationId ?? 'new chat') + (message.at ? ' · ' + message.at : '');
    article.append(...renderToolActivity(this.doc, activity, tool.status,
      toolDetailText([['Tool', tool.name], ['Input', tool.input], ['Result', tool.result], ['Note', extra], ['Message', scope]])));
    return article;
  }

  /** Codex transcript markup: article.codex-message.{human|codex|tool} > pre.message-text + Message details. */
  private messageElement(message: ClaudeChatMessage): HTMLElement {
    const role = message.role === 'user' ? 'human' : message.role === 'assistant' ? 'codex' : 'tool';
    if (message.tool || message.role === 'tool') {
      const tool = message.tool ?? { name: message.text || 'Tool', status: 'finished' as const };
      const extra = message.tool && message.text && message.text !== message.tool.name ? message.text : '';
      const article = this.toolArticle(message, tool, extra);
      if (message.id) this.tools.set(message.id, { article, tool, text: extra });
      return article;
    }
    const article = this.make('article', undefined, 'codex-message ' + role);
    article.setAttribute('data-role', message.role);
    article.setAttribute('aria-label', message.role === 'user' ? 'Your message' : message.role === 'assistant' ? 'Assistant message' : 'Error');
    const body = this.make('pre', undefined, 'message-text');
    article.append(message.role === 'assistant' ? renderMessageText(this.doc, message.text) : Object.assign(body, { textContent: message.text }));
    if (message.role === 'error') article.append(this.make('p', 'Not completed', 'message-acknowledgement'));
    const details = this.make('details', undefined, 'message-details');
    details.append(this.make('summary', 'Message details'), this.make('pre', 'Claude · ' + (this.activeTab()?.conversationId ?? 'new chat') + (message.at ? ' · ' + message.at : ''), 'hint mono'));
    article.append(details);
    return article;
  }
  /** Replaces an assistant message body; fenced code renders as <pre><code>, never as HTML. */
  private setText(article: HTMLElement, value: string): void {
    const body = article.querySelector<HTMLElement>(".message-text"), next = renderMessageText(this.doc, value);
    if (body) body.replaceWith(next); else article.prepend(next);
  }
  private appendMessage(message: ClaudeChatMessage, scroll: boolean): HTMLElement {
    const known = message.id && message.tool ? this.tools.get(message.id) : undefined;
    if (known) {
      // Status update of a shown tool line: the started event's input is kept when the update omits it.
      const tool: ClaudeChatTool = { ...message.tool!, ...(message.tool!.input === undefined && known.tool.input !== undefined ? { input: known.tool.input } : {}) };
      const next = this.toolArticle(message, tool, known.text);
      known.article.replaceWith(next); this.tools.set(message.id, { article: next, tool, text: known.text });
      return next;
    }
    // A new user message starts a new turn: the previous turn's changes are summarised first.
    if (message.role === 'user') this.flushChanges();
    const box = this.el('codex-messages');
    const element = this.messageElement(message);
    if (!box) return element;
    const near = scroll || this.nearBottom();
    if (this.messageCount === 0) box.replaceChildren();
    box.append(element); this.messageCount++;
    if (near) this.scrollToBottom();
    return element;
  }

  private clearMessages(): void {
    this.tools.clear(); this.messageCount = 0; this.turnChanges = [];
    const box = this.el('codex-messages'); if (!box || !this.active) return;
    box.replaceChildren(this.make('p', this.loading ? 'Loading conversation…' : CLAUDE_CHAT_EMPTY_TEXT, 'empty'));
  }
  private nearBottom(): boolean {
    const box = this.el('codex-messages'); if (!box) return false;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 96;
  }
  private scrollToBottom(): void { const box = this.el('codex-messages'); if (box) box.scrollTop = box.scrollHeight; }

  // ---- Model and reasoning choice (per tab; the last choice is remembered for new chats) ----
  private readChoice(): { model: string; effort: string } {
    try {
      const value = record(JSON.parse(this.storage?.getItem(CLAUDE_CHAT_CHOICE_KEY) ?? 'null'));
      return { model: text(value?.model, 128), effort: text(value?.effort, 64) };
    } catch { return { model: '', effort: '' }; }
  }
  private saveChoice(tab: Tab): void {
    try { this.storage?.setItem(CLAUDE_CHAT_CHOICE_KEY, JSON.stringify({ model: tab.model, effort: tab.effort })); } catch { /* Only the remembered choice is lost. */ }
  }
  private applyDefaultsTo(tab: Tab): void {
    const models = this.models(), efforts = this.efforts();
    if (!models.length) return;
    if (!models.includes(tab.model)) tab.model = this.state?.defaultModel && models.includes(this.state.defaultModel) ? this.state.defaultModel : models[0]!;
    if (!efforts.includes(tab.effort)) tab.effort = efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : efforts[0] ?? '';
  }
  private applyDefaults(): void {
    const saved = this.readChoice();
    for (const tab of this.tabs) {
      if (!tab.model) tab.model = saved.model; if (!tab.effort) tab.effort = saved.effort;
      this.applyDefaultsTo(tab);
    }
  }
  private applyChoice(tab: Tab, model: string, effort: string): void {
    if (model && this.models().includes(model)) tab.model = model;
    if (effort && this.efforts().includes(effort)) tab.effort = effort;
  }
  private chooseModel(model: string): void {
    const tab = this.activeTab(); if (!tab || !this.models().includes(model)) return;
    tab.model = model; this.applyDefaultsTo(tab); this.saveChoice(tab);
    this.showModels(false); this.render();
  }
  private chooseEffort(effort: string): void {
    const tab = this.activeTab(); if (!tab || !this.efforts().includes(effort)) return;
    tab.effort = effort; this.saveChoice(tab); this.render();
  }

  private pickerOpen(): boolean { const popover = this.el('codex-model-popover'); return !!popover && !popover.hidden; }
  private pickerEnabled(): boolean { return this.ready() && this.models().length > 0; }
  private openPicker(): void {
    const popover = this.el('codex-model-popover'); if (!popover || !this.pickerEnabled()) return;
    popover.hidden = false; this.el('codex-model-trigger')?.setAttribute('aria-expanded', 'true');
    const search = this.el<HTMLInputElement>('codex-model-search'); if (search) search.value = '';
    this.reasoningOpen = false; this.showModels(false); this.renderPicker();
    (this.el('codex-picker-effort-slider') ?? this.el('codex-picker-current-model'))?.focus({ preventScroll: true });
    this.positionPicker();
  }
  private closePicker(restore = false): void {
    const popover = this.el('codex-model-popover'); if (!popover) return;
    const wasOpen = !popover.hidden; popover.hidden = true;
    this.el('codex-model-trigger')?.setAttribute('aria-expanded', 'false');
    this.reasoningOpen = false; this.showModels(false);
    if (restore && wasOpen) this.el('codex-model-trigger')?.focus({ preventScroll: true });
  }
  private showModels(open: boolean): void {
    this.pickerModels = open;
    const summary = this.el('codex-picker-summary'), list = this.el('codex-picker-model-list');
    if (summary) summary.hidden = open; if (list) list.hidden = !open;
    this.el('codex-picker-current-model')?.setAttribute('aria-expanded', String(open));
    const popover = this.el('codex-model-popover'); if (popover?.dataset) popover.dataset.view = open ? 'models' : 'reasoning';
    this.positionPicker();
  }
  private positionPicker(): void {
    const popover = this.el('codex-model-popover'), trigger = this.el('codex-model-trigger');
    if (!this.active || !popover || !trigger || popover.hidden) return;
    try { positionComposerPopover(this.doc, popover, trigger, this.pickerModels); } catch { /* Placement is presentation only. */ }
  }
  private pickerKey(key: KeyboardEvent): void {
    if (key.isComposing || key.altKey || key.ctrlKey || key.metaKey) return;
    if (key.key === 'Escape') {
      key.preventDefault();
      if (this.pickerModels) { this.showModels(false); this.el('codex-picker-current-model')?.focus({ preventScroll: true }); } else this.closePicker(true);
      return;
    }
    const target = key.target as HTMLElement, models = this.el('codex-model-options'), efforts = this.el('codex-picker-efforts'), search = this.el('codex-model-search');
    const inModels = !!models?.contains(target), inEfforts = !!efforts?.contains(target);
    if (target === search && key.key === 'Enter') { key.preventDefault(); if (models) firstModelRow(models)?.click(); return; }
    if (target === search && ['ArrowDown', 'ArrowUp'].includes(key.key)) {
      const row = models ? modelListEntry(models, key.key) : null; if (row) { key.preventDefault(); row.focus({ preventScroll: true }); }
      return;
    }
    if (inModels && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key.key)) {
      // Up/Down/Home/End stay within a provider column; Left/Right move between the ChatGPT and Claude columns.
      if (!['ArrowLeft', 'ArrowRight'].includes(key.key) || models!.dataset.layout === 'columns') key.preventDefault();
      const row = modelListMove(models!, target, key.key); if (row) { row.focus({ preventScroll: true }); row.scrollIntoView?.({ block: 'nearest' }); }
      return;
    }
    if (inEfforts && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key.key)) {
      const rows = Array.from((inModels ? models! : efforts!).querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = rows.indexOf(target as HTMLButtonElement), step = key.key === 'ArrowUp' ? -1 : 1;
      const next = key.key === 'Home' ? 0 : key.key === 'End' ? rows.length - 1 : (index + step + rows.length) % rows.length;
      const row = rows[next]; if (!row) return;
      key.preventDefault(); row.focus({ preventScroll: true });
      if (inEfforts) row.click();
    }
  }

  private renderPicker(): void {
    const tab = this.activeTab(), models = this.models(), efforts = this.efforts();
    const model = tab && models.includes(tab.model) ? tab.model : '', effort = tab && efforts.includes(tab.effort) ? tab.effort : '';
    const name = model ? this.modelLabel(model) : null, enabled = this.pickerEnabled();
    const set = (id: string, value: string) => { const node = this.el(id); if (node && node.textContent !== value) node.textContent = value; };
    set('codex-model-label', name?.short ?? 'Choose model');
    set('codex-effort-label', effort); const effortLabel = this.el('codex-effort-label'); if (effortLabel) effortLabel.hidden = !effort;
    const trigger = this.el<HTMLButtonElement>('codex-model-trigger');
    if (trigger) {
      trigger.disabled = !enabled; trigger.setAttribute('aria-busy', 'false');
      const label = name ? 'Claude model: ' + name.short + ' (' + (name.id === model ? model : model + ', ' + name.id) + ')' + (effort ? ', reasoning: ' + claudeEffortLabel(effort) : '') : 'Choose Claude model and reasoning';
      trigger.setAttribute('aria-label', label); trigger.title = label;
    }
    set('codex-model-picker-status', !this.bridge ? CLAUDE_CHAT_NO_BRIDGE_TEXT : !this.ready() ? 'Sign in to Claude Code to choose a model.' :
      !models.length ? 'Claude Code reported no models.' : name ? 'Claude · ' + name.short + ' · reasoning ' + (effort || 'not chosen') : 'Choose a Claude model.');
    if (!enabled && this.pickerOpen()) this.closePicker();
    if (!this.pickerOpen()) return;
    const search = this.el<HTMLInputElement>('codex-model-search');
    const query = (search?.value ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const host = this.el('codex-model-options');
    if (host) {
      const focusModel = (this.doc.activeElement as HTMLElement | null)?.dataset?.pickerModel;
      const rows = models.filter(item => { const label = this.modelLabel(item); return query.every(word => (label.full + ' ' + item + ' ' + label.id).toLocaleLowerCase().includes(word)); });
      let cross: ComposerModelGroup | null = null;
      try { cross = this.crossProvider?.group() ?? null; } catch { cross = null; }
      const own: HTMLElement[] = [];
      for (const item of rows) {
        const row = this.make('button', undefined, 'picker-model-option'); row.type = 'button';
        row.dataset.pickerModel = item; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(item === model));
        row.tabIndex = item === (rows.includes(model) ? model : rows[0]) ? 0 : -1;
        const label = this.modelLabel(item);
        row.title = (label.id === item ? item : item + ' → ' + label.id) + (item === this.state?.defaultModel ? ' · Claude Code default' : '');
        row.append(this.make('span', label.short), composerPickerCheck(this.doc, item === model));
        row.addEventListener('click', () => { if (this.active && this.pickerOpen()) this.chooseModel(item); });
        own.push(row);
      }
      // The other provider's section: choosing there switches provider explicitly through the cross-provider link.
      const other = cross ? crossProviderRows(this.doc, cross, query, id => { if (this.active && this.pickerOpen()) { this.closePicker(); this.crossProvider?.choose(id); } }) : [];
      fillModelOptions(this.doc, host, { provider: 'claude', label: 'Claude', rows: own, empty: models.length ? 'No matching models' : 'No models reported' }, cross, other, query);
      const empty = this.el('codex-model-empty');
      if (empty) { empty.hidden = !!cross || rows.length > 0; empty.textContent = models.length ? 'No Claude models match your search.' : 'Claude Code reported no models.'; }
      if (focusModel) Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(row => row.dataset.pickerModel === focusModel)?.focus({ preventScroll: true });
    }
    const effortHost = this.el('codex-picker-efforts');
    if (effortHost) {
      effortHost.replaceChildren();
      for (const value of efforts) {
        const button = this.make('button', claudeEffortLabel(value), 'picker-effort-option'); button.type = 'button'; button.dataset.pickerEffort = value;
        button.append(composerPickerCheck(this.doc, value === effort)); button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', String(value === effort));
        button.tabIndex = value === (effort || efforts[0]) ? 0 : -1;
        button.addEventListener('click', () => { if (this.active && this.pickerOpen()) this.chooseEffort(value); });
        effortHost.append(button);
      }
      effortHost.hidden = !this.reasoningOpen;
    }
    const reasoning = this.el<HTMLButtonElement>('codex-picker-reasoning-trigger');
    if (reasoning) { reasoning.textContent = 'Reasoning' + (effort ? ' · ' + effort : ''); reasoning.disabled = !efforts.length; reasoning.setAttribute('aria-expanded', String(this.reasoningOpen)); }
    const hint = this.el('codex-picker-effort-hint'); if (hint) hint.textContent = efforts.length ? 'Reasoning levels reported by Claude Code.' : 'Claude Code reported no reasoning levels.';
    set('codex-picker-effort-value', effort ? claudeEffortLabel(effort) : 'Reasoning');
    set('codex-picker-current-model-label', name?.short ?? 'Choose model');
    const slider = this.el<HTMLInputElement>('codex-picker-effort-slider');
    if (slider) {
      const index = efforts.indexOf(effort), ratio = efforts.length > 1 && index >= 0 ? Math.min(1, index / (efforts.length - 1)) : 0;
      slider.max = String(Math.max(0, efforts.length - 1)); slider.value = String(Math.max(0, index)); slider.disabled = efforts.length < 2 || index < 0;
      slider.setAttribute('aria-valuetext', effort ? claudeEffortLabel(effort) : 'Reasoning');
      slider.style?.setProperty('--effort-position', String(ratio * 100) + '%'); slider.style?.setProperty('--effort-offset', String(ratio * 24) + 'px');
      slider.dataset.effortTone = effort === 'max' ? 'ultra' : 'standard';
    }
    const reset = this.el<HTMLButtonElement>('codex-picker-reset');
    if (reset) { reset.disabled = !efforts.includes(DEFAULT_EFFORT) || effort === DEFAULT_EFFORT; reset.setAttribute('aria-label', 'Use the standard reasoning level (' + claudeEffortLabel(DEFAULT_EFFORT) + ')'); }
    this.positionPicker();
  }

  // ---- Tabs strip and Saved chats (same markup as the Codex chat tabs) ----
  private restoreTabs(): void {
    try {
      const value = record(JSON.parse(this.storage?.getItem(CLAUDE_CHAT_TABS_KEY) ?? 'null'));
      if (!value || value.version !== 1 || !Array.isArray(value.open)) return;
      const ids = [...new Set(value.open.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256))].slice(0, CLAUDE_CHAT_TAB_LIMIT);
      for (const id of ids) this.createTab(id);
      const active = this.tabs.find(tab => tab.conversationId === value.active);
      this.activeKey = active?.key ?? this.tabs[0]?.key ?? null;
    } catch { /* Presentation storage is optional. */ }
  }
  private persistTabs(): void {
    try {
      this.storage?.setItem(CLAUDE_CHAT_TABS_KEY, JSON.stringify({ version: 1,
        open: this.tabs.map(tab => tab.conversationId).filter((id): id is string => !!id), active: this.activeTab()?.conversationId ?? null }));
    } catch { /* Only the remembered tabs are lost. */ }
  }
  private tabTitle(tab: Tab): string {
    if (!tab.conversationId) return 'New chat';
    return this.conversations.find(row => row.conversationId === tab.conversationId)?.title || 'Chat';
  }
  private renderTabs(): void {
    const strip = this.el('claude-chat-tabs'); if (!strip) return;
    const sending = !!this.turn && this.turn.turnId === null;
    const focusKey = (this.doc.activeElement as HTMLElement | null)?.dataset?.chatKey;
    strip.replaceChildren();
    for (const tab of this.tabs) {
      const wrap = this.make('span', undefined, 'chat-tab'); wrap.setAttribute('role', 'presentation');
      const button = this.make('button', this.tabTitle(tab)); button.type = 'button'; button.setAttribute('role', 'tab'); button.dataset.chatKey = tab.key;
      prependProviderLogo(this.doc, button, 'claude'); // Claude tabs lead with the Claude mark; the text still names the chat.
      button.title = tab.conversationId ? this.tabTitle(tab) + ' · Claude' : 'New Claude chat';
      button.setAttribute('aria-selected', String(tab.key === this.activeKey)); button.setAttribute('aria-controls', 'codex-messages');
      button.tabIndex = tab.key === this.activeKey ? 0 : -1; button.disabled = sending && tab.key !== this.activeKey;
      if (this.turn?.tabKey === tab.key) button.setAttribute('aria-busy', 'true');
      button.addEventListener('click', () => { if (this.active) this.selectTab(tab.key); });
      const close = this.make('button', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close ' + button.textContent);
      close.disabled = sending && this.turn?.tabKey === tab.key;
      close.addEventListener('click', () => { if (this.active) this.closeTab(tab.key); });
      wrap.append(button, close); strip.append(wrap);
    }
    if (focusKey) Array.from(strip.querySelectorAll<HTMLElement>('[role=tab]')).find(node => node.dataset.chatKey === focusKey)?.focus({ preventScroll: true });
  }
  private renderSaved(): void {
    const menu = this.el<HTMLDetailsElement>('claude-saved-chats'); if (!menu) return;
    const sending = !!this.turn && this.turn.turnId === null, current = this.activeTab()?.conversationId ?? null;
    const summary = this.make('summary', 'Saved chats');
    const rows: HTMLElement[] = [summary];
    for (const row of sortConversations(this.conversations)) {
      const button = this.make('button', row.title || 'Untitled chat'); button.type = 'button';
      button.dataset.conversationId = row.conversationId; button.setAttribute('aria-current', String(row.conversationId === current));
      const name = row.model ? this.modelLabel(row.model).full : '';
      button.title = [name, row.effort, row.updatedAt].filter(Boolean).join(' · ');
      button.disabled = sending || !this.bridge;
      button.addEventListener('click', () => { if (!this.active) return; menu.open = false; void this.open(row.conversationId); });
      rows.push(button);
    }
    if (!this.conversations.length) rows.push(this.make('p', this.listed ? 'No saved Claude chats.' : 'Saved Claude chats have not been read.'));
    if (current) {
      const remove = this.make('button', this.confirmingDelete ? 'Click again to delete this chat' : 'Delete this chat'); remove.type = 'button';
      remove.className = 'claude-chat-delete'; remove.disabled = !this.canDelete(current);
      if (this.confirmingDelete) remove.setAttribute('data-confirm', 'true');
      remove.addEventListener('click', () => {
        if (!this.active || !this.canDelete(current)) return;
        if (!this.confirmingDelete) { this.confirmingDelete = true; this.renderSaved(); this.el('claude-saved-chats')?.querySelector<HTMLButtonElement>('.claude-chat-delete')?.focus(); return; }
        void this.deleteConversation(current);
      });
      rows.push(remove);
    }
    menu.replaceChildren(...rows);
  }

  private statusText(): string {
    if (!this.bridge) return CLAUDE_CHAT_NO_BRIDGE_TEXT;
    if (this.statusError) return this.statusError;
    if (!this.state) return this.refreshing ? 'Checking Claude Code…' : 'Claude Code status has not been read.';
    if (!this.state.installed) return this.state.message ?? 'Install Claude Code to chat with Claude.';
    if (!this.state.signedIn) return this.state.message ?? 'Sign in to Claude Code to chat with Claude.';
    if (!this.models().length || !this.efforts().length) return 'Claude Code reported no model or reasoning choices. Update Claude Code, then reopen the chat.';
    if (this.turn && this.notice && this.turn.turnId !== null && !this.turn.stopping) return this.notice;
    if (this.turn) {
      const waiting = this.queue.filter(item => item.tabKey === this.activeKey).length;
      const queued = waiting ? ' ' + waiting + (waiting === 1 ? ' message' : ' messages') + ' queued.' : ' Press Enter to queue your next message.';
      return this.turn.turnId === null ? 'Sending…' : this.turn.stopping ? 'Stopping…' : (this.turnOwnsActiveTab() ? 'Claude is working…' : 'Claude is replying in another chat.') + queued;
    }
    return this.notice || 'Continue in this conversation.';
  }

  private renderControls(): void {
    const input = this.input(), submit = this.el<HTMLButtonElement>('codex-submit');
    const ready = this.ready(), turn = this.turn, stopMode = this.turnOwnsActiveTab();
    if (input) input.disabled = !ready;
    if (submit) {
      submit.type = stopMode ? 'button' : 'submit';
      const state = stopMode ? 'active' : 'idle';
      if (submit.dataset.taskState !== state) {
        submit.dataset.taskState = state; submit.setAttribute('aria-label', stopMode ? 'Stop task' : 'Send message');
        const path = submit.querySelector?.('svg path'); path?.setAttribute('d', stopMode ? STOP_PATH : SEND_PATH); path?.setAttribute('fill', stopMode ? 'currentColor' : 'none');
      }
      const controls = submit.closest?.<HTMLElement>('.composer-controls'); if (controls) controls.dataset.taskActive = String(stopMode);
      submit.disabled = stopMode ? !turn?.turnId || turn.stopping : !this.canSend() || !!turn || !(input?.value.trim());
    }
    const create = this.el<HTMLButtonElement>('workspace-new-chat'); if (create) create.disabled = !!turn && turn.turnId === null;
  }

  private render(): void {
    if (!this.active) return;
    const notice = this.el('claude-chat-notice'); if (notice) notice.textContent = this.statusText();
    const status = this.el('claude-chat-status');
    if (status) status.textContent = !this.bridge ? 'Unavailable' : this.turn ? 'Working' : this.ready() ? (this.state?.cliVersion ? 'Claude Code ' + this.state.cliVersion : 'Signed in') : this.state ? 'Not signed in' : 'Checking';
    const box = this.el('codex-messages');
    if (box) { box.setAttribute('aria-busy', String(this.loading || !!this.turn)); if (this.messageCount === 0 && !box.querySelector?.('.empty')) this.clearMessages(); }
    this.renderTabs();
    this.renderSaved();
    this.renderControls();
    this.renderPicker();
    this.renderQueue();
    this.renderMeter();
  }

  /** Pending chips above the composer for messages queued in the shown chat; each can be removed. */
  private renderQueue(): void {
    let host = this.el(QUEUE_ID);
    const form = this.el('codex-compose');
    if (!host && form) {
      host = this.make('div', undefined, 'composer-queue'); host.id = QUEUE_ID;
      host.setAttribute('role', 'list'); host.setAttribute('aria-label', 'Queued messages');
      form.prepend(host);
    }
    if (!host) return;
    const items = this.queue.filter(item => item.tabKey === this.activeKey);
    host.hidden = !this.active || !items.length;
    const signature = JSON.stringify(items.map(item => item.id));
    if (host.dataset.signature === signature) return;
    host.dataset.signature = signature; host.replaceChildren();
    items.forEach((item, index) => {
      const chip = this.make('span', undefined, 'composer-queue-chip'); chip.setAttribute('role', 'listitem'); chip.title = item.text;
      const preview = item.text.replace(/\s+/g, ' ');
      chip.append(this.make('span', 'Queued ' + (index + 1), 'composer-queue-label'), this.make('span', preview.length > 60 ? preview.slice(0, 59) + '…' : preview, 'composer-queue-text'));
      const remove = this.make('button', '×', 'composer-queue-remove'); remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove queued message ' + (index + 1) + ': ' + preview.slice(0, 80));
      remove.addEventListener('click', () => { if (this.active) { this.dequeue(item.id); this.input()?.focus({ preventScroll: true }); } });
      chip.append(remove); host!.append(chip);
    });
  }

  /** Small ring + count of tokens this conversation used (from finished replies' usage), with a tooltip. */
  private renderMeter(): void {
    let meter = this.el(METER_ID);
    const controls = this.el('codex-compose')?.querySelector?.<HTMLElement>('.composer-controls') ?? null;
    if (!meter && controls) {
      meter = this.make('span', undefined, 'claude-usage-meter'); meter.id = METER_ID; meter.setAttribute('role', 'img');
      const ring = this.doc.createElementNS(SVG_NS, 'svg'); ring.setAttribute('viewBox', '0 0 18 18'); ring.setAttribute('aria-hidden', 'true'); ring.setAttribute('class', 'usage-ring');
      for (const name of ['usage-ring-track', 'usage-ring-output']) {
        const circle = this.doc.createElementNS(SVG_NS, 'circle'); circle.setAttribute('cx', '9'); circle.setAttribute('cy', '9'); circle.setAttribute('r', '7'); circle.setAttribute('class', name);
        ring.append(circle);
      }
      meter.append(ring as unknown as HTMLElement, this.make('span', '', 'usage-meter-count'));
      controls.prepend(meter);
    }
    if (!meter) return;
    const usage = this.conversationUsage();
    meter.hidden = !this.active || !usage;
    if (!usage) return;
    const total = usage.inputTokens + usage.outputTokens, label = usageMeterText(usage);
    meter.setAttribute('aria-label', label); meter.title = label;
    const count = meter.querySelector?.<HTMLElement>('.usage-meter-count'); if (count) count.textContent = compactTokens(total);
    const arc = meter.querySelector?.('.usage-ring-output');
    const share = total > 0 ? usage.outputTokens / total : 0;
    arc?.setAttribute('stroke-dasharray', (Math.max(share, total ? 0.04 : 0) * RING).toFixed(2) + ' ' + RING.toFixed(2));
  }
}

/** The Codex chat's side of the shared composer (see CodexChat). */
export interface CodexComposerPeer {
  yieldSurface(yielded: boolean): void;
  setCrossProviderModels(source: CrossProviderModels | null): void;
  crossProviderChanged(): void;
  modelGroup(): ComposerModelGroup;
  currentEffort(): string | null;
  takeComposerDraft(): string;
  receiveHandoff(handoff: { draft: string; model: string | null; effort: string | null }): void;
  subscribeStateChange?(listener: () => void): () => void;
  /** Fresh evidence that the signed-in ChatGPT account is out of usage (CodexChat.usageLimit). */
  usageLimit?(): ProviderUsageLimit | null;
}
/** Provider setup's side: which provider owns the surface, and an explicit provider choice. */
export interface ChatProviderSwitch {
  chatSurface(): ComposerProvider;
  subscribeChatSurface(listener: () => void): () => void;
  requestProvider(next: ComposerProvider): boolean;
}
export interface ChatProviderLink {
  /** Applies the current surface owner: Codex yields and Claude activates, or the reverse. Idempotent. */
  sync(): void;
  stop(): void;
}
const HANDOFF_MS = 120000;
const PROVIDER_NAMES: Record<ComposerProvider, string> = { codex: 'ChatGPT', claude: 'Claude' };
/** Reported reset time in the viewer's locale: time only today, weekday and time otherwise. */
export function formatUsageReset(resetsAt: number, now = Date.now()): string {
  const at = new Date(resetsAt * 1000), today = new Date(now).toDateString() === at.toDateString();
  return at.toLocaleString(undefined, today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
/** The composer notice sentence for one provider's usage limit. */
export function usageLimitNoticeText(provider: ComposerProvider, limit: ProviderUsageLimit, now = Date.now()): string {
  const name = PROVIDER_NAMES[provider];
  if (limit.resetsAt === null) return name + ' usage limit reached.';
  if (limit.resetsAt * 1000 <= now) return name + ' reported a usage limit; its reported reset time has passed.';
  return name + ' usage limit reached \u2014 resets at ' + formatUsageReset(limit.resetsAt, now) + '.';
}
/** Ids of the inline usage-limit notice above the shared composer (studio.html). */
export const USAGE_LIMIT_NOTICE_IDS = Object.freeze({ root: 'usage-limit-notice', message: 'usage-limit-message', action: 'usage-limit-action' });
/**
 * Links the Codex and Claude chats that share one composer: each model list shows both providers' models, and choosing
 * the other provider's model requests that provider explicitly through provider setup. When the surface actually
 * switches, the unsent composer text moves with it and the chosen model is selected with the current effort when the
 * new provider supports it. A switch never sends a message or starts a turn.
 */
export function linkChatProviders(options: { codex: CodexComposerPeer; claude: ClaudeChat; provider: ChatProviderSwitch; enabled?: () => boolean }): ChatProviderLink {
  const { codex, claude, provider } = options;
  let pending: { target: ComposerProvider; model: string | null; effort: string | null; at: number } | null = null;
  let current: ComposerProvider | null = null, stopped = false;
  const removers: (() => void)[] = [];
  const request = (target: ComposerProvider, model: string, effort: string | null) => {
    if (stopped) return;
    pending = { target, model: model || null, effort, at: Date.now() };
    if (provider.chatSurface() === target) { sync(); return; }
    if (!provider.requestProvider(target)) pending = null;
  };
  codex.setCrossProviderModels({
    group: () => claude.modelGroup(),
    choose: model => request('claude', model, codex.currentEffort()),
    opened: () => { const loading = claude.loadModels(); codex.crossProviderChanged(); void loading.then(() => codex.crossProviderChanged(), () => {}); },
  });
  claude.setCrossProviderModels({ group: () => codex.modelGroup(), choose: model => request('codex', model, claude.currentEffort()) });
  removers.push(claude.subscribeModels(() => codex.crossProviderChanged()));
  if (codex.subscribeStateChange) removers.push(codex.subscribeStateChange(() => claude.crossProviderChanged()));
  const sync = () => {
    const live = !stopped && (options.enabled?.() ?? true);
    const next: ComposerProvider = live && provider.chatSurface() === 'claude' ? 'claude' : 'codex';
    const fresh = pending && Date.now() - pending.at <= HANDOFF_MS ? pending : null;
    // Only a real switch toward the provider the user picked carries the draft and model; startup, resume and
    // Settings changes keep each provider's own draft.
    const carry = live && current !== null && current !== next && fresh?.target === next ? fresh : null;
    if (carry || !fresh) pending = null;
    try {
      if (next === 'claude') {
        const draft = carry ? codex.takeComposerDraft() : '';
        codex.yieldSurface(true); claude.activate(); void claude.refresh();
        if (carry) claude.receiveHandoff({ draft, model: carry.model, effort: carry.effort });
      } else {
        const draft = carry ? claude.takeComposerDraft() : '';
        claude.deactivate(); codex.yieldSurface(false);
        if (carry) codex.receiveHandoff({ draft, model: carry.model, effort: carry.effort });
      }
    } catch { /* A surface hand-off is presentation only and cannot break the workspace. */ }
    current = live ? next : null;
    renderNotice();
  };
  // ---- Usage-limit notice: one inline notice above the composer for the provider that owns the surface. ----
  // It offers the other provider in one click (the same explicit, draft-carrying switch as the model list) or its
  // sign-in; it never retries, resends or switches by itself.
  const doc = claude.doc;
  let action: { kind: 'switch' | 'setup'; target: ComposerProvider } | null = null, claudeStatusRequested = false;
  const node = (id: string) => { try { return doc?.getElementById?.(id) ?? null; } catch { return null; } };
  const renderNotice = () => {
    const root = node(USAGE_LIMIT_NOTICE_IDS.root), message = node(USAGE_LIMIT_NOTICE_IDS.message), button = node(USAGE_LIMIT_NOTICE_IDS.action) as HTMLButtonElement | null;
    if (!root) return;
    let text = '', next: typeof action = null, label = '';
    try {
      const live = !stopped && (options.enabled?.() ?? true), owner: ComposerProvider = live && current === 'claude' ? 'claude' : 'codex';
      const limit = live ? owner === 'codex' ? codex.usageLimit?.() ?? null : claude.usageLimit() : null;
      if (limit) {
        text = usageLimitNoticeText(owner, limit);
        if (owner === 'codex') {
          const group = claude.modelGroup();
          // Claude's sign-in is read once so the notice can offer the switch instead of the sign-in.
          if (group && !group.available && !claudeStatusRequested) { claudeStatusRequested = true; void claude.loadModels().catch(() => {}); }
          if (group?.available) { next = { kind: 'switch', target: 'claude' }; label = 'Switch to Claude'; text += ' Your draft moves with you.'; }
          else if (claude.available()) { next = { kind: 'setup', target: 'claude' }; label = 'Sign in to Claude'; text += ' Your draft stays here.'; }
        } else {
          const group = codex.modelGroup(), codexLimited = !!codex.usageLimit?.();
          if (group.available && !codexLimited) { next = { kind: 'switch', target: 'codex' }; label = 'Switch to ChatGPT'; text += ' Your draft moves with you.'; }
          else text += codexLimited ? ' ChatGPT is also at its usage limit.' : ' Your draft stays here.';
        }
      }
    } catch { text = ''; next = null; }
    action = next;
    root.hidden = !text; root.dataset.provider = text ? (current ?? 'codex') : '';
    if (message && message.textContent !== text) message.textContent = text;
    if (button) { button.hidden = !next; button.disabled = !next; if (button.textContent !== label) button.textContent = label; button.className = next?.kind === 'setup' ? 'secondary' : ''; }
  };
  const actionButton = node(USAGE_LIMIT_NOTICE_IDS.action);
  if (actionButton) {
    const press = () => {
      const chosen = action; if (!chosen || stopped) return;
      if (chosen.kind === 'switch') { request(chosen.target, '', chosen.target === 'claude' ? codex.currentEffort() : claude.currentEffort()); return; }
      // Sign-in: choose Claude explicitly (so a later switch still carries the draft) and open provider setup.
      request(chosen.target, '', null);
      const Event = doc?.defaultView?.CustomEvent;
      if (Event) doc.dispatchEvent(new Event('workspace:providersetup', { detail: { provider: chosen.target } }));
    };
    actionButton.addEventListener('click', press);
    removers.push(() => actionButton.removeEventListener('click', press));
  }
  removers.push(claude.subscribeUsageLimit(renderNotice), claude.subscribeModels(renderNotice));
  if (codex.subscribeStateChange) removers.push(codex.subscribeStateChange(renderNotice));
  removers.push(provider.subscribeChatSurface(sync));
  sync();
  return {
    sync() { stopped = false; sync(); },
    stop() { stopped = true; pending = null; current = null; renderNotice(); },
  };
}
