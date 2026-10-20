# VFX recipes: full builds, bursts, beams, post-processing, budgets

Uneven Size/Transparency keys are `[[time, value], ...]`; evenly spaced lists may be plain numbers. Item Positions are world studs: move the host part, never re-tune the emitters. Textures are only `rbxasset://textures/particles/` built-ins.

## Attachment placement
- Point sources (flame, wand tip, muzzle, sparks at a hit) emit from an Attachment; area sources (dust, mist, rain of leaves) emit from the host part, whose Size is the volume. Attachment Position is relative to its part.
- Flame 0.2-0.4 studs above the wick or logs; smoke Attachment 1-1.5 studs above the flame so smoke starts where the fire fades.
- Beams: one Attachment on each endpoint. Trails: two Attachments across the motion (blade base and tip, or left and right of a dash), 2-3 studs apart.
- Character effects: scripts parent emitters to the character's existing RootAttachment or a hand grip Attachment; never weld extra parts for this.

## Campfire (layered: smoke behind, core, embers, warm light)
```json
{"name": "Campfire", "items": [
  {"key": "Host", "name": "FireHost", "className": "Part", "props": {"Size": [2, 0.4, 2], "Position": [0, 0.6, 0], "Transparency": 1, "CanCollide": false, "CastShadow": false}},
  {"key": "Flame", "in": "Host", "name": "Flame", "className": "Attachment", "fx": {"Position": [0, 0.3, 0]}},
  {"key": "SmokePoint", "in": "Host", "name": "SmokePoint", "className": "Attachment", "fx": {"Position": [0, 1.4, 0]}},
  {"in": "Flame", "name": "Core", "className": "ParticleEmitter", "fx": {"Texture": "rbxasset://textures/particles/fire_main.dds", "Rate": 40, "Lifetime": [0.6, 1.1],
    "Speed": [3, 5], "SpreadAngle": [8, 8], "Size": [1.6, 1.2, 0.2], "Transparency": [[0, 1], [0.15, 0.35], [0.7, 0.55], [1, 1]],
    "Color": ["#ffd27a", "#ff8a2a", "#b2361a"], "LightEmission": 1, "LightInfluence": 0, "Acceleration": [0, 4, 0], "Drag": 1, "Rotation": [0, 360], "RotSpeed": [-40, 40], "ZOffset": 0.5}},
  {"in": "Host", "name": "Embers", "className": "ParticleEmitter", "fx": {"Texture": "rbxasset://textures/particles/fire_sparks_main.dds", "Rate": 8, "Lifetime": [1.5, 2.5],
    "Speed": [4, 8], "SpreadAngle": [25, 25], "Size": [0.12, 0], "Transparency": [[0, 0], [0.8, 0.2], [1, 1]], "Color": ["#ffb347", "#ff5a1f"],
    "LightEmission": 1, "Acceleration": [0, 3, 0], "Drag": 1.5}},
  {"in": "SmokePoint", "name": "Smoke", "className": "ParticleEmitter", "fx": {"Texture": "rbxasset://textures/particles/smoke_main.dds", "Rate": 6, "Lifetime": [4, 6],
    "Speed": [1.5, 3], "SpreadAngle": [12, 12], "Size": [1.5, 6], "Transparency": [[0, 1], [0.15, 0.7], [1, 1]], "Color": ["#5a5550", "#8a8580"],
    "LightInfluence": 1, "Acceleration": [1.2, 0.6, 0.4], "Drag": 0.4, "Rotation": [0, 360], "RotSpeed": [-15, 15], "ZOffset": -1}},
  {"in": "Flame", "name": "Glow", "className": "PointLight", "fx": {"Range": 14, "Brightness": 2, "Color": "#ffb46b", "Shadows": true}}]}
```
Torch: same Core at 0.5x Size and Rate 25, Embers Rate 3, no Smoke, PointLight Range 12. Add flicker from a client script.

## Waterfall (sheet at the lip, mist at the pool)
```json
{"name": "WaterfallFx", "items": [
  {"key": "Lip", "name": "Lip", "className": "Part", "props": {"Size": [12, 1, 2], "Position": [0, 40, 0], "Transparency": 1, "CanCollide": false, "CastShadow": false}},
  {"in": "Lip", "name": "Sheet", "className": "ParticleEmitter", "fx": {"Texture": "rbxasset://textures/particles/smoke_main.dds", "Rate": 60, "Lifetime": [1.2, 1.8],
    "Speed": [18, 24], "SpreadAngle": [4, 10], "Size": [2, 5], "Transparency": [0.4, 1], "Color": ["#e8f6ff", "#cfe8f5"], "EmissionDirection": "Bottom",
    "Acceleration": [0, -30, 0], "LightInfluence": 1, "Rotation": [0, 360]}},
  {"key": "Pool", "name": "Pool", "className": "Part", "props": {"Size": [14, 1, 8], "Position": [0, 1, 3], "Transparency": 1, "CanCollide": false, "CastShadow": false}},
  {"in": "Pool", "name": "Mist", "className": "ParticleEmitter", "fx": {"Texture": "rbxasset://textures/particles/smoke_main.dds", "Rate": 20, "Lifetime": [2, 3],
    "Speed": [3, 6], "SpreadAngle": [60, 60], "Size": [3, 10], "Transparency": [[0, 1], [0.2, 0.6], [1, 1]], "Color": ["#ffffff", "#dcecf5"],
    "Acceleration": [0, 1, 0], "Drag": 1, "LightInfluence": 1, "Rotation": [0, 360], "RotSpeed": [-10, 10]}}]}
```

## Bursts (Rate 0 emitters, fired with Emit)
| Burst | Emitters (Emit count) | Key values |
|---|---|---|
| Explosion | Core explosion01_core_main (6), Shockwave explosion01_shockwave_main (1), Smoke explosion01_smoke_main (10), Sparks fire_sparks_main (30) | Core Lifetime 0.25-0.4, Size 0:2 1:8, LightEmission 1, fff1c1 to ff7a1f; Shockwave Lifetime 0.35, Speed 0, Size 0:1 1:14, Transparency 0:0.2 1:1; Smoke Lifetime 1.5-2.5, Speed 4-8, SpreadAngle 180, Size 0:3 1:9, Drag 3, 4a4642; Sparks = Impact sparks preset |
| Heal / level-up | sparkles_main (20) on RootAttachment | Lifetime 0.8-1.2, Speed 2-4, Shape Cylinder, Acceleration 0,4,0, Size 0:0.3 1:0, 8dffb0 to 3ccf7a, LightEmission 1 |
| Coin pickup | sparkles_main (12) | Lifetime 0.4-0.6, Speed 4-6, SpreadAngle 180, Size 0:0.25 1:0, ffe08a to ffc845, LightEmission 1 |
| Hit spark | Impact sparks preset (15-25) | at the hit Attachment, oriented to the surface normal |

```lua
--!strict
-- One pooled emitter set per effect; never create emitters per hit.
local function burst(host: Instance, counts: { [string]: number })
	for name, count in counts do
		local emitter = host:FindFirstChild(name)
		if emitter and emitter:IsA("ParticleEmitter") then emitter:Emit(count) end
	end
end
burst(workspace:WaitForChild("ExplosionFx"):WaitForChild("Host"), { Core = 6, Shockwave = 1, Smoke = 10, Sparks = 30 })
```
Flash: tween the burst PointLight Brightness 8 to 0 over 0.25 s. Move the pooled host to the hit position before calling `burst`.

## Beams and trails
| Effect | Values |
|---|---|
| Laser | Width0 = Width1 = 0.3, FaceCamera true, LightEmission 1, Segments 1, Color ff3b3b, Transparency 0:0 1:0.2 |
| Energy tether | Width 0.4 to 0.2, CurveSize0 2, CurveSize1 -2, Segments 20, LightEmission 1, 6fe3ff to a36bff, Transparency 0:0.1 0.5:0.4 1:0.1 |
| Light shaft | Width0 6, Width1 14, FaceCamera false, Transparency 0:0.85 1:1, LightInfluence 0, ffe6b0, no texture |
| Sword swing trail | Lifetime 0.18, WidthScale 0:1 1:0, Transparency 0:0.2 1:1, LightEmission 0.8, Enabled false until the swing |
| Dash trail | Lifetime 0.35, MinLength 0.1, Transparency 0:0.5 1:1, the player colour |
Textures on beams: none (solid), or forcefield_glow_main.dds with TextureMode Stretch for a soft core.

## Post-processing that flatters VFX (environment_apply section overrides)
Bloom decides whether LightEmission and Neon glow. Change only what differs from the scene preset (`arcane-photoreal`).
| Scene | Call |
|---|---|
| Campfire at night | preset night, bloom {Intensity 0.7, Size 28, Threshold 1.1} |
| Magic / arcane | preset night or sci_fi, bloom {Intensity 0.9, Size 32, Threshold 0.95}, colorCorrection {Saturation 0.1} |
| Waterfall by day | preset clear_day, atmosphere {Density 0.3, Haze 1.5}, sunRays {Intensity 0.08, Spread 0.7} |
| Forest clearing | preset forest-morning (dusk: forest-dusk); scene_build plinth kit `life` adds Dust motes, rune light and Fireflies |
| Volcanic | preset golden_hour, atmosphere {Density 0.45, Haze 2.5, Color "#c27a52", Decay "#6b2a14"}, colorCorrection {Contrast 0.15, TintColor "#ffe2c8"} |
Sane ranges: Bloom Intensity 0.3-1, Size 20-36, Threshold 0.9-1.6 (under 0.8 the whole scene glows); ColorCorrection Contrast 0-0.25, Saturation -0.45 to 0.15, TintColor channels 0.85+; SunRays Intensity 0.03-0.15, Spread 0.4-0.9; Atmosphere Density 0.25-0.6 (0.7+ hides the map), Haze 0-3, Glare 0-0.6. DepthOfField: the `environment_apply` depthOfField section (values in `arcane-photoreal`).

## Performance budgets
| Item | Cap |
|---|---|
| Rate x max Lifetime per emitter | 200 (ambient fill 100) |
| Live particles in view | 1500 desktop, 600 phone |
| Emitters per effect | 4 |
| Lifetime | ambient 10 s, bursts 2.5 s |
| Large translucent particles (Size 6+) overlapping | 20 (fill-rate cost) |
| Shadowed lights on screen / flickering lights | 8 / 20 |
| Beam Segments | 20 |
Phones: a client script halves Rate when `UserSettings():GetService("UserGameSettings").SavedQualityLevel.Value` is 1-3 (0 = automatic: keep full Rate).
