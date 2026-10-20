# Portable effect format

All coordinates use studs and seconds, with Y up and initial emission along +Y. This version supports particle layers; beams, trails and mesh deformation are authored separately rather than silently approximated by the exporter.

An effect has `version: 1`, a lowercase ASCII `name`, an integer `seed`, an emission `duration` from 0.05 to 15 seconds, and one to eight `layers`. Effect names and layer IDs match `[a-z][a-z0-9-]{0,47}`: start with a lowercase letter, then use lowercase letters, digits or hyphens, up to 48 characters. Each layer has:

| Field | Meaning |
| --- | --- |
| `id` | Unique ASCII layer name |
| `start`, `duration` | Emission window in seconds, entirely within the effect duration |
| `burst`, `rate` | Initial count and particles per second during the window |
| `life`, `speed` | Ordered `[min, max]` ranges; lifetime is at most 20 seconds |
| `spread` | Cone half-angle in degrees, 0 to 180 |
| `position`, `acceleration` | Three numbers, in studs and studs/second squared |
| `drag` | Nonnegative drag, 0 to 10 |
| `texture` | `flare`, `ring`, `smoke` or `spark` |
| `blend` | `alpha` or `add` |
| `color` | RGB components from 0 to 1 |
| `size`, `alpha` | Two to eight `[normalizedAge, value]` keys, starting at 0 and ending at 1 |

Size and alpha keys describe **each particle's normalized age**, not global effect time. Alpha 0 means invisible; the exporter converts it to native Transparency. Global layer timing and particle-age curves are separate. Particle size is its full billboard width in studs.

Optional `budgets` has `peakParticles` (1 to 2000, default 600), `totalParticles` (1 to 4096, default 2048), and `textureMiB` (1 to 64, default 16). Validation uses conservative peak bounds, includes overlapping bursts and rates, and fails when the authored effect exceeds a budget. It does not silently thin or truncate the effect. Screen coverage and overdraw still need visual/device measurement.

Burst count is 0 to 4096; rate is 0 to 400 per second; speed is 0 to 200 studs/second. Position components are within ±10000 and acceleration within ±1000. Size is 0 to 100 studs. Layer emission windows may have zero duration for a burst. At least one particle must be emitted per layer. Unsupported properties, duplicate JSON keys and nonfinite numbers are rejected. Contact-sheet rendering is bounded to eight million shaded pixels; an excessive billboard footprint fails with its stage and cause, retaining the generated files for inspection.

`build --tile 64` produces a 4 by 4 atlas per used texture, with transparent gutters inside each cell. Tile sizes 32, 64 and 128 are supported. All texture frames use straight alpha and neutral RGB for tinting in the runtime. Reusing a texture reuses its atlas. The seed, normalized spec, helper hashes, atlas pixel/file hashes, Python/zlib versions, counts and conservative bounds are recorded in `build.json`. Preview particle streams are keyed to stable layer IDs, so reordering another layer does not change their motion. Identical PNG byte hashes require the same encoding environment; pixel hashes let you compare the uncompressed art separately. The seed controls these authored assets and the local preview; Roblox emitters do not expose the same seeded particle simulation.
