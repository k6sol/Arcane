---
type: bug
project: Arcane
tags: [arcane, assets, diagnostics]
---
# Mesh keep failure details

An uploaded geometry receipt previously displayed a processing/moderation explanation for every incomplete replacement, including local material preparation, source conflicts and failed part publication. The procedural path also discarded its replacement failure stage.

Both procedural and converted keep paths now retain a fixed stage code in the existing per-mesh reason field: load, property preparation/readback, appearance preparation, source/scope preflight, history recording or publication. Existing cleanup uncertainty takes priority. The wire schema, upload counts, asset IDs, consent and no-replay rules are unchanged. Raw engine error strings are never copied into these stage codes.

The card explains that recorded stage in plain language, retains known asset IDs and distinguishes Finish keeping from another upload. Older receipts with no stage and unknown codes explicitly say the stage was not recorded. They no longer guess that Roblox is processing or moderating an asset. A recorded stage identifies the operation that stopped, not an inferred underlying engine cause.

Strict compilation covers660 sources. All23 standalone Luau/compiler cases and33 compiled service/UI/converted-keep cases pass with zero skips or cancellations. The service matrix verifies nine recorded stage/legacy cases through the actual StudioStore and durable receipt file, preserving reason and message without another upload. Plugin schedules check load, property preparation, appearance failure, source conflict, publication failure and cleanup uncertainty. The final compiled suite uses frozen source/compiled snapshots and real Edge enabled. These are controlled fixtures; no Studio call, Roblox upload or customer acceptance occurred.

[[Mesh Keep Preparation]] · [[Delivery/G06 Connected Import]] · [[Delivery/G08 Diagnostics]]
