---
name: arcane-vfx
description: "Design readable Roblox effects for actual gameplay cues or atmosphere, with controlled particle/beam/trail construction, event timing, cleanup and measured overlap cost."
license: MIT
---

# Effects that communicate and stay within budget

## Specify the effect contract
Identify the source, audience, trigger, spatial range and meaning: anticipation, impact, success, damage, travel, environmental motion or ambience. Match colour, shape and timing to the art direction. A full game needs its important state changes to read; a small asset edit does not require an effect suite.

Keep gameplay authority separate from presentation. Server-accepted actions determine hits, damage and rewards. Clients can present the validated cue, but a particle collision, animation marker or arbitrary remote payload cannot grant damage. Give every transient a start, stop, interruption and owner-cleanup path.

## Construct through supported tools
With the actual scene.effects capability, use scene_build for fixtures plus effects: invisible non-colliding hosts, Attachment items, then supported effect className with in and fx. scene_create serves a single addition. Build Beam/Trail attachment endpoints first and reference the actual keys/refs. Read the current schema rather than inventing properties or classes.

NumberSequence, colour sequences and ranges must use the tool's bounded formats. Textures come from supported built-ins, the existing project or the user; do not invent asset IDs or fetch free textures without an express request. Built-ins such as fire_main.dds, smoke_main.dds and sparkles_main.dds under rbxasset://textures/particles/ can provide simple cues when accepted by the current tool. No fitting image means an honest simpler effect or a stated missing resource, not an invented texture.

Use a layered effect only when the event needs it. A fire may combine a compact core, sparse embers and slower smoke; an impact may need one short directional burst; a pickup may need a brief glint plus GUI feedback. Start and end opacity/size intentionally, vary rotation where useful and keep additive stacking from erasing shape. Flames shrink; smoke usually expands and dissipates. Orient directional bursts to actual impact normals and attach trails to the moving source, enabling them only during the relevant phase.

The existing declared [recipes](references/recipes.md) reference supplies fuller fire/waterfall/burst examples. Read it only for the needed effect and treat its numbers as starting targets, not universal quality or engine limits.

## Concrete values and starting recipes
In `fx`, NumberRange is a scalar or `[min,max]`; NumberSequence is a scalar, even list or `[[t,value,envelope?],...]`; ColorSequence is a colour, even colour list or `[[t,"#hex"],...]`. Vectors are arrays; enum values use names. `Attachment0`/`Attachment1` use earlier item keys in `scene_build`, actual Attachment refs in `scene_create`. PointLight/SpotLight illuminate; Highlight marks a target and needs a clear selection lifecycle.

These small-emitter settings are adaptation starts in studs/seconds, not validated visuals or engine caps. The existing `arcane-vfx:recipes` supplies full builds.
| Layer | Rate; Lifetime; Speed | Shape response |
|---|---|---|
| Fire core | 40; [0.6,1.1]; [3,5] | fire_main.dds; Size [1.6,1.2,0.2], LightEmission 1, SpreadAngle [8,8], Drag 1 |
| Embers | 8; [1.5,2.5]; [4,8] | fire_sparks_main.dds; Size [0.12,0], spread [25,25], Drag 1.5 |
| Smoke | 6; [4,6]; [1.5,3] | smoke_main.dds; Size [1.5,6], fade in/out, LightInfluence 1 |
| Impact sparks | 0; [0.15,0.4]; [12,22] | fire_sparks_main.dds; Size [0.12,0], Drag 4, orient to hit; Emit 15 initially |
| Magic aura / dust motes | 4; [2,4]; [0.2,0.6] | sparkles_main.dds; Size [0.15,0], subtle opacity; match source volume |

Use `explosion01_smoke_main.dds` for suitable burst smoke, not an invented image. `ZOffset` can separate layered sprites, but inspect depth ordering from multiple views. For optional post-processing, coordinate `environment_apply` with arcane-photoreal rather than globally brightening a focused effect.

## Runtime and budgets
Create static hosts/effects directly; scripts handle bursts, timing, distance gating and flicker. Use script_update with exact baselines, script_read, then script_set_enabled through the supported review path. Set burst Rate to 0 and call :Emit(count) from the accepted event; do not run continuous emission for single hits. Reuse or pool effect instances for repeated events. For a sustained emitter, estimate live particles as rate times maximum lifetime, then include overlapping emitters and bursts. Measure transparent screen coverage, light/shadow cost and the busiest expected view, especially on phones.

Disable emission before delayed disposal; cancel owned tasks/listeners when the source, round or character ends. Bound concurrent effects and choose graceful culling without hiding essential warnings. Reduced flashes, shake and particle density must retain an equivalent important cue.

## Acceptance
An Edit viewport can check placement, lights and endpoints, not animated particle behavior. Use playtest_request for a supported human-approved runtime scenario and actual playtest_status observations for motion and cleanup; captures are review context, not attested gameplay proof. Observe trigger-to-effect timing, direction, travel attachment, overlapping bursts, pause/interrupt and respawn/despawn. Measure the agreed worst-case cost and verify effects actually stop with no continuing tasks. Report missing media, untested states and observed limitations; more particles or permanent bloom is not evidence of polish.
