/**
 * Learned preferences: Arcane's local feedback loop. No model weights change. Preference records stay local; compact summaries join chat context.
 *
 *  1. CAPTURE  `extractObservations` turns one chat turn's Arcane tool calls (scene_build kits and scatter,
 *              environment_apply presets, assets_procedural generators/materials, skills) into parameter observations;
 *              `classifyFeedback` reads a short user message ("too plain", "perfect", "trees look the same") with a small
 *              deterministic keyword/pattern classifier and returns a polarity, a confidence and any specific aspects.
 *  2. LEARN    `learn` folds one signal into per-parameter preference weights: a Beta(1,1) posterior per option value whose
 *              pseudo-counts decay exponentially (30-day half-life), so repeated feedback strengthens a preference and stale
 *              feedback fades. Feedback that contradicts the current lean halves the opposing mass first, so the most recent
 *              opinion wins quickly.
 *  3. APPLY    `preferenceContext` is a compact (<= 600 characters), cache-stable "What this user likes" block for the chat
 *              context; `applyLearnedDefaults` fills only arguments a tool call omitted (explicit arguments always win);
 *              `skillBoosts` gives liked skills a small routing boost.
 *
 * Pure functions only: the daemon owns storage (preference-store.ts) and every caller passes `now` explicitly.
 */

export const PREFERENCE_LIMITS = Object.freeze({
  items: 160, contextChars: 600, contextItems: 6, labelChars: 96, reasonChars: 160, textChars: 2000,
  tools: 48, toolInputChars: 16_384, idChars: 96,
});
/** Evidence half-life: feedback older than this counts half as much. */
export const PREFERENCE_HALF_LIFE_MS = 30 * 24 * 3600 * 1000;
/** A value is acted on once its decayed evidence mass reaches this and its posterior mean leans clearly one way. */
export const PREFERENCE_ACTIVE_MASS = 0.6;
export const PREFERENCE_LIKE_MEAN = 0.6, PREFERENCE_DISLIKE_MEAN = 0.4;

export type FeedbackSource = 'explicit' | 'message' | 'undo' | 'reask' | 'keep' | 'review';
export type Polarity = 'positive' | 'negative' | 'neutral';
export interface Aspect { param: string; value: string; like: boolean }
export interface Classification { polarity: Polarity; confidence: number; aspects: Aspect[]; matched: string[] }
export interface Observation { param: string; value: string }
export interface ToolCall { name: string; input: unknown }
export interface PreferenceItem {
  id: string; param: string; value: string;
  /** Decayed positive / negative evidence mass (the Beta(1,1) prior is not stored). */
  like: number; dislike: number;
  /** Raw number of signals that touched this item (never decays; shown as evidence). */
  evidence: number;
  updatedAt: number;
  /** A human edit in Settings pins the item regardless of later evidence until it is edited again or deleted. */
  pinned: 'like' | 'dislike' | null;
}
export interface PreferenceState { version: 1; items: PreferenceItem[] }
export interface PreferenceView extends PreferenceItem { label: string; mean: number; mass: number; stance: 'like' | 'dislike' | 'unsure' }
export interface LearnChange { id: string; label: string; stance: 'like' | 'dislike' | 'unsure'; became: boolean }
export interface LearnResult { state: PreferenceState; changes: LearnChange[]; message: string | null }
export interface FeedbackSignal { source: FeedbackSource; polarity: Polarity; confidence: number; aspects: Aspect[] }

export const emptyPreferences = (): PreferenceState => ({ version: 1, items: [] });

// ---------------------------------------------------------------------------------------------------------------------
// Parameters: the closed set of things Arcane can learn and act on. Anything else is ignored, so a message can never
// smuggle in arbitrary keys.
// ---------------------------------------------------------------------------------------------------------------------
const STONES = ['Limestone', 'Marble', 'Granite', 'Sandstone', 'Slate', 'Basalt', 'Concrete', 'Cobblestone', 'Pavement'] as const;
const PRESETS = ['clear_day', 'night', 'horror', 'forest-morning', 'forest-noon', 'forest-golden-hour', 'forest-overcast', 'forest-dusk'] as const;
const LIBRARY = /^[a-z][a-z-]{1,31}$/;
const SKILL = /^arcane-[a-z0-9]+(?:-[a-z0-9]+)*$/;
type Param = { values: (value: string) => boolean; label: (value: string, like: boolean) => string };
const oneOf = (list: readonly string[]) => (value: string) => list.includes(value);
const PARAMS: Record<string, Param> = {
  'forest.density': { values: oneOf(['sparse', 'medium', 'dense']), label: (v, like) => like
    ? { sparse: 'sparse, open forests (density <0.4)', medium: 'medium-density forests', dense: 'dense forests (density ≥0.8)' }[v]!
    : { sparse: 'sparse, empty-looking forests', medium: 'medium-density forests', dense: 'crowded forests' }[v]! },
  'forest.species': { values: oneOf(['mixed', 'single']), label: (v, like) => v === 'mixed' ? (like ? 'mixed-species forests' : 'mixed-species forests') : (like ? 'single-species forests' : 'single-species forests') },
  'scatter.variation': { values: oneOf(['varied', 'uniform']), label: (v, like) => v === 'varied' ? (like ? 'varied trees and props (size/tint variation, variant families)' : 'heavy size/tint variation')
    : (like ? 'uniform, matching props' : 'identical trees') },
  'stone.material': { values: oneOf(STONES), label: v => v.toLowerCase() + ' stone' },
  'stone.weathering': { values: oneOf(['clean', 'light', 'weathered']), label: (v, like) => v === 'weathered' ? 'weathered, aged stone' : v === 'clean' ? 'clean, unweathered stone' : (like ? 'lightly weathered stone' : 'barely weathered stone') },
  'stone.surface': { values: v => v === 'plain' || LIBRARY.test(v) && v.startsWith('stone-'), label: (v, like) => v === 'plain' ? (like ? 'plain stone' : 'plain stone; use ashlar with weathering') : v.replace('stone-', '') + ' stone surfaces' },
  'detail.level': { values: oneOf(['rich', 'simple']), label: (v, like) => v === 'rich' ? (like ? 'rich detail (weathering, variation, undergrowth)' : 'busy, over-detailed builds') : (like ? 'simple, clean builds' : 'plain, bare-looking builds') },
  'lighting.preset': { values: oneOf(PRESETS), label: v => ({ clear_day: 'clear daylight', night: 'night lighting', horror: 'dark horror lighting', 'forest-morning': 'morning light',
    'forest-noon': 'bright noon light', 'forest-golden-hour': 'golden-hour lighting', 'forest-overcast': 'overcast light', 'forest-dusk': 'dusk lighting' } as Record<string, string>)[v]! },
  'lighting.time': { values: oneOf(['day', 'golden', 'night']), label: v => ({ day: 'daytime light', golden: 'warm golden-hour light', night: 'night scenes' } as Record<string, string>)[v]! },
  'tree.foliage': { values: oneOf(['lush', 'sparse']), label: v => v === 'lush' ? 'full, lush tree canopies' : 'sparse, open canopies' },
  'rock.moss': { values: oneOf(['mossy', 'bare']), label: v => v === 'mossy' ? 'mossy rocks and logs' : 'bare rocks without moss' },
  'procedural.variants': { values: oneOf(['family', 'single']), label: (v, like) => v === 'family' ? 'variant families for repeated models' : (like ? 'single repeated models' : 'one model repeated everywhere') },
  'skill': { values: v => SKILL.test(v), label: v => 'the ' + v.replace(/^arcane-/, '').replaceAll('-', ' ') + ' guide' },
};
export const PREFERENCE_PARAMS = Object.freeze(Object.keys(PARAMS));
export function validPreference(param: string, value: string): boolean {
  return Object.hasOwn(PARAMS, param) && typeof value === 'string' && value.length > 0 && value.length <= 48 && PARAMS[param]!.values(value);
}
export const preferenceId = (param: string, value: string) => param + '=' + value;
export function preferenceLabel(item: Pick<PreferenceItem, 'param' | 'value'>, like: boolean): string {
  const label = Object.hasOwn(PARAMS, item.param) ? PARAMS[item.param]!.label(item.value, like) : item.param + ' ' + item.value;
  return label.slice(0, PREFERENCE_LIMITS.labelChars);
}

// ---------------------------------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------------------------------
const decay = (mass: number, since: number, now: number) => since >= now ? mass : mass * Math.pow(0.5, (now - since) / PREFERENCE_HALF_LIFE_MS);
const round = (value: number) => Math.round(value * 10_000) / 10_000;
export function scoreItem(item: PreferenceItem, now: number): { mean: number; mass: number; stance: 'like' | 'dislike' | 'unsure' } {
  const like = decay(item.like, item.updatedAt, now), dislike = decay(item.dislike, item.updatedAt, now), mass = like + dislike;
  const mean = (like + 1) / (mass + 2);
  if (item.pinned) return { mean: item.pinned === 'like' ? Math.max(mean, 0.9) : Math.min(mean, 0.1), mass: Math.max(mass, 1), stance: item.pinned };
  const stance = mass >= PREFERENCE_ACTIVE_MASS && mean >= PREFERENCE_LIKE_MEAN ? 'like' : mass >= PREFERENCE_ACTIVE_MASS && mean <= PREFERENCE_DISLIKE_MEAN ? 'dislike' : 'unsure';
  return { mean, mass, stance };
}
export function viewPreferences(state: PreferenceState, now: number): PreferenceView[] {
  return state.items.map(item => { const s = scoreItem(item, now); return { ...item, ...s, label: preferenceLabel(item, s.stance !== 'dislike') }; })
    .sort((a, b) => strength(b) - strength(a) || a.id.localeCompare(b.id));
}
const strength = (view: { mean: number; mass: number }) => Math.abs(view.mean - 0.5) * Math.min(view.mass, 6);

// ---------------------------------------------------------------------------------------------------------------------
// Classifier: deterministic keyword/pattern rules. Confidence is the strongest matched rule, reduced for questions and for
// long messages that are mostly a new request.
// ---------------------------------------------------------------------------------------------------------------------
type Rule = [RegExp, Polarity, number, string];
const RULES: Rule[] = [
  [/\b(?:no problem|no worries|not bad)\b/, 'positive', 0.6, 'no-problem'],
  [/\b(?:not|isn'?t|aren'?t|doesn'?t look|don'?t (?:like|love))\s+(?:quite\s+|very\s+|that\s+|so\s+)?(?:good|great|right|perfect|nice|it|what i (?:wanted|asked for)|better|ok(?:ay)?)\b/, 'negative', 0.85, 'negated-praise'],
  [/\b(?:terrible|awful|horrible|ugly|hideous|hate (?:it|this|that)|garbage|trash|worse|wrong|broken|cheap|fake|amateur)\b/, 'negative', 0.9, 'strong-negative'],
  [/\b(?:bad|meh|nope|weird|off|boring|bland|dull|lifeless|empty|messy|cluttered)\b/, 'negative', 0.75, 'negative-word'],
  [/\b(?:too|way too|so)\s+(?:plain|simple|basic|flat|sparse|thin|empty|bare|dense|crowded|busy|dark|bright|small|big|large|uniform|repetitive|samey|clean|dirty|blurry|green|grey|gray|saturated)\b/, 'negative', 0.8, 'too-x'],
  [/\b(?:not enough|needs? (?:more|less|to be)|lacks?|missing|could be better|should be|instead)\b/, 'negative', 0.65, 'needs-change'],
  [/\b(?:look|looks|are|is)\s+(?:all\s+)?(?:the same|identical|alike|samey|copy[- ]?pasted)\b|\bidentical\b|\bclones?\b/, 'negative', 0.8, 'identical'],
  [/\b(?:undo|revert|roll ?back|remove (?:it|this|that|them)|delete (?:it|this|that|them)|redo|try again|start over|do it again)\b/, 'negative', 0.75, 'redo'],
  [/^\s*(?:no+|nah|nope)\b(?![- ]?(?:problem|worries))/, 'negative', 0.7, 'leading-no'],
  [/\b(?:perfect|love (?:it|this|that|the)|amazing|awesome|excellent|fantastic|beautiful|gorgeous|stunning|nailed it|exactly(?: what i wanted)?|spot on|great (?:job|work)|well done)\b/, 'positive', 0.92, 'strong-positive'],
  [/\b(?:looks?|that'?s|it'?s|this is|is)\s+(?:really\s+|pretty\s+|very\s+)?(?:good|great|nice|fine|ok(?:ay)?|better|right|cool|lovely)\b|\bmuch better\b|\bkeep (?:it|this|that)\b|\bi like (?:it|this|that|the)\b/, 'positive', 0.8, 'looks-good'],
  [/^\s*(?:yes|yep|yeah|yup|ok(?:ay)?|good|great|nice|cool|thanks|thank you|ty|sweet|works)\b/, 'positive', 0.7, 'leading-yes'],
];
type AspectRule = { pattern: RegExp; aspects: Aspect[] | ((positive: boolean) => Aspect[]) };
const like = (param: string, value: string): Aspect => ({ param, value, like: true });
const dislike = (param: string, value: string): Aspect => ({ param, value, like: false });
const lexical = (param: string, value: string) => (positive: boolean): Aspect[] => [{ param, value, like: positive }];
const ASPECTS: AspectRule[] = [
  { pattern: /\b(?:too|so|way too|really)\s+(?:sparse|thin|empty|bare|open)\b|\bnot (?:dense|thick|full) enough\b|\b(?:more|denser|thicker|fuller)\s+(?:trees|forest|woods|foliage)\b|\bneeds? more trees\b|\b(?:denser|thicker)\b/,
    aspects: [like('forest.density', 'dense'), dislike('forest.density', 'sparse')] },
  { pattern: /\b(?:too|so|way too)\s+(?:dense|crowded|cluttered|busy|thick|packed)\b|\bfewer trees\b|\bless dense\b|\bsparser\b|\bmore (?:space|room|clearings?)\b/,
    aspects: [like('forest.density', 'sparse'), dislike('forest.density', 'dense')] },
  { pattern: /\b(?:look|looks|are|is)\s+(?:all\s+)?(?:the same|identical|alike|samey|copy[- ]?pasted)\b|\bidentical\b|\bclones?\b|\btoo (?:uniform|repetitive|samey)\b|\bmore (?:variety|variation|variance)\b|\b(?:all|every) (?:tree|rock|bush)s? (?:is|are|look) the same\b/,
    aspects: [like('scatter.variation', 'varied'), dislike('scatter.variation', 'uniform'), like('procedural.variants', 'family')] },
  { pattern: /\bplain stone\b|\b(?:stone|rock|plinth|wall|pillar|marble|column|floor)s?\b[^.!?]{0,30}\b(?:plain|boring|flat|bland|too clean|basic)\b|\b(?:plain|boring|flat|bland)\b[^.!?]{0,20}\b(?:stone|rock|plinth|wall|pillar|marble|column)s?\b/,
    aspects: [dislike('stone.surface', 'plain'), like('stone.surface', 'stone-ashlar'), like('stone.weathering', 'weathered')] },
  { pattern: /\btoo (?:plain|simple|basic|flat|bland|boring)\b|\b(?:more|needs?|lacks?|missing)\s+(?:some\s+)?(?:detail|details|detailing|texture|character)\b|\bboring\b|\bbland\b|\blifeless\b/,
    aspects: [like('detail.level', 'rich'), dislike('detail.level', 'simple')] },
  { pattern: /\btoo (?:busy|cluttered|detailed|noisy|much going on)\b|\bsimpler\b|\bcleaner\b|\bless (?:detail|clutter)\b/,
    aspects: [like('detail.level', 'simple'), dislike('detail.level', 'rich')] },
  { pattern: /\b(?:more|too little|not enough)\s+(?:weathering|wear|moss|age|grime)\b|\b(?:weathered|aged|worn|ancient|old|ruined)\b(?![^.!?]{0,12}\btoo\b)/, aspects: p => [{ param: 'stone.weathering', value: 'weathered', like: p }] },
  { pattern: /\btoo (?:worn|dirty|weathered|grimy|old)\b|\b(?:clean(?:er)?|new(?:er)?|pristine|polished)\s+(?:stone|marble|look)\b/, aspects: [like('stone.weathering', 'clean'), dislike('stone.weathering', 'weathered')] },
  { pattern: /\bashlar\b/, aspects: lexical('stone.surface', 'stone-ashlar') },
  { pattern: /\bcobble(?:stone)?s?\b/, aspects: lexical('stone.material', 'Cobblestone') },
  { pattern: /\bmarble\b/, aspects: lexical('stone.material', 'Marble') },
  { pattern: /\bgranite\b/, aspects: lexical('stone.material', 'Granite') },
  { pattern: /\bsandstone\b/, aspects: lexical('stone.material', 'Sandstone') },
  { pattern: /\bslate\b/, aspects: lexical('stone.material', 'Slate') },
  { pattern: /\bbasalt\b/, aspects: lexical('stone.material', 'Basalt') },
  { pattern: /\bgolden[- ]?hour\b|\bsunset\b|\bwarm (?:light|lighting|glow)\b/, aspects: p => [{ param: 'lighting.preset', value: 'forest-golden-hour', like: p }, { param: 'lighting.time', value: 'golden', like: p }] },
  { pattern: /\bovercast\b|\bcloudy\b/, aspects: lexical('lighting.preset', 'forest-overcast') },
  { pattern: /\bdusk\b|\btwilight\b/, aspects: lexical('lighting.preset', 'forest-dusk') },
  { pattern: /\bmorning (?:light|sun)\b|\bsunrise\b/, aspects: lexical('lighting.preset', 'forest-morning') },
  { pattern: /\btoo dark\b|\bbrighter\b|\bcan'?t see\b/, aspects: [like('lighting.time', 'day'), dislike('lighting.time', 'night')] },
  { pattern: /\btoo bright\b|\bdarker\b|\bmoodier\b/, aspects: [dislike('lighting.time', 'day')] },
  { pattern: /\bmore (?:leaves|foliage|canopy)\b|\bleafier\b|\blush(?:er)?\b|\bfuller (?:trees|canopy|canopies)\b|\b(?:trees|canopy) (?:look )?(?:too )?(?:bare|thin|sparse)\b/, aspects: [like('tree.foliage', 'lush'), dislike('tree.foliage', 'sparse')] },
  { pattern: /\btoo (?:leafy|many leaves)\b|\bfewer leaves\b/, aspects: [like('tree.foliage', 'sparse'), dislike('tree.foliage', 'lush')] },
  { pattern: /\bmore moss\b|\bmossy\b|\bmossier\b/, aspects: p => [{ param: 'rock.moss', value: 'mossy', like: p }] },
  { pattern: /\b(?:no|less|without) moss\b|\btoo mossy\b/, aspects: [like('rock.moss', 'bare'), dislike('rock.moss', 'mossy')] },
  { pattern: /\b(?:mixed|more) (?:species|tree types|kinds of trees)\b/, aspects: [like('forest.species', 'mixed')] },
];
const STRIP = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g;
export function normalizeFeedbackText(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.slice(0, PREFERENCE_LIMITS.textChars).normalize('NFKC').replace(STRIP, ' ').replace(/[‘’ʼ]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim();
}
/**
 * Classifies one short message. A message with no matched rule is neutral (it is a new request, not feedback). Aspects are
 * returned even without a clear polarity ("trees look the same" is a complaint by itself).
 */
export function classifyFeedback(raw: unknown): Classification {
  const text = normalizeFeedbackText(raw);
  if (!text) return { polarity: 'neutral', confidence: 0, aspects: [], matched: [] };
  let positive = 0, negative = 0; const matched: string[] = [];
  for (const [pattern, polarity, weight, name] of RULES) {
    if (!pattern.test(text)) continue;
    matched.push(name);
    if (name === 'no-problem') { positive = Math.max(positive, weight); continue; }
    if (polarity === 'positive') positive = Math.max(positive, weight); else negative = Math.max(negative, weight);
  }
  // "not perfect" / "not good": the negated-praise rule also matches the praise rule; negation wins.
  if (matched.includes('negated-praise')) positive = 0;
  // "no, not good" and "no that's ok"? A leading "no" followed by praise is mixed; treat as the stronger one.
  let polarity: Polarity = 'neutral', confidence = 0;
  if (negative > 0 || positive > 0) {
    if (negative >= positive) { polarity = 'negative'; confidence = negative - (positive ? 0.25 * positive : 0); }
    else { polarity = 'positive'; confidence = positive - (negative ? 0.25 * negative : 0); }
  }
  const aspects: Aspect[] = [];
  const add = (aspect: Aspect) => { if (validPreference(aspect.param, aspect.value) && !aspects.some(a => a.param === aspect.param && a.value === aspect.value)) aspects.push(aspect); };
  for (const rule of ASPECTS) {
    if (!rule.pattern.test(text)) continue;
    const list = typeof rule.aspects === 'function' ? rule.aspects(polarity !== 'negative') : rule.aspects;
    list.forEach(add);
  }
  if (aspects.length && polarity === 'neutral') { polarity = 'negative'; confidence = 0.6; }
  // Questions and long new requests are weaker evidence about the previous output.
  const words = text.split(' ').length;
  if (/\?\s*$/.test(text)) confidence *= 0.6;
  if (words > 24) confidence *= 0.7; else if (words > 12) confidence *= 0.85;
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(3))));
  if (confidence < 0.3) return { polarity: 'neutral', confidence, aspects: [], matched };
  return { polarity, confidence, aspects, matched };
}

/** Token-overlap similarity of two requests (re-asking for the same thing). */
export function requestSimilarity(a: unknown, b: unknown): number {
  const words = (value: unknown) => new Set(normalizeFeedbackText(value).match(/[a-z0-9]{3,}/g) ?? []);
  const x = words(a), y = words(b);
  if (x.size < 3 || y.size < 3) return 0;
  let shared = 0; for (const word of x) if (y.has(word)) shared++;
  return shared / (x.size + y.size - shared);
}

// ---------------------------------------------------------------------------------------------------------------------
// Observations from tool calls
// ---------------------------------------------------------------------------------------------------------------------
const rec = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const parse = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') { if (value.length > PREFERENCE_LIMITS.toolInputChars) return null; try { return rec(JSON.parse(value)); } catch { return null; } }
  return rec(value);
};
/** Trees per 250 square studs (16-stud spacing = 1.0). Kit defaults: 80 trees. */
export function forestDensity(trees: number, radius: number): number { return trees * 250 / (Math.PI * radius * radius); }
export const densityBucket = (density: number) => density >= 0.8 ? 'dense' : density < 0.4 ? 'sparse' : 'medium';
const weatheringBucket = (value: number) => value >= 0.65 ? 'weathered' : value < 0.3 ? 'clean' : 'light';
const toolName = (name: string) => name.replace(/^mcp__[A-Za-z0-9_-]+__/, '');
const SCENE_TOOLS = new Set(['scene_build', 'environment_apply', 'assets_procedural', 'skills_get', 'skills_recommend', 'terrain_generate', 'scene_create', 'scene_update', 'script_update']);
/** True when a tool call produced (or shaped) something the user can judge. */
export function isOutputTool(name: string): boolean { return SCENE_TOOLS.has(toolName(name)); }
export function extractObservations(calls: readonly ToolCall[]): Observation[] {
  const out: Observation[] = [];
  const add = (param: string, value: string) => { if (validPreference(param, value) && !out.some(o => o.param === param && o.value === value)) out.push({ param, value }); };
  for (const call of calls.slice(0, PREFERENCE_LIMITS.tools)) {
    const name = toolName(String(call?.name ?? '')), input = parse(call?.input);
    if (!input) continue;
    if (name === 'scene_build') {
      for (const raw of Array.isArray(input.kits) ? input.kits.slice(0, 8) : []) {
        const kit = rec(raw); if (!kit) continue;
        if (kit.kind === 'forest') {
          const radius = num(kit.radius), trees = num(kit.trees) ?? 80;
          if (radius && radius > 0) add('forest.density', densityBucket(forestDensity(trees, radius)));
          const species = Array.isArray(kit.species) ? kit.species.length : 6;
          add('forest.species', species >= 3 ? 'mixed' : 'single');
          add('detail.level', (num(kit.undergrowth) ?? trees * 2) > 0 ? 'rich' : 'simple');
        } else if (kit.kind === 'plinth') {
          add('stone.material', typeof kit.material === 'string' ? kit.material : 'Limestone');
          const weathering = num(kit.weathering) ?? 0.5;
          add('stone.weathering', weatheringBucket(weathering));
          add('stone.surface', 'plain');
          add('detail.level', weathering >= 0.65 || kit.style === 'fluted' ? 'rich' : 'simple');
        }
      }
      for (const raw of Array.isArray(input.scatter) ? input.scatter.slice(0, 16) : []) {
        const layer = rec(raw); if (!layer) continue;
        const scale = Array.isArray(layer.scale) ? layer.scale.map(num) : null;
        const spread = scale && scale[0] !== null && scale[1] !== null ? (scale[1] as number) - (scale[0] as number) : 0.5;
        add('scatter.variation', layer.tint !== undefined || spread >= 0.6 || Array.isArray(layer.use) && layer.use.length >= 3 ? 'varied' : 'uniform');
      }
    } else if (name === 'environment_apply') {
      if (typeof input.preset === 'string') add('lighting.preset', input.preset);
      const lighting = rec(input.lighting), clock = num(lighting?.ClockTime) ?? (typeof input.preset === 'string' ? ({ night: 0, horror: 0, 'forest-golden-hour': 18, 'forest-dusk': 19 } as Record<string, number>)[input.preset] ?? 12 : null);
      if (clock !== null) add('lighting.time', clock < 5 || clock >= 20 ? 'night' : clock < 7.5 || clock >= 16.5 ? 'golden' : 'day');
    } else if (name === 'assets_procedural') {
      const generator = rec(input.generator), kind = generator?.kind;
      add('procedural.variants', Array.isArray(input.variant) ? 'family' : 'single');
      if (kind === 'tree') { const leaves = num(generator!.leafDensity); if (leaves !== null) add('tree.foliage', leaves >= 0.7 ? 'lush' : leaves <= 0.4 ? 'sparse' : ''); }
      if (kind === 'foliage') { const density = num(generator!.density); if (density !== null) add('tree.foliage', density >= 0.7 ? 'lush' : density <= 0.4 ? 'sparse' : ''); }
      if (kind === 'rock' || kind === 'log' || kind === 'stump') add('rock.moss', generator!.moss === true ? 'mossy' : 'bare');
      if (kind === 'spec') for (const raw of Array.isArray(generator!.materials) ? generator!.materials.slice(0, 3) : []) {
        const material = rec(raw); if (!material || material.finish !== 'stone') continue;
        add('stone.surface', typeof material.library === 'string' ? material.library : 'plain');
        const wear = num(material.wear); if (wear !== null) add('stone.weathering', weatheringBucket(wear));
      }
    } else if (name === 'skills_get') {
      for (const id of Array.isArray(input.ids) ? input.ids.slice(0, 8) : []) if (typeof id === 'string') add('skill', id.split(':')[0]!);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------------------------------------------------
const SOURCE_WEIGHT: Record<FeedbackSource, number> = { explicit: 1, keep: 1.2, review: 1, message: 1, undo: 0.8, reask: 0.5 };
function touch(items: Map<string, PreferenceItem>, param: string, value: string, likes: boolean, weight: number, now: number): PreferenceItem | null {
  if (!validPreference(param, value) || !(weight > 0)) return null;
  const id = preferenceId(param, value), existing = items.get(id);
  const item: PreferenceItem = existing ? { ...existing } : { id, param, value, like: 0, dislike: 0, evidence: 0, updatedAt: now, pinned: null };
  item.like = decay(item.like, item.updatedAt, now); item.dislike = decay(item.dislike, item.updatedAt, now);
  // Contradiction: the newest opinion wins quickly. Halve the opposing mass before adding this signal.
  if (likes && item.dislike > item.like) item.dislike *= 0.5;
  if (!likes && item.like > item.dislike) item.like *= 0.5;
  if (likes) item.like += weight; else item.dislike += weight;
  item.like = round(item.like); item.dislike = round(item.dislike);
  item.evidence = Math.min(item.evidence + 1, 1_000_000); item.updatedAt = now;
  // A new signal releases a human pin only when it agrees; edits in Settings stay authoritative otherwise.
  items.set(id, item);
  return item;
}
/** Bounded state: drop the weakest, oldest items beyond the limit. */
function prune(items: PreferenceItem[], now: number): PreferenceItem[] {
  if (items.length <= PREFERENCE_LIMITS.items) return items;
  return [...items].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || scoreItem(b, now).mass - scoreItem(a, now).mass || b.updatedAt - a.updatedAt)
    .slice(0, PREFERENCE_LIMITS.items);
}
/**
 * Folds one feedback signal on one output into the state. Specific aspects ("too sparse") take full weight; the output's
 * own observed values take full weight when the feedback is general ("no, not good"), and a quarter when the user named a
 * specific aspect (the rest of the build was not what they complained about). A value the user asked to move away from
 * gets the opposite evidence.
 */
export function learn(state: PreferenceState, signal: FeedbackSignal, observations: readonly Observation[], now: number): LearnResult {
  if (signal.polarity === 'neutral' && !signal.aspects.length) return { state, changes: [], message: null };
  const weight = Math.max(0, Math.min(1.5, signal.confidence * SOURCE_WEIGHT[signal.source]));
  const items = new Map(state.items.map(item => [item.id, item]));
  const before = new Map(state.items.map(item => [item.id, scoreItem(item, now).stance]));
  const touched = new Set<string>();
  const aspectParams = new Set(signal.aspects.map(a => a.param));
  for (const aspect of signal.aspects) { const item = touch(items, aspect.param, aspect.value, aspect.like, weight, now); if (item) touched.add(item.id); }
  if (signal.polarity !== 'neutral') {
    const positive = signal.polarity === 'positive';
    for (const o of observations) {
      if (aspectParams.has(o.param)) {
        // The user named this parameter: an observed value the aspect did not ask for is the thing to move away from.
        if (!positive && !signal.aspects.some(a => a.param === o.param && a.value === o.value)) { const item = touch(items, o.param, o.value, false, weight * 0.5, now); if (item) touched.add(item.id); }
        continue;
      }
      const item = touch(items, o.param, o.value, positive, signal.aspects.length ? weight * 0.25 : weight, now);
      if (item) touched.add(item.id);
    }
  }
  const next: PreferenceState = { version: 1, items: prune([...items.values()], now).sort((a, b) => a.id.localeCompare(b.id)) };
  const changes: LearnChange[] = [];
  for (const id of touched) {
    const item = next.items.find(row => row.id === id); if (!item) continue;
    const stance = scoreItem(item, now).stance;
    changes.push({ id, label: preferenceLabel(item, stance !== 'dislike'), stance, became: stance !== 'unsure' && before.get(id) !== stance });
  }
  changes.sort((a, b) => Number(b.became) - Number(a.became) || (a.stance === 'unsure' ? 1 : 0) - (b.stance === 'unsure' ? 1 : 0) || a.id.localeCompare(b.id));
  return { state: next, changes, message: learningMessage(changes, signal) };
}
/** The chat's one-line "Learning" note: what Arcane will do differently next time. */
export function learningMessage(changes: readonly LearnChange[], signal: Pick<FeedbackSignal, 'polarity'>): string | null {
  const decided = changes.filter(change => change.stance !== 'unsure');
  if (!decided.length) return changes.length ? (signal.polarity === 'positive' ? 'Noted — that helps me learn what you like.' : 'Noted — I\'ll take that into account.') : null;
  const plain = (label: string) => label.split(';')[0]!.replace(/\s*\([^)]*\)/g, '');
  const avoid = decided.filter(change => change.stance === 'dislike').map(change => plain(change.label));
  const keep = decided.filter(change => change.stance === 'like').map(change => plain(change.label));
  const list = (values: string[]) => values.slice(0, 2).join(' and ');
  if (avoid.length && keep.length) return `Got it — I'll avoid ${list(avoid)} and lean towards ${list(keep)} next time.`;
  if (avoid.length) return `Got it — I'll avoid ${list(avoid)} next time.`;
  return signal.polarity === 'positive' ? `Got it — I'll keep using ${list(keep)}.` : `Got it — I'll go for ${list(keep)} next time.`;
}

/** A human edit from Settings: pin like/dislike, or clear the pin. */
export function editPreference(state: PreferenceState, id: string, stance: 'like' | 'dislike' | null, now: number): PreferenceState {
  const items = state.items.map(item => item.id === id ? { ...item, pinned: stance, updatedAt: now, like: decay(item.like, item.updatedAt, now), dislike: decay(item.dislike, item.updatedAt, now) } : item);
  if (!items.some(item => item.id === id)) {
    const [param, value] = id.split(/=(.*)/s) as [string, string];
    if (stance && validPreference(param, value ?? '')) items.push({ id: preferenceId(param, value), param, value, like: 0, dislike: 0, evidence: 0, updatedAt: now, pinned: stance });
  }
  return { version: 1, items: items.sort((a, b) => a.id.localeCompare(b.id)) };
}
export function removePreference(state: PreferenceState, id: string): PreferenceState { return { version: 1, items: state.items.filter(item => item.id !== id) }; }

/** Strict reader for persisted state (unknown params, malformed numbers and duplicates are dropped). */
export function readPreferenceState(value: unknown): PreferenceState | null {
  const root = rec(value); if (!root || root.version !== 1 || !Array.isArray(root.items)) return null;
  const items: PreferenceItem[] = [], seen = new Set<string>();
  for (const raw of root.items.slice(0, PREFERENCE_LIMITS.items)) {
    const row = rec(raw); if (!row) continue;
    const param = row.param, value = row.value;
    if (typeof param !== 'string' || typeof value !== 'string' || !validPreference(param, value)) continue;
    const id = preferenceId(param, value); if (seen.has(id)) continue;
    const like = num(row.like), dislike = num(row.dislike), evidence = num(row.evidence), updatedAt = num(row.updatedAt);
    if (like === null || dislike === null || evidence === null || updatedAt === null || like < 0 || dislike < 0 || like > 1e6 || dislike > 1e6 || evidence < 0) continue;
    const pinned = row.pinned === 'like' || row.pinned === 'dislike' ? row.pinned : null;
    seen.add(id); items.push({ id, param, value, like, dislike, evidence: Math.round(evidence), updatedAt, pinned });
  }
  return { version: 1, items: items.sort((a, b) => a.id.localeCompare(b.id)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Applying what was learned
// ---------------------------------------------------------------------------------------------------------------------
/** Project preferences win over the global layer for the same option value. */
export function mergeLayers(project: PreferenceState, global: PreferenceState): PreferenceState {
  const items = new Map(global.items.map(item => [item.id, item]));
  for (const item of project.items) items.set(item.id, item);
  return { version: 1, items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
export interface LearnedBias {
  /** param -> liked value (the strongest liked value of that parameter). */
  prefer: Record<string, string>;
  /** param -> disliked values. */
  avoid: Record<string, string[]>;
  /** skill id -> small routing boost. */
  boosts: Record<string, number>;
}
export function learnedBias(state: PreferenceState, now: number): LearnedBias {
  const prefer: Record<string, string> = {}, avoid: Record<string, string[]> = {}, boosts: Record<string, number> = {};
  const best: Record<string, number> = {};
  for (const view of viewPreferences(state, now)) {
    if (view.stance === 'like') {
      const s = strength(view);
      if (!(view.param in best) || s > best[view.param]!) { best[view.param] = s; prefer[view.param] = view.value; }
      if (view.param === 'skill') boosts[view.value] = Math.min(4, Math.round(1 + 3 * Math.min(1, strength(view) / 1.5)));
    } else if (view.stance === 'dislike') (avoid[view.param] ??= []).push(view.value);
  }
  for (const list of Object.values(avoid)) list.sort();
  return { prefer, avoid, boosts };
}
export function readLearnedBias(value: unknown): LearnedBias {
  const root = rec(value), prefer: Record<string, string> = {}, avoid: Record<string, string[]> = {}, boosts: Record<string, number> = {};
  for (const [param, item] of Object.entries(rec(root?.prefer) ?? {})) if (typeof item === 'string' && validPreference(param, item)) prefer[param] = item;
  for (const [param, list] of Object.entries(rec(root?.avoid) ?? {})) if (Array.isArray(list)) {
    const values = list.filter((item): item is string => typeof item === 'string' && validPreference(param, item)).slice(0, 16); if (values.length) avoid[param] = values;
  }
  for (const [id, boost] of Object.entries(rec(root?.boosts) ?? {})) if (SKILL.test(id) && typeof boost === 'number' && boost > 0 && boost <= 4) boosts[id] = boost;
  return { prefer, avoid, boosts };
}
/**
 * The chat context block. Only decided items, strongest first up to PREFERENCE_LIMITS.contextItems, then listed in id order so
 * the text (and the provider's cached prompt prefix) changes only when the set of learned preferences changes.
 */
export function preferenceContext(state: PreferenceState, now: number): string {
  const views = viewPreferences(state, now).filter(view => view.stance !== 'unsure' && view.param !== 'skill').slice(0, PREFERENCE_LIMITS.contextItems)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!views.length) return '';
  const head = 'What this user likes (learned locally from their feedback on earlier results; their explicit requests always win):';
  let text = head;
  for (const view of views) {
    const line = '\n- ' + (view.stance === 'like' ? 'prefers ' : 'avoid: ') + view.label;
    if (text.length + line.length > PREFERENCE_LIMITS.contextChars) break;
    text += line;
  }
  return text === head ? '' : text;
}

export interface BiasResult<T> { input: T; applied: string[] }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const likes = (bias: LearnedBias, param: string, value: string) => bias.prefer[param] === value;
const avoids = (bias: LearnedBias, param: string, value: string) => !!bias.avoid[param]?.includes(value);
/**
 * Fills learned defaults into a tool call's input where the call omitted them. Only optional, default-less fields are touched,
 * so an explicit argument always wins. Returns the new input and one short note per applied default.
 */
export function applyLearnedDefaults<T>(tool: string, original: T, bias: LearnedBias): BiasResult<T> {
  const applied: string[] = [];
  const name = toolName(tool);
  const input = rec(original);
  if (!input || !Object.keys(bias.prefer).length && !Object.keys(bias.avoid).length) return { input: original, applied };
  const out = clone(input);
  const richer = likes(bias, 'detail.level', 'rich') || avoids(bias, 'detail.level', 'simple');
  if (name === 'scene_build') {
    const kits = Array.isArray(out.kits) ? out.kits : [];
    for (const kit of kits.map(rec)) {
      if (!kit) continue;
      if (kit.kind === 'forest' && kit.trees === undefined && typeof kit.radius === 'number' && kit.radius > 0) {
        let target: string | undefined = bias.prefer['forest.density'];
        if (!target && (richer || avoids(bias, 'forest.density', 'sparse'))) target = 'dense';
        if (!target && avoids(bias, 'forest.density', 'medium')) target = avoids(bias, 'forest.density', 'dense') ? 'sparse' : 'dense';
        if (target && target !== densityBucket(forestDensity(80, kit.radius))) {
          const density = target === 'dense' ? 0.95 : target === 'sparse' ? 0.3 : 0.6;
          kit.trees = Math.max(1, Math.min(1500, Math.round(density * Math.PI * kit.radius * kit.radius / 250)));
          applied.push(`forest ${String(kit.key ?? '')}`.trim() + `: trees ${kit.trees} (learned: ${target} forests)`);
        }
      }
      if (kit.kind === 'plinth') {
        if (kit.material === undefined && bias.prefer['stone.material'] && !avoids(bias, 'stone.material', bias.prefer['stone.material'])) {
          kit.material = bias.prefer['stone.material']; applied.push(`plinth material ${kit.material} (learned)`);
        } else if (kit.material === undefined && avoids(bias, 'stone.material', 'Limestone')) { kit.material = 'Granite'; applied.push('plinth material Granite (learned: avoid limestone)'); }
        if (kit.weathering === undefined) {
          const weathered = likes(bias, 'stone.weathering', 'weathered') || avoids(bias, 'stone.surface', 'plain') || richer;
          const clean = likes(bias, 'stone.weathering', 'clean') || likes(bias, 'detail.level', 'simple');
          if (weathered && !clean) { kit.weathering = 0.85; applied.push('plinth weathering 0.85 (learned: weathered, not plain stone)'); }
          else if (clean && !weathered) { kit.weathering = 0.15; applied.push('plinth weathering 0.15 (learned: clean stone)'); }
        }
        if (kit.life === undefined) {
          const time = bias.prefer['lighting.time'], preset = bias.prefer['lighting.preset'];
          if (time === 'golden' || preset === 'forest-golden-hour' || preset === 'forest-dusk') { kit.life = 'dusk'; applied.push('plinth life dusk (learned: golden-hour light)'); }
          else if (time === 'day') { kit.life = 'day'; applied.push('plinth life day (learned)'); }
        }
      }
    }
    const varied = likes(bias, 'scatter.variation', 'varied') || avoids(bias, 'scatter.variation', 'uniform');
    if (varied) for (const layer of (Array.isArray(out.scatter) ? out.scatter : []).map(rec)) {
      if (!layer) continue;
      if (layer.scale === undefined) { layer.scale = [0.65, 1.4]; applied.push('scatter scale 0.65–1.4 (learned: avoid identical trees)'); }
      if (layer.tint === undefined) { layer.tint = { min: [0.86, 0.86, 0.86], max: [1.12, 1.12, 1.12] }; applied.push('scatter tint variation (learned: avoid identical trees)'); }
    }
  } else if (name === 'environment_apply') {
    const preset = bias.prefer['lighting.preset'];
    if (preset && ['preset', 'lighting', 'atmosphere', 'terrain', 'materials', 'soundService'].every(key => out[key] === undefined)) {
      out.preset = preset; applied.push(`preset ${preset} (learned)`);
    }
  } else if (name === 'assets_procedural') {
    const generator = rec(out.generator);
    if (generator) {
      const lush = bias.prefer['tree.foliage'];
      if (generator.kind === 'tree' && generator.leafDensity === undefined && lush) { generator.leafDensity = lush === 'lush' ? 0.9 : 0.4; applied.push(`leafDensity ${generator.leafDensity} (learned: ${lush} canopies)`); }
      if (generator.kind === 'foliage' && generator.density === undefined && lush) { generator.density = lush === 'lush' ? 0.9 : 0.4; applied.push(`density ${generator.density} (learned: ${lush} foliage)`); }
      const moss = bias.prefer['rock.moss'];
      if ((generator.kind === 'rock' || generator.kind === 'log' || generator.kind === 'stump') && generator.moss === undefined && moss) { generator.moss = moss === 'mossy'; applied.push(`moss ${String(generator.moss)} (learned)`); }
      if (generator.kind === 'spec' && Array.isArray(generator.materials)) for (const material of generator.materials.map(rec)) {
        if (!material || material.finish !== 'stone') continue;
        const surface = bias.prefer['stone.surface'];
        if (material.library === undefined && (surface && surface !== 'plain' || avoids(bias, 'stone.surface', 'plain'))) {
          material.library = surface && surface !== 'plain' ? surface : 'stone-ashlar'; applied.push(`material ${String(material.id)} library ${material.library} (learned: not plain stone)`);
        }
        if (material.wear === undefined && (likes(bias, 'stone.weathering', 'weathered') || avoids(bias, 'stone.surface', 'plain'))) { material.wear = 0.6; applied.push(`material ${String(material.id)} wear 0.6 (learned: weathered stone)`); }
      }
      if (out.variant === undefined && generator.kind !== 'column' && generator.kind !== 'spec' && (likes(bias, 'procedural.variants', 'family') || likes(bias, 'scatter.variation', 'varied')))
        applied.push('hint: the user rejects identical repeats; generate a variant family ([i,n]) for repeated models');
    }
  }
  return { input: (applied.some(note => !note.startsWith('hint:')) ? out : original) as T, applied };
}

/**
 * The block appended after project memory in every provider's system prompt ('' when nothing is learned). The desktop
 * Claude/Arcane hosts keep a byte-identical copy (a unit test pins them). Control/invisible characters and the closing tag
 * are neutralised; the text is bounded to PREFERENCE_LIMITS.contextChars.
 */
export function learnedPreferenceSection(text: unknown): string {
  const clean = typeof text === 'string' ? text.slice(0, PREFERENCE_LIMITS.contextChars).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/<\/?\s*learned-preferences\s*>/gi, '').trim() : '';
  return clean ? '\n\n<learned-preferences>\n' + clean + '\n</learned-preferences>' : '';
}
