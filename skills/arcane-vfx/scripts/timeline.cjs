/* Original analytic preview; native Roblox particle simulation is separate. */
const ArcaneTimeline = (() => {
  function random(seed, index, channel) {
    let x = (seed ^ Math.imul(index + 1, 0x9e3779b9) ^ Math.imul(channel + 1, 0x85ebca6b)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  }
  function curve(keys, age) {
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i];
      if (age <= b[0]) return a[1] + (b[1] - a[1]) * (age - a[0]) / (b[0] - a[0]);
    }
    return keys[keys.length - 1][1];
  }
  function layerSeed(name) {
    let value = 2166136261;
    for (let i = 0; i < name.length; i++) value = Math.imul(value ^ name.charCodeAt(i), 16777619) >>> 0;
    return value;
  }
  function end(effect) {
    return Math.max(...effect.layers.map(l => l.start + l.duration + l.life[1]));
  }
  function sample(effect, time) {
    if (!Number.isFinite(time) || time < 0 || time > 35) throw Error('Preview time must be finite and between 0 and 35 seconds.');
    const particles = [];
    effect.layers.forEach((layer, li) => {
      const total = layer.burst + Math.floor(layer.rate * layer.duration + 1e-9);
      for (let index = 0; index < total; index++) {
        const born = layer.start + (index < layer.burst ? 0 : (index - layer.burst + 1) / layer.rate);
        const age = time - born;
        if (age < 0) continue;
        const rand = channel => random(effect.seed ^ layerSeed(layer.id), index, channel);
        const life = layer.life[0] + (layer.life[1] - layer.life[0]) * rand(0);
        if (age >= life) continue;
        const speed = layer.speed[0] + (layer.speed[1] - layer.speed[0]) * rand(1);
        const cosine = 1 - rand(2) * (1 - Math.cos(layer.spread * Math.PI / 180));
        const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine)), angle = rand(3) * Math.PI * 2;
        const velocity = [speed * sine * Math.cos(angle), speed * cosine, speed * sine * Math.sin(angle)];
        const factor = layer.drag > 1e-6 ? -Math.expm1(-layer.drag * age) / layer.drag : age;
        const gravity = layer.drag > 1e-6 ? (age - factor) / layer.drag : .5 * age * age;
        const position = layer.position.map((p, i) => p + velocity[i] * factor + layer.acceleration[i] * gravity);
        const t = age / life;
        particles.push({layer: li, index, position, age: t, size: curve(layer.size, t), alpha: curve(layer.alpha, t)});
      }
    });
    return particles;
  }
  return Object.freeze({random, curve, end, sample});
})();
if (typeof module !== 'undefined') module.exports = ArcaneTimeline;
