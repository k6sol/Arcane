---
name: arcane-world-building
description: "Create coherent playable Roblox worlds with terrain and modular content, meaningful destinations, traversal, environmental storytelling and measured streaming/performance."
license: MIT
---

# World building organized around play

## Define a connected world
Read the existing place and intended core loop. Map spawn/onboarding, destinations, challenges, rewards, recovery and return routes at the scale the request needs. For a full game, these spaces must support the real gameplay states; for one room or biome, complete that area without inventing an unrelated campaign.

Choose movement envelope, player camera, landmark hierarchy, world boundary and target-device budget before mass placement. Block and traverse the main route early. Give each district/room/biome an identity through function, large forms, palette and recurring details, while sharing a coherent art direction. Alternate constrained/open spaces, reveal landmarks deliberately and provide orientation at decision points.

## Build a reusable content system
Define module dimensions, grid/connection rules, floor and doorway heights, pivots, material scale, collision and gameplay sockets. Test a corner, transition, elevation change and repeated run before producing a kit. Keep a placement seed/manifest and original editable sources. A random rotation of one prop is not a diverse content family.

Author finished models, UVs, textures and PBR in Blender using a faithful supported recipe or permitted native route. Inspect previews and exact-model human review before the advertised import flow. Toolbox/free assets require an express request. Primitive architecture/blockouts can serve their requested purpose but cannot silently replace a requested realistic finish.

Use terrain_generate for requested landforms, routes, water and clearing transitions; environment_apply serves supported lighting/atmosphere and simple fills. Batch repeated placement with scene_build templates/prototypes and appropriate scatter. Wild growth benefits from clustering and variable spacing; farms, avenues or formal gardens can intentionally use rows. Keep ordered structures aligned instead of randomizing load-bearing parts.

## Connect art to functionality
Reserve interaction, combat, vehicle, camera and NPC navigation clearance before small dressing. Route and objective markers must agree with actual gameplay locations. Avoid visually promising doors, climbable ledges, collectibles or safe areas that have no corresponding behavior unless intentionally decorative and legible as such.

Copy continuous routes into every scatter layer's avoidPaths with full widths. Derive footprintRadius from conservative template extents and check placed/requested counts. Separate gameplay collision from render detail and preserve existing content outside the authorized area. Use the current receipt/Undo mechanism correctly; an ambiguous mutation is inspected, never replayed automatically.

## Acceptance
Traverse the complete critical loop from the actual spawn to objective and return/recovery path, including elevation changes, doors, water edges and boundaries. Inspect landmark readability at player height, clipping, floating props, material repetition, dark choke points and blocked camera views. Check a representative dense state rather than an empty overview.

Test advertised streaming and distant representations in engine: naming an object LOD does not implement switching. Measure frame cost, visible instances/materials/transparency and loading behavior on representative devices; record conditions and unresolved bottlenecks. Placed session-only mesh/image resources do not prove Play/reopen persistence. Distinguish a composed world, a traversed world and a fully functioning game, and state which is demonstrated.
