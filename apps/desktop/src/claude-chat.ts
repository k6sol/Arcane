/// <reference lib="dom" />
// Claude chat controller for the shared workspace chat surface. While the Claude provider is active it renders into
// the same nodes as the Codex chat (tabs strip, Saved chats, #codex-messages transcript, composer and the composer
// model picker) using the same markup classes, so both providers present one chat experience. It talks exclusively to
// the Electron preload bridge `window.arcaneDesktop.claudeChat` and writes model output with textContent only.
import {
  closeChoiceBlocks, composerMenuOpen, composerPickerCheck, crossProviderColumns, describeToolActivity, fillModelColumns, firstModelRow, installComposerCommands, loopPickerFocus, modelListEntry,
  modelListMove, parseToolDetail, patchMessageText, positionComposerPopover, prefillComposer, prependProviderLogo, renderChangeCard, renderEarlierButton, renderMessageText, renderToolActivity,
  restoreRequestText, revealEarlier, toolDetailText, toolResultImage, transcriptWindowStart, formatUsageReset, usageLimitActive, usageLimitPickerNote,boundRecordedChatTranscript,publicChatText,renderChatQueueStrip,ChatQueueJournal,chatQueueScope,
} from './codex-chat.js';
import type { BeforeMessageSubmit,RecordedChatTranscript, ChoiceBlockOptions, ComposerModelGroup, ComposerProvider, CrossProviderModels, ProviderUsageLimit, ToolChange,ChatQueueRow,ChatQueueAction } from './codex-chat.js';
import type {ChatQueueBridge,StoredChatQueueRow} from '../../../packages/protocol/src/chat-queue.js';
import type { ChatAttachmentsController, ChatAttachmentsOwner } from './chat-attachments.js';
import { ClaudePreferenceStore, claudePreferenceBridge, type ClaudePreferenceBridge, type ClaudePreferenceSnapshot } from './claude-preferences.js';
import { chatSwitchFocus, chatSwitchOpenSection, chatSwitchSummary, restoreChatSwitchFocus } from './chat-tabs.js';
import { USAGE_PRICES_AS_OF, compactTokenCount, costConversionNote, estimateUsageUsd, formatUsageCost, type TaskUsageCostDisplay } from './task-usage.js';
import { costDisplay, onCostPreferences, replyUsageText } from './task-usage-ui.js';

export type ClaudeChatRole = 'user' | 'assistant' | 'tool' | 'error';
export type ClaudeToolStatus = 'started' | 'finished' | 'failed';
/** input/result are the engine's bounded display details (JSON or a short excerpt); older engines omit them. */
/** `image`: a live tool event's capture (PNG/JPEG data: URL from the host's Arcane tools); saved history never has one. */
export interface ClaudeChatTool { name: string; status: ClaudeToolStatus; input?: string; result?: string; image?: string }
/** `steered`: a user message sent into a running reply (it joined that reply instead of starting a new one). */
export interface ClaudeMessageDelivery { model:string; effort:string; turnId:string|null; startedAt:string; finishedAt:string|null; state:'sending'|'accepted'|'completed'|'failed'|'stopped'; error:string|null;contextIncluded:boolean;transmittedBytes:number }
export interface ClaudeChatMessage { id: string; role: ClaudeChatRole; text: string; at: string; tool?: ClaudeChatTool; steered?: true; delivery?:ClaudeMessageDelivery }
/** Exact saved IDs reconcile a late history read with messages received while that read was pending. */
export function mergeClaudeChatMessages(saved:readonly ClaudeChatMessage[],live:readonly ClaudeChatMessage[]):ClaudeChatMessage[] {
  const merged=saved.map(message=>({...message})), byId=new Map(merged.flatMap((message,index)=>message.id?[[message.id,index] as const]:[]));
  for(const message of live) {
    const index=message.id?byId.get(message.id):undefined;
    if(index===undefined){if(message.id)byId.set(message.id,merged.length);merged.push(message);}
    else {
      const previous=merged[index]!;
      const settled=previous.delivery?.finishedAt&&!message.delivery?.finishedAt?previous.delivery:message.delivery??previous.delivery;
      merged[index]={...previous,...message,...(settled?{delivery:settled}:{}),...(previous.tool&&message.tool?{tool:{...previous.tool,...message.tool}}:{})};
    }
  }
  return merged;
}
export function claudeMessageDetails(message:ClaudeChatMessage,provider:string,conversationId:string|null):string {
  const delivery=message.delivery;
  const fields:[string,string|number|null|undefined][]=[['Provider',provider],['Message',message.role==='user'?'Your prompt':message.role==='assistant'?'Assistant response':message.role==='error'?'Error':'Tool result'],
    ['Status',delivery?.state??(message.role==='error'?'Failed':'Saved message')],['Model',delivery?.model??'Not reported for this message'],['Reasoning',delivery?.effort??'Not reported for this message'],
    ['Submitted',delivery?.startedAt],['Finished',delivery?.finishedAt],['Recorded',message.at||null],['Error details',delivery?.error??(message.role==='error'?message.text:null)],
    ['Text size',new TextEncoder().encode(message.text).length+' UTF-8 bytes'],['Transmitted text',delivery?delivery.transmittedBytes+' UTF-8 bytes':null],['Shared conversation context',delivery?.contextIncluded?'Included with this explicit Send':null],['Lines',message.text.split('\n').length],['Conversation',conversationId??'Not started'],['Turn',delivery?.turnId],['Message ID',message.id||null]];
  return fields.filter(([,value])=>value!==null&&value!==undefined).map(([label,value])=>label+': '+value).join('\n');
}
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
  /** images: optional PNG references (data URLs from the composer); the engine keeps only an '[image: name]' marker. */
  /** `playtest` mirrors the composer's Playtest switch (#playtest-toggle) when it is mounted; the engine turns it into a short system note. */
  send(request: { conversationId: string | null; text: string; model: string; effort: string; displayText?:string; images?: readonly ClaudeChatImage[]; playtest?: boolean }): Promise<unknown>;
  /** Removes a saved user message and everything after it (edit and rewind). Older bridges lack it; Edit is then hidden. */
  rewind?(request: { conversationId: string; messageId: string }): Promise<unknown>;
  /**
   * Steers the running reply: Claude reads the text after the tool calls already running finish, in the same reply.
   * Resolves { messageId } when delivered, false when the reply can no longer take guidance. Older bridges lack it; Enter then queues.
   */
  steer?(request: { turnId: string; text: string }): Promise<unknown>;
  stop(turnId: string): Promise<unknown>;
  remove(conversationId: string): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
}
export interface ClaudeChatImage { readonly name: string; readonly dataUrl: string }
/** The shared composer attachments (text files and PNG references) this chat borrows while it owns the composer. */
export interface ClaudeChatAttachments {
  claim(owner: ChatAttachmentsOwner | null): void;
  controller(): ChatAttachmentsController | null;
}
/**
 * What makes one chat provider's controller distinct (bridge, status reading, storage keys and copy). ClaudeChat uses
 * the Claude profile by default; the Arcane Credits chat (arcane-chat.ts) reuses the same controller with its own.
 */
export interface ChatProfile {
  provider: ComposerProvider;
  /** Provider name in copy ('Claude'), and the engine that reports its models and sign-in ('Claude Code'). */
  name: string; engine: string;
  /** The preload bridge under window.arcaneDesktop. */
  readBridge(win: unknown): ClaudeChatBridge | null;
  /** Reads the bridge's status reply (throws when it is not understood). */
  readStatus(value: unknown): ClaudeChatStatus;
  keys: { choice: string; tabs: string; usage: string };
  tabPrefix: string; emptyText: string; noBridgeText: string;
  /** The engine's fixed usage-limit message (a done event carrying it is a usage limit). */
  usageLimitText: string;
  /** Fixed, already-safe bridge refusals shown as they are. */
  knownErrors: ReadonlySet<string>;
  defaultEffort: string;
  /** The model takes PNG references. */
  images: boolean;
}
export interface ClaudeChatOptions {
  /** Scoped native presentation persistence; test injection never grants chat authority. */
  preferences?:ClaudePreferenceBridge|null;
  /** Test seam. When omitted the bridge is read from the document's window. */
  bridge?: unknown;
  /** Provider profile; the Claude profile when omitted. */
  profile?: ChatProfile;
  /** Test seam. When omitted the document's shared composer attachments are used. */
  attachments?: ClaudeChatAttachments;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/**
 * Feedback seam for the local learning loop (learned-preferences.ts registers it from the workspace). Presentation and
 * learning signals only: it can append rating controls and a note to the transcript, never send, edit or authorize.
 */
export interface ChatFeedbackSink {
  userMessage(event: { key: string; text: string; box: HTMLElement | null; anchor: HTMLElement | null }): void;
  turnFinished(event: { key: string; ok: boolean; tools: readonly { name: string; status?: string; input?: string; result?: string; article?: HTMLElement | null }[]; box: HTMLElement | null }): void;
}
let feedbackSink: ChatFeedbackSink | null = null;
export function setChatFeedbackHooks(sink: ChatFeedbackSink | null): void {
  feedbackSink = sink && typeof sink.userMessage === 'function' && typeof sink.turnFinished === 'function' ? sink : null;
}
export const CLAUDE_CHAT_CHOICE_KEY = 'arcane.claude-chat.choice.v1';
/** Presentation only: which saved Claude conversations are open as tabs. Never message text or authority. */
export const CLAUDE_CHAT_TABS_KEY = 'arcane.claude-chat.tabs.v1';
export const CLAUDE_CHAT_EMPTY_TEXT = 'New Claude chat. Your first message starts the conversation.';
export const CLAUDE_CHAT_NO_BRIDGE_TEXT = 'Claude chat requires the Arcane desktop app.';
export const CLAUDE_CHAT_TAB_LIMIT = 16;
/** The engine's fixed refusal for image references (claude-chat.cjs MESSAGES.images). */
export const CLAUDE_CHAT_IMAGES_TEXT = 'Attached images must be at most 4 PNG references within 512 KiB in total.';
/** Shown when a message with attachments is typed while a reply runs (only plain text can wait in the queue). */
export const CLAUDE_CHAT_QUEUE_ATTACHMENTS_TEXT = 'Attachments are sent with the next message after this reply finishes. Wait for it, then send.';
/** The engine's one fixed usage-limit message (claude-chat.cjs MESSAGES.usageLimit). */
export const CLAUDE_CHAT_USAGE_LIMIT_TEXT = 'Claude usage limit reached. This message was not answered; try again after the limit resets.';
const MAX_TEXT = 1024 * 1024, MAX_INPUT = 100000, MAX_BUFFERED = 2000, DEFAULT_EFFORT = 'high';
/** A streamed reply is drawn at most once per animation frame and at most this often (about 30 times a second). */
const STREAM_FRAME_MS = 32;
const SEND_PATH = 'M12 19V5m-6 6 6-6 6 6', STOP_PATH = 'M7 7h10v10H7Z';
// Fixed, already-safe messages the preload bridge may reject with; anything else is replaced by a generic message.
const KNOWN_BRIDGE_ERRORS = new Set(['Claude chat is unavailable.', 'Another Claude chat reply is still running in this conversation.',
  'Too many Claude chat replies are running. Wait for one to finish.', 'This conversation no longer exists.', 'Message is empty or too long.',
  'This message can no longer be edited.', CLAUDE_CHAT_IMAGES_TEXT]);
/** Shown after an edit with "Also undo Studio changes": the restore request waits in the composer, the edit in the queue. */
export const CLAUDE_CHAT_EDIT_UNDO_TEXT = 'Review the restore request in the message box, then send it. Your edited message waits in the queue and is sent after that reply finishes.';
export const CLAUDE_CHAT_EDIT_UNDO_LABEL = 'Also undo Studio changes made after this message';
const bridgeError = (error: unknown, fallback: string, known: ReadonlySet<string> = KNOWN_BRIDGE_ERRORS) => { try { const message = (error as Error)?.message; return typeof message === 'string' && known.has(message) ? message : fallback; } catch { return fallback; } };
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
  if (message.steered === true && output.role === 'user') output.steered = true;
  const delivery=record(message.delivery);
  if(delivery&&typeof delivery.model==='string'&&delivery.model.length<=128&&typeof delivery.effort==='string'&&delivery.effort.length<=64&&
    typeof delivery.turnId==='string'&&delivery.turnId.length<=256&&typeof delivery.startedAt==='string'&&Number.isFinite(Date.parse(delivery.startedAt))&&
    (delivery.finishedAt===null||typeof delivery.finishedAt==='string'&&Number.isFinite(Date.parse(delivery.finishedAt)))&&
    ['sending','accepted','completed','failed','stopped'].includes(String(delivery.state))&&(delivery.error===null||typeof delivery.error==='string'&&delivery.error.length<=2048)&&
    typeof delivery.contextIncluded==='boolean'&&typeof delivery.transmittedBytes==='number'&&Number.isSafeInteger(delivery.transmittedBytes)&&delivery.transmittedBytes>=0&&delivery.transmittedBytes<=2000000)
    output.delivery={model:delivery.model,effort:delivery.effort,turnId:delivery.turnId,startedAt:delivery.startedAt,finishedAt:delivery.finishedAt as string|null,
      state:delivery.state as ClaudeMessageDelivery['state'],error:delivery.error as string|null,contextIncluded:delivery.contextIncluded,transmittedBytes:delivery.transmittedBytes};
  const tool = record(message.tool);
  if (tool && typeof tool.status === 'string' && TOOL_STATES.includes(tool.status as ClaudeToolStatus)) {
    output.tool = { name: text(tool.name, 256) || 'Tool', status: tool.status as ClaudeToolStatus };
    for (const key of ['input', 'result'] as const) if (typeof tool[key] === 'string' && (tool[key] as string).length <= 4096) output.tool[key] = tool[key] as string;
    // Display only: kept when it decodes as a bounded PNG/JPEG data URL (toolResultImage); anything else is dropped.
    if (output.tool.status === 'finished' && typeof tool.image === 'string' && toolResultImage({ image: tool.image })) output.tool.image = tool.image;
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
function readUsageLimit(value: unknown, error: string | null, fixed = CLAUDE_CHAT_USAGE_LIMIT_TEXT): ProviderUsageLimit | null {
  const limit = record(value), reset = limit?.resetsAt;
  if (limit) {
    const resetsAt = typeof reset === 'number' && Number.isSafeInteger(reset) && reset >= 1e9 && reset < 1e11 ? reset : null, window = limit.window;
    return window === 'session' || window === 'weekly' ? { resetsAt, window } : { resetsAt };
  }
  return error === fixed ? { resetsAt: null } : null;
}
/** One finished reply's tokens and cost: Claude Code's reported cost, else the maintained price table for the model, else none. */
export interface ClaudeReplyCost { tokens: number; inputTokens: number; outputTokens: number; usd: number | null; source: 'reported' | 'table' | null }
export function claudeReplyCost(value: unknown, model: string | null = null): ClaudeReplyCost | null {
  const usage = record(value); if (!usage) return null;
  const input = finite(usage.inputTokens), output = finite(usage.outputTokens), cost = finite(usage.costUsd);
  if (input === null && output === null) return null;
  const inputTokens = Math.max(0, input ?? 0), outputTokens = Math.max(0, output ?? 0);
  const reported = cost !== null && cost >= 0 ? cost : null, table = reported === null && model ? estimateUsageUsd(model, { inputTokens, outputTokens }) : null;
  return { tokens: inputTokens + outputTokens, inputTokens, outputTokens, usd: reported ?? table, source: reported !== null ? 'reported' : table !== null ? 'table' : null };
}
const DEFAULT_DISPLAY: TaskUsageCostDisplay = { preferences: { show: true, currency: 'USD', rate: null }, locale: 'en-US' };
export function formatClaudeUsage(value: unknown, model: string | null = null, display: TaskUsageCostDisplay = DEFAULT_DISPLAY): string | null {
  const reply = claudeReplyCost(value, model);
  return reply ? 'Done · ' + replyUsageText(reply.tokens, reply.usd, display) : null;
}
const conversion = (display: TaskUsageCostDisplay) => costConversionNote(display.preferences);
/** The tooltip for one reply's usage line: exact counts and where the cost came from. */
export function claudeReplyUsageTitle(reply: ClaudeReplyCost, display: TaskUsageCostDisplay = DEFAULT_DISPLAY): string {
  const format = (n: number) => Math.round(n).toLocaleString('en-US');
  const counts = format(reply.tokens) + ' tokens (' + format(reply.inputTokens) + ' input including cache, ' + format(reply.outputTokens) + ' output).';
  if (reply.usd === null || !display.preferences.show) return counts + (reply.usd === null ? ' No cost estimate is available for this model.' : '');
  return counts + ' ' + formatUsageCost(reply.usd, display.preferences, display.locale) + (reply.source === 'reported'
    ? ' is Claude Code\'s own cost estimate at API prices. Your subscription is not charged per token.'
    : ' is estimated from Arcane\'s price table (' + USAGE_PRICES_AS_OF + ') with all input at the base rate, so it may be high.') + conversion(display);
}
/** Tokens and estimated cost of finished replies in one conversation, recorded on this device (presentation only). */
export interface ClaudeConversationUsage {
  inputTokens: number; outputTokens: number; costUsd: number | null; replies: number;
  /** Replies whose cost came from the price table rather than Claude Code, and replies with no cost at all. */
  tableCostReplies: number; uncostedReplies: number;
}
/** Compact token count: 950, 12.3k, 1.2M. */
export const compactTokens = compactTokenCount;
/** The meter's accessible description and tooltip. */
export function usageMeterText(usage: ClaudeConversationUsage, display: TaskUsageCostDisplay = DEFAULT_DISPLAY): string {
  const total = usage.inputTokens + usage.outputTokens, format = (n: number) => Math.round(n).toLocaleString('en-US');
  const cost = usage.costUsd !== null && display.preferences.show ? formatUsageCost(usage.costUsd, display.preferences, display.locale) : null;
  return 'Tokens used in this conversation: ' + format(total) + ' (' + format(usage.inputTokens) + ' input, ' + format(usage.outputTokens) + ' output' +
    (cost ? ', ' + cost + ' estimated' : '') + ') across ' + usage.replies + (usage.replies === 1 ? ' reply' : ' replies') + ' recorded on this device.' +
    (cost ? ' Costs are estimates at API prices' + (usage.tableCostReplies ? ', partly from Arcane\'s price table' : '') +
      (usage.uncostedReplies ? '; ' + usage.uncostedReplies + (usage.uncostedReplies === 1 ? ' reply has' : ' replies have') + ' no estimate' : '') +
      '; your subscription is not charged per token.' + conversion(display) : '') +
    ' The red arc is the output share.';
}
/** Per-conversation usage totals kept on this device (bounded). */
export const CLAUDE_CHAT_USAGE_KEY = 'arcane.claude-chat.usage.v1';
const USAGE_ROWS = 200;
/** Steering is an explicit queue-row action; Enter keeps the next prompt pending. */
export const CLAUDE_CHAT_STEER_HINT = 'Enter to queue · Use Steer on a queued message';
/** Shown when a steering message arrived as the reply ended: it waits in the queue instead. */
export const CLAUDE_CHAT_STEER_QUEUED_TEXT = 'The reply was already finishing, so your message is queued and sent next.';
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

/** The Claude chat's profile (the default for ClaudeChat). */
export const CLAUDE_CHAT_PROFILE: ChatProfile = Object.freeze({
  provider: 'claude', name: 'Claude', engine: 'Claude Code', readBridge: readClaudeChatBridge, readStatus: readClaudeChatStatus,
  keys: Object.freeze({ choice: CLAUDE_CHAT_CHOICE_KEY, tabs: CLAUDE_CHAT_TABS_KEY, usage: CLAUDE_CHAT_USAGE_KEY }),
  tabPrefix: 'claude-tab-', emptyText: CLAUDE_CHAT_EMPTY_TEXT, noBridgeText: CLAUDE_CHAT_NO_BRIDGE_TEXT, usageLimitText: CLAUDE_CHAT_USAGE_LIMIT_TEXT,
  knownErrors: KNOWN_BRIDGE_ERRORS, defaultEffort: DEFAULT_EFFORT, images: true,
}) as ChatProfile;

interface Turn {
  turnId: string | null; conversationId: string | null; tabKey: string; stopping: boolean;
  bubble: HTMLElement | null; text: string; echo: string | null; prompt: string;
  /** The exact text sent, offered by "Retry message" when the reply does not finish; null when images were attached. */
  retry: string | null;
  delivery:ClaudeMessageDelivery;
}
/** The transcript's lightweight marker for sent PNG references (claude-chat.cjs imageMarkers). */
export const claudeImageMarkers = (images: readonly { name: string }[]): string => images.map(image => '[image: ' + image.name + ']').join(' ');
const editable = (message: ClaudeChatMessage) => message.role === 'user' && !!message.id && !message.steered;
interface Tab { key: string; conversationId: string | null; model: string; effort: string; draft: string; title?:string }
type El = HTMLElement;
/** Claude-only composer nodes created on first activation (studio.html stays provider-neutral). */
const QUEUE_ID = 'claude-chat-queue', METER_ID = 'claude-usage-meter';
const SVG_NS = 'http://www.w3.org/2000/svg', RING = 2 * Math.PI * 7;

export class ClaudeChat {
  protected readonly profile: ChatProfile;
  private readonly bridge: ClaudeChatBridge | null;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly preferenceStore:ClaudePreferenceStore|null;
  private nativeHydrating=false;
  private nativeReading:Promise<void>|null=null;
  private nativeDisposed=false;
  private preferenceEdits=0;
  private lastChoice:{model:string;effort:string}|null=null;
  private nativeDeferred:Tab[]=[];
  private nativeQueuedView:{projectPath:string;active:string|null;rows:(Pick<Tab,'key'|'conversationId'|'model'|'effort'|'draft'>&{title:string})[]}|null=null;
  private readonly attachments: ClaudeChatAttachments;
  /** This chat currently holds the shared composer attachments. */
  private claimed = false;
  protected state: ClaudeChatStatus | null = null;
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
  /** The last few live captures by tool message id, so a re-rendered transcript keeps its thumbnails (memory only). */
  private toolImages = new Map<string, string>();
  /** Studio changes reported by the visible turn's tools; shown as one card when the turn ends. */
  private turnChanges: ToolChange[] = [];
  /** Messages typed while a reply runs; sent one by one after each reply finishes successfully. */
  private queue: (ChatQueueRow&{tabKey:string})[] = [];
  private queueJournal=new ChatQueueJournal();
  /** An empty local replacement remains dirty until its exact checkpoint is acknowledged. */
  private queueEmptyCheckpoint:{projectPath:string|null}|null=null;
  private queueEmptyRenderPending=false;
  private queueSaveGeneration=0;
  private queueRecoveryContext:{projectPath:string|null}|null=null;
  private queueAfterDraftSendScope:string|null=null;
  private queueSeq = 0;
  private queueEnqueue:ChatQueueRow|null=null;
  private queueAfterTurn:Turn|null=null;
  private queueSending=false;
  private queueSteering=false;
  private queueChoice:string|null=null;
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
  /** Messages shown for the active tab, in order (tool entries updated in place); used to find an edit's discarded changes. */
  private shown: ClaudeChatMessage[] = [];
  /** Last displayed transcript for each open tab; a failed history refresh keeps it visible. */
  private readonly cachedMessages=new Map<string,ClaudeChatMessage[]>();
  private shownKey:string|null=null;
  private readonly messageElements=new WeakMap<HTMLElement,ClaudeChatMessage>();
  private beforeMessageSubmit:BeforeMessageSubmit|null=null;
  private preparingSend=false;
  private readonly transcriptListeners=new Set<()=>void>();
  private transcriptSignature='';
  private conversationRevision=0;
  /** Cancels the streamed reply's pending paint; null when nothing is waiting to be drawn. */
  private streamFrame: (() => void) | null = null;
  private streamPainted = 0;
  /** An edit's rewind call is in flight; sending waits for it. */
  private rewinding = false;

  constructor(readonly doc: Document, options: ClaudeChatOptions = {}) {
    const profile = this.profile = options.profile ?? CLAUDE_CHAT_PROFILE;
    this.bridge = Object.hasOwn(options, 'bridge') ? profile.readBridge({ arcaneDesktop: { [profile.provider === 'claude' ? 'claudeChat' : profile.provider + 'Chat']: options.bridge } }) : profile.readBridge(doc?.defaultView);
    let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
    if (Object.hasOwn(options, 'storage')) storage = options.storage ?? null;
    else { try { storage = doc?.defaultView?.localStorage ?? null; } catch { storage = null; } }
    this.storage = storage;
    const preferences=profile.provider==='claude'?(Object.hasOwn(options,'preferences')?options.preferences??null:claudePreferenceBridge(doc?.defaultView)):null;
    this.preferenceStore=preferences?new ClaudePreferenceStore(preferences,()=>{
      if(this.nativeDisposed)return;
      const failure='Claude chat preferences could not be saved. Keep this window open and try again.';
      if(this.preferenceStore?.error())this.notice=failure;else if(this.notice===failure)this.notice='';
      this.render();
    }):null;
    if (options.attachments) this.attachments = options.attachments;
    else {
      // The attachments module loads on first activation (as the workspace loads it); until then nothing attaches.
      let shared: typeof import('./chat-attachments.js') | null = null, loading = false;
      this.attachments = {
        claim: owner => {
          if (shared) { shared.claimChatAttachments(doc, owner); return; }
          if (!owner || loading) return;
          loading = true;
          void import('./chat-attachments.js').then(module => {
            shared = module;
            if (this.active && this.claimed) { this.claimed = false; this.claimAttachments(); this.render(); }
          }).catch(() => { /* Attachments stay unavailable; text chat is unaffected. */ });
        },
        controller: () => shared?.sharedChatAttachments(doc) ?? null,
      };
    }
    this.restoreTabs();
    if(this.preferenceStore)void this.loadNativePreferences();
  }

  /** True when the preload bridge is present; otherwise the surface explains it needs the desktop app. */
  available(): boolean { return !!this.bridge; }
  /** True while this controller owns the shared chat surface. */
  isActive(): boolean { return this.active; }
  activeConversation(): string | null { return this.activeTab()?.conversationId ?? null; }
  setBeforeMessageSubmit(callback:BeforeMessageSubmit|null):void{this.beforeMessageSubmit=callback;}
  setQueuePersistence(port:ChatQueueBridge|null):Promise<void>{
    if(this.profile.provider!=='claude')return Promise.resolve();
    const preserveLocal=this.queue.length>0||this.queueEmptyCheckpoint!==null;
    const recovering={projectPath:this.queueProject()};this.queueRecoveryContext=recovering;this.queueSaveGeneration++;
    return this.queueJournal.attach(port,'claude',(rows,project)=>{
      if(preserveLocal||this.queue.length||this.queueEmptyCheckpoint)return;
      this.queue=rows.map<ChatQueueRow&{tabKey:string}>(target=>({id:target.id,text:target.text,tabKey:target.localId,scope:chatQueueScope('claude',project,target.conversationId,target.sessionId,target.localId),
        state:target.state==='unknown'?'unknown':target.state==='rejected'?'rejected':'paused',notice:target.attachmentState==='missing'?'Attachments must be restored before this message can be sent.':'Restored after restart. Review this chat and choose Send next.',...(target.requestId?{requestId:target.requestId}:{}),target}));
      this.queueSeq=Math.max(this.queueSeq,...rows.map(row=>row.id));this.queueAfterTurn=null;this.queueChoice=null;
    },()=>{if(!this.nativeDisposed)this.render();}).finally(()=>{if(this.queueRecoveryContext===recovering)this.queueRecoveryContext=null;});
  }
  private queueProject():string|null{return this.preferenceStore?.projectPath??this.queueJournal.projectPath??this.queueRecoveryContext?.projectPath??null;}
  private async queueSave(explicit=false):Promise<boolean>{
    const project=this.queueProject(),pending=this.queueEmptyCheckpoint,generation=++this.queueSaveGeneration;
    if(!this.queue.length&&pending)this.queueEmptyRenderPending=false;
    if(pending&&pending.projectPath!==project)return false;
    const saved=await this.queueJournal.save(this.queue,project,explicit);
    if(saved&&generation===this.queueSaveGeneration&&project===this.queueProject()&&this.queueEmptyCheckpoint===pending){this.queueEmptyCheckpoint=null;this.queueEmptyRenderPending=false;}
    return saved;
  }
  private replaceQueue(rows:(ChatQueueRow&{tabKey:string})[]):void {
    const removedLast=this.queue.length>0&&!rows.length;this.queue=rows;
    if(this.profile.provider==='claude'&&removedLast){
      const project=this.queueProject();
      if(!this.queueEmptyCheckpoint||this.queueEmptyCheckpoint.projectPath===project)this.queueEmptyCheckpoint={projectPath:project};
      this.queueEmptyRenderPending=true;
    }
  }

  isDraftConversation():boolean {
    const tab=this.activeTab();return !this.nativeDisposed&&!this.nativeHydrating&&!this.loading&&!!tab&&tab.conversationId===null&&this.turn?.tabKey!==tab.key;
  }
  subscribeTranscriptChange(listener:()=>void):()=>void{this.transcriptListeners.add(listener);return()=>{this.transcriptListeners.delete(listener);};}
  recordedTranscript():RecordedChatTranscript {
    const tab=this.activeTab(),messages=this.active?this.shown:this.cachedMessages.get(tab?.key??'')??[];
    return boundRecordedChatTranscript({provider:this.profile.provider,projectPath:this.preferenceStore?.projectPath??null,conversationId:tab?.conversationId??null,sessionId:null,earlierCount:0,
      messages:messages.filter(message=>message.role!=='tool'&&!message.tool).map((message,index)=>({id:message.id||'local:'+tab?.key+':'+index+':'+(message.delivery?.startedAt??message.at),role:message.role as 'user'|'assistant'|'error',text:publicChatText(message.text),
        source:message.delivery?'live' as const:'history' as const,at:message.at||message.delivery?.startedAt||null,model:message.delivery?.model??null}))});
  }
  private publishTranscript():void {
    const signature=JSON.stringify(this.recordedTranscript());if(signature===this.transcriptSignature)return;this.transcriptSignature=signature;
    for(const listener of this.transcriptListeners){try{listener();}catch{/* Presentation subscribers never affect a chat turn. */}}
  }
  showConversationNotice(message:string):void{this.notice=message;this.render();}
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
    const offCost = onCostPreferences(this.doc, () => { if (this.active) { this.refreshReplyUsage(); this.renderMeter(); } });
    this.removers.push(offCost);
    listen(this.el('codex-compose'), 'submit', event => { event.preventDefault(); this.submit(); });
    listen(this.el('codex-submit'), 'click', event => { if (this.turnOwnsActiveTab()) { event.preventDefault(); void this.stopTurn(); } });
    listen(input, 'keydown', event => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Enter' || key.shiftKey || key.isComposing || key.ctrlKey || key.metaKey) return;
      // While the "/" or "@" menu is open, Enter picks from it instead of sending.
      if (event.defaultPrevented || composerMenuOpen(this.doc)) return;
      // Alt+Enter queues the message for after the running reply; with no reply running it does nothing.
      if (key.altKey) { if (this.turn) { event.preventDefault(); if (!this.rewinding) this.enqueue(); } return; }
      event.preventDefault(); this.submit();
    });
    listen(input, 'input', () => { const tab = this.activeTab(); if (tab && input) {tab.draft = input.value;this.preferenceEdits++;if(this.preferenceStore)this.persistTabs();} this.renderControls(); });
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
    listen(this.el('codex-picker-reset'), 'click', () => { if (this.pickerOpen() && this.efforts().includes(this.profile.defaultEffort)) this.chooseEffort(this.profile.defaultEffort); });
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
      } catch { this.statusError = this.profile.name + ' events are unavailable. Restart Arcane to chat with ' + this.profile.name + '.'; }
    }
    this.render();
  }

  stop(): void {
    this.nativeDisposed=true;this.preferenceStore?.dispose();
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
    // Text files and PNG references attach through the shared composer controller, scoped to the active Claude tab.
    this.claimAttachments();
    for (const id of ['welcome-connect', 'codex-conversation-start', 'codex-draft-review']) { const node = this.el(id); if (node) node.hidden = true; }
    this.showTab(this.activeKey!);
  }

  /** Returns the shared surface to Codex, keeping Claude tabs, drafts and any running turn. */
  deactivate(): void {
    if (!this.active) return;
    this.pauseQueue('Paused while another provider is shown. Choose Send next to resume.');
    const tab = this.activeTab(), input = this.input();
    if (tab && input) tab.draft = input.value;
    this.queueNativePreferences();
    this.closePicker();
    if (this.claimed) { this.claimed = false; try { this.attachments.claim(null); } catch { /* Presentation only. */ } }
    const attach = this.el('workspace-add-context'); if (attach && this.restoreAttach !== null) attach.hidden = this.restoreAttach;
    this.restoreAttach = null;
    this.el('codex-messages')?.removeAttribute('aria-busy');
    this.steerHint(false);
    for (const id of [QUEUE_ID, METER_ID]) { const node = this.el(id); if (node) node.hidden = true; }
    this.rememberMessages();
    this.active = false; this.tools.clear(); this.messageCount = 0; this.turnChanges = []; this.shown = [];this.shownKey=null;
    this.cancelStream();
    if (this.turn) { this.turn.bubble = null; }
  }

  /**
   * Borrows the shared composer attachments while this chat owns the composer. Without a controller (it loads after the
   * chat history) the attach button stays hidden until the next render finds one.
   */
  private claimAttachments(): void {
    const attach = this.el('workspace-add-context'), controller = this.attachments.controller();
    if (!controller) {
      if (attach && this.restoreAttach === null) { this.restoreAttach = attach.hidden === true; attach.hidden = true; }
    } else if (attach && this.restoreAttach !== null) { attach.hidden = this.restoreAttach; this.restoreAttach = null; }
    if (this.claimed) { controller?.syncScope(); return; }
    this.claimed = true;
    try {
      this.attachments.claim({
        getScope: () => this.attachmentScope(),
        // Claude Code models take image input; the engine checks every reference again.
        imageInputAvailable: () => this.profile.images,
        onChange: () => { if (this.active) this.renderControls(); },
      });
    } catch { this.claimed = false; }
  }
  /** Attachments belong to the active Claude tab while Claude can send; any change clears them. */
  private attachmentScope(): string | null {
    const tab = this.activeTab();
    return this.active && this.ready() && tab ? JSON.stringify([this.profile.provider, tab.key]) : null;
  }
  /** Composer attachments for the next message, or null when there are none. Throws the controller's readable message. */
  private takeAttachments(message: string): { text: string; images: ClaudeChatImage[] } | null {
    const controller = this.attachments.controller();
    if (!controller) return null;
    const prepared = controller.prepareText(message), images = controller.prepareReferences().map(image => ({ name: image.name, dataUrl: image.dataUrl }));
    return prepared === message && !images.length ? null : { text: prepared, images };
  }

  /** Reads status and the conversation list. Concurrent calls share one read. */
  refresh(): Promise<void> {
    if (!this.started) this.start();
    if (!this.bridge) { this.render(); return Promise.resolve(); }
    if (this.refreshing) return this.refreshing;
    const bridge = this.bridge;
    this.refreshing = (async () => {
      try { this.state = this.profile.readStatus(await bridge.status()); this.statusError = null; }
      catch { this.state = null; this.statusError = this.profile.engine + ' status is unavailable. Reopen the chat to try again.'; }
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
    const note = this.columnNote();
    return { provider: this.profile.provider, label: this.profile.name, available: ready, hint: !this.state ? (this.refreshing ? 'Checking ' + this.profile.engine + '…' : 'Sign in to use') : ready ? 'Choose a model' : 'Sign in to use',
      models: ready ? this.models().map(id => { const name = this.modelLabel(id), detail = this.modelDetail(id); return { id, label: name.short, title: name.id === id ? id : id + ' → ' + name.id, ...(detail ? { detail } : {}) }; }) : [],
      ...(note ? { note } : {}) };
  }
  /** A short second line for a model row (e.g. its price); none for Claude. */
  protected modelDetail(_model: string): string | null { return null; }
  /** A short line under this provider's model column heading (e.g. a balance); none for Claude. */
  protected groupNote(): string | null { return null; }
  /** The column line: 'Usage limit reached' (with the reset) while a subscription provider is exhausted, else groupNote. */
  private columnNote(): string | null {
    return (this.profile.provider === 'arcane' ? null : usageLimitPickerNote(this.limit)) ?? this.groupNote();
  }
  /** The done notice for a finished reply's usage. */
  protected replyNotice(usage: unknown, model: string | null, display: TaskUsageCostDisplay): string | null { return formatClaudeUsage(usage, model, display); }
  /** A reply finished (any outcome); the Arcane chat refreshes its balance here. */
  protected replyFinished(): void { /* Claude has nothing to refresh. */ }
  /** Status line text while signed in. */
  protected readyLabel(): string { return this.state?.cliVersion ? this.profile.engine + ' ' + this.state.cliVersion : 'Signed in'; }
  /** Reads Claude Code status once so another provider's model list can show Claude models. */
  loadModels(): Promise<void> { return this.state || !this.bridge ? Promise.resolve() : this.refresh(); }
  /** Status (models, efforts, sign-in) was read. */
  subscribeModels(listener: () => void): () => void { this.modelListeners.add(listener); return () => { this.modelListeners.delete(listener); }; }
  /** The last Claude reply ended at the account's usage limit (cleared by the next completed reply). Presentation only. */
  usageLimit(): ProviderUsageLimit | null { return this.limit ? { ...this.limit } : null; }
  /** Usage-limit evidence changed. */
  subscribeUsageLimit(listener: () => void): () => void { this.usageListeners.add(listener); return () => { this.usageListeners.delete(listener); }; }
  /** Forgets usage-limit evidence whose reported reset has passed (the notice's Retry). Presentation only. */
  clearUsageLimit(): void { this.setUsageLimit(null); }
  private setUsageLimit(next: ProviderUsageLimit | null): void {
    if (JSON.stringify(next) === JSON.stringify(this.limit)) return;
    this.limit = next;
    for (const listener of [...this.usageListeners]) { try { listener(); } catch { /* Observers cannot break the chat. */ } }
    // The model list marks this provider's column while it is exhausted.
    for (const listener of [...this.modelListeners]) { try { listener(); } catch { /* Observers cannot break the chat. */ } }
  }
  /** Effort of the active Claude tab, carried to the other provider when the user switches from the model list. */
  currentEffort(): string | null { return this.activeTab()?.effort || null; }
  /** Moves the unsent composer text out of Claude for a provider switch; the Claude tab keeps an empty draft. */
  takeComposerDraft(): string {
    const input = this.input(), tab = this.activeTab();
    if (!this.active || !input || !input.value) return '';
    const value = input.value; input.value = ''; if (tab) tab.draft = '';this.preferenceEdits++;this.queueNativePreferences();
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
    if (handoff.draft && tab) { tab.draft = handoff.draft; if (input) input.value = handoff.draft;this.preferenceEdits++;this.queueNativePreferences(); }
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
    if(this.nativeHydrating){void this.nativeReading?.then(()=>{if(!this.nativeDisposed)this.newChat();});return;}
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
    if(this.nativeReading)await this.nativeReading;if(this.nativeDisposed)return;
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
  /** A provider handoff opens only after its exact saved history can be read; failed preparation leaves the source alone. */
  async openRecordedConversation(conversationId:string):Promise<boolean> {
    await this.readyForRuntimeRecovery();
    const bridge=this.bridge;if(!bridge||this.turn&&this.turn.turnId===null)return false;
    const fingerprint=JSON.stringify([this.viewEpoch,this.activeKey,this.preferenceStore?.projectPath,this.activeTab()?.model,this.activeTab()?.effort,this.active?this.input()?.value:this.activeTab()?.draft]),turn=this.turn;
    let prepared:Record<string,unknown>|null;
    try{
      prepared=record(await bridge.history(conversationId));
      if(!prepared||prepared.conversationId!==conversationId||!Array.isArray(prepared.messages)||prepared.messages.length>2000||prepared.messages.some(row=>!readClaudeChatMessage(row)))return false;
    }catch{return false;}
    if(this.nativeDisposed||this.turn!==turn||fingerprint!==JSON.stringify([this.viewEpoch,this.activeKey,this.preferenceStore?.projectPath,this.activeTab()?.model,this.activeTab()?.effort,this.active?this.input()?.value:this.activeTab()?.draft]))return false;
    let tab=this.tabs.find(row=>row.conversationId===conversationId);
    const reusable=this.activeTab()?.conversationId===null&&!this.activeTab()!.draft.trim()?this.activeTab():null;
    if(!tab&&!reusable&&this.tabs.length>=CLAUDE_CHAT_TAB_LIMIT)return false;
    this.saveDraft();tab??=reusable??this.createTab(conversationId);tab.conversationId=conversationId;
    const row=this.conversations.find(item=>item.conversationId===conversationId);if(row)this.applyChoice(tab,row.model,row.effort);
    const messages=(prepared.messages as unknown[]).map(readClaudeChatMessage).filter((message):message is ClaudeChatMessage=>!!message);
    this.cachedMessages.set(tab.key,mergeClaudeChatMessages(messages,this.cachedMessages.get(tab.key)??[]));
    await this.showTab(tab.key,prepared);
    return this.activeTab()?.conversationId===conversationId;
  }

  selectTab(key: string): void {
    if (key === this.activeKey || this.turn && this.turn.turnId === null || !this.tabs.some(tab => tab.key === key)) return;
    this.saveDraft(); void this.showTab(key);
  }

  closeTab(key: string): void {
    const index = this.tabs.findIndex(tab => tab.key === key);
    if (index < 0 || this.turn && this.turn.turnId === null && this.turn.tabKey === key) return;
    if(this.queue.some(item=>item.tabKey===key)){this.notice='This chat has queued messages. Remove them before closing its tab.';this.render();return;}
    this.saveDraft();
    this.tabs.splice(index, 1);this.restoreDeferredPreferences();
    if (!this.tabs.length) this.createTab(null);
    if (this.activeKey === key) void this.showTab(this.tabs[Math.max(0, index - 1)]!.key);
    else { this.persistTabs(); this.render(); }
  }

  /** Enter queues during a reply. Steering always requires the explicit row action. */
  submit(): void {
    if (this.rewinding) return;
    if (this.turn) this.enqueue(); else void this.send();
  }
  /** The visible running reply takes steering messages: the bridge supports it and the reply has started and is not stopping. */
  canSteer(): boolean {
    const turn = this.turn;
    return this.active && !this.queueEnqueue&&!this.queueSteering&&!!turn && typeof this.bridge?.steer === 'function' && turn.turnId !== null && !turn.stopping && this.turnOwnsActiveTab() && this.ready();
  }
  /** While a steerable reply runs, the empty composer says what Enter and Alt+Enter do; the shared placeholder returns after. */
  private steerHint(on: boolean): void {
    const input = this.input(); if (!input?.dataset) return;
    if (on && input.dataset.steerHint !== 'true') { input.dataset.placeholder = input.placeholder ?? ''; input.placeholder = CLAUDE_CHAT_STEER_HINT; input.dataset.steerHint = 'true'; }
    else if (!on && input.dataset.steerHint === 'true') { input.placeholder = input.dataset.placeholder ?? ''; delete input.dataset.steerHint; delete input.dataset.placeholder; }
  }
  /**
   * Sends the composer text into the running reply. It shows at once as a steered message in the transcript (the build
   * progress group keeps going); Claude reads it after the step it is running. A reply that was already ending gets it
   * queued instead, so nothing is lost and nothing runs twice. Attachments wait for the next message.
   */
  async steer(queued?:ChatQueueRow): Promise<boolean> {
    const bridge = this.bridge, input = this.input(), tab = this.activeTab(), turn = this.turn;
    if (!this.active || !bridge?.steer || !input || !tab || !turn?.turnId || !this.canSteer()) return false;
    const item=queued?this.queueItem(queued):null;if(queued&&!item)return false;
    const message = (item?.text??input.value).trim();
    if (!message) return false;
    if (message.length > MAX_INPUT) { this.notice = 'This message is too long for ' + this.profile.name + '. Shorten it to 100,000 characters.'; this.render(); return false; }
    let pending: unknown = null; if(!item)try { pending = this.takeAttachments(message); } catch { pending = true; }
    if (pending) { this.notice = CLAUDE_CHAT_QUEUE_ATTACHMENTS_TEXT; this.render(); return false; }
    if(item){
      if(item.target?.attachmentState==='missing'){this.notice='Restore this message’s attachments before sending it.';this.render();return false;}
      const gesture=this.queueGesture();item.state='sending';item.notice='Saving steering message…';this.queueSteering=true;this.render();
      const saved=await this.queueSave(true);this.queueSteering=false;
      if(!saved||gesture!==this.queueGesture()||this.turn!==turn||!this.canSteer()){
        item.state='paused';item.notice=saved?'Not sent: the conversation changed while saving.':'Not sent: secure saving failed. Your text is retained.';this.render();return false;
      }
      item.dispatched=true;item.notice='Steering this reply…';
    }else{input.value = ''; tab.draft = '';}
    this.notice = '';
    const echo: ClaudeChatMessage = { id: '', role: 'user', text: message, at: new Date().toISOString(), steered: true };
    const article = this.appendMessage(echo, true), epoch = this.viewEpoch;
    article.dataset.steerState = 'sending';
    this.queueSteering=true;this.render();
    let reply: unknown = null, failed = false;
    try { reply = await bridge.steer({ turnId: turn.turnId, text: message }); } catch { failed = true; }
    this.queueSteering=false;
    const id = text(record(reply)?.messageId, 256), shown = this.active && epoch === this.viewEpoch;
    if (id) {
      echo.id = id;
      if (shown) article.dataset.steerState = 'sent';
      if(item)this.replaceQueue(this.queue.filter(row=>row!==item));
      this.render();if(turn.delivery.state==='completed')this.drainQueue(turn);return true;
    }
    // A refused or unknown steering result never starts another turn or retries this text.
    if (shown) { article.remove(); this.shown = this.shown.filter(item => item !== echo); }
    if(item){
      item.state=!failed&&reply===false?'rejected':'unknown';item.notice=item.state==='rejected'?'Steering was not accepted. This message is still queued.':'Steering delivery is unknown. Review the recorded reply before sending again.';
      this.pauseQueue('Paused after an unconfirmed steering result.');this.notice=item.notice;
    }else{
      const ownsComposer = this.active && tab.key === this.activeKey;
      const current = ownsComposer ? input.value : tab.draft, next = current.trim() ? current + '\n\n' + message : message;
      tab.draft = next; if (ownsComposer) input.value = next;
      this.preferenceEdits++; this.queueNativePreferences();
      this.notice = !failed&&reply===false?'This reply did not accept the steering message. Your text is back in the message box.':'Steering delivery is unknown. Your text is retained; review the recorded reply before sending again.';
    }
    this.render(); return false;
  }

  /** Queues the composer text to send after the running reply finishes successfully. */
  enqueue(): boolean {
    if(this.queueEnqueue)return false;
    const input = this.input(), tab = this.activeTab();
    if (!this.active || !input || !tab || !this.turn || !this.turnOwnsActiveTab()||!this.ready()) return false;
    if(this.profile.provider==='claude'&&!this.queueJournal.available(this.queueProject())){this.notice=this.queueJournal.notice()??'Wait for queued message recovery before adding another prompt.';this.render();return false;}
    const draft=input.value,message = draft.trim();
    if (!message) return false;
    if (message.length > MAX_INPUT) { this.notice = 'This message is too long for ' + this.profile.name + '. Shorten it to 100,000 characters.'; this.render(); return false; }
    let pending: unknown = null; try { pending = this.takeAttachments(message); } catch { pending = true; }
    if (pending) { this.notice = CLAUDE_CHAT_QUEUE_ATTACHMENTS_TEXT; this.render(); return false; }
    if (!this.turn.turnId){this.notice='Wait for the current message acknowledgement before queueing another prompt. Your text is retained.';this.render();return false;}
    if (!this.pushQueued(message,tab))return false;
    const item=this.queue.at(-1)!;
    if(this.profile.provider!=='claude'){
      item.notice='Queued in this window only.';this.armQueue(this.turn);input.value='';tab.draft='';this.notice='';this.render();return true;
    }
    const turn=this.turn!,gesture=this.queueGesture(),draftRevision=this.preferenceEdits,attachmentRevision=this.attachments.controller()?.selectionRevision();
    item.state='paused';item.notice='Saving queued message…';this.queueEnqueue=item;
    const saving=this.queueSave(true);this.render();
    void saving.then(saved=>{
      if(this.queueEnqueue!==item)return;this.queueEnqueue=null;
      if(!saved){
        // The IPC reply can fail after bytes were saved. Any surviving disk row restores paused.
        this.replaceQueue(this.queue.filter(row=>row!==item));this.notice='Saving the queued message could not be confirmed. Your original draft and files are retained.';
      }else if(gesture===this.queueGesture()&&draftRevision===this.preferenceEdits&&this.turn===turn&&!turn.stopping&&this.active&&this.input()===input&&input.value===draft&&this.attachments.controller()?.selectionRevision()===attachmentRevision){
        item.state='queued';item.notice=null;this.armQueue(turn);input.value='';tab.draft='';this.notice='';
      }else{
        item.notice='Saved and paused because the draft or conversation changed. Your current draft is retained.';
        this.pauseQueue('Paused while saving the queued message. Choose Send next to resume.');
      }
      this.render();
    });return true;
  }
  /** Queued messages (presentation and tests). */
  queued(): readonly { id: number; text: string }[] { const scope=this.queueScope();return this.queue.filter(item=>item.scope===scope).map(item => ({ id: item.id, text: item.text })); }
  /** Removes one queued message without sending it. */
  dequeue(id: number): void {
    if(this.queueEnqueue)return;
    const before = this.queue.length;
    this.replaceQueue(this.queue.filter(item => item.id !== id||item.scope!==this.queueScope()||item.state==='sending'));
    if (this.queue.length !== before) this.render();
  }
  /** Unsubmitted rows stay separate from drafts and require an explicit resume after failure. */
  private returnQueue(): void {
    if(!this.queue.length)return;this.pauseQueue('Paused because the reply did not finish. Choose Send next when ready.');
    this.notice='Queued messages are retained above the composer. Choose Send next to resume.';
  }
  /** Only the exact successful reply armed by a queue gesture can advance its own queue. */
  private drainQueue(finished?:Turn,manual=false): void {
    if(this.queueEnqueue||this.queueSending||this.queueSteering||this.turn||!this.active||!this.canSend()||!manual&&(!finished||this.queueAfterTurn!==finished))return;
    const scope=this.queueScope(),head=this.queue.find(item=>item.scope===scope&&item.state==='queued');if(!head)return;
    if(finished&&(finished.tabKey!==head.tabKey||finished.conversationId!==this.activeTab()?.conversationId)){this.pauseQueue('Conversation changed. Choose Send next to resume.');return;}
    this.queueAfterTurn=null;this.queueSending=true;head.state='sending';head.notice='Sending queued message…';this.render();
    void this.send(head.text,head).then(accepted=>{
      if(accepted){this.replaceQueue(this.queue.filter(item=>item!==head));if(this.active&&this.queueScope()===scope&&this.queue.some(item=>item.scope===scope&&item.state==='queued'))this.armQueue(accepted);}
      else if(head.state==='sending'){head.state='paused';head.notice='Not sent. Review this conversation and choose Send next.';this.pauseQueue('Paused after the queued message could not start.');}
      this.queueSending=false;this.render();
      if(accepted?.delivery.state==='completed')this.drainQueue(accepted);
    });
  }

  private queueScope(tab=this.activeTab()):string|null {const project=this.queueProject();return tab&&project&&this.profile.provider==='claude'?chatQueueScope('claude',project,tab.conversationId,null,tab.key):tab&&this.profile.provider!=='claude'?JSON.stringify([this.profile.provider,tab.key,tab.conversationId]):null;}
  private queueGesture():string{return JSON.stringify([this.active,this.viewEpoch,this.queueScope(),this.activeTab()?.model,this.activeTab()?.effort,this.turn?.turnId,this.turn?.stopping]);}
  private queueItem(captured:Readonly<ChatQueueRow>):(ChatQueueRow&{tabKey:string})|null{return this.queue.find(item=>item.id===captured.id&&item.scope===this.queueScope()&&item.scope===captured.scope&&item.text===captured.text&&item.state===captured.state)??null;}
  private pushQueued(text:string,tab:Tab):boolean {
    const scope=this.queueScope(tab);if(!scope)return false;
    if(this.queue.length>=64||this.queue.filter(item=>item.scope===scope).length>=CLAUDE_CHAT_QUEUE_LIMIT){this.notice='Up to '+CLAUDE_CHAT_QUEUE_LIMIT+' messages can wait in one chat. Remove one before adding another.';this.render();return false;}
    const target:StoredChatQueueRow={id:++this.queueSeq,localId:tab.key,conversationId:tab.conversationId,sessionId:null,text,modelId:tab.model||null,effort:tab.effort||null,connectionId:null,requestId:null,createdAt:new Date().toISOString(),state:'pending',attachmentState:'none'};
    this.queue.push({id:target.id,text,tabKey:tab.key,scope,state:'queued',notice:null,target});return true;
  }
  private queueSelection():string{return JSON.stringify([this.queueScope(),this.activeTab()?.model,this.activeTab()?.effort]);}
  private armQueue(turn:Turn|null):void{this.queueAfterTurn=turn;this.queueChoice=this.queueSelection();}
  private pauseQueue(reason:string):void {this.queueAfterDraftSendScope=null;this.queueAfterTurn=null;this.queueChoice=null;for(const item of this.queue)if(item.state==='queued'){item.state='paused';item.notice=reason;}}
  private queueAction(action:ChatQueueAction,captured:Readonly<ChatQueueRow>,gesture:string,text?:string):boolean {
    if(this.queueEnqueue||!this.active||gesture!==this.queueGesture())return false;const item=this.queueItem(captured);if(!item||item.state==='sending')return false;
    if((action==='steer'||action==='next')&&item.target?.attachmentState==='missing'){this.notice='Restore this message’s attachments before sending it. Your text is retained.';this.render();return false;}
    const scoped=this.queue.filter(row=>row.scope===item.scope),index=scoped.indexOf(item);
    if(action==='remove')this.dequeue(item.id);
    else if(action==='edit'){
      if(item.state==='unknown')return false;
      if(typeof text!=='string'||!text.trim()||text.length>MAX_INPUT){this.notice='Enter a message within the chat input limit.';this.render();return false;}
      item.text=text.trim();item.state='paused';item.notice='Edited. Choose Send next to resume.';
    }else if(action==='steer'){if(item.state==='unknown'||!this.canSteer())return false;void this.steer(item);}
    else if(action==='up'||action==='down'){
      const other=scoped[index+(action==='up'?-1:1)];if(!other)return false;const a=this.queue.indexOf(item),b=this.queue.indexOf(other);[this.queue[a],this.queue[b]]=[this.queue[b]!,this.queue[a]!];
    }else if(action==='next'){
      if(item.state==='unknown'||!this.ready()||this.rewinding)return false;
      const first=this.queue.indexOf(scoped[0]!);this.queue.splice(this.queue.indexOf(item),1);this.queue.splice(first,0,item);item.state='queued';item.notice=null;item.tabKey=this.activeTab()!.key;
      this.armQueue(this.turnOwnsActiveTab()?this.turn:null);if(!this.turn)this.drainQueue(undefined,true);
    }
    this.render();return true;
  }

  /** Sends the composer text, or one queued message (which leaves the composer untouched). */
  private sendPreparationFingerprint():string{return JSON.stringify([this.viewEpoch,this.preferenceStore?.projectPath,this.activeKey,this.activeTab()?.conversationId,this.activeTab()?.model,this.activeTab()?.effort,this.turn?.turnId]);}
  async send(queued?: string,queuedEntry?:ChatQueueRow): Promise<Turn|undefined> {
    if(this.queueEnqueue||this.nativeHydrating)return;
    const bridge = this.bridge, input = this.input(), tab = this.activeTab();
    if (!this.active || !bridge || !input || !tab || !this.canSend() || this.turn || this.rewinding||this.preparingSend) return;
    const message = (queued ?? input.value).trim();
    if (!message) return;
    if (message.length > MAX_INPUT) { this.notice = 'This message is too long for ' + this.profile.name + '. Shorten it to 100,000 characters.'; this.render(); return; }
    // A typed message carries the composer's attachments: text files are quoted into the text, PNG references travel as images.
    let attached: { text: string; images: ClaudeChatImage[] } | null = null;
    if (queued === undefined) {
      try { attached = this.takeAttachments(message); }
      catch (error) { this.notice = error instanceof Error && error.message.length <= 300 ? error.message : 'Attachments could not be prepared.'; this.render(); return; }
      if (attached && attached.text.length > MAX_INPUT) { this.notice = 'This message and its attachments are too long for ' + this.profile.name + '. Remove an attachment or shorten the message.'; this.render(); return; }
    }
    let sent = attached?.text ?? message;const visibleSent=sent,images = attached?.images ?? [];
    if(this.beforeMessageSubmit&&queued===undefined){
      const fingerprint=this.sendPreparationFingerprint();
      this.preparingSend=true;this.renderControls();
      try{
        const prepared=await this.beforeMessageSubmit(visibleSent);
        if(!this.active||input.value.trim()!==message||fingerprint!==this.sendPreparationFingerprint()||!this.canSend()||this.rewinding)return;
        if(typeof prepared!=='string'||!prepared.trim()||prepared.length>MAX_INPUT)throw new Error('Shared conversation context could not fit this message. Your draft is retained.');
        sent=prepared;
      }catch(error){this.notice=error instanceof Error?error.message:'Conversation context could not be prepared. Your draft is retained.';this.render();return;}
      finally{this.preparingSend=false;this.renderControls();}
    }
    if(queuedEntry){
      if(queuedEntry.scope!==this.queueScope()||queuedEntry.state!=='sending'||queuedEntry.target?.attachmentState==='missing')return;
      const fingerprint=this.sendPreparationFingerprint();this.preparingSend=true;
      const saved=this.profile.provider==='claude'?await this.queueSave(true):true;this.preparingSend=false;
      if(!saved||!this.active||fingerprint!==this.sendPreparationFingerprint()||this.turn||this.rewinding||!this.canSend()){
        queuedEntry.state='paused';queuedEntry.notice=saved?'Not sent: the conversation changed while saving.':'Not sent: secure saving failed. Your text is retained.';this.render();return;
      }
      queuedEntry.dispatched=true;
    }
    const { model, effort } = tab, epoch = this.viewEpoch, conversationId = tab.conversationId;
    const delivery:ClaudeMessageDelivery={model,effort,turnId:null,startedAt:new Date().toISOString(),finishedAt:null,state:'sending',error:null,contextIncluded:sent!==visibleSent,transmittedBytes:new TextEncoder().encode(sent).length};
    const turn: Turn = this.turn = { turnId: null, conversationId, tabKey: tab.key, stopping: false, bubble: null, text: '', echo: message, prompt: message, retry: images.length ? null : visibleSent,delivery };
    this.buffered = []; this.notice = '';
    if (queued === undefined) { input.value = ''; tab.draft = ''; }
    const echo: ClaudeChatMessage = { id: '', role: 'user', text: images.length ? visibleSent + '\n\n' + claudeImageMarkers(images) : visibleSent, at: delivery.startedAt,delivery };
    const echoArticle = this.appendMessage(echo, true), echoEpoch = this.viewEpoch;
    try { feedbackSink?.userMessage({ key: this.profile.provider + ':' + tab.key, text: message, box: this.el('codex-messages'), anchor: echoArticle }); } catch { /* Learning is optional. */ }
    this.render();
    let reply: Record<string, unknown> | null, failure = this.profile.name + ' could not start this message. Try again.';
    const playtestSwitch = this.doc.getElementById?.('playtest-toggle'), playtest = playtestSwitch ? { playtest: playtestSwitch.getAttribute('aria-checked') === 'true' } : {};
    try { reply = record(await bridge.send({ conversationId, text: sent, model, effort, ...(sent!==visibleSent?{displayText:visibleSent}:{}),...(images.length ? { images } : {}), ...playtest })); }
    catch (error) { reply = null; failure = bridgeError(error, failure, this.profile.knownErrors); }
    const turnId = text(reply?.turnId, 256), nextConversation = text(reply?.conversationId, 256);
    if (!turnId || !nextConversation) {
      delivery.state='failed';delivery.finishedAt=new Date().toISOString();delivery.error=failure;this.refreshMessageDetails();
      this.turn = null; this.buffered = [];
      const visible = this.active && epoch === this.viewEpoch;
      if (visible) this.appendMessage({ id: '', role: 'error', text: failure, at: '' }, true);
      if(queuedEntry){queuedEntry.state='unknown';queuedEntry.notice='Message delivery is unconfirmed. Review the recorded conversation before sending again.';}
      else if (queued !== undefined) this.pushQueued(message,tab);
      else {const current=visible?input.value:tab.draft;const restored=current.trim()?current+'\n\n'+message:message;tab.draft=restored;if(visible)input.value=restored;this.preferenceEdits++;this.queueNativePreferences();}
      this.returnQueue();
      this.render(); return;
    }
    turn.turnId = turnId; turn.conversationId = nextConversation;
    delivery.turnId=turnId;delivery.state='accepted';
    // Sent: the attachments are cleared (a failed start keeps them for another try).
    if (attached) { try { this.attachments.controller()?.clear(); } catch { /* Presentation only. */ } }
    // The engine's saved id for this message makes it editable once the reply has finished.
    const savedId = text(reply?.messageId, 256);
    if(savedId)echo.id=savedId;
    if (savedId && echoEpoch === this.viewEpoch) this.offerEdit(echoArticle, echo);
    this.reconcileShownIds();
    this.refreshMessageDetails();
    if (this.tabs.includes(tab) && tab.conversationId === null) tab.conversationId = nextConversation;
    if (!this.conversations.some(row => row.conversationId === nextConversation)) {
      this.conversationRevision++;
      this.conversations.unshift({ conversationId: nextConversation, title: message.split('\n')[0]!.slice(0, 80), updatedAt: new Date().toISOString(), model, effort });
    }
    this.persistTabs();
    if(this.queueAfterDraftSendScope===this.queueScope()){this.queueAfterDraftSendScope=null;this.armQueue(turn);}
    const pending = this.buffered.splice(0);
    this.render();
    for (const event of pending) this.onEvent(event);
    return turn;
  }

  async stopTurn(): Promise<void> {
    const turn = this.turn;
    if (!this.bridge || !turn?.turnId || turn.stopping) return;
    turn.stopping = true; this.render();
    let stopped = false;
    try { stopped = (await this.bridge.stop(turn.turnId)) !== false; } catch { stopped = false; }
    if (!stopped && this.turn === turn) { turn.stopping = false; this.notice = this.profile.name + ' could not stop this turn.'; this.render(); }
  }

  /** Deletes a saved conversation. A conversation with a running turn cannot be deleted. */
  async deleteConversation(conversationId: string): Promise<void> {
    const bridge = this.bridge;
    if (!bridge || this.deleting.has(conversationId) || !this.canDelete(conversationId)) return;
    this.confirmingDelete = false; this.deleting.add(conversationId); this.render();
    try { await bridge.remove(conversationId); }
    catch (error) {
      this.deleting.delete(conversationId);
      this.notice = bridgeError(error, 'This conversation could not be deleted. Try again.', this.profile.knownErrors); this.render(); return;
    }
    this.deleting.delete(conversationId);
    this.loadUsage(); if (this.usage.delete(conversationId)) this.saveUsage();
    this.conversationRevision++;this.conversations = this.conversations.filter(row => row.conversationId !== conversationId);
    const tab = this.tabs.find(row => row.conversationId === conversationId);
    if (tab) { tab.draft = ''; this.closeTab(tab.key); }
    await this.reloadList();
    this.render();
  }

  private canDelete(conversationId: string): boolean {
    const turn = this.turn;
    return !!this.bridge && !this.deleting.has(conversationId) && !(turn && (turn.turnId === null || turn.conversationId === conversationId));
  }
  protected ready(): boolean { return !!this.bridge && !!this.state?.installed && !!this.state.signedIn && !this.statusError; }
  protected modelLabel(model: string): { short: string; full: string; id: string } { return claudeModelLabel(model, this.state?.resolved); }
  protected models(): string[] { const state = this.state; return state ? state.models.length ? state.models : state.defaultModel ? [state.defaultModel] : [] : []; }
  private efforts(): string[] { return this.state?.efforts ?? []; }
  private canSend(): boolean { const tab = this.activeTab(); return this.ready() && !!tab && this.models().includes(tab.model) && this.efforts().includes(tab.effort); }
  private turnOwnsActiveTab(): boolean { return !!this.turn && this.turn.tabKey === this.activeKey; }

  private createTab(conversationId: string | null): Tab {
    const saved = this.readChoice();
    const tab: Tab = { key: this.nextTabKey(), conversationId, model: saved.model, effort: saved.effort, draft: '' };
    this.tabs.push(tab); this.applyDefaultsTo(tab);
    return tab;
  }
  private saveDraft(): void { const tab = this.activeTab(), input = this.input(); if (this.active && tab && input && tab.draft!==input.value) {tab.draft = input.value;this.preferenceEdits++;if(this.preferenceStore)this.persistTabs();} }

  private async showTab(key: string,prepared?:Record<string,unknown>): Promise<void> {
    const tab = this.tabs.find(row => row.key === key); if (!tab) return;
    if(key!==this.activeKey)this.pauseQueue('Paused after changing chats. Choose Send next to resume.');
    this.rememberMessages();
    this.activeKey = key; this.confirmingDelete = false; this.persistTabs();
    if (!this.active) { this.render(); return; }
    const epoch = ++this.viewEpoch;
    const input = this.input(); if (input) input.value = tab.draft;
    this.cancelStream();
    if (this.turn) { this.turn.bubble = null; }
    this.closePicker();
    this.loading = !!tab.conversationId; this.clearMessages();
    this.shownKey=key;
    for(const message of this.cachedMessages.get(key)??[])this.appendMessage(message,false,true);
    this.attachRunningBubble();
    this.render();
    if (!tab.conversationId || !this.bridge) return;
    const atReadStart=new Set(this.shown),readingDelivery=this.turnOwnsActiveTab()?this.turn?.delivery:null;
    try {
      const value = prepared??record(await this.bridge.history(tab.conversationId));
      if (epoch !== this.viewEpoch || !this.active) return;
      const messages = Array.isArray(value?.messages) ? value.messages : null;
      if (!messages) throw Error('history');
      const live=this.shown.slice();
      this.loading = false; this.clearMessages();this.shownKey=key;
      // A long conversation shows its last turns; the earlier ones render in place from "Show earlier messages".
      const recorded=messages.map(readClaudeChatMessage).filter((message):message is ClaudeChatMessage=>!!message),recordedIds=new Set(recorded.flatMap(message=>message.id?[message.id]:[]));
      // Saved history replaces older cached turns. Preserve exact matching metadata, the reply that was already
      // running when the read began, and messages received while it was pending, even if that reply has now finished.
      const current=live.filter(message=>!!message.id&&recordedIds.has(message.id)||!!readingDelivery&&message.delivery===readingDelivery||!atReadStart.has(message));
      const saved = mergeClaudeChatMessages(recorded,current);
      const first = transcriptWindowStart(saved.flatMap((message, index) => message.role === 'user' || index === 0 ? [index] : []));
      this.shown.push(...saved.slice(0, first));
      for (const message of saved.slice(first)) this.appendMessage(message, false, true);
      this.attachRunningBubble();
      if (first) this.offerEarlier(saved.slice(0, first), saved[first]?.role === 'user' ? saved[first]!.text : null);
      // The last saved turn's changes; a turn still running in this chat shows its card when it finishes.
      if (this.turn?.conversationId !== tab.conversationId) this.flushChanges();
      this.scrollToBottom();
    } catch (error) {
      if (epoch !== this.viewEpoch || !this.active) return;
      this.loading = false;
      this.notice = bridgeError(error, 'This conversation could not be refreshed. Displayed messages and your draft are retained. Try again.', this.profile.knownErrors);
    }
    this.render();
  }

  private async reloadList(): Promise<void> {
    if (!this.bridge) return;
    const previous = this.conversations,revision=this.conversationRevision;
    let ok = false;
    try { const next=readConversations(await this.bridge.list());if(revision!==this.conversationRevision)return;this.conversations = next; ok = true; this.listed = true; }
    catch { if (!this.statusError) this.notice = 'Saved ' + this.profile.name + ' conversations could not be read.'; }
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
    const visible = this.active && turn.conversationId !== null && turn.conversationId === this.activeTab()?.conversationId;
    switch (event.type) {
      case 'delta': {
        turn.text = (turn.text + text(event.text)).slice(-MAX_TEXT);
        if (!visible) return;
        // Only the reply being written is a live region; aria-busy holds its announcement until it settles.
        if (!turn.bubble) { turn.bubble = this.appendMessage({ id: '', role: 'assistant', text: '', at: '',delivery:turn.delivery }, false); turn.bubble.setAttribute('aria-busy', 'true'); turn.bubble.setAttribute('aria-live', 'polite'); }
        this.paintStream();
        return;
      }
      case 'message': case 'tool': {
        const message = readClaudeChatMessage(event.message);
        if (!message) return;
        message.delivery=turn.delivery;
        if (message.role === 'user' && turn.echo !== null && message.text.trim() === turn.echo) { turn.echo = null; return; }
        // A finished reply replaces the pending paint; anything else first draws the text that streamed before it.
        if (message.role === 'assistant') this.cancelStream(); else this.flushStream();
        if (!visible) { if (message.role === 'assistant') { turn.bubble = null; turn.text = ''; } return; }
        if (message.role === 'assistant' && turn.bubble) {
          const row=this.messageElements.get(turn.bubble);if(row)Object.assign(row,message,{text:message.text||turn.text});
          this.setText(turn.bubble, message.text || turn.text, true);
          turn.bubble.setAttribute('aria-busy', 'false'); turn.bubble.removeAttribute('aria-live');
          turn.bubble = null; turn.text = '';this.reconcileShownIds();this.refreshMessageDetails(); return;
        }
        if (message.role === 'assistant') { turn.bubble = null; turn.text = ''; }
        const near = this.nearBottom();
        this.appendMessage(message, false);
        if (near) this.scrollToBottom();
        return;
      }
      case 'done': {
        this.flushStream();
        turn.bubble?.setAttribute('aria-busy', 'false'); turn.bubble?.removeAttribute('aria-live');
        const ok = event.ok === true, error = nullableText(event.error, 2048), limited = ok ? null : readUsageLimit(event.usageLimit, error, this.profile.usageLimitText);
        turn.delivery.state=ok?'completed':turn.stopping?'stopped':'failed';turn.delivery.finishedAt=new Date().toISOString();turn.delivery.error=error;this.refreshMessageDetails();
        this.turn = null; this.markTurnLive();
        // At the usage limit the unanswered message returns to an empty composer so it can move to the other provider.
        // It is never resent automatically.
        if (limited) {
          const tab = this.tabs.find(row => row.key === turn.tabKey), input = this.input(), shown = this.active && tab?.key === this.activeKey;
          if (tab && !tab.draft.trim() && !(shown && input?.value.trim())) { tab.draft = turn.prompt; if (shown && input) input.value = turn.prompt; }
        }
        if (visible) this.flushChanges();
        if (visible && !ok && !(turn.stopping && !error)) {
          // At a subscription usage limit the line says which limit and when it resets, in the notice's own words.
          const limitText = limited && this.profile.provider !== 'arcane' ? usageLimitNoticeText(this.profile.provider, limited) + ' This message was not answered.' : null;
          const failed = this.appendMessage({ id: '', role: 'error', text: limitText ?? error ?? this.profile.name + ' stopped before finishing.', at: '' }, true);
          if (limitText) failed.className += ' chat-usage-limit';
          // A crash, expired sign-in, outage or offline Studio: the same message can be sent again, only on click.
          if (!limited && !turn.stopping && turn.retry) this.offerRetry(failed, turn.retry, turn.tabKey);
        }
        const model = this.turnModel(turn.tabKey), display = this.costDisplay(), reply = claudeReplyCost(event.usage, model);
        this.notice = turn.stopping && !ok ? 'Stopped.' : this.replyNotice(event.usage, model, display) ?? (ok ? 'Done.' : '');
        if (visible && reply) this.appendReplyUsage(reply, display);
        if (visible && ok) try { feedbackSink?.turnFinished({ key: this.profile.provider + ':' + turn.tabKey, ok, tools: this.turnTools(), box: this.el('codex-messages') }); } catch { /* Learning is optional. */ }
        this.addUsage(turn.conversationId, reply);
        if (limited) this.setUsageLimit(limited); else if (ok) this.setUsageLimit(null);
        // The queue continues only after a reply that finished; a failure, Stop or usage limit returns it to the draft.
        if (ok) this.drainQueue(turn); else this.returnQueue();
        try { this.replyFinished(); } catch { /* Presentation only. */ }
        this.render();
        void this.reloadList().then(() => this.render());
        return;
      }
    }
  }

  /** The exact model ID a tab's turn ran on (alias resolved when Claude Code reported it). */
  protected turnModel(tabKey: string): string | null {
    const alias = this.tabs.find(tab => tab.key === tabKey)?.model ?? null;
    return alias ? this.state?.resolved[alias] ?? alias : null;
  }
  private costDisplay(): TaskUsageCostDisplay { return costDisplay(this.doc, this.storage); }
  /** A subtle '12k tokens (~$0.31)' line under the finished reply. Its numbers stay on the node so a preference change re-renders it. */
  private appendReplyUsage(reply: ClaudeReplyCost, display: TaskUsageCostDisplay): void {
    const box = this.el('codex-messages'); if (!box || !this.active) return;
    const line = this.make('p', replyUsageText(reply.tokens, reply.usd, display), 'reply-usage');
    line.dataset.tokens = String(reply.tokens); line.dataset.inputTokens = String(reply.inputTokens); line.dataset.outputTokens = String(reply.outputTokens);
    if (reply.usd !== null) line.dataset.usd = String(reply.usd);
    if (reply.source) line.dataset.costSource = reply.source;
    line.title = claudeReplyUsageTitle(reply, display);
    const last = Array.from(box.querySelectorAll<HTMLElement>('.codex-message')).at(-1);
    if (last && last.getAttribute('data-role') === 'assistant') last.append(line); else box.append(line);
  }
  /** Re-renders every visible reply usage line after a cost preference change. */
  private refreshReplyUsage(): void {
    const box = this.el('codex-messages'); if (!box) return;
    const display = this.costDisplay();
    for (const line of Array.from(box.querySelectorAll<HTMLElement>('.reply-usage'))) {
      const number = (key: string) => { const value = Number(line.dataset[key]); return Number.isFinite(value) && value >= 0 ? value : null; };
      const tokens = number('tokens'); if (tokens === null) continue;
      const source = line.dataset.costSource === 'reported' || line.dataset.costSource === 'table' ? line.dataset.costSource : null;
      const reply: ClaudeReplyCost = { tokens, inputTokens: number('inputTokens') ?? 0, outputTokens: number('outputTokens') ?? 0, usd: number('usd'), source };
      line.textContent = replyUsageText(reply.tokens, reply.usd, display); line.title = claudeReplyUsageTitle(reply, display);
    }
  }
  /** Accumulates a finished reply's tokens and cost for its conversation's meter, and keeps the totals on this device. */
  private addUsage(conversationId: string | null, reply: ClaudeReplyCost | null): void {
    if (!conversationId || !reply) return;
    this.loadUsage();
    const row = this.usage.get(conversationId) ?? { inputTokens: 0, outputTokens: 0, costUsd: null, replies: 0, tableCostReplies: 0, uncostedReplies: 0 };
    row.inputTokens += reply.inputTokens; row.outputTokens += reply.outputTokens; row.replies++;
    if (reply.usd !== null) row.costUsd = (row.costUsd ?? 0) + reply.usd; else row.uncostedReplies++;
    if (reply.source === 'table') row.tableCostReplies++;
    this.usage.delete(conversationId); this.usage.set(conversationId, row);
    while (this.usage.size > USAGE_ROWS) this.usage.delete(this.usage.keys().next().value!);
    this.saveUsage();
  }
  private usageLoaded = false;
  private loadUsage(): void {
    if (this.usageLoaded) return;
    this.usageLoaded = true;
    try {
      const stored = record(JSON.parse(this.storage?.getItem(this.profile.keys.usage) ?? 'null')), rows = record(stored?.rows);
      if (stored?.version !== 1 || !rows) return;
      const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12 ? v : null;
      for (const [id, value] of Object.entries(rows).slice(-USAGE_ROWS)) {
        const row = record(value); if (!row || !id || id.length > 256 || this.usage.has(id)) continue;
        const input = count(row.inputTokens), output = count(row.outputTokens), replies = count(row.replies);
        if (input === null || output === null || !replies) continue;
        this.usage.set(id, { inputTokens: input, outputTokens: output, costUsd: row.costUsd === null ? null : count(row.costUsd), replies: Math.round(replies),
          tableCostReplies: Math.round(count(row.tableCostReplies) ?? 0), uncostedReplies: Math.round(count(row.uncostedReplies) ?? 0) });
      }
    } catch { /* Usage history is optional presentation. */ }
  }
  private saveUsage(): void {
    try { this.storage?.setItem(this.profile.keys.usage, JSON.stringify({ version: 1, rows: Object.fromEntries(this.usage) })); } catch { /* Totals stay for this session. */ }
  }
  /** Token and cost totals for a conversation recorded on this device; null before its first finished reply. */
  conversationUsage(conversationId: string | null = this.activeConversation()): ClaudeConversationUsage | null {
    this.loadUsage();
    const row = conversationId ? this.usage.get(conversationId) : undefined; return row ? { ...row } : null;
  }
  /** Shows the visible turn's Studio changes as one card after its messages. */
  /** The shared transcript's build progress group is live while this tab's turn runs (presentation only). */
  /** The visible turn's tool calls (after its user message), with their transcript articles, for the feedback seam. */
  private turnTools(): { name: string; status: string; input?: string; result?: string; article: HTMLElement | null }[] {
    let start = this.shown.length; while (start > 0 && this.shown[start - 1]!.role !== 'user') start--;
    return this.shown.slice(start).filter(row => !!row.tool).map(row => ({ name: row.tool!.name, status: row.tool!.status,
      ...(row.tool!.input !== undefined ? { input: row.tool!.input } : {}), ...(row.tool!.result !== undefined ? { result: row.tool!.result } : {}),
      article: row.id ? this.tools.get(row.id)?.article ?? null : null }));
  }
  private markTurnLive(): void {
    const box = this.el('codex-messages'); if (!box?.dataset || !this.active) return;
    const live = String(!!this.turn && this.turn.tabKey === this.activeKey);
    if (box.dataset.turnLive !== live) box.dataset.turnLive = live;
  }
  private flushChanges(): void {
    const changes = this.turnChanges; this.turnChanges = [];
    const box = this.el('codex-messages'); if (!box || !this.active || !changes.length) return;
    const card = renderChangeCard(this.doc, changes); if (!card) return;
    const near = this.nearBottom(); box.append(card); if (near) this.scrollToBottom();
  }
  private toolArticle(message: ClaudeChatMessage, tool: ClaudeChatTool, extra: string): HTMLElement {
    const article = this.make('article', undefined, 'codex-message tool');
    article.setAttribute('data-role', 'tool'); article.setAttribute('aria-label', 'Tool activity'); article.dataset.toolState = tool.status;
    // Keyed so the build progress group keeps one start time per call across its status updates.
    if (message.id) article.dataset.toolKey = 'claude\0' + message.id;
    if (message.at) article.dataset.toolAt = message.at;
    // A failed call's plain-text result is its reason; JSON results describe themselves.
    const activity = describeToolActivity(tool.name, parseToolDetail(tool.input), parseToolDetail(tool.result) ?? (tool.status === 'failed' ? tool.result ?? null : null), tool.status);
    const capture = tool.status === 'finished' ? tool.image ?? (message.id ? this.toolImages.get(message.id) : undefined) : undefined;
    if (capture && message.id && tool.image) { this.toolImages.delete(message.id); this.toolImages.set(message.id, capture); while (this.toolImages.size > 8) this.toolImages.delete(this.toolImages.keys().next().value!); }
    if (capture && !activity.image) activity.image = toolResultImage({ image: capture });
    if (activity.change && !this.turnChanges.some(change => change.receipt === activity.change!.receipt)) this.turnChanges.push(activity.change);
    const scope = this.profile.name + ' · ' + (this.activeTab()?.conversationId ?? 'new chat') + (message.at ? ' · ' + message.at : '');
    article.append(...renderToolActivity(this.doc, activity, tool.status,
      toolDetailText([['Tool', tool.name], ['Input', tool.input], ['Result', tool.result], ['Note', extra], ['Message', scope]])));
    return article;
  }

  /** Codex transcript markup: article.codex-message.{human|codex|tool} > pre.message-text + Message details. */
  private messageElement(message: ClaudeChatMessage, restored = false): HTMLElement {
    const role = message.role === 'user' ? 'human' : message.role === 'assistant' ? 'codex' : 'tool';
    if (message.tool || message.role === 'tool') {
      const tool = message.tool ?? { name: message.text || 'Tool', status: 'finished' as const };
      const extra = message.tool && message.text && message.text !== message.tool.name ? message.text : '';
      const article = this.toolArticle(message, tool, extra);
      if (message.id) this.tools.set(message.id, { article, tool, text: extra });
      return article;
    }
    const article = this.make('article', undefined, 'codex-message ' + role + (message.steered ? ' steered' : ''));
    this.messageElements.set(article,message);
    article.setAttribute('data-role', message.role);
    article.setAttribute('aria-label', message.steered ? 'Your steering message' : message.role === 'user' ? 'Your message' : message.role === 'assistant' ? 'Assistant message' : 'Error');
    // Steered into the running reply: a small label above the text (the build progress group continues past it).
    if (message.steered) { article.dataset.steered = 'true'; article.append(this.make('p', 'Steered', 'message-steer-label')); }
    const body = this.make('pre', undefined, 'message-text');
    article.append(message.role === 'assistant' ? renderMessageText(this.doc, message.text, restored ? { restored: true } : this.choiceOptions()) : Object.assign(body, { textContent: message.text }));
    if (message.role === 'error') article.append(this.make('p', 'Not completed', 'message-acknowledgement'));
    const details = this.make('details', undefined, 'message-details');
    details.append(this.make('summary', 'Message details'), this.make('pre', claudeMessageDetails(message,this.profile.name,this.activeTab()?.conversationId??null), 'hint mono'));
    article.append(details);
    if (editable(message)) this.offerEdit(article, message);
    return article;
  }
  /**
   * Replaces an assistant message body; fenced code renders as <pre><code>, never as HTML. A finished (`live`) reply's
   * arcane-choices / arcane-plan block becomes buttons; while streaming it stays display-only.
   */
  private setText(article: HTMLElement, value: string, live = false): void {
    // Finished blocks keep their nodes; only the changed tail (normally the block being written) is replaced.
    const body = article.querySelector<HTMLElement>(".message-text"), next = patchMessageText(this.doc, body, value, live ? this.choiceOptions() : {});
    if (next === body) return;
    if (body) body.replaceWith(next); else article.prepend(next);
  }
  /** Draws the streamed reply: at once without animation frames, otherwise once per frame and STREAM_FRAME_MS at most. */
  private paintStream(): void {
    const view = this.doc.defaultView;
    if (typeof view?.requestAnimationFrame !== 'function') { this.drawStream(); return; }
    if (this.streamFrame) return;
    let id = 0;
    const tick = () => {
      if (Date.now() - this.streamPainted < STREAM_FRAME_MS) { id = view.requestAnimationFrame(tick); return; }
      this.streamFrame = null; this.drawStream();
    };
    id = view.requestAnimationFrame(tick);
    this.streamFrame = () => view.cancelAnimationFrame(id);
  }
  /** Draws a pending streamed paint now (before a tool line, the end of the turn, and so on). */
  private flushStream(): void { if (this.streamFrame) { this.cancelStream(); this.drawStream(); } }
  private cancelStream(): void { const cancel = this.streamFrame; this.streamFrame = null; cancel?.(); }
  private drawStream(): void {
    const turn = this.turn; if (!turn?.bubble || !this.active) return;
    // Follows the reply only while the reader is at the bottom; scrolling up stops the follow.
    const near = this.nearBottom();
    const message=this.messageElements.get(turn.bubble);if(message)message.text=turn.text;
    this.setText(turn.bubble, turn.text); this.streamPainted = Date.now();
    this.publishTranscript();
    if (near) this.scrollToBottom();
  }
  /** Long saved conversations show their last turns first; "Show earlier messages" renders the rest in place. */
  private offerEarlier(earlier: ClaudeChatMessage[], answer: string | null): void {
    const box = this.el('codex-messages'); if (!box) return;
    const key = this.activeKey;
    const button = renderEarlierButton(this.doc, earlier.length, () => {
      if (!this.active || this.activeKey !== key || !button.isConnected) return;
      revealEarlier(box, () => button.replaceWith(this.renderEarlier(earlier, answer)));
    });
    box.prepend(button);
  }
  /** Saved messages before the window, with their turns' change cards and answered choices, as they render on load. */
  private renderEarlier(earlier: ClaudeChatMessage[], answer: string | null): DocumentFragment {
    const fragment = this.doc.createDocumentFragment(), live = this.turnChanges;
    this.turnChanges = [];
    const flush = () => { const card = renderChangeCard(this.doc, this.turnChanges); this.turnChanges = []; if (card) fragment.append(card); };
    try {
      for (const message of earlier) {
        if (message.role === 'user') { flush(); closeChoiceBlocks(fragment, message.text); }
        fragment.append(this.messageElement(message, true));
      }
      flush(); closeChoiceBlocks(fragment, answer);
    } finally { this.turnChanges = live; }
    return fragment;
  }
  private choiceOptions(): ChoiceBlockOptions { return { choose: answer => this.answerChoice(answer) }; }
  /**
   * A choice or "Approve plan" click: the user's explicit answer, sent as exactly one next message. While a reply runs in
   * this chat it waits in the queue (sent after that reply finishes; returned to the draft otherwise).
   */
  answerChoice(answer: string): boolean {
    const tab = this.activeTab(), message = answer.trim();
    if (!this.active || !tab || !message || message.length > MAX_INPUT || this.rewinding) return false;
    if (this.turn) {
      if (!this.turnOwnsActiveTab() || this.turn.turnId === null || this.queue.length >= CLAUDE_CHAT_QUEUE_LIMIT || !this.ready()) return false;
      if(!this.pushQueued(message,tab))return false;this.armQueue(this.turn);this.render();
      return true;
    }
    if (!this.canSend()) return false;
    void this.send(message);
    return true;
  }

  /** "Retry message" under a reply that did not finish. Sends that message again only when clicked; the composer draft stays. */
  private offerRetry(article: HTMLElement, message: string, tabKey: string): void {
    const button = this.make('button', 'Retry message', 'secondary chat-message-retry'); button.type = 'button';
    button.setAttribute('aria-label', 'Send this message again');
    button.addEventListener('click', () => {
      if (button.disabled) return;
      if (!this.active || this.activeKey !== tabKey || this.turn || this.rewinding) { this.notice = 'Wait for the current reply to finish, then retry the message.'; this.render(); return; }
      if (!this.canSend()) { this.notice = this.profile.name + ' is not ready to send. Check the model and sign-in, then retry the message.'; this.render(); return; }
      button.disabled = true; button.hidden = true;
      void this.send(message);
    });
    article.append(button);
  }

  // ---- Edit a past message and rewind ----
  /** Adds the hover/focus "Edit" action to one saved user message (only when the bridge can rewind). */
  private offerEdit(article: HTMLElement, message: ClaudeChatMessage): void {
    if (!this.bridge?.rewind || !editable(message) || article.querySelector('.chat-message-edit')) return;
    const button = this.make('button', 'Edit', 'quiet chat-message-edit'); button.type = 'button';
    button.setAttribute('aria-label', 'Edit this message'); button.title = 'Edit this message and continue the chat from here';
    button.addEventListener('click', () => { if (this.active) this.beginEdit(article, message); });
    article.append(button);
  }
  /** Studio changes (receipts) made by tool calls after the user message `messageId`, oldest first. */
  changesAfter(messageId: string): ToolChange[] {
    const at = this.shown.findIndex(row => row.id === messageId && row.role === 'user');
    if (at < 0) return [];
    const changes: ToolChange[] = [];
    for (const row of this.shown.slice(at + 1)) {
      if (!row.tool) continue;
      const change = describeToolActivity(row.tool.name, parseToolDetail(row.tool.input), parseToolDetail(row.tool.result), row.tool.status).change;
      if (change && !changes.some(item => item.receipt === change.receipt)) changes.push(change);
    }
    return changes;
  }
  /** Inline editor in place of the message text: textarea, optional undo checkbox, Send and Cancel. Nothing is sent until Send. */
  private beginEdit(article: HTMLElement, message: ClaudeChatMessage): void {
    if (this.turn || this.rewinding) { this.notice = 'Wait for the reply to finish before editing a message.'; this.render(); return; }
    if (article.querySelector('.chat-edit')) return;
    const changes = this.changesAfter(message.id);
    const form = this.make('form', undefined, 'chat-edit'); form.setAttribute('aria-label', 'Edit message');
    const area = this.make('textarea', undefined, 'chat-edit-input'); area.value = message.text; area.setAttribute('aria-label', 'Edited message');
    area.rows = Math.min(8, Math.max(2, message.text.split('\n').length));
    const undo = this.make('input'); undo.type = 'checkbox'; undo.className = 'chat-edit-undo-box'; undo.disabled = !changes.length;
    const label = this.make('label', undefined, 'chat-edit-undo');
    label.append(undo, this.make('span', CLAUDE_CHAT_EDIT_UNDO_LABEL + (changes.length ? ' (' + changes.length + ')' : '')));
    const hint = this.make('p', 'Replies after this message are removed from this chat. ' + (changes.length
      ? 'With the box checked, a restore request for those Studio changes is written into the message box for you to review and send first.'
      : 'No Studio changes were made after this message.'), 'chat-edit-hint');
    const actions = this.make('div', undefined, 'chat-edit-actions');
    const send = this.make('button', 'Send edited message', 'chat-edit-send'); send.type = 'submit';
    const cancel = this.make('button', 'Cancel', 'secondary chat-edit-cancel'); cancel.type = 'button';
    actions.append(send, cancel);
    form.append(area, label, hint, actions);
    const close = () => { try { article.replaceWith(this.messageElement(message)); } catch { /* Already gone with its transcript. */ } };
    const submit = () => { if (this.active) void this.submitEdit(message, area.value, undo.checked === true && !undo.disabled); };
    form.addEventListener('submit', event => { event.preventDefault(); submit(); });
    cancel.addEventListener('click', close);
    area.addEventListener('keydown', event => {
      const key = event as KeyboardEvent;
      if (key.key === 'Escape') { event.preventDefault(); close(); return; }
      if (key.key === 'Enter' && !key.shiftKey && !key.isComposing && !key.altKey && !key.ctrlKey && !key.metaKey) { event.preventDefault(); submit(); }
    });
    const body = article.querySelector<HTMLElement>('.message-text'); if (body) body.hidden = true;
    for (const selector of ['.chat-message-edit', '.message-details']) { const node = article.querySelector<HTMLElement>(selector); if (node) node.hidden = true; }
    article.dataset.editing = 'true'; article.append(form);
    try { area.focus({ preventScroll: true }); } catch { /* Focus is presentation only. */ }
  }
  /**
   * Rewinds the saved conversation to just before `message` (the engine drops it and everything after it), reloads the
   * kept transcript, then continues: the edited text is sent now, or — with "Also undo Studio changes" — a restore request
   * for the discarded turns' receipts (newest first) is written into the message box for the user to review and send, and
   * the edited text waits in the queue behind it. Studio is never changed without that explicit Send.
   */
  async submitEdit(message: ClaudeChatMessage, value: string, undo: boolean): Promise<void> {
    const bridge = this.bridge, tab = this.activeTab(), edited = value.trim();
    if (!this.active || !bridge?.rewind || !tab?.conversationId || this.turn || this.rewinding || !editable(message)) return;
    if (!edited) { this.notice = 'The edited message is empty.'; this.render(); return; }
    if (edited.length > MAX_INPUT) { this.notice = 'This message is too long for ' + this.profile.name + '. Shorten it to 100,000 characters.'; this.render(); return; }
    if (!this.canSend()) { this.notice = this.profile.name + ' is not ready to send. Check the model and sign-in, then try again.'; this.render(); return; }
    const changes = undo ? this.changesAfter(message.id) : [], conversationId = tab.conversationId;
    this.rewinding = true; this.notice = 'Editing…'; this.render();
    try { await bridge.rewind({ conversationId, messageId: message.id }); }
    catch (error) { this.rewinding = false; this.notice = bridgeError(error, 'This message could not be edited. Try again.', this.profile.knownErrors); this.render(); return; }
    this.rewinding = false;
    this.discardEditedMessages(tab.key,message.id);
    if (this.activeTab() !== tab || tab.conversationId !== conversationId) return;
    await this.showTab(tab.key);
    if (!this.active || this.activeKey !== tab.key) return;
    if (changes.length) {
      prefillComposer(this.doc, restoreRequestText(changes));
      if(this.pushQueued(edited,tab))this.queueAfterDraftSendScope=this.queueScope();else{const input=this.input();if(input){input.value+='\n\nEdited message to continue with after restoring:\n'+edited;tab.draft=input.value;}}
      this.notice = CLAUDE_CHAT_EDIT_UNDO_TEXT; this.render();
      return;
    }
    this.notice = '';
    await this.send(edited);
  }

  /** The acknowledged rewind removes this message and its replies even if the following history read fails. */
  private discardEditedMessages(tabKey:string,messageId:string):void {
    const kept=(messages:ClaudeChatMessage[])=>{const index=messages.findIndex(message=>message.id===messageId);return index<0?messages:messages.slice(0,index);};
    const cached=this.cachedMessages.get(tabKey);if(cached)this.cachedMessages.set(tabKey,kept(cached));
    if(this.shownKey!==tabKey)return;
    const messages=kept(this.shown);this.cachedMessages.set(tabKey,messages);
    this.clearMessages();this.shownKey=tabKey;
    if(this.active)for(const message of messages)this.appendMessage(message,false,true);
    else this.shown=messages;
  }

  /** `restored`: from saved history, so its choice / plan buttons are inert and only show the answer given. */
  private appendMessage(message: ClaudeChatMessage, scroll: boolean, restored = false): HTMLElement {
    const known = message.id && message.tool ? this.tools.get(message.id) : undefined;
    if (known) {
      // Status update of a shown tool line: the started event's input is kept when the update omits it.
      const tool: ClaudeChatTool = { ...message.tool!, ...(message.tool!.input === undefined && known.tool.input !== undefined ? { input: known.tool.input } : {}) };
      const next = this.toolArticle(message, tool, known.text);
      known.article.replaceWith(next); this.tools.set(message.id, { article: next, tool, text: known.text });
      const row = this.shown.findIndex(item => item.id === message.id && !!item.tool);
      if (row >= 0) this.shown[row] = { ...message, tool };
      return next;
    }
    const box = this.el('codex-messages');
    // A new user message starts a new turn: the previous turn's changes are summarised first, and earlier choice buttons close.
    if (message.role === 'user' && !message.steered) { this.flushChanges(); closeChoiceBlocks(box, message.text); }
    if (this.active) this.shown.push(message);
    const element = this.messageElement(message, restored);
    if (!box) return element;
    // Saved history loads without per-message layout reads; showTab scrolls once at the end.
    const near = !restored && (scroll || this.nearBottom());
    if (this.messageCount === 0) box.replaceChildren();
    box.append(element); this.messageCount++;
    this.publishTranscript();
    if (near) this.scrollToBottom();
    return element;
  }

  private rememberMessages():void {
    if(!this.shownKey)return;
    // A closed tab never retains another copy of its transcript.
    for(const key of this.cachedMessages.keys())if(!this.tabs.some(tab=>tab.key===key))this.cachedMessages.delete(key);
    const bounded:ClaudeChatMessage[]=[];let bytes=0;
    for(const message of this.shown.slice().reverse()){
      const cached={...message};if(message.tool){const {image,...tool}=message.tool;cached.tool=tool;}
      const size=new TextEncoder().encode(JSON.stringify(cached)).length;
      if(bounded.length>=256||bytes+size>512*1024)break;
      bytes+=size;bounded.unshift(cached);
    }
    if(this.tabs.some(tab=>tab.key===this.shownKey))this.cachedMessages.set(this.shownKey,bounded);
  }
  private refreshMessageDetails():void {
    const articles=Array.from(this.el('codex-messages')?.querySelectorAll<HTMLElement>('.codex-message')??[]);
    for(const article of articles){
      const message=this.messageElements.get(article);if(!message)continue;
      if(message.tool)continue;
      const pre=article?.querySelector<HTMLElement>('.message-details pre');
      if(pre)pre.textContent=claudeMessageDetails(message,this.profile.name,this.activeTab()?.conversationId??null);
    }
  }
  private attachRunningBubble():void {
    if(!this.turnOwnsActiveTab()||!this.turn)return;
    const turn=this.turn;
    const articles=Array.from(this.el('codex-messages')?.querySelectorAll<HTMLElement>('.codex-message')??[]);
    turn.bubble=articles.findLast(article=>{const message=this.messageElements.get(article);return message?.role==='assistant'&&message.delivery===turn.delivery&&turn.delivery.state==='accepted';})??null;
    if(turn.bubble){turn.bubble.setAttribute('aria-busy','true');turn.bubble.setAttribute('aria-live','polite');}
  }
  private reconcileShownIds():void {
    const ids=this.shown.filter(message=>!!message.id).map(message=>message.id);
    if(new Set(ids).size===ids.length)return;
    const messages=mergeClaudeChatMessages([],this.shown),key=this.shownKey;
    this.clearMessages();this.shownKey=key;
    for(const message of messages)this.appendMessage(message,false,true);
    this.attachRunningBubble();
  }

  private clearMessages(): void {
    this.cancelStream();
    this.tools.clear(); this.messageCount = 0; this.turnChanges = []; this.shown = [];
    const box = this.el('codex-messages'); if (!box || !this.active) return;
    box.replaceChildren(this.make('p', this.loading ? 'Loading conversation…' : this.profile.emptyText, 'empty'));
  }
  private nearBottom(): boolean {
    const box = this.el('codex-messages'); if (!box) return false;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 96;
  }
  private scrollToBottom(): void { const box = this.el('codex-messages'); if (box) box.scrollTop = box.scrollHeight; }

  // ---- Model and reasoning choice (per tab; the last choice is remembered for new chats) ----
  private readChoice(): { model: string; effort: string } {
    if(this.lastChoice)return {...this.lastChoice};
    try {
      const value = record(JSON.parse(this.storage?.getItem(this.profile.keys.choice) ?? 'null'));
      return { model: text(value?.model, 128), effort: text(value?.effort, 64) };
    } catch { return { model: '', effort: '' }; }
  }
  private saveChoice(tab: Tab): void {
    this.lastChoice={model:tab.model,effort:tab.effort};
    this.preferenceEdits++;this.queueNativePreferences();
    try { this.storage?.setItem(this.profile.keys.choice, JSON.stringify({ model: tab.model, effort: tab.effort })); } catch { /* Only the remembered choice is lost. */ }
  }
  private applyDefaultsTo(tab: Tab): void {
    const models = this.models(), efforts = this.efforts();
    if (!models.length) return;
    if(this.preferenceStore?.available()&&((tab.model&&!models.includes(tab.model))||(tab.effort&&!efforts.includes(tab.effort)))) {
      if(tab.key===this.activeKey)this.notice='Your previous model or reasoning choice is unavailable. Choose a reported option to continue.';
      return;
    }
    if(tab.key===this.activeKey&&this.notice==='Your previous model or reasoning choice is unavailable. Choose a reported option to continue.')this.notice='';
    if (!models.includes(tab.model)) tab.model = this.state?.defaultModel && models.includes(this.state.defaultModel) ? this.state.defaultModel : models[0]!;
    if (!efforts.includes(tab.effort)) tab.effort = efforts.includes(this.profile.defaultEffort) ? this.profile.defaultEffort : efforts[0] ?? '';
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
    const popover = this.el('codex-model-popover');
    if (popover && loopPickerFocus(popover, key)) return; // Tab stays inside the open picker.
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
      const label = name ? this.profile.name + ' model: ' + name.short + ' (' + (name.id === model ? model : model + ', ' + name.id) + ')' + (effort ? ', reasoning: ' + claudeEffortLabel(effort) : '') : 'Choose ' + this.profile.name + ' model and reasoning';
      trigger.setAttribute('aria-label', label); trigger.title = label;
    }
    const p = this.profile;
    set('codex-model-picker-status', !this.bridge ? p.noBridgeText : !this.ready() ? 'Sign in to ' + p.engine + ' to choose a model.' :
      !models.length ? p.engine + ' reported no models.' : name ? p.name + ' · ' + name.short + ' · reasoning ' + (effort || 'not chosen') : 'Choose a ' + p.name + ' model.');
    if (!enabled && this.pickerOpen()) this.closePicker();
    if (!this.pickerOpen()) return;
    const search = this.el<HTMLInputElement>('codex-model-search');
    const query = (search?.value ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const host = this.el('codex-model-options');
    if (host) {
      const focusModel = (this.doc.activeElement as HTMLElement | null)?.dataset?.pickerModel;
      const rows = models.filter(item => { const label = this.modelLabel(item); return query.every(word => (label.full + ' ' + item + ' ' + label.id).toLocaleLowerCase().includes(word)); });
      const own: HTMLElement[] = [];
      for (const item of rows) {
        const row = this.make('button', undefined, 'picker-model-option'); row.type = 'button';
        row.dataset.pickerModel = item; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(item === model));
        row.tabIndex = item === (rows.includes(model) ? model : rows[0]) ? 0 : -1;
        const label = this.modelLabel(item);
        row.title = (label.id === item ? item : item + ' → ' + label.id) + (item === this.state?.defaultModel ? ' · ' + p.engine + ' default' : '');
        row.append(this.make('span', label.short));
        const detail = this.modelDetail(item); if (detail) row.append(this.make('small', detail, 'picker-model-detail'));
        row.append(composerPickerCheck(this.doc, item === model));
        row.addEventListener('click', () => { if (this.active && this.pickerOpen()) this.chooseModel(item); });
        own.push(row);
      }
      // The other provider's section: choosing there switches provider explicitly through the cross-provider link.
      const others = crossProviderColumns(this.doc, this.crossProvider, query, (id, provider) => { if (this.active && this.pickerOpen()) { this.closePicker(); this.crossProvider?.choose(id, provider); } });
      const note = this.columnNote();
      fillModelColumns(this.doc, host, { provider: p.provider, label: p.name, rows: own, empty: models.length ? 'No matching models' : 'No models reported', ...(note ? { note } : {}) }, others, query);
      const empty = this.el('codex-model-empty');
      if (empty) { empty.hidden = others.length > 0 || rows.length > 0; empty.textContent = models.length ? 'No ' + p.name + ' models match your search.' : p.engine + ' reported no models.'; }
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
    const hint = this.el('codex-picker-effort-hint'); if (hint) hint.textContent = efforts.length ? 'Reasoning levels reported by ' + p.engine + '.' : p.engine + ' reported no reasoning levels.';
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
    if (reset) { reset.disabled = !efforts.includes(p.defaultEffort) || effort === p.defaultEffort; reset.setAttribute('aria-label', 'Use the standard reasoning level (' + claudeEffortLabel(p.defaultEffort) + ')'); }
    this.positionPicker();
  }

  // ---- Tabs strip and Saved chats (same markup as the Codex chat tabs) ----
  private restoreTabs(): void {
    try {
      const value = record(JSON.parse(this.storage?.getItem(this.profile.keys.tabs) ?? 'null'));
      if (!value || value.version !== 1 || !Array.isArray(value.open)) return;
      const ids = [...new Set(value.open.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256))].slice(0, CLAUDE_CHAT_TAB_LIMIT);
      for (const id of ids) this.createTab(id);
      const active = this.tabs.find(tab => tab.conversationId === value.active);
      this.activeKey = active?.key ?? this.tabs[0]?.key ?? null;
    } catch { /* Presentation storage is optional. */ }
  }

  private nativePreferenceSnapshot():ClaudePreferenceSnapshot|null {
    const project=this.preferenceStore?.projectPath;if(!project)return null;
    return {version:1,projectPath:project,provider:'claude',activeTabId:this.activeKey,tabs:this.tabs.map(tab=>({
      localId:tab.key,title:Array.from(this.tabTitle(tab).replace(/[\x00-\x1f\x7f]/g,' ')).slice(0,100).join(''),provider:'claude',threadId:tab.conversationId,sessionId:null,
      draft:tab.draft,modelId:tab.model||null,effort:tab.effort||null,tool:'all',previewOpen:false,
    }))};
  }
  private queueNativePreferences():void {
    if(this.nativeHydrating||this.nativeDisposed||this.nativeDeferred.length)return;
    const projectPath=this.preferenceStore?.projectPath;if(!projectPath)return;
    const rows=this.tabs.map(tab=>({key:tab.key,conversationId:tab.conversationId,model:tab.model,effort:tab.effort,draft:tab.draft,title:this.tabTitle(tab)})),previous=this.nativeQueuedView;
    if(previous&&previous.projectPath===projectPath&&previous.active===this.activeKey&&previous.rows.length===rows.length&&rows.every((row,index)=>(['key','conversationId','model','effort','draft','title'] as const).every(key=>row[key]===previous.rows[index]![key])))return;
    const value=this.nativePreferenceSnapshot();if(!value)return;
    try{this.preferenceStore?.queue(value);this.nativeQueuedView={projectPath,active:this.activeKey,rows};}catch{this.notice='Claude chat preferences could not be saved. Keep this window open and try again.';}
  }
  private loadNativePreferences():Promise<void> {
    const store=this.preferenceStore;if(!store||this.nativeDisposed)return Promise.resolve();if(this.nativeReading)return this.nativeReading;
    const revision=this.preferenceEdits,preserveLocal=this.preferenceEdits>0||this.tabs.some(tab=>tab.draft.length>0);this.nativeHydrating=true;
    this.nativeReading=(async()=>{
      let restored=false;
      try{
        const saved=await store.read();if(this.nativeDisposed)return;
        this.saveDraft();
        if(saved){
          const tabs:Tab[]=saved.tabs.map(row=>({key:row.localId,conversationId:row.threadId,model:row.modelId??'',effort:row.effort??'',draft:row.draft,title:row.title}));
          if(!preserveLocal&&revision===this.preferenceEdits&&!this.turn){this.tabs=tabs;this.activeKey=saved.activeTabId;restored=true;}
          else for(const tab of tabs){
            const existing=this.tabs.find(row=>row.key===tab.key||tab.conversationId!==null&&row.conversationId===tab.conversationId);
            if(existing&&existing.draft===tab.draft)continue;
            if(existing){if(!tab.draft)continue;tab.key=this.nextTabKey();tab.conversationId=null;tab.title='Recovered draft';}
            if(this.tabs.length<CLAUDE_CHAT_TAB_LIMIT)this.tabs.push(tab);else this.nativeDeferred.push(tab);
          }
          if(!this.tabs.length)this.createTab(null);if(!this.activeTab())this.activeKey=this.tabs[0]!.key;
        }
      }catch{if(!this.nativeDisposed)this.notice='Claude chat preferences could not be saved. Keep this window open and try again.';}
      finally{
        if(!this.nativeDisposed){
          this.nativeHydrating=false;this.applyDefaults();
          if(restored&&this.activeTab())this.saveChoice(this.activeTab()!);
          if(this.nativeDeferred.length)this.notice='Close a chat tab to load the remaining saved drafts. Keep this window open until they are loaded.';
          this.queueNativePreferences();if(restored&&this.active&&!this.turn)void this.showTab(this.activeKey!);this.render();
        }
      }
    })().finally(()=>{this.nativeReading=null;});return this.nativeReading;
  }
  private nextTabKey():string {let key:string;do{key=this.profile.tabPrefix+(++this.tabSeq);}while(this.tabs.some(tab=>tab.key===key)||this.nativeDeferred.some(tab=>tab.key===key));return key;}
  private restoreDeferredPreferences():void {
    while(this.nativeDeferred.length&&this.tabs.length<CLAUDE_CHAT_TAB_LIMIT)this.tabs.push(this.nativeDeferred.shift()!);
    if(!this.nativeDeferred.length&&this.notice?.startsWith('Close a chat tab to load'))this.notice='';
  }
  async readyForRuntimeRecovery():Promise<void> { await this.queueJournal.ready();if((this.queue.length||this.queueEmptyCheckpoint)&&this.profile.provider==='claude'&&!this.queueJournal.available(this.queueProject()))throw new Error('Saved queued messages could not be read.');if(this.nativeReading)await this.nativeReading;if(this.preferenceStore?.error())throw new Error('Saved chat drafts could not be read.'); }
  async prepareForRuntimeRecovery():Promise<void> {
    if(this.active){const attachments=this.attachments.controller();if(attachments&&(attachments.prepareReferences().length||attachments.prepareText('')))throw new Error('Send or remove your attachments before restarting.');}
    this.returnQueue();
    await this.queueJournal.ready();
    if((this.queue.length||this.queueEmptyCheckpoint)&&this.profile.provider==='claude'){
      const saved=await this.queueSave(true);if(!saved||this.queueEmptyCheckpoint)throw new Error('Queued messages could not be saved. Keep this window open.');
    }
    if(this.nativeReading)await this.nativeReading;
    if(this.preferenceStore&&!this.preferenceStore.available())await this.loadNativePreferences();
    this.saveDraft();this.persistTabs();
    if(this.nativeDeferred.length)throw new Error('Load the remaining saved drafts before restarting. Keep this window open.');
    const value=this.nativePreferenceSnapshot();
    if(value&&this.preferenceStore?.available()){await this.preferenceStore.flush(value);return;}
    if(this.tabs.some(tab=>tab.draft.length))throw new Error('Send or clear your unsent drafts before restarting. Keep this window open.');
  }

  async prepareForRestart():Promise<void> {
    if(this.turn)throw new Error('Finish or stop the current chat before restarting.');
    if(this.active){const tab=this.activeTab(),input=this.input();if(tab&&input)tab.draft=input.value;
      const attachments=this.attachments.controller();
      if(attachments&&(attachments.prepareReferences().length||attachments.prepareText('')))throw new Error('Send or remove your attachments before restarting.');
    }
    await this.prepareForRuntimeRecovery();
  }
  private persistTabs(): void {
    this.queueNativePreferences();
    try {
      this.storage?.setItem(this.profile.keys.tabs, JSON.stringify({ version: 1,
        open: this.tabs.map(tab => tab.conversationId).filter((id): id is string => !!id), active: this.activeTab()?.conversationId ?? null }));
    } catch { /* Only the remembered tabs are lost. */ }
  }
  private tabTitle(tab: Tab): string {
    if(tab.title&&!tab.conversationId)return tab.title;
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
      prependProviderLogo(this.doc, button, this.profile.provider); // Tabs lead with the provider's mark; the text still names the chat.
      button.title = tab.conversationId ? this.tabTitle(tab) + ' · ' + this.profile.name : 'New ' + this.profile.name + ' chat';
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
    const focus = chatSwitchFocus(this.doc, menu), active = this.activeTab();
    // Same switcher as the ChatGPT tabs: on narrow layouts the strip is hidden and this sheet lists open chats and New chat.
    const rows: HTMLElement[] = [chatSwitchSummary(this.doc, active ? this.tabTitle(active) : 'Saved chats', this.profile.provider),
      chatSwitchOpenSection(this.doc, menu, this.tabs.map(tab => ({ key: tab.key, label: this.tabTitle(tab), current: tab.key === this.activeKey,
        selectDisabled: sending && tab.key !== this.activeKey, closeDisabled: sending && this.turn?.tabKey === tab.key })), {
        select: key => { if (this.active) this.selectTab(key); }, close: key => { if (this.active) this.closeTab(key); },
        newChat: () => { if (this.active) this.el<HTMLButtonElement>('workspace-new-chat')?.click(); }, newDisabled: sending })];
    for (const row of sortConversations(this.conversations)) {
      const button = this.make('button', row.title || 'Untitled chat'); button.type = 'button';
      button.dataset.conversationId = row.conversationId; button.setAttribute('aria-current', String(row.conversationId === current));
      const name = row.model ? this.modelLabel(row.model).full : '';
      button.title = [name, row.effort, row.updatedAt].filter(Boolean).join(' · ');
      button.disabled = sending || !this.bridge;
      button.addEventListener('click', () => { if (!this.active) return; menu.open = false; void this.open(row.conversationId); });
      rows.push(button);
    }
    if (!this.conversations.length) rows.push(this.make('p', this.listed ? 'No saved ' + this.profile.name + ' chats.' : 'Saved ' + this.profile.name + ' chats have not been read.'));
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
    restoreChatSwitchFocus(menu, focus);
  }

  private statusText(): string {
    const { name, engine } = this.profile;
    if (!this.bridge) return this.profile.noBridgeText;
    if (this.statusError) return this.statusError;
    if (!this.state) return this.refreshing ? 'Checking ' + engine + '…' : engine + ' status has not been read.';
    if (!this.state.installed) return this.state.message ?? 'Install ' + engine + ' to chat with ' + name + '.';
    if (!this.state.signedIn) return this.state.message ?? 'Sign in to ' + engine + ' to chat with ' + name + '.';
    if (!this.models().length || !this.efforts().length) return this.state.message ?? engine + ' reported no model or reasoning choices. Update ' + engine + ', then reopen the chat.';
    if (this.turn && this.notice && this.turn.turnId !== null && !this.turn.stopping) return this.notice;
    if (this.turn) {
      const waiting = this.queue.filter(item => item.tabKey === this.activeKey).length;
      const queued = (waiting ? ' ' + waiting + (waiting === 1 ? ' message' : ' messages') + ' queued.' : '') +
        (this.canSteer() ? ' ' + CLAUDE_CHAT_STEER_HINT + '.' : waiting ? '' : ' Press Enter to queue your next message.');
      return this.turn.turnId === null ? 'Sending…' : this.turn.stopping ? 'Stopping…' : (this.turnOwnsActiveTab() ? name + ' is working…' : name + ' is replying in another chat.') + queued;
    }
    return this.notice || 'Continue in this conversation.';
  }

  private renderControls(): void {
    const input = this.input(), submit = this.el<HTMLButtonElement>('codex-submit');
    const ready = this.ready(), turn = this.turn, stopMode = this.turnOwnsActiveTab();
    if (input) input.disabled = !ready||this.nativeHydrating;
    this.steerHint(this.canSteer());
    if (submit) {
      submit.type = stopMode ? 'button' : 'submit';
      const state = stopMode ? 'active' : 'idle';
      if (submit.dataset.taskState !== state) {
        submit.dataset.taskState = state; submit.setAttribute('aria-label', stopMode ? 'Stop task' : 'Send message');
        const path = submit.querySelector?.('svg path'); path?.setAttribute('d', stopMode ? STOP_PATH : SEND_PATH); path?.setAttribute('fill', stopMode ? 'currentColor' : 'none');
      }
      const controls = submit.closest?.<HTMLElement>('.composer-controls'); if (controls) controls.dataset.taskActive = String(stopMode);
      submit.disabled = this.nativeHydrating||this.preparingSend|| (stopMode ? !turn?.turnId || turn.stopping : !!this.queueEnqueue || !this.canSend() || !!turn || this.rewinding || !(input?.value.trim()));
    }
    const create = this.el<HTMLButtonElement>('workspace-new-chat'); if (create) create.disabled = !!turn && turn.turnId === null;
  }

  private render(): void {
    this.publishTranscript();
    if (!this.active) return;
    this.queueNativePreferences();
    if (this.claimed) this.claimAttachments();
    const notice = this.el('claude-chat-notice'); if (notice) notice.textContent = this.statusText();
    const status = this.el('claude-chat-status');
    if (status) status.textContent = !this.bridge ? 'Unavailable' : this.turn ? 'Working' : this.ready() ? this.readyLabel() : this.state ? 'Not signed in' : 'Checking';
    const box = this.el('codex-messages');
    if (box) { box.setAttribute('aria-busy', String(this.loading || !!this.turn)); if (this.messageCount === 0 && !box.querySelector?.('.empty')) this.clearMessages(); }
    this.markTurnLive();
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
      host = this.make('div', undefined, 'queue-strip'); host.id = QUEUE_ID;
      host.setAttribute('role', 'list'); host.setAttribute('aria-label', 'Queued messages');
      form.prepend(host);
    }
    if (!host) return;
    if(this.queueAfterTurn&&this.queueChoice!==this.queueSelection())this.pauseQueue('Model or conversation changed. Choose Send next to resume.');
    if(this.profile.provider==='claude'&&(this.queue.length||this.queueEmptyRenderPending)&&!this.queueEnqueue&&!this.queueSending&&!this.queueSteering&&this.queueJournal.available(this.queueProject()))void this.queueSave();
    const scope=this.queueScope(),gesture=this.queueGesture(),items=this.queue.filter(item=>item.scope===scope);
    renderChatQueueStrip(this.doc,host,items,{active:this.active,busy:!!this.queueEnqueue,scope,gesture,canSteer:this.canSteer(),steerReason:this.canSteer()?'Guide the current reply with this message.':'Steering is available only for this chat’s active reply.',
      canSendNext:this.ready()&&!this.rewinding&&!this.queueSteering&&!this.queueSending&&(!this.turn||this.turnOwnsActiveTab()),action:(action,item,text)=>this.queueAction(action,item,gesture,text)});
    for(const old of Array.from(host.querySelectorAll('.queue-persistence-notice')))old.remove();
    const saveNotice=this.profile.provider==='claude'?this.queueJournal.notice():null;if(saveNotice&&items.length){const note=this.make('p',saveNotice,'queue-persistence-notice');note.setAttribute('role','status');host.append(note);}
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
      meter.append(ring as unknown as HTMLElement, this.make('span', '', 'usage-meter-count'), this.make('span', '', 'usage-meter-cost'));
      controls.prepend(meter);
    }
    if (!meter) return;
    const usage = this.conversationUsage();
    meter.hidden = !this.active || !usage;
    if (!usage) return;
    const display = this.costDisplay(), total = usage.inputTokens + usage.outputTokens, label = usageMeterText(usage, display);
    meter.setAttribute('aria-label', label); meter.title = label;
    const count = meter.querySelector?.<HTMLElement>('.usage-meter-count'); if (count) count.textContent = compactTokens(total);
    const cost = meter.querySelector?.<HTMLElement>('.usage-meter-cost');
    if (cost) { const shown = usage.costUsd !== null && display.preferences.show; cost.textContent = shown ? formatUsageCost(usage.costUsd!, display.preferences, display.locale) : ''; cost.hidden = !shown; }
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
  showConversationNotice?(message:string):void;
}
/** Provider setup's side: which provider owns the surface, and an explicit provider choice. */
export interface ChatProviderSwitch {
  chatSurface(): ComposerProvider;
  subscribeChatSurface(listener: () => void): () => void;
  /** `hint.signedIn`: the chosen provider's own fresh status lists models (presentation only; see provider-setup). */
  requestProvider(next: ComposerProvider, hint?: { signedIn?: boolean }): boolean;
}
export interface ChatProviderLink {
  /** Applies the current surface owner: Codex yields and Claude activates, or the reverse. Idempotent. */
  sync(): void;
  stop(): void;
  /** Adds (or removes) the Arcane Credits chat as a third provider; it loads after the workspace. */
  setArcane(chat: ClaudeChat | null): void;
}
const HANDOFF_MS = 120000;
const PROVIDER_NAMES: Record<ComposerProvider, string> = { codex: 'ChatGPT', claude: 'Claude', arcane: 'Arcane Credits' };
/** Reported reset time in the viewer's locale: time only today, weekday and time otherwise. */
export { formatUsageReset };
/** The composer notice sentence for one provider's usage limit (for Arcane Credits: the balance ran out). */
export function usageLimitNoticeText(provider: ComposerProvider, limit: ProviderUsageLimit, now = Date.now()): string {
  if (provider === 'arcane') return 'You’re out of Arcane Credits.';
  const name = PROVIDER_NAMES[provider], kind = limit.window === 'weekly' ? ' weekly limit' : limit.window === 'session' ? ' session limit' : ' usage limit';
  if (limit.resetsAt === null) return name + kind + ' reached. Try again later or switch model.';
  if (!usageLimitActive(limit, now)) return name + kind + ' should have reset by now. Retry when you’re ready.';
  return name + kind + ' reached — resets at ' + formatUsageReset(limit.resetsAt, now) + '.';
}
/** Ids of the inline usage-limit notice above the shared composer (studio.html): one main action, Arcane Credits, Retry. */
export const USAGE_LIMIT_NOTICE_IDS = Object.freeze({ root: 'usage-limit-notice', message: 'usage-limit-message', action: 'usage-limit-action',
  credits: 'usage-limit-credits', retry: 'usage-limit-retry' });
/** Settings section the out-of-credits notice opens (plans.ts PLANS_SECTION_ID). */
const PLANS_SECTION = 'settings-plans';
/**
 * Links the Codex and Claude chats (and, once connected, the Arcane Credits chat) that share one composer: each model
 * list shows every provider's models, and choosing another provider's model requests that provider explicitly through
 * provider setup. When the surface actually switches, the unsent composer text moves with it and the chosen model is
 * selected with the current effort when the new provider supports it. A switch never sends a message or starts a turn.
 */
export function linkChatProviders(options: { codex: CodexComposerPeer; claude: ClaudeChat; arcane?: ClaudeChat | null; provider: ChatProviderSwitch; enabled?: () => boolean;
  beforeProviderSwitch?:(from:ComposerProvider,to:ComposerProvider)=>Promise<boolean>|boolean }): ChatProviderLink {
  const { codex, claude, provider } = options;
  let arcane: ClaudeChat | null = options.arcane ?? null;
  let pending: { target: ComposerProvider; model: string | null; effort: string | null; at: number } | null = null;
  let current: ComposerProvider | null = null, stopped = false;
  let preparingSwitch=false,switchGeneration=0;
  const removers: (() => void)[] = [];
  let arcaneRemovers: (() => void)[] = [];
  const chatOf = (target: ComposerProvider | null): ClaudeChat | null => target === 'claude' ? claude : target === 'arcane' ? arcane : null;
  const chats = (): ClaudeChat[] => arcane ? [claude, arcane] : [claude];
  const request = async (target: ComposerProvider, model: string, effort: string | null) => {
    if (stopped||preparingSwitch) return;
    const source=provider.chatSurface(),generation=switchGeneration;
    if(source!==target&&options.beforeProviderSwitch){
      preparingSwitch=true;
      let allowed=false;
      try{allowed=await options.beforeProviderSwitch(source,target);}catch{/* The source conversation stays selected. */}
      finally{preparingSwitch=false;}
      if(stopped||generation!==switchGeneration||provider.chatSurface()!==source)return;
      if(!allowed){const message='This conversation could not be switched. Your current chat, model and draft are retained.';
        if(source==='codex')codex.showConversationNotice?.(message);else chatOf(source)?.showConversationNotice(message);return;}
    }
    pending = { target, model: model || null, effort, at: Date.now() };
    if (provider.chatSurface() === target) { sync(); return; }
    let signedIn = false;
    try { signedIn = !!(target === 'codex' ? codex.modelGroup() : chatOf(target)?.modelGroup())?.available; } catch { signedIn = false; }
    if (!(signedIn ? provider.requestProvider(target, { signedIn: true }) : provider.requestProvider(target))) pending = null;
  };
  /** Every provider's section except the owner's, in display order; Arcane only while its chat reports one. */
  const groupsFor = (owner: ComposerProvider): ComposerModelGroup[] => [owner === 'codex' ? null : codex.modelGroup(), owner === 'claude' ? null : claude.modelGroup(),
    owner === 'arcane' || !arcane ? null : arcane.modelGroup()].filter((group): group is ComposerModelGroup => !!group);
  const loadAll = (from: ComposerProvider, redraw: () => void) => {
    const loading = Promise.all(chats().filter(chat => chat !== chatOf(from)).map(chat => chat.loadModels()));
    redraw(); void loading.then(redraw, () => {});
  };
  const wire = () => {
    codex.setCrossProviderModels({
      group: () => claude.modelGroup(), ...(arcane ? { groups: () => groupsFor('codex') } : {}),
      choose: (model, target = 'claude') => request(target, model, codex.currentEffort()),
      opened: () => loadAll('codex', () => codex.crossProviderChanged()),
    });
    claude.setCrossProviderModels({ group: () => codex.modelGroup(), ...(arcane ? { groups: () => groupsFor('claude') } : {}),
      choose: (model, target = 'codex') => request(target, model, claude.currentEffort()) });
    const chat = arcane;
    chat?.setCrossProviderModels({ group: () => codex.modelGroup(), groups: () => groupsFor('arcane'), choose: (model, target = 'codex') => request(target, model, chat.currentEffort()) });
  };
  wire();
  removers.push(claude.subscribeModels(() => { codex.crossProviderChanged(); arcane?.crossProviderChanged(); }));
  if (codex.subscribeStateChange) removers.push(codex.subscribeStateChange(() => { claude.crossProviderChanged(); arcane?.crossProviderChanged(); }));
  const sync = () => {
    const live = !stopped && (options.enabled?.() ?? true), surface = provider.chatSurface();
    const next: ComposerProvider = !live ? 'codex' : surface === 'claude' ? 'claude' : surface === 'arcane' && arcane ? 'arcane' : 'codex';
    const fresh = pending && Date.now() - pending.at <= HANDOFF_MS ? pending : null;
    // Only a real switch toward the provider the user picked carries the draft and model; startup, resume and
    // Settings changes keep each provider's own draft.
    const carry = live && current !== null && current !== next && fresh?.target === next ? fresh : null;
    if (carry || !fresh) pending = null;
    try {
      const previous = chatOf(current), target = chatOf(next);
      if (target) {
        const draft = carry ? (previous ? previous.takeComposerDraft() : codex.takeComposerDraft()) : '';
        for (const chat of chats()) if (chat !== target) chat.deactivate();
        codex.yieldSurface(true); target.activate(); void target.refresh();
        if (carry) target.receiveHandoff({ draft, model: carry.model, effort: carry.effort });
      } else {
        const draft = carry && previous ? previous.takeComposerDraft() : '';
        for (const chat of chats()) chat.deactivate();
        codex.yieldSurface(false);
        if (carry) codex.receiveHandoff({ draft, model: carry.model, effort: carry.effort });
      }
    } catch { /* A surface hand-off is presentation only and cannot break the workspace. */ }
    current = live ? next : null;
    renderNotice();
  };
  // ---- Usage-limit notice: one inline notice above the composer for the provider that owns the surface. ----
  // It offers another provider in one click (the same explicit, draft-carrying switch as the model list), its sign-in,
  // Arcane Credits when they are set up, or, when Arcane Credits ran out, Buy credits (opens Settings > Plans & credits).
  // Retry appears only once the reported reset time has passed and sends the visible draft on that click. Nothing here
  // retries, resends or switches by itself.
  const doc = claude.doc;
  type NoticeAction = { kind: 'switch' | 'setup' | 'buy'; target: ComposerProvider };
  let action: NoticeAction | null = null, credits = false, retry = false, claudeStatusRequested = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  const node = (id: string) => { try { return doc?.getElementById?.(id) ?? null; } catch { return null; } };
  const limitOf = (owner: ComposerProvider): ProviderUsageLimit | null => owner === 'codex' ? codex.usageLimit?.() ?? null : chatOf(owner)?.usageLimit() ?? null;
  const renderNotice = () => {
    const root = node(USAGE_LIMIT_NOTICE_IDS.root), message = node(USAGE_LIMIT_NOTICE_IDS.message), button = node(USAGE_LIMIT_NOTICE_IDS.action) as HTMLButtonElement | null;
    if (resetTimer !== null) { clearTimeout(resetTimer); resetTimer = null; }
    if (!root) return;
    let text = '', next: NoticeAction | null = null, label = '', offerCredits = false, offerRetry = false, resetsAt: number | null = null;
    try {
      const live = !stopped && (options.enabled?.() ?? true), owner: ComposerProvider = live && current ? current : 'codex';
      const limit = live ? limitOf(owner) : null, now = Date.now();
      if (limit) {
        text = usageLimitNoticeText(owner, limit, now);
        const arcaneGroup = arcane?.modelGroup() ?? null, waiting = usageLimitActive(limit, now);
        if (waiting && limit.resetsAt !== null) resetsAt = limit.resetsAt;
        // Retry only after the reported reset: the account should have usage again.
        offerRetry = owner !== 'arcane' && !waiting;
        if (owner === 'arcane') { next = { kind: 'buy', target: 'arcane' }; label = 'Buy credits'; text += ' This message was not answered; your draft stays here.'; }
        else if (owner === 'codex') {
          const group = claude.modelGroup(), claudeLimited = usageLimitActive(claude.usageLimit());
          // Claude's sign-in is read once so the notice can offer the switch instead of the sign-in.
          if (group && !group.available && !claudeStatusRequested) { claudeStatusRequested = true; void claude.loadModels().catch(() => {}); }
          if (group?.available && !claudeLimited) { next = { kind: 'switch', target: 'claude' }; label = 'Switch to Claude'; text += ' Your draft moves with you.'; offerCredits = !!arcaneGroup?.available; }
          else if (arcaneGroup?.available) { next = { kind: 'switch', target: 'arcane' }; label = 'Use Arcane Credits'; text += claudeLimited ? ' Claude is also at its usage limit. Your draft moves with you.' : ' Your draft moves with you.'; }
          else if (claudeLimited) text += ' Claude is also at its usage limit.';
          else if (claude.available()) { next = { kind: 'setup', target: 'claude' }; label = 'Sign in to Claude'; text += ' Your draft stays here.'; }
        } else {
          const group = codex.modelGroup(), codexLimited = usageLimitActive(codex.usageLimit?.());
          if (group.available && !codexLimited) { next = { kind: 'switch', target: 'codex' }; label = 'Switch to ChatGPT'; text += ' Your draft moves with you.'; offerCredits = !!arcaneGroup?.available; }
          else if (arcaneGroup?.available) { next = { kind: 'switch', target: 'arcane' }; label = 'Use Arcane Credits'; text += codexLimited ? ' ChatGPT is also at its usage limit. Your draft moves with you.' : ' Your draft moves with you.'; }
          else text += codexLimited ? ' ChatGPT is also at its usage limit.' : ' Your draft stays here.';
        }
        // Past the reset Retry leads; a sign-in offer is no longer needed.
        if (offerRetry && next?.kind === 'setup') next = null;
      }
    } catch { text = ''; next = null; offerCredits = false; offerRetry = false; resetsAt = null; }
    action = next; credits = offerCredits; retry = offerRetry;
    root.hidden = !text; root.dataset.provider = text ? (current ?? 'codex') : '';
    if (text) root.dataset.state = retry ? 'reset' : 'limited'; else delete root.dataset.state;
    if (message && message.textContent !== text) message.textContent = text;
    if (button) { button.hidden = !next; button.disabled = !next; if (button.textContent !== label) button.textContent = label; button.className = next?.kind === 'setup' || retry ? 'secondary' : ''; }
    const creditsButton = node(USAGE_LIMIT_NOTICE_IDS.credits) as HTMLButtonElement | null;
    if (creditsButton) { creditsButton.hidden = !credits; creditsButton.disabled = !credits; }
    const retryButton = node(USAGE_LIMIT_NOTICE_IDS.retry) as HTMLButtonElement | null;
    if (retryButton) { retryButton.hidden = !retry; retryButton.disabled = !retry; }
    // Redraw once at the reported reset so Retry appears then; the redraw never sends anything.
    if (resetsAt !== null && !stopped) resetTimer = setTimeout(() => { resetTimer = null; renderNotice(); }, Math.min(2147483000, Math.max(1000, resetsAt * 1000 - Date.now() + 1000)));
  };
  const effortNow = () => current === 'codex' || !current ? codex.currentEffort() : chatOf(current)?.currentEffort() ?? null;
  const bind = (id: string, press: () => void) => {
    const button = node(id); if (!button) return;
    const handler = () => { if (!stopped) press(); };
    button.addEventListener('click', handler);
    removers.push(() => button.removeEventListener('click', handler));
  };
  bind(USAGE_LIMIT_NOTICE_IDS.action, () => {
    const chosen = action; if (!chosen) return;
    const Event = doc?.defaultView?.CustomEvent;
    if (chosen.kind === 'buy') { if (Event) doc.dispatchEvent(new Event('workspace:settingsrequest', { detail: { target: PLANS_SECTION } })); return; }
    if (chosen.kind === 'switch') { request(chosen.target, '', effortNow()); return; }
    // Sign-in: choose Claude explicitly (so a later switch still carries the draft) and open provider setup.
    request(chosen.target, '', null);
    if (Event) doc.dispatchEvent(new Event('workspace:providersetup', { detail: { provider: chosen.target } }));
  });
  bind(USAGE_LIMIT_NOTICE_IDS.credits, () => { if (credits && arcane?.modelGroup()?.available) request('arcane', '', effortNow()); });
  bind(USAGE_LIMIT_NOTICE_IDS.retry, () => {
    if (!retry) return;
    const owner = current ?? 'codex', input = node('codex-composer') as HTMLTextAreaElement | null, form = node('codex-compose') as HTMLFormElement | null;
    // The reset passed, so the old evidence no longer applies. The visible draft is sent only by this click.
    chatOf(owner)?.clearUsageLimit();
    renderNotice();
    try { if (input?.value.trim() && typeof form?.requestSubmit === 'function') form.requestSubmit(); else if (typeof input?.focus === 'function') input.focus(); } catch { /* The draft stays for a manual send. */ }
  });
  removers.push(claude.subscribeUsageLimit(renderNotice), claude.subscribeModels(renderNotice));
  if (codex.subscribeStateChange) removers.push(codex.subscribeStateChange(renderNotice));
  removers.push(provider.subscribeChatSurface(sync));
  const attachArcane = () => {
    for (const remove of arcaneRemovers.splice(0)) remove();
    const chat = arcane; if (!chat) return;
    arcaneRemovers = [chat.subscribeUsageLimit(renderNotice), chat.subscribeModels(() => { codex.crossProviderChanged(); claude.crossProviderChanged(); renderNotice(); })];
  };
  attachArcane();
  sync();
  return {
    sync() { stopped = false; sync(); },
    stop() { stopped = true;switchGeneration++; pending = null; current = null; renderNotice(); },
    setArcane(chat: ClaudeChat | null) {
      if (chat === arcane) return;
      const previous = arcane;
      if (previous) { previous.setCrossProviderModels(null); if (current === 'arcane') previous.deactivate(); }
      arcane = chat; wire(); attachArcane();
      codex.crossProviderChanged(); claude.crossProviderChanged();
      if (current === 'arcane' || provider.chatSurface() === 'arcane') sync(); else renderNotice();
    },
  };
}
