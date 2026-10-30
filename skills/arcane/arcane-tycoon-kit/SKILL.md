---
name: arcane-tycoon-kit
description: "Prescriptive tycoon genre kit: plot claiming, droppers, conveyors, collectors, ordered purchase buttons, upgrades, rebirth and session-locked DataStore saves, with build order, balancing numbers, budgets and playtest plan."
license: MIT
---

# Tycoon: a visible production system with meaningful expansion

Choose the fantasy and decision loop: build a factory, run a restaurant, develop a workshop or another requested business. A complete tycoon needs useful spending choices, readable production and a satisfying built-out state; a free dropper feeding one button is only a first milestone. Preserve the scope of an existing purchase/plot repair and do not add rebirth or commerce by reflex.

Read [patterns](references/patterns.md) (`arcane-tycoon-kit:patterns`) for retained plot/purchase/dropper fragments. Use `arcane-economy`, `arcane-datastore-safety`, `arcane-remote-security`, `arcane-interface`, `arcane-physics`, `arcane-vfx` and `arcane-audio` as needed. The sample numbers and record layout are starting hypotheses, not a complete durable system.

## A plot and purchase contract

Separate PlotService ownership, production scheduling, purchase/unlock graph, profile state and client presentation. Claim exactly one eligible plot per player and handle simultaneous claims. A failed profile load must not create a default plot that later overwrites real progress. Release/reset only the original owner's managed plot after required save/cleanup, preserving unrelated authored content and another claimant's current ownership.

Use stable buyable IDs, prerequisites and prices from server definitions. Validate owner, active plot epoch, availability, affordability and duplicate claim before mutation. The visible purchase should match its real world change and new income/capacity. A hidden button is not sufficient authorization: forged remote/touch paths must still fail. Record requested persistent purchases/rebirths under a duplicate-safe profile protocol; in-memory busy flags do not survive a crash.

## Production and content that evolve

Plan a dependency graph with capacity, throughput, efficiency, routing or service-quality choices. At least the choices promised by the brief should change operation, not merely replace a small colored box with a larger one. Later areas can introduce another material/recipe, bottleneck or workflow; cosmetic construction should visibly develop the fantasy without gating every useful action behind decoration. Do not impose a fixed number of plots, droppers or minutes on every project.

Lay out readable input -> processing -> output flow with service access, collector ownership and safe player circulation. Original themed machinery/buildings need consistent scale, silhouette, material and signage; use real custom authoring only when capabilities and workspace grants permit it, and no Toolbox by default. Prototype the actual conveyor/production behavior before decorating it. Each drop is credited once to the correct plot; old drops/upgraders cannot pay the next occupant. Cap transient drops/effects and schedule production centrally rather than cloning a script into every object.

## Information and feedback

Show cash, useful income/capacity, actual price/prerequisites and purchase refusal. Confirmation for destructive reset explains what survives. Production animation and sound communicate throughput/jams; upgrade effects follow confirmed state. Add a clear claim route, first affordable action and build-out/replay path. Keep essential controls readable on target devices and avoid constant coin bursts obscuring the plot. Requested saves stay off until authorized, and unavailable media/persistence is disclosed rather than represented as finished.

## Acceptance

Build using actual scoped scene/script tools, review exact disabled source, and request separate human-approved finite playtests. Follow status through cleanup. Test claim -> free production -> collection -> paid purchase -> visible output change, then later prerequisite branches and requested reset. Attempt another player's button, insufficient funds, duplicate collector touch, rapid rebirth, leave/reclaim and old-drop arrival. Compare actual balance/ownership, GUI and world state. Measure intended full-plot load, not only the initial free machine; requested save/rejoin and simultaneous multi-client claims need their own evidence. Report any unfinished branch rather than calling a starter production loop the whole game.

## Tool integration

Use scene_build for plots, production machines and collector/purchase surfaces; model the original machinery before final placement. Bind the actual plot epoch to script_update logic and interface state. Test income, prerequisite branches and old drops against the current owner.

Use script_update for complete disabled source and script_set_enabled only through its exact syntax/review gate. Follow the `arcane-playtest-qa` script check loop: playtest_request, playtest_status and playtest_cancel retain the actual host repair/cleanup allowance. Existing requested saves use arcane-datastore-safety and the project's single writer; keep session lock, UpdateAsync and failure handling intact. Load this kit's declared patterns only when needed; its fragments are not a finished game.
