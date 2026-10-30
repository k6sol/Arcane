---
name: arcane-simulator-kit
description: "Prescriptive simulator genre kit: collect-sell-upgrade loop, capped backpack, currency-gated zones, pets and eggs basics, rebirth and session-locked saves, with build order, balancing numbers, budgets and playtest plan."
license: MIT
---

# Collection simulator: satisfying activity and worthwhile choices

Use this kit for a collection/progression simulator when that is the actual brief. A vehicle, flight or physical simulation is not automatically a collect-sell game. Define what the player does, why the activity is satisfying and which decisions change efficiency, risk or access. A full game needs varied usable content and later goals, not an empty exponential counter; a small bag or tool fix should not add pets, eggs or rebirth.

Read [patterns](references/patterns.md) (`arcane-simulator-kit:patterns`) for retained collect/sell/zone/pet fragments. Coordinate `arcane-economy`, `arcane-inventory`, `arcane-gameplay-feel`, `arcane-interface`, `arcane-remote-security` and requested `arcane-datastore-safety`. Optional pets use actual `arcane-characters:pets` guidance; do not make them a mandatory genre feature.

## The real server loop

Separate node/activity definitions, authoritative collection, capacity, selling, upgrade eligibility and progression. The client supplies input intent only. Validate live node/actor, zone access, distance, rate, equipped tool and available capacity before granting. Repeated hits on a depleted node cannot pay again; respawn callbacks belong to the node/zone epoch so an unloaded area does not resurrect old objects. Locked-zone collision visuals are convenience, never server reward authority.

Give each upgrade a useful effect: capacity changes return trips, reach changes positioning, a tool opens a different activity, or a zone changes hazards/resource behavior. Show those trade-offs before buying. Define full-bag, interruption, simultaneous collection, selling once and rebirth/reset consequences. Requested persistence loads before economy effects and preserves failed profiles. Pet ownership, rarity, equipment limits and bonus calculation live on the server; follower visuals cannot mint bonuses. Paid/random mechanics require separate actual policy/commerce review, never invented IDs or client rolls.

## Content and locations with purpose

Block out one complete gather -> return -> sell -> informed upgrade -> changed activity cycle, then extend it to the requested breadth. Areas should change traversal, tool use, objectives, resource timing or a meaningful choice, not merely gate the same sphere behind a higher price. Set a content roster appropriate to the brief rather than fixed zone/node counts. Ensure later unlocks and optional activities are actually reachable through the normal economy.

Create coherent original tools, resource silhouettes, hub/shop landmarks and region art. Natural scenes are conditional, not a universal forest substitute. Genuine custom Blender assets require actual authoring capabilities and workspace permission; use the supported owned integration path and disclose unsupported features. No Toolbox unless requested. Keep nodes readable at action distance and avoid scenery hiding the interactable surface.

## Feel, GUI and acceptance

Tool windup/contact/recovery, resource reaction, pickup sound and bag feedback should reflect actual accepted collection. Coordinate real rig/animation/audio/VFX assets; missing IDs are gaps. The HUD shows capacity, currency and useful next objective; upgrades explain benefit, affordability and prerequisite. Provide full-bag/rejected-action feedback, target-device controls and an intentional return path. Pet/hatch presentation must remain bounded and not block core input or imply a grant before the server result.

Use actual scene/script tools and reviewed disabled source, then separately approved finite playtests with status/cleanup. Verify collection, full capacity, sell, upgrade effect and a later activity under real progression. Exercise locked-zone/remote spam, double depletion, duplicate selling, failed load and reset. Compare time-to-unlock calculations with observed travel/action time; example price curves are not evidence. Check full intended node/pet/effect load and cleanup on zone/character changes. Distinguish single-client plumbing, actual gameplay, requested save/rejoin and untested randomness/multiplayer rather than calling a clickable hub finished.
