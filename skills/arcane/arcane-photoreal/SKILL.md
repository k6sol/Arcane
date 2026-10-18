---
name: arcane-photoreal
description: "Make Roblox scenes look photoreal: Future lighting, mood presets (golden hour, foggy forest, night, horror, sci-fi) with Atmosphere and post-processing, terrain grass, MaterialVariants, SurfaceAppearance, real-world scale and imperfection rules."
license: MIT
---

# Photoreal finish: light, mood, materials, scale

## Rules first
- One `environment_apply` call sets the look: `preset` (one word) + `technology: "Future"` + `terrainDecoration: true` when the ground uses Grass. The host expands the preset to exact Lighting, Atmosphere, Bloom, ColorCorrection and SunRays values; add only the section fields you want to change. Never leave default Lighting on a finished scene.
- That call is one undo step, verified and rolled back as a whole. If Studio refuses a setting the error names the manual step (for example Lighting.Technology = Future or Terrain Decoration = true in the Properties window); tell the user that one line and continue.
- MaterialService.Use2022Materials stays a manual Properties-window setting; mention it once if materials look flat.
- Realism comes from real assets: `studio_asset_search` free (preferably verified) Creator Store models for organic and complex objects, `studio_asset_insert` one per kind (scripts stripped) and clone with `scene_build` templates; else `studio_asset_generate`; else `assets_procedural` (review with `assets_preview`; session-only MeshParts that vanish in Play until the user uploads them); primitives for exact-dimension architecture. Never buy or publish.
- Order: `terrain_generate` first (seeded landforms, a `flatten` clearing under the focal structure, river/path polylines, snowLine for peaks), then assets or procedural meshes, then `scene_build` geometry (one batch per layer); `environment_apply` sets the look. DepthOfField only through a client script: `scene_create` a LocalScript under StarterPlayer.StarterPlayerScripts, `script_update` it to create a `DepthOfFieldEffect` under the Camera, then enable it with `script_read` + `script_set_enabled`.
- When Atmosphere exists, FogStart/FogEnd are ignored. Use Atmosphere Density and Haze for distance fog.
- Verify with `studio_viewport_capture`: `frame {ref: main subject, views: ["three_quarter","low_angle"]}` (one sheet) plus one eye-level camera down the main path. Fix floating objects, plastic surfaces, repetition and blown highlights before reporting.

## Mood presets (`preset` values; tune per field after)
| Mood | preset | Key traits | Tune with |
|---|---|---|---|
| Clear day | clear_day | ClockTime 13, Brightness 3, light haze, neutral grade | atmosphere Haze, colorCorrection Saturation |
| Golden hour | golden_hour | ClockTime 17.6, warm ColorShift_Top, Glare and Haze, warm TintColor | lighting ClockTime 17-18, sunRays Intensity |
| Foggy forest | foggy_forest | ClockTime 9.5, Density 0.55, Haze 3, desaturated, EnvironmentSpecularScale 0.6 | atmosphere Density 0.4-0.7 |
| Night | night | ClockTime 0, cool OutdoorAmbient, ExposureCompensation 0.3, strong bloom | lighting OutdoorAmbient, bloom Threshold |
| Horror | horror | ClockTime 0.5, Brightness 0.4, Contrast 0.25, Saturation -0.45, EnvironmentDiffuseScale 0.3 | atmosphere Decay, ShadowSoftness |
| Sci-fi | sci_fi | ClockTime 21, cyan ColorShift_Top, Bloom 1/32/0.95 | colorCorrection TintColor |

- Night and horror are carried by practical lights: warm PointLights (ffb46b, Brightness 2-3) and, for horror, a player flashlight SpotLight (Angle 45, Range 40, Brightness 3, Shadows true) plus 1-3 flickering sources. Light and particle recipes (created directly): `arcane-vfx`.
- Foggy forest adds low ground mist (the vfx Smoke preset with Size 0:4 1:12, Speed 0.3-0.6, near the ground).
- Sci-fi surfaces: Metal, DiamondPlate, Glass; Neon trims 4fd8ff or ff3df0 on at most 5% of visible surface.
- DepthOfField: gameplay FarIntensity 0.15, FocusDistance 40, InFocusRadius 60, NearIntensity 0; cinematic FarIntensity 0.4, FocusDistance 20, InFocusRadius 15. Expose an off switch in settings.

## Materials
- Use textured materials (Concrete, Brick, WoodPlanks, Slate, Cobblestone, Plaster, Metal) over SmoothPlastic; SmoothPlastic only for painted manufactured items.
- Colour range 0.08-0.92 per channel, saturation under 70% except emissive. No pure white or black.
- Reflectance 0 on most parts, at most 0.2; Glass Transparency 0.3-0.5.
- MaterialVariant directly: `environment_apply` `materials: [{name, baseMaterial, studsPerTile, override: true, ColorMap, NormalMap, RoughnessMap, MetalnessMap}]`. Maps are a user-given or existing rbxassetid, or a built-in rbxasset://textures path. `override` restyles every part and terrain of that base material. StudsPerTile 8-16 for walls and floors, 20-40 for ground.
- `studio_asset_generate` kind material creates a MaterialVariant from baseMaterial + prompt and applies it to parts with a receipt; kind texture retextures an inserted MeshPart.
- Decal/Texture (direct, `scene_create`/`scene_build` fx) for signs, grime and stains: Texture StudsPerTileU/V matches the surface; Transparency 0.2-0.6 for dirt.
- SurfaceAppearance maps are not settable by plugins: only on MeshParts from the asset pipeline or set by the user. ColorMap + NormalMap (OpenGL, +Y) + RoughnessMap + MetalnessMap; roughness never pure 0 or 1; metalness 0 or 1.

## Real-world scale (avatar 5.5 studs, 1 stud ~ 0.3 m)
Door 4 x 7.5; floor-to-floor 12-14; stair riser 0.75-1 with tread 1.5-2; railing 3.5; table 2.7; chair seat 1.6; counter 3; window sill 3; road lane 12-14; sidewalk 8; street lamp 16-18; car 6 x 5 x 14; realistic tree 25-40 tall with a 1.5-3 trunk.

## Imperfection and variation
- No identical neighbours: Size jitter 3-8%, yaw 2-5 degrees on props (never structure), tint 0.94-1.06.
- Darken 10-15% at ground contact and wall bases; add moss and damp on the shaded side.
- Sink rocks 20-40% into terrain; use `ground:true` in scatter. Nothing floats.
- Clutter gathers in corners and along walls (litter, leaves, puddles), never evenly spread.
- Break long straight edges with trim, chamfer wedges and broken or missing pieces every 12-20 studs.
- One dominant key light. Practical lights are warmer (ffb46b-ffd2a1) than the cool sky fill.
- Natural layouts and forests: `arcane-natural-scenes`; detailed architecture: `arcane-architectural-features`.
- Realistic sound (ambience, reverb, music): `arcane-audio`.
