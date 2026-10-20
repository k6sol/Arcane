/// <reference lib="dom" />
// Arcane Credits chat controller. Models come from the user's Arcane gateway and replies are paid with Arcane Credits;
// the desktop host (apps/desktop/electron/arcane-chat.cjs) runs the tool loop and streams events in the Claude chat
// bridge's shape, so this controller IS the Claude chat controller with the Arcane profile: same tabs, transcript,
// composer, queue, edit and picker, plus credit prices per model, the balance, and a Buy credits notice when it runs out.
// It talks only to `window.arcaneDesktop.arcaneChat` and writes model output with textContent only.
import { ClaudeChat, type ChatProfile, type ClaudeChatBridge, type ClaudeChatOptions, type ClaudeChatStatus } from './claude-chat.js';
import type { ComposerModelGroup } from './codex-chat.js';
import { compactTokenCount } from './task-usage.js';

export interface ArcaneModelPricing { inputPerMTok: number; outputPerMTok: number }
export interface ArcaneModel { id: string; label: string; pricing: ArcaneModelPricing | null }
export interface ArcaneBalance { credits: number; actionsRemaining: number | null; plan: string | null }
export type ArcaneChatState = 'disabled' | 'signed-out' | 'error' | 'ready';
/** The host's status: `available` is false (and nothing was requested) until a gateway is configured and an account connected. */
export interface ArcaneChatStatus {
  available: boolean; state: ArcaneChatState; models: ArcaneModel[]; efforts: string[]; defaultModel: string | null;
  balance: ArcaneBalance | null; message: string | null;
}

export const ARCANE_CHAT_CHOICE_KEY = 'arcane.arcane-chat.choice.v1';
/** Presentation only: which saved Arcane conversations are open as tabs. Never message text or authority. */
export const ARCANE_CHAT_TABS_KEY = 'arcane.arcane-chat.tabs.v1';
export const ARCANE_CHAT_USAGE_KEY = 'arcane.arcane-chat.usage.v1';
export const ARCANE_CHAT_EMPTY_TEXT = 'New Arcane chat. Replies use your Arcane Credits; your first message starts the conversation.';
export const ARCANE_CHAT_NO_BRIDGE_TEXT = 'Arcane chat requires the Arcane desktop app.';
/** The host's one fixed out-of-credits message (arcane-chat.cjs MESSAGES.noCredits). */
export const ARCANE_CHAT_NO_CREDITS_TEXT = 'You\'re out of Arcane Credits. This message was not answered; buy credits to continue.';
/** Gateway models have no reasoning levels; the host reports this one. */
export const ARCANE_CHAT_EFFORT = 'standard';
/** How long a status read stays fresh before opening the model list asks again (connecting an account shows up then). */
const STATUS_FRESH_MS = 30000;
const KNOWN_ERRORS: ReadonlySet<string> = new Set(['Arcane chat is unavailable.', 'Another Arcane chat reply is still running in this conversation.',
  'Too many Arcane chat replies are running. Wait for one to finish.', 'This conversation no longer exists.', 'Message is empty or too long.',
  'This message can no longer be edited.', 'Arcane Credits chat sends text only. Remove the attached images, then send.']);
const BRIDGE_KEYS = ['status', 'list', 'history', 'send', 'stop', 'remove', 'onEvent'] as const;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;

export function readArcaneChatBridge(win: unknown): ClaudeChatBridge | null {
  try {
    const root = (win as { arcaneDesktop?: unknown } | null | undefined)?.arcaneDesktop as { arcaneChat?: unknown } | undefined;
    const value = root?.arcaneChat as Record<string, unknown> | undefined;
    if (!value || typeof value !== 'object' || value.version !== 1) return null;
    return BRIDGE_KEYS.every(key => typeof value[key] === 'function') ? value as unknown as ClaudeChatBridge : null;
  } catch { return null; }
}

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const shortText = (value: unknown, max: number): string | null => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
export function readArcaneChatStatus(value: unknown): ArcaneChatStatus {
  const state = record(value);
  if (!state || typeof state.available !== 'boolean' || !['disabled', 'signed-out', 'error', 'ready'].includes(state.state as string) || !Array.isArray(state.models))
    throw Error('Arcane chat status unavailable.');
  const models: ArcaneModel[] = [];
  for (const item of state.models.slice(0, 32)) {
    const row = record(item), id = row?.id, label = shortText(row?.label, 64), pricing = record(row?.pricing);
    if (typeof id !== 'string' || !MODEL_ID.test(id) || !label || models.some(model => model.id === id)) continue;
    models.push({ id, label, pricing: pricing && count(pricing.inputPerMTok) && count(pricing.outputPerMTok) ? { inputPerMTok: pricing.inputPerMTok, outputPerMTok: pricing.outputPerMTok } : null });
  }
  const balance = record(state.balance);
  const efforts = Array.isArray(state.efforts) ? state.efforts.filter((effort): effort is string => typeof effort === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(effort)).slice(0, 4) : [];
  return {
    available: state.available, state: state.state as ArcaneChatState, models, efforts: efforts.length ? efforts : [ARCANE_CHAT_EFFORT],
    defaultModel: typeof state.defaultModel === 'string' && models.some(model => model.id === state.defaultModel) ? state.defaultModel : models[0]?.id ?? null,
    balance: balance && count(balance.credits) ? { credits: balance.credits, actionsRemaining: count(balance.actionsRemaining) ? balance.actionsRemaining : null, plan: shortText(balance.plan, 48) } : null,
    message: shortText(state.message, 512),
  };
}
const integer = (value: number) => Math.round(value).toLocaleString('en-US');
/** '1,200 credits' (one credit is singular). */
export function formatCredits(credits: number): string { return integer(credits) + (Math.round(credits) === 1 ? ' credit' : ' credits'); }
/** A model's price as the account is charged: credits per million input and output tokens, e.g. '360 in · 1.8k out per 1M tokens'. */
export function arcaneModelPriceText(pricing: ArcaneModelPricing | null): string | null {
  return pricing ? compactTokenCount(pricing.inputPerMTok) + ' in · ' + compactTokenCount(pricing.outputPerMTok) + ' out per 1M tokens' : null;
}
/** The balance line under the Arcane column heading and in the status chip. */
export function arcaneBalanceText(balance: ArcaneBalance | null): string | null {
  if (!balance) return null;
  return formatCredits(balance.credits) + ' left' + (balance.plan ? ' · ' + balance.plan + (balance.actionsRemaining !== null ? ' (' + integer(balance.actionsRemaining) + ' actions)' : '') : '');
}
/** The done notice for an Arcane reply: tokens and the credits the gateway charged. */
export function formatArcaneUsage(value: unknown): string | null {
  const usage = record(value); if (!usage) return null;
  const tokens = (count(usage.inputTokens) ? usage.inputTokens : 0) + (count(usage.outputTokens) ? usage.outputTokens : 0), credits = count(usage.credits) ? usage.credits : null;
  if (!tokens && credits === null) return null;
  return 'Done · ' + compactTokenCount(tokens) + ' tokens' + (credits !== null ? ' · ' + formatCredits(credits) : '');
}
function asClaudeStatus(status: ArcaneChatStatus): ClaudeChatStatus {
  const ready = status.available && status.state === 'ready';
  return { installed: status.available, signedIn: ready, cliVersion: null, models: ready ? status.models.map(model => model.id) : [], efforts: status.efforts,
    defaultModel: ready ? status.defaultModel : null, message: status.message, resolved: {} };
}

export class ArcaneChat extends ClaudeChat {
  private arcane: ArcaneChatStatus | null = null;
  private readAt = 0;

  constructor(doc: Document, options: Omit<ClaudeChatOptions, 'profile'> = {}) {
    // The profile's status reader keeps the Arcane-only fields (prices, balance) for this controller.
    const holder: { chat: ArcaneChat | null } = { chat: null };
    const profile: ChatProfile = {
      provider: 'arcane', name: 'Arcane', engine: 'Arcane Credits', readBridge: readArcaneChatBridge,
      readStatus: value => { const status = readArcaneChatStatus(value); if (holder.chat) { holder.chat.arcane = status; holder.chat.readAt = Date.now(); } return asClaudeStatus(status); },
      keys: { choice: ARCANE_CHAT_CHOICE_KEY, tabs: ARCANE_CHAT_TABS_KEY, usage: ARCANE_CHAT_USAGE_KEY },
      tabPrefix: 'arcane-tab-', emptyText: ARCANE_CHAT_EMPTY_TEXT, noBridgeText: ARCANE_CHAT_NO_BRIDGE_TEXT, usageLimitText: ARCANE_CHAT_NO_CREDITS_TEXT,
      knownErrors: KNOWN_ERRORS, defaultEffort: ARCANE_CHAT_EFFORT, images: false,
    };
    super(doc, { ...options, profile });
    holder.chat = this;
  }

  /** The last status read, with prices and balance (presentation only). */
  arcaneStatus(): ArcaneChatStatus | null { return this.arcane ? { ...this.arcane, models: this.arcane.models.map(model => ({ ...model })) } : null; }
  /** Connected and ready with at least one model: the Arcane column and surface may be offered. */
  usable(): boolean { return !!this.arcane && this.arcane.available && this.arcane.state === 'ready' && this.arcane.models.length > 0; }

  /** Hidden entirely (null) until a gateway is configured and an account is connected. */
  override modelGroup(): ComposerModelGroup | null {
    if (!this.arcane?.available) return null;
    const group = super.modelGroup();
    if (!group) return null;
    return this.usable() ? group : { ...group, available: false, hint: this.arcane.state === 'signed-out' ? 'Reconnect in Plans & credits' : 'Unavailable right now', models: [] };
  }
  /** Status goes stale: opening the model list re-reads it (an account connected meanwhile then shows up). */
  override loadModels(): Promise<void> {
    return this.available() && (!this.arcane || Date.now() - this.readAt >= STATUS_FRESH_MS) ? this.refresh() : Promise.resolve();
  }
  protected override modelLabel(model: string): { short: string; full: string; id: string } {
    const label = this.arcane?.models.find(row => row.id === model)?.label ?? model;
    return { short: label, full: label + ' (Arcane Credits)', id: model };
  }
  protected override modelDetail(model: string): string | null { return arcaneModelPriceText(this.arcane?.models.find(row => row.id === model)?.pricing ?? null); }
  protected override groupNote(): string | null { return arcaneBalanceText(this.arcane?.balance ?? null); }
  /** Credits, never a USD estimate: the gateway's charge is the cost. */
  protected override turnModel(_tabKey: string): string | null { return null; }
  protected override replyNotice(usage: unknown): string | null { return formatArcaneUsage(usage); }
  /** The balance changed: read it again (one shared read; it also refreshes the saved chats list). */
  protected override replyFinished(): void { this.readAt = 0; void this.refresh(); }
  protected override readyLabel(): string { return arcaneBalanceText(this.arcane?.balance ?? null) ?? 'Arcane Credits'; }
}
