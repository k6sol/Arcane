---
name: arcane-procedural-generation
description: "Author reproducible Roblox layouts, assets and encounters with meaningful variation, bounded generation, validated topology and traceable source-to-engine integration."
license: MIT
---

# Generate controlled variation, not repetition

## Define the grammar and its invariants
Identify what varies and what must remain playable: connectivity, objective order, clearance, collision, fairness, pacing, budget and excluded combinations. Design modules and transition rules around real player decisions. Changing random seeds or tinting copies does not by itself produce different courses, encounters or scenes.

Separate layout, encounter, asset-shape, surface and cosmetic seeds so one local change does not unexpectedly reshuffle the whole world. Retain generator version, normalized configuration and source/result identity for reproduction. Server authority owns rewarding layouts and outcomes; client cosmetic variation cannot claim progress or rewards.

## Build in useful scales
Generate macro structure first: regions, route graph, focal landmarks and traversal. Then assign challenge/encounter rhythms and medium-scale modules. Finish surfaces, local vegetation/clutter, motion and sound only where they support that structure. Natural placement needs spatial fields, believable grouping, paths/clearings and multiple scales, not concentric rings or uniform random noise.

Original mesh assets still require actual Blender geometry, UVs, material/PBR authoring, export, review and import. Use an existing bounded recipe only if it faithfully represents the requested object. A recipe name or returned plan is not generated geometry. Do not turn a failed generator or missing template into a silent primitive scene; report the exact failed stage and keep the completion register honest.

Constrain generation before expensive work. Use a bounded attempt budget and a deliberately valid fallback layout that still meets the brief; if no such result exists, retain the seed/configuration and report failure. A lower-quality asset substitute is not a valid fallback for an original-finished-art requirement. Do not regenerate underneath active players without an explicit transition and ownership plan.

## Validate and select actual results
Check graph reachability, spawn/objective separation, collision, slopes/clearance, overlap, resource/content budgets and encounter legality. For assets, inspect topology, silhouette, scale, UV density/seams and texture-to-geometry detail before engine placement. Validate multiple ordinary and difficult seeds, extreme dimensions and player counts. Keep failing seeds as regressions; a reviewed sample does not prove every possible seed.

For full games, curate enough validated outcomes to support the promised content breadth. Review meaningful differences in routes, decisions and environment identity, not just screenshots of differently colored copies. Ensure deterministic reset/rejoin/replay behavior and cleanup of rejected or superseded candidates. Preserve actual source/job/import/test evidence; pending or unknown native work is not reusable or complete merely because the UI stopped moving.
