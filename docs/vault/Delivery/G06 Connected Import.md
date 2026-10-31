---
type: goal
project: Arcane
tags: [arcane]
---
# Complete connected import and scene editing

Status: **In progress**. Priority: P0.

Deliver: approved mesh, texture and PBR artifacts map correctly into the intended project through the modular Arcane plugin; transforms/materials/collision survive conversion; later revisions update the same mapping. Explicit authorized deletion works with accurate scope and recovery.

Done when: actual source → conversion → payload → plugin receipts retain exact identities, units and material mappings in controlled acceptance fixtures; wrong asset types and unsupported conversions fail clearly. Placement alone must not be described as uploaded or registered in Asset Manager. Real upload/Studio rendering remains a separate unverified acceptance item.

Depends on: 4 and 5. Owner: asset/plugin integration.

## Acceptance record

- [ ] Required behavior implemented against current source.
- [ ] Each outcome above verified at its stated scope.
- [ ] Evidence and remaining limitations recorded below.
- [ ] Relevant regression checks passed for the published revision.

## Evidence

No whole-goal completion evidence recorded yet. Add actual revision/run/artifact links and distinguish controlled tests from customer/native proof.

## Next action

Resolve listed dependencies, then reproduce the missing outcome before editing.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]

## Current controlled acceptance

[[Bugs/Import Reply Recovery]] verifies a lost desktop reply after an actual stored file import. Error421 preserves uncertainty; an explicit asset-list read recovers the same record without repeating native import. All three real-browser file-import/model/effect journeys pass. This strengthens library/preview recovery, not native Studio upload or the whole connected-import goal.

[[Bugs/Studio Packet Poll Fairness]] preserves strict continuity and ownership while allowing genuine plugin I/O after the next original packet is queued. Local verification covers 57 staging/MCP/diagnostic cases, the unchanged 20 MiB PBR stage/seal/reconstruct/recover case and a 141-packet zero-idle pacing transfer. Actual Studio rendering, reviewed model import, upload/Asset Manager registration, later revisions and authorized scene deletion still require their own acceptance.
