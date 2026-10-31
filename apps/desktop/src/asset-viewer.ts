/// <reference lib="dom" />
import {userError,userErrorText} from './user-errors.js';
import { fetchVerifiedArtifact, readDownloadArtifacts } from './asset-downloads.js';
import { validateGlb } from './glb-preflight.js';
import { AssetReviewCard } from './asset-review.js';

export type ViewerView = 'perspective' | 'front' | 'side' | 'top';
export type ViewerMode = 'rendered' | 'wireframe' | 'clay' | 'normals' | 'uv';
export type ViewerLighting = 'studio' | 'soft' | 'dramatic';
export interface ViewerRuntime {
  reset(): void;
  setView(value: ViewerView): void;
  setMode(value: ViewerMode): void;
  setLighting(value: ViewerLighting): void;
  /** Optional capabilities: older runtimes (and recording fixtures) omit them, and their controls stay hidden. */
  modes?(): readonly string[];
  setTurntable?(value: boolean): void;
  turntable?(): boolean;
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
interface ViewerOptions { transport?: typeof fetch; loadRuntime?: () => Promise<ViewerModule>; loadEffectRuntime?: () => Promise<EffectModule>; deadlineMs?: number; tokenOrigin?: string }
const runtimePath = '/asset-viewer-runtime.mjs';
const loadRuntime = (): Promise<ViewerModule> => import(runtimePath);
const clean = (value: string, limit = 120): string => value.replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, '').slice(0, limit);
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

// ---- Inspector facts: read only from the exact manifest (request + validation). Absent data stays absent. ----
type Tone = 'ok' | 'warn' | 'bad';
export interface ViewerMaterialRow { name: string; detail: string | null; texture: number | null; color: string | null; mapped: boolean }
export interface ViewerFacts {
  name: string | null; kind: string | null; variant: string | null;
  triangles: number | null; budget: number | null; materials: number | null; texture: number | null;
  uv: { value: string; tone: Tone } | null;
  materialRows: ViewerMaterialRow[];
  issues: { tone: Exclude<Tone, 'ok'>; title: string }[];
  passed: string[];
}
type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : null;
const items = (value: unknown, limit = 256): unknown[] => Array.isArray(value) ? value.slice(0, limit) : [];
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const words = (value: unknown, limit = 120): string | null => {
  if (typeof value !== 'string') return null;
  const text = clean(value, limit).trim(); return text || null;
};
const capital = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
const plural = (n: number, one: string, many = one + 's'): string => n.toLocaleString() + ' ' + (n === 1 ? one : many);
const TEMPLATES: Record<string, string> = { 'hero-prop': 'Hero prop', 'environment-kit': 'Environment kit', 'custom-assembly': 'Assembly', procedural: 'Procedural model' };
function kindOf(template: string | null, procedural: Fields | null): string | null {
  const kind = words(procedural?.kind, 24), species = words(procedural?.species, 24);
  if (kind === 'tree') return species ? capital(species) + ' tree' : 'Tree';
  if ((kind === 'log' || kind === 'stump') && species) return capital(species) + ' ' + kind;
  if (kind === 'foliage') return capital(words(procedural?.style, 24) ?? 'foliage');
  if (kind === 'rock') return capital(words(procedural?.form, 24) ?? 'rock');
  if (kind && ['column', 'log', 'stump'].includes(kind)) return capital(kind);
  if (kind) return 'Model';
  return template ? TEMPLATES[template] ?? null : null;
}
function partName(mesh: Fields, assetName: string | null): string | null {
  let name = words(mesh.name, 80); if (!name) return null;
  name = name.replace(/^(?:SM|COL|LOD\d*)_/, '');
  if (assetName && name.startsWith(assetName + '_')) name = name.slice(assetName.length + 1);
  name = name.replace(/[_-]+/g, ' ').trim();
  return name ? capital(name) : null;
}
const colour = (value: unknown): string | null => {
  const c = items(value, 4);
  if (c.length < 3 || !c.slice(0, 3).every(v => typeof v === 'number' && v >= 0 && v <= 1)) return null;
  return 'rgb(' + c.slice(0, 3).map(v => Math.round((v as number) * 255)).join(' ') + ')';
};
export function viewerFacts(manifest: unknown): ViewerFacts {
  const m = fields(manifest), request = fields(m?.request), validation = fields(m?.validation), procedural = fields(request?.procedural);
  const name = words(request?.name), totals = fields(validation?.totals);
  const variantPair = items(procedural?.variant, 3), vi = count(variantPair[0]), vn = count(variantPair[1]);
  const meshes = items(validation?.meshes).map(fields).filter((mesh): mesh is Fields => !!mesh);
  const render = meshes.filter(mesh => mesh.role === 'render');
  const budgetValue = count(request?.triangleBudget), budget = budgetValue && budgetValue > 0 ? budgetValue : null;
  const triangles = count(totals?.renderTriangles);
  // Materials, from the measured per-material evidence (or bare names when that is all the audit kept).
  const rows = new Map<string, ViewerMaterialRow>();
  for (const mesh of render) {
    const part = partName(mesh, name), evidence = items(mesh.materialProperties, 64).map(fields).filter((row): row is Fields => !!row);
    if (evidence.length) for (const material of evidence) {
      const label = words(material.name, 80); if (!label || rows.has(label)) continue;
      const surface = fields(material.surface), images = items(surface?.images, 16).map(fields);
      const sizes = images.flatMap(image => [count(image?.width), count(image?.height)]).filter((n): n is number => !!n);
      const mode = surface?.alphaMode, finish = mode === 'MASK' ? 'alpha cutout' : mode === 'BLEND' ? 'transparent' : null;
      const detail = [part, finish].filter((value): value is string => !!value).join(', ');
      rows.set(label, { name: label, detail: detail ? capital(detail) : null, texture: sizes.length ? Math.max(...sizes) : null, color: colour(material.color), mapped: images.length > 0 });
    } else for (const value of items(mesh.materials, 64)) {
      const label = words(value, 80); if (!label || rows.has(label)) continue;
      rows.set(label, { name: label, detail: part, texture: null, color: null, mapped: false });
    }
  }
  const materialRows = [...rows.values()].slice(0, 24);
  const textures = materialRows.map(row => row.texture).filter((n): n is number => n !== null);
  // UV quality only where the pipeline measured it (natural-finish parts); its own verdicts, never a score.
  const uvReports = render.map(mesh => fields(mesh.uvQuality)).filter((q): q is Fields => !!q);
  const uvErrors = uvReports.reduce((n, q) => n + items(q.errors).length, 0), uvWarnings = uvReports.reduce((n, q) => n + items(q.warnings).length, 0);
  const uv = !uvReports.length ? null : uvErrors ? { value: plural(uvErrors, 'issue'), tone: 'bad' as const }
    : uvWarnings ? { value: plural(uvWarnings, 'warning'), tone: 'warn' as const } : { value: 'Passed', tone: 'ok' as const };
  // Checks: the pipeline's own errors and warnings, then facts that its measurements prove.
  const issues: ViewerFacts['issues'] = [], passed: string[] = [];
  for (const value of items(validation?.errors, 8)) { const title = words(value, 200); if (title) issues.push({ tone: 'bad', title }); }
  for (const mesh of render) for (const value of items(mesh.errors, 4)) {
    const title = words(value, 200), part = partName(mesh, name); if (title) issues.push({ tone: 'bad', title: part ? part + ': ' + title : title });
  }
  for (const value of items(validation?.warnings, 8)) { const title = words(value, 200); if (title) issues.push({ tone: 'warn', title }); }
  if (triangles !== null && budget !== null) {
    if (triangles <= budget) passed.push('Within triangle budget');
    else issues.unshift({ tone: 'bad', title: 'Over the triangle budget by ' + (triangles - budget).toLocaleString() });
  }
  const all = (test: (mesh: Fields) => boolean) => render.length > 0 && render.every(test);
  const zero = (mesh: Fields, ...keys: string[]) => keys.every(key => mesh[key] === 0);
  if (all(mesh => zero(mesh, 'nonManifoldEdges', 'degenerateFaces', 'duplicateFaces'))) passed.push('Closed mesh, no broken faces');
  if (all(mesh => zero(mesh, 'inconsistentNormals', 'invertedComponents'))) passed.push('Consistent normals');
  if (all(mesh => (count(mesh.uvLayers) ?? 0) > 0 && zero(mesh, 'invalidUVs', 'degenerateUVFaces'))) passed.push('UV map on every part, none invalid');
  if (all(mesh => mesh.finitePositions === true)) passed.push('Finite vertex positions');
  if (validation?.savedSceneReopened === true) passed.push('Saved scene reopens');
  if (meshes.some(mesh => mesh.role === 'collision')) passed.push('Collision mesh included');
  return {
    name, kind: kindOf(words(request?.template, 40), procedural), variant: vi && vn && vi <= vn ? vi + ' / ' + vn : null,
    triangles, budget, materials: count(totals?.materials), texture: textures.length ? Math.max(...textures) : null, uv,
    materialRows, issues: issues.slice(0, 10), passed,
  };
}

// ---- Imported assets ("Imported by you"): models from the user's own files and Roblox effect packages. They carry no
// job, manifest or review; the inspector shows facts the daemon measured from the real file and a Remove action. ----
export interface ImportedEffectItemView { className: string; name: string; parent: string | null; position: [number, number, number]; area: [number, number, number] | null; props: Record<string, unknown> }
export interface ImportedEffectView { items: ImportedEffectItemView[]; scripts: number; otherClasses: string[]; clamped: string[]; truncated: boolean }
export interface ImportedViewerAsset {
  id: string; kind: 'model' | 'effect'; format: 'glb' | 'gltf' | 'rbxmx'; name: string; fileName: string; bytes: number; sha256: string; importedAt: string;
  model: { triangles: number; meshes: number; materials: number; textures: number; animations: number } | null;
  effect: ImportedEffectView | null;
}
export interface EffectRuntime {
  reset(): void; setView(value: ViewerView): void; setPlaying(value: boolean): void; playing(): boolean; canPlay(): boolean;
  seek(seconds: number): void; time(): number; duration(): number; setLoop(value: boolean): void; loop(): boolean;
  setVisible(index: number, visible: boolean): void; previewed(): Set<number>; dispose(): void;
}
export interface EffectModule {
  createEffectViewer(options: { host: HTMLElement; effect: ImportedEffectView; label: string; signal: AbortSignal; onStatus: (message: string) => void }): Promise<EffectRuntime>;
}
const effectRuntimePath = '/effect-viewer-runtime.mjs';
const loadEffectRuntime = (): Promise<EffectModule> => import(effectRuntimePath);
/** Arcane's VFX budgets (skills/arcane/arcane-vfx): live particles per emitter, in view on phones, emitters per effect. */
export const EFFECT_BUDGETS = Object.freeze({ perEmitter: 200, phone: 600, emitters: 4 });
const PARTICLE_CLASSES = new Set(['ParticleEmitter', 'Fire', 'Smoke', 'Sparkles']);
const LIGHT_CLASSES = new Set(['PointLight', 'SpotLight', 'SurfaceLight']);
const numberOf = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const rangeOf = (value: unknown): { min: number; max: number } | null => {
  const r = fields(value); const min = numberOf(r?.min), max = numberOf(r?.max);
  return min !== null && max !== null ? { min, max } : null;
};
const round = (value: number, digits = 2): string => String(Math.round(value * 10 ** digits) / 10 ** digits);
const span = (r: { min: number; max: number }, unit: string): string => (r.min === r.max ? round(r.min) : round(r.min) + ' – ' + round(r.max)) + unit;
/** Estimated live particles for one item: Rate × longest Lifetime (legacy effects use their stand-in rates). */
export function particleEstimate(item: ImportedEffectItemView): number {
  if (item.className === 'ParticleEmitter') {
    if (item.props.Enabled === false) return 0;
    const rate = numberOf(item.props.Rate) ?? 20, life = rangeOf(item.props.Lifetime) ?? { min: 5, max: 10 };
    return Math.round(Math.max(0, rate) * Math.max(0, life.max));
  }
  return item.className === 'Fire' ? 66 : item.className === 'Smoke' ? 48 : item.className === 'Sparkles' ? 19 : 0;
}
/** Inspector facts for an import: what the daemon measured, the VFX budgets for effects, and plain notes. */
export function importedFacts(asset: ImportedViewerAsset): ViewerFacts & { notes: string[] } {
  const facts: ViewerFacts & { notes: string[] } = { name: clean(asset.name, 80) || 'Imported asset', kind: asset.kind === 'effect' ? 'Imported effect' : 'Imported model', variant: null,
    triangles: asset.model?.triangles ?? null, budget: null, materials: asset.model?.materials ?? null, texture: null, uv: null, materialRows: [], issues: [], passed: [], notes: [] };
  if (asset.model) {
    facts.passed.push('Passed Arcane’s GLB safety check', 'Textures are embedded in the file');
    if (asset.format === 'gltf') facts.notes.push('Packed from a .gltf and its files into one GLB.');
    return facts;
  }
  const effect = asset.effect; if (!effect) return facts;
  const particles = effect.items.filter(item => PARTICLE_CLASSES.has(item.className));
  const over = particles.map(item => ({ item, live: particleEstimate(item) })).filter(row => row.live > EFFECT_BUDGETS.perEmitter);
  for (const row of over) facts.issues.push({ tone: 'warn', title: clean(row.item.name, 60) + ': about ' + row.live.toLocaleString() + ' live particles (budget ' + EFFECT_BUDGETS.perEmitter + ' per emitter)' });
  if (particles.length && !over.length) facts.passed.push('Every emitter within ' + EFFECT_BUDGETS.perEmitter + ' live particles');
  const total = particles.reduce((sum, item) => sum + particleEstimate(item), 0);
  if (total > EFFECT_BUDGETS.phone) facts.issues.push({ tone: 'warn', title: 'About ' + total.toLocaleString() + ' particles in view (phone budget ' + EFFECT_BUDGETS.phone + ')' });
  else if (particles.length) facts.passed.push('Within the phone budget of ' + EFFECT_BUDGETS.phone + ' particles');
  if (particles.length > EFFECT_BUDGETS.emitters) facts.issues.push({ tone: 'warn', title: particles.length + ' emitters (budget ' + EFFECT_BUDGETS.emitters + ' per effect)' });
  else if (particles.length) facts.passed.push('At most ' + EFFECT_BUDGETS.emitters + ' emitters');
  const listed = [...new Set(effect.items.filter(item => !PARTICLE_CLASSES.has(item.className) && !LIGHT_CLASSES.has(item.className)).map(item => item.className))];
  if (listed.length) facts.notes.push(listed.join(' and ') + (listed.length === 1 ? ' is' : ' are') + ' listed but not previewed.');
  if (particles.length) facts.notes.push('Roblox particle textures show as stand-in sprites.');
  if (effect.items.some(item => ['Fire', 'Smoke', 'Sparkles'].includes(item.className))) facts.notes.push('Fire, Smoke and Sparkles are close approximations.');
  if (effect.scripts) facts.notes.push('Contains ' + effect.scripts + (effect.scripts === 1 ? ' script' : ' scripts') + '. Arcane never runs scripts from imports.');
  if (effect.clamped.length) facts.notes.push('Values outside Arcane’s limits were capped: ' + [...new Set(effect.clamped.map(key => key.split('.')[1]))].slice(0, 6).join(', ') + '.');
  if (effect.otherClasses.length) facts.notes.push('Also in the file, not shown: ' + effect.otherClasses.slice(0, 6).join(', ') + '.');
  if (effect.truncated) facts.notes.push('Only the first 64 effects are listed.');
  return facts;
}
/** One-line summary and property rows for the emitter list and the Properties section. */
export function effectSummary(item: ImportedEffectItemView): string {
  if (item.className === 'ParticleEmitter') return round(numberOf(item.props.Rate) ?? 20, 1) + ' /s';
  if (LIGHT_CLASSES.has(item.className)) return round(numberOf(item.props.Range) ?? 8, 1) + ' studs';
  if (item.className === 'Beam' || item.className === 'Trail') return 'Not previewed';
  return '';
}
export interface EffectPropertyRow { label: string; value: string; curve?: number[]; gradient?: string }
const colourCss = (rgb: number[]): string => 'rgb(' + rgb.slice(0, 3).map(v => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(' ') + ')';
export function effectProperties(item: ImportedEffectItemView): EffectPropertyRow[] {
  const p = item.props, rows: EffectPropertyRow[] = [];
  const add = (label: string, value: string | null, extra: Partial<EffectPropertyRow> = {}) => { if (value !== null) rows.push({ label, value, ...extra }); };
  const sequence = (value: unknown): { keys: number[][] } | null => { const s = fields(value); const keys = Array.isArray(s?.keys) ? (s!.keys as unknown[]).filter((k): k is number[] => Array.isArray(k) && k.length === 3 && k.every(v => typeof v === 'number' && Number.isFinite(v))) : []; return keys.length >= 2 ? { keys } : null; };
  const sequenceRow = (label: string, value: unknown, unit = '') => {
    const s = sequence(value), n = numberOf(value);
    if (s) add(label, round(s.keys[0]![1]!) + ' → ' + round(s.keys[s.keys.length - 1]![1]!) + unit, { curve: s.keys.map(k => k[1]!) });
    else if (n !== null) add(label, round(n) + unit);
  };
  const colourRow = (label: string, value: unknown) => {
    const s = fields(value), colors = Array.isArray(s?.colors) ? (s!.colors as unknown[]).filter((k): k is number[] => Array.isArray(k) && k.length === 4 && k.every(v => typeof v === 'number' && Number.isFinite(v))) : [];
    if (colors.length >= 2) add(label, colors.length + ' stops', { gradient: 'linear-gradient(90deg,' + colors.map(k => colourCss(k.slice(1)) + ' ' + Math.round(k[0]! * 100) + '%').join(',') + ')' });
    else if (Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number')) add(label, '', { gradient: colourCss(value as number[]) });
  };
  if (item.className === 'ParticleEmitter') {
    add('Rate', round(numberOf(p.Rate) ?? 20, 1) + ' /s');
    const life = rangeOf(p.Lifetime), speed = rangeOf(p.Speed);
    add('Lifetime', life ? span(life, ' s') : null); add('Speed', speed ? span(speed, ' studs/s') : null);
    sequenceRow('Size', p.Size, ' studs'); sequenceRow('Transparency', p.Transparency); colourRow('Colour', p.Color);
    const spread = Array.isArray(p.SpreadAngle) ? p.SpreadAngle as number[] : null; add('Spread', spread ? round(spread[0]!) + '° × ' + round(spread[1]!) + '°' : null);
    const accel = Array.isArray(p.Acceleration) ? p.Acceleration as number[] : null; add('Acceleration', accel && accel.some(v => v !== 0) ? accel.map(v => round(v, 1)).join(', ') : null);
    add('Drag', numberOf(p.Drag) ? round(numberOf(p.Drag)!) : null); add('Light emission', numberOf(p.LightEmission) !== null ? round(numberOf(p.LightEmission)!) : null);
    add('Direction', typeof p.EmissionDirection === 'string' ? p.EmissionDirection : null);
    add('Texture', typeof p.Texture === 'string' ? clean(p.Texture.replace(/^rbxasset:\/\/textures\/particles\//, '').replace(/^rbxasset:\/\//, ''), 48) : null);
  } else if (LIGHT_CLASSES.has(item.className)) {
    add('Brightness', numberOf(p.Brightness) !== null ? round(numberOf(p.Brightness)!) : null); add('Range', numberOf(p.Range) !== null ? round(numberOf(p.Range)!) + ' studs' : null);
    colourRow('Colour', p.Color); add('Shadows', typeof p.Shadows === 'boolean' ? (p.Shadows ? 'On' : 'Off') : null);
    if (item.className !== 'PointLight') add('Angle', numberOf(p.Angle) !== null ? round(numberOf(p.Angle)!) + '°' : null);
  } else {
    for (const [key, value] of Object.entries(p).slice(0, 10)) {
      const r = rangeOf(value), n = numberOf(value);
      if (typeof value === 'boolean') add(key, value ? 'On' : 'Off');
      else if (n !== null) add(key, round(n));
      else if (r) add(key, span(r, ''));
      else if (typeof value === 'string') add(key, clean(value, 48));
      else if (sequence(value)) sequenceRow(key, value);
      else if (fields(value)?.colors || Array.isArray(value) && value.length === 3) colourRow(key, value);
    }
  }
  if (p.Enabled === false) add('Enabled', 'Off');
  return rows.slice(0, 14);
}

// ---- Icons: cloned from studio.html <template id="asset-viewer-icons"> (parser-created SVG; the CSP blocks
// data: images). Skipped when the template is absent; an icon is never the only label of a control.
const MODE_LABELS: Record<ViewerMode, string> = { clay: 'Shaded', rendered: 'Textured', wireframe: 'Wireframe', uv: 'UV checker', normals: 'Normals' };
const MODE_ORDER: ViewerMode[] = ['clay', 'rendered', 'wireframe', 'uv', 'normals'];
const LIGHT_LABELS: Record<ViewerLighting, string> = { studio: 'Studio', soft: 'Soft', dramatic: 'Dramatic' };
const VIEW_LABELS: Record<ViewerView, string> = { perspective: 'Perspective', front: 'Front', side: 'Side', top: 'Top' };
const REVIEW_LABELS: Record<string, string> = { pending: 'Awaiting review', approved: 'Approved', rejected: 'Rejected', unknown: 'Decision unconfirmed', unavailable: 'Review unavailable' };

interface Frame {
  root: HTMLElement; frame: HTMLElement; stage: HTMLElement; host: HTMLElement; status: HTMLElement;
  inspector: HTMLElement; tabs: HTMLElement; body: HTMLElement; footer: HTMLElement; pill: HTMLElement; pillText: HTMLElement;
  stats: HTMLElement; statRows: HTMLElement; tiles: HTMLElement; facts: ViewerFacts;
}

/** Exact manifest -> bounded authenticated bytes -> checksum -> data preflight -> GPU.
 * No provider calls, filesystem discovery, CDN, demo model or persistent asset cache.
 * The caller's current() fences project/chat/job identity as well as this local epoch.
 * Presentation: a stage (canvas with floating controls) and an inspector (manifest facts, checks and the
 * existing model review card). Container queries place them side by side or stacked; nothing here sizes the canvas.
 */
export class AssetViewerPanel {
  private epoch = 0;
  private controller: AbortController | null = null;
  private runtime: ViewerRuntime | null = null;
  private effectRuntime: EffectRuntime | null = null;
  private removeControls: (() => void)[] = [];
  private clock: ReturnType<typeof setTimeout> | null = null;
  private readonly review: AssetReviewCard;
  constructor(private readonly doc: Document, private readonly token: string, private readonly options: ViewerOptions = {}) {
    this.review = new AssetReviewCard(doc, token, { ...(options.transport ? { transport: options.transport } : {}), ...(options.tokenOrigin ? { tokenOrigin: options.tokenOrigin } : {}) });
  }
  clear(): void {
    this.epoch++;
    this.review.clear();
    this.controller?.abort(); this.controller = null;
    this.runtime?.dispose(); this.runtime = null;
    this.effectRuntime?.dispose(); this.effectRuntime = null;
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
    const view = this.frame(root, viewerFacts(manifest)), status = view.status;
    const setPhase = (phase: 'loading' | 'ready' | 'stopped') => { view.frame.dataset.phase = phase; };
    const setStatus = (message: string) => {
      if (!active()) return;
      // Renderer notifications are trusted code, but its nested decoder errors
      // may contain untrusted asset strings. Only publish known UI messages.
      status.textContent = message === '3D preview ready.' ? '3D preview ready.' :
        message === 'Drag to orbit · Right-drag to pan · Scroll to zoom' ? message :
        message.startsWith('WebGL context lost.') ? '3D preview interrupted. Reload the asset to continue.' :
        message.startsWith('3D preview stopped:') ? '3D preview stopped. Check the export’s validation report.' : 'Loading 3D preview…';
      if (message.startsWith('WebGL context lost.') || message.startsWith('3D preview stopped:')) { this.review.clear(); setPhase('stopped'); }
    };
    root.hidden = false;
    const timer = setTimeout(() => { controller.abort(); if (epoch === this.epoch && current()) { status.textContent = '3D preview timed out. Reload the asset to try again.'; setPhase('stopped'); } }, this.options.deadlineMs ?? 45000);
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
      const runtime = await bounded(module.createAssetViewer({ host: view.host, bytes, label: artifact.filename, signal: controller.signal, onStatus: setStatus }), controller.signal, value => value.dispose());
      if (!active()) { runtime.dispose(); return; }
      this.runtime = runtime;
      this.controls(view, runtime, active);
      this.reviewStatus(view);
      void this.review.show(view.footer, { jobId, sha256: artifact.sha256, bytes: artifact.bytes }, controller.signal, active);
      if (fields(manifest)?.origin === 'converted-glb') {
        view.footer.append(this.make('p', 'Model approval is recorded separately from Studio import.', 'hint'));
      }
      setStatus('Drag to orbit · Right-drag to pan · Scroll to zoom');
      setPhase('ready');
      const EventType = this.doc.defaultView?.CustomEvent;
      if (EventType) this.doc.dispatchEvent(new EventType('workspace:assetactivity', { detail: { jobId, state: 'succeeded' } }));
    } catch {
      if (epoch === this.epoch) { this.runtime?.dispose(); this.runtime = null; }
      // Do not echo loader/network errors or untrusted GLB names into the product.
      if (epoch === this.epoch && current() && !controller.signal.aborted) { status.textContent = userErrorText(userError(null,'preview')); setPhase('stopped'); }
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
  private button(text: string | undefined, className: string, label?: string): HTMLButtonElement {
    const button = this.make('button', text, className); button.type = 'button';
    if (label) button.setAttribute('aria-label', label);
    return button;
  }
  /** Decorative icon cloned from the page's icon template; null when the template or the icon is absent. */
  private icon(name: string, className = 'vw-icon'): Element | null {
    const template = this.doc.getElementById('asset-viewer-icons') as HTMLTemplateElement | null;
    const source = template?.content?.querySelector?.('[data-icon="' + name + '"]');
    if (!source) return null;
    const icon = source.cloneNode(true) as Element;
    icon.setAttribute('class', className); icon.removeAttribute('data-icon');
    return icon;
  }
  private add(parent: HTMLElement, ...nodes: (Node | null | undefined)[]): void {
    for (const node of nodes) if (node) parent.append(node);
  }
  private listen(element: EventTarget, event: string, action: (event: Event) => void): void {
    element.addEventListener(event, action); this.removeControls.push(() => element.removeEventListener(event, action));
  }
  private press(button: HTMLElement, on: boolean): void {
    button.setAttribute('aria-pressed', String(on));
    button.className = button.className.replace(/\s*\bis-on\b/g, '') + (on ? ' is-on' : '');
  }
  /** Stage and inspector shells. Facts come from the manifest only, so they render before the GPU work starts. */
  private frame(root: HTMLElement, facts: ViewerFacts): Frame {
    const frame = this.make('div', undefined, 'vw'); frame.dataset.phase = 'loading'; frame.dataset.inspector = 'open';
    const stage = this.make('section', undefined, 'vw-stage'); stage.setAttribute('aria-label', '3D preview');
    const host = this.make('div', undefined, 'viewer-canvas'); host.setAttribute('aria-label', 'Interactive asset preview');
    const status = this.make('p', 'Verifying 3D model…', 'viewer-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    stage.append(host, status);
    const inspector = this.make('aside', undefined, 'vw-inspector'); inspector.setAttribute('aria-label', 'Model details');
    const head = this.make('header', undefined, 'vw-inspector-head');
    const pill = this.make('span', undefined, 'vw-pill'), pillText = this.make('span', 'Checking review'); pill.hidden = true; pill.dataset.state = 'checking';
    pill.setAttribute('aria-hidden', 'true'); pill.append(this.make('span', undefined, 'vw-pill-dot'), pillText);
    const toggle = this.button(undefined, 'vw-ghost vw-inspector-toggle', 'Hide details'); toggle.setAttribute('aria-expanded', 'true'); this.add(toggle, this.icon('panel'));
    this.listen(toggle, 'click', () => this.setInspector(frame, toggle, frame.dataset.inspector !== 'open'));
    head.append(pill, this.make('span', undefined, 'vw-grow'), toggle);
    const tabs = this.make('div', undefined, 'vw-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Detail sections');
    const body = this.make('div', undefined, 'vw-inspector-body');
    const footer = this.make('footer', undefined, 'vw-inspector-foot');
    // Stats: manifest numbers now; runtime measurements (size, and triangles when the audit has none) join on load.
    const stats = this.section(body, 'stats', 'Stats'), statRows = this.make('div', undefined, 'vw-stat-rows'), tiles = this.make('dl', undefined, 'vw-tiles');
    stats.append(statRows, tiles);
    if (facts.materialRows.length) this.materials(body, facts.materialRows);
    if (facts.issues.length || facts.passed.length) this.checks(body, facts);
    inspector.append(head, tabs, body, footer);
    frame.append(stage, inspector); root.append(frame);
    // Layout and stage size classes follow the measured widths (the canvas breakpoints). The observer runs after layout
    // and before paint; a layout switch only resizes the deeper stage, so it settles in the same frame.
    frame.dataset.layout = 'stacked'; frame.dataset.stage = 'xs';
    const Observer = this.doc.defaultView?.ResizeObserver;
    if (Observer) {
      const measure = () => {
        const width = root.clientWidth, stageWidth = stage.clientWidth; if (!width) return;
        const layout = width >= 880 ? 'wide' : 'stacked';
        const size = stageWidth >= 940 ? 'xl' : stageWidth >= 880 ? 'lg' : stageWidth >= 680 ? 'md' : stageWidth >= 560 ? 'sm' : 'xs';
        if (frame.dataset.layout !== layout) frame.dataset.layout = layout;
        if (frame.dataset.stage !== size) frame.dataset.stage = size;
      };
      const observer = new Observer(measure); observer.observe(root); observer.observe(stage);
      this.removeControls.push(() => observer.disconnect());
    }
    return { root, frame, stage, host, status, inspector, tabs, body, footer, pill, pillText, stats, statRows, tiles, facts };
  }
  private section(body: HTMLElement, key: string, title: string): HTMLElement {
    const section = this.make('section', undefined, 'vw-sec'); section.dataset.section = key;
    const id = 'vw-h-' + key, heading = this.make('h3', title, 'vw-sec-title'); heading.id = id;
    section.setAttribute('aria-labelledby', id); section.append(heading); body.append(section);
    return section;
  }
  private setInspector(frame: HTMLElement, toggle: HTMLElement, open: boolean): void {
    frame.dataset.inspector = open ? 'open' : 'closed';
    toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', open ? 'Hide details' : 'Show details');
    const show = frame.querySelector?.('.vw-show-details'); if (show) show.setAttribute('aria-expanded', String(open));
  }
  private materials(body: HTMLElement, rows: ViewerMaterialRow[]): void {
    const section = this.section(body, 'materials', 'Materials'), list = this.make('ul', undefined, 'vw-materials');
    for (const row of rows) {
      const item = this.make('li', undefined, 'vw-material'), swatch = this.make('span', undefined, 'vw-swatch' + (row.mapped ? ' is-mapped' : ''));
      swatch.setAttribute('aria-hidden', 'true'); if (row.color) swatch.style.backgroundColor = row.color;
      const names = this.make('span', undefined, 'vw-material-names');
      names.append(this.make('span', row.name, 'vw-material-name'));
      if (row.detail) names.append(this.make('span', row.detail, 'vw-material-detail'));
      item.append(swatch, names);
      if (row.texture) item.append(this.make('span', row.texture + ' px', 'vw-num vw-material-size'));
      list.append(item);
    }
    section.append(list);
  }
  private checks(body: HTMLElement, facts: ViewerFacts): void {
    const section = this.section(body, 'checks', 'Checks');
    for (const issue of facts.issues) {
      const note = this.make('div', undefined, 'vw-note is-' + issue.tone); note.setAttribute('role', 'note');
      this.add(note, this.icon('alert'), this.make('span', issue.title, 'vw-note-title'));
      section.append(note);
    }
    if (!facts.passed.length) return;
    const summary = this.button(undefined, 'vw-passed-toggle'); summary.setAttribute('aria-expanded', 'false');
    const list = this.make('ul', undefined, 'vw-passed'); list.hidden = true; list.id = 'vw-passed-list'; summary.setAttribute('aria-controls', list.id);
    this.add(summary, this.icon('passed'), this.make('span', plural(facts.passed.length, 'check') + ' passed', 'vw-grow'), this.icon('chevron', 'vw-icon vw-chevron'));
    for (const text of facts.passed) list.append(this.make('li', text));
    this.listen(summary, 'click', () => { list.hidden = !list.hidden; summary.setAttribute('aria-expanded', String(!list.hidden)); });
    section.append(summary, list);
  }
  private stat(view: Frame, label: string, value: string, unit?: string, meter?: { value: number; max: number }): void {
    const row = this.make('div', undefined, 'vw-stat'), figure = this.make('span', undefined, 'vw-stat-value');
    figure.append(this.make('span', value, 'vw-num vw-stat-main'));
    if (unit) figure.append(this.make('span', ' ' + unit, 'vw-stat-unit'));
    row.append(this.make('span', label, 'vw-stat-label'), figure); view.statRows.append(row);
    if (!meter) return;
    const bar = this.make('div', undefined, 'vw-meter' + (meter.value > meter.max ? ' is-over' : '')), fill = this.make('span');
    bar.setAttribute('role', 'meter'); bar.setAttribute('aria-label', label + ' used of the ' + meter.max.toLocaleString() + ' budget');
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(meter.max)); bar.setAttribute('aria-valuenow', String(Math.min(meter.value, meter.max)));
    fill.style.width = Math.min(100, Math.round(meter.value / meter.max * 1000) / 10) + '%';
    bar.append(fill); view.statRows.append(bar);
  }
  private tile(view: Frame, label: string, value: string, tone?: Tone): void {
    const tile = this.make('div', undefined, 'vw-tile' + (tone ? ' is-' + tone : ''));
    tile.append(this.make('dt', label), this.make('dd', value, 'vw-num')); view.tiles.append(tile);
  }
  /** Runtime-measured stats, stage controls and the narrow-layout section tabs. */
  private controls(view: Frame, runtime: ViewerRuntime, active: () => boolean): void {
    const { facts } = view, stats = runtime.stats(), dimensions = stats.dimensions;
    const triangles = facts.triangles ?? (Number.isSafeInteger(stats.triangles) && stats.triangles >= 0 ? stats.triangles : null);
    if (triangles !== null) this.stat(view, 'Triangles', triangles.toLocaleString(), facts.budget ? '/ ' + facts.budget.toLocaleString() : undefined, facts.budget ? { value: triangles, max: facts.budget } : undefined);
    // glTF's physical units are metres, not Roblox studs. Never infer a conversion.
    const sized = dimensions && Object.values(dimensions).every(v => Number.isFinite(v) && v >= 0);
    const size = sized ? [dimensions.x, dimensions.y, dimensions.z].map(v => v.toFixed(2)).join(' × ') : null;
    if (size) this.stat(view, 'Size', size, 'm');
    const materials = facts.materials ?? (Number.isSafeInteger(stats.materials) && stats.materials >= 0 ? stats.materials : null);
    if (materials !== null) this.tile(view, 'Materials', materials.toLocaleString());
    if (facts.texture) this.tile(view, 'Textures', facts.texture + ' px');
    if (facts.uv) this.tile(view, 'UV quality', facts.uv.value, facts.uv.tone);
    view.tiles.hidden = !view.tiles.childElementCount;
    // One spoken summary for the canvas; the inspector rows carry the same numbers visually.
    const metrics = this.make('p', undefined, 'viewer-metrics vw-sr'); metrics.id = 'vw-metrics';
    if (size) metrics.textContent = size + ' m · ' + stats.triangles.toLocaleString() + ' triangles';
    view.stage.append(metrics); view.host.setAttribute('aria-describedby', metrics.id);
    if (runtime.hasAnimations) this.animationControls(view, runtime, active);
    this.hud(view, runtime, active);
    this.sectionTabs(view);
  }
  private sectionTabs(view: Frame): void {
    const sections = Array.from(view.body.children).filter(node => node.tagName === 'SECTION') as HTMLElement[];
    const tabs: HTMLButtonElement[] = [];
    const pick = (index: number) => sections.forEach((section, i) => {
      section.className = 'vw-sec' + (i === index ? ' is-current' : '');
      tabs[i]?.setAttribute('aria-selected', String(i === index)); tabs[i]?.setAttribute('tabindex', i === index ? '0' : '-1');
    });
    view.tabs.hidden = sections.length < 2;
    sections.forEach((section, index) => {
      const title = section.dataset.tab ?? section.querySelector?.('h3')?.textContent ?? section.dataset.section ?? '';
      const tab = this.button(title, 'vw-tab'); tab.setAttribute('role', 'tab'); tabs.push(tab);
      this.listen(tab, 'click', () => pick(index));
      this.listen(tab, 'keydown', event => {
        const key = (event as KeyboardEvent).key, step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
        if (!step) return; event.preventDefault();
        const next = (index + step + sections.length) % sections.length; pick(next); tabs[next]?.focus?.();
      });
      view.tabs.append(tab);
    });
    pick(0);
  }
  /** Mirrors the review card's recorded state into the header pill; the card keeps its own live status for assistive tech. */
  private reviewStatus(view: Frame): void {
    const Observer = this.doc.defaultView?.MutationObserver;
    view.pill.hidden = false;
    const sync = () => {
      const state = (view.footer.querySelector?.('.viewer-review')?.getAttribute('data-review-state')) ?? 'checking';
      view.pill.dataset.state = state; view.pillText.textContent = REVIEW_LABELS[state] ?? 'Checking review';
    };
    sync();
    if (!Observer) return;
    const observer = new Observer(sync);
    observer.observe(view.footer, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-review-state'] });
    this.removeControls.push(() => observer.disconnect());
  }
  /** Floating stage controls: preview type, asset, display modes, lighting, full screen, camera gizmo, hints, reset, turntable. */
  private hud(view: Frame, runtime: ViewerRuntime, active: () => boolean): void {
    const hud = this.make('div', undefined, 'vw-hud'), { facts } = view;
    // Preview type: models only today; effect previews have no runtime yet.
    const kinds = this.make('div', undefined, 'vw-glass vw-seg vw-kinds'); kinds.setAttribute('role', 'tablist'); kinds.setAttribute('aria-label', 'Preview type');
    const model = this.button(undefined, 'vw-seg-item is-on'); model.setAttribute('role', 'tab'); model.setAttribute('aria-selected', 'true');
    this.add(model, this.icon('cube'), this.make('span', 'Model'));
    const effects = this.button(undefined, 'vw-seg-item'); effects.setAttribute('role', 'tab'); effects.setAttribute('aria-selected', 'false');
    effects.disabled = true; effects.title = 'No effect to preview';
    this.add(effects, this.icon('flame'), this.make('span', 'Effects'));
    kinds.append(model, effects);
    // Asset: name, kind and variant from the manifest request.
    const asset = this.assetChip(facts, 'cube');
    // Display modes the runtime genuinely supports for this asset; the rest are not shown.
    const supported = new Set(runtime.modes?.() ?? ['rendered', 'wireframe', 'clay']);
    const modes = this.make('div', undefined, 'vw-glass vw-seg vw-modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Display');
    const modeButtons = new Map<ViewerMode, HTMLButtonElement>();
    const setMode = (mode: ViewerMode) => { runtime.setMode(mode); modeButtons.forEach((button, key) => this.press(button, key === mode)); };
    for (const mode of MODE_ORDER) {
      if (!supported.has(mode)) continue;
      const button = this.button(undefined, 'vw-seg-item', MODE_LABELS[mode]);
      this.add(button, this.icon(mode), this.make('span', MODE_LABELS[mode], 'vw-label'));
      this.press(button, mode === 'rendered'); modeButtons.set(mode, button);
      this.listen(button, 'click', () => { if (active()) setMode(mode); });
      modes.append(button);
    }
    // Tools: lighting menu, full screen (the panel's own control) and, while hidden, the details toggle.
    const tools = this.make('div', undefined, 'vw-glass vw-tools');
    const lightWrap = this.make('div', undefined, 'vw-menu-wrap');
    const light = this.button(undefined, 'vw-tool vw-light'); light.setAttribute('aria-haspopup', 'menu'); light.setAttribute('aria-expanded', 'false');
    const lightName = this.make('span', LIGHT_LABELS.studio, 'vw-label'); light.setAttribute('aria-label', 'Lighting, Studio');
    this.add(light, this.icon('sun'), lightName, this.icon('chevron', 'vw-icon vw-chevron'));
    const menu = this.make('div', undefined, 'vw-menu'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Lighting'); menu.hidden = true;
    const openMenu = (open: boolean) => { menu.hidden = !open; light.setAttribute('aria-expanded', String(open)); this.press(light, open); };
    const lightItems: [ViewerLighting, HTMLButtonElement][] = [];
    for (const key of Object.keys(LIGHT_LABELS) as ViewerLighting[]) {
      const item = this.button(undefined, 'vw-menu-item', LIGHT_LABELS[key]); item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', String(key === 'studio'));
      item.dataset.light = key;
      this.add(item, this.make('span', undefined, 'vw-light-swatch'), this.make('span', LIGHT_LABELS[key], 'vw-grow'), this.icon('check', 'vw-icon vw-menu-check'));
      this.listen(item, 'click', () => {
        if (!active()) return;
        runtime.setLighting(key);
        for (const [other, node] of lightItems) node.setAttribute('aria-checked', String(other === key));
        lightName.textContent = LIGHT_LABELS[key]; light.setAttribute('aria-label', 'Lighting, ' + LIGHT_LABELS[key]); openMenu(false);
      });
      lightItems.push([key, item]); menu.append(item);
    }
    this.listen(light, 'click', () => { if (active()) openMenu(!!menu.hidden); });
    this.listen(lightWrap, 'keydown', event => { if ((event as KeyboardEvent).key === 'Escape' && !menu.hidden) { openMenu(false); light.focus?.(); } });
    if (typeof this.doc.addEventListener === 'function') this.listen(this.doc, 'pointerdown', event => {
      if (!menu.hidden && !(event.target instanceof Node && lightWrap.contains(event.target))) openMenu(false);
    });
    lightWrap.append(light, menu); tools.append(lightWrap);
    const expand = this.doc.getElementById('preview-expand');
    if (expand) {
      const full = this.button(undefined, 'vw-tool vw-full', 'Full screen'); this.add(full, this.icon('expand'));
      const sync = () => { const on = expand.getAttribute('aria-pressed') === 'true'; this.press(full, on); full.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen'); };
      this.listen(full, 'click', () => { if (active()) { expand.click(); sync(); } });
      if (typeof this.doc.addEventListener === 'function') this.listen(this.doc, 'fullscreenchange', sync);
      sync(); tools.append(this.make('span', undefined, 'vw-divider'), full);
    }
    const showDetails = this.button(undefined, 'vw-tool vw-show-details', 'Show details'); showDetails.setAttribute('aria-expanded', 'true'); this.add(showDetails, this.icon('panel'));
    const toggle = view.inspector.querySelector?.('.vw-inspector-toggle') as HTMLElement | null | undefined;
    this.listen(showDetails, 'click', () => { if (toggle) this.setInspector(view.frame, toggle, true); });
    tools.append(showDetails);
    // Camera gizmo: axis views from +Y (top), +X (side) and +Z (front); the centre returns to perspective.
    const gizmo = this.make('div', undefined, 'vw-gizmo-wrap');
    const axes = this.make('div', undefined, 'vw-glass vw-gizmo'); axes.setAttribute('role', 'group'); axes.setAttribute('aria-label', 'Camera');
    const cameraLabel = this.make('span', VIEW_LABELS.perspective, 'vw-camera'); cameraLabel.setAttribute('aria-live', 'polite');
    const viewButtons = new Map<ViewerView, HTMLButtonElement>();
    this.add(axes, this.icon('gizmo', 'vw-axis-lines'));
    for (const [key, text] of [['top', 'Y'], ['side', 'X'], ['front', 'Z'], ['perspective', '']] as [ViewerView, string][]) {
      const button = this.button(text, 'vw-axis vw-axis-' + key, VIEW_LABELS[key] + ' view'); viewButtons.set(key, button);
      this.press(button, key === 'perspective');
      this.listen(button, 'click', () => {
        if (!active()) return;
        runtime.setView(key); cameraLabel.textContent = VIEW_LABELS[key];
        viewButtons.forEach((node, other) => this.press(node, other === key));
      });
      axes.append(button);
    }
    gizmo.append(axes, cameraLabel);
    // Viewport bar: input hints, reset and turntable.
    const bar = this.make('div', undefined, 'vw-glass vw-bar'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Viewport controls');
    const hints = this.make('div', undefined, 'vw-hints'); hints.setAttribute('aria-hidden', 'true');
    for (const [label, side] of [['Orbit', 'left'], ['Pan', 'right'], ['Zoom', 'wheel']]) {
      const hint = this.make('span', undefined, 'vw-hint'), key = this.make('kbd', undefined, 'vw-mouse is-' + side);
      this.add(key, this.icon('mouse')); hint.append(key, this.make('span', label)); hints.append(hint);
    }
    const reset = this.button(undefined, 'vw-tool vw-reset', 'Reset view');
    this.add(reset, this.icon('reset'), this.make('span', 'Reset', 'vw-label'), this.make('kbd', 'R', 'vw-key vw-label'));
    this.listen(reset, 'click', () => { if (active()) runtime.reset(); });
    bar.append(hints, this.make('span', undefined, 'vw-divider vw-hints-divider'), reset);
    if (typeof runtime.setTurntable === 'function') {
      const spin = this.button(undefined, 'vw-tool vw-spin', 'Turntable'), setTurntable = runtime.setTurntable.bind(runtime);
      this.add(spin, this.icon('turntable'), this.make('span', 'Turntable', 'vw-label'));
      this.press(spin, runtime.turntable?.() ?? false);
      if (this.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) spin.title = 'Paused while reduced motion is on';
      this.listen(spin, 'click', () => { if (!active()) return; const on = spin.getAttribute('aria-pressed') !== 'true'; setTurntable(on); this.press(spin, on); });
      bar.append(spin);
    }
    // Top: preview type and asset on the left, display modes and tools on the right (the right group wraps under the
    // left one rather than overlapping it). Bottom: camera gizmo, then the viewport bar centred.
    const top = this.make('div', undefined, 'vw-hud-top'), left = this.make('div', undefined, 'vw-hud-left'), right = this.make('div', undefined, 'vw-hud-right');
    const bottom = this.make('div', undefined, 'vw-hud-bottom');
    left.append(kinds, asset); right.append(modes, tools); top.append(left, right); bottom.append(gizmo, bar);
    hud.append(top, bottom);
    view.stage.append(hud);
  }
  private animationControls(view: Frame, runtime: ViewerRuntime, active: () => boolean): void {
    const clips = runtime.animations(); if (!clips.length) return;
    const section = this.section(view.body, 'animation', 'Animation');
    // Keep animation right after stats, above materials and checks: it is the one interactive section.
    const second = view.body.children[1]; if (second && second !== section) view.body.insertBefore(section, second);
    const bar = this.make('div', undefined, 'viewer-animation vw-clip');
    const select = this.make('select'); select.setAttribute('aria-label', 'Animation clip');
    for (const clip of clips) { const option = this.make('option', clean(clip.name) || 'Clip ' + (clip.index + 1)); option.value = String(clip.index); select.append(option); }
    const play = this.make('button', 'Play', 'vw-play'); play.type = 'button'; play.setAttribute('aria-label', 'Play animation');
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
    const row = this.make('div', undefined, 'vw-clip-row'); row.append(play, seek);
    const options = this.make('div', undefined, 'vw-clip-row'); options.append(select, speed, loopLabel);
    bar.append(row, options); section.append(bar); sync();
    const root = view.root;
    const poll = () => {
      if (!active()) return;
      if (!this.doc.hidden && !root.closest('[hidden]')) sync();
      this.clock = setTimeout(poll, 250);
    }; this.clock = setTimeout(poll, 250);
  }
  /** Asset chip: name, kind and variant. While the asset picker is mounted (asset-imports.ts) the chip opens it. */
  private assetChip(facts: ViewerFacts, iconName: string): HTMLElement {
    const choosable = !!this.doc.getElementById('asset-picker');
    const asset = choosable ? this.button(undefined, 'vw-glass vw-asset is-choose') : this.make('div', undefined, 'vw-glass vw-asset');
    const names = this.make('span', undefined, 'vw-asset-names');
    names.append(this.make('span', facts.name ?? 'Model', 'vw-asset-name'));
    if (facts.kind) names.append(this.make('span', facts.kind, 'vw-asset-kind'));
    this.add(asset, this.icon(iconName, 'vw-icon vw-asset-icon'), names);
    if (facts.variant) { asset.append(this.make('span', undefined, 'vw-divider')); const variant = this.make('span', facts.variant, 'vw-num vw-asset-variant'); variant.setAttribute('aria-label', 'Variant ' + facts.variant.replace(' / ', ' of ')); asset.append(variant); }
    if (choosable) {
      asset.setAttribute('aria-haspopup', 'dialog'); asset.setAttribute('aria-label', 'Choose an asset. Showing ' + (facts.name ?? 'Model'));
      this.add(asset, this.icon('chevron', 'vw-icon vw-chevron'));
      this.listen(asset, 'click', () => { const EventType = this.doc.defaultView?.CustomEvent; if (EventType) this.doc.dispatchEvent(new EventType('arcane:choose-asset', { detail: { anchor: asset } })); });
    }
    return asset;
  }
  /** An import: no review card; facts measured from the real file, an Imported pill and Remove in the footer. */
  async showImported(asset: ImportedViewerAsset, load: (signal: AbortSignal) => Promise<ArrayBuffer>, current: () => boolean, actions: { remove(): void }): Promise<void> {
    this.clear();
    const root = this.doc.getElementById('asset-viewer');
    if (!root || !current()) return;
    const epoch = this.epoch, controller = new AbortController(); this.controller = controller;
    const active = () => epoch === this.epoch && this.controller === controller && !controller.signal.aborted && current();
    const facts = importedFacts(asset), view = this.frame(root, facts), status = view.status;
    view.frame.dataset.source = 'imported'; view.frame.dataset.kind = asset.kind;
    view.pill.hidden = false; view.pill.dataset.state = 'imported'; view.pillText.textContent = 'Imported'; view.pill.removeAttribute('aria-hidden');
    this.importFooter(view, asset, actions, active);
    const setPhase = (phase: 'loading' | 'ready' | 'stopped') => { view.frame.dataset.phase = phase; };
    const stopped = asset.kind === 'effect' ? 'Effect preview stopped. Reopen the effect to try again.' : 'Arcane can’t preview this model. Re-export it as a GLB with embedded textures.';
    const setStatus = (message: string) => {
      if (!active()) return;
      status.textContent = message === '3D preview ready.' || message === 'Effect preview ready.' ? (asset.kind === 'effect' ? 'Effect preview ready.' : '3D preview ready.') :
        message.startsWith('WebGL context lost.') ? '3D preview interrupted. Reopen the asset to continue.' :
        message.startsWith('3D preview stopped:') || message.startsWith('Effect preview stopped:') || message.startsWith('Effect preview unavailable:') ? stopped : 'Loading preview…';
      if (message.startsWith('WebGL context lost.') || message.includes('stopped:') || message.includes('unavailable:')) setPhase('stopped');
    };
    root.hidden = false; status.textContent = asset.kind === 'effect' ? 'Loading effect…' : 'Verifying 3D model…';
    const timer = setTimeout(() => { controller.abort(); if (epoch === this.epoch && current()) { status.textContent = 'Preview timed out. Reopen the asset to try again.'; setPhase('stopped'); } }, this.options.deadlineMs ?? 45000);
    try {
      if (asset.kind === 'model') {
        const bytes = await bounded(load(controller.signal), controller.signal);
        if (!active()) return;
        validateGlb(bytes);
        const module = await bounded((this.options.loadRuntime ?? loadRuntime)(), controller.signal);
        if (!active()) return;
        const runtime = await bounded(module.createAssetViewer({ host: view.host, bytes, label: facts.name ?? 'Imported model', signal: controller.signal, onStatus: setStatus }), controller.signal, value => value.dispose());
        if (!active()) { runtime.dispose(); return; }
        this.runtime = runtime;
        this.controls(view, runtime, active);
        if (asset.model) {
          this.tile(view, 'Textures', asset.model.textures.toLocaleString());
          if (asset.model.animations) this.tile(view, 'Animations', asset.model.animations.toLocaleString());
          view.tiles.hidden = false;
        }
        this.importNotes(view, facts.notes);
        setStatus('Drag to orbit · Right-drag to pan · Scroll to zoom'); status.textContent = 'Drag to orbit · Right-drag to pan · Scroll to zoom';
      } else {
        const effect = asset.effect; if (!effect) throw new Error('Effect unavailable.');
        const module = await bounded((this.options.loadEffectRuntime ?? loadEffectRuntime)(), controller.signal);
        if (!active()) return;
        const runtime = await bounded(module.createEffectViewer({ host: view.host, effect, label: facts.name ?? 'Imported effect', signal: controller.signal, onStatus: setStatus }), controller.signal, value => value.dispose());
        if (!active()) { runtime.dispose(); return; }
        this.effectRuntime = runtime;
        this.effectControls(view, asset, effect, runtime, active);
        this.importNotes(view, facts.notes);
        status.textContent = 'Drag to orbit · Right-drag to pan · Scroll to zoom';
      }
      setPhase('ready');
    } catch {
      if (epoch === this.epoch) { this.runtime?.dispose(); this.runtime = null; this.effectRuntime?.dispose(); this.effectRuntime = null; }
      if (epoch === this.epoch && current() && !controller.signal.aborted) { status.textContent = stopped; setPhase('stopped'); }
    } finally {
      clearTimeout(timer);
      if (!current() && epoch === this.epoch) this.clear();
    }
  }
  /** Footer for imports: where it came from and Remove (the file on the computer is never touched). */
  private importFooter(view: Frame, asset: ImportedViewerAsset, actions: { remove(): void }, active: () => boolean): void {
    const source = this.make('div', undefined, 'vw-import-source');
    const date = new Date(asset.importedAt), when = Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    const size = asset.bytes < 1024 * 1024 ? Math.max(1, Math.round(asset.bytes / 1024)) + ' KB' : (asset.bytes / 1024 / 1024).toFixed(1) + ' MB';
    source.append(this.make('span', 'Imported by you', 'vw-import-by'), this.make('span', [clean(asset.fileName, 80), size, when].filter(Boolean).join(' · '), 'vw-import-file'));
    const remove = this.button('Remove import', 'secondary vw-import-remove');
    this.listen(remove, 'click', () => { if (active()) actions.remove(); });
    view.footer.append(source, remove);
  }
  private importNotes(view: Frame, notes: string[]): void {
    if (!notes.length) return;
    let section = view.body.querySelector?.('[data-section="checks"]') as HTMLElement | null | undefined;
    if (!section) { section = this.section(view.body, 'checks', 'Checks'); }
    const list = this.make('ul', undefined, 'vw-import-notes');
    for (const note of notes) list.append(this.make('li', note));
    section.append(list);
    // Tabs were built before the notes may have added the Checks section; rebuild them once.
    view.tabs.replaceChildren(); this.sectionTabs(view);
  }
  /** Effects: emitter list, properties, VFX budgets and the timeline. */
  private effectControls(view: Frame, asset: ImportedViewerAsset, effect: ImportedEffectView, runtime: EffectRuntime, active: () => boolean): void {
    const items = effect.items, previewed = runtime.previewed();
    const particles = items.map((item, index) => ({ item, index })).filter(row => PARTICLE_CLASSES.has(row.item.className));
    const hidden = new Set<number>();
    // Stats: estimated live particles against the phone budget, then counts.
    const estimate = () => particles.reduce((sum, row) => sum + (hidden.has(row.index) ? 0 : particleEstimate(row.item)), 0);
    const meterRow = this.make('div', undefined, 'vw-import-meter');
    const drawMeter = () => {
      meterRow.replaceChildren();
      const value = estimate(), row = this.make('div', undefined, 'vw-stat'), figure = this.make('span', undefined, 'vw-stat-value');
      figure.append(this.make('span', value.toLocaleString(), 'vw-num vw-stat-main'), this.make('span', ' / ' + EFFECT_BUDGETS.phone, 'vw-stat-unit'));
      row.append(this.make('span', 'Particles in view', 'vw-stat-label'), figure);
      const bar = this.make('div', undefined, 'vw-meter' + (value > EFFECT_BUDGETS.phone ? ' is-over' : '')), fill = this.make('span');
      bar.setAttribute('role', 'meter'); bar.setAttribute('aria-label', 'Estimated particles in view against the phone budget of ' + EFFECT_BUDGETS.phone);
      bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(EFFECT_BUDGETS.phone)); bar.setAttribute('aria-valuenow', String(Math.min(value, EFFECT_BUDGETS.phone)));
      fill.style.width = Math.min(100, Math.round(value / EFFECT_BUDGETS.phone * 1000) / 10) + '%'; bar.append(fill);
      meterRow.append(row, bar);
    };
    if (particles.length) { drawMeter(); view.statRows.append(meterRow); }
    const lights = items.filter(item => LIGHT_CLASSES.has(item.className)).length;
    this.tile(view, 'Emitters', particles.length.toLocaleString());
    if (lights) this.tile(view, 'Lights', lights.toLocaleString());
    this.tile(view, 'File', asset.bytes < 1024 * 1024 ? Math.max(1, Math.round(asset.bytes / 1024)) + ' KB' : (asset.bytes / 1024 / 1024).toFixed(1) + ' MB');
    view.tiles.hidden = false;
    // Emitters: select to inspect, the eye hides one in the preview.
    const listSection = this.section(view.body, 'emitters', 'Emitters'), list = this.make('ul', undefined, 'vw-emitters');
    const propsSection = this.section(view.body, 'properties', 'Properties'), propsHead = this.make('p', undefined, 'vw-emitter-class'), propsList = this.make('dl', undefined, 'vw-emitter-props');
    propsSection.dataset.tab = 'Properties'; propsSection.append(propsHead, propsList);
    // Keep Emitters and Properties right after Stats (Checks stays last).
    const checks = view.body.querySelector?.('[data-section="checks"]');
    if (checks) { view.body.insertBefore(listSection, checks); view.body.insertBefore(propsSection, checks); }
    const heading = propsSection.querySelector?.('h3');
    const selectButtons: HTMLButtonElement[] = [];
    const pick = (index: number) => {
      const item = items[index]; if (!item) return;
      selectButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
      if (heading) heading.textContent = clean(item.name, 60) || item.className;
      propsHead.textContent = item.className + (previewed.has(index) ? '' : ' · not previewed');
      propsList.replaceChildren();
      for (const row of effectProperties(item)) {
        const line = this.make('div', undefined, 'vw-emitter-prop'), value = this.make('dd');
        if (row.curve) value.append(this.sparkline(row.curve));
        if (row.gradient) { const swatch = this.make('span', undefined, 'vw-gradient'); swatch.style.background = row.gradient; swatch.setAttribute('aria-hidden', 'true'); value.append(swatch); }
        if (row.value) value.append(this.make('span', row.value, 'vw-num'));
        line.append(this.make('dt', row.label), value); propsList.append(line);
      }
    };
    items.forEach((item, index) => {
      const li = this.make('li', undefined, 'vw-emitter'), select = this.button(undefined, 'vw-emitter-pick');
      select.setAttribute('aria-pressed', 'false');
      const names = this.make('span', undefined, 'vw-emitter-names');
      names.append(this.make('span', clean(item.name, 60) || item.className, 'vw-emitter-name'), this.make('span', item.className, 'vw-emitter-type'));
      this.add(select, this.icon(LIGHT_CLASSES.has(item.className) ? 'sun' : 'flame', 'vw-icon vw-emitter-icon'), names, this.make('span', effectSummary(item), 'vw-num vw-emitter-sum'));
      this.listen(select, 'click', () => { if (active()) pick(index); });
      selectButtons.push(select); li.append(select);
      if (previewed.has(index)) {
        const eye = this.button(undefined, 'vw-ghost vw-emitter-eye', 'Hide ' + (clean(item.name, 60) || item.className)); eye.setAttribute('aria-pressed', 'false');
        this.add(eye, this.icon('eye'));
        this.listen(eye, 'click', () => {
          if (!active()) return;
          const hide = !hidden.has(index); if (hide) hidden.add(index); else hidden.delete(index);
          runtime.setVisible(index, !hide); eye.setAttribute('aria-pressed', String(hide)); eye.setAttribute('aria-label', (hide ? 'Show ' : 'Hide ') + (clean(item.name, 60) || item.className));
          li.dataset.hidden = String(hide); if (particles.length) drawMeter();
        });
        li.append(eye);
      }
      list.append(li);
    });
    listSection.append(list);
    pick(items.findIndex((_, index) => previewed.has(index)) >= 0 ? items.findIndex((_, index) => previewed.has(index)) : 0);
    this.effectHud(view, asset, runtime, active);
    this.sectionTabs(view);
  }
  private sparkline(values: number[]): SVGSVGElement | HTMLElement {
    const template = this.doc.getElementById('asset-viewer-icons') as HTMLTemplateElement | null;
    const svg = template?.content?.querySelector?.('[data-icon="spark"]')?.cloneNode(true) as SVGSVGElement | undefined;
    if (!svg) return this.make('span');
    const max = Math.max(...values), min = Math.min(...values), range = max - min || 1;
    const points = values.map((v, i) => (2 + i / Math.max(1, values.length - 1) * 60).toFixed(1) + ',' + (19 - (v - min) / range * 16).toFixed(1)).join(' ');
    svg.removeAttribute('data-icon'); svg.setAttribute('class', 'vw-spark');
    svg.querySelector('polyline')?.setAttribute('points', points);
    return svg;
  }
  /** Effects HUD: preview type and asset, tools, camera gizmo and the timeline (play, time, scrub, loop, reset). */
  private effectHud(view: Frame, asset: ImportedViewerAsset, runtime: EffectRuntime, active: () => boolean): void {
    const hud = this.make('div', undefined, 'vw-hud');
    const kinds = this.make('div', undefined, 'vw-glass vw-seg vw-kinds'); kinds.setAttribute('role', 'tablist'); kinds.setAttribute('aria-label', 'Preview type');
    const model = this.button(undefined, 'vw-seg-item'); model.setAttribute('role', 'tab'); model.setAttribute('aria-selected', 'false'); model.disabled = true; model.title = 'No model in this file';
    this.add(model, this.icon('cube'), this.make('span', 'Model'));
    const effects = this.button(undefined, 'vw-seg-item is-on'); effects.setAttribute('role', 'tab'); effects.setAttribute('aria-selected', 'true');
    this.add(effects, this.icon('flame'), this.make('span', 'Effects'));
    kinds.append(model, effects);
    const chip = this.assetChip(view.facts, 'flame');
    const tools = this.make('div', undefined, 'vw-glass vw-tools');
    const expand = this.doc.getElementById('preview-expand');
    if (expand) {
      const full = this.button(undefined, 'vw-tool vw-full', 'Full screen'); this.add(full, this.icon('expand'));
      const sync = () => { const on = expand.getAttribute('aria-pressed') === 'true'; this.press(full, on); full.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen'); };
      this.listen(full, 'click', () => { if (active()) { expand.click(); sync(); } });
      if (typeof this.doc.addEventListener === 'function') this.listen(this.doc, 'fullscreenchange', sync);
      sync(); tools.append(full);
    }
    const showDetails = this.button(undefined, 'vw-tool vw-show-details', 'Show details'); showDetails.setAttribute('aria-expanded', 'true'); this.add(showDetails, this.icon('panel'));
    const toggle = view.inspector.querySelector?.('.vw-inspector-toggle') as HTMLElement | null | undefined;
    this.listen(showDetails, 'click', () => { if (toggle) this.setInspector(view.frame, toggle, true); });
    tools.append(showDetails);
    // Camera gizmo, as for models.
    const gizmo = this.make('div', undefined, 'vw-gizmo-wrap');
    const axes = this.make('div', undefined, 'vw-glass vw-gizmo'); axes.setAttribute('role', 'group'); axes.setAttribute('aria-label', 'Camera');
    const cameraLabel = this.make('span', VIEW_LABELS.perspective, 'vw-camera'); cameraLabel.setAttribute('aria-live', 'polite');
    const viewButtons = new Map<ViewerView, HTMLButtonElement>();
    this.add(axes, this.icon('gizmo', 'vw-axis-lines'));
    for (const [key, text] of [['top', 'Y'], ['side', 'X'], ['front', 'Z'], ['perspective', '']] as [ViewerView, string][]) {
      const button = this.button(text, 'vw-axis vw-axis-' + key, VIEW_LABELS[key] + ' view'); viewButtons.set(key, button); this.press(button, key === 'perspective');
      this.listen(button, 'click', () => { if (!active()) return; runtime.setView(key); cameraLabel.textContent = VIEW_LABELS[key]; viewButtons.forEach((node, other) => this.press(node, other === key)); });
      axes.append(button);
    }
    gizmo.append(axes, cameraLabel);
    // Timeline.
    const bar = this.make('div', undefined, 'vw-glass vw-bar vw-timeline'); bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Timeline');
    const play = this.button(undefined, 'vw-tool vw-play-toggle', 'Play'); this.add(play, this.icon('play', 'vw-icon vw-icon-play'), this.icon('pause', 'vw-icon vw-icon-pause'));
    const now = this.make('span', '0.0 s', 'vw-num vw-time'), end = this.make('span', runtime.duration().toFixed(1) + ' s', 'vw-num vw-time vw-time-end');
    const scrub = this.make('input', undefined, 'vw-scrub'); scrub.type = 'range'; scrub.min = '0'; scrub.max = String(runtime.duration()); scrub.step = '0.01'; scrub.value = '0';
    scrub.setAttribute('aria-label', 'Timeline position in seconds');
    const loop = this.button(undefined, 'vw-tool vw-loop', 'Loop'); this.add(loop, this.icon('loop')); this.press(loop, runtime.loop());
    const reset = this.button(undefined, 'vw-tool vw-reset', 'Reset view'); this.add(reset, this.icon('reset'));
    if (!runtime.canPlay()) { play.disabled = true; play.title = 'Paused while reduced motion is on'; }
    const sync = () => {
      if (!active()) return;
      const on = runtime.playing(), t = runtime.time();
      this.press(play, on); play.setAttribute('aria-label', on ? 'Pause' : 'Play'); view.frame.dataset.playing = String(on);
      now.textContent = t.toFixed(1) + ' s'; scrub.value = String(Math.min(runtime.duration(), t)); scrub.setAttribute('aria-valuetext', t.toFixed(1) + ' seconds');
    };
    this.listen(play, 'click', () => { if (active()) { runtime.setPlaying(!runtime.playing()); sync(); } });
    this.listen(scrub, 'input', () => { if (!active()) return; runtime.setPlaying(false); runtime.seek(Number(scrub.value)); sync(); });
    this.listen(loop, 'click', () => { if (!active()) return; const on = !runtime.loop(); runtime.setLoop(on); this.press(loop, on); });
    this.listen(reset, 'click', () => { if (active()) runtime.reset(); });
    const track = this.make('div', undefined, 'vw-track'); track.append(scrub);
    bar.append(play, now, track, end, loop, this.make('span', undefined, 'vw-divider'), reset);
    const top = this.make('div', undefined, 'vw-hud-top'), left = this.make('div', undefined, 'vw-hud-left'), right = this.make('div', undefined, 'vw-hud-right');
    const bottom = this.make('div', undefined, 'vw-hud-bottom');
    left.append(kinds, chip); right.append(tools); top.append(left, right); bottom.append(gizmo, bar);
    hud.append(top, bottom); view.stage.append(hud);
    sync();
    const root = view.root;
    const poll = () => { if (!active()) return; if (runtime.playing() && !this.doc.hidden && !root.closest('[hidden]')) sync(); this.clock = setTimeout(poll, 100); };
    this.clock = setTimeout(poll, 100);
  }
}
