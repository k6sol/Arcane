---
name: arcane-racing-kit
description: "Prescriptive racing genre kit: track building, ordered checkpoints and laps, vehicle setup basics, countdown, timing, best-lap saves and leaderboards, with build order, tuning numbers, budgets and playtest plan."
license: MIT
---

# Racing: handling, courses and a complete race flow

First establish the requested vehicle style, camera, player count and competition: kart circuit, rally, time trial, arcade checkpoint run or another actual brief. Inspect existing vehicles and tracks before replacing them. For a complete racing game, one working lap is the handling milestone; delivery also needs the requested course/vehicle breadth and a usable arrive -> choose -> race -> results -> retry flow. Do not impose a universal track count or expand a small vehicle fix into a championship.

Read [patterns](references/patterns.md) (`arcane-racing-kit:patterns`) for retained configuration/checkpoint/constraint fragments. They require integration and actual driving tests, not blind insertion. Use `arcane-physics`, `arcane-rounds`, `arcane-input-camera`, `arcane-interface`, `arcane-audio` and `arcane-vfx` for the relevant portions.

## Build the race contract

Keep RaceService phases, ordered-gate timing, vehicle lifecycle, track definitions and requested saves separate. A track definition contains stable ID, grid/reset poses, checkpoint order, direction, bounds and race rules. Race/vehicle epochs prevent a delayed gate or respawn callback from advancing another run. Server time and validated order determine laps/results; client clocks and a touched finish line alone do not. Vehicle-bound eligibility must distinguish a real entrant/driver from someone walking through gates; a foot-based scenario only tests gate logic, not driving validity.

Define countdown lock/release, wrong-way handling, crashes, resets, disconnect, late join/spectator and finish grace. A reset returns the original entrant to a safe owned pose without granting skipped progress or a faster lap. Place gates at shortcut risks and check direction/plausible traversal where needed. Award a result once, with ties/DNF visible. Best times need track/rules identity and requested persistent duplicate-safe saves; keep saving off and label session-only when it is outside authorization.

## Courses and vehicles with distinct decisions

Block out a demanding corner, transition, straight and recovery area before dressing the full course. Measure road seams, clearance, banking, barriers and camera sightlines against the real kart. Course variants should alter braking, grip, overtaking, elevation or route choice, not recolor identical straights. Landmarks and coherent roadside art communicate the next turn without hiding the racing line. A full brief's content roster must be reachable through selection and finishable, not folders of unused maps.

Build original vehicles suited to the style. Custom Blender geometry uses actual authoring capabilities/workspace permission and the supported owned import path; do not substitute Toolbox unless requested. Keep physical chassis, collision, visual shell and camera purpose clear. Constraints/network ownership are established by reviewed game code where scene tools cannot create them. Tune wheel radius, torque, steering, mass and friction together from measured handling; the reference numbers are hypotheses. Do not advertise physically realistic driving from their presence.

## Presentation and acceptance

Provide course/vehicle choice where required, countdown, lap/checkpoint, position, time, speed and readable results/retry. Engine/rev/skid audio, wheel/steer animation and restrained boost/dust cues follow actual vehicle state. Use valid authorized media IDs and disclose missing ones. Support brake/reset input and camera recovery on target devices; results must not leave controls stuck.

Use actual inspection/build tools and exact script baselines; review disabled source before enabling. Request finite human-approved playtests through `playtest_request`, then follow `playtest_status` through cleanup. Check ordered gates, reverse/skip attempts, countdown, reset, last-lap finish and repeated races. Drive every delivered course, including corners/seams and off-track recovery; measure multi-car collisions/ownership and mobile handling when available. Keep single-client gate tests distinct from driving/multiplayer proof. Record frame/query/part budgets under the intended field, clean empty vehicles/effects and report unfinished courses, media or native acceptance honestly.

## Tool integration

Use scene_build for authored course geometry, checkpoint volumes and vehicle assemblies. Read the physics/input-camera guidance for the actual driving controller. Integrate VehicleSeat and HingeConstraint only as the mechanism requires; verify steering, grip, braking, reset and legal lap progression.

Use script_update for complete disabled source and script_set_enabled only through its exact syntax/review gate. Follow the `arcane-playtest-qa` script check loop: playtest_request, playtest_status and playtest_cancel retain the actual host repair/cleanup allowance. Existing requested saves use arcane-datastore-safety and the project's single writer; keep session lock, UpdateAsync and failure handling intact. Load this kit's declared patterns only when needed; its fragments are not a finished game.
