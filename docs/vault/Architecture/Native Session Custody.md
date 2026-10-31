---
type: architecture
project: Arcane
tags: [arcane, chat, lifetimes]
---
# Native session custody

`apps/daemon/src/native-session-custody.ts` records native connection lifetime evidence in the existing project action database. Journal version5 adds a bounded strict table; it does not reinterpret older task or action outcomes.

## Allocation and closure

Reserve an opaque lease before invoking the original factory or reaching its first asynchronous effect. The trusted low-level lifecycle observer records each actual discovery/final allocation boundary. Only genuine no-start or completed original initialization cleanup may close a failed factory lease. A partially throwing constructor or unconfirmed cleanup remains held. Missing observation is not no-start proof.

A returned client is privately bound to its original lease and connection. Persist possible filesystem-write capability before a grant, effective writable turn, remembered grant after rotation, repair/incorporation or accepted approval. This records potential capability even if a later request is refused; it never grants permission.

Normal task retirement does not close the native process. Physical close is cached before invoking the original owner's captured close function. Only its successful completion may persist closure, and the stored connection must still match the original binding. A changed binding, failed close or failed persistence retains uncertainty. Original failures, including falsy values, remain intact. Observation persistence faults fence subsequent admission.

## Migration and evidence boundaries

Adding custody does not relabel legacy action/task outcomes; existing pending-request restart recovery remains unchanged. Do not reconstruct closed leases from terminal task labels. A pre-v5 journal containing unexpected custody metadata is refused before migration writes; a v5 journal must contain the exact custody schema. Future and invalid versions are refused. Retain the existing4096-entry bound without eviction.

Native transport closure does not prove descendant-process containment, proposal-worker closure, Studio import custody, Blender job closure or human acceptance. Those resource journals and limits remain independent. This implementation records future evidence; it does not resolve the customer's retained historical tasks or admit a fresh recovery session by itself.

Controlled verification uses actual SQLite reopen, local stdio fixtures, held original closures, persistence refusals, connection-binding changes and migration checks. Exact results belong in [[Operations/Current State]]. Authenticated customer and Studio acceptance remain separate.

[[Architecture/Task Lifetimes]] · [[Architecture/Chat and Sessions]] · [[Delivery/G04 Task Lifetimes]]
