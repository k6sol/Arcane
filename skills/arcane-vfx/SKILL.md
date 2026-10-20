---
name: arcane-vfx
description: "Design, author and refine layered Roblox visual effects with original particle textures, timed bursts, portable previews and cancellable client playback. Use for impacts, spells, smoke, fire, portals, trails and ambient effects."
license: MIT
---

# Arcane VFX

Build an effect around its visible purpose: the action it communicates, focal shape, timing, world scale and intended viewing distance. Match the user's references and style. Use available local tools; this skill works without Arcane or a particular MCP server.

## Author and compare

Separate anticipation, impact and recovery when they help the action read. Give each layer a job: shape, direction, light, residue or breakup. Offset their timing and lifetime; avoid an undifferentiated flash hiding the subject. For a realistic effect, work from observable motion and material behavior before adding glow.

For portable particle effects, author a JSON spec using [the format](references/effect-format.md). Run `python scripts/effect.py validate SPEC`, then `python scripts/effect.py build SPEC --out NEW_DIRECTORY` from this skill folder. Paths are ordinary local files; resolve them against this folder when working elsewhere. The build produces original seeded texture atlases, data for a client runtime, a scrub preview and a build report. It does not call any external service.

Open the actual generated preview. Scrub onset, peak and tail, inspect from multiple angles and check light and dark backgrounds. Revise the shape or timing responsible for a visible defect. Compare variants with the same seed, view and time. The preview approximates particle motion and blending; it is not a capture of Roblox playback.

For custom mesh effects, use Blender when available: model the silhouette, create useful UV flow for the intended distortion, inspect normals and seams, and export only owned effect objects. Procedural mesh and texture helpers are starting materials, not evidence that the result meets the reference. Do not substitute toolbox assets or external art unless the user requested them.

## Deliver through the available host

Read [Roblox playback](references/roblox-playback.md) for the generated runtime, native emitters, beams and trails. Keep cosmetic effects client-side; gameplay outcomes remain server-authoritative. Supply texture IDs only after an authorized upload, and preserve asset ownership. A preview approval does not grant unrelated publishing permission.

If Arcane is available, inspect its current tool inventory and use the matching asset, script, review and playtest tools. Do not invent tool names or assume that a local file path is an uploaded Roblox asset. Outside Arcane, deliver the same files and clear placement instructions through the user's existing Studio workflow.

Keep effect duration, tails and live-particle cost finite. Every runtime effect needs idempotent cancellation that destroys only its own objects and disconnects its own work. Validate overlapping effects, interrupted effects, lowest intended graphics quality and actual camera distance before claiming native acceptance. Report the failed stage and cause if generation, upload or playback fails; retain enough evidence to reproduce it.
