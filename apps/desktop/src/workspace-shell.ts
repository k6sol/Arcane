/// <reference lib="dom" />

const shells = new WeakMap<Document, WorkspaceShell>();

/** StudioWorkbench emits this only for observed asset activity; it grants no authority. */
export const WORKSPACE_ASSET_ACTIVITY_EVENT = 'workspace:assetactivity';
export interface WorkspaceAssetActivity { jobId: string; state: 'queued' | 'running' | 'succeeded' }
interface PreviewPresentation { open: boolean; seenJobs: Set<string>; returnFocus: HTMLElement | null }
// Keep presentation choices across pagehide/pageshow on the same document, without storage.
const previewPresentations = new WeakMap<Document, PreviewPresentation>();
const PREVIEW_JOB_LIMIT = 256;

function assetActivity(value: unknown): WorkspaceAssetActivity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Copy only two bounded data fields. No text, URLs, paths, or accessor execution.
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== 2 || !fields.jobId || !fields.state ||
      !('value' in fields.jobId) || !('value' in fields.state)) return null;
  const jobId: unknown = fields.jobId.value, state: unknown = fields.state.value;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobId) ||
      (state !== 'queued' && state !== 'running' && state !== 'succeeded')) return null;
  return { jobId, state };
}

export type WorkspaceTool = 'all' | 'blender' | 'roblox';
export interface WorkspaceToolChange { tool: WorkspaceTool }
const TOOL_PRESENTATION: Record<WorkspaceTool, { label: string; heading: string; description: string; settings: string }> = {
  all: { label: 'All tools', heading: 'Your workspace', description: 'Models and scenes.', settings: 'workspace-settings' },
  blender: { label: 'Blender', heading: 'Blender workspace', description: 'Models, materials, textures and animation.', settings: 'asset-heading' },
  roblox: { label: 'Roblox Studio', heading: 'Roblox Studio workspace', description: 'Scenes, scripts and game systems.', settings: 'session-heading' },
};
const workspaceTool = (value: string | null): WorkspaceTool | null =>
  value === 'all' || value === 'blender' || value === 'roblox' ? value : null;

interface NavigationMatch { id: string; key: string; label: string; score: number; tool: WorkspaceTool | null }
const searchText = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();

/** Every term must match; exact labels and word prefixes lead the results. */
function matchScore(label: string, keywords: string, query: string): number | null {
  if (!query) return 0;
  const name = searchText(label), extra = searchText(keywords), words = name.split(/\s+/);
  const terms = [...new Set(query.split(/\s+/))];
  if (!terms.every(term => (name + ' ' + extra).includes(term))) return null;
  let score = name === query ? 1000 : name.startsWith(query) ? 750 : name.includes(query) ? 500 : 0;
  for (const term of terms) score += words.includes(term) ? 90 : words.some(word => word.startsWith(term)) ? 70 : name.includes(term) ? 40 : 15;
  return score;
}

/** Presentation-only navigation. Native actions remain in the existing panels. */
export class WorkspaceShell {
  private readonly removers: (() => void)[] = [];
  private readonly focusTargets = new Set<HTMLElement>();
  private readonly navigation: HTMLElement[];
  private searchResults: HTMLElement | null = null;
  private openSearch: (() => void) | null = null;
  private readonly recentTargets: string[] = [];
  private disposed = false;
  private fullscreenBusy = false;
  private tool: WorkspaceTool = 'all';
  private settingsReturnFocus: HTMLElement | null = null;
  private settingsSections: HTMLElement[] = [];

  get activeTool(): WorkspaceTool { return this.tool; }

  constructor(private readonly doc: Document, private readonly onNavigate?: () => void) {
    this.navigation = Array.from(doc.querySelectorAll<HTMLElement>('[data-workspace-target]'));
    for (const control of this.navigation) {
      if (control.classList.contains('is-active')) control.setAttribute('aria-current', 'page');
      if (['new-chat', 'sidebar-toggle', 'preview-expand', 'preview-settings', 'workspace-preview-toggle', 'workspace-preview-close', 'preview-model-tab', 'preview-files-tab'].includes(control.id) || control.hasAttribute('data-draft')) continue;
      this.button(control, () => {
        const tool = workspaceTool(control.getAttribute('data-workspace-tool'));
        if (tool) this.selectTool(tool);
        else this.navigate(control.getAttribute('data-workspace-target'));
      }, control.hasAttribute('data-workspace-tool'));
    }
    for (const control of doc.querySelectorAll<HTMLElement>('[data-draft]')) this.button(control, () => {
      const tool = workspaceTool(control.getAttribute('data-workspace-tool'));
      if (tool) { this.selectTool(tool); return; }
      const draft = control.getAttribute('data-draft');
      if (draft !== null) this.openComposer(draft);
    }, control.hasAttribute('data-workspace-tool'));
    const newChat = doc.getElementById('new-chat');
    newChat?.setAttribute('type','button');
    if (newChat && newChat.getAttribute('data-chat-action') !== 'new') {
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
    // File attachments are handled by the scoped chat controller. Selecting a
    // workspace tool must never inject generic instructions into the draft.
    this.bindSearch();
    this.bindSettingsDrawer();
    this.bindToolSwitcher();
    this.bindPreviewPresentation();
    this.bindArtifactTabs();
    this.bindPreviews();
    this.bindShortcuts();
  }

  cleanup(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeSettings(false);
    for (const remove of this.removers.splice(0)) remove();
    this.searchResults?.remove();
    this.searchResults = null;
    this.openSearch = null;
    this.recentTargets.length = 0;
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
    const drawer = this.settingsDialog();
    if (drawer) {
      if (drawer.contains(target)) {
        const section = target.closest<HTMLElement>('[data-settings-section]');
        if (section) this.selectSettingsSection(section);
        if (!drawer.open && typeof drawer.showModal === 'function') {
          this.settingsReturnFocus = this.doc.activeElement as HTMLElement | null;
          try { drawer.showModal(); } catch { this.notice('Settings could not be opened. Please try again.'); return; }
        }
      } else if (drawer.open) this.closeSettings(false);
    }
    // Only explicit navigation opens settings; startup and tool selection do not.
    for (let ancestor: HTMLElement | null = target; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open')) ancestor.setAttribute('open', '');
    }
    if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
      this.focusTargets.add(target);
    }
    const home = target.id === 'codex-heading' || target.id === 'codex-composer';
    const scrollTarget = home ? this.doc.getElementById('workspace-stage') ?? this.doc.getElementById('workspace-topbar') ?? target : target;
    scrollTarget.scrollIntoView?.({ block: 'start' });
    target.focus?.({ preventScroll: true });
  }

  private settingsDialog(): HTMLDialogElement | null {
    const element = this.doc.getElementById('settings-drawer');
    return element?.tagName === 'DIALOG' ? element as HTMLDialogElement : null;
  }

  private closeSettings(restoreFocus = true): void {
    const drawer = this.settingsDialog(), target = this.settingsReturnFocus;
    this.settingsReturnFocus = null;
    if (drawer?.open) this.onNavigate?.();
    if (drawer?.open && typeof drawer.close === 'function') drawer.close();
    if (restoreFocus && target?.isConnected && !target.closest('[hidden], [inert]')) target.focus?.({ preventScroll: true });
  }

  private bindSettingsDrawer(): void {
    const drawer = this.settingsDialog();
    if (!drawer) return;
    this.settingsSections = Array.from(drawer.querySelectorAll<HTMLElement>('[data-settings-section]'));
    const navigation = Array.from(drawer.querySelectorAll<HTMLButtonElement>('[data-settings-section-target]'));
    const search = this.doc.getElementById('settings-search') as HTMLInputElement | null;
    const filter = () => {
      const query = searchText(search?.value ?? '');
      const matches: HTMLElement[] = [];
      for (const control of navigation) {
        const section = this.settingsSections.find(section => section.id === control.getAttribute('data-settings-section-target'));
        const labels = section ? Array.from(section.querySelectorAll('h2, h3, label, summary')).map(label => label.textContent ?? '').join(' ') : '';
        control.hidden = !section || matchScore(control.textContent ?? '', labels, query) === null;
        if (!control.hidden && section) matches.push(section);
      }
      const empty = this.doc.getElementById('settings-search-empty');
      if (empty) empty.hidden = matches.length !== 0;
      const current = this.settingsSections.find(section => !section.hidden);
      if (matches.length && (!current || !matches.includes(current))) {
        this.onNavigate?.(); this.selectSettingsSection(matches[0]!);
      } else if (!matches.length) {
        this.onNavigate?.();
        for (const section of this.settingsSections) section.hidden = true;
        for (const control of navigation) control.removeAttribute('aria-current');
      }
    };
    if (search) this.listen(search, 'input', filter);
    for (const control of navigation) this.button(control, () => {
      const section = this.settingsSections.find(section => section.id === control.getAttribute('data-settings-section-target'));
      if (section) this.focus(section);
    });
    for (const control of drawer.querySelectorAll<HTMLElement>('[data-settings-close]')) this.button(control, () => this.closeSettings());
    this.listen(drawer, 'cancel', event => { event.preventDefault(); this.closeSettings(); });
    this.listen(drawer, 'close', () => {
      // A queued close from an earlier opening must not affect the current modal.
      if (drawer.open) return;
      this.onNavigate?.(); if (this.settingsReturnFocus) this.closeSettings();
    });
    this.listen(drawer, 'click', event => {
      if (event.target !== drawer) return;
      const input = event as MouseEvent, bounds = drawer.getBoundingClientRect();
      if (input.clientX < bounds.left || input.clientX > bounds.right || input.clientY < bounds.top || input.clientY > bounds.bottom) this.closeSettings();
    });
    // Presentation-only requests: they do not probe, log in, grant permissions or submit.
    this.listen(this.doc, 'workspace:settingsrequest', event => {
      const detail: unknown = (event as CustomEvent).detail;
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return;
      const fields = Object.getOwnPropertyDescriptors(detail);
      if (Reflect.ownKeys(fields).length !== 1 || !fields.target || !('value' in fields.target)) return;
      const id: unknown = fields.target.value;
      if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/.test(id)) return;
      const target = this.doc.getElementById(id);
      if (target && drawer.contains(target)) this.navigate(id);
    });
  }

  private selectSettingsSection(section: HTMLElement): void {
    for (const page of this.settingsSections) page.hidden = page !== section;
    for (const control of this.doc.querySelectorAll<HTMLElement>('[data-settings-section-target]')) {
      if (control.getAttribute('data-settings-section-target') === section.id) control.setAttribute('aria-current', 'page');
      else control.removeAttribute('aria-current');
    }
    // A section request from elsewhere in the shell must remain reachable after a search.
    const active = this.doc.activeElement;
    if (active?.id !== 'settings-search') {
      const search = this.doc.getElementById('settings-search') as HTMLInputElement | null;
      if (search) search.value = '';
      for (const control of this.doc.querySelectorAll<HTMLElement>('[data-settings-section-target]')) control.hidden = false;
      const empty = this.doc.getElementById('settings-search-empty'); if (empty) empty.hidden = true;
    }
  }

  private bindToolSwitcher(): void {
    for (const switcher of this.doc.querySelectorAll<HTMLDetailsElement>('.tool-switcher')) {
      const close = (restore = false) => {
        if (!switcher.open) return;
        switcher.open = false;
        if (restore) switcher.querySelector<HTMLElement>('summary')?.focus();
      };
      this.listen(this.doc, 'pointerdown', event => {
        if (event.target && !switcher.contains(event.target as Node)) close();
      });
      this.listen(switcher, 'keydown', event => {
        const key = event as KeyboardEvent;
        if (key.key === 'Escape' && !key.isComposing && !event.defaultPrevented) { event.preventDefault(); close(true); }
      });
    }
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
    const section = target.closest<HTMLElement>('[data-settings-section]');
    if (section) this.selectSettingsSection(section);
    if (target.closest('[hidden], [inert]')) return false;
    this.recordVisit('target:' + target.id);
    this.markCurrent(target.id);
    this.focus(target);
    return true;
  }

  private composer(): HTMLTextAreaElement | HTMLInputElement | null {
    const composer = this.doc.getElementById('codex-composer');
    return composer && (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT')
      ? composer as HTMLTextAreaElement | HTMLInputElement : null;
  }

  /** Close settings and dismiss displayed secrets before the chat controller navigates. */
  showConversation(): void { this.openComposer(); }
  showRecordedWork(): void {
    const target=this.doc.getElementById('work-heading');
    if(target)this.focus(target);
  }
  private openComposer(draft?: string): void {
    const composer = this.composer();
    if (!composer) return;
    this.onNavigate?.();
    // Old markup can retain canned tool hints. Routing already comes from native
    // developer instructions; these hints must never become public message text.
    if (draft !== undefined && draft.length && !/^\s*Tool context:/i.test(draft)) {
      const next = composer.value + (composer.value ? '\n\n' : '') + draft;
      const rawLimit = composer.getAttribute('maxlength');
      const limit = rawLimit !== null && /^\d+$/.test(rawLimit) ? Number(rawLimit) : 131072;
      if (next.length > limit || new TextEncoder().encode(next).length > 131072) {
        this.notice('This addition exceeds the message limit. Your draft was preserved.');
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
    const context = TOOL_PRESENTATION[this.tool];
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
    for (const switcher of this.doc.querySelectorAll<HTMLDetailsElement>('.tool-switcher')) {
      const menuFocused = switcher.contains(this.doc.activeElement);
      switcher.open = false;
      if (menuFocused) switcher.querySelector<HTMLElement>('summary')?.focus();
    }
    this.recordVisit('tool:' + tool);
    if (tool === this.tool) return;
    this.tool = tool;
    this.renderTool();
    // Integration signal only: never create/resume a native thread or submit text.
    const CustomEvent = this.doc.defaultView?.CustomEvent;
    if (CustomEvent) this.doc.dispatchEvent(new CustomEvent<WorkspaceToolChange>('workspace:toolchange', {
      detail: { tool }, bubbles: false,
    }));
  }

  private recordVisit(key: string): void {
    const previous = this.recentTargets.indexOf(key);
    if (previous !== -1) this.recentTargets.splice(previous, 1);
    this.recentTargets.unshift(key);
    this.recentTargets.length = Math.min(this.recentTargets.length, 6);
  }

  private bindShortcuts(): void {
    // Advertise the shortcuts to assistive technology on the controls they act on.
    for (const [id, keys] of [['codex-composer', 'Control+/'], ['claude-chat-input', 'Control+/'], ['codex-model-trigger', 'Control+Shift+M'], ['workspace-search', 'Control+K']] as const)
      this.doc.getElementById(id)?.setAttribute('aria-keyshortcuts', keys);
    for (const control of this.doc.querySelectorAll<HTMLElement>('[data-workspace-target]')) if (control.getAttribute('data-workspace-target') === 'workspace-settings') control.setAttribute('aria-keyshortcuts', 'Control+,');
    this.listen(this.doc, 'keydown', event => {
      const keyboard = event as KeyboardEvent;
      if (event.defaultPrevented || keyboard.isComposing || keyboard.altKey) return;
      if (keyboard.key === 'Escape') { if (!keyboard.ctrlKey && !keyboard.metaKey && !keyboard.shiftKey && this.closePopover()) event.preventDefault(); return; }
      if (keyboard.repeat || !(keyboard.ctrlKey || keyboard.metaKey)) return;
      const key = keyboard.key.toLowerCase();
      // Another modal (settings or a confirmation) owns the keyboard; only Ctrl+/ may leave settings for the composer.
      const modal = this.openDialog(), settingsOnly = !modal || modal === this.settingsDialog();
      if (keyboard.shiftKey) {
        if (key === 'm' && !modal) {
          const trigger = this.doc.getElementById('codex-model-trigger') as HTMLButtonElement | null;
          if (!this.shown(trigger) || trigger.disabled) return;
          event.preventDefault();
          if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
        }
        return;
      }
      if (key === 'n' && this.doc.getElementById('new-chat')?.getAttribute('data-chat-action') !== 'new' && this.composer()) { event.preventDefault(); this.openComposer(); }
      if (key === 'k') {
        const search = this.doc.getElementById('workspace-search');
        const editable = (event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]');
        if (!search || (editable && editable !== search && editable.getAttribute('contenteditable') !== 'false')) return;
        event.preventDefault(); this.focus(search); this.openSearch?.();
      }
      if ((key === '/' || keyboard.code === 'Slash') && settingsOnly) {
        const codex = this.composer(), claude = this.doc.getElementById('claude-chat-input');
        if (this.shown(codex)) { event.preventDefault(); this.openComposer(); }
        else if (this.shown(claude)) { event.preventDefault(); if (modal) this.closeSettings(false); claude.focus(); }
      }
      if (key === ',' && settingsOnly) { event.preventDefault(); this.navigate('workspace-settings'); }
      if (key === 'w' && !modal) {
        // Same control and rules as the visible tab's own close button: a disabled close (busy turn) stays closed.
        for (const id of ['workspace-chat-tabs', 'claude-chat-tabs']) {
          const strip = this.doc.getElementById(id), tab = Array.from(strip?.querySelectorAll<HTMLElement>('button') ?? []).find(node => node.getAttribute('role') === 'tab' && node.getAttribute('aria-selected') === 'true');
          if (!this.shown(strip) || !tab) continue;
          const close = Array.from(tab.parentElement?.children ?? []).find(node => node !== tab && node.tagName === 'BUTTON') as HTMLButtonElement | undefined;
          if (close && !close.disabled) { event.preventDefault(); close.click(); }
          return;
        }
      }
    });
  }

  /** Visible to the person: present, not inside a hidden or inert subtree, and laid out. */
  private shown(element: Element | null): element is HTMLElement {
    if (!element || element.closest('[hidden], [inert]')) return false;
    const rects = (element as HTMLElement).getClientRects?.();
    return !rects || rects.length > 0;
  }

  private openDialog(): HTMLDialogElement | null {
    return Array.from(this.doc.querySelectorAll<HTMLDialogElement>('dialog')).find(dialog => dialog.hasAttribute('open')) ?? null;
  }

  /** Escape outside a popover closes the open one, using the same control a click would. */
  private closePopover(): boolean {
    if (this.openDialog()) return false;
    const picker = this.doc.getElementById('codex-model-popover'), trigger = this.doc.getElementById('codex-model-trigger') as HTMLButtonElement | null;
    if (picker && !picker.hidden && trigger && !trigger.disabled) { trigger.click(); trigger.focus(); return true; }
    for (const menu of this.doc.querySelectorAll<HTMLDetailsElement>('details')) {
      if (!menu.open || !(menu.classList.contains('chat-tabs-history') || menu.classList.contains('tool-switcher'))) continue;
      menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus(); return true;
    }
    const dock = Array.from(this.doc.getElementById('studio-diagnostics')?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(node => node.getAttribute('aria-expanded') === 'true');
    if (dock) { dock.click(); dock.focus(); return true; }
    return false;
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
      // A close may arrive while the browser is still entering fullscreen.
      if (!this.disposed && preview.hidden && this.doc.fullscreenElement === preview && typeof this.doc.exitFullscreen === 'function') await this.doc.exitFullscreen();
      if (!this.disposed) { sync(); this.notice(''); }
    } catch {
      this.notice('Unable to change preview fullscreen. Use your browser fullscreen controls.');
    } finally { this.fullscreenBusy = false; }
  }

  private bindPreviewPresentation(): void {
    const stage = this.doc.getElementById('workspace-stage'), preview = this.doc.getElementById('artifact-panel');
    if (!stage || !preview) return;
    const toggle = this.doc.getElementById('workspace-preview-toggle'), close = this.doc.getElementById('workspace-preview-close');
    let presentation = previewPresentations.get(this.doc);
    if (!presentation) {
      presentation = { open: false, seenJobs: new Set(), returnFocus: null };
      previewPresentations.set(this.doc, presentation);
    }
    const state = presentation;
    const sync = () => {
      preview.hidden = !state.open;
      stage.classList.toggle('preview-open', state.open);
      toggle?.setAttribute('aria-controls', preview.id);
      toggle?.setAttribute('aria-expanded', String(state.open));
      toggle?.setAttribute('aria-pressed', String(state.open));
      toggle?.setAttribute('aria-label', state.open ? 'Hide model preview' : 'Show model preview');
    };
    const usable = (target: HTMLElement | null): target is HTMLElement =>
      !!target && target.isConnected && typeof target.focus === 'function' && !target.closest('[hidden], [inert], [disabled]');
    const restoreFocus = () => {
      const target = [state.returnFocus, toggle, this.composer()].find(usable);
      state.returnFocus = null;
      if (target) this.focus(target);
    };
    const setOpen = (open: boolean, manual = false) => {
      if (this.disposed || state.open === open) return;
      if (open) {
        const active = this.doc.activeElement as HTMLElement | null;
        state.returnFocus = manual ? toggle : usable(active) && active !== this.doc.body && !preview.contains(active) ? active : this.composer();
      }
      state.open = open;
      sync();
      if (manual && open) this.focus(close ?? preview);
      if (!open) {
        if (this.doc.fullscreenElement === preview && typeof this.doc.exitFullscreen === 'function') {
          void this.doc.exitFullscreen().catch(() => {
            this.notice('Unable to exit preview fullscreen. Use your browser fullscreen controls.');
          });
        }
        restoreFocus();
      }
    };
    if (toggle) this.button(toggle, () => setOpen(!state.open, true));
    if (close) this.button(close, () => setOpen(false, true));
    this.listen(preview, 'keydown', event => {
      const key = event as KeyboardEvent;
      if (!state.open || this.settingsDialog()?.open || event.defaultPrevented || key.key !== 'Escape' || key.isComposing || key.repeat ||
          key.ctrlKey || key.metaKey || key.altKey || key.shiftKey || this.doc.fullscreenElement === preview) return;
      event.preventDefault();
      setOpen(false, true);
    });
    this.listen(this.doc, WORKSPACE_ASSET_ACTIVITY_EVENT, event => {
      if (this.disposed) return;
      const activity = assetActivity((event as CustomEvent<unknown>).detail);
      if (!activity || state.seenJobs.has(activity.jobId) || state.seenJobs.size >= PREVIEW_JOB_LIMIT) return;
      // Completion alone is not a loaded preview. The producer emits succeeded
      // after appending its verified, decoded canvas, never for empty placeholders.
      if (activity.state === 'succeeded') {
        const canvases = this.doc.getElementById('asset-previews')?.querySelectorAll<HTMLCanvasElement>('figure canvas[role="img"]');
        const model = this.doc.getElementById('asset-viewer')?.querySelector<HTMLCanvasElement>('canvas[role="img"]');
        if ((!canvases || !Array.from(canvases).some(canvas => canvas.width > 0 && canvas.height > 0)) && (!model || model.width <= 0 || model.height <= 0)) return;
      }
      // Once observed, this identity cannot reopen a deliberately closed panel,
      // even after another job, repeated polls, canvas replacements or pageshow.
      state.seenJobs.add(activity.jobId);
      setOpen(true);
    });
    sync();
  }

  private bindArtifactTabs(): void {
    const model = this.doc.getElementById('preview-model-tab'), files = this.doc.getElementById('preview-files-tab');
    const stage = this.doc.getElementById('artifact-stage'), exports = this.doc.getElementById('artifact-files');
    if (!model || !files || !stage || !exports) return;
    let selected: 'preview' | 'files' = 'preview';
    const seen = new Set<string>();
    const sync = () => {
      if (this.disposed) return;
      if (exports.childElementCount === 0) {
        const empty = this.doc.createElement('p'); empty.className = 'hint'; empty.textContent = 'Exports will appear here.'; exports.append(empty);
      }
      for (const [tab, name, panel] of [[model, 'preview', stage], [files, 'files', exports]] as const) {
        const active = selected === name;
        if (tab.getAttribute('aria-selected') !== String(active)) tab.setAttribute('aria-selected', String(active));
        tab.setAttribute('tabindex', active ? '0' : '-1'); tab.classList.toggle('is-active', active);
        if (panel.hidden !== !active) panel.hidden = !active;
      }
    };
    const choose = (tab: 'preview' | 'files', focus = false) => { selected = tab; sync(); if (focus) this.focus(tab === 'preview' ? model : files); };
    this.button(model, () => choose('preview')); this.button(files, () => choose('files'));
    for (const tab of [model, files]) this.listen(tab, 'keydown', event => {
      const key = event as KeyboardEvent;
      if (key.altKey || key.ctrlKey || key.metaKey || key.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key.key)) return;
      event.preventDefault(); choose(key.key === 'Home' ? 'preview' : key.key === 'End' ? 'files' : selected === 'preview' ? 'files' : 'preview', true);
    });
    this.listen(this.doc, WORKSPACE_ASSET_ACTIVITY_EVENT, event => {
      const activity = assetActivity((event as CustomEvent<unknown>).detail);
      if (!activity || seen.has(activity.jobId) || seen.size >= PREVIEW_JOB_LIMIT) return;
      seen.add(activity.jobId); choose('preview');
    });
    const Observer = this.doc.defaultView?.MutationObserver;
    if (Observer) {
      const observer = new Observer(sync);
      // The download owner replaces content/visibility after each verified
      // manifest. Keep that content in the selected tab; never issue reads.
      observer.observe(exports, { childList: true, attributes: true, attributeFilter: ['hidden'] });
      this.removers.push(() => observer.disconnect());
    }
    sync();
  }
  private bindPreviews(): void {
    const previews = this.doc.getElementById('asset-previews');
    if (!previews) return;
    const summary = this.doc.getElementById('asset-job-summary'), status = this.doc.getElementById('preview-guide-status');
    const emptyTitle = this.doc.getElementById('preview-empty-title'), emptyDescription = this.doc.getElementById('preview-empty-description');
    let selected: HTMLElement | null = null;
    let figures: HTMLElement[] = [];
    const sync = (refreshFigures = true) => {
      if(refreshFigures)figures = Array.from(previews.querySelectorAll<HTMLElement>('figure')).filter(figure => figure.querySelector('canvas'));
      if (!selected || !figures.includes(selected)) selected = figures.find(figure => figure.getAttribute('aria-pressed') === 'true') ?? figures[0] ?? null;
      for (const figure of figures) {
        if(figure.getAttribute('role')!=='button')figure.setAttribute('role', 'button');
        if(figure.getAttribute('tabindex')!=='0')figure.setAttribute('tabindex', '0');
        const pressed=figure===selected;
        if(figure.getAttribute('aria-pressed')!==String(pressed))figure.setAttribute('aria-pressed', String(pressed));
        if(figure.classList.contains('is-selected')!==pressed)figure.classList.toggle('is-selected', pressed);
      }
      if (status) {
        const building = summary?.getAttribute('data-asset-state') === 'running';
        const slug = summary?.getAttribute('data-asset-name') ?? '';
        const name = /^[a-z][a-z0-9-]{0,47}$/.test(slug) ? slug.replaceAll('-', ' ') : 'model';
        const title = building ? 'Building ' + name : 'Preview your work';
        if (emptyTitle && emptyTitle.textContent !== title) emptyTitle.textContent = title;
        const description = building ? 'Your preview will appear here.' : 'Your completed models appear here.';
        if (emptyDescription && emptyDescription.textContent !== description) emptyDescription.textContent = description;
        const text = figures.length ? (summary?.textContent ?? '')
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
          .replace(/\barcane_local_v1_[0-9]+_[a-f0-9]{64}\b/g, '[REDACTED]')
          .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
          .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 2048)
          : building ? 'Building ' + name + '…' : 'No model is selected. Nothing is generated automatically.';
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
      const observer = new Observer(records => sync(!records || records.some(record => previews.contains(record.target))));
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
    results.hidden = true;
    search.parentElement.append(results);
    this.searchResults = results;
    const title = this.doc.createElement('p');
    title.className = 'workspace-search-title';
    const options = this.doc.createElement('div');
    options.id = 'workspace-search-options';
    options.className = 'workspace-search-options';
    options.setAttribute('role', 'listbox');
    options.setAttribute('aria-label', 'Workspace tools');
    const status = this.doc.createElement('p');
    status.className = 'workspace-search-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    results.append(title, options, status);
    const attributes = ['role', 'aria-controls', 'aria-expanded', 'aria-autocomplete', 'aria-haspopup', 'aria-activedescendant'];
    const previousAttributes = attributes.map(name => [name, search.getAttribute(name)] as const);
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-controls', options.id);
    search.setAttribute('aria-autocomplete', 'list');
    search.setAttribute('aria-haspopup', 'listbox');
    let selected = -1;
    const select = (index: number, scroll = false) => {
      const rows = Array.from(options.querySelectorAll<HTMLElement>('button'));
      selected = rows.length ? Math.max(0, Math.min(index, rows.length - 1)) : -1;
      for (const [position, row] of rows.entries()) row.setAttribute('aria-selected', String(position === selected));
      const active = rows[selected];
      if (active) {
        search.setAttribute('aria-activedescendant', active.id);
        if (scroll) active.scrollIntoView?.({ block: 'nearest' });
      } else search.removeAttribute('aria-activedescendant');
    };
    const close = () => {
      results.hidden = true;
      search.setAttribute('aria-expanded', 'false');
      search.removeAttribute('aria-activedescendant');
      selected = -1;
    };
    close();
    this.removers.push(() => {
      for (const [name, value] of previousAttributes) {
        if (value === null) search.removeAttribute(name); else search.setAttribute(name, value);
      }
    });
    const render = () => {
      this.onNavigate?.();
      options.replaceChildren();
      const query = searchText(search.value.slice(0, 256));
      const matches = new Map<string, NavigationMatch>(), sidebar = this.doc.getElementById('app-sidebar');
      for (const item of this.doc.querySelectorAll<HTMLElement>('[data-workspace-target], [data-search-item]')) {
        if (results.contains(item) || item.closest('[hidden], [inert]') || item.hasAttribute('disabled') || item.hasAttribute('data-draft')) continue;
        if (!sidebar?.contains(item) && !item.hasAttribute('data-search-item')) continue;
        const keywords = item.getAttribute('data-search-item') ?? '';
        const id = item.getAttribute('data-workspace-target') || (this.doc.getElementById(keywords) ? keywords : item.id);
        const target = id ? this.doc.getElementById(id) : null;
        if (!target || target.closest('[hidden], [inert]')) continue;
        // Search navigation labels and headings, never entire panel transcripts.
        const heading = item.querySelector<HTMLElement>('h1, h2, h3');
        const labelledBy = this.doc.getElementById(item.getAttribute('aria-labelledby') ?? '');
        const label = (item.getAttribute('aria-label') || item.getAttribute('data-search-label') || labelledBy?.textContent || heading?.textContent
          || (/^(A|BUTTON|H[1-6])$/.test(item.tagName) ? item.textContent : ''))?.trim();
        if (!label) continue;
        const tool = workspaceTool(item.getAttribute('data-workspace-tool'));
        const key = tool ? 'tool:' + tool : 'target:' + id;
        const score = matchScore(label, keywords, query);
        if (score === null || (matches.get(key)?.score ?? -1) >= score) continue;
        matches.set(key, { id, key, label, score, tool });
      }
      const ranked = [...matches.values()].sort((a, b) => {
        if (query) return b.score - a.score;
        const recentA = this.recentTargets.indexOf(a.key), recentB = this.recentTargets.indexOf(b.key);
        return (recentA < 0 ? 6 : recentA) - (recentB < 0 ? 6 : recentB);
      }).slice(0, 16);
      title.textContent = query ? 'Workspace matches' : this.recentTargets.length ? 'Recent & workspace tools' : 'Jump to a tool';
      for (const [index, match] of ranked.entries()) {
        const button = this.doc.createElement('button');
        button.type = 'button';
        button.id = 'workspace-search-option-' + index;
        button.setAttribute('role', 'option');
        button.setAttribute('tabindex', '-1');
        button.setAttribute('data-workspace-target', match.id);
        if (match.tool) button.setAttribute('data-workspace-tool', match.tool);
        button.textContent = match.label;
        options.append(button);
      }
      status.textContent = ranked.length ? `${ranked.length} ${ranked.length === 1 ? 'tool' : 'tools'} · Arrow keys to choose · Enter to open` : 'No matching workspace sections. Try a tool name or keyword.';
      results.hidden = false;
      search.setAttribute('aria-expanded', 'true');
      select(0);
    };
    this.openSearch = render;
    this.listen(search, 'focus', render);
    this.listen(search, 'input', render);
    // Keep DOM focus in the combobox while its active option is announced.
    this.listen(results, 'mousedown', event => { event.preventDefault(); });
    this.listen(results, 'click', event => {
      const control = (event.target as Element | null)?.closest?.('button[data-workspace-target]');
      if (!control || !results.contains(control)) return;
      event.preventDefault();
      const tool = workspaceTool(control.getAttribute('data-workspace-tool'));
      if (tool) { this.selectTool(tool); close(); }
      else if (this.navigate(control.getAttribute('data-workspace-target'))) close();
    });
    this.listen(search, 'keydown', event => {
      const keyboard = event as KeyboardEvent, key = keyboard.key;
      if (keyboard.isComposing || keyboard.ctrlKey || keyboard.metaKey || keyboard.altKey) return;
      if (key === 'Escape') { event.preventDefault(); close(); }
      if (key === 'Enter') {
        event.preventDefault();
        const active = results.hidden ? null : options.querySelectorAll<HTMLElement>('button')[selected];
        if (active) {
          const tool = workspaceTool(active.getAttribute('data-workspace-tool'));
          if (tool) { this.selectTool(tool); close(); }
          else if (this.navigate(active.getAttribute('data-workspace-target'))) close();
        }
      }
      if (key === 'Tab') close();
      if ((key === 'ArrowDown' || key === 'ArrowUp') && !keyboard.shiftKey) {
        event.preventDefault();
        if (results.hidden) {
          render();
          if (key === 'ArrowUp') select(options.children.length - 1, true);
        } else select(selected + (key === 'ArrowDown' ? 1 : -1), true);
      }
    });
    this.listen(results, 'keydown', event => {
      if ((event as KeyboardEvent).key === 'Escape') { event.preventDefault(); this.focus(search); close(); }
    });
    this.listen(this.doc, 'pointerdown', event => {
      const target = event.target as Node | null;
      if (target && target !== search && !results.contains(target)) close();
    });
    this.listen(this.doc, 'focusin', event => {
      const target = event.target as Node | null;
      if (target && target !== search && !results.contains(target)) close();
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
