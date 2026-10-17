---
name: arcane-vfx
description: "Build Roblox VFX with exact presets: ParticleEmitter fire, smoke, sparks, magic, waterfall, dust, fireflies and leaves, plus Beams, Trails, lights and Highlight, with pooling and performance budgets."
license: MIT
---

# VFX: particles, beams, trails, lights

## Rules first
- Arcane builds parts, not effect instances. Batch every emitter host and fixture in ONE `scene_build`: invisible hosts (Transparency 1, CanCollide false, CastShadow false, Anchored) with clear names, plus visible fixtures (logs, lamp posts, Neon bulbs).
- Effects are created by one Script per effect group: `scene_create` a Script inside the effect Model, then `script_update` with a preset table that builds the instances from `script.Parent`. Scripts stay disabled until the user wants them live; then `script_read` + `script_set_enabled`.
- Edit-mode `studio_viewport_capture` shows hosts and fixtures only. Effects appear at runtime: verify with `playtest_request` (capture) and say so.
- Textures: only these verified built-ins, or an asset id the user gives or that already exists in the place. Never invent rbxassetid numbers.
  `rbxasset://textures/particles/` + `fire_main.dds`, `fire_sparks_main.dds`, `smoke_main.dds`, `sparkles_main.dds`, `explosion01_smoke_main.dds`, `explosion01_core_main.dds`, `explosion01_shockwave_main.dds`, `forcefield_glow_main.dds`, `forcefield_vortex_main.dds`, `SquareParticle.png`.
- Budget: Rate x max Lifetime <= 200 per emitter, <= 1500 live particles in view, <= 8 lights with Shadows on screen, <= 31 Highlights at once. Effects are cosmetic only; gameplay state stays on the server.
- Mood, fog and post-processing (Bloom, DepthOfField, ColorCorrection, SunRays, Atmosphere) live in `arcane-photoreal`.

## Script shape (--!strict)
```lua
local function ns(...: number): NumberSequence -- pairs: time, value
	local a, k = { ... }, {}
	for i = 1, #a, 2 do table.insert(k, NumberSequenceKeypoint.new(a[i], a[i + 1])) end
	return NumberSequence.new(k)
end
local function cs(...: string): ColorSequence -- evenly spaced hex colours
	local a, k = { ... }, {}
	for i, hex in a do table.insert(k, ColorSequenceKeypoint.new((i - 1) / math.max(#a - 1, 1), Color3.fromHex(hex))) end
	return ColorSequence.new(k)
end
```
Set `Rotation = NumberRange.new(0, 360)` on every soft particle so copies never look stamped. Sequences need keypoints at time 0 and 1 (max 20).

## Emitter presets (Size and Transparency as time:value)
| Effect | Texture | Rate | Lifetime | Speed | Spread | Size | Transparency | Colour | Other |
|---|---|---|---|---|---|---|---|---|---|
| Fire core | fire_main | 40 | 0.6-1.1 | 3-5 | 8,8 | 0:1.6 0.5:1.2 1:0.2 | 0:1 0.15:0.35 0.7:0.55 1:1 | ffd27a ff8a2a b2361a | LightEmission 1, LightInfluence 0, Accel 0,4,0, Drag 1, RotSpeed -40..40 |
| Embers | fire_sparks_main | 8 | 1.5-2.5 | 4-8 | 25,25 | 0:0.12 1:0 | 0:0 0.8:0.2 1:1 | ffb347 ff5a1f | LightEmission 1, Accel 0,3,0, Drag 1.5 |
| Smoke | smoke_main | 6 | 4-6 | 1.5-3 | 12,12 | 0:1.5 1:6 | 0:1 0.15:0.7 1:1 | 5a5550 8a8580 | LightInfluence 1, Accel 1.2,0.6,0.4 (wind), Drag 0.4, RotSpeed -15..15 |
| Impact sparks | fire_sparks_main | Emit(25) | 0.2-0.45 | 20-35 | 70,70 | 0:0.15 1:0 | 0:0 1:1 | fff1c1 ff9a2e | Orientation VelocityParallel, Accel 0,-60,0, Drag 3, LightEmission 1 |
| Magic aura | sparkles_main | 25 | 1-1.6 | 0.5-1.5 | 180,180 | 0:0.4 0.5:0.25 1:0 | 0:1 0.2:0 1:1 | 6fe3ff a36bff | Shape Sphere, Accel 0,1.5,0, LightEmission 1; PointLight Range 10, Brightness 1.5, 8fbaff |
| Waterfall sheet | smoke_main | 60 | 1.2-1.8 | 18-24 | 4,10 | 0:2 1:5 | 0:0.4 1:1 | e8f6ff cfe8f5 | Box host at lip, EmissionDirection Bottom, Accel 0,-30,0, LightInfluence 1 |
| Waterfall mist | smoke_main | 20 | 2-3 | 3-6 | 60,60 | 0:3 1:10 | 0:1 0.2:0.6 1:1 | ffffff dcecf5 | at pool, Accel 0,1,0, Drag 1 |
| Dust motes | sparkles_main | 4 per 10x10 area | 6-10 | 0.1-0.3 | 180,180 | 0:0.1 1:0.1 | 0:1 0.3:0.5 0.7:0.5 1:1 | fff3d6 | Box Volume host, LightEmission 0.4 |
| Footstep dust | smoke_main | Emit(6) | 0.6-0.9 | 2-4 | 70,70 | 0:0.6 1:2 | 0:0.5 1:1 | b9a58a | Drag 4, Accel 0,-2,0 |
| Fireflies | sparkles_main | 3 | 6-9 | 0.3-0.8 | 180,180 | 0:0.1 0.5:0.22 1:0.1 | 0:1 0.2:0 0.4:0.6 0.6:0 0.8:0.5 1:1 | d8ff6a | Box host 60x8x60 at 2-6 studs, LightEmission 1, LightInfluence 0, Drag 1; night only |
| Falling leaves | SquareParticle | 3 | 8-12 | 1-2 | 30,30 | 0:0.4 1:0.4 | 0:1 0.05:0 0.9:0 1:1 | c8742b 9a3b1d (or 6f8f3a) | Box host above canopy, Bottom, Accel 0.6,-1.2,0.3, Drag 0.6, RotSpeed -90..90, Squash 0:0.6 1:0.6 |

Waterfall body: Terrain Water pool via `environment_apply`; falling sheet as Glass parts (Transparency 0.35, #5aa7c8) behind the particles.

## Beams, trails, lights, Highlight
- Beam (laser/energy): Width0 = Width1 = 0.3, FaceCamera true, LightEmission 1, Segments 10, TextureMode Wrap, TextureSpeed 2. Light shaft: Width0 6, Width1 14, Transparency 0:0.85 1:1, warm colour, no texture.
- Trail (sword swing): attachments 3 studs apart on the blade, Lifetime 0.18, WidthScale 0:1 1:0, Transparency 0:0.2 1:1, LightEmission 0.8, Enabled only during the swing. Dash trail: Lifetime 0.35.
- Torch/lantern PointLight: Range 12-16, Brightness 1.5-2, ffb46b, Shadows true; flicker on the client with `base + math.noise(t * 3, seed) * 0.25`, <= 20 flickering lights.
- Street lamp SpotLight: Face Bottom, Angle 70, Range 24, Brightness 2, ffd9a0, above a Neon bulb part. Sci-fi strip: SurfaceLight Range 10, Brightness 1, 4fd8ff on Neon trims. Range max is 60.
- Highlight (hover/interact): FillTransparency 0.85, OutlineTransparency 0, white outline, DepthMode Occluded. Reuse one Highlight and move its Adornee.

## Lifecycle
- Bursts: keep one pooled emitter and call `Emit(n)`; never create an emitter per hit.
- Transient effects: disable, then destroy after the max Lifetime (`Debris:AddItem`). Disconnect flicker loops when the light is destroyed.
- Gate continuous ambient effects (fireflies, leaves) by distance or zone on the client when there are more than 10 emitters.

## Verify
Playtest capture from the player's eye height and one overview. Check silhouette readability, no blown-out additive stacking, and that effects stop and clean up after interruption.
