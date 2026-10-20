/**
 * World-space spatial maps for scatter placement: deterministic 2D fields (gradient-noise fBm, domain warp and
 * Voronoi patches) over a scene that drive per-instance choices instead of independent random rolls.
 *
 * ForestMaps reads, at any [x, z]:
 * - region: warped Voronoi patches, each led by one species (picked by share), blending into its neighbour across
 *   a soft band, so species form groves with transitions rather than an even mix;
 * - age: older and bigger towards the interior, saplings at clearing and rim edges, plus a slow fBm swell;
 * - elevation (a terrain height sampler when given, else a low-frequency relief proxy) and moisture (low, wet ground);
 * - heading: the lean direction, towards the light at clearing edges and a coherent drift elsewhere.
 * mapField turns them into a ScatterField that scene_build's scatter loop consults for acceptance density, scale,
 * variant choice (age-ordered `<use>-<n>` families), yaw and tint, with a neighbour rule: no two nearby instances
 * share a variant at a similar rotation. No runtime import from scene-build.ts.
 */
type V3 = [number, number, number];

/** Per-point hooks consulted by the scatter loop (an internal, non-schema field of an expanded kit scatter spec). */
export interface ScatterField {
  /** Acceptance probability 0..1 of a candidate point. */
  density(x: number, z: number): number;
  /** Placement scale in [low, high] from the maps; `u` is the loop's uniform roll. */
  scale(x: number, z: number, low: number, high: number, u: number): number;
  /** Variant index into `names`, yaw (degrees) and optional part tint; records the instance for the neighbour rule. */
  pick(x: number, z: number, names: readonly string[], scale: number, u: () => number): { index: number; yaw: number; tint?: V3 };
}

// ---- noise primitives ----
function hash(seed: number, a: number, b: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a | 0, 0xc2b2ae35) ^ Math.imul(b | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 2D gradient noise in about [-1, 1]. */
export function noise(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const g = (i: number, j: number, dx: number, dz: number) => { const a = hash(seed, ix + i, iz + j) * Math.PI * 2; return Math.cos(a) * dx + Math.sin(a) * dz; };
  const u = fade(fx), v = fade(fz);
  return 1.41 * lerp(lerp(g(0, 0, fx, fz), g(1, 0, fx - 1, fz), u), lerp(g(0, 1, fx, fz - 1), g(1, 1, fx - 1, fz - 1), u), v);
}
/** Fractal Brownian motion of `noise` (about [-1, 1]) at `scale` studs per base cycle. */
export function fbm(seed: number, x: number, z: number, scale: number, octaves = 4): number {
  let sum = 0, amp = 1, norm = 0, f = 1 / scale;
  for (let o = 0; o < octaves; o++) { sum += amp * noise(seed + o * 1013, x * f, z * f); norm += amp; amp *= 0.5; f *= 2.03; }
  return sum / norm;
}
/** Domain warp: [x, z] displaced by two fBm fields of `amount` studs. */
export function warp(seed: number, x: number, z: number, scale: number, amount: number): [number, number] {
  return [x + amount * fbm(seed + 17, x, z, scale, 3), z + amount * fbm(seed + 29, x + 311, z - 173, scale, 3)];
}
/** Voronoi (jittered grid) at `cell` studs: nearest/second site ids and distances. */
export function voronoi(seed: number, x: number, z: number, cell: number): { id: number; f1: number; next: number; f2: number } {
  const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
  let id = 0, f1 = Infinity, next = 0, f2 = Infinity;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const gx = cx + i, gz = cz + j, sx = (gx + 0.15 + 0.7 * hash(seed, gx, gz)) * cell, sz = (gz + 0.15 + 0.7 * hash(seed + 1, gx, gz)) * cell;
    const d = Math.hypot(x - sx, z - sz), key = ((gx & 0xffff) << 16) ^ (gz & 0xffff);
    if (d < f1) { f2 = f1; next = id; f1 = d; id = key; } else if (d < f2) { f2 = d; next = key; }
  }
  return { id, f1, next, f2 };
}

// ---- forest maps ----
/** Environmental preference of a species: weight multiplier exp(moist*m + elev*e + age*a). Unknown names are neutral. */
export const PREFERENCES: Record<string, { moist: number; elev: number; age: number }> = {
  pine: { moist: -1.1, elev: 1.2, age: 0 }, oak: { moist: 0.2, elev: -0.4, age: 0.9 }, birch: { moist: 1.1, elev: -0.3, age: -1 },
  bush: { moist: 0, elev: -0.2, age: -1.4 }, fern: { moist: 1.6, elev: -0.6, age: 0.6 }, rock: { moist: -1.2, elev: 1.5, age: 0 }, log: { moist: 0.6, elev: -0.3, age: 1.6 },
};
export interface ForestMapOptions {
  seed: number; center: [number, number]; radius: number;
  clearing?: { center?: [number, number] | undefined; inner: number; outer: number } | undefined;
  /** Terrain surface height in studs, when the caller knows it (e.g. its own terrain heightfield). */
  height?: ((x: number, z: number) => number) | undefined;
}
export class ForestMaps {
  readonly cell: number; private readonly seed: number; private readonly o: ForestMapOptions;
  private readonly heights?: { low: number; span: number };
  constructor(options: ForestMapOptions) {
    this.o = options; this.seed = options.seed >>> 0;
    this.cell = Math.max(24, Math.min(160, options.radius / 2.4));
    if (options.height) { // normalise the sampled terrain range over the forest disc
      let low = Infinity, high = -Infinity; const [cx, cz] = options.center, R = options.radius;
      for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++) { const h = options.height(cx + R * i / 8, cz + R * j / 8); low = Math.min(low, h); high = Math.max(high, h); }
      this.heights = { low, span: Math.max(1e-6, high - low) };
    }
  }
  /** 0 low .. 1 high ground. */
  elevation(x: number, z: number): number {
    if (this.o.height && this.heights) return clamp01((this.o.height(x, z) - this.heights.low) / this.heights.span);
    return clamp01(0.5 + 0.75 * fbm(this.seed + 401, x, z, this.o.radius * 0.9, 3));
  }
  /** 0 dry .. 1 wet: low ground plus a patchy fBm. */
  moisture(x: number, z: number): number {
    return clamp01(0.62 * (1 - this.elevation(x, z)) + 0.38 * (0.5 + 0.8 * fbm(this.seed + 503, x, z, this.cell * 1.3, 3)));
  }
  /** 0 sapling .. 1 old: interior distance from clearing and rim edges, plus a slow swell. */
  age(x: number, z: number): number {
    const [cx, cz] = this.o.center, R = this.o.radius, rim = smooth((R - Math.hypot(x - cx, z - cz)) / (R * 0.35));
    const c = this.o.clearing, [fx, fz] = c?.center ?? [cx, cz];
    const open = c ? smooth((Math.hypot(x - fx, z - fz) - c.inner) / Math.max(12, (c.outer - c.inner) * 1.6)) : 1;
    return clamp01(0.68 * Math.min(rim, open) + 0.32 * (0.5 + 0.9 * fbm(this.seed + 607, x, z, this.cell * 0.9, 3)));
  }
  /** Species weights (sum 1) at a point: the warped Voronoi patch leader, blended with the neighbour patch near borders. */
  mix(x: number, z: number, names: readonly string[], shares: readonly number[]): number[] {
    const [wx, wz] = warp(this.seed + 701, x, z, this.cell * 1.4, this.cell * 0.45);
    const v = voronoi(this.seed + 809, wx, wz, this.cell), m = this.moisture(x, z) * 2 - 1, e = this.elevation(x, z) * 2 - 1, a = this.age(x, z) * 2 - 1;
    const total = shares.reduce((s, w) => s + w, 0);
    const leader = (site: number) => { // share-weighted pick, nudged by the site's environment
      let roll = hash(this.seed + 911, site, 7) * total;
      for (let i = 0; i < names.length; i++) { roll -= shares[i]!; if (roll < 0) return i; }
      return names.length - 1;
    };
    const own = leader(v.id), other = leader(v.next), t = smooth((v.f2 - v.f1) / (this.cell * 0.4));
    const out = names.map((name, i) => {
      const p = PREFERENCES[name] ?? { moist: 0, elev: 0, age: 0 };
      const patch = (i === own ? t + (1 - t) * 0.5 : 0) + (i === other ? (1 - t) * 0.5 : 0);
      return (0.1 + patch) * (shares[i]! / total) * Math.exp(0.7 * (p.moist * m + p.elev * e + p.age * a));
    });
    const sum = out.reduce((s, w) => s + w, 0);
    return out.map(w => w / sum);
  }
  /** Lean heading (radians, world XZ): towards the clearing near its edge, else a slow coherent drift. */
  heading(x: number, z: number): number {
    const drift = fbm(this.seed + 1009, x, z, this.o.radius * 1.2, 2) * Math.PI * 2;
    const c = this.o.clearing;
    if (!c) return drift;
    const [fx, fz] = c.center ?? this.o.center, d = Math.hypot(x - fx, z - fz);
    const edge = 1 - smooth((d - c.inner) / Math.max(12, c.outer - c.inner + 24));
    const tx = (fx - x) / Math.max(d, 1e-6), tz = (fz - z) / Math.max(d, 1e-6);
    return Math.atan2(edge * tz + (1 - edge) * Math.sin(drift), edge * tx + (1 - edge) * Math.cos(drift));
  }
}

/** Neighbour bookkeeping shared by every layer of a kit: names and yaws of placed instances on a grid. */
export class Neighbours {
  private readonly grid = new Map<string, { x: number; z: number; name: string; yaw: number }[]>();
  constructor(readonly cell = 12) {}
  near(x: number, z: number, radius: number) {
    const out: { x: number; z: number; name: string; yaw: number }[] = [], r = Math.ceil(radius / this.cell), cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++) for (const p of this.grid.get(i + ',' + j) ?? []) if (Math.hypot(p.x - x, p.z - z) < radius) out.push(p);
    return out;
  }
  add(x: number, z: number, name: string, yaw: number): void {
    const k = Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell);
    (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push({ x, z, name, yaw });
  }
}
/** Smallest absolute difference of two yaws in degrees (0..180). */
export const yawGap = (a: number, b: number) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
/** Yaw (degrees) that turns local +X (the baked variant lean) towards world heading `h` (radians in XZ). */
export const yawToward = (h: number) => -h * 180 / Math.PI;
const wrapYaw = (y: number) => Math.round((((y + 180) % 360 + 360) % 360 - 180) * 10) / 10;
/** Same variant within this many layer spacings counts as adjacent, and must differ in yaw by at least MIN_YAW_GAP. */
export const NEIGHBOUR_SPACINGS = 1.6;
export const MIN_YAW_GAP = 35;

export interface LayerFieldOptions {
  maps: ForestMaps; neighbours: Neighbours; names: readonly string[]; shares: readonly number[]; layer: number;
  spacing: number; seed: number; tint?: { min: V3; max: V3 } | undefined;
  /** Variant names whose number is an age-ordered family member (`<use>-<n>`, 1 youngest). */
  family: boolean; under: boolean;
}
/** A ScatterField for one kit layer. */
export function mapField(o: LayerFieldOptions): ScatterField {
  const { maps, neighbours } = o;
  return {
    density(x, z) {
      const w = maps.mix(x, z, o.names, o.shares);
      return Math.max(0.05, Math.min(1, w[o.layer]! / Math.max(...w)));
    },
    scale(x, z, low, high, u) {
      // Age drives size: big old trees in the interior, saplings at edges; a small roll keeps neighbours apart.
      const age = maps.age(x, z), t = clamp01(0.82 * age ** 0.9 + 0.18 * u);
      return low + (high - low) * t;
    },
    pick(x, z, names, scale, u) {
      const n = names.length, age = maps.age(x, z), roll = u(), jitter = u();
      // Families: age picks the member (1 youngest); other variant lists follow a warped noise patch field (logistic-flattened
      // fBm, so every entry gets its share).
      const pref = o.family ? age * (n - 1) + (roll - 0.5) * 1.6
        : 1 / (1 + Math.exp(-fbm(o.seed + 13, ...warp(o.seed + 31, x, z, maps.cell, maps.cell * 0.3), maps.cell * 0.6, 2) / 0.17)) * n - 0.5 + (roll - 0.5) * 1.2;
      const order = names.map((_, i) => i).sort((a, b) => Math.abs(a - pref) - Math.abs(b - pref) || a - b);
      const lean = yawToward(maps.heading(x, z)) + (jitter - 0.5) * (o.under ? 360 : 50);
      const near = neighbours.near(x, z, o.spacing * NEIGHBOUR_SPACINGS * Math.max(1, scale));
      const clash = (i: number, yaw: number) => near.some(p => p.name === names[i] && yawGap(p.yaw, yaw) < MIN_YAW_GAP);
      const free = (i: number) => !near.some(p => p.name === names[i]);
      // Prefer a variant no neighbour uses (within 1.5 steps of the age target), else turn the preferred one away.
      let index = order.find(i => Math.abs(i - pref) <= 1.5 && free(i)) ?? order[0]!, yaw = wrapYaw(lean);
      if (clash(index, yaw)) {
        const alt = order.find(i => !clash(i, yaw));
        if (alt !== undefined && Math.abs(alt - pref) <= 2.5) index = alt;
        else {
          let best = yaw, gap = -1;
          for (let k = 1; k < 12; k++) {
            const y = wrapYaw(lean + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 30);
            const g = Math.min(180, ...near.filter(p => p.name === names[index]).map(p => yawGap(p.yaw, y)));
            if (g > gap) { gap = g; best = y; }
          }
          yaw = best;
        }
      }
      neighbours.add(x, z, names[index]!, yaw);
      let tint: V3 | undefined;
      if (o.tint) { // drier ground reads yellower, wet ground deeper; older plants darker
        const m = maps.moisture(x, z), a = age, { min, max } = o.tint;
        const t = [clamp01(0.55 + 0.4 * (0.5 - m) - 0.25 * (a - 0.5)), clamp01(0.5 + 0.3 * (m - 0.5) - 0.3 * (a - 0.5)), clamp01(0.45 + 0.35 * (m - 0.5) - 0.2 * (a - 0.5))];
        tint = t.map((v, i) => Math.round((min[i]! + v * (max[i]! - min[i]!)) * 1000) / 1000) as V3;
      }
      return tint ? { index, yaw, tint } : { index, yaw };
    },
  };
}
