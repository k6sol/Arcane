---
name: arcane-obby-kit
description: "Prescriptive obby genre kit: stage design rules, difficulty curve, checkpoints, kill bricks, moving platforms, Stage leaderboard, saved progress and skip-stage product stubs, with build order, budgets and playtest plan."
license: MIT
---

# Obby: fair movement challenges with a finished route

Identify the actual movement style, audience, avatar/controller assumptions and intended challenge. Precision, exploration, speedrunning and cooperative platforming need different pacing. A short repair preserves existing stages; a complete obby request needs a connected taught -> varied -> combined challenge sequence, meaningful checkpoints, a finish and replay/recovery. A starter walkway plus a stage counter is an early test, not a finished game.

Use [patterns](references/patterns.md) (`arcane-obby-kit:patterns`) as retained server/checkpoint/mover/save fragments. They need lifecycle ownership and real movement checks. Relevant companions are `arcane-level-design`, `arcane-physics`, `arcane-input-camera`, `arcane-interface`, `arcane-gameplay-feel` and `arcane-datastore-safety` when saving is requested.

## Stage design before decoration

Give each stage a readable movement idea, safe observation point, reachable goal and recovery route. Teach a mechanic, vary its timing/space, then combine it with something already learned. Distinct locations should change play and orientation, not just hue. Use coherent themed geometry, landmarks, hazards and sound cues; do not force a forest or default horror lighting. Budget the requested route breadth and review every playable branch, including optional shortcuts if present.

Calibrate gaps, rises, beams, ceilings and mover timing against the actual avatar and control settings, not universal jump-distance claims. Show the landing and next goal from the player's camera; avoid untelegraphed kill volumes and camera-blocking decoration. Breathers/checkpoints follow challenge cost and retry time rather than a fixed every-N rule. Stable movers need measured rider behavior under latency and low frame rates; setting a velocity in a snippet does not prove that an anchored platform carries players correctly.

## Authoritative progress and recovery

Separate StageService, hazards, mover ownership, presentation and optional profile storage. Stable stage IDs and validated progression order prevent a random touch from skipping the course. One initial spawn plus owned checkpoint respawn avoids competing SpawnLocations. Character/round epochs protect delayed respawns and hazard debounce cleanup from a replacement character. Define restart, death during transit, reaching the final checkpoint and switching routes without granting twice.

Load requested saved progress before enabling dependent play; never write defaults over a failed profile. Clamp/validate recovered stage references when content changes. Keep skip-stage commerce absent/inactive unless requested with real product IDs and a completed durable receipt path. A stub/comment is not paid functionality; client SkipStage intent cannot change progress.

## Make effort and achievement legible

The HUD shows actual stage/section and a clear checkpoint confirmation; finish state offers replay/continue/exit appropriate to the brief. Use landing/checkpoint cues, moving-platform motion, restrained hazard effects and a consistent safe/danger language with symbol/text alternatives. Respect touch targets, focus and camera visibility on narrow screens. Actual animation/audio assets need availability and permission; do not invent IDs or call a silent placeholder polished.

## Acceptance through the real course

Inspect parents/build in scoped batches, write exact-baseline disabled scripts and enable only after review. Use finite separately approved playtests and read actual status through owned stop/restoration. Verify first action, ordinary checkpoint, death/retry, moving/timed obstacle, final completion and repeat/reset. Try out-of-order/duplicate touches and respawn during a mover cycle. Walkway attribute assertions prove checkpoint plumbing only; do not alter a challenge to manufacture a test pass. Report manual movement, multiplayer and requested save/rejoin cases that remain untested. Measure mover/connection/part costs and ensure unloading/restarting does not accumulate callbacks.

## Tool integration

Use scene_build for the actual checkpoint route, moving-platform assemblies and hazard hosts. Measure jumps with the real controller before dressing them. Bind stage progress, death and respawn to the same run identity; one checkpoint attribute cannot prove route reachability.

Use script_update for complete disabled source and script_set_enabled only through its exact syntax/review gate. Follow the `arcane-playtest-qa` script check loop: playtest_request, playtest_status and playtest_cancel retain the actual host repair/cleanup allowance. Existing requested saves use arcane-datastore-safety and the project's single writer; keep session lock, UpdateAsync and failure handling intact. Load this kit's declared patterns only when needed; its fragments are not a finished game.
