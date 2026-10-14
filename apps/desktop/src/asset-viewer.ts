/// <reference lib="dom" />
import { fetchVerifiedArtifact, readDownloadArtifacts } from './asset-downloads.js';
import { validateGlb } from './glb-preflight.js';

export interface ViewerRuntime {
  reset(): void;
  setView(value: 'perspective' | 'front' | 'side' | 'top'): void;
  setMode(value: 'rendered' | 'wireframe' | 'clay'): void;
  setLighting(value: 'studio' | 'soft' | 'dramatic'): void;
  setAnimationPlaying(value: boolean): void;
  animations(): { index: number; name: string; duration: number }[];
  animationState(): { index: number; time: number; duration: number; playing: boolean; speed: number; loop: boolean };
  selectAnimation(index: number): void;
  seekAnimation(seconds: number): void;
  setAnimationSpeed(speed: number): void;
  setAnimationLoop(loop: boolean): void;
  stats(): { triangles: number; materials: number; drawCalls?: number; dimensions: { x: number; y: number; z: number } };
  hasAnimations: boolean;
  dispose(): void;
}
export interface ViewerModule {
  createAssetViewer(options: { host: HTMLElement; bytes: ArrayBuffer; label: string; signal: AbortSignal; onStatus: (message: string) => void }): Promise<ViewerRuntime>;
}
interface ViewerOptions { transport?: typeof fetch; loadRuntime?: () => Promise<ViewerModule>; deadlineMs?: number }
const runtimePath = '/asset-viewer-runtime.mjs';
const loadRuntime = (): Promise<ViewerModule> => import(runtimePath);
const clean = (value: string): string => value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 120);
function bounded<T>(operation: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let abandoned = false;
    const abort = () => { abandoned = true; reject(new Error('Preview cancelled.')); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    void operation.then(value => {
      signal.removeEventListener('abort', abort);
      if (abandoned || signal.aborted) late?.(value); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); if (!abandoned) reject(error); });
  });
}

/** Exact manifest -> bounded authenticated bytes -> checksum -> data preflight -> GPU.
 * No provider calls, filesystem discovery, CDN, demo model or persistent asset cache.
 * The caller's current() fences project/chat/job identity as well as this local epoch.
 */
export class AssetViewerPanel {
  private epoch = 0;
  private controller: AbortController | null = null;
  private runtime: ViewerRuntime | null = null;
  private removeControls: (() => void)[] = [];
  private clock: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly doc: Document, private readonly token: string, private readonly options: ViewerOptions = {}) {}
  clear(): void {
    this.epoch++;
    this.controller?.abort(); this.controller = null;
    this.runtime?.dispose(); this.runtime = null;
    for (const remove of this.removeControls.splice(0)) remove();
    if (this.clock) clearTimeout(this.clock); this.clock = null;
    const root = this.doc.getElementById('asset-viewer');
    if (root) { root.replaceChildren(); root.hidden = true; }
  }
  async show(manifest: unknown, jobId: string, current: () => boolean): Promise<void> {
    this.clear();
    const root = this.doc.getElementById('asset-viewer');
    if (!root || !current()) return;
    const epoch = this.epoch, controller = new AbortController(); this.controller = controller;
    const active = () => epoch === this.epoch && this.controller === controller && !controller.signal.aborted && current();
    const status = this.make('p', 'Verifying 3D model…', 'viewer-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const setStatus = (message: string) => {
      if (!active()) return;
      // Renderer notifications are trusted code, but its nested decoder errors
      // may contain untrusted asset strings. Only publish known UI messages.
      status.textContent = message === '3D preview ready.' ? '3D preview ready.' :
        message === 'Drag to orbit · Right-drag to pan · Scroll to zoom' ? message :
        message.startsWith('WebGL context lost.') ? '3D preview interrupted. Reload the asset to continue.' :
        message.startsWith('3D preview stopped:') ? '3D preview stopped. Check the export’s validation report.' : 'Loading 3D preview…';
    };
    const host = this.make('div', undefined, 'viewer-canvas'); host.setAttribute('aria-label', 'Interactive asset preview');
    root.append(host, status); root.hidden = false;
    const timer = setTimeout(() => { controller.abort(); if (epoch === this.epoch && current()) status.textContent = '3D preview timed out. Reload the asset to try again.'; }, this.options.deadlineMs ?? 45000);
    try {
      const artifact = readDownloadArtifacts(manifest, jobId).find(row => row.path === 'asset.glb');
      if (!artifact) { if (active()) { root.replaceChildren(); root.hidden = true; } return; }
      const blob = await bounded(fetchVerifiedArtifact(artifact, this.token, controller.signal, this.options.transport), controller.signal);
      if (!active()) return;
      const bytes = await bounded(blob.arrayBuffer(), controller.signal);
      if (!active()) return;
      validateGlb(bytes);
      if (!active()) return;
      setStatus('Loading 3D preview…');
      const module = await bounded((this.options.loadRuntime ?? loadRuntime)(), controller.signal);
      if (!active()) return;
      const runtime = await bounded(module.createAssetViewer({ host, bytes, label: artifact.filename, signal: controller.signal, onStatus: setStatus }), controller.signal, value => value.dispose());
      if (!active()) { runtime.dispose(); return; }
      this.runtime = runtime;
      this.controls(root, host, runtime, active);
      setStatus('Drag to orbit · Right-drag to pan · Scroll to zoom');
      const EventType = this.doc.defaultView?.CustomEvent;
      if (EventType) this.doc.dispatchEvent(new EventType('workspace:assetactivity', { detail: { jobId, state: 'succeeded' } }));
    } catch {
      if (epoch === this.epoch) { this.runtime?.dispose(); this.runtime = null; }
      // Do not echo loader/network errors or untrusted GLB names into the product.
      if (epoch === this.epoch && current() && !controller.signal.aborted) status.textContent = '3D preview unavailable. Check the asset’s export and validation report.';
    } finally {
      clearTimeout(timer);
      if (!current() && epoch === this.epoch) this.clear();
    }
  }
  private make<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const element = this.doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  private listen(element: HTMLElement, event: string, action: () => void): void {
    element.addEventListener(event, action); this.removeControls.push(() => element.removeEventListener(event, action));
  }
  private controls(root: HTMLElement, host: HTMLElement, runtime: ViewerRuntime, active: () => boolean): void {
    const bar = this.make('div', undefined, 'viewer-toolbar'); bar.setAttribute('aria-label', '3D preview controls');
    const choice = (label: string, values: readonly string[], apply: (value: string) => void) => {
      const select = this.make('select'); select.setAttribute('aria-label', label);
      for (const value of values) { const option = this.make('option', value.charAt(0).toUpperCase() + value.slice(1)); option.value = value; select.append(option); }
      this.listen(select, 'change', () => { if (active()) apply(select.value); }); bar.append(select); return select;
    };
    choice('View', ['perspective', 'front', 'side', 'top'], value => runtime.setView(value as Parameters<ViewerRuntime['setView']>[0]));
    choice('Display', ['rendered', 'wireframe', 'clay'], value => runtime.setMode(value as Parameters<ViewerRuntime['setMode']>[0]));
    choice('Lighting', ['studio', 'soft', 'dramatic'], value => runtime.setLighting(value as Parameters<ViewerRuntime['setLighting']>[0]));
    const reset = this.make('button', 'Reset view'); reset.type = 'button';
    this.listen(reset, 'click', () => { if (active()) runtime.reset(); }); bar.append(reset); root.insertBefore(bar, host);
    const stats = runtime.stats(), dimensions = stats.dimensions;
    const metrics = this.make('p', undefined, 'viewer-metrics');
    // glTF's physical units are metres, not Roblox studs. Never infer a conversion.
    if (dimensions && Object.values(dimensions).every(v => Number.isFinite(v) && v >= 0)) metrics.textContent = [dimensions.x, dimensions.y, dimensions.z].map(v => v.toFixed(2)).join(' × ') + ' m · ' + stats.triangles.toLocaleString() + ' triangles';
    root.append(metrics);
    if (runtime.hasAnimations) this.animationControls(root, runtime, active);
  }
  private animationControls(root: HTMLElement, runtime: ViewerRuntime, active: () => boolean): void {
    const clips = runtime.animations(); if (!clips.length) return;
    const bar = this.make('div', undefined, 'viewer-animation');
    const select = this.make('select'); select.setAttribute('aria-label', 'Animation clip');
    for (const clip of clips) { const option = this.make('option', clean(clip.name) || 'Clip ' + (clip.index + 1)); option.value = String(clip.index); select.append(option); }
    const play = this.make('button', 'Play'); play.type = 'button'; play.setAttribute('aria-label', 'Play animation');
    const seek = this.make('input'); seek.type = 'range'; seek.min = '0'; seek.step = '.01'; seek.value = '0'; seek.setAttribute('aria-label', 'Animation time');
    const speed = this.make('select'); speed.setAttribute('aria-label', 'Animation speed');
    for (const value of [.25, .5, 1, 1.5, 2]) { const option = this.make('option', value + '×'); option.value = String(value); option.selected = value === 1; speed.append(option); }
    const loopLabel = this.make('label', undefined, 'viewer-loop'), loop = this.make('input'); loop.type = 'checkbox'; loop.checked = runtime.animationState().loop; loopLabel.append(loop, this.doc.createTextNode('Loop')); loop.setAttribute('aria-label', 'Loop animation');
    const sync = () => {
      if (!active()) return;
      const state = runtime.animationState(); seek.max = String(state.duration); seek.value = String(state.time);
      play.textContent = state.playing ? 'Pause' : 'Play'; play.setAttribute('aria-label', state.playing ? 'Pause animation' : 'Play animation'); play.setAttribute('aria-pressed', String(state.playing));
    };
    this.listen(select, 'change', () => { if (active()) { runtime.selectAnimation(Number(select.value)); sync(); } });
    this.listen(play, 'click', () => { if (active()) { runtime.setAnimationPlaying(!runtime.animationState().playing); sync(); } });
    this.listen(seek, 'input', () => { if (active()) { runtime.seekAnimation(Number(seek.value)); sync(); } });
    this.listen(speed, 'change', () => { if (active()) runtime.setAnimationSpeed(Number(speed.value)); });
    this.listen(loop, 'change', () => { if (active()) runtime.setAnimationLoop(loop.checked); });
    bar.append(select, play, seek, speed, loopLabel); root.append(bar); sync();
    const poll = () => {
      if (!active()) return;
      if (!this.doc.hidden && !root.closest('[hidden]')) sync();
      this.clock = setTimeout(poll, 250);
    }; this.clock = setTimeout(poll, 250);
  }
}
