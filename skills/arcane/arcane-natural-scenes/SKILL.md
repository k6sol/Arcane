---
name: arcane-natural-scenes
description: "Build high-detail natural Roblox scenes fast: terrain ground and paths, varied multi-part trees, undergrowth, natural Poisson-disk placement and atmosphere in a few batch calls."
license: MIT
---

# Natural scenes: forests, meadows, rocks

## Process (aim for 4-6 write calls in total)
1. Plan once: focal point, clearing radius (18-30 studs around a landmark), a 6-10 stud path to it, dense and sparse zones, and a budget of 800-2500 parts.
2. `environment_apply` terrain. Never use a flat Part disc as ground.
   - Base: a Block 2-4 studs thick in Grass, larger than the forest.
   - Hills: 6-15 Balls of radius 20-60, sunk so only 4-12 studs show, mixing LeafyGrass and Grass.
   - Patches: Ground or Mud near the clearing.
   - Path: overlapping Cylinders/Blocks in Ground, Pebble or Cobblestone.
   - If terrain is unavailable, overlap 5+ irregular Grass/Ground slabs at varied heights and yaw.
3. Real assets first. `studio_asset_search` each kind ("realistic pine tree", "mossy boulder", "fern"), prefer verified free models in one style, then `studio_asset_insert` one per kind into a hidden template Folder (ServerStorage if granted) with maxSize at real scale. Scripts are stripped. Check one with `studio_viewport_capture`.
4. `scene_build` once per layer (trees, undergrowth, rocks): `templates` (the inserted refs) + `scatter` with `ground:true` clones them. Build the part archetypes below only when no suitable asset exists; use `studio_asset_generate` kind mesh for a single hero object.
5. `environment_apply` lighting, atmosphere and effects.
6. Check the receipt: counts and scatter placed vs requested. Fix only real gaps.

## Tree archetypes (fallback when no asset fits): use 3-4, each a multi-part prototype
- Trunks: Wood, CanCollide true. Foliage: CanCollide false; small leaves CastShadow false. Everything Anchored.
- Disc or column: Part Shape Cylinder with Size [length, d, d] and Orientation [0,0,90] (vertical axis).
- **Pine (12-16 parts)**
  - Trunk: 3 stacked cylinders tapering 1.6 -> 1.2 -> 0.8 studs, 14-18 studs tall in total, #5a4030.
  - Canopy: 5-7 tiers, each a flat cylinder disc or 2 crossed WedgeParts.
  - Tiers shrink from diameter 9 to 2 going up, each offset 15-30 degrees in yaw.
  - Greens alternate #2f5d34 / #3b6e3a / #28502e, LeafyGrass.
- **Oak (14-20 parts)**
  - Trunk: 2.2-2.6 studs thick and 8-10 tall, #4b3626.
  - Branches: 2-3 cylinders angled 30-50 degrees.
  - Canopy: 6-10 overlapping Balls of 5-9 studs, irregular within a 6-8 stud radius, in 2-3 greens (#4a7a3a, #5b8c43, #3f6b34).
- **Birch (8-12 parts)**
  - Trunk: slender, 0.9 studs thick, pale #e8e4d8 in SmoothPlastic.
  - Marks: 3-5 thin dark Blocks (#2b2b2b) on the trunk.
  - Canopy: 4-6 light balls (#8fb35a, #a3c46a).
- **Variety**: add a sapling or dead snag for contrast.

Set scatter variation:
- tint min [0.85,0.9,0.85] and max [1.1,1.1,1.05].
- scale [0.75,1.25].
- yaw random (the default).

## Undergrowth: 2-4x as many items as trees, cheap parts
- Bush: 3-5 clustered Balls of 1.5-3 studs in LeafyGrass greens.
- Fern: 4-6 thin WedgeParts (0.1 x 1.5 x 0.4), yaw steps of 60-72 degrees, tilted 30-45 degrees.
- Grass tuft: 3 crossed thin Blocks (0.1 x 1 x 0.15), CanCollide false, CastShadow false.
- Mossy rock cluster: 2-4 rotated Blocks/Balls in Slate/Rock greys (#6b6e70, #7d807a) with a thin green moss cap.
- Fallen log: a horizontal cylinder plus 1-2 stubs.
- Flower: a thin stem plus 2-3 tiny coloured Balls in SmoothPlastic.

## Placement rules
- Use `scatter` only for natural layouts.
- Never use rings, grids, rows, evenly stepped angles or one shared radius.
- Trees:
  - minSpacing 7-10 studs.
  - clusters 6-12 for groves.
  - clearing inner = clearing radius, outer = inner + 25-40, so density ramps up.
- Use `avoid` circles to keep the path clear.
- Order: trees, then bushes/rocks (minSpacing 2-4), then tufts (minSpacing 1-1.5). The shared occupancy keeps later layers out of trunks.
- Group each layer in its own Model: Trees, Undergrowth, Rocks.

## Lighting (one environment_apply)
Shortcut: `preset: "clear_day"` or `"foggy_forest"`, plus `terrainDecoration: true` on Grass ground, then override fields. Other moods and photoreal materials: `arcane-photoreal`. Fireflies, falling leaves, waterfalls (created directly): `arcane-vfx`.
- lighting:
  - ClockTime 14.5-16, Brightness 2-3.
  - Ambient [0.27,0.29,0.3], OutdoorAmbient [0.5,0.52,0.5].
  - EnvironmentDiffuseScale 0.6, EnvironmentSpecularScale 0.5, ShadowSoftness 0.3.
- atmosphere:
  - Density 0.3, Offset 0.25, Haze 1.5-2.5, Glare 0.2.
  - Color [0.78,0.82,0.85], Decay [0.45,0.5,0.45].
- bloom: Intensity 0.3, Size 24, Threshold 1.5.
- colorCorrection: Contrast 0.08, Saturation 0.08, Brightness 0.02.
- sunRays: Intensity 0.06, Spread 0.6.

## Budget
- Total: 800-2500 parts.
- If over budget, cut tufts first, never tree detail.
- Do not re-read the whole forest after building. The receipt counts are the evidence; inspect one keyed ref if needed.
