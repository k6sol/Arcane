// Main-window side of the Pyx pop-out bar. It reads what the workspace already shows (composer, model chip, transcript,
// submit state) and publishes a small snapshot for the bar; it answers the bar's requests by using the main composer's
// own controls, so a Pyx instruction takes exactly the path a typed one does (send, queue or steer, per the active chat).
// It never calls a provider, never stores anything and never sends on its own.
import type { PyxBarState, PyxPhase, PyxProvider, PyxSubmitResult, PyxSuggestion } from './pyx-bar.js';
import { STARTER_PROMPTS, type StarterPrompt } from './starter-prompts.js';

export interface PyxHostSnapshot { readonly state: PyxBarState; readonly suggestions: readonly PyxSuggestion[] }
export type PyxHostRequest =
  | { readonly type: 'submit'; readonly id: string; readonly text: string }
  | { readonly type: 'stop' }
  | { readonly type: 'model-picker' };
/** Main preload: window.arcaneDesktop.pyx (preload.cjs). */
export interface PyxHostBridge {
  readonly version: 1;
  /** The perch: opens the bar when it is closed and closes it when it is open. */
  open(): Promise<unknown> | void;
  publish(snapshot: PyxHostSnapshot): void;
  onRequest(listener: (request: unknown) => void): () => void;
  answer(id: string, result: PyxSubmitResult): void;
  /** Whether the bar is open, now and on every change (the perch's aria-expanded follows it). */
  onVisibility?(listener: (open: boolean) => void): () => void;
  /** Whether the bar is open right now (asked once, after this window loads). */
  isOpen?(): Promise<boolean>;
  /** Where the composer is (viewport CSS pixels), so the bar first opens clear of it. */
  layout?(rect: PyxComposerRect | null): void;
}
export interface PyxComposerRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** The composer and the perch that sits on its edge: the part of the main window the bar must not cover when it opens. */
export function pyxComposerRect(doc: Document): PyxComposerRect | null {
  const rects = ['codex-compose', 'composer-pyx'].map(id => doc.getElementById(id)?.getBoundingClientRect()).filter((r): r is DOMRect => !!r && r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  const x = Math.min(...rects.map(r => r.left)), y = Math.min(...rects.map(r => r.top));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(...rects.map(r => r.right)) - x), height: Math.round(Math.max(...rects.map(r => r.bottom)) - y) };
}
/** The perch says whether it will open or close the bar. */
export function pyxPerchExpanded(doc: Document, open: boolean): void {
  const perch = doc.getElementById('composer-pyx'); if (!perch) return;
  perch.setAttribute('aria-expanded', String(open));
  perch.setAttribute('aria-label', open ? 'Close Pyx' : 'Open Pyx');
}
export interface PyxLinkOptions {
  bridge: PyxHostBridge;
  surface: () => PyxProvider;
  subscribeSurface?: (listener: () => void) => () => void;
  /** Real step counts for the running turn, when a host has them (for example the build progress card). */
  progress?: () => { title?: string; step: number; steps: number } | null;
  /** Honest reason the active chat cannot send (not signed in, runtime stopped…); null when it can. */
  offline?: () => string | null;
  /** "What next" suggestions from a real source. Absent: starter prompts on an empty chat, otherwise none. */
  suggestions?: () => readonly PyxSuggestion[];
  now?: () => number;
  /** How long a submit may take to be taken by the chat before Pyx reports that it was not. */
  acceptWindowMs?: number;
}
export interface PyxLink { refresh(): void; stop(): void }

export const PYX_DRAFT_BUSY = 'Arcane’s chat box has an unsent draft. Send or clear it there first.';
export const PYX_NOT_READY = 'Arcane isn’t ready to send yet. Open Arcane to finish setting up.';
export const PYX_NOT_TAKEN = 'Arcane didn’t take that message. Open Arcane to see why.';

/** First sentence (or line) of a reply, at most `max` characters, cut on a word. Pyx's report, never rewritten. */
export function pyxSummary(reply: string, max = 140): string | null {
  const clean = reply.replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const sentence = /^(.+?[.!?])(\s|$)/.exec(clean)?.[1] ?? clean;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1), space = cut.lastIndexOf(' ');
  return (space > max * .6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '') + '…';
}
/** Starter prompts for an empty chat: their titles as labels, their full prompts as the fill. */
export function pyxStarterSuggestions(starters: readonly StarterPrompt[] = STARTER_PROMPTS): PyxSuggestion[] {
  return starters.slice(0, 3).map(s => ({ label: s.title, text: s.prompt }));
}
/** Claude names its models "Opus 5.5"; ChatGPT and Arcane ids pass through as the picker shows them. */
export function pyxShortModel(label: string | null | undefined): string | null {
  const value = (label ?? '').replace(/\s+/g, ' ').trim();
  if (!value || /^choose model$/i.test(value)) return null;
  return value.replace(/^claude\s+/i, '');
}

export function startPyxLink(doc: Document, options: PyxLinkOptions): PyxLink {
  const now = options.now ?? (() => Date.now()), acceptWindow = options.acceptWindowMs ?? 4000;
  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T | null;
  let workingSince: number | null = null, lastPhase: PyxPhase = 'idle', lastKey = '', timer: ReturnType<typeof setTimeout> | null = null, stopped = false;

  const articles = () => [...(doc.getElementById('codex-messages')?.querySelectorAll<HTMLElement>('article[data-role]') ?? [])];
  const snapshot = (): PyxHostSnapshot => {
    const submit = $<HTMLButtonElement>('codex-submit'), input = $<HTMLTextAreaElement>('codex-composer');
    const effortLabel = $('codex-effort-label'), list = articles();
    const turns = list.filter(a => ['user', 'assistant', 'error'].includes(a.dataset.role ?? a.getAttribute('data-role') ?? ''));
    const last = turns.at(-1), lastUser = [...turns].reverse().find(a => a.getAttribute('data-role') === 'user');
    const lastAssistant = [...turns].reverse().find(a => a.getAttribute('data-role') === 'assistant');
    let offline: string | null = null; try { offline = options.offline?.() ?? null; } catch { offline = null; }
    if (!offline && input?.disabled && submit?.dataset.taskState !== 'active') offline = PYX_NOT_READY;
    const working = submit?.dataset.taskState === 'active';
    const phase: PyxPhase = offline ? 'offline' : working ? 'working' : last?.getAttribute('data-role') === 'error' ? 'error' : lastPhase === 'working' ? 'done' : 'idle';
    if (phase === 'working' && workingSince === null) workingSince = now();
    if (phase !== 'working') workingSince = null;
    let progress: PyxBarState['progress'] = null;
    if (phase === 'working') {
      let counted: ReturnType<NonNullable<PyxLinkOptions['progress']>> = null; try { counted = options.progress?.() ?? null; } catch { counted = null; }
      const asked = pyxSummary(lastUser?.querySelector('.message-text, pre, p')?.textContent ?? lastUser?.textContent ?? '', 80);
      progress = { title: counted?.title ?? asked ?? 'Working', step: counted?.step ?? null, steps: counted?.steps ?? null, startedAt: workingSince };
    }
    const replyFresh = !!lastAssistant && (!lastUser || turns.indexOf(lastAssistant) > turns.indexOf(lastUser));
    const reply = replyFresh ? pyxSummary(lastAssistant.querySelector('.message-text, .claude-message-body, pre')?.textContent ?? lastAssistant.textContent ?? '') : null;
    const effort = effortLabel && !effortLabel.hidden ? effortLabel.textContent?.trim() || null : null;
    const modelTitle = $('codex-model-label')?.textContent?.replace(/\s+/g, ' ').trim() || null;
    let surface: PyxProvider = 'codex'; try { surface = options.surface(); } catch { surface = 'codex'; }
    let suggestions: readonly PyxSuggestion[] = [];
    try { suggestions = options.suggestions ? options.suggestions() : turns.length ? [] : pyxStarterSuggestions(); } catch { suggestions = []; }
    const state: PyxBarState = { phase, provider: surface, model: pyxShortModel(modelTitle), modelTitle: modelTitle && !/^choose model$/i.test(modelTitle) ? modelTitle : null, effort,
      reply, progress, message: phase === 'offline' ? offline : phase === 'error' ? pyxSummary(last?.textContent ?? '', 200) : null,
      canStop: working && !!submit && !submit.disabled };
    lastPhase = phase === 'done' ? 'idle' : phase;
    return { state, suggestions };
  };
  const publish = () => {
    timer = null; if (stopped) return;
    const next = snapshot(), key = JSON.stringify({ ...next, state: { ...next.state, progress: next.state.progress && { ...next.state.progress } } });
    if (key === lastKey) return; lastKey = key;
    try { options.bridge.publish(next); } catch { /* The bar is optional; the workspace keeps working without it. */ }
  };
  const refresh = () => { if (!stopped && !timer) timer = setTimeout(publish, 60); };

  const submitFromPyx = async (id: string, value: string) => {
    const input = $<HTMLTextAreaElement>('codex-composer'), form = $<HTMLFormElement>('codex-compose'), submit = $<HTMLButtonElement>('codex-submit');
    const answer = (result: PyxSubmitResult) => { try { options.bridge.answer(id, result); } catch { /* bar closed */ } };
    if (!input || !form || typeof form.requestSubmit !== 'function') return answer({ accepted: false, message: PYX_NOT_READY });
    if (input.value.trim()) return answer({ accepted: false, message: PYX_DRAFT_BUSY });
    if (input.disabled) return answer({ accepted: false, message: PYX_NOT_READY });
    input.value = value; input.dispatchEvent(new (doc.defaultView?.Event ?? Event)('input', { bubbles: true }));
    await Promise.resolve();
    if (submit?.disabled && submit.dataset.taskState !== 'active') { input.value = ''; input.dispatchEvent(new (doc.defaultView?.Event ?? Event)('input', { bubbles: true })); return answer({ accepted: false, message: PYX_NOT_READY }); }
    form.requestSubmit(); // the chat's own submit handler: send, queue or steer exactly as Enter in the main composer
    const started = now();
    while (now() - started < acceptWindow) {
      if (input.value.trim() !== value.trim()) return answer({ accepted: true });
      await new Promise(done => setTimeout(done, 50));
    }
    if (input.value.trim() === value.trim()) { input.value = ''; input.dispatchEvent(new (doc.defaultView?.Event ?? Event)('input', { bubbles: true })); }
    answer({ accepted: false, message: PYX_NOT_TAKEN });
  };
  const onRequest = (request: unknown) => {
    if (stopped || !request || typeof request !== 'object') return;
    const r = request as Record<string, unknown>;
    if (r.type === 'submit' && typeof r.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(r.id) && typeof r.text === 'string' && r.text.trim() && r.text.length <= 131072) void submitFromPyx(r.id, r.text);
    else if (r.type === 'stop') { const submit = $<HTMLButtonElement>('codex-submit'); if (submit?.dataset.taskState === 'active' && !submit.disabled) submit.click(); }
    else if (r.type === 'model-picker') { const trigger = $<HTMLButtonElement>('codex-model-trigger'); if (trigger && trigger.getAttribute('aria-expanded') !== 'true') trigger.click(); trigger?.focus(); }
  };
  const off = options.bridge.onRequest(onRequest);
  const observer = typeof doc.defaultView?.MutationObserver === 'function' ? new doc.defaultView.MutationObserver(refresh) : null;
  const watch = (id: string, init: MutationObserverInit) => { const node = doc.getElementById(id); if (node) observer?.observe(node, init); };
  watch('codex-messages', { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-role'] });
  watch('codex-submit', { attributes: true, attributeFilter: ['data-task-state', 'disabled'] });
  watch('codex-model-trigger', { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  watch('codex-composer', { attributes: true, attributeFilter: ['disabled'] });
  const offSurface = options.subscribeSurface?.(refresh);
  const tick = setInterval(() => { if (workingSince !== null) refresh(); }, 5000);
  // The perch reflects the bar: aria-expanded and "Open Pyx" / "Close Pyx".
  let offVisibility: (() => void) | undefined;
  if (typeof options.bridge.onVisibility === 'function') {
    pyxPerchExpanded(doc, false);
    let heard = false;
    try { offVisibility = options.bridge.onVisibility(open => { heard = true; if (!stopped) pyxPerchExpanded(doc, open === true); }); } catch { offVisibility = undefined; }
    // After a reload of this window the bar may already be open: ask once (a later change always wins).
    void Promise.resolve(options.bridge.isOpen?.()).then(open => { if (!stopped && !heard && typeof open === 'boolean') pyxPerchExpanded(doc, open); }, () => { /* closed by default */ });
  }
  // Where the composer is, whenever the window or the composer changes size.
  let layoutKey = '', layoutTimer: ReturnType<typeof setTimeout> | null = null;
  const sendLayout = () => {
    layoutTimer = null; if (stopped || typeof options.bridge.layout !== 'function') return;
    const rect = pyxComposerRect(doc), key = JSON.stringify(rect); if (key === layoutKey) return; layoutKey = key;
    try { options.bridge.layout(rect); } catch { /* optional */ }
  };
  const layoutSoon = () => { if (!stopped && !layoutTimer) layoutTimer = setTimeout(sendLayout, 120); };
  const view = doc.defaultView;
  view?.addEventListener('resize', layoutSoon);
  const resizer = typeof view?.ResizeObserver === 'function' ? new view.ResizeObserver(layoutSoon) : null;
  for (const id of ['codex-compose', 'composer-pyx']) { const node = doc.getElementById(id); if (node) resizer?.observe(node); }
  sendLayout();
  publish();
  return {
    refresh,
    stop() {
      stopped = true; observer?.disconnect(); resizer?.disconnect(); view?.removeEventListener('resize', layoutSoon); clearInterval(tick);
      if (timer) clearTimeout(timer); if (layoutTimer) clearTimeout(layoutTimer);
      try { off(); } catch { /* gone */ } try { offSurface?.(); } catch { /* gone */ } try { offVisibility?.(); } catch { /* gone */ }
    },
  };
}
