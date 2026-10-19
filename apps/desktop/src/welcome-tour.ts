/// <reference lib="dom" />
// Optional first-launch welcome tour: four short coach marks that point at real controls (model picker, Playtest,
// setup checklist or Connect Studio, starter gallery). Shown once after sign-in, never over the sign-in screen, and
// replayable from Settings › Guide. Nothing here sends, saves or requests anything except one local "seen" flag.
// Static by design: no transitions or animations, so reduced motion needs no special case.

export const WELCOME_TOUR_KEY = 'arcane.welcome-tour.v1';

export interface TourStep {
  id: 'model' | 'playtest' | 'setup' | 'starters';
  title: string;
  body: string;
  /** Candidate targets, first visible wins. No visible target: the card shows centered without a spotlight. */
  targets: readonly string[];
}

export const TOUR_STEPS: readonly TourStep[] = Object.freeze([
  { id: 'model', title: 'Pick your model',
    body: 'ChatGPT and Claude models sit side by side here. Choose one and set how hard it thinks. Ctrl+Shift+M opens it anytime.',
    targets: ['#codex-model-trigger'] },
  { id: 'playtest', title: 'Let Arcane playtest',
    body: 'Turn on Playtest to ask Arcane to check gameplay after a build.',
    targets: ['#playtest-toggle'] },
  { id: 'setup', title: 'Connect Studio',
    body: 'Finish setup here: install the plugin, then click Connect Studio. Arcane builds straight into your open place.',
    targets: ['#setup-checklist', '#key-setup-gate', '#welcome-connect', '.app-sidebar [data-workspace-target="workspace-settings"]'] },
  { id: 'starters', title: 'Start from an idea',
    body: 'Pick a starter to fill the message box, or just describe your game. Nothing sends until you do.',
    targets: ['#starter-gallery', '#codex-composer'] },
]);

type TourStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Pure: has the tour been finished or skipped before? Unreadable or malformed storage counts as not seen. */
export function tourSeen(storage: TourStorage | null): boolean {
  if (!storage) return false;
  try {
    const value = JSON.parse(storage.getItem(WELCOME_TOUR_KEY) ?? 'null') as { version?: unknown; seen?: unknown } | null;
    return !!value && value.version === 1 && value.seen === true;
  } catch { return false; }
}

/** Records completion. Storage failures are ignored: the tour simply shows again next launch. */
export function markTourSeen(storage: TourStorage | null, how: 'finished' | 'skipped' | 'shown'): void {
  try { storage?.setItem(WELCOME_TOUR_KEY, JSON.stringify({ version: 1, seen: true, how })); } catch { /* Private mode or full storage. */ }
}

export type TourMove = { kind: 'go'; index: number } | { kind: 'skip' } | { kind: 'finish' } | null;
/** Pure: the tour's response to a key pressed inside the coach card. `onButton` is true when focus is on a button. */
export function tourKeyMove(key: string, index: number, count: number, onButton = false): TourMove {
  switch (key) {
    case 'Escape': return { kind: 'skip' };
    case 'ArrowRight': case 'PageDown': return index + 1 < count ? { kind: 'go', index: index + 1 } : { kind: 'finish' };
    case 'ArrowLeft': case 'PageUp': return index > 0 ? { kind: 'go', index: index - 1 } : null;
    case 'Home': return index > 0 ? { kind: 'go', index: 0 } : null;
    case 'End': return index < count - 1 ? { kind: 'go', index: count - 1 } : null;
    // A focused button handles Enter itself; Enter elsewhere in the card means Next.
    case 'Enter': return onButton ? null : index + 1 < count ? { kind: 'go', index: index + 1 } : { kind: 'finish' };
    default: return null;
  }
}

export interface Box { top: number; left: number; width: number; height: number }
export interface Placement { top: number; left: number; side: 'below' | 'above' | 'center' }
/** Pure: where the coach card goes for a target box, keeping a margin from every viewport edge. */
export function placeCard(target: Box | null, card: { width: number; height: number }, viewport: { width: number; height: number }, gap = 12, margin = 16): Placement {
  const clampLeft = (left: number) => Math.max(margin, Math.min(left, viewport.width - card.width - margin));
  const clampTop = (top: number) => Math.max(margin, Math.min(top, viewport.height - card.height - margin));
  if (!target) return { top: clampTop((viewport.height - card.height) / 2), left: clampLeft((viewport.width - card.width) / 2), side: 'center' };
  const left = clampLeft(target.left + target.width / 2 - card.width / 2);
  const below = target.top + target.height + gap, above = target.top - gap - card.height;
  if (below + card.height + margin <= viewport.height) return { top: below, left, side: 'below' };
  if (above >= margin) return { top: above, left, side: 'above' };
  // Tall targets (a whole checklist): overlap the lower part of the target rather than leave the screen.
  return { top: clampTop(viewport.height - card.height - margin), left, side: 'center' };
}

export interface WelcomeTourOptions {
  storage?: TourStorage | null;
  /** The desktop owns this app-wide flag; browser storage is only a fallback for web use. */
  persistence?: WelcomeTourPersistence | null;
  steps?: readonly TourStep[];
  /** Auto-start on first launch once signed in. Default true. */
  autoStart?: boolean;
}
export interface WelcomeTourPersistence {
  read(): Promise<{available: boolean; seen: boolean}>;
  dismiss(input: {how: 'finished' | 'skipped' | 'shown'}): Promise<{saved: true}>;
}
export interface WelcomeTour { start(): boolean; close(how: 'finished' | 'skipped' | 'paused'): void; active(): boolean; stop(): void }

const FOCUSABLE = 'button:not([disabled]):not([hidden]), [href], [tabindex]:not([tabindex="-1"])';

export function startWelcomeTour(doc: Document, options: WelcomeTourOptions = {}): WelcomeTour {
  const steps = options.steps ?? TOUR_STEPS, storage = options.storage ?? null;
  const root = doc.getElementById('welcome-tour'), card = doc.getElementById('welcome-tour-card'), spot = doc.getElementById('welcome-tour-spotlight');
  const title = doc.getElementById('welcome-tour-title'), body = doc.getElementById('welcome-tour-body'), counter = doc.getElementById('welcome-tour-count');
  const back = doc.getElementById('welcome-tour-back') as HTMLButtonElement | null, next = doc.getElementById('welcome-tour-next') as HTMLButtonElement | null;
  const skip = doc.getElementById('welcome-tour-skip') as HTMLButtonElement | null, replay = doc.getElementById('welcome-tour-replay') as HTMLButtonElement | null;
  const view = doc.defaultView;
  const persistence = options.persistence ?? (view as (Window & {arcaneDesktop?: {welcomeTour?: WelcomeTourPersistence}}) | null)?.arcaneDesktop?.welcomeTour ?? null;
  const noop: WelcomeTour = { start: () => false, close() {}, active: () => false, stop() {} };
  if (!root || !card || !spot || !title || !body || !back || !next || !skip || !view || !steps.length) return noop;
  let index = -1, stopped = false, returnFocus: HTMLElement | null = null, target: HTMLElement | null = null;
  let pending: number | null = null;
  let hydrated = !persistence, allowAuto = true, seen = tourSeen(storage);
  const wasSeen = () => seen || tourSeen(storage);
  // Serialize presentation and completion so a quick Skip cannot race the host's file lock.
  let pendingSave: Promise<void> = Promise.resolve();
  function remember(how: 'finished' | 'skipped' | 'shown') {
    seen = true; markTourSeen(storage, how);
    if (persistence) pendingSave = pendingSave.then(() => persistence.dismiss({how})).then(() => {}, () => {});
  }

  const visible = (node: Element | null): node is HTMLElement => {
    if (!(node instanceof view.HTMLElement) || node.closest('[hidden], [inert]')) return false;
    const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0;
  };
  const signInShowing = () => { const gate = doc.getElementById('provider-login-gate'); return !!gate && !gate.hidden && visible(gate); };
  const blocked = () => signInShowing() || !!doc.querySelector('dialog[open]');
  const findTarget = (step: TourStep) => { for (const selector of step.targets) { const node = doc.querySelector(selector); if (visible(node)) return node; } return null; };

  function layout() {
    if (index < 0) return;
    const viewport = { width: view!.innerWidth, height: view!.innerHeight };
    let box: Box | null = null;
    if (target && visible(target)) {
      const r = target.getBoundingClientRect(), pad = 6;
      box = { top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
      Object.assign(spot!.style, { top: box.top + 'px', left: box.left + 'px', width: box.width + 'px', height: box.height + 'px' });
      spot!.hidden = false;
    } else spot!.hidden = true;
    const place = placeCard(box, { width: card!.offsetWidth, height: card!.offsetHeight }, viewport);
    card!.style.top = place.top + 'px'; card!.style.left = place.left + 'px'; card!.dataset.side = place.side;
  }

  function show(at: number) {
    index = Math.max(0, Math.min(at, steps.length - 1));
    const step = steps[index]!;
    target = findTarget(step);
    try { target?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* Optional. */ }
    root!.dataset.step = step.id;
    if (counter) counter.textContent = 'Step ' + (index + 1) + ' of ' + steps.length;
    title!.textContent = step.title; body!.textContent = step.body;
    back!.hidden = index === 0;
    next!.textContent = index === steps.length - 1 ? 'Done' : 'Next';
    layout();
    next!.focus();
  }

  function onKey(event: KeyboardEvent) {
    if (index < 0) return;
    if (event.key === 'Tab') {
      // Focus trap: Tab and Shift+Tab cycle inside the coach card.
      const items = [...card!.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
      if (!items.length) return;
      const first = items[0]!, last = items[items.length - 1]!, active = doc.activeElement;
      if (event.shiftKey && (active === first || !card!.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !card!.contains(active))) { event.preventDefault(); first.focus(); }
      return;
    }
    const onButton = doc.activeElement instanceof view!.HTMLButtonElement && card!.contains(doc.activeElement);
    const move = tourKeyMove(event.key, index, steps.length, onButton);
    if (!move) return;
    event.preventDefault(); event.stopPropagation();
    if (move.kind === 'go') show(move.index); else close(move.kind === 'skip' ? 'skipped' : 'finished');
  }
  // Keep keyboard focus in the card if something else grabs it while the tour is open.
  function onFocusIn(event: FocusEvent) { if (index >= 0 && event.target instanceof view!.Node && !card!.contains(event.target)) next!.focus(); }
  const onLayout = () => layout();

  function start(): boolean {
    if (stopped || index >= 0 || blocked()) return false;
    const active = doc.activeElement; returnFocus = active instanceof view!.HTMLElement && active !== doc.body ? active : null;
    root!.hidden = false;
    doc.addEventListener('keydown', onKey, true); doc.addEventListener('focusin', onFocusIn);
    view!.addEventListener('resize', onLayout); view!.addEventListener('scroll', onLayout, true);
    show(0);
    return true;
  }
  function close(how: 'finished' | 'skipped' | 'paused') {
    if (index < 0) return;
    index = -1; target = null; root!.hidden = true; spot!.hidden = true; delete root!.dataset.step;
    doc.removeEventListener('keydown', onKey, true); doc.removeEventListener('focusin', onFocusIn);
    view!.removeEventListener('resize', onLayout); view!.removeEventListener('scroll', onLayout, true);
    if (how !== 'paused') {
      remember(how);
    }
    const to = returnFocus && returnFocus.isConnected && visible(returnFocus) ? returnFocus : doc.getElementById('codex-composer');
    returnFocus = null;
    try { (to as HTMLElement | null)?.focus({ preventScroll: true }); } catch { /* Optional. */ }
  }

  const onBack = () => { if (index > 0) show(index - 1); };
  const onNext = () => { if (index + 1 < steps.length) show(index + 1); else close('finished'); };
  const onSkip = () => close('skipped');
  const replayStatus = doc.getElementById('welcome-tour-replay-status');
  const onReplay = () => {
    if (signInShowing()) { if (replayStatus) replayStatus.textContent = 'Sign in first, then replay the tour.'; return; }
    if (replayStatus) replayStatus.textContent = '';
    const drawer = doc.getElementById('settings-drawer') as HTMLDialogElement | null;
    if (drawer?.open) drawer.close();
    // Let the drawer's own close handling settle focus first.
    view!.setTimeout(() => { start(); }, 0);
  };
  back.addEventListener('click', onBack); next.addEventListener('click', onNext); skip.addEventListener('click', onSkip);
  replay?.addEventListener('click', onReplay);

  // First launch: wait for sign-in (the gate hides) and for no dialog to be open, then show once.
  const Observer = view.MutationObserver;
  let observer: MutationObserver | null = null;
  const tryAuto = () => {
    if (stopped || !hydrated || !allowAuto || index >= 0 || pending !== null || wasSeen()) return;
    // A short settle so the signed-in workspace (checklist, gallery) has rendered before measuring targets.
    pending = view.setTimeout(() => {
      pending = null;
      if (!stopped && !wasSeen() && start()) remember('shown');
    }, 400);
  };
  // Pause (without marking seen) if the user is signed out while the tour is open.
  const onGate = () => { if (index >= 0 && signInShowing()) close('paused'); else if (options.autoStart !== false) tryAuto(); };
  if (Observer) {
    observer = new Observer(onGate);
    const gate = doc.getElementById('provider-login-gate'), stage = doc.getElementById('workspace-stage');
    if (gate) observer.observe(gate, { attributes: true, attributeFilter: ['hidden'] });
    if (stage) observer.observe(stage, { attributes: true, attributeFilter: ['class'] });
    const drawer = doc.getElementById('settings-drawer'); if (drawer) observer.observe(drawer, { attributes: true, attributeFilter: ['open'] });
  }
  if (persistence) {
    void persistence.read().then(async value => {
      if (stopped) return;
      allowAuto = value.available;
      if (value.seen) { seen = true; markTourSeen(storage, 'skipped'); }
      else if (seen && value.available) await persistence.dismiss({how: 'skipped'});
    }).catch(() => { allowAuto = false; }).finally(() => {
      hydrated = true; if (options.autoStart !== false) tryAuto();
    });
  } else if (options.autoStart !== false && !wasSeen()) tryAuto();

  return {
    start, close, active: () => index >= 0,
    stop() {
      if (stopped) return; close('paused'); stopped = true; observer?.disconnect();
      if (pending !== null) { view.clearTimeout(pending); pending = null; }
      back.removeEventListener('click', onBack); next.removeEventListener('click', onNext); skip.removeEventListener('click', onSkip);
      replay?.removeEventListener('click', onReplay);
    },
  };
}
