/// <reference lib="dom" />
// Browser-only Claude chat surface. It talks exclusively to the Electron preload
// bridge `window.arcaneDesktop.claudeChat`; it imports nothing and renders model
// output with textContent only (never innerHTML).

export type ClaudeChatRole = 'user' | 'assistant' | 'tool' | 'error';
export type ClaudeToolStatus = 'started' | 'finished' | 'failed';
export interface ClaudeChatTool { name: string; status: ClaudeToolStatus }
export interface ClaudeChatMessage { id: string; role: ClaudeChatRole; text: string; at: string; tool?: ClaudeChatTool }
export interface ClaudeChatStatus {
  installed: boolean; signedIn: boolean; cliVersion: string | null; models: string[]; efforts: string[];
  defaultModel: string | null; message: string | null;
}
export interface ClaudeChatConversation { conversationId: string; title: string; updatedAt: string; model: string; effort: string }
export interface ClaudeChatUsage { inputTokens: number; outputTokens: number; costUsd: number | null }
export type ClaudeChatEvent =
  | { turnId: string; conversationId: string; type: 'delta'; text: string }
  | { turnId: string; conversationId: string; type: 'message'; message: ClaudeChatMessage }
  | { turnId: string; conversationId: string; type: 'tool'; message: ClaudeChatMessage }
  | { turnId: string; conversationId: string; type: 'done'; ok: boolean; error: string | null; usage: ClaudeChatUsage | null };
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
export const CLAUDE_CHAT_EMPTY_TEXT = 'Ask Claude to build something in your Studio place';
export const CLAUDE_CHAT_NO_BRIDGE_TEXT = 'Claude chat requires the Arcane desktop app.';
const MAX_TEXT = 1024 * 1024, MAX_INPUT = 100000, MAX_BUFFERED = 2000;
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

export function readClaudeChatStatus(value: unknown): ClaudeChatStatus {
  const state = record(value);
  if (!state || typeof state.installed !== 'boolean' || typeof state.signedIn !== 'boolean') throw Error('Claude status unavailable.');
  return {
    installed: state.installed, signedIn: state.installed && state.signedIn, cliVersion: nullableText(state.cliVersion, 100),
    models: names(state.models), efforts: names(state.efforts), defaultModel: nullableText(state.defaultModel, 128), message: nullableText(state.message, 2048),
  };
}
export function readClaudeChatMessage(value: unknown): ClaudeChatMessage | null {
  const message = record(value);
  if (!message || typeof message.role !== 'string' || !ROLES.includes(message.role as ClaudeChatRole)) return null;
  const output: ClaudeChatMessage = { id: text(message.id, 256), role: message.role as ClaudeChatRole, text: text(message.text), at: text(message.at, 64) };
  const tool = record(message.tool);
  if (tool && typeof tool.status === 'string' && TOOL_STATES.includes(tool.status as ClaudeToolStatus))
    output.tool = { name: text(tool.name, 256) || 'Tool', status: tool.status as ClaudeToolStatus };
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
export function formatClaudeUsage(value: unknown): string | null {
  const usage = record(value); if (!usage) return null;
  const input = finite(usage.inputTokens), output = finite(usage.outputTokens), cost = finite(usage.costUsd);
  const parts: string[] = [];
  if (input !== null) parts.push(Math.round(input) + ' input tokens');
  if (output !== null) parts.push(Math.round(output) + ' output tokens');
  if (cost !== null) parts.push('$' + cost.toFixed(4));
  return parts.length ? 'Done · ' + parts.join(' · ') : null;
}

/** Safe text rendering: blank-line paragraphs and ``` fenced code, all via DOM nodes and textContent. */
export function renderClaudeText(doc: Document, target: HTMLElement, value: string): void {
  const nodes: HTMLElement[] = [];
  value.split('```').forEach((part, index) => {
    if (index % 2 === 1) {
      let code = part, language = '';
      const newline = code.indexOf('\n');
      if (newline >= 0 && /^[A-Za-z0-9_+#.-]{0,32}$/.test(code.slice(0, newline).trim())) { language = code.slice(0, newline).trim(); code = code.slice(newline + 1); }
      const pre = doc.createElement('pre'), element = doc.createElement('code');
      element.textContent = code.replace(/\n$/, '');
      if (language) element.setAttribute('data-language', language);
      pre.append(element); nodes.push(pre);
      return;
    }
    for (const paragraph of part.split(/\n[ \t]*\n/)) {
      const trimmed = paragraph.replace(/^\n+|\n+$/g, '');
      if (!trimmed.trim()) continue;
      const element = doc.createElement('p'); element.textContent = trimmed; nodes.push(element);
    }
  });
  target.replaceChildren(...nodes);
}

interface Turn {
  turnId: string | null; conversationId: string | null; stopping: boolean;
  bubble: HTMLElement | null; text: string; echo: string | null;
}
type Elements = {
  messages: HTMLElement; input: HTMLTextAreaElement; send: HTMLButtonElement; composer: HTMLElement; list: HTMLElement;
  stop: HTMLButtonElement | null; model: HTMLSelectElement | null; effort: HTMLSelectElement | null; status: HTMLElement | null; create: HTMLButtonElement | null;
};

export class ClaudeChat {
  private readonly doc: Document;
  private readonly bridge: ClaudeChatBridge | null;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly els: Elements | null;
  private state: ClaudeChatStatus | null = null;
  private statusError: string | null = null;
  private conversations: ClaudeChatConversation[] = [];
  private activeId: string | null = null;
  private turn: Turn | null = null;
  private buffered: Record<string, unknown>[] = [];
  private notice = '';
  private messageCount = 0;
  private viewEpoch = 0;
  private refreshing: Promise<void> | null = null;
  private started = false;
  private removers: (() => void)[] = [];
  private tools = new Map<string, HTMLElement>();
  private choiceSignature = '';
  /** Conversation whose delete control is waiting for its confirming second click. */
  private confirmingDelete: string | null = null;
  private deleting = new Set<string>();
  private focusConfirm = false;

  constructor(readonly root: HTMLElement, options: ClaudeChatOptions = {}) {
    this.doc = root.ownerDocument;
    this.bridge = Object.hasOwn(options, 'bridge') ? readClaudeChatBridge({ arcaneDesktop: { claudeChat: options.bridge } }) : readClaudeChatBridge(this.doc?.defaultView);
    let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
    if (Object.hasOwn(options, 'storage')) storage = options.storage ?? null;
    else { try { storage = this.doc?.defaultView?.localStorage ?? null; } catch { storage = null; } }
    this.storage = storage;
    const find = <T extends HTMLElement>(name: string) => root.querySelector<T>('.' + name);
    const messages = find('claude-chat-messages'), input = find<HTMLTextAreaElement>('claude-chat-input'), send = find<HTMLButtonElement>('claude-chat-send');
    const composer = find('claude-chat-composer'), list = find('claude-chat-list');
    this.els = messages && input && send && composer && list ? {
      messages, input, send, composer, list, stop: find('claude-chat-stop'), model: find('claude-chat-model'),
      effort: find('claude-chat-effort'), status: find('claude-chat-status'), create: find('claude-chat-new'),
    } : null;
  }

  /** True when the preload bridge is present; otherwise the surface explains it needs the desktop app. */
  available(): boolean { return !!this.bridge; }
  activeConversation(): string | null { return this.activeId; }
  running(): boolean { return !!this.turn; }

  start(): void {
    if (this.started || !this.els) { this.render(); return; }
    this.started = true;
    const { input, composer, stop, model, effort, create } = this.els;
    const listen = (target: EventTarget | null, name: string, handler: (event: Event) => void) => {
      if (!target) return; target.addEventListener(name, handler); this.removers.push(() => target.removeEventListener(name, handler));
    };
    listen(composer, 'submit', event => { event.preventDefault(); void this.send(); });
    listen(input, 'keydown', event => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Enter' || key.shiftKey || key.isComposing || key.altKey || key.ctrlKey || key.metaKey) return;
      event.preventDefault(); void this.send();
    });
    listen(input, 'input', () => this.renderControls());
    listen(stop, 'click', () => { void this.stopTurn(); });
    listen(create, 'click', () => this.newChat());
    listen(model, 'change', () => this.saveChoice());
    listen(effort, 'change', () => this.saveChoice());
    if (this.bridge) {
      try {
        const remove = this.bridge.onEvent(event => { try { this.onEvent(event); } catch { /* A malformed event cannot break the chat. */ } });
        if (typeof remove === 'function') this.removers.push(() => { try { remove(); } catch { /* Already detached. */ } });
      } catch { this.statusError = 'Claude events are unavailable. Restart Arcane to chat with Claude.'; }
    }
    this.render();
  }

  stop(): void {
    this.started = false;
    for (const remove of this.removers.splice(0)) remove();
  }

  /** Reads status and the conversation list. Concurrent calls share one read. */
  refresh(): Promise<void> {
    if (!this.started) this.start();
    if (!this.bridge || !this.els) { this.render(); return Promise.resolve(); }
    if (this.refreshing) return this.refreshing;
    const bridge = this.bridge;
    this.refreshing = (async () => {
      try { this.state = readClaudeChatStatus(await bridge.status()); this.statusError = null; }
      catch { this.state = null; this.statusError = 'Claude Code status is unavailable. Reopen the chat to try again.'; }
      this.populateChoices();
      await this.reloadList();
    })().finally(() => { this.refreshing = null; this.render(); });
    this.render();
    return this.refreshing;
  }

  newChat(): void {
    if (!this.els || this.turn && this.turn.turnId === null) return;
    this.activeId = null; this.viewEpoch++; this.notice = ''; this.confirmingDelete = null;
    this.clearMessages(); this.render();
    try { this.els.input.focus(); } catch { /* Focus is presentation only. */ }
  }

  async open(conversationId: string): Promise<void> {
    if (!this.els || !this.bridge || this.turn && this.turn.turnId === null) return;
    const row = this.conversations.find(item => item.conversationId === conversationId);
    this.activeId = conversationId; const epoch = ++this.viewEpoch; this.confirmingDelete = null;
    this.notice = 'Loading conversation…'; this.clearMessages();
    if (row) this.applyChoice(row.model, row.effort);
    if (this.turn?.conversationId === conversationId) { this.turn.bubble = null; this.turn.text = ''; }
    this.render();
    try {
      const value = record(await this.bridge.history(conversationId));
      if (epoch !== this.viewEpoch) return;
      const messages = Array.isArray(value?.messages) ? value.messages : null;
      if (!messages) throw Error('history');
      this.clearMessages();
      for (const item of messages) { const message = readClaudeChatMessage(item); if (message) this.appendMessage(message, false); }
      this.notice = '';
      this.scrollToBottom();
    } catch (error) {
      if (epoch !== this.viewEpoch) return;
      this.notice = bridgeError(error, 'This conversation could not be loaded. Try again.');
    }
    this.render();
  }

  async send(): Promise<void> {
    const els = this.els, bridge = this.bridge;
    if (!els || !bridge || !this.canSend() || this.turn) return;
    const message = els.input.value.trim();
    if (!message || message.length > MAX_INPUT) return;
    const model = els.model?.value ?? this.state?.defaultModel ?? '', effort = els.effort?.value ?? '';
    const epoch = this.viewEpoch, conversationId = this.activeId;
    const turn: Turn = this.turn = { turnId: null, conversationId, stopping: false, bubble: null, text: '', echo: message };
    this.buffered = []; this.notice = '';
    els.input.value = '';
    this.appendMessage({ id: '', role: 'user', text: message, at: new Date().toISOString() }, true);
    this.render();
    let reply: Record<string, unknown> | null, failure = 'Claude could not start this message. Try again.';
    try { reply = record(await bridge.send({ conversationId, text: message, model, effort })); }
    catch (error) { reply = null; failure = bridgeError(error, failure); }
    const turnId = text(reply?.turnId, 256), nextConversation = text(reply?.conversationId, 256);
    if (!turnId || !nextConversation) {
      this.turn = null; this.buffered = [];
      if (epoch === this.viewEpoch) this.appendMessage({ id: '', role: 'error', text: failure, at: '' }, true);
      if (!els.input.value) els.input.value = message;
      this.render(); return;
    }
    turn.turnId = turnId; turn.conversationId = nextConversation;
    if (epoch === this.viewEpoch && this.activeId === null) this.activeId = nextConversation;
    if (!this.conversations.some(row => row.conversationId === nextConversation)) {
      this.conversations.unshift({ conversationId: nextConversation, title: message.split('\n')[0]!.slice(0, 80), updatedAt: new Date().toISOString(), model, effort });
    }
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

  /** Deletes a saved conversation after the confirm click. A conversation with a running turn cannot be deleted. */
  async deleteConversation(conversationId: string): Promise<void> {
    const bridge = this.bridge;
    if (!this.els || !bridge || this.deleting.has(conversationId) || !this.canDelete(conversationId)) return;
    this.confirmingDelete = null; this.deleting.add(conversationId); this.render();
    try { await bridge.remove(conversationId); }
    catch (error) {
      this.deleting.delete(conversationId);
      this.notice = bridgeError(error, 'This conversation could not be deleted. Try again.'); this.render(); return;
    }
    this.deleting.delete(conversationId);
    this.conversations = this.conversations.filter(row => row.conversationId !== conversationId);
    if (this.activeId === conversationId) this.newChat();
    await this.reloadList();
    this.render();
  }

  private canDelete(conversationId: string): boolean {
    const turn = this.turn;
    return !!this.bridge && !this.deleting.has(conversationId) && !(turn && (turn.turnId === null || turn.conversationId === conversationId));
  }

  private canSend(): boolean { return this.ready() && !!this.els?.model?.value && !!this.els.effort?.value; }
  private ready(): boolean { return !!this.bridge && !!this.state?.installed && !!this.state.signedIn && !this.statusError; }

  private async reloadList(): Promise<void> {
    if (!this.bridge) return;
    const previous = this.conversations;
    try { this.conversations = readConversations(await this.bridge.list()); }
    catch { if (!this.statusError) this.notice = 'Saved Claude conversations could not be read.'; }
    // Keep the open or just-started conversation visible until the engine lists it.
    for (const id of [this.activeId, this.turn?.conversationId ?? null]) {
      if (!id || this.conversations.some(row => row.conversationId === id)) continue;
      const row = previous.find(item => item.conversationId === id);
      if (row) this.conversations.unshift(row);
    }
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
    const visible = turn.conversationId === this.activeId;
    switch (event.type) {
      case 'delta': {
        turn.text = (turn.text + text(event.text)).slice(-MAX_TEXT);
        if (!visible) return;
        const near = this.nearBottom();
        if (!turn.bubble) { turn.bubble = this.appendMessage({ id: '', role: 'assistant', text: '', at: '' }, false); turn.bubble.setAttribute('aria-busy', 'true'); }
        const body = turn.bubble.querySelector<HTMLElement>('.claude-message-body');
        if (body) renderClaudeText(this.doc, body, turn.text);
        if (near) this.scrollToBottom();
        return;
      }
      case 'message': case 'tool': {
        const message = readClaudeChatMessage(event.message);
        if (!message) return;
        if (message.role === 'user' && turn.echo !== null && message.text.trim() === turn.echo) { turn.echo = null; return; }
        if (!visible) { if (message.role === 'assistant') { turn.bubble = null; turn.text = ''; } return; }
        if (message.role === 'assistant' && turn.bubble) {
          const body = turn.bubble.querySelector<HTMLElement>('.claude-message-body');
          if (body) renderClaudeText(this.doc, body, message.text || turn.text);
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
        const ok = event.ok === true, error = nullableText(event.error, 2048);
        this.turn = null;
        if (visible && !ok && !(turn.stopping && !error)) this.appendMessage({ id: '', role: 'error', text: error ?? 'Claude stopped before finishing.', at: '' }, true);
        this.notice = turn.stopping && !ok ? 'Stopped.' : formatClaudeUsage(event.usage) ?? (ok ? 'Done.' : '');
        this.render();
        void this.reloadList().then(() => this.renderList());
        return;
      }
    }
  }

  private messageElement(message: ClaudeChatMessage): HTMLElement {
    const article = this.doc.createElement('article');
    article.className = 'claude-message';
    article.setAttribute('data-role', message.role);
    article.setAttribute('aria-label', message.role === 'user' ? 'Your message' : message.role === 'assistant' ? 'Claude' : message.role === 'tool' ? 'Tool activity' : 'Error');
    if (message.tool || message.role === 'tool') {
      const chip = this.doc.createElement('span');
      chip.className = 'claude-tool-chip';
      this.updateChip(chip, message.tool ?? { name: message.text || 'Tool', status: 'finished' });
      article.append(chip);
      if (message.id) this.tools.set(message.id, chip);
      if (message.tool && message.text && message.text !== message.tool.name) {
        const body = this.doc.createElement('div'); body.className = 'claude-message-body'; body.textContent = message.text; article.append(body);
      }
      return article;
    }
    const body = this.doc.createElement('div');
    body.className = 'claude-message-body';
    if (message.role === 'error') body.textContent = message.text;
    else renderClaudeText(this.doc, body, message.text);
    article.append(body);
    return article;
  }

  private updateChip(chip: HTMLElement, tool: ClaudeChatTool) {
    chip.setAttribute('data-status', tool.status);
    chip.textContent = tool.name + (tool.status === 'started' ? ' · running' : tool.status === 'failed' ? ' · failed' : ' · done');
  }

  private appendMessage(message: ClaudeChatMessage, scroll: boolean): HTMLElement {
    const els = this.els!;
    if (message.id && message.tool && this.tools.has(message.id)) {
      const chip = this.tools.get(message.id)!; this.updateChip(chip, message.tool);
      return chip;
    }
    const near = scroll || this.nearBottom();
    if (this.messageCount === 0) els.messages.replaceChildren();
    const element = this.messageElement(message);
    els.messages.append(element); this.messageCount++;
    if (near) this.scrollToBottom();
    return element;
  }

  private clearMessages() {
    if (!this.els) return;
    this.tools.clear(); this.messageCount = 0;
    const empty = this.doc.createElement('p');
    empty.className = 'claude-chat-empty'; empty.textContent = CLAUDE_CHAT_EMPTY_TEXT;
    this.els.messages.replaceChildren(empty);
  }

  private nearBottom(): boolean {
    const box = this.els?.messages; if (!box) return false;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 96;
  }
  private scrollToBottom() { const box = this.els?.messages; if (box) box.scrollTop = box.scrollHeight; }

  private readChoice(): { model: string; effort: string } {
    try {
      const value = record(JSON.parse(this.storage?.getItem(CLAUDE_CHAT_CHOICE_KEY) ?? 'null'));
      return { model: text(value?.model, 128), effort: text(value?.effort, 64) };
    } catch { return { model: '', effort: '' }; }
  }
  private saveChoice() {
    const model = this.els?.model?.value ?? '', effort = this.els?.effort?.value ?? '';
    try { this.storage?.setItem(CLAUDE_CHAT_CHOICE_KEY, JSON.stringify({ model, effort })); } catch { /* Only the remembered choice is lost. */ }
  }
  private fill(select: HTMLSelectElement | null, values: string[], label: (value: string) => string) {
    if (!select) return;
    select.replaceChildren(...values.map(value => {
      const option = this.doc.createElement('option'); option.value = value; option.textContent = label(value); return option;
    }));
  }
  private populateChoices() {
    const state = this.state;
    const models = state ? state.models.length ? state.models : state.defaultModel ? [state.defaultModel] : [] : [];
    const efforts = state?.efforts ?? [];
    const signature = JSON.stringify([models, efforts]);
    if (signature === this.choiceSignature) return;
    this.choiceSignature = signature;
    this.fill(this.els?.model ?? null, models, value => value === state?.defaultModel ? value + ' (default)' : value);
    this.fill(this.els?.effort ?? null, efforts, value => value);
    const saved = this.readChoice();
    const model = models.includes(saved.model) ? saved.model : state?.defaultModel && models.includes(state.defaultModel) ? state.defaultModel : models[0] ?? '';
    const effort = efforts.includes(saved.effort) ? saved.effort : efforts.includes('high') ? 'high' : efforts[0] ?? '';
    this.setSelect(this.els?.model ?? null, model); this.setSelect(this.els?.effort ?? null, effort);
  }
  private applyChoice(model: string, effort: string) {
    const els = this.els; if (!els) return;
    if (model && this.state?.models.includes(model)) this.setSelect(els.model, model);
    if (effort && this.state?.efforts.includes(effort)) this.setSelect(els.effort, effort);
  }
  private setSelect(select: HTMLSelectElement | null, value: string) { if (select) select.value = value; }

  private statusText(): string {
    if (!this.bridge) return CLAUDE_CHAT_NO_BRIDGE_TEXT;
    if (this.statusError) return this.statusError;
    if (!this.state) return this.refreshing ? 'Checking Claude Code…' : 'Claude Code status has not been read.';
    if (!this.state.installed) return this.state.message ?? 'Install Claude Code to chat with Claude.';
    if (!this.state.signedIn) return this.state.message ?? 'Sign in to Claude Code to chat with Claude.';
    if (!this.els?.model?.value || !this.els.effort?.value) return 'Claude Code reported no model or effort choices. Update Claude Code, then reopen the chat.';
    if (this.turn) return this.turn.turnId === null ? 'Sending…' : this.turn.stopping ? 'Stopping…' : 'Claude is working…';
    return this.notice || (this.state.cliVersion ? 'Claude Code ' + this.state.cliVersion + ' · signed in' : 'Claude Code signed in');
  }

  private renderList() {
    const els = this.els; if (!els) return;
    sortConversations(this.conversations);
    if (this.confirmingDelete && !this.conversations.some(row => row.conversationId === this.confirmingDelete && this.canDelete(row.conversationId))) this.confirmingDelete = null;
    let confirmButton: HTMLButtonElement | null = null;
    els.list.replaceChildren(...this.conversations.map(row => {
      const item = this.doc.createElement('button');
      item.type = 'button'; item.className = 'claude-chat-item';
      item.textContent = row.title || 'Untitled chat';
      item.setAttribute('data-conversation-id', row.conversationId);
      item.setAttribute('aria-current', String(row.conversationId === this.activeId));
      if (row.updatedAt) item.title = row.updatedAt;
      item.disabled = !this.bridge || !!this.turn && this.turn.turnId === null;
      item.addEventListener('click', () => { if (row.conversationId !== this.activeId) void this.open(row.conversationId); });
      const remove = this.doc.createElement('button'), confirming = this.confirmingDelete === row.conversationId;
      remove.type = 'button'; remove.className = 'claude-chat-delete';
      remove.setAttribute('aria-label', 'Delete conversation ' + (row.title || 'Untitled chat'));
      remove.textContent = confirming ? 'Delete?' : '×';
      remove.title = confirming ? 'Click again to delete this conversation' : 'Delete conversation';
      if (confirming) { remove.setAttribute('data-confirm', 'true'); confirmButton = remove; }
      remove.disabled = !this.canDelete(row.conversationId);
      remove.addEventListener('click', () => {
        if (!this.canDelete(row.conversationId)) return;
        if (this.confirmingDelete !== row.conversationId) { this.confirmingDelete = row.conversationId; this.focusConfirm = true; this.renderList(); return; }
        void this.deleteConversation(row.conversationId);
      });
      const wrap = this.doc.createElement('div');
      wrap.className = 'claude-chat-row'; wrap.append(item, remove);
      return wrap;
    }));
    // Keep keyboard focus on the control that now asks for confirmation (only right after the first click).
    if (this.focusConfirm) { this.focusConfirm = false; try { (confirmButton as HTMLButtonElement | null)?.focus(); } catch { /* Focus is presentation only. */ } }
  }

  private renderControls() {
    const els = this.els; if (!els) return;
    const ready = this.ready(), turn = this.turn;
    els.input.disabled = !ready;
    els.send.disabled = !this.canSend() || !!turn || !els.input.value.trim();
    if (els.stop) { els.stop.hidden = !turn; els.stop.disabled = !turn?.turnId || turn.stopping; }
    for (const select of [els.model, els.effort]) if (select) select.disabled = !ready || !!turn || select.options.length === 0;
    if (els.create) els.create.disabled = !this.bridge || !!turn && turn.turnId === null;
    this.root.setAttribute('aria-busy', String(!!turn || !!this.refreshing));
  }

  private render() {
    const els = this.els; if (!els) return;
    if (els.status) els.status.textContent = this.statusText();
    if (this.messageCount === 0 && !els.messages.querySelector('.claude-chat-empty')) this.clearMessages();
    this.renderList();
    this.renderControls();
  }
}
