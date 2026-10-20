---
name: arcane-vfx
description: "Build Roblox VFX with exact presets: ParticleEmitter fire, smoke, sparks, magic, waterfall, dust, fireflies and leaves, plus Beams, Trails, lights and Highlight, with pooling and performance budgets."
license: MIT
---

# VFX: particles, beams, trails, lights

## Rules first
- Arcane creates effect instances directly. Put fixtures AND effects in ONE `scene_build`: parts (hosts: Transparency 1, CanCollide false, CastShadow false), then items with an effect `className`, `in` (part, Attachment or group key) and `fx`. Single additions: `scene_create` with `fx`.
- Classes: Attachment, ParticleEmitter, Beam, Trail, PointLight, SpotLight, SurfaceLight, Highlight, Fire, Smoke, Sparkles, Decal, Texture. Every value is verified; the build is atomic and `receipt_restore` removes it.
- fx values: NumberSequence as a number, evenly spaced numbers `[1.6,1.2,0.2]` or `[[t,v,envelope],...]` (times 0..1, max 20); ColorSequence as `["#ffd27a","#b2361a"]`; NumberRange as `[min,max]`; Vector2/3 arrays; enums by name (`Orientation: "VelocityParallel"`, `EmissionDirection: "Bottom"`, `Shape: "Sphere"`).
- Beam/Trail: create two Attachment items first, then `Attachment0`/`Attachment1` = their keys (`scene_create`: Attachment refs).
- Textures: only these built-ins, or an asset id the user gives or that already exists in the place. Never invent rbxassetid numbers; other URLs are refused. No fitting texture: plain particles (no Texture) with soft Transparency keys.
  `rbxasset://textures/particles/` + `fire_main.dds`, `fire_sparks_main.dds`, `smoke_main.dds`, `sparkles_main.dds`, `explosion01_smoke_main.dds`, `explosion01_core_main.dds`, `explosion01_shockwave_main.dds`, `forcefield_glow_main.dds`, `forcefield_vortex_main.dds`, `SquareParticle.png`.
- Scripts only for runtime behaviour (bursts with `Emit(`, flicker, swing-only trails): `scene_create` a Script, `script_update`, then enable it with `script_read` + `script_set_enabled` once complete.
- Full builds (campfire, waterfall), bursts (explosion, heal, pickup), beam/trail table, post-processing per scene and budgets: `skills_get` ids ["arcane-vfx"], references ["arcane-vfx:recipes"], allowExperimental true ([recipes](references/recipes.md)).

## Look professional
- Layer every effect: a bright core (LightEmission 1, LightInfluence 0), a secondary (embers, sparks, glints) and a soft volume (smoke, mist, LightInfluence 1), plus one light for colour spill. ZOffset: smoke -1, core 0.5.
- Fade in and out: Transparency starts and ends at 1 (or 0 to 1 for sparks); Size shrinks for fire and sparks, grows for smoke and mist. Never a constant Transparency.
- `Rotation: [0,360]` and a small RotSpeed on soft particles so copies never look stamped.
- Colour ramps go hot to cool (white-yellow, orange, red) for fire and bright to saturated for magic. Additive (LightEmission 1) stacks blow out: keep core Rate 40 or less and Size under 2.
- Point sources emit from an Attachment 0.2-0.4 studs above the source; areas emit from a host part whose Size is the area. Emitter Shape follows its host part (Box = host Size).

## Emitter presets (fx values; Size/Transparency as time:value)
| Effect | Texture | Rate | Lifetime | Speed | SpreadAngle | Size | Transparency | Color | Other |
|---|---|---|---|---|---|---|---|---|---|
| Fire core | fire_main | 40 | 0.6-1.1 | 3-5 | 8,8 | 0:1.6 0.5:1.2 1:0.2 | 0:1 0.15:0.35 0.7:0.55 1:1 | ffd27a ff8a2a b2361a | LightEmission 1, LightInfluence 0, Acceleration 0,4,0, Drag 1, RotSpeed -40..40 |
| Embers | fire_sparks_main | 8 | 1.5-2.5 | 4-8 | 25,25 | 0:0.12 1:0 | 0:0 0.8:0.2 1:1 | ffb347 ff5a1f | LightEmission 1, Acceleration 0,3,0, Drag 1.5 |
| Smoke | smoke_main | 6 | 4-6 | 1.5-3 | 12,12 | 0:1.5 1:6 | 0:1 0.15:0.7 1:1 | 5a5550 8a8580 | LightInfluence 1, Acceleration 1.2,0.6,0.4, Drag 0.4, RotSpeed -15..15 |
| Impact sparks | fire_sparks_main | 0 + Emit(25) | 0.2-0.45 | 20-35 | 70,70 | 0:0.15 1:0 | 0:0 1:1 | fff1c1 ff9a2e | Orientation VelocityParallel, Acceleration 0,-60,0, Drag 3, LightEmission 1 |
| Magic aura | sparkles_main | 25 | 1-1.6 | 0.5-1.5 | 180,180 | 0:0.4 0.5:0.25 1:0 | 0:1 0.2:0 1:1 | 6fe3ff a36bff | Shape Sphere, Acceleration 0,1.5,0, LightEmission 1; PointLight Range 10, Brightness 1.5, 8fbaff |
| Waterfall sheet | smoke_main | 60 | 1.2-1.8 | 18-24 | 4,10 | 0:2 1:5 | 0:0.4 1:1 | e8f6ff cfe8f5 | Box host at lip, EmissionDirection Bottom, Acceleration 0,-30,0, LightInfluence 1 |
| Waterfall mist | smoke_main | 20 | 2-3 | 3-6 | 60,60 | 0:3 1:10 | 0:1 0.2:0.6 1:1 | ffffff dcecf5 | at pool, Acceleration 0,1,0, Drag 1 |
| Dust motes | sparkles_main | 4 per 10x10 area | 6-10 | 0.1-0.3 | 180,180 | 0:0.1 1:0.1 | 0:1 0.3:0.5 0.7:0.5 1:1 | fff3d6 | Box host, ShapeStyle Volume, LightEmission 0.4 |
| Footstep dust | smoke_main | 0 + Emit(6) | 0.6-0.9 | 2-4 | 70,70 | 0:0.6 1:2 | 0:0.5 1:1 | b9a58a | Drag 4, Acceleration 0,-2,0 |
| Fireflies | sparkles_main | 3 | 6-9 | 0.3-0.8 | 180,180 | 0:0.1 0.5:0.22 1:0.1 | 0:1 0.2:0 0.4:0.6 0.6:0 0.8:0.5 1:1 | d8ff6a | Box host 60x8x60 at 2-6 studs, LightEmission 1, LightInfluence 0, Drag 1; dusk/night (plinth kit `life`) |
| Falling leaves | SquareParticle | 3 | 8-12 | 1-2 | 30,30 | 0:0.4 1:0.4 | 0:1 0.05:0 0.9:0 1:1 | c8742b 9a3b1d (or 6f8f3a) | Box host above canopy, EmissionDirection Bottom, Acceleration 0.6,-1.2,0.3, Drag 0.6, RotSpeed -90..90, Squash 0.6 |

Waterfall body: a `terrain_generate` lake (or an `environment_apply` Water fill) as the pool; falling sheet as Glass parts (Transparency 0.35, #5aa7c8) behind the particles.

## Beams, trails, lights, Highlight
- Beam laser: Width 0.3, FaceCamera true, LightEmission 1. Light shaft: Width0 6, Width1 14, Transparency 0:0.85 1:1. Trail swing: blade Attachments 3 studs apart, Lifetime 0.18, Enabled false until a script swings.
- PointLight torch: Range 12-16, Brightness 1.5-2, ffb46b, Shadows true; flicker client-side `base + math.noise(t * 3, seed) * 0.25`. SpotLight street lamp: Face Bottom, Angle 70, Range 24, Brightness 2, ffd9a0. Range max 60.
- Highlight: FillTransparency 0.85, OutlineTransparency 0, white, DepthMode Occluded; reuse one and move its Adornee.
- Fire/Smoke/Sparkles are legacy; prefer the emitter presets up close.
- Scene glow comes from Bloom: tune `environment_apply` bloom per the recipes table; moods in `arcane-photoreal`.

## Budgets and lifecycle
- Rate x max Lifetime <= 200 per emitter, <= 1500 live particles in view (600 on phones), <= 4 emitters per effect, <= 8 shadowed lights on screen, <= 31 Highlights. Effects are cosmetic only.
- Bursts: one pooled emitter with Rate 0; a script calls `Emit(n)`. Never create an emitter per hit. Transient: disable, then `Debris:AddItem` after max Lifetime; disconnect flicker loops on destroy. Gate ambient effects by zone on the client past 10 emitters.

## Verify
Edit-mode `studio_viewport_capture` with `frame {ref, views}` shows lights, Beams and placement; particles animate at runtime, so confirm motion with `playtest_request` (capture). Check silhouette readability, no blown-out additive stacking, and that effects stop and clean up after interruption.
