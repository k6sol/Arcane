// Pyx, Arcane's crystal fire pet: the Claude Design ShardPet pixel maps (24×24), ported exactly and run-length encoded
// into one-pixel-high rects. Shared by the pop-out bar (pyx-bar.ts) and, once root adopts it, the composer perch.
// Palette: k outline, d dark red, r red, l light red, w white.

export type PyxSpriteMood = 'idle' | 'listening' | 'working' | 'done';
export type PyxFrame = 1 | 2;
export interface PyxPixelRun { readonly x: number; readonly y: number; readonly w: number; readonly fill: string }

export const PYX_GRID = 24;
export const PYX_PALETTE: Readonly<Record<'k' | 'd' | 'r' | 'l' | 'w', string>> = Object.freeze({ k: '#14040A', d: '#8E0F22', r: '#E5323F', l: '#FF6B78', w: '#FFFFFF' });
/** Character sheet timings: idle swaps its two frames every 600 ms, working every 180 ms; done is held 1.2 s, then idle. */
export const PYX_FRAME_MS: Readonly<Record<PyxSpriteMood, number | null>> = Object.freeze({ idle: 600, listening: null, working: 180, done: null });
export const PYX_DONE_HOLD_MS = 1200;

const CREST_BASE = ['......kwk.kllk.kwk......', '......klrkrllrkrlk......', '......krlrrllrrlrk......'] as const;
const CREST_HOT = ['......kwk.kwlk.kwk......', '......klrkrllrkrlk......', '......krrlrllrlrrk......'] as const;
const CRESTS: Readonly<Record<string, readonly string[]>> = {
  calm1: ['........................', '........................', '...........k............', '..........kwk...........', '.......k..kwlk..k.......', ...CREST_BASE],
  calm2: ['........................', '........................', '............k...........', '...........kwk..........', '......k...klwk..k.......', ...CREST_BASE],
  tall1: ['...........k............', '..........kwk...........', '.......k..kwk...k.......', '......kwk.kwlk.kwk......', '......klk.kllk.klk......', CREST_BASE[1], CREST_BASE[2], '......krrlrllrlrrk......'],
  tall2: ['............k...........', '...........kwk..........', '......k...kwlk...k......', '......kwk.kwlk.kwk......', '......klk.kllk.klk......', CREST_BASE[1], CREST_BASE[2], '......krrlrllrlrrk......'],
  // ShardPet builds blaze as four rows, one extra row, then the three hot rows.
  blaze: ['...........k............', '..........kwk...........', '.......k..kwk...k.......', '......kwk.kwwk.kwk......', '......kwk.klwk.kwk......', ...CREST_HOT],
};
// Faceted gem body y=9..21: light from top-left, dithered right facet, dark base.
const BODY = ['......kkkkkkkkkkkk......', '.....klwwllllrrrddk.....', '....klwlllrrrrrrrdddk...', '...kllrrrrrrrrrrrdddk...', '...kllrrrrrrrrrrddddk...',
  '...klrrrrrrrrrrrrdddk...', '...klrrrrrrrrrrrddddk...', '...klrrrrrrrrrrrrdddk...', '...klrrrrrrrrrrdrdddk...', '....krrrrrrrrrdrddddk...',
  '.....krdrdrdrdddddk.....', '......kddddddddddk......', '.......kkkkkkkkkk.......'];
const FEET = ['......kddk....kddk......', '......kkkk....kkkk......'];
const ARM_DOWN = ['..k', 'kll', 'krr', 'kk.'], ARM_UP = ['kk..', 'klk.', 'kllk', '.kl.', '..k.'], ARM_OUT = ['kk.', 'rdk', 'kk.'], BLOCK = ['kkkk', 'kwlk', 'klrk', 'kkkk'];
type Dot = readonly [number, number, string];
// Faces: eyes at x7-8 and x15-16, mouth centred on x11.5.
const FACES: Readonly<Record<PyxSpriteMood, readonly Dot[]>> = {
  idle: [[7, 14, 'w'], [8, 14, 'k'], [7, 15, 'k'], [8, 15, 'k'], [15, 14, 'w'], [16, 14, 'k'], [15, 15, 'k'], [16, 15, 'k'], [10, 17, 'k'], [11, 18, 'k'], [12, 18, 'k'], [13, 17, 'k']],
  listening: [[7, 13, 'k'], [8, 13, 'w'], [7, 14, 'k'], [8, 14, 'k'], [7, 15, 'k'], [8, 15, 'k'], [15, 13, 'k'], [16, 13, 'w'], [15, 14, 'k'], [16, 14, 'k'], [15, 15, 'k'], [16, 15, 'k'],
    [11, 17, 'k'], [12, 17, 'k'], [11, 18, 'k'], [12, 18, 'k']],
  working: [[7, 12, 'k'], [8, 13, 'k'], [16, 12, 'k'], [15, 13, 'k'], [7, 14, 'w'], [8, 14, 'k'], [7, 15, 'k'], [8, 15, 'k'], [15, 14, 'w'], [16, 14, 'k'], [15, 15, 'k'], [16, 15, 'k'],
    [11, 17, 'k'], [12, 17, 'k']],
  done: [[6, 14, 'k'], [7, 13, 'k'], [8, 13, 'k'], [9, 14, 'k'], [14, 14, 'k'], [15, 13, 'k'], [16, 13, 'k'], [17, 14, 'k'], [10, 17, 'k'], [11, 17, 'd'], [12, 17, 'd'], [13, 17, 'k'],
    [11, 18, 'k'], [12, 18, 'k']],
};
const CONFIG: Readonly<Record<PyxSpriteMood, (frame: PyxFrame) => { crest: string; dy: number; feetDy: number }>> = {
  idle: frame => ({ crest: frame === 2 ? 'calm2' : 'calm1', dy: frame === 2 ? 1 : 0, feetDy: 0 }),
  listening: () => ({ crest: 'calm1', dy: 0, feetDy: 0 }),
  working: frame => ({ crest: frame === 2 ? 'tall2' : 'tall1', dy: 0, feetDy: 0 }),
  done: () => ({ crest: 'blaze', dy: -1, feetDy: -1 }),
};

/** The 24×24 grid of palette keys ('' for transparent), exactly as ShardPet composes it. */
export function pyxSpriteGrid(mood: PyxSpriteMood, frame: PyxFrame = 1): string[][] {
  const grid: string[][] = Array.from({ length: PYX_GRID }, () => Array<string>(PYX_GRID).fill(''));
  const put = (x: number, y: number, c: string) => { if (c && c !== '.' && x >= 0 && x < PYX_GRID && y >= 0 && y < PYX_GRID) grid[y]![x] = c; };
  const stamp = (rows: readonly string[], x0: number, y0: number) => rows.forEach((row, j) => [...row].forEach((c, i) => put(x0 + i, y0 + j, c)));
  const dots = (list: readonly Dot[], dy: number) => list.forEach(([x, y, c]) => put(x, y + dy, c));
  const mirror = (rows: readonly string[]) => rows.map(s => [...s].reverse().join('').replace(/r/g, 'd').replace(/l/g, 'r'));
  const cfg = CONFIG[mood](frame), dy = cfg.dy;
  let crest = CRESTS[cfg.crest]!;
  if (mood === 'listening') crest = crest.map((s, i) => (i >= 2 && i <= 5 ? '.' + s.slice(0, 23) : s)); // leans toward the input
  stamp(crest, 0, 1 + dy);
  stamp(FEET, 0, 22 + cfg.feetDy);
  stamp(BODY, 0, 9 + dy);
  if (mood === 'done') { stamp(ARM_UP, 0, 9 + dy); stamp(mirror(ARM_UP), 20, 9 + dy); }
  else if (mood === 'listening') { stamp(ARM_DOWN, 0, 14 + dy); stamp(mirror(ARM_UP), 20, 9 + dy); }
  else if (mood === 'working') { stamp(ARM_DOWN, 0, 14 + dy); stamp(ARM_OUT, 21, 13 + dy); stamp(BLOCK, 20, frame === 2 ? 8 : 9); }
  else { stamp(ARM_DOWN, 0, 14 + dy); stamp(mirror(ARM_DOWN), 21, 14 + dy); }
  dots(FACES[mood], dy);
  dots([[6, 16, 'l'], [17, 16, 'l']], dy);
  if (mood === 'done') dots([[5, 16, 'l'], [18, 16, 'l']], dy);
  if (mood === 'done') dots([[1, 3, 'w'], [0, 4, 'w'], [1, 4, 'w'], [2, 4, 'w'], [1, 5, 'w'], [22, 5, 'w'], [21, 6, 'w'], [22, 6, 'w'], [23, 6, 'w'], [22, 7, 'w'], [20, 1, 'l'], [3, 1, 'l']], 0);
  if (mood === 'idle') dots([frame === 2 ? [19, 1, 'l'] : [18, 2, 'l']], 0);
  if (mood === 'working') dots(frame === 2 ? [[19, 6, 'w'], [22, 5, 'w']] : [[20, 7, 'w'], [23, 6, 'w']], 0);
  return grid;
}

/** One frame as horizontal runs {x, y, w, fill} (height 1), in ShardPet's order. */
export function pyxSpritePixels(mood: PyxSpriteMood, frame: PyxFrame = 1): PyxPixelRun[] {
  const runs: PyxPixelRun[] = [];
  pyxSpriteGrid(mood, frame).forEach((row, y) => {
    for (let x = 0; x < PYX_GRID;) {
      const c = row[x]; if (!c) { x++; continue; }
      let w = 1; while (x + w < PYX_GRID && row[x + w] === c) w++;
      runs.push({ x, y, w, fill: PYX_PALETTE[c as keyof typeof PYX_PALETTE] }); x += w;
    }
  });
  return runs;
}

/** Integer pixel scale only: a requested size snaps down to a whole multiple of 24 (minimum 1x). */
export function pyxScale(size: number): number { return Math.max(1, Math.floor((Number.isFinite(size) ? size : PYX_GRID) / PYX_GRID)); }

const SVG_NS = 'http://www.w3.org/2000/svg';
/**
 * A crisp sprite frame as inline SVG (no image, no data URI: the page CSP is img-src 'self' blob:). Rects only, built with
 * createElementNS; the caller sizes it through its width/height (an integer multiple of 24).
 */
export function pyxSpriteGroup(doc: Document, mood: PyxSpriteMood, frame: PyxFrame): SVGGElement {
  const group = doc.createElementNS(SVG_NS, 'g') as SVGGElement;
  group.setAttribute('data-mood', mood); group.setAttribute('data-frame', String(frame));
  for (const p of pyxSpritePixels(mood, frame)) {
    const rect = doc.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(p.x)); rect.setAttribute('y', String(p.y)); rect.setAttribute('width', String(p.w)); rect.setAttribute('height', '1'); rect.setAttribute('fill', p.fill);
    group.append(rect);
  }
  return group;
}
export function pyxSpriteSvg(doc: Document, size = 48): SVGSVGElement {
  const px = pyxScale(size) * PYX_GRID, svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', 'pyx-sprite'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', String(px)); svg.setAttribute('height', String(px));
  svg.setAttribute('shape-rendering', 'crispEdges'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  return svg;
}
