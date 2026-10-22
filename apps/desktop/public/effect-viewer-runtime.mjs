import * as THREE from '/vendor/three/build/three.module.js';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';

// Effect preview for imported Roblox effect packages (the daemon's normalized ImportedEffect, never raw XML).
// ParticleEmitters are simulated from their real properties: Rate, Lifetime, Speed, SpreadAngle, EmissionDirection,
// Acceleration, Drag, Size / Transparency / Color sequences, Rotation, RotSpeed, LightEmission and the host part's
// area. Legacy Fire, Smoke and Sparkles use close stand-ins, and lights add their colour and range. Roblox textures are
// not available here, so particles draw as soft procedural sprites shaped after the texture family. The simulation is
// deterministic (seeded per emitter) and starts empty, as an emitter does when it is enabled.
const owners = new WeakMap();
const STEP = 1 / 60;
const MAX_PER_EMITTER = 1024;
const MAX_PARTICLES = 4096;
const MAX_PIXELS = 4_000_000;
const VIEWS = ['perspective', 'front', 'side', 'top'];
class PreviewError extends Error {}
const previewError = message => new PreviewError(message);
const safeReason = error => error instanceof PreviewError ? error.message : 'The effect could not be displayed safely.';
const abortError = () => new DOMException('Effect preview cancelled.', 'AbortError');
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const range = (value, min, max) => value && typeof value === 'object' && !Array.isArray(value) && 'min' in value ? { min: finite(value.min, min), max: finite(value.max, max) } : typeof value === 'number' && Number.isFinite(value) ? { min: value, max: value } : { min, max };
const vec = (value, fallback) => Array.isArray(value) && value.length === fallback.length && value.every(v => Number.isFinite(v)) ? value.slice() : fallback.slice();
function sequence(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return [[0, value, 0], [1, value, 0]];
  const keys = value && Array.isArray(value.keys) ? value.keys.filter(k => Array.isArray(k) && k.length === 3 && k.every(Number.isFinite)) : [];
  return keys.length >= 2 ? keys.slice().sort((a, b) => a[0] - b[0]) : [[0, fallback, 0], [1, fallback, 0]];
}
function colours(value, fallback) {
  const keys = value && Array.isArray(value.colors) ? value.colors.filter(k => Array.isArray(k) && k.length === 4 && k.every(Number.isFinite)) : [];
  if (keys.length >= 2) return keys.slice().sort((a, b) => a[0] - b[0]);
  const rgb = Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : fallback;
  return [[0, ...rgb], [1, ...rgb]];
}
function sample(keys, t, column) {
  if (t <= keys[0][0]) return keys[0][column];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t <= b[0]) { const span = b[0] - a[0], f = span > 0 ? (t - a[0]) / span : 0; return a[column] + (b[column] - a[column]) * f; }
  }
  return keys[keys.length - 1][column];
}
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DIRECTIONS = { Top: [0, 1, 0], Bottom: [0, -1, 0], Right: [1, 0, 0], Left: [-1, 0, 0], Front: [0, 0, -1], Back: [0, 0, 1] };
// Sprite families after the built-in texture name: 0 soft, 1 smoke, 2 spark, 3 square, 4 flame.
function spriteOf(texture) {
  const name = typeof texture === 'string' ? texture.toLowerCase() : '';
  if (/smoke|mist|cloud/.test(name)) return 1;
  if (/spark|glow|star/.test(name)) return 2;
  if (/square/.test(name)) return 3;
  if (/fire|flame|explosion/.test(name)) return 4;
  return 0;
}
/** One normalized item -> emitter parameters, or null for items without a particle preview. */
function emitterOf(item, index) {
  const p = item.props ?? {};
  const base = { index, name: item.name, origin: vec(item.position, [0, 0, 0]), area: Array.isArray(item.area) ? vec(item.area, [0, 0, 0]) : null, enabled: p.Enabled !== false };
  if (item.className === 'ParticleEmitter') return { ...base,
    rate: Math.max(0, finite(p.Rate, 20)), life: range(p.Lifetime, 5, 10), speed: range(p.Speed, 5, 5), spread: vec(p.SpreadAngle, [0, 0]),
    accel: vec(p.Acceleration, [0, 0, 0]), drag: Math.max(0, finite(p.Drag, 0)), size: sequence(p.Size, 1), alpha: sequence(p.Transparency, 0),
    color: colours(p.Color, [1, 1, 1]), rotation: range(p.Rotation, 0, 0), spin: range(p.RotSpeed, 0, 0), additive: finite(p.LightEmission, 0) >= .5,
    direction: DIRECTIONS[p.EmissionDirection] ?? DIRECTIONS.Top, shape: p.Shape ?? 'Box', surface: p.ShapeStyle === 'Surface', timeScale: Math.max(0, finite(p.TimeScale, 1)),
    sprite: spriteOf(p.Texture), emission: Math.min(1, Math.max(0, finite(p.LightEmission, 0))) };
  // Legacy effects: close stand-ins built from their own properties.
  if (item.className === 'Fire') {
    const size = Math.max(.5, finite(p.Size, 5)), heat = finite(p.Heat, 9), c1 = vec(p.Color, [.93, .55, .2]), c2 = vec(p.SecondaryColor, [.55, .1, .05]);
    return { ...base, rate: 60, life: { min: .5, max: 1.1 }, speed: { min: Math.abs(heat) * .4, max: Math.abs(heat) * .7 }, spread: [12, 12], accel: [0, heat >= 0 ? 2 : -2, 0], drag: .4,
      size: [[0, size * .5, 0], [.5, size * .38, 0], [1, size * .08, 0]], alpha: [[0, .9, 0], [.15, .25, 0], [.7, .5, 0], [1, 1, 0]],
      color: [[0, ...c1], [1, ...c2]], rotation: { min: 0, max: 360 }, spin: { min: -40, max: 40 }, additive: true, direction: heat >= 0 ? DIRECTIONS.Top : DIRECTIONS.Bottom, shape: 'Box', surface: false,
      timeScale: Math.max(0, finite(p.TimeScale, 1)), sprite: 4, emission: 1, legacy: true };
  }
  if (item.className === 'Smoke') {
    const size = Math.max(.1, finite(p.Size, 1)), rise = finite(p.RiseVelocity, 1), opacity = Math.min(1, Math.max(0, finite(p.Opacity, .5))), c = vec(p.Color, [1, 1, 1]);
    return { ...base, rate: 8, life: { min: 4, max: 6 }, speed: { min: Math.abs(rise) * .8, max: Math.abs(rise) * 1.2 }, spread: [10, 10], accel: [0, 0, 0], drag: .2,
      size: [[0, size, 0], [1, size * 4, 0]], alpha: [[0, 1, 0], [.15, 1 - opacity, 0], [1, 1, 0]], color: [[0, ...c], [1, ...c]], rotation: { min: 0, max: 360 }, spin: { min: -15, max: 15 },
      additive: false, direction: rise >= 0 ? DIRECTIONS.Top : DIRECTIONS.Bottom, shape: 'Box', surface: false, timeScale: Math.max(0, finite(p.TimeScale, 1)), sprite: 1, emission: 0, legacy: true };
  }
  if (item.className === 'Sparkles') {
    const c = vec(p.SparkleColor, [.56, .39, 1]);
    return { ...base, rate: 12, life: { min: 1, max: 1.6 }, speed: { min: 1, max: 2.5 }, spread: [180, 180], accel: [0, 0, 0], drag: .5,
      size: [[0, .35, 0], [1, .05, 0]], alpha: [[0, 0, 0], [1, 1, 0]], color: [[0, ...c], [1, ...c]], rotation: { min: 0, max: 360 }, spin: { min: -90, max: 90 },
      additive: true, direction: DIRECTIONS.Top, shape: 'Sphere', surface: false, timeScale: Math.max(0, finite(p.TimeScale, 1)), sprite: 2, emission: 1, legacy: true };
  }
  return null;
}
const lightOf = (item, index) => ['PointLight', 'SpotLight', 'SurfaceLight'].includes(item.className) ? {
  index, origin: vec(item.position, [0, 0, 0]), color: vec(item.props?.Color, [1, 1, 1]), brightness: Math.max(0, finite(item.props?.Brightness, 1)),
  range: Math.max(0, finite(item.props?.Range, 8)), enabled: item.props?.Enabled !== false } : null;

const VERTEX = `
attribute float aSize; attribute float aAlpha; attribute float aRotation; attribute vec3 aColor;
uniform float uScale; varying float vAlpha; varying float vRotation; varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.001), 0.0, 384.0);
  vAlpha = aAlpha; vRotation = aRotation; vColor = aColor;
}`;
const FRAGMENT = `
uniform int uSprite; varying float vAlpha; varying float vRotation; varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0; float c = cos(vRotation), s = sin(vRotation); p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  float r = length(p), shape;
  if (uSprite == 1) shape = pow(clamp(1.0 - r, 0.0, 1.0), 1.6) * (0.75 + 0.25 * sin(p.x * 5.0 + p.y * 3.0));
  else if (uSprite == 2) shape = clamp(1.0 - r * 3.0, 0.0, 1.0) + clamp(1.0 - abs(p.x) * 9.0, 0.0, 1.0) * clamp(1.0 - abs(p.y), 0.0, 1.0) * 0.8 + clamp(1.0 - abs(p.y) * 9.0, 0.0, 1.0) * clamp(1.0 - abs(p.x), 0.0, 1.0) * 0.8;
  else if (uSprite == 3) shape = step(max(abs(p.x), abs(p.y)), 0.8);
  else if (uSprite == 4) shape = pow(clamp(1.0 - length(vec2(p.x * 1.3, p.y * 0.85 + 0.15)), 0.0, 1.0), 1.2);
  else shape = pow(clamp(1.0 - r, 0.0, 1.0), 2.0);
  float alpha = shape * vAlpha; if (alpha < 0.004) discard;
  gl_FragColor = vec4(vColor, alpha);
}`;

export async function createEffectViewer({ host, effect, label, signal, onStatus }) {
  if (!(host instanceof HTMLElement) || !effect || !Array.isArray(effect.items) || !(signal instanceof AbortSignal)) throw new TypeError('Effect viewer requires a host, an effect and an AbortSignal.');
  if (signal.aborted) throw abortError();
  owners.get(host)?.dispose();
  const document = host.ownerDocument, window = document.defaultView, motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const listeners = [], resources = new Set();
  let disposed = false, raf = null, lastTime = null, epoch = 0, playing = !motion.matches, loop = true, time = 0, dirty = true;
  let renderer, scene, camera, controls, canvas, resizeObserver, intersectionObserver, width = 0, height = 0, intersecting = false, intersectionKnown = false, lastVisible = false, frames = 0;
  let view = 'perspective', cameraEdited = false, bounds;
  const status = message => { try { onStatus?.(message); } catch { /* Consumer status must not break ownership. */ } };
  const listen = (target, type, listener, options) => { target.addEventListener(type, listener, options); listeners.push(() => target.removeEventListener(type, listener, options)); };
  const own = value => { resources.add(value); return value; };
  const emitters = effect.items.slice(0, 64).map(emitterOf).filter(Boolean);
  const lights = effect.items.slice(0, 64).map(lightOf).filter(Boolean);
  if (!emitters.length && !lights.length) throw previewError('This effect has nothing Arcane can preview.');
  const duration = Math.min(12, Math.max(2, ...emitters.map(e => e.life.max + 1)));
  function stopFrame() { epoch++; if (raf !== null) window.cancelAnimationFrame(raf); raf = null; lastTime = null; }
  function dispose() {
    if (disposed) return;
    disposed = true; stopFrame();
    resizeObserver?.disconnect(); intersectionObserver?.disconnect();
    listeners.splice(0).forEach(remove => remove());
    controls?.dispose();
    for (const resource of resources) resource.dispose();
    resources.clear();
    renderer?.dispose(); renderer?.forceContextLoss();
    renderer = scene = camera = controls = null;
    if (owners.get(host)?.dispose === dispose) owners.delete(host);
  }
  owners.set(host, { dispose });
  listen(signal, 'abort', dispose, { once: true });

  // ---- Simulation: fixed steps from an empty start, so seeking is exact and repeatable. ----
  for (const e of emitters) {
    e.capacity = Math.min(MAX_PER_EMITTER, Math.max(1, Math.ceil(e.rate * e.life.max) + 8), MAX_PARTICLES);
    e.pos = new Float32Array(e.capacity * 3); e.vel = new Float32Array(e.capacity * 3); e.age = new Float32Array(e.capacity); e.lifeOf = new Float32Array(e.capacity);
    e.rot = new Float32Array(e.capacity); e.spinOf = new Float32Array(e.capacity); e.seed = new Float32Array(e.capacity);
    e.visible = true;
  }
  function restart() {
    for (const e of emitters) { e.count = 0; e.accumulator = 0; e.random = random(0x9e3779b1 ^ (e.index + 1) * 2654435761); e.age.fill(0); }
    time = 0;
  }
  function spawn(e) {
    if (e.count >= e.capacity) return;
    const i = e.count++, r = e.random, o = i * 3;
    let x = e.origin[0], y = e.origin[1], z = e.origin[2];
    if (e.area) {
      const [sx, sy, sz] = e.area;
      if (e.shape === 'Sphere') { const radius = Math.min(sx, sy, sz) / 2 * (e.surface ? 1 : Math.cbrt(r())), u = r() * 2 - 1, a = r() * Math.PI * 2, k = Math.sqrt(1 - u * u); x += radius * k * Math.cos(a); y += radius * u; z += radius * k * Math.sin(a); }
      else { x += (r() - .5) * sx; y += (r() - .5) * sy; z += (r() - .5) * sz; }
    }
    e.pos[o] = x; e.pos[o + 1] = y; e.pos[o + 2] = z;
    // Direction: the emission normal, tilted up to SpreadAngle (degrees) around the two perpendicular axes.
    const [dx, dy, dz] = e.direction, ax = THREE.MathUtils.degToRad(e.spread[0]) * (r() * 2 - 1), ay = THREE.MathUtils.degToRad(e.spread[1]) * (r() * 2 - 1);
    const direction = new THREE.Vector3(dx, dy, dz), side = Math.abs(dy) > .9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(direction, side).normalize(), v = new THREE.Vector3().crossVectors(direction, u).normalize();
    direction.applyAxisAngle(u, ax).applyAxisAngle(v, ay);
    const speed = e.speed.min + (e.speed.max - e.speed.min) * r();
    e.vel[o] = direction.x * speed; e.vel[o + 1] = direction.y * speed; e.vel[o + 2] = direction.z * speed;
    e.age[i] = 0; e.lifeOf[i] = Math.max(.01, e.life.min + (e.life.max - e.life.min) * r());
    e.rot[i] = THREE.MathUtils.degToRad(e.rotation.min + (e.rotation.max - e.rotation.min) * r());
    e.spinOf[i] = THREE.MathUtils.degToRad(e.spin.min + (e.spin.max - e.spin.min) * r());
    e.seed[i] = r();
  }
  function step(dt) {
    for (const e of emitters) {
      const scaled = dt * e.timeScale;
      // Age and retire (swap-remove keeps the live range packed).
      for (let i = 0; i < e.count;) {
        e.age[i] += scaled;
        if (e.age[i] >= e.lifeOf[i]) {
          const last = --e.count;
          if (i !== last) {
            for (const [array, n] of [[e.pos, 3], [e.vel, 3]]) for (let k = 0; k < n; k++) array[i * n + k] = array[last * n + k];
            for (const array of [e.age, e.lifeOf, e.rot, e.spinOf, e.seed]) array[i] = array[last];
          }
          continue;
        }
        const o = i * 3, damping = e.drag > 0 ? Math.exp(-e.drag * scaled) : 1;
        for (let k = 0; k < 3; k++) { e.vel[o + k] = (e.vel[o + k] + e.accel[k] * scaled) * damping; e.pos[o + k] += e.vel[o + k] * scaled; }
        e.rot[i] += e.spinOf[i] * scaled;
        i++;
      }
      if (!e.enabled) continue;
      e.accumulator += e.rate * scaled;
      while (e.accumulator >= 1) { e.accumulator -= 1; spawn(e); }
    }
    time += dt;
  }
  function simulateTo(target) {
    if (target < time) restart();
    while (time + STEP <= target + 1e-9) step(STEP);
  }

  // ---- Scene ----
  function buildScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#141012');
    const box = new THREE.Box3();
    for (const e of emitters) {
      const reach = Math.min(40, e.speed.max * e.life.max * .6 + Math.abs(e.accel[1]) * e.life.max * e.life.max * .2) + sample(e.size, 0, 1);
      const half = e.area ? new THREE.Vector3(...e.area).multiplyScalar(.5) : new THREE.Vector3();
      const origin = new THREE.Vector3(...e.origin);
      box.expandByPoint(origin.clone().sub(half)).expandByPoint(origin.clone().add(half));
      box.expandByPoint(origin.clone().addScaledVector(new THREE.Vector3(...e.direction), reach));
      box.expandByPoint(origin.clone().addScalar(-1)).expandByPoint(origin.clone().addScalar(1));
    }
    for (const light of lights) box.expandByPoint(new THREE.Vector3(...light.origin)).expandByScalar(.5);
    bounds = snapshotBounds() ?? box;
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    // A dark ground under the effect picks up the light colour, as on a stage.
    const ground = new THREE.Mesh(own(new THREE.CircleGeometry(Math.max(size.x, size.z, 4) * 1.4, 48)), own(new THREE.MeshStandardMaterial({ color: 0x1b1517, roughness: .95, metalness: 0 })));
    ground.rotation.x = -Math.PI / 2; ground.position.set(center.x, box.min.y - .02, center.z); scene.add(ground);
    scene.add(new THREE.HemisphereLight(0x6f6a72, 0x0d0a0b, .6));
    for (const light of lights) {
      const point = new THREE.PointLight(new THREE.Color(...light.color), light.brightness * 6, Math.max(1, light.range), 1.4);
      point.position.set(...light.origin); light.object = point; scene.add(point);
      const glow = new THREE.Points(own(new THREE.BufferGeometry()), own(material(0, true)));
      glow.geometry.setAttribute('position', new THREE.Float32BufferAttribute(light.origin, 3));
      glow.geometry.setAttribute('aSize', new THREE.Float32BufferAttribute([Math.min(8, Math.max(1, light.range * .35))], 1));
      glow.geometry.setAttribute('aAlpha', new THREE.Float32BufferAttribute([Math.min(.55, .12 + light.brightness * .08)], 1));
      glow.geometry.setAttribute('aRotation', new THREE.Float32BufferAttribute([0], 1));
      glow.geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(light.color, 3));
      light.glow = glow; scene.add(glow);
    }
    for (const e of emitters) {
      const geometry = own(new THREE.BufferGeometry());
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(e.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(e.capacity), 1).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(e.capacity), 1).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aRotation', new THREE.BufferAttribute(new Float32Array(e.capacity), 1).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(e.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
      e.points = new THREE.Points(geometry, own(material(e.sprite, e.additive)));
      e.points.frustumCulled = false;
      scene.add(e.points);
    }
  }
  // Frame what the effect actually draws: simulate a representative moment and keep the central 94% of live particles
  // on each axis (a few long-lived strays do not shrink the effect to a dot), plus emitter and light origins.
  function snapshotBounds() {
    restart(); simulateTo(Math.min(duration, Math.max(1.5, duration * .6)));
    const axes = [[], [], []]; let size = .5;
    for (const e of emitters) {
      for (let i = 0; i < e.count; i++) for (let k = 0; k < 3; k++) axes[k].push(e.pos[i * 3 + k]);
      size = Math.max(size, sample(e.size, .3, 1));
    }
    restart();
    if (axes[0].length < 8) return null;
    const pick = (values, q) => values[Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))))];
    const box = new THREE.Box3();
    for (const values of axes) values.sort((a, b) => a - b);
    box.min.set(pick(axes[0], .03), pick(axes[1], .03), pick(axes[2], .03)); box.max.set(pick(axes[0], .97), pick(axes[1], .97), pick(axes[2], .97));
    for (const e of emitters) box.expandByPoint(new THREE.Vector3(...e.origin));
    for (const light of lights) box.expandByPoint(new THREE.Vector3(...light.origin));
    return box.expandByScalar(Math.min(4, size * .5));
  }
  function material(sprite, additive) {
    return new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, uniforms: { uScale: { value: 400 }, uSprite: { value: sprite } } });
  }
  function upload() {
    const scale = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.isPerspectiveCamera ? camera.fov : 38) / 2));
    for (const e of emitters) {
      const g = e.points.geometry, position = g.getAttribute('position'), size = g.getAttribute('aSize'), alpha = g.getAttribute('aAlpha'), rotation = g.getAttribute('aRotation'), colour = g.getAttribute('aColor');
      for (let i = 0; i < e.count; i++) {
        const t = e.age[i] / e.lifeOf[i], jitter = e.seed[i] * 2 - 1;
        position.array[i * 3] = e.pos[i * 3]; position.array[i * 3 + 1] = e.pos[i * 3 + 1]; position.array[i * 3 + 2] = e.pos[i * 3 + 2];
        size.array[i] = Math.max(0, sample(e.size, t, 1) + jitter * sample(e.size, t, 2));
        alpha.array[i] = Math.min(1, Math.max(0, 1 - (sample(e.alpha, t, 1) + jitter * sample(e.alpha, t, 2))));
        rotation.array[i] = e.rot[i];
        colour.array[i * 3] = sample(e.color, t, 1); colour.array[i * 3 + 1] = sample(e.color, t, 2); colour.array[i * 3 + 2] = sample(e.color, t, 3);
      }
      g.setDrawRange(0, e.count);
      for (const attribute of [position, size, alpha, rotation, colour]) attribute.needsUpdate = true;
      e.points.material.uniforms.uScale.value = scale;
      e.points.visible = e.visible;
    }
    for (const light of lights) light.glow.material.uniforms.uScale.value = scale;
  }

  // ---- Frame scheduling: the model viewer's rules (visible, intersecting, capped DPR, reduced motion). ----
  function hostVisible() {
    if (disposed || document.visibilityState !== 'visible' || !intersecting || !host.isConnected || width <= 0 || height <= 0) return false;
    for (let node = host; node instanceof HTMLElement; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  }
  const animate = () => playing && !motion.matches;
  function draw() { upload(); renderer.render(scene, camera); frames++; dirty = false; }
  function schedule() {
    const visible = !!renderer && hostVisible();
    if (visible && !lastVisible) dirty = true;
    lastVisible = visible;
    if (!visible) { stopFrame(); return; }
    if (raf !== null || (!dirty && !animate())) return;
    const frameEpoch = epoch;
    raf = window.requestAnimationFrame(now => {
      raf = null;
      if (frameEpoch !== epoch || !hostVisible()) { lastTime = null; return; }
      try {
        if (animate()) {
          const delta = lastTime === null ? 0 : Math.min((now - lastTime) / 1000, .1); lastTime = now;
          let target = time + delta;
          if (target >= duration) { if (loop) { restart(); target = 0; } else { target = duration; playing = false; } }
          simulateTo(target);
        } else lastTime = null;
        draw(); schedule();
      } catch (error) { status(`Effect preview stopped: ${safeReason(error)}`); dispose(); }
    });
  }
  function requestRender() { dirty = true; schedule(); }
  function fit() {
    const center = bounds.getCenter(new THREE.Vector3()), radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 1.5);
    const direction = view === 'front' ? new THREE.Vector3(0, 0, -1) : view === 'side' ? new THREE.Vector3(1, 0, 0) : view === 'top' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(.9, .45, -1.2).normalize();
    const aspect = width > 0 && height > 0 ? width / height : 1, fov = THREE.MathUtils.degToRad(38);
    const distance = radius / Math.sin(Math.min(fov / 2, Math.atan(Math.tan(fov / 2) * aspect))) * 1.05;
    camera.aspect = aspect; camera.near = Math.max(.05, distance - radius * 3); camera.far = distance + radius * 6; camera.updateProjectionMatrix();
    camera.position.copy(center).addScaledVector(direction, distance);
    controls.target.copy(center); controls.minDistance = radius * .2; controls.maxDistance = distance * 6; controls.update(); controls.saveState();
    cameraEdited = false;
  }
  function measure() {
    if (disposed) return;
    const rect = host.getBoundingClientRect(), nextWidth = host.clientWidth, nextHeight = host.clientHeight;
    if (!intersectionKnown) intersecting = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    let fitNow = false;
    if (nextWidth !== width || nextHeight !== height) { fitNow = !cameraEdited; width = nextWidth; height = nextHeight; dirty = true; }
    const visible = !!renderer && hostVisible();
    if (renderer && width > 0 && height > 0) {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(MAX_PIXELS / (width * height)));
      const pixelWidth = Math.max(1, Math.floor(width * dpr)), pixelHeight = Math.max(1, Math.floor(height * dpr));
      if (visible && (canvas.width !== pixelWidth || canvas.height !== pixelHeight)) renderer.setSize(pixelWidth, pixelHeight, false);
      if (fitNow) fit(); else { camera.aspect = width / height; camera.updateProjectionMatrix(); }
    }
    if (visible && frames > 0 && dirty) { try { draw(); lastVisible = true; } catch (error) { status(`Effect preview stopped: ${safeReason(error)}`); dispose(); return; } }
    schedule();
  }

  try {
    restart();
    buildScene();
    camera = new THREE.PerspectiveCamera(38, 1, .05, 1000);
    canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${label || 'Effect'} — interactive effect preview`);
    canvas.setAttribute('aria-description', 'Drag to orbit. Right-drag to pan. Scroll to zoom. Home or R resets the view.');
    canvas.style.cssText = 'display:block;width:100%;height:100%;outline-offset:-3px;';
    const context = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'low-power' });
    if (!context) throw previewError('WebGL2 is unavailable for this effect preview.');
    renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.append(canvas);
    configureControls();
    listen(canvas, 'keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Home' || event.key === 'r' || event.key === 'R') { event.preventDefault(); reset(); }
    });
    listen(canvas, 'webglcontextlost', event => { event.preventDefault(); status('WebGL context lost. Reopen the effect preview to continue.'); dispose(); });
    // Under reduced motion the effect starts still, part-way through, so its shape is visible.
    if (!animate()) simulateTo(Math.min(duration * .6, 1.5));
    resizeObserver = new ResizeObserver(measure); resizeObserver.observe(host);
    intersectionObserver = new IntersectionObserver(entries => { intersectionKnown = true; const entry = entries[entries.length - 1]; intersecting = entry.isIntersecting && entry.intersectionRatio > 0; measure(); }, { threshold: [0, Number.EPSILON] });
    intersectionObserver.observe(host);
    listen(document, 'visibilitychange', () => { dirty = true; stopFrame(); measure(); });
    listen(motion, 'change', () => { stopFrame(); requestRender(); });
    listen(window, 'resize', measure);
    for (const type of ['animationend', 'transitionend']) listen(document, type, event => { if (event.target instanceof Node && event.target.contains(host)) measure(); }, { capture: true, passive: true });
    measure();
    if (renderer && hostVisible() && !frames) { draw(); lastVisible = true; }
    status('Effect preview ready.');
    if (signal.aborted) throw abortError();
  } catch (error) {
    dispose();
    if (error.name !== 'AbortError') status(`Effect preview unavailable: ${safeReason(error)}`);
    throw error;
  }
  function reset() { if (!disposed && controls) { fit(); requestRender(); } }
  // OrbitControls keeps the camera up axis from construction, so a view change builds fresh controls (as the model viewer does).
  function configureControls() {
    controls?.dispose();
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false; controls.enablePan = true; controls.cursorStyle = 'grab';
    controls.addEventListener('change', () => { cameraEdited = true; requestRender(); });
  }
  function live() { return emitters.reduce((sum, e) => sum + (e.visible ? e.count : 0), 0); }
  return {
    reset,
    setView(value) { if (disposed || !VIEWS.includes(value)) return; view = value; camera.up.set(0, view === 'top' ? 0 : 1, view === 'top' ? 1 : 0); configureControls(); reset(); },
    setPlaying(value) { if (disposed || typeof value !== 'boolean') return; playing = value; if (playing && time >= duration - 1e-6) restart(); stopFrame(); requestRender(); },
    playing: () => !disposed && playing && !motion.matches,
    canPlay: () => !motion.matches,
    seek(seconds) { if (disposed || typeof seconds !== 'number' || !Number.isFinite(seconds)) return; simulateTo(Math.min(duration, Math.max(0, seconds))); requestRender(); },
    time: () => time,
    duration: () => duration,
    setLoop(value) { if (!disposed && typeof value === 'boolean') loop = value; },
    loop: () => loop,
    setVisible(index, value) {
      if (disposed || typeof value !== 'boolean') return;
      for (const e of emitters) if (e.index === index) e.visible = value;
      for (const light of lights) if (light.index === index) { light.object.visible = value; light.glow.visible = value; }
      requestRender();
    },
    liveParticles: live,
    previewed: () => new Set([...emitters.map(e => e.index), ...lights.map(light => light.index)]),
    dispose,
  };
}
