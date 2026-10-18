---
name: arcane-natural-scenes
description: "Build high-detail natural Roblox scenes fast: terrain ground and paths, varied multi-part trees, undergrowth, natural Poisson-disk placement and atmosphere in a few batch calls."
license: MIT
---

# Natural scenes: forests, meadows, rocks

## Process (aim for 4-6 write calls in total)
1. Plan once: focal point, clearing radius (18-30 studs around a landmark), a 6-10 stud path to it, dense and sparse zones, and a budget of 800-2500 parts.
2. `terrain_generate` the ground first, one call. Never use a flat Part disc as ground.
   - Region larger than the scene, baseHeight 20-40, fixed seed; fbm amplitude 6-20, ridged 40-120 for mountains at the edges.
   - `flatten` the clearing under each focal structure (radius + 4, blend 16-30) so it sits level.
   - `path`: 3-8 points in gentle bends, width 6-10, ending at the clearing. `river`: 4-12 points along low ground, width 12-40, depth 6-12, never through the clearing.
   - Default materials: Sand shores, Mud banks, Rock cliffs, Grass; snowLine for peaks.
   - Extras or an older plugin: `environment_apply` terrain fills.
3. Real assets first. `studio_asset_search` each kind ("realistic pine tree", "mossy boulder", "fern"), prefer verified free models in one style and light ones (a clone template holds at most 2000 instances), then `studio_asset_insert` one per kind into a template Folder (ServerStorage if granted) with maxSize at real scale. Scripts are stripped.
4. No fitting asset: `studio_asset_generate` kind mesh for one hero object; else `assets_procedural` (tree, rock, foliage; check `assets_preview`, then prepare, stage, reconstruct and `assets_place_studio_import` one copy), whose meshes last only this Studio session and vanish in Play until the user uploads them (say so); else the part archetypes below.
5. `scene_build` once per layer (trees, undergrowth, rocks): `templates` (the inserted refs) + `scatter` with `ground:true` clones them. One build creates at most 4000 instances including clone contents; split big layers.
6. `environment_apply` lighting, atmosphere and effects.
7. Check the receipt (counts, scatter placed vs requested), then one `studio_viewport_capture` of the scene, which also checks the inserted assets through their clones. Fix only real gaps.

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
- Fallen log: a horizontal cylinder; flower: a stem plus 2-3 tiny Balls.

## Placement rules
- Use `scatter` only for natural layouts.
- Never use rings, grids, rows, evenly stepped angles or one shared radius.
- Trees:
  - minSpacing 7-10 studs.
  - clusters 6-12 for groves.
  - clearing inner = clearing radius, outer = inner + 25-40, so density ramps up.
- Use `avoid` circles to keep the path and river clear; `ground:true` lands items on the generated surface.
- Order: trees, then bushes/rocks (minSpacing 2-4), then tufts (minSpacing 1-1.5). The shared occupancy keeps later layers out of trunks.
- Group each layer in its own Model: Trees, Undergrowth, Rocks.

## Lighting (one environment_apply)
`preset: "clear_day"` or `"foggy_forest"`, plus `terrainDecoration: true` on Grass ground, then override only what differs. Warm afternoon forest: lighting ClockTime 14.5-16, ShadowSoftness 0.3; atmosphere Density 0.3, Haze 1.5-2.5, Decay [0.45,0.5,0.45]. Other moods and photoreal materials: `arcane-photoreal`. Fireflies, falling leaves, waterfalls (created directly): `arcane-vfx`. Wind, birds and water ambience: `arcane-audio`.

## Budget
- Total: 800-2500 parts.
- If over budget, cut tufts first, never tree detail.
- Do not re-read the forest after building; receipt counts and one capture are the evidence.
