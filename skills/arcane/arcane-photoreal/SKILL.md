---
name: arcane-photoreal
description: "Make Roblox scenes look photoreal: Future lighting, mood presets (golden hour, foggy forest, night, horror, sci-fi) with Atmosphere and post-processing, terrain grass, MaterialVariants, SurfaceAppearance, real-world scale and imperfection rules."
license: MIT
---

# Photoreal finish: light, mood, materials, scale

## Rules first
- Apply one mood preset in ONE `environment_apply` call (lighting + atmosphere + bloom + colorCorrection + sunRays). Never leave default Lighting on a finished scene.
- Arcane cannot set these. Tell the user once, in one line each, to set them in the Properties window:
  - Lighting.Technology = Future (point-light shadows, specular).
  - Workspace.Terrain.Decoration = true (animated grass blades; Grass material only, not LeafyGrass).
  - MaterialService.Use2022Materials = true; MaterialVariants are added in the Material Manager.
- Build geometry with `scene_build` (one batch per layer) and terrain with `environment_apply`. Use DepthOfField only through a client script: `scene_create` a LocalScript under StarterPlayer.StarterPlayerScripts, `script_update` it to create a `DepthOfFieldEffect` under the Camera, and keep it disabled until activated.
- When Atmosphere exists, FogStart/FogEnd are ignored. Use Atmosphere Density and Haze for distance fog.
- Verify with `studio_viewport_capture`: one eye-level shot (camera 5 studs high looking down the main path) and one overview. Fix floating objects, plastic-looking surfaces, repetition and blown highlights before reporting.

## Mood presets (environment_apply values; colours are 0..1 RGB)
| Mood | lighting | atmosphere | bloom Intensity/Size/Threshold | colorCorrection | sunRays Intensity/Spread |
|---|---|---|---|---|---|
| Clear day | ClockTime 13, Brightness 3, ExposureCompensation 0, Ambient [0.05,0.05,0.06], OutdoorAmbient [0.5,0.5,0.52], ShadowSoftness 0.15 | Density 0.25, Offset 0.25, Color [0.78,0.84,0.9], Decay [0.55,0.62,0.7], Glare 0.2, Haze 1 | 0.3/24/1.6 | Contrast 0.06, Saturation 0.05 | 0.05/0.6 |
| Golden hour | ClockTime 17.6, Brightness 2.5, ExposureCompensation 0.2, Ambient [0.08,0.06,0.05], OutdoorAmbient [0.55,0.45,0.38], ColorShift_Top [1,0.78,0.5], ShadowSoftness 0.25 | Density 0.32, Offset 0.15, Color [0.95,0.78,0.6], Decay [0.9,0.55,0.35], Glare 0.6, Haze 1.8 | 0.6/30/1.2 | Brightness 0.02, Contrast 0.1, Saturation 0.12, TintColor [1,0.95,0.88] | 0.12/0.8 |
| Foggy forest | ClockTime 9.5, Brightness 1.6, Ambient [0.1,0.11,0.12], OutdoorAmbient [0.42,0.46,0.48], ShadowSoftness 0.6 | Density 0.55, Offset 0.05, Color [0.72,0.78,0.8], Decay [0.55,0.62,0.6], Glare 0, Haze 3 | 0.35/24/1.6 | Contrast 0.05, Saturation -0.15, TintColor [0.93,0.98,1] | 0.04/0.5 |
| Night | ClockTime 0, Brightness 1, ExposureCompensation 0.3, Ambient [0.04,0.05,0.08], OutdoorAmbient [0.18,0.22,0.32], ColorShift_Top [0.6,0.7,1], ShadowSoftness 0.3 | Density 0.35, Offset 0.1, Color [0.35,0.42,0.6], Decay [0.2,0.25,0.4], Glare 0, Haze 1 | 0.8/28/0.9 | Contrast 0.12, Saturation -0.25, TintColor [0.85,0.9,1] | 0/0 |
| Horror | ClockTime 0.5, Brightness 0.4, ExposureCompensation -0.3, Ambient [0.02,0.02,0.025], OutdoorAmbient [0.08,0.08,0.1], ShadowSoftness 0.1 | Density 0.6, Offset 0, Color [0.25,0.27,0.28], Decay [0.12,0.12,0.14], Glare 0, Haze 2.5 | 0.4/20/1.4 | Brightness -0.05, Contrast 0.25, Saturation -0.45, TintColor [0.9,1,0.95] | 0/0 |
| Sci-fi | ClockTime 21, Brightness 1.2, Ambient [0.05,0.06,0.1], OutdoorAmbient [0.2,0.24,0.35], ColorShift_Top [0.6,0.8,1], ShadowSoftness 0.15 | Density 0.3, Offset 0.2, Color [0.45,0.55,0.75], Decay [0.25,0.2,0.45], Glare 0.3, Haze 1.2 | 1/32/0.95 | Contrast 0.15, Saturation 0.1, TintColor [0.9,0.97,1] | 0.05/0.4 |

All presets: EnvironmentDiffuseScale 1, EnvironmentSpecularScale 1, GlobalShadows true (Foggy forest: specular 0.6; Horror: diffuse 0.3).
- Night and horror are carried by practical lights: warm PointLights (ffb46b, Brightness 2-3) and, for horror, a player flashlight SpotLight (Angle 45, Range 40, Brightness 3, Shadows true) plus 1-3 flickering sources. Light recipes: `arcane-vfx`.
- Foggy forest adds low ground mist (the vfx Smoke preset with Size 0:4 1:12, Speed 0.3-0.6, near the ground).
- Sci-fi surfaces: Metal, DiamondPlate, Glass; Neon trims 4fd8ff or ff3df0 on at most 5% of visible surface.
- DepthOfField: gameplay FarIntensity 0.15, FocusDistance 40, InFocusRadius 60, NearIntensity 0; cinematic FarIntensity 0.4, FocusDistance 20, InFocusRadius 15. Expose an off switch in settings.

## Materials
- Use textured materials (Concrete, Brick, WoodPlanks, Slate, Cobblestone, Plaster, Metal) over SmoothPlastic; SmoothPlastic only for painted manufactured items.
- Colour range 0.08-0.92 per channel, saturation under 70% except emissive. No pure white or black.
- Reflectance 0 on most parts, at most 0.2; Glass Transparency 0.3-0.5.
- MaterialVariant (user-created in Material Manager): StudsPerTile 8-16 for walls and floors, 20-40 for ground; name the BaseMaterial it overrides.
- SurfaceAppearance (MeshParts from the asset pipeline only): ColorMap + NormalMap (OpenGL, +Y) + RoughnessMap + MetalnessMap; 1024 px for hero props, 512 px otherwise; roughness never pure 0 or 1; metalness 0 or 1.

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
