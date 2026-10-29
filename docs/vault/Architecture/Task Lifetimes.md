---
type: reference
project: Arcane
tags: [arcane]
---
# Task lifetimes

Task status, original request completion, worker closure, resource cleanup and human acceptance are separate facts.

Register original work before allocation or its first asynchronous effect. Join allocation, publication, persistence and original cleanup tails. Normal retirement fences new work while allowing accepted work to finish; explicit Stop must still cancel the original owned work. Preserve exact first failures, including falsy thrown values, without confusing normal interrupted requests with failed cleanup.

Unknown acknowledgement, worker ownership or physical closure remains retained and must not trigger replay. Genuine completed work can release bookkeeping only under its actual ownership and capacity rules. JSON state or copied IDs cannot reconstruct a live capability. Human review and later Keep/import decisions must remain independently available where supported.

[[Delivery/G04 Task Lifetimes]] · [[Delivery/G07 Test and Repair]] · [[Development Skills/arcane-task-lifetimes/SKILL]]
