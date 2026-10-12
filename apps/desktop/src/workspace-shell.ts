/// <reference lib="dom" />

const shells = new WeakMap<Document, WorkspaceShell>();

export type WorkspaceTool = 'all' | 'blender' | 'roblox';
export interface WorkspaceToolChange { tool: WorkspaceTool }
const TOOL_CONTEXT: Record<WorkspaceTool, { label: string; heading: string; description: string; settings: string; draft: string }> = {
  all: { label: 'All tools', heading: 'Your workspace', description: 'Models and scene work stay in this conversation.', settings: 'workspace-settings',
    draft: 'Tool context: Blender models, materials and textures, and Roblox Studio scenes and scripts.' },
  blender: { label: 'Blender', heading: 'Blender workspace', description: 'Models, materials, textures and animation in this conversation.', settings: 'asset-heading',
    draft: 'Tool context: Blender models, materials, textures and animation.' },
  roblox: { label: 'Roblox Studio', heading: 'Roblox Studio workspace', description: 'Scenes, scripts and game systems in this conversation.', settings: 'session-heading',
    draft: 'Tool context: Roblox Studio scenes, scripts and game systems.' },
};
const workspaceTool = (value: string | null): WorkspaceTool | null =>
  value === 'all' || value === 'blender' || value === 'roblox' ? value : null;

/** Presentation-only navigation. Native actions remain in the existing panels. */
export class WorkspaceShell {
  private readonly removers: (() => void)[] = [];
  private readonly focusTargets = new Set<HTMLElement>();
  private readonly navigation: HTMLElement[];
  private searchResults: HTMLElement | null = null;
  private disposed = false;
  private fullscreenBusy = false;
  private tool: WorkspaceTool = 'all';

  get activeTool(): WorkspaceTool { return this.tool; }

  constructor(private readonly doc: Document, private readonly onNavigate?: () => void) {
    this.navigation = Array.from(doc.querySelectorAll<HTMLElement>('[data-workspace-target]'));
    for (const control of this.navigation) {
      if (control.classList.contains('is-active')) control.setAttribute('aria-current', 'page');
      if (['new-chat', 'sidebar-toggle', 'preview-expand', 'preview-settings'].includes(control.id) || control.hasAttribute('data-draft')) continue;
      this.button(control, () => {
        const tool = workspaceTool(control.getAttribute('data-workspace-tool'));
        if (tool) this.selectTool(tool);
        else this.navigate(control.getAttribute('data-workspace-target'));
      }, control.hasAttribute('data-workspace-tool'));
    }
    for (const control of doc.querySelectorAll<HTMLElement>('[data-draft]')) this.button(control, () => {
      const draft = control.getAttribute('data-draft');
      if (draft !== null) this.openComposer(draft);
    });
    const newChat = doc.getElementById('new-chat');
    if (newChat) {
      newChat.setAttribute('aria-label', 'Focus current conversation');
      newChat.setAttribute('title', 'Focus current conversation');
      this.button(newChat, () => this.openComposer());
    }
    const sidebar = doc.getElementById('app-sidebar'), toggle = doc.getElementById('sidebar-toggle');
    if (sidebar && toggle) {
      toggle.setAttribute('aria-controls', sidebar.id);
      const sync = () => toggle.setAttribute('aria-expanded', String(!sidebar.classList.contains('collapsed')));
      sync();
      this.button(toggle, () => { sidebar.classList.toggle('collapsed'); sync(); });
    }
    const settings = doc.getElementById('preview-settings');
    if (settings) this.button(settings, () => { this.navigate('asset-heading'); });
    const expand = doc.getElementById('preview-expand'), preview = doc.getElementById('artifact-panel');
    if (expand && preview) {
      const sync = () => {
        const expanded = doc.fullscreenElement === preview;
        expand.setAttribute('aria-pressed', String(expanded));
        expand.setAttribute('aria-label', expanded ? 'Exit preview fullscreen' : 'Expand preview fullscreen');
      };
      sync();
      this.listen(doc, 'fullscreenchange', sync);
      this.button(expand, () => { void this.toggleFullscreen(preview, sync); });
    }
    // Restore presentation context on pageshow without touching the native thread or draft.
    this.tool = workspaceTool(doc.getElementById('workspace-stage')?.getAttribute('data-workspace-tool') ?? null) ?? 'all';
    this.renderTool();
    const addContext = doc.getElementById('workspace-add-context');
    if (addContext) this.button(addContext, () => {
      this.openComposer(TOOL_CONTEXT[this.tool].draft +
        '\nThis is supplemental context. It does not grant permission to run tools or change files.');
    });
    this.bindSearch();
    this.bindPreviews();
    this.bindShortcuts();
  }

  cleanup(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.removers.splice(0)) remove();
    this.searchResults?.remove();
    this.searchResults = null;
    for (const target of this.focusTargets) {
      if (target.getAttribute('tabindex') === '-1') target.removeAttribute('tabindex');
    }
    this.focusTargets.clear();
    if (shells.get(this.doc) === this) shells.delete(this.doc);
  }

  private listen(target: EventTarget, type: string, handler: EventListener, capture = false): void {
    target.addEventListener(type, handler, capture);
    this.removers.push(() => target.removeEventListener(type, handler, capture));
  }

  private button(control: HTMLElement, action: () => void, ownsToolNavigation = false): void {
    // Shell controls inside a native form must never become submit buttons.
    if (control.tagName === 'BUTTON') control.setAttribute('type', 'button');
    this.listen(control, 'click', event => {
      event.preventDefault();
      // Own tool navigation before legacy workshop scrolling, including after pageshow.
      // Secret dismissal still uses the shared onNavigate callback.
      if (ownsToolNavigation) event.stopImmediatePropagation();
      action();
    }, ownsToolNavigation);
  }

  private focus(target: HTMLElement, dismissSecrets = true): void {
    if (dismissSecrets) this.onNavigate?.();
    // Only explicit navigation opens settings; startup and tool selection do not.
    for (let ancestor: HTMLElement | null = target; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open')) ancestor.setAttribute('open', '');
    }
    if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
      this.focusTargets.add(target);
    }
    const home = target.id === 'codex-heading' || target.id === 'codex-composer';
    const scrollTarget = home ? this.doc.getElementById('workspace-topbar') ?? target : target;
    scrollTarget.scrollIntoView?.({ block: 'start' });
    target.focus?.({ preventScroll: true });
  }

  private markCurrent(id: string): void {
    const chosen = new Map<Element | null, HTMLElement>();
    for (const control of this.navigation) {
      if (control.hasAttribute('data-workspace-tool') || control.hasAttribute('data-draft') || control.getAttribute('data-workspace-target') !== id) continue;
      const group = control.closest('nav') ?? control.parentElement;
      if (!chosen.has(group)) chosen.set(group, control);
    }
    for (const control of this.navigation) {
      if (control.hasAttribute('data-workspace-tool')) continue;
      const group = control.closest('nav') ?? control.parentElement;
      const current = !control.hasAttribute('data-draft') && chosen.get(group) === control;
      control.classList.toggle('is-active', current);
      if (current) control.setAttribute('aria-current', 'page'); else control.removeAttribute('aria-current');
    }
  }

  private navigate(id: string | null): boolean {
    const target = id ? this.doc.getElementById(id) : null;
    if (!target) return false;
    this.markCurrent(target.id);
    this.focus(target);
    return true;
  }

  private composer(): HTMLTextAreaElement | HTMLInputElement | null {
    const composer = this.doc.getElementById('codex-composer');
    return composer && (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT')
      ? composer as HTMLTextAreaElement | HTMLInputElement : null;
  }

  private openComposer(draft?: string): void {
    const composer = this.composer();
    if (!composer) return;
    this.onNavigate?.();
    if (draft !== undefined && draft.length) {
      const next = composer.value + (composer.value ? '\n\n' : '') + draft;
      const rawLimit = composer.getAttribute('maxlength');
      const limit = rawLimit !== null && /^\d+$/.test(rawLimit) ? Number(rawLimit) : 131072;
      if (next.length > limit || new TextEncoder().encode(next).length > 131072) {
        this.notice('Tool context exceeds the message limit. Your draft was preserved.');
        this.focus(composer, false);
        return;
      }
      composer.value = next;
      const InputEvent = this.doc.defaultView?.Event ?? Event;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
      this.notice('Context added to your draft. Review it before sending.');
    }
    if (this.doc.getElementById('codex-heading')) this.markCurrent('codex-heading');
    this.focus(composer, false);
  }

  private renderTool(): void {
    const context = TOOL_CONTEXT[this.tool];
    this.doc.getElementById('workspace-stage')?.setAttribute('data-workspace-tool', this.tool);
    for (const [id, value] of [['workspace-tool-label', context.label], ['workspace-context-heading', context.heading],
      ['workspace-context-description', context.description]] as const) {
      const element = this.doc.getElementById(id);
      if (element) element.textContent = value;
    }
    this.doc.getElementById('workspace-tool-settings')?.setAttribute('data-workspace-target', context.settings);
    for (const control of this.navigation) {
      const tool = workspaceTool(control.getAttribute('data-workspace-tool'));
      if (!tool) continue;
      const selected = tool === this.tool;
      control.setAttribute('aria-pressed', String(selected));
      control.classList.toggle('is-active', selected);
      control.removeAttribute('aria-current');
    }
  }

  private selectTool(tool: WorkspaceTool): void {
    this.onNavigate?.();
    if (tool === this.tool) return;
    this.tool = tool;
    this.renderTool();
    // Integration signal only: never create/resume a native thread or submit text.
    const CustomEvent = this.doc.defaultView?.CustomEvent;
    if (CustomEvent) this.doc.dispatchEvent(new CustomEvent<WorkspaceToolChange>('workspace:toolchange', {
      detail: { tool }, bubbles: false,
    }));
  }

  private bindShortcuts(): void {
    this.listen(this.doc, 'keydown', event => {
      const keyboard = event as KeyboardEvent;
      if (event.defaultPrevented || keyboard.isComposing || keyboard.repeat || keyboard.altKey || keyboard.shiftKey || !(keyboard.ctrlKey || keyboard.metaKey)) return;
      const key = keyboard.key.toLowerCase();
      if (key === 'n' && this.composer()) { event.preventDefault(); this.openComposer(); }
      if (key === 'k') {
        const search = this.doc.getElementById('workspace-search');
        const editable = (event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]');
        if (!search || (editable && editable !== search && editable.getAttribute('contenteditable') !== 'false')) return;
        event.preventDefault(); this.focus(search);
      }
    });
  }

  private notice(message: string): void {
    if (this.disposed) return;
    const notice = this.doc.getElementById('shell-notice');
    if (notice) { notice.textContent = message; notice.hidden = !message; }
  }

  private async toggleFullscreen(preview: HTMLElement, sync: () => void): Promise<void> {
    if (this.fullscreenBusy) return;
    const exiting = this.doc.fullscreenElement === preview;
    if (exiting ? typeof this.doc.exitFullscreen !== 'function' : typeof preview.requestFullscreen !== 'function') {
      this.notice('Preview fullscreen is unavailable in this browser.');
      return;
    }
    this.fullscreenBusy = true;
    try {
      if (exiting) await this.doc.exitFullscreen();
      else await preview.requestFullscreen();
      if (!this.disposed) { sync(); this.notice(''); }
    } catch {
      this.notice('Unable to change preview fullscreen. Use your browser fullscreen controls.');
    } finally { this.fullscreenBusy = false; }
  }

  private bindPreviews(): void {
    const previews = this.doc.getElementById('asset-previews');
    if (!previews) return;
    const summary = this.doc.getElementById('asset-job-summary'), status = this.doc.getElementById('preview-guide-status');
    let selected: HTMLElement | null = null;
    const sync = () => {
      const figures = Array.from(previews.querySelectorAll<HTMLElement>('figure')).filter(figure => figure.querySelector('canvas'));
      if (!selected || !figures.includes(selected)) selected = figures.find(figure => figure.getAttribute('aria-pressed') === 'true') ?? figures[0] ?? null;
      for (const figure of figures) {
        figure.setAttribute('role', 'button');
        figure.setAttribute('tabindex', '0');
        figure.setAttribute('aria-pressed', String(figure === selected));
        figure.classList.toggle('is-selected', figure === selected);
      }
      if (status) {
        const text = figures.length ? (summary?.textContent ?? '')
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
          .replace(/\barcane_local_v1_[0-9]+_[a-f0-9]{64}\b/g, '[REDACTED]')
          .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
          .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 2048)
          : 'No model is selected. Nothing is generated automatically.';
        if (status.textContent !== text) status.textContent = text;
      }
    };
    const select = (event: Event) => {
      const figure = (event.target as Element | null)?.closest?.('figure') as HTMLElement | null;
      if (!figure || !previews.contains(figure) || !figure.querySelector('canvas')) return;
      event.preventDefault();
      this.onNavigate?.();
      selected = figure;
      sync();
      figure.focus({ preventScroll: true });
    };
    this.listen(previews, 'click', select);
    this.listen(previews, 'keydown', event => {
      if (['Enter', ' '].includes((event as KeyboardEvent).key)) select(event);
    });
    const Observer = this.doc.defaultView?.MutationObserver;
    if (Observer) {
      const observer = new Observer(sync);
      observer.observe(previews, { childList: true, subtree: true });
      if (summary && status) observer.observe(summary, { childList: true, subtree: true, characterData: true });
      this.removers.push(() => observer.disconnect());
    }
    sync();
  }

  private bindSearch(): void {
    const search = this.doc.getElementById('workspace-search') as HTMLInputElement | null;
    if (!search || search.tagName !== 'INPUT' || !search.parentElement) return;
    const results = this.doc.createElement('div');
    results.id = 'workspace-search-results';
    results.className = 'workspace-search-results';
    results.setAttribute('role', 'region');
    results.setAttribute('aria-label', 'Workspace navigation matches');
    results.hidden = true;
    search.parentElement.append(results);
    this.searchResults = results;
    const previousControls = search.getAttribute('aria-controls'), previousExpanded = search.getAttribute('aria-expanded');
    search.setAttribute('aria-controls', results.id);
    const close = () => { results.hidden = true; search.setAttribute('aria-expanded', 'false'); };
    close();
    this.removers.push(() => {
      for (const [name, value] of [['aria-controls', previousControls], ['aria-expanded', previousExpanded]] as const) {
        if (value === null) search.removeAttribute(name); else search.setAttribute(name, value);
      }
    });
    this.listen(search, 'input', () => {
      this.onNavigate?.();
      results.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase();
      if (!query) { close(); return; }
      const seen = new Set<string>(), sidebar = this.doc.getElementById('app-sidebar');
      for (const item of this.doc.querySelectorAll<HTMLElement>('[data-workspace-target], [data-search-item]')) {
        if (results.contains(item) || item.closest('[hidden], [inert]') || item.hasAttribute('disabled')) continue;
        if (!sidebar?.contains(item) && !item.hasAttribute('data-search-item')) continue;
        const keywords = item.getAttribute('data-search-item') ?? '';
        const id = item.getAttribute('data-workspace-target') || (this.doc.getElementById(keywords) ? keywords : item.id);
        const target = id ? this.doc.getElementById(id) : null;
        if (!target || seen.has(id)) continue;
        // Search navigation labels and headings, never entire panel transcripts.
        const heading = item.querySelector<HTMLElement>('h1, h2, h3');
        const labelledBy = this.doc.getElementById(item.getAttribute('aria-labelledby') ?? '');
        const label = (item.getAttribute('aria-label') || labelledBy?.textContent || heading?.textContent
          || (/^(A|BUTTON|H[1-6])$/.test(item.tagName) ? item.textContent : ''))?.trim();
        if (!label || !(label + ' ' + keywords).toLocaleLowerCase().includes(query)) continue;
        seen.add(id);
        const button = this.doc.createElement('button');
        button.type = 'button';
        button.setAttribute('data-workspace-target', id);
        const tool = workspaceTool(item.getAttribute('data-workspace-tool'));
        if (tool) button.setAttribute('data-workspace-tool', tool);
        button.textContent = label;
        results.append(button);
      }
      if (!seen.size) {
        const empty = this.doc.createElement('p');
        empty.textContent = 'No matching workspace sections.';
        results.append(empty);
      }
      results.hidden = false;
      search.setAttribute('aria-expanded', 'true');
    });
    this.listen(results, 'click', event => {
      const control = (event.target as Element | null)?.closest?.('button[data-workspace-target]');
      if (!control || !results.contains(control)) return;
      event.preventDefault();
      const tool = workspaceTool(control.getAttribute('data-workspace-tool'));
      if (tool) { this.selectTool(tool); close(); }
      else if (this.navigate(control.getAttribute('data-workspace-target'))) close();
    });
    this.listen(search, 'keydown', event => {
      const key = (event as KeyboardEvent).key;
      if (key === 'Escape') { event.preventDefault(); close(); }
      if (key === 'Enter') {
        event.preventDefault();
        const first = results.hidden ? null : results.querySelector<HTMLElement>('button[data-workspace-target]');
        if (first) {
          const tool = workspaceTool(first.getAttribute('data-workspace-tool'));
          if (tool) { this.selectTool(tool); close(); }
          else if (this.navigate(first.getAttribute('data-workspace-target'))) close();
        }
      }
      if (key === 'ArrowDown' && !results.hidden) {
        event.preventDefault();
        const first = results.querySelector<HTMLElement>('button');
        if (first) this.focus(first);
      }
    });
    this.listen(results, 'keydown', event => {
      if ((event as KeyboardEvent).key === 'Escape') { event.preventDefault(); close(); this.focus(search); }
    });
  }
}

/** Repeated starts share one binding set; cleanup permits a fresh pageshow start. */
export function startWorkspaceShell(doc: Document, onNavigate?: () => void): WorkspaceShell {
  const current = shells.get(doc);
  if (current) return current;
  const shell = new WorkspaceShell(doc, onNavigate);
  shells.set(doc, shell);
  return shell;
}
