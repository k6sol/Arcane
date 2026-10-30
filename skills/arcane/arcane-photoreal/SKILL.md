---
name: arcane-photoreal
description: "Develop a requested realistic Roblox look through original form, scale, UV/PBR surfaces and controlled lighting, then assess the actual engine result without promising photographic equivalence."
license: MIT
---

# Realistic look development with readable play

## Use realism only when it is the brief
Establish references, scale, material families, time/weather and player camera. Preserve an intentionally stylized project or a local edit's scope. Realism is a relationship among geometry, light, surfaces and composition; adding fog and texture to blockout forms does not satisfy it. Do not insert people or scale figures into review views unless requested.

Start with silhouettes, construction thickness, contact and believable proportions. Author original Blender models, UVs, textures and PBR through an available faithful route; inspect previews and exported maps before the supported human-reviewed import flow. Toolbox/free models or materials require an express request. Retain sources and do not claim imported/persistent content from a local render.

## Establish scale and surfaces
Use the import's explicit unit conversion once and measure known dimensions against the real intended avatar/movement envelope without creating a scale figure. Doors need passing/headroom clearance, stairs need usable rise/tread/landings, and props need sensible grip/contact height. Old numerical examples are design references, not universal engine dimensions.

Material response should reveal construction: paint over metal, cut wood versus bark, dry versus wet stone, cloth versus skin. Use consistent grain and texel scale, correct normals, useful roughness variation and intentional material separation. Avoid pure glossy plastic on every surface, uniformly dirty noise, fake painted geometry and uncontrolled saturation. Material choice follows actual surface and style; SmoothPlastic can be appropriate to a smooth manufactured object.

For imported MeshParts, verify the actual supported SurfaceAppearance/map path, UV0, normal convention, alpha and factor handling. For a deliberate MaterialVariant edit, inspect which base-material users an override will affect before applying it. A global override is not a local texture edit. Unsupported channels and session-only images are explicit limitations.

## Light to explain the scene
Use one dominant light direction plus purposeful practicals/fill. Establish a neutral material review before a dramatic mood so exposure does not hide bad normals or surfaces. environment_apply offers presets such as clear_day, golden_hour, foggy_forest, night, horror, sci_fi and forest variants; select only one that serves the brief, then tune supported sections from actual engine captures. [forest-light](references/forest-light.md) is a declared reference for forest conditions.

Atmosphere controls the supported distance haze; do not stack unrelated fog assumptions. Bloom is restrained spill, not a substitute for emissive geometry or illumination. Keep critical gameplay paths, enemies and GUI legible in night/horror looks. Depth of field and shake belong to the intended camera use and accessibility options, not every gameplay view. If a setting is refused, report the named manual/capability boundary rather than claiming the preset applied.

Use terrain_generate for requested natural ground; keep local lighting or material edits scoped.

## Apply supported controls, then inspect
Use `environment_apply` with a relevant `preset` and explicit section overrides; these current preset starts are not universal art direction:
| Condition | Preset | ClockTime |
|---|---|---|
| Clear day | clear_day | 13 |
| Golden hour | golden_hour | 17.6 |
| Foggy forest | foggy_forest | 9.5 |
| Night | night | 0 |
For horror/sci-fi or forest variants, read the current preset/declared forest-light values rather than guessing.

Sections include `lighting` (ExposureCompensation, OutdoorAmbient, ColorShift_Top, ShadowSoftness, EnvironmentDiffuseScale, EnvironmentSpecularScale), `atmosphere` (Density, Haze, Glare, Decay), `bloom` (Intensity, Size, Threshold), `colorCorrection` (TintColor, Contrast, Saturation), `sunRays` and `depthOfField` (FarIntensity, FocusDistance, InFocusRadius). Tune one cause at a time. When Atmosphere is present, FogStart/FogEnd are ignored; inspect the actual haze instead.

`technology: "Future"` and `terrainDecoration: true` are explicit supported choices, not prerequisites for every edit. Refused properties require the reported manual step. `materials` entries use `name`, `baseMaterial`, `studsPerTile`, `override` and supported ColorMap/NormalMap/RoughnessMap/MetalnessMap content; do not invent IDs or imply procedural Blender shaders transfer automatically.

Use `studio_viewport_capture` in Edit with `frame: {ref, views: ["front","three_quarter"]}` for a neutral comparison; it does not start Play or certify gameplay. Preserve the requested camera/look and report refused capture settings.

## Acceptance
Inspect a player-height route view, a wider composition and neutral closeups of important surfaces. Look for floating contacts, repeated clones, bad bark/stone scale, black crushed detail, blown highlights, alpha halos and material mismatches. Grounding should respect shape and terrain; do not uniformly bury every rock by a fixed percentage.

Traverse the intended action in representative lighting and compare target-device cost with the unmodified scene. Add atmospheric VFX/audio only when relevant, authorized and actually functional. Separate source-render quality, exported-map correctness, engine appearance and played readability in the report. Measured success on one fixture or a pleasing screenshot does not establish photorealism or full-game quality.
