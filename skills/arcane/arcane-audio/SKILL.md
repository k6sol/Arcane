---
name: arcane-audio
description: "Build realistic Roblox audio: layered positional ambience (wind, birds, water), roll-off, SoundGroups for mixing, per-area reverb, footstep/interaction scripts, music with ducking and performance budgets, using only real sound ids."
license: MIT
---

# Audio: ambience, mixing, reverb, music

## Rules first
- Sound ids: ONLY `rbxassetid://<digits>` the user gave, already in the place, or returned by `studio_asset_search` with `category: "Audio"` (free results; check name and `durationSeconds`). Never invent, guess or "remember" an id; URLs and file paths are refused. No id for a layer? Build the emitter without SoundId and tell the user which sound to supply.
- Arcane creates audio directly. In ONE `scene_build`: a Folder group `Audio`, SoundGroup items, emitter parts (Transparency 1, CanCollide false, CastShadow false, small Size), then Sound items with `in` (part, Attachment or group key) and `fx`, then *SoundEffect items inside a Sound or SoundGroup. Single additions: `scene_create` with `fx`.
- Classes: Sound, SoundGroup, ReverbSoundEffect, EqualizerSoundEffect, EchoSoundEffect, ChorusSoundEffect, CompressorSoundEffect, DistortionSoundEffect. Every value is verified; `receipt_restore` removes the build.
- Sound fx: SoundId, Volume 0..10, PlaybackSpeed 0.1..4, Looped, Playing, RollOffMode (Inverse, Linear, LinearSquare, InverseTapered), RollOffMinDistance/RollOffMaxDistance (min <= max), TimePosition, SoundGroup = key of an earlier SoundGroup item.
- Keep `Playing` false in Edit. Looped ambience starts from a script at runtime (or `Playing: true` only when the user wants autoplay on start).
- Placement decides behaviour: a Sound in a BasePart or Attachment is 3D positional; a Sound in a Model/Folder plays everywhere (music, UI, global beds).
- World settings: `environment_apply` `soundService: {AmbientReverb, DistanceFactor (3.33 = 1 m), DopplerScale, RolloffScale}` (Workspace grant).

## Mix bus layout (SoundGroups)
| SoundGroup | Volume | Contents |
|---|---|---|
| Ambience | 0.6 | wind, birds, water, room tone |
| SFX | 0.9 | footsteps, doors, pickups, impacts |
| Music | 0.4 | score; ducked under events |
| UI | 0.7 | clicks, notifications (non-positional) |
Put one CompressorSoundEffect (Threshold -18, Ratio 3, Attack 0.01, Release 0.25) on SFX to tame stacking. Settings sliders change SoundGroup.Volume, never each Sound.

## Ambience layering (positional)
Build three layers, each a Looped Sound in its own emitter, never one stereo loop for the whole map:
| Layer | Host | Volume | RollOffMode | Min-Max studs | Notes |
|---|---|---|---|---|---|
| Wind bed | group (global) | 0.25 | - | - | soft, Looped; a second gust loop at 0.15 for exposed areas |
| Birds | 3-6 tree-canopy Attachments | 0.35 | InverseTapered | 15-120 | different ids or PlaybackSpeed 0.9-1.1 per emitter |
| River/stream | 3-5 parts along the bank, ~40 studs apart | 0.5 | InverseTapered | 10-90 | overlap so walking along it never drops out |
| Waterfall | part at the plunge pool | 0.9 | Inverse | 20-250 | EqualizerSoundEffect LowGain 3 for weight |
| Fire/torch | flame Attachment | 0.45 | InverseTapered | 6-45 | pairs with arcane-vfx emitters |
| Indoor room tone | room part | 0.15 | Linear | 5-30 | quiet hum so silence never feels broken |
Roll-off rules: Min = where the source sounds full (its physical size); Max = where it should vanish (stay under 300). InverseTapered is the natural default; Linear for room tones that must end at walls.

## Reverb per area
- Global character: `soundService.AmbientReverb` (Forest, City, Mountains, Plain; Cave for caves).
- Distinct spaces: a SoundGroup per area (`CaveSFX`) with ReverbSoundEffect, and a client script that moves the local player's footstep/voice Sounds into that group when they enter a zone part.
  - Cave: DecayTime 3.5, Density 1, Diffusion 1, DryLevel 0, WetLevel -4.
  - Hall: DecayTime 2, DryLevel 0, WetLevel -8. Small room: DecayTime 0.6, WetLevel -12.
- Echo for canyons only: EchoSoundEffect Delay 0.35, Feedback 0.3, WetLevel -10.

## Footsteps and interactions (script pattern)
Server owns gameplay; the client plays what only that player needs to hear first.
- Footsteps (LocalScript in StarterPlayerScripts): on Humanoid.Running/Heartbeat, when speed > 1 and FloorMaterial changes or step interval elapses (0.32 s walk, 0.24 s run), play a pre-created Sound in the HumanoidRootPart chosen by `Humanoid.FloorMaterial` (Grass, Wood, Concrete, Metal...). Randomise PlaybackSpeed 0.92-1.08 and Volume 0.4-0.55; keep a table of 2-4 ids per material.
- Interactions: a server Script validates the ProximityPrompt/Touched action, then plays a Sound parented to the door/chest part so every player hears it positionally. Never trust a client remote to play arbitrary ids; map action names to known Sounds on the server.
- Reuse Sounds; never `Instance.new("Sound")` per step. Use `SoundService:PlayLocalSound` only for UI.
- Create scripts with `scene_create`, write them with `script_update`, then enable them with `script_read` + `script_set_enabled` once complete.

## Music with ducking
- Music Sounds live in a group (global) under the Music SoundGroup; crossfade tracks with TweenService on Volume over 2-3 s, never hard cuts.
- Ducking: when a dialogue, cutscene or boss cue starts, tween `Music.Volume` 0.4 -> 0.12 over 0.3 s, restore over 1.5 s afterwards (client side). Ambience may dip to 0.4 too.
- Combat/explore states: two looped stems at TimePosition sync; crossfade between them instead of restarting.

## Performance budgets
- <= 10 simultaneously audible looping Sounds per area; <= 40 Sound instances placed for ambience in a whole map.
- RollOffMaxDistance <= 300 for loops; distant sources fade out instead of mixing in.
- Pool one-shots; stop and clean up Sounds on destroyed objects.
- Long music: one track playing at a time; load the next only before crossfade.

## Verify
Read back the receipt counts; check each emitter's parent (positional vs global). Ask the user to listen in Play: levels per group, no clipping when everything overlaps, roll-off edges, reverb in each zone, music ducks and recovers. Visual mood belongs to `arcane-photoreal`; scenery to `arcane-natural-scenes`.
