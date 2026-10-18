/// <reference lib="dom" />
// Quick-start gallery on the empty chat. A click fills the composer with a starter prompt for the user to review;
// nothing is ever sent, saved or requested from here. Hidden once the conversation has messages; while the setup
// checklist is showing, the cards fold behind one "Browse starters" button so the first-run screen stays calm.
import { STARTER_PROMPTS, type StarterIcon, type StarterPrompt } from './starter-prompts.js';

const SVG = 'http://www.w3.org/2000/svg';
/** 24px stroke icons; one path string each. */
export const STARTER_ICONS: Readonly<Record<StarterIcon, string>> = Object.freeze({
  tree: 'M12 3 6 12h3l-4 6h14l-4-6h3ZM12 18v3',
  flag: 'M5 21V4M5 4h12l-2.5 4L17 12H5',
  coins: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5',
  loop: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  ghost: 'M6 20v-9a6 6 0 0 1 12 0v9l-3-2-3 2-3-2ZM10 11v1M14 11v1',
  layout: 'M3 4h18v16H3ZM3 9h18M8 9v11',
  target: 'M12 7a5 5 0 1 0 0 10 5 5 0 1 0 0-10ZM12 2v4M12 18v4M2 12h4M18 12h4',
  store: 'M4 9h16l-1.5-5h-13ZM5 9v11h14V9M10 20v-6h4v6',
  chat: 'M4 5h16v11H9l-5 4Z',
  flask: 'M9 3h6M10 3v6l-5 10h14l-5-10V3M7.5 14h9',
});

export interface ComposerFill { value: string; replaced: boolean; fits: boolean }
/** Pure: the composer text after choosing a starter. An empty box or an unedited starter is replaced; a draft is kept and the starter appended. */
export function composerWithStarter(current: string, prompt: string, maxLength = 131072, starters: readonly StarterPrompt[] = STARTER_PROMPTS): ComposerFill {
  const draft = current.trim();
  const replaced = !draft || starters.some(s => s.prompt === draft);
  const value = replaced ? prompt : current.replace(/\s+$/, '') + '\n\n' + prompt;
  return { value, replaced, fits: maxLength <= 0 || value.length <= maxLength };
}

/** Pure: roving focus target for a key in a grid of `count` cards laid out in `columns` columns. */
export function starterFocusTarget(key: string, index: number, count: number, columns: number): number | null {
  const cols = Math.max(1, columns), last = count - 1;
  switch (key) {
    case 'ArrowRight': return Math.min(last, index + 1);
    case 'ArrowLeft': return Math.max(0, index - 1);
    case 'ArrowDown': return index + cols <= last ? index + cols : index;
    case 'ArrowUp': return index - cols >= 0 ? index - cols : index;
    case 'Home': return 0;
    case 'End': return last;
    default: return null;
  }
}

export interface StarterGalleryOptions { prompts?: readonly StarterPrompt[] }
export interface StarterGallery { refresh(): void; stop(): void }

export function startStarterGallery(doc: Document, options: StarterGalleryOptions = {}): StarterGallery {
  const prompts = options.prompts ?? STARTER_PROMPTS;
  const root = doc.getElementById('starter-gallery'), grid = doc.getElementById('starter-gallery-grid');
  const toggle = doc.getElementById('starter-gallery-toggle') as HTMLButtonElement | null, status = doc.getElementById('starter-gallery-status');
  if (!root || !grid) return { refresh() {}, stop() {} };
  let expanded: boolean | null = null; // null: follow the checklist; true/false: the user's choice for this page.
  let stopped = false;
  const cards: HTMLButtonElement[] = [];

  const icon = (name: StarterIcon) => {
    const svg = doc.createElementNS(SVG, 'svg');
    for (const [k, v] of Object.entries({ class: 'starter-card-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
    const path = doc.createElementNS(SVG, 'path'); path.setAttribute('d', STARTER_ICONS[name]); svg.append(path);
    return svg;
  };
  const span = (cls: string, text: string) => { const node = doc.createElement('span'); node.className = cls; node.textContent = text; return node; };
  grid.replaceChildren(...prompts.map((starter, index) => {
    const item = doc.createElement('li'); item.className = 'starter-gallery-item';
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'starter-card';
    button.dataset.starterId = starter.id; button.dataset.category = starter.category.toLowerCase(); button.tabIndex = index === 0 ? 0 : -1;
    button.append(icon(starter.icon), span('starter-card-title', starter.title), span('starter-card-desc', starter.description), span('starter-card-chip', starter.category));
    button.addEventListener('click', () => choose(starter, button));
    button.addEventListener('focus', () => { for (const card of cards) card.tabIndex = card === button ? 0 : -1; });
    cards.push(button); item.append(button); return item;
  }));

  const columns = () => {
    const template = doc.defaultView?.getComputedStyle(grid).gridTemplateColumns ?? '';
    return template && template !== 'none' ? template.trim().split(/\s+/).length : 1;
  };
  const onKey = (event: KeyboardEvent) => {
    const index = cards.indexOf(event.target as HTMLButtonElement); if (index < 0) return;
    const next = starterFocusTarget(event.key, index, cards.length, columns()); if (next === null) return;
    event.preventDefault(); cards[next]!.focus();
  };
  grid.addEventListener('keydown', onKey);

  function announce(text: string) { if (status) status.textContent = text; }
  function choose(starter: StarterPrompt, button: HTMLButtonElement) {
    const composer = doc.getElementById('codex-composer') as HTMLTextAreaElement | null;
    if (!composer || composer.disabled || composer.readOnly) { announce('The message box is not available yet. Finish setup first.'); return; }
    const fill = composerWithStarter(composer.value, starter.prompt, composer.maxLength);
    if (!fill.fits) { announce('Your draft is too long to add this starter. Clear the message box and try again.'); return; }
    composer.value = fill.value;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    for (const card of cards) card.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'true');
    composer.focus();
    try { composer.setSelectionRange(fill.value.length, fill.value.length); } catch { /* Selection is optional. */ }
    announce((fill.replaced ? 'Added “' : 'Appended “') + starter.title + '” to the message box. Review it, then send.');
  }

  const hasMessages = () => !!doc.querySelector('#codex-messages .codex-message');
  const checklistShowing = () => { const list = doc.getElementById('setup-checklist'); return !!list && !list.hidden; };
  function refresh() {
    if (stopped) return;
    root!.hidden = hasMessages();
    const compact = checklistShowing();
    const open = expanded ?? !compact;
    root!.dataset.compact = String(compact);
    grid!.hidden = !open;
    if (toggle) {
      toggle.hidden = !compact && expanded === null;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Hide starters' : 'Browse starters';
    }
  }
  const onToggle = () => { expanded = !!grid.hidden; refresh(); if (expanded) cards.find(c => c.tabIndex === 0)?.focus(); };
  toggle?.addEventListener('click', onToggle);
  const View = doc.defaultView?.MutationObserver;
  const observer = View ? new View(() => refresh()) : null;
  const messages = doc.getElementById('codex-messages'), checklist = doc.getElementById('setup-checklist');
  if (messages) observer?.observe(messages, { childList: true, subtree: true });
  if (checklist) observer?.observe(checklist, { attributes: true, attributeFilter: ['hidden'] });
  refresh();
  return {
    refresh,
    stop() { if (stopped) return; stopped = true; observer?.disconnect(); grid.removeEventListener('keydown', onKey); toggle?.removeEventListener('click', onToggle); },
  };
}
