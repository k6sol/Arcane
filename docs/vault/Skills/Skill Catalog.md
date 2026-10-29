---
type: reference
project: Arcane
tags: [arcane]
---
# Product skill catalog

Catalogued from `7e52f67546fb5409c41dd9f2bc9376fc33c15e9c`. 62 registered skills. The existing registry says `runtimeIntegrated: false` and load policy `approved-only`; presence here does not approve or enable a skill. Read `Skill Library/registry.json` for exact metadata. Original source and references are projected without modification; the repository LICENSE accompanies the library.

## Craft

- [[Skill Library/Arcane/arcane-interface/SKILL|Game UI design system]] — Build modern, responsive Roblox ScreenGui interfaces from a design system: tokens, UICorner/UIStroke/UIGradient components, scale layouts, typography, hover/press tweens, accessible contrast and clean LocalScript modules. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-accessibility/SKILL|Accessibility and inclusive controls]] — Review Roblox readability, motion, audio cues and device interaction; improve access without changing the intended challenge. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-gameplay-feel/SKILL|Responsiveness and gameplay polish]] — Tune Roblox actions, pacing, feedback and retry flow so mechanics feel responsive and readable rather than merely functional. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-level-design/SKILL|Level layout and player decisions]] — Design Roblox spaces around traversal, sightlines, interaction reach and encounter choices, using readable blockouts before set dressing. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-art-direction/SKILL|Coherent visual direction]] — Establish and maintain a project-specific Roblox visual language, reference set and review criteria instead of generic generated aesthetics. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-blender-props/SKILL|Reference-driven Blender props]] — Author game-ready Blender props and mechanical models from references with controlled silhouette, scale, moving parts and engine validation. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-materials/SKILL|UVs, textures and engine look development]] — Create and verify Blender-to-Roblox UVs, textures and materials at the asset's actual scale and supported engine settings. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-rig-animation/SKILL|Rigs, clips and motion integration]] — Author and validate Roblox rig conversions, animation clips, grips and transitions in Blender and on the actual runtime rig. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-vfx/SKILL|VFX: particles, beams, trails and lights]] — Build Roblox VFX with exact presets: ParticleEmitter fire, smoke, sparks, magic, waterfall, dust, fireflies and leaves, plus Beams, Trails, lights and Highlight, with pooling and performance budgets. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-audio/SKILL|Audio: ambience, mixing, reverb and music]] — Build realistic Roblox audio: layered positional ambience (wind, birds, water), roll-off, SoundGroups for mixing, per-area reverb, footstep/interaction scripts, music with ducking and performance budgets, using only real sound ids. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-avatars/SKILL|Avatars and wearable integration]] — Create or integrate Roblox avatar items and cosmetics using the intended rig, fit and publication requirements; distinguish them from ordinary NPC props. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-localization/SKILL|Localization and text presentation]] — Prepare Roblox interfaces and permitted player-facing text for multiple languages with real layout, filtering and fallback checks. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-world-building/SKILL|Terrain and modular world building]] — Build coherent Roblox terrain, biomes and modular environments with landmarks, traversal and measured runtime budgets. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-architectural-features/SKILL|Architectural features and spawn pedestals]] — Build detailed Roblox architecture such as classical columns, stepped plinths, stairs and spawn pedestals with correct SpawnLocation placement, in one batch call. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-natural-scenes/SKILL|Natural scenes and forests]] — Build coherent original forests, caves and spawn landmarks with grounded foliage, continuous paths, natural scatter and visual review. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-photoreal/SKILL|Photoreal lighting, materials and scale]] — Make Roblox scenes look photoreal: Future lighting, mood presets (golden hour, foggy forest, night, horror, sci-fi) with Atmosphere and post-processing, terrain grass, MaterialVariants, SurfaceAppearance, real-world scale and imperfection rules. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-cinematics/SKILL|Playable cinematics and broadcast sequences]] — Build Roblox cutscenes, introductions and timed media with camera ownership, synchronized playback and interruption-safe gameplay transitions. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-asset-optimization/SKILL|Asset QA, collision and LODs]] — Validate and optimize Roblox-bound Blender assets for measured budgets, collision, material cost and verified LOD consumption. Status: `experimental`; approved: `false`.

## Engineering

- [[Skill Library/Arcane/arcane-studio-context/SKILL|Live Studio context]] — Inspect the intended Roblox place, selection and source before live Studio work; resolve ambiguous targets without changing the game. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-safe-edits/SKILL|Conflict-safe Studio edits]] — Apply and restore bounded Luau or scene changes while preserving concurrent manual work; use for live mutations and reimports. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-luau-architecture/SKILL|Luau architecture and scripting]] — Write production-quality typed Luau for Roblox: server/client split, ModuleScripts, server-validated remotes, cleanup ownership, CollectionService, TweenService, RunService and performance, using Arcane's disabled-until-activated script flow. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-networking/SKILL|Replication and network contracts]] — Design client-server requests, state replication and prediction for Roblox multiplayer without trusting client-owned outcomes. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-remote-security/SKILL|Networking security checklist]] — Networking security checklist: design and validate Roblox remotes, prompts, purchases, damage and rewards with server authority, type checks and rate limits; not a promise of exploit-free games. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-persistence/SKILL|Player data and migrations]] — Implement or diagnose Roblox save/load, session ownership and schema migration with explicit failure handling and protected test data. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-datastore-safety/SKILL|DataStore safety]] — Write or review Roblox DataStore code that never loses or overwrites player data: pcall with budgeted retries, UpdateAsync, session locking, BindToClose and Studio API-access awareness. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-cross-server/SKILL|Cross-server systems]] — Design Roblox matchmaking, queues, teleport handoff and transient cross-server coordination with expiry, retries and recovery. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-rounds/SKILL|Rounds and lifecycle state machines]] — Build Roblox round, team, objective and elimination flows that survive simultaneous completion, late joins and disconnects. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-gameplay-systems/SKILL|Gameplay system recipes]] — Server-authoritative recipes for common Roblox systems: rounds, checkpoints, leaderstats, shop and currency, inventory, sprint and stamina, health and damage, teams, doors and keys, NPC dialogue and pathfinding NPCs. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-inventory/SKILL|Inventory, equipment and item lifecycle]] — Build server-owned Roblox items, hotbars, equipment and consumables with consistent replicated presentation and duplication controls. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-input-camera/SKILL|Controls and camera]] — Build responsive Roblox keyboard, controller and touch input, camera and viewmodels with explicit focus and lifecycle behavior. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-physics/SKILL|Physics, vehicles and mechanisms]] — Create stable Roblox physical interactions, mechanisms and vehicles with deliberate authority, constraints and recoverable states. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-combat/SKILL|Combat and hit detection]] — Implement Roblox melee or ranged combat with readable timing, server-validated outcomes, accurate queries and counterplay. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-npc/SKILL|NPC perception and pathing]] — Build believable Roblox NPC behavior and navigation with observable perception, bounded planning and recovery when routes fail. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-performance/SKILL|Performance, streaming and resource budgets]] — Measure and improve Roblox client/server performance, streaming and resource lifecycle on representative workloads. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-debugging/SKILL|Repro-driven debugging]] — Diagnose Roblox errors and behavioral failures with scoped hypotheses, minimal patches and repeatable evidence. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-playtest-qa/SKILL|Assertion-based gameplay QA]] — Define and run Roblox feature/playflow tests and check your scripts work: real inputs, state assertions, Output errors since a cursor, at most 3 fixes and guaranteed teardown. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-characters/SKILL|NPCs and characters]] — NPCs and characters that look and behave well: R15 rigs from HumanoidDescription, default animations, AnimationController creatures, pathfinding, idle/patrol/chase/attack/flee state machines, ProximityPrompt dialogue, a pet or follower that follows the player, network ownership and server authority. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-asset-integration/SKILL|Ownership-aware assets and reimport]] — Validate and import Roblox models, textures, audio and animations while preserving ownership, stable mappings and gameplay children. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-release/SKILL|Safe release and deployment]] — Prepare Roblox releases with tested migrations, permissions, rollback boundaries and explicit publication authorization. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-social-moderation/SKILL|Social systems and player safety]] — Build Roblox parties, social interactions and user-content features with platform filtering, permissions, privacy and abuse controls. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-studio-plugins/SKILL|Roblox Studio plugin authoring]] — Build Roblox Studio tools with dock widgets, editor-aware operations, scoped connections and safe unload/update behavior. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-open-cloud/SKILL|Open Cloud services and authorization]] — Integrate Roblox cloud operations with current endpoint capabilities, minimum scopes, ownership checks and async reconciliation. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-procedural-generation/SKILL|Seeded procedural content]] — Build Roblox procedural layouts or encounters with reproducible seeds, validity constraints and meaningful controlled variation. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-trading/SKILL|Recoverable item trading]] — Design Roblox trading and gifting with explicit consent, ownership, durable recovery and no false multi-record atomicity claims. Status: `experimental`; approved: `false`.

## Platform

- [[Skill Library/Arcane/arcane-subscription-workflow/SKILL|Subscription-aware agent workflow]] — Choose a supported AI client or authorized plan connection for Arcane work while respecting subscription limits and separate API billing. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-context-budget/SKILL|Efficient evidence and context budgets]] — Reduce redundant Arcane context and tool output without losing current source, acceptance evidence or the user's requested quality. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-project-director/SKILL|End-to-end project direction]] — Coordinate a scoped Roblox feature or game slice across design, code, assets and tests with dependencies and concrete acceptance. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-quality-review/SKILL|Independent quality gates]] — Review a Roblox slice against brief, function, feel, visual coherence and device budgets using evidence rather than self-awarded scores. Status: `experimental`; approved: `false`.

## Product

- [[Skill Library/Arcane/arcane-economy/SKILL|Progression and economy design]] — Design fair Roblox progression, currencies and rewards with a measurable loop, bounded grants and recovery from duplication. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-monetization/SKILL|Purchases and monetization quality]] — Implement requested Roblox products, passes and paid benefits with verified receipts, clear value and current platform-rule checks. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-game-design/SKILL|Distinctive game design and vertical slices]] — Design Roblox core loops and scoped prototypes with meaningful player decisions and measurable play hypotheses across genres. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-analytics/SKILL|Analytics and play hypotheses]] — Design privacy-conscious Roblox funnels and event measurements that distinguish gameplay problems from unsupported retention claims. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-live-ops/SKILL|Live operations and events]] — Plan and implement Roblox seasonal events, feature flags and balance changes with compatibility, expiry and recovery. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-genre-adaptation/SKILL|Genre-specific prototypes]] — Adapt a Roblox vertical slice to its requested genre using selective design references; do not copy another game's assets or default to horror. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-onboarding/SKILL|First-session onboarding]] — Build Roblox onboarding that teaches through the real core loop, with clear first action, recovery and optional guidance. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-tycoon-kit/SKILL|Tycoon genre kit]] — Prescriptive tycoon genre kit: plot claiming, droppers, conveyors, collectors, ordered purchase buttons, upgrades, rebirth and session-locked DataStore saves, with build order, balancing numbers, budgets and playtest plan. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-obby-kit/SKILL|Obby genre kit]] — Prescriptive obby genre kit: stage design rules, difficulty curve, checkpoints, kill bricks, moving platforms, Stage leaderboard, saved progress and skip-stage product stubs, with build order, budgets and playtest plan. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-simulator-kit/SKILL|Simulator genre kit]] — Prescriptive simulator genre kit: collect-sell-upgrade loop, capped backpack, currency-gated zones, pets and eggs basics, rebirth and session-locked saves, with build order, balancing numbers, budgets and playtest plan. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-horror-kit/SKILL|Horror genre kit]] — Prescriptive horror genre kit: atmosphere and lighting moods, positional audio stingers, a stalker chase AI, jump-scare pacing, objectives and safe saves, with build order, tension numbers, budgets and playtest plan. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-arena-kit/SKILL|Round-based arena and PvP kit]] — Prescriptive round-based arena/PvP genre kit: lobby, intermission, map vote, rounds, win conditions and weapon basics with server-authoritative hit validation, plus stats saves, build order, balancing, budgets and playtest plan. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-racing-kit/SKILL|Racing genre kit]] — Prescriptive racing genre kit: track building, ordered checkpoints and laps, vehicle setup basics, countdown, timing, best-lap saves and leaderboards, with build order, tuning numbers, budgets and playtest plan. Status: `experimental`; approved: `false`.

- [[Skill Library/Arcane/arcane-rpg-kit/SKILL|RPG and adventure genre kit]] — Prescriptive RPG/adventure genre kit: quests, NPC dialogue, inventory, combat basics, XP and levels, enemy camps and session-locked saves, with build order, balancing curves, budgets and playtest plan. Status: `experimental`; approved: `false`.
