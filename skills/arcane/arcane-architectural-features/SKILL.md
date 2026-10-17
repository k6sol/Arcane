---
name: arcane-architectural-features
description: "Build detailed Roblox architecture such as classical columns, stepped plinths, stairs and spawn pedestals with correct SpawnLocation placement, in one batch call."
license: MIT
---

# Architectural features: columns, plinths, spawn pedestals

## Process
- Build one landmark with one `scene_build` call (roughly 120-220 parts).
- Group it in a Model with keyed sub-Models: Plinth, Column, Capital, Stair, Top.
- Key the spawn so its ref comes back.

## Geometry rules
- Discs and columns are Part Shape Cylinder with Size [length, d, d] and Orientation [0,0,90], which makes the axis vertical.
- Stack with a running height. A piece of thickness t sitting on surface y has centre y + t/2.
- Use materials with subtle tint contrast:
  - Marble: #e6e2da shaft, #d4cfc4 core.
  - Limestone: #cfc6b0 trims.
  - Slate: #5f6366 steps and bands.
- Use a prototype plus yawed placements for every repeated ring element (flutes, balusters, treads). The prototype part sits at a relative Position [radius, y, 0], and the placement `yaw` swings it around the centre.

## Classical column on a stepped plinth (centre C at ground g)
1. **Plinth**
   - 3 steps, 1.2 high each, diameters 26 / 22 / 18.
   - Alternate Slate and Marble.
   - Add a 0.3-thick Limestone trim disc 0.6 wider at each step top.
2. **Base torus**: 3 discs, 0.4 thick, diameters 9.6 / 9.2 / 8.8.
3. **Shaft**
   - Core cylinder 8 studs in diameter and 18-26 tall.
   - Fluting: 20 thin cylinders (0.7 diameter) at radius 3.85, as 20 placements of one "Flute" prototype, yaw step 18 degrees.
4. **Necking and capital**
   - Necking: a 0.3 Slate band.
   - Echinus: 3 flared discs (diameters 9 / 10 / 11, 0.5 thick).
   - Abacus: a square Limestone Block 12 x 1.2 x 12.
5. **Top platform**
   - A Slate disc 14 in diameter and 0.8 thick.
   - Railing: 16-24 balusters (Cylinder 0.4 diameter, 2.5 tall) at radius 6.4.
   - Leave a 3-baluster gap where the stairs arrive.
   - Rail: 10-12 short Blocks as chords on top of the balusters.
6. **Access**
   - The spawn must be reachable, so add a spiral stair.
   - Treads: Block 4 x 0.6 x 1.8 at radius (shaft radius + 2.4).
   - Rise 1.0-1.2 per tread with a yaw step of 20 degrees (18 treads per turn), from the plinth top to the platform.
   - Use one "Tread" prototype with placements at increasing `at` height and `yaw`.
7. **SpawnLocation**
   - Size [6, 1, 6] Block. Never rotate it.
   - Centred, with its bottom flush on the platform top (centre y = top + 0.5).
   - Anchored true, CanCollide true. Neutral stays true by default.
   - It must not overlap the railing or capital.

## Moving an existing spawn
- When asked to move the spawn, prefer `scene_update` on the existing SpawnLocation:
  - Read Position and Size with scene_inspect.
  - Set them in one update with exact expected values.
- Creating a second SpawnLocation makes spawning random between them. If one is created anyway, say so explicitly, because deletion is not exposed.

## Integration with surroundings
- Leave a clearing of 20-30 studs radius around the plinth.
- Lead a terrain path (Pebble/Cobblestone, 6-8 wide) to the stair foot.
- Blend a Ground/Mud ring around the plinth base.
- Add a few mossy rocks and flowers at the base.
- Never let foliage intersect the plinth or stair.

## Finish
- Keep exact-dimension structure (plinths, columns, stairs, spawn) as primitive parts. Dress it with real assets: `studio_asset_search` + `studio_asset_insert` for props (lamps, statues, vases, benches, ivy); `studio_asset_generate` kind mesh for a carved hero ornament and kind material for bespoke stone applied to the parts. Check with `studio_viewport_capture`.
- Realistic scale, weathering and lighting moods: `arcane-photoreal`. Torches, lamps and glow: `arcane-vfx`.

## Verify
- Check the receipt instance count against the plan.
- Inspect only the keyed spawn: confirm its Position y equals platform top + 0.5 and its Orientation is [0,0,0].
