// Pyx pop-out bar (renderer). A small always-available chat bar with Pyx to the left: it takes an instruction, reports
// back, asks what next and offers suggestions. Suggestions never send: a click only fills the box.
// The bar talks to its host only through PyxBarBridge (window.arcaneDesktop.pyx); it holds no credential, makes no
// network request and never starts inference by itself. Sending goes through the host to the active chat's own send path.
import { PYX_DONE_HOLD_MS, PYX_FRAME_MS, pyxSpriteGroup, pyxSpriteSvg, type PyxFrame, type PyxSpriteMood } from './pyx-sprite.js';

export type PyxProvider = 'claude' | 'codex' | 'arcane';
/** What the host reports. 'done' is optional: a working → idle change is treated the same way. */
export type PyxPhase = 'idle' | 'working' | 'done' | 'error' | 'offline';
/** Sprite mood plus the alert badge state (error or offline). */
export type PyxMood = PyxSpriteMood | 'alert';
export interface PyxProgress { readonly title: string; readonly step: number | null; readonly steps: number | null; readonly startedAt: number | null }
export interface PyxBarState {
  readonly phase: PyxPhase;
  readonly provider: PyxProvider | null;
  /** Short model name for the chip ("Opus 5.5"). */
  readonly model: string | null;
  /** Full model name for assistive tech ("Claude Opus 5.5"); falls back to `model`. */
  readonly modelTitle: string | null;
  /** Reasoning effort as the provider names it (low, medium, high, xhigh, max…). */
  readonly effort: string | null;
  /** Pyx's latest report: a short summary of the last reply. Shown in the bubble and announced. */
  readonly reply: string | null;
  /** The running turn: what it is doing and, only when the host really knows, step counts. */
  readonly progress: PyxProgress | null;
  /** Honest reason for the error/offline phase. */
  readonly message: string | null;
  /** The host can stop the running turn. */
  readonly canStop: boolean;
}
export interface PyxSuggestion { readonly label: string; readonly text: string }
export type PyxSubmitResult = { readonly accepted: true } | { readonly accepted: false; readonly message?: string };
export interface PyxModelChoice {readonly revision:string;readonly provider:PyxProvider;readonly model:string;readonly effort:string}
export interface PyxModelsView {
  readonly revision:string;readonly selectable:boolean;readonly message:string|null;
  readonly selected:{readonly provider:PyxProvider;readonly model:string;readonly effort:string}|null;
  readonly models:readonly {readonly provider:PyxProvider;readonly id:string;readonly label:string;readonly efforts:readonly string[]}[];
}
export interface PyxModelResult {readonly state:'applied'|'rejected'|'unknown';readonly message?:string}
/**
 * The only channel between the bar and its host (preload: window.arcaneDesktop.pyx). Every method is an intent; the host
 * owns routing, providers, queueing, auth and the window itself.
 */
export interface PyxBarBridge {
  readonly version: 1;
  /** Send the text through the active chat's existing send path (queued or steered exactly as the main composer would). */
  submit(text: string): Promise<PyxSubmitResult>;
  /** Current state now and on every change. Returns an unsubscribe. */
  onState(listener: (state: unknown) => void): () => void;
  /** "What next" suggestions from a real source (never invented by the bar). Returns an unsubscribe. */
  onSuggestions(listener: (suggestions: unknown) => void): () => void;
  /** Hide the bar (Escape). The draft stays in this document. */
  close(): void;
  /** Bring the main window forward with the active chat and hide the bar. */
  expandToMain(): void;
  /** Stop the running turn, as the main composer's Stop does. */
  stop?(): void;
  /** Read/select the main composer's actual catalogue without focusing its window. */
  models?():Promise<unknown>;
  selectModel?(choice:PyxModelChoice):Promise<unknown>;
  /** Only a boolean intent; the host owns the fixed picker size and screen bounds. */
  pickerOpen?(open:boolean):void;
  /** Transparent areas pass clicks through to the app below; true while the pointer is over the bar's parts. */
  setInteractive?(interactive: boolean): void;
  /**
   * The host says whether the bar is open (the perch toggles it). The bar pops in on true; on false it pops out and then
   * calls close(). Absent: the bar is open from the start and close() hides it at once.
   */
  onVisibility?(listener: (open: boolean) => void): () => void;
  /** The bar has painted its first (closed) frame: the host may show the window now. */
  ready?(): void;
  /** Moving the window: the bar only reports the gesture; the host reads the cursor and keeps the bar on screen. */
  drag?(phase: PyxDragPhase): void;
  /** Keyboard moving (arrow keys on Pyx), in pixels; the host bounds, clamps and remembers it. */
  nudge?(dx: number, dy: number): void;
}
export type PyxDragPhase = 'start' | 'move' | 'end' | 'cancel';

export const PYX_INPUT_MAX = 131072;
/** How far the pointer travels before a press on Pyx becomes a move instead of a click. */
export const PYX_DRAG_THRESHOLD = 4;
/** Arrow keys on Pyx move the bar this far (Shift: four times as far). */
export const PYX_NUDGE_STEP = 16;
/** Matches pyx-bar.css --pyx-pop-out (plus a frame): the bar hides once its pop-out has played. */
export const PYX_CLOSE_MS = 170;
export const PYX_MAX_SUGGESTIONS = 3;
export const PYX_PLACEHOLDER = 'Tell Pyx what to build';
export const PYX_STEER_PLACEHOLDER = 'Steer the build';
const PYX_STATUS: Readonly<Record<PyxMood, string>> = { idle: 'Pyx is resting', listening: 'Pyx is listening', working: 'Pyx is working', done: 'Pyx finished', alert: 'Pyx needs attention' };
const PROVIDER_NAMES: Readonly<Record<PyxProvider, string>> = { claude: 'Claude', codex: 'ChatGPT', arcane: 'Arcane' };
/** The same marks as codex-chat.ts PROVIDER_MARKS (a unit test keeps them identical); drawn white in the chip. */
export const PYX_PROVIDER_MARKS: Readonly<Record<PyxProvider, string>> = {
  codex: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  arcane: 'M12 1.5 1.5 21.375h4.875L12 10.5l5.625 10.875h4.875L12 1.5ZM10.125 15l7.125 4.875-2.25-4.875Z',
  claude: 'M4.7144 15.9555l4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
};

// ------------------------------------------------------------------------------------------------ pure helpers ----
const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return clean ? clean.slice(0, max) : null;
};
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : null;
export const PYX_OFFLINE_STATE: PyxBarState = Object.freeze({ phase: 'offline', provider: null, model: null, modelTitle: null, effort: null, reply: null, progress: null, message: null, canStop: false });
const pyxExact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  const own=Reflect.ownKeys(value);return own.length===keys.length&&own.every(key=>typeof key==='string'&&keys.includes(key)&&!!Object.getOwnPropertyDescriptor(value,key)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
};
const pyxBounded=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
/** Model data is display-only. Selection still requires the original private main-renderer capture. */
export function readPyxModels(value:unknown):PyxModelsView|null {
  try{
    if(!pyxExact(value,['revision','selectable','message','selected','models'])||!pyxBounded(value.revision,64)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.revision)||typeof value.selectable!=='boolean'||!(value.message===null||pyxBounded(value.message,300))||!Array.isArray(value.models)||value.models.length>768||new TextEncoder().encode(JSON.stringify(value)).length>32768)return null;
    const rows:PyxModelsView['models'][number][]=[],seen=new Set<string>();
    for(const row of value.models){
      if(!pyxExact(row,['provider','id','label','efforts'])||!['codex','claude','arcane'].includes(String(row.provider))||!pyxBounded(row.id,256)||!pyxBounded(row.label,96)||!Array.isArray(row.efforts)||!row.efforts.length||row.efforts.length>16||row.efforts.some(x=>!pyxBounded(x,64))||new Set(row.efforts).size!==row.efforts.length)return null;
      const key=JSON.stringify([row.provider,row.id]);if(seen.has(key))return null;seen.add(key);
      rows.push(Object.freeze({provider:row.provider as PyxProvider,id:row.id,label:row.label,efforts:Object.freeze([...row.efforts]) as readonly string[]}));
    }
    const selected=value.selected;
    if(selected!==null&&(!pyxExact(selected,['provider','model','effort'])||!rows.some(row=>row.provider===selected.provider&&row.id===selected.model&&row.efforts.includes(selected.effort as string))))return null;
    return Object.freeze({revision:value.revision,selectable:value.selectable,message:value.message as string|null,selected:selected?Object.freeze({...selected}) as PyxModelsView['selected']:null,models:Object.freeze(rows)});
  }catch{return null;}
}

/** Copies a host state into a bounded, well-typed value; anything malformed is dropped rather than shown. */
export function readPyxState(value: unknown): PyxBarState {
  if (!value || typeof value !== 'object') return PYX_OFFLINE_STATE;
  const v = value as Record<string, unknown>;
  const phase: PyxPhase = (['idle', 'working', 'done', 'error', 'offline'] as const).find(p => p === v.phase) ?? 'offline';
  const provider: PyxProvider | null = (['claude', 'codex', 'arcane'] as const).find(p => p === v.provider) ?? null;
  let progress: PyxProgress | null = null;
  if (v.progress && typeof v.progress === 'object') {
    const p = v.progress as Record<string, unknown>, title = text(p.title, 200);
    let step = count(p.step), steps = count(p.steps);
    if (step === null || steps === null || steps === 0 || step > steps) { step = null; steps = null; }
    const startedAt = typeof p.startedAt === 'number' && Number.isFinite(p.startedAt) && p.startedAt > 0 ? p.startedAt : null;
    if (title) progress = { title, step, steps, startedAt };
  }
  return { phase, provider, model: text(v.model, 64), modelTitle: text(v.modelTitle, 96), effort: text(v.effort, 24), reply: text(v.reply, 600),
    progress, message: text(v.message, 300), canStop: v.canStop === true };
}
/** At most three suggestions; a plain string is both label and text. Duplicates and empties are dropped. */
export function readPyxSuggestions(value: unknown): PyxSuggestion[] {
  if (!Array.isArray(value)) return [];
  const out: PyxSuggestion[] = [], seen = new Set<string>();
  for (const item of value.slice(0, 16)) {
    const label = text(typeof item === 'string' ? item : (item as { label?: unknown } | null)?.label, 60);
    const fill = typeof item === 'string' ? text(item, 4000) : text((item as { text?: unknown } | null)?.text, 4000) ?? label;
    if (!label || !fill || seen.has(fill)) continue;
    seen.add(fill); out.push({ label, text: fill });
    if (out.length === PYX_MAX_SUGGESTIONS) break;
  }
  return out;
}
/** Closed-chip effort pips, as the main composer: low or minimal 1, medium 2, high and above 3; unknown 0 (no pips). */
export function pyxEffortLevel(effort: string | null | undefined): 0 | 1 | 2 | 3 {
  const value = String(effort ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return value === 'minimal' || value === 'low' ? 1 : value === 'medium' ? 2 : ['high', 'xhigh', 'extrahigh', 'max'].includes(value) ? 3 : 0;
}
/** Mood priority, as on the composer perch: typing > alert > working > done (held 1.2 s) > idle. */
export function pyxMood(input: { phase: PyxPhase; typing: boolean; doneUntil: number; now: number }): PyxMood {
  if (input.typing) return 'listening';
  if (input.phase === 'error' || input.phase === 'offline') return 'alert';
  if (input.phase === 'working') return 'working';
  if (input.now < input.doneUntil) return 'done';
  return 'idle';
}
/** The bubble: Pyx's report, ending with the question. Never invented: no reply and no message means no bubble. */
export function pyxBubbleText(state: PyxBarState): string | null {
  if (state.phase === 'offline') return state.message ?? 'Pyx can’t reach Arcane right now.';
  if (state.phase === 'error') return state.message ?? 'The last turn didn’t finish.';
  if (state.phase === 'working' || !state.reply) return null;
  return /[?？]\s*$/.test(state.reply) ? state.reply : state.reply.replace(/\s*$/, '') + ' What next?';
}
/** A suggestion fills the box (replacing an empty box or an earlier suggestion, otherwise appended). It never sends. */
export function pyxFill(current: string, suggestion: string, offered: readonly string[] = []): string {
  if (!current.trim() || offered.includes(current.trim())) return suggestion.slice(0, PYX_INPUT_MAX);
  return (current.replace(/\s+$/, '') + ' ' + suggestion).slice(0, PYX_INPUT_MAX);
}
/** "12s", "1m 12s", "1h 4m". */
export function pyxElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
export function pyxModelLabel(state: PyxBarState): string {
  const level = pyxEffortLevel(state.effort), name = state.modelTitle ?? (state.model && state.provider && !state.model.toLowerCase().startsWith(PROVIDER_NAMES[state.provider].toLowerCase()) ? PROVIDER_NAMES[state.provider] + ' ' + state.model : state.model);
  if (!name) return 'Choose a model';
  return 'Model: ' + name + (level && state.effort ? ', reasoning ' + state.effort.toLowerCase() : '') + '. Change model';
}
/** Arrow keys on Pyx: the step the bar moves by, or null for any other key. */
export function pyxNudge(key: string, shift: boolean): { dx: number; dy: number } | null {
  const step = PYX_NUDGE_STEP * (shift ? 4 : 1);
  return key === 'ArrowLeft' ? { dx: -step, dy: 0 } : key === 'ArrowRight' ? { dx: step, dy: 0 } : key === 'ArrowUp' ? { dx: 0, dy: -step } : key === 'ArrowDown' ? { dx: 0, dy: step } : null;
}
/** A press becomes a move once the pointer has travelled past the threshold (a smaller wobble is still a click). */
export function pyxDragStarted(fromX: number, fromY: number, x: number, y: number, threshold = PYX_DRAG_THRESHOLD): boolean {
  return Math.hypot(x - fromX, y - fromY) >= threshold;
}

// ------------------------------------------------------------------------------------------------ the bar ----
export interface PyxBarOptions {
  /** Defaults to window.arcaneDesktop.pyx. Absent: the bar stays honest and offline. */
  bridge?: PyxBarBridge | null;
  now?: () => number;
  /** Defaults to matchMedia('(prefers-reduced-motion: reduce)'). */
  reducedMotion?: () => boolean;
}
export interface PyxBarController { mood(): PyxMood; state(): PyxBarState; isOpen(): boolean; stop(): void }

const SVG_NS = 'http://www.w3.org/2000/svg';
const ESCAPE_ONLY = new Set(['Escape', 'Esc']);

export function bridgeFromWindow(win: Window | null | undefined): PyxBarBridge | null {
  const candidate = (win as unknown as { arcaneDesktop?: { pyx?: unknown } } | null)?.arcaneDesktop?.pyx as Partial<PyxBarBridge> | undefined;
  return candidate && candidate.version === 1 && typeof candidate.submit === 'function' && typeof candidate.onState === 'function' && typeof candidate.onSuggestions === 'function' &&
    typeof candidate.close === 'function' && typeof candidate.expandToMain === 'function' ? candidate as PyxBarBridge : null;
}

export function startPyxBar(doc: Document, options: PyxBarOptions = {}): PyxBarController {
  const win = doc.defaultView;
  const bridge = options.bridge === undefined ? bridgeFromWindow(win) : options.bridge;
  const now = options.now ?? (() => Date.now());
  const media = typeof win?.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = options.reducedMotion ?? (() => media?.matches === true);
  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T | null;
  const root = $('pyx'), form = $<HTMLFormElement>('pyx-form'), input = $<HTMLInputElement>('pyx-input'), pet = $<HTMLButtonElement>('pyx-pet');
  const bubble = $('pyx-bubble'), bubbleText = $('pyx-bubble-text'), bubbleOpen = $<HTMLButtonElement>('pyx-bubble-open'), status = $<HTMLButtonElement>('pyx-status');
  const statusTitle = $('pyx-status-title'), statusCount = $('pyx-status-count'), live = $('pyx-live-dot'), progress = $('pyx-progress'), fill = $('pyx-progress-fill');
  const chip = $<HTMLButtonElement>('pyx-model'), chipLogo = doc.getElementById('pyx-model-logo'), chipName = $('pyx-model-name'), pips = $('pyx-model-pips');
  const picker=$('pyx-model-picker'),modelOptions=$('pyx-model-options'),modelNotice=$('pyx-model-notice'),modelClose=$<HTMLButtonElement>('pyx-model-close'),modelSearch=$<HTMLInputElement>('pyx-model-search'),modelEffort=$<HTMLSelectElement>('pyx-model-effort'),reasoningLabel=$('pyx-reasoning-label');
  const closeButton = $<HTMLButtonElement>('pyx-close'), stopButton = $<HTMLButtonElement>('pyx-stop'), send = $<HTMLButtonElement>('pyx-send'), chips = $('pyx-suggestions'), announcer = $('pyx-announce'), moodText = $('pyx-mood');
  const sprite = doc.getElementById('pyx-sprite'), badge = doc.getElementById('pyx-badge');
  if (!root || !form || !input || !pet || !bubble || !bubbleText || !status || !statusTitle || !statusCount || !progress || !fill || !chip || !chipName || !pips || !send || !chips || !announcer || !sprite)
    return { mood: () => 'idle', state: () => PYX_OFFLINE_STATE, isOpen: () => false, stop() {} };

  let state: PyxBarState = bridge ? { ...PYX_OFFLINE_STATE, phase: 'idle' } : { ...PYX_OFFLINE_STATE, message: 'Pyx isn’t connected to Arcane. Open Arcane to use Pyx.' };
  let suggestions: PyxSuggestion[] = [], offered: string[] = [];
  let doneUntil = 0, mood: PyxMood = 'idle', frame: PyxFrame = 1, steering = false, sending = false, stopped = false, localError: string | null = null;
  let frameTimer: ReturnType<typeof setTimeout> | null = null, doneTimer: ReturnType<typeof setTimeout> | null = null, clock: ReturnType<typeof setInterval> | null = null;
  let pulse: Animation | null = null, lastAnnounced = '', lastBubble = '', interactive: boolean | null = null, suggestionsKey = '';
  let open = false, closeTimer: ReturnType<typeof setTimeout> | null = null;
  let press: { id: number; x: number; y: number; target: HTMLElement; moving: boolean } | null = null, suppressClick = false;
  const unsubscribe: (() => void)[] = [];
  const frames = new Map<string, SVGGElement>();
  const spriteFrame = (m: PyxSpriteMood, f: PyxFrame) => { const key = m + f; let g = frames.get(key); if (!g) { g = pyxSpriteGroup(doc, m, f); frames.set(key, g); } return g; };
  const restart = (node: Element, className: string) => { node.classList.remove(className); void (node as HTMLElement).offsetWidth; node.classList.add(className); };
  const typing = () => doc.activeElement === input && input.value.trim().length > 0;
  const working = () => state.phase === 'working';
  const motionOn = () => !reduced() && doc.visibilityState !== 'hidden';
  let modelView:PyxModelsView|null=null,pickerShown=false,pickerBusy=false,pickerUnknown=false,pickerGeneration=0;
  chip.setAttribute('aria-haspopup','dialog');chip.setAttribute('aria-controls','pyx-model-picker');chip.setAttribute('aria-expanded','false');
  const closePicker=(restore=true)=>{
    pickerGeneration++;pickerShown=false;pickerBusy=false;modelView=null;root.dataset.pickerOpen='false';if(picker)picker.hidden=true;chip.setAttribute('aria-expanded','false');
    try{bridge?.pickerOpen?.(false);}catch{/* Host may have closed. */}if(restore&&!stopped)chip.focus({preventScroll:true});
  };
  const renderModels=()=>{
    if(!modelOptions||!modelNotice||!modelEffort||!reasoningLabel)return;modelOptions.replaceChildren();
    const query=(modelSearch?.value??'').trim().toLowerCase(),rows=modelView?.models.filter(row=>(row.label+' '+row.id+' '+PROVIDER_NAMES[row.provider]).toLowerCase().includes(query))??[];
    for(const row of rows){
      const selected=modelView?.selected,effort=selected&&row.efforts.includes(selected.effort)?selected.effort:row.efforts[0]!;
      const button=doc.createElement('button');button.type='button';button.className='pyx-model-option';button.setAttribute('role','option');button.setAttribute('aria-selected',String(selected?.provider===row.provider&&selected.model===row.id));
      button.disabled=pickerBusy||pickerUnknown||!modelView?.selectable;button.dataset.model=row.id;button.dataset.provider=row.provider;
      const name=doc.createElement('span');name.textContent=row.label;const detail=doc.createElement('small');detail.textContent=PROVIDER_NAMES[row.provider]+' · '+effort;button.append(name,detail);
      button.addEventListener('click',event=>{if(event.isTrusted&&!button.disabled)void selectModel(row.provider,row.id,effort);});modelOptions.append(button);
    }
    const selected=modelView?.selected,row=selected?modelView?.models.find(row=>row.provider===selected.provider&&row.id===selected.model):null;
    reasoningLabel.hidden=!row;modelEffort.replaceChildren();for(const effort of row?.efforts??[]){const option=doc.createElement('option');option.value=effort;option.textContent=effort;modelEffort.append(option);}
    modelEffort.value=selected?.effort??'';modelEffort.disabled=pickerBusy||pickerUnknown||!modelView?.selectable;
    if(modelView&&!rows.length&&!pickerBusy&&!pickerUnknown)modelNotice.textContent=query?'No reported models match this search.':modelView.message??'No models are currently reported.';
  };
  const selectModel=async(provider:PyxProvider,model:string,effort:string)=>{
    const view=modelView,generation=pickerGeneration;if(!view||!pickerShown||pickerBusy||pickerUnknown||!view.selectable||!bridge?.selectModel)return;
    pickerBusy=true;if(modelNotice)modelNotice.textContent='Selecting model…';renderModels();
    let result:PyxModelResult={state:'unknown',message:'Model selection is unconfirmed. Review it in Arcane; nothing was retried.'};
    try{const response=await bridge.selectModel({revision:view.revision,provider,model,effort});
      if(pyxExact(response,['state',...(response&&typeof response==='object'&&Object.hasOwn(response,'message')?['message']:[])])&&['applied','rejected','unknown'].includes(String(response.state))&&(!Object.hasOwn(response,'message')||pyxBounded(response.message,300)))result=response as unknown as PyxModelResult;
    }catch{/* Never retry an unobserved selection. */}
    if(stopped||generation!==pickerGeneration||!pickerShown)return;pickerBusy=false;
    if(result.state==='applied'){closePicker();announcer.textContent='Model selected for the next message.';return;}
    pickerUnknown=true;if(modelNotice)modelNotice.textContent=result.message??'The model list changed. Close and reopen it to review the current conversation.';renderModels();
  };
  const openPicker=async()=>{
    if(stopped||!open)return;if(pickerShown){closePicker();return;}
    if(!picker||!modelNotice||!modelOptions||!bridge?.models||!bridge.selectModel){localError='Model selection is unavailable here. Open Arcane to choose a model.';refresh();return;}
    const generation=++pickerGeneration;pickerShown=true;pickerBusy=true;pickerUnknown=false;modelView=null;picker.hidden=false;root.dataset.pickerOpen='true';chip.setAttribute('aria-expanded','true');
    if(modelSearch)modelSearch.value='';modelNotice.textContent='Reading current models…';renderModels();try{bridge.pickerOpen?.(true);}catch{/* Fixed host geometry is optional in previews. */}
    let view:PyxModelsView|null=null;try{view=readPyxModels(await bridge.models());}catch{/* An unavailable read has no selection effect. */}
    if(stopped||generation!==pickerGeneration||!pickerShown)return;pickerBusy=false;modelView=view;modelNotice.textContent=view?.message??(view?'Choose a model for the next message.':'The current model list is unavailable. Open Arcane to finish setup or review the current request.');renderModels();modelSearch?.focus({preventScroll:true});
  };
  modelClose?.addEventListener('click',()=>closePicker());modelSearch?.addEventListener('input',renderModels);
  modelEffort?.addEventListener('change',event=>{const selected=modelView?.selected;if(event.isTrusted&&selected&&!modelEffort.disabled)void selectModel(selected.provider,selected.model,modelEffort.value);});
  picker?.addEventListener('keydown',event=>{
    const key=(event as KeyboardEvent).key;if(!['ArrowDown','ArrowUp','Home','End'].includes(key))return;
    const target=event.target as Node|null,inList=!!target&&!!modelOptions?.contains(target);
    // Native reasoning selects and search caret keys keep their own keyboard
    // behavior. Only the actual model list owns Home/End navigation.
    if(!inList&&!(target===modelSearch&&(key==='ArrowDown'||key==='ArrowUp')))return;
    const buttons=[...(modelOptions?.querySelectorAll<HTMLButtonElement>('button')??[])].filter(button=>!button.disabled);if(!buttons.length)return;
    event.preventDefault();const at=buttons.indexOf(doc.activeElement as HTMLButtonElement),next=key==='Home'?0:key==='End'?buttons.length-1:at<0?(key==='ArrowDown'?0:buttons.length-1):key==='ArrowDown'?(at+1)%buttons.length:(at-1+buttons.length)%buttons.length;buttons[next]!.focus({preventScroll:true});buttons[next]!.scrollIntoView({block:'nearest'});
  });
  doc.addEventListener('pointerdown',event=>{const target=event.target as Node|null;if(pickerShown&&target&&!picker?.contains(target)&&!chip.contains(target))closePicker(false);});

  // Chip: the provider mark in white, the model name, a divider, the reasoning pips and a chevron.
  const paintChip = () => {
    const provider = state.provider, level = pyxEffortLevel(state.effort);
    chip.dataset.provider = provider ?? 'none';
    if (chipLogo) {
      chipLogo.replaceChildren();
      if (provider) { const path = doc.createElementNS(SVG_NS, 'path'); path.setAttribute('d', PYX_PROVIDER_MARKS[provider]); chipLogo.append(path); }
      chipLogo.toggleAttribute('hidden', !provider);
    }
    chipName.textContent = state.model ?? 'Choose model';
    pips.dataset.level = String(level); pips.hidden = level === 0; pips.title = level && state.effort ? 'Reasoning: ' + state.effort.toLowerCase() : '';
    const divider = doc.getElementById('pyx-model-divider'); if (divider) divider.hidden = level === 0;
    chip.setAttribute('aria-label', pyxModelLabel(state));
  };

  const paintSprite = () => {
    const spriteMood: PyxSpriteMood = mood === 'alert' ? 'idle' : mood;
    const g = spriteFrame(spriteMood, PYX_FRAME_MS[spriteMood] ? frame : 1);
    if (sprite.firstChild !== g) sprite.replaceChildren(g);
    badge?.toggleAttribute('hidden', mood !== 'alert');
    root.dataset.mood = mood; pet.dataset.mood = mood;
    if (moodText) moodText.textContent = PYX_STATUS[mood];
  };
  const schedule = () => {
    if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
    const spriteMood: PyxSpriteMood = mood === 'alert' ? 'idle' : mood, period = PYX_FRAME_MS[spriteMood];
    if (!period || !motionOn() || stopped) { if (frame !== 1) { frame = 1; paintSprite(); } return; }
    frameTimer = setTimeout(() => { frameTimer = null; frame = frame === 1 ? 2 : 1; paintSprite(); schedule(); }, period);
  };
  const paintPulse = () => {
    const on = working() && !steering && motionOn() && !stopped && typeof live?.animate === 'function';
    if (on && !pulse && live) pulse = live.animate([{ opacity: 1 }, { opacity: .35 }, { opacity: 1 }], { duration: 1200, iterations: Infinity, easing: 'ease-in-out' });
    else if (!on && pulse) { pulse.cancel(); pulse = null; }
  };

  const paintProgress = () => {
    const p = state.progress;
    statusTitle.textContent = p?.title ?? 'Working';
    const parts: string[] = [];
    if (p?.step !== null && p?.step !== undefined && p.steps) parts.push(p.step + ' of ' + p.steps);
    if (p?.startedAt) parts.push(pyxElapsed(now() - p.startedAt));
    statusCount.textContent = parts.join(' · ');
    const known = !!(p && p.steps && p.step !== null);
    progress.hidden = !known;
    if (known && p && p.steps) {
      progress.setAttribute('aria-valuemax', String(p.steps)); progress.setAttribute('aria-valuenow', String(p.step));
      fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, (p.step ?? 0) / p.steps)).toFixed(4) + ')';
    }
    status.setAttribute('aria-label', [p?.title ?? 'Working', ...parts].join(', ') + '. Add an instruction');
  };

  const announce = (message: string | null) => {
    if (!message || message === lastAnnounced) return;
    lastAnnounced = message; announcer.textContent = ''; // a fresh node text so the same phrase repeats after a change
    setTimeout(() => { if (!stopped) announcer.textContent = message; }, 30);
  };

  const paintBubble = () => {
    const message = localError ?? pyxBubbleText(state);
    const show = !!message && !(working() && !localError);
    bubble.hidden = !show;
    bubble.dataset.tone = localError || state.phase === 'error' || state.phase === 'offline' ? 'alert' : 'reply';
    if (bubbleOpen) bubbleOpen.hidden = !(state.phase === 'offline' && bridge);
    if (show && message) {
      bubbleText.textContent = message; bubble.title = message;
      if (message !== lastBubble) { lastBubble = message; restart(bubble, 'is-entering'); announce(message); }
    } else lastBubble = '';
  };

  const paintSuggestions = () => {
    const show = suggestions.length > 0 && !working() && state.phase !== 'offline';
    const key = show ? suggestions.map(s => s.text).join('\u0000') : '';
    chips.hidden = !show;
    if (key === suggestionsKey) return;
    suggestionsKey = key; chips.replaceChildren();
    if (!show) return;
    offered = suggestions.map(s => s.text);
    suggestions.forEach((s, i) => {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'pyx-suggestion pyx-hit is-entering'; button.dataset.index = String(i);
      button.title = s.label; // the whole label, when the chip had to shorten it
      const plus = doc.createElementNS(SVG_NS, 'svg'); plus.setAttribute('viewBox', '0 0 24 24'); plus.setAttribute('aria-hidden', 'true'); plus.setAttribute('focusable', 'false'); plus.setAttribute('class', 'pyx-suggestion-icon');
      for (const d of ['M12 5v14', 'M5 12h14']) { const path = doc.createElementNS(SVG_NS, 'path'); path.setAttribute('d', d); plus.append(path); }
      const label = doc.createElement('span'); label.textContent = s.label;
      button.append(plus, label);
      button.addEventListener('click', () => {
        steering = working();
        input.value = pyxFill(input.value, s.text, offered);
        input.focus(); const end = input.value.length; input.setSelectionRange(end, end); input.scrollLeft = input.scrollWidth;
        refresh(); // fills only: nothing is sent until Send or Enter
      });
      chips.append(button);
    });
  };

  const paintControls = () => {
    const isWorking = working(), showInput = !isWorking || steering, offline = state.phase === 'offline';
    root.dataset.phase = state.phase; root.dataset.steering = String(isWorking && steering);
    input.hidden = !showInput; status.hidden = showInput;
    input.placeholder = isWorking ? PYX_STEER_PLACEHOLDER : PYX_PLACEHOLDER;
    const canStop = isWorking && state.canStop && typeof bridge?.stop === 'function';
    if (stopButton) stopButton.hidden = !canStop || steering;
    send.hidden = isWorking && !steering;
    send.disabled = sending || offline || !bridge; // an empty box just focuses the input, as the canvas Send stays lit
    send.setAttribute('aria-disabled', String(send.disabled));
    form.setAttribute('aria-busy', String(sending));
  };

  const paintClock = () => {
    const needs = working() && !!state.progress?.startedAt && !stopped;
    if (needs && !clock) clock = setInterval(() => { if (!steering) paintProgress(); }, 1000);
    else if (!needs && clock) { clearInterval(clock); clock = null; }
  };

  const refresh = () => {
    if (stopped) return;
    if (!working()) steering = false;
    const next = pyxMood({ phase: state.phase, typing: typing(), doneUntil, now: now() });
    const entered = next !== mood; mood = next;
    if (entered) { frame = 1; if (mood === 'done') restart(pet, 'is-hopping'); }
    paintSprite(); schedule(); paintChip(); paintProgress(); paintControls(); paintBubble(); paintSuggestions(); paintPulse(); paintClock();
  };

  const applyState = (value: unknown) => {
    const previous = state; state = readPyxState(value);
    if(pickerShown&&(state.provider!==previous.provider||state.phase==='offline'))closePicker(false);
    if (state.phase !== 'error') localError = null;
    const finished = state.phase === 'done' || previous.phase === 'working' && state.phase === 'idle';
    if (finished && previous.phase !== 'done') {
      doneUntil = now() + PYX_DONE_HOLD_MS;
      if (doneTimer) clearTimeout(doneTimer);
      doneTimer = setTimeout(() => { doneTimer = null; refresh(); }, PYX_DONE_HOLD_MS + 20);
      suggestionsKey = ''; // the suggestions rise again after each finished turn
    }
    if (state.phase === 'working' && previous.phase !== 'working') { doneUntil = 0; restart(status, 'is-entering'); }
    refresh();
  };

  // ---- events
  const submit = async () => {
    const value = input.value.trim();
    if (!value || sending || !bridge || state.phase === 'offline') { input.focus(); return; }
    sending = true; localError = null; refresh();
    try {
      const result = await bridge.submit(value.slice(0, PYX_INPUT_MAX));
      if (result && result.accepted === true) { if (input.value.trim() === value) input.value = ''; steering = false; suggestions = []; }
      else localError = text((result as { message?: unknown } | null)?.message, 300) ?? 'Arcane didn’t take that. Your text is still here.';
    } catch { localError = 'Pyx couldn’t pass that to Arcane. Your text is still here.'; }
    finally { sending = false; refresh(); }
  };
  form.addEventListener('submit', event => { event.preventDefault(); void submit(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => { if (localError && state.phase !== 'offline') localError = null; refresh(); });
  input.addEventListener('focus', refresh);
  input.addEventListener('blur', () => { if (working() && !input.value.trim()) steering = false; refresh(); });
  status.addEventListener('click', () => { steering = true; refresh(); input.focus(); });
  // Typing while a turn runs opens the box for steering; the first key lands in it.
  doc.addEventListener('keydown', event => {
    if (ESCAPE_ONLY.has(event.key)) { if (event.isComposing) return; event.preventDefault();if(pickerShown){closePicker();return;} if (press?.moving) { endPress('cancel'); return; } requestClose(); return; }
    if(pickerShown&&picker?.contains(event.target as Node))return;
    if (working() && !steering && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && doc.activeElement !== input && !(doc.activeElement instanceof (win?.HTMLButtonElement ?? HTMLButtonElement) && event.key === ' ')) {
      event.preventDefault(); steering = true; input.value = (input.value + event.key).slice(0, PYX_INPUT_MAX); refresh(); input.focus(); const end = input.value.length; input.setSelectionRange(end, end); refresh();
    }
  });
  pet.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; event.preventDefault(); return; } // that press moved the bar
    try { bridge?.expandToMain(); } catch { /* the host owns the window */ }
  });
  pet.addEventListener('keydown', event => {
    const step = pyxNudge(event.key, event.shiftKey); if (!step || event.altKey || event.ctrlKey || event.metaKey || typeof bridge?.nudge !== 'function') return;
    event.preventDefault(); try { bridge?.nudge?.(step.dx, step.dy); } catch { /* the host owns the window */ }
  });
  closeButton?.addEventListener('click', () => requestClose());
  bubbleOpen?.addEventListener('click', () => { try { bridge?.expandToMain(); } catch { /* the host owns the window */ } });
  chip.addEventListener('click',event=>{if(event.isTrusted)void openPicker();});
  stopButton?.addEventListener('click', () => { try { bridge?.stop?.(); } catch { /* the host owns the turn */ } });
  // Transparent margins pass the pointer through to whatever is under the bar.
  const pointer = (event: Event) => {
    if (press) return; // a move in progress keeps the bar interactive until the pointer is released
    const target = event.target as Element | null, over = open && !!target?.closest?.('.pyx-hit');
    if (over !== interactive) { interactive = over; try { bridge?.setInteractive?.(over); } catch { /* optional */ } }
  };
  doc.addEventListener('pointermove', pointer, { passive: true });
  doc.addEventListener('pointerleave', () => { if (interactive !== false) { interactive = false; try { bridge?.setInteractive?.(false); } catch { /* optional */ } } });
  const visibility = () => { schedule(); paintPulse(); };
  doc.addEventListener('visibilitychange', visibility);
  media?.addEventListener?.('change', visibility);
  win?.addEventListener('focus', () => { if (open && (!doc.activeElement || doc.activeElement === doc.body)) focusInput(); });

  // ---- moving: press on the bar's body or on Pyx and drag. The host moves the window to follow the cursor.
  const canMove = () => typeof bridge?.drag === 'function';
  const handleFor = (target: EventTarget | null): HTMLElement | null => {
    const el = target as Element | null;
    if (!el || typeof (el as Element).closest !== 'function') return null;
    if (el.closest('.pyx-pet')) return pet;
    return el === form ? form : null; // the bar's own surface, never its input or buttons
  };
  const sendDrag = (phase: PyxDragPhase) => { try { bridge?.drag?.(phase); } catch { /* the host owns the window */ } };
  const endPress = (phase: 'end' | 'cancel') => {
    const current = press; press = null; if (!current) return;
    try { if (current.target.hasPointerCapture?.(current.id)) current.target.releasePointerCapture(current.id); } catch { /* already released */ }
    if (current.moving) { delete root.dataset.dragging; sendDrag('end'); if (current.target === pet) suppressClick = true; }
    else sendDrag('cancel');
  };
  form.addEventListener('pointerdown', event => {
    if (!open || !canMove() || event.button !== 0 || !event.isPrimary) return;
    const target = handleFor(event.target); if (!target) return;
    if (target === form) event.preventDefault(); // no text selection or focus change from the bar's surface
    press = { id: event.pointerId, x: event.screenX, y: event.screenY, target, moving: false };
    suppressClick = false;
    try { target.setPointerCapture(event.pointerId); } catch { /* synthetic pointers have nothing to capture */ }
    sendDrag('start'); // the host notes where the cursor and the window are now
  });
  doc.addEventListener('pointermove', event => {
    if (!press || event.pointerId !== press.id) return;
    if (!press.moving) {
      if (!pyxDragStarted(press.x, press.y, event.screenX, event.screenY)) return;
      press.moving = true; root.dataset.dragging = 'true';
    }
    sendDrag('move');
  });
  doc.addEventListener('pointerup', event => { if (press && event.pointerId === press.id) endPress('end'); });
  doc.addEventListener('pointercancel', event => { if (press && event.pointerId === press.id) endPress('cancel'); });
  form.addEventListener('lostpointercapture', event => { if (press && event.pointerId === press.id) endPress('end'); }, true);

  // ---- opening and closing: a pop in, a quicker pop out, then the host hides the window.
  const focusInput = () => {
    if (input.hidden) return;
    input.focus({ preventScroll: true });
    const end = input.value.length; try { input.setSelectionRange(end, end); } catch { /* not focusable yet */ }
  };
  const setOpen = (next: boolean) => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    open = next; root.dataset.open = String(next);
    interactive = null; // the host resets pass-through when the window hides; ask again on the next pointer move
    if (!next && press) endPress('cancel');
  };
  const show = () => {
    if (stopped) return;
    const was = open; setOpen(true);
    if (!was) { if (motionOn()) restart(pet, 'is-hopping'); focusInput(); }
  };
  /** × , Escape, or the host closing it (the perch): pop out, then hide. Nothing in the box is lost. */
  const requestClose = () => {
    if (stopped) return;
    closePicker(false);
    const finish = () => { closeTimer = null; try { bridge?.close(); } catch { /* the host owns the window */ } };
    if (!open) { finish(); return; }
    setOpen(false);
    if (reduced()) finish(); else closeTimer = setTimeout(finish, PYX_CLOSE_MS);
  };

  if (bridge && typeof bridge.onVisibility === 'function') {
    try { unsubscribe.push(bridge.onVisibility(value => { if (value === true) show(); else if (value === false && open) requestClose(); })); } catch { show(); }
  } else show(); // no host window to animate with: open from the start
  if (bridge) {
    try { unsubscribe.push(bridge.onState(applyState)); } catch { state = { ...PYX_OFFLINE_STATE, message: 'Pyx couldn’t read Arcane’s state.' }; }
    try { unsubscribe.push(bridge.onSuggestions(value => { suggestions = readPyxSuggestions(value); refresh(); })); } catch { suggestions = []; }
  }
  refresh();
  root.classList.add('is-ready');
  // Two frames: the closed state has painted, so the host can show the window without a flash, then pop it in.
  const raf = win?.requestAnimationFrame?.bind(win) ?? ((cb: FrameRequestCallback) => setTimeout(() => cb(now()), 16));
  raf(() => raf(() => { if (!stopped) { try { bridge?.ready?.(); } catch { /* optional */ } } }));

  return {
    mood: () => mood,
    state: () => state,
    isOpen: () => open,
    stop() {
      closePicker(false);
      stopped = true; if (closeTimer) clearTimeout(closeTimer);
      for (const off of unsubscribe.splice(0)) { try { off(); } catch { /* already gone */ } }
      if (frameTimer) clearTimeout(frameTimer); if (doneTimer) clearTimeout(doneTimer); if (clock) clearInterval(clock);
      pulse?.cancel(); pulse = null;
      doc.removeEventListener('visibilitychange', visibility); media?.removeEventListener?.('change', visibility);
    },
  };
}

/** A scripted bridge for tests and design previews: records every intent and never reaches a provider. */
export interface FakePyxBridge extends PyxBarBridge {
  readonly calls: { method: string; args: unknown[] }[];
  pushState(state: Partial<PyxBarState> & { phase: PyxPhase }): void;
  pushSuggestions(suggestions: readonly (string | PyxSuggestion)[]): void;
  /** What the next submit answers (default accepted). */
  nextSubmit: PyxSubmitResult | Error;
  /** Host windows only (options.window): say the bar is open or closed, as the perch does. */
  pushVisibility(open: boolean): void;
}
export function createFakePyxBridge(initial?: Partial<PyxBarState> & { phase: PyxPhase }, options: { stop?: boolean; picker?: boolean; window?: boolean } = {}): FakePyxBridge {
  const stateListeners = new Set<(state: unknown) => void>(), suggestionListeners = new Set<(s: unknown) => void>(), visibilityListeners = new Set<(open: boolean) => void>();
  let visible: boolean | null = null;
  let current: unknown = initial ?? { phase: 'idle' }, offered: unknown = [];
  const fake: FakePyxBridge = {
    version: 1, calls: [], nextSubmit: { accepted: true },
    submit(value: string) { fake.calls.push({ method: 'submit', args: [value] }); const r = fake.nextSubmit; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); },
    onState(listener) { stateListeners.add(listener); listener(current); return () => { stateListeners.delete(listener); }; },
    onSuggestions(listener) { suggestionListeners.add(listener); listener(offered); return () => { suggestionListeners.delete(listener); }; },
    close() { fake.calls.push({ method: 'close', args: [] }); },
    expandToMain() { fake.calls.push({ method: 'expandToMain', args: [] }); },
    setInteractive(on: boolean) { fake.calls.push({ method: 'setInteractive', args: [on] }); },
    pushState(next) { current = next; for (const l of stateListeners) l(next); },
    pushSuggestions(next) { offered = next; for (const l of suggestionListeners) l(next); },
    pushVisibility(open) { visible = open; for (const l of visibilityListeners) l(open); },
  };
  if (options.window) {
    fake.onVisibility = listener => { visibilityListeners.add(listener); if (visible !== null) listener(visible); return () => { visibilityListeners.delete(listener); }; };
    fake.ready = () => { fake.calls.push({ method: 'ready', args: [] }); };
    fake.drag = phase => { fake.calls.push({ method: 'drag', args: [phase] }); };
    fake.nudge = (dx, dy) => { fake.calls.push({ method: 'nudge', args: [dx, dy] }); };
  }
  if (options.stop !== false) fake.stop = () => { fake.calls.push({ method: 'stop', args: [] }); };
  if (options.picker){
    fake.models=async()=>{fake.calls.push({method:'models',args:[]});return {revision:'453f0fb4-f28b-434a-aee5-605261af915f',selectable:true,message:null,selected:null,models:[]};};
    fake.selectModel=async choice=>{fake.calls.push({method:'selectModel',args:[choice]});return{state:'applied'};};
    fake.pickerOpen=on=>{fake.calls.push({method:'pickerOpen',args:[on]});};
  }
  return fake;
}

// Boot inside the pop-out window (pyx-bar.html loads this module). Tests import the functions above instead.
if (typeof document !== 'undefined' && document.getElementById('pyx')?.dataset.autostart === 'true') startPyxBar(document);
