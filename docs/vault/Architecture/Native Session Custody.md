---
type: architecture
project: Arcane
tags: [arcane, chat, lifetimes]
---
# Native session custody

`apps/daemon/src/native-session-custody.ts` records native connection lifetime evidence in the existing project action database. Journal version5 adds a bounded strict lease table. Version6 adds exact allocated-request and reused-turn mappings, without reinterpreting older task or action outcomes.

## Allocation and closure

Reserve an opaque lease before invoking the original factory or reaching its first asynchronous effect. The trusted low-level lifecycle observer records each actual discovery/final allocation boundary. Only genuine no-start or completed original initialization cleanup may close a failed factory lease. A partially throwing constructor or unconfirmed cleanup remains held. Missing observation is not no-start proof.

A returned client is privately bound to its original lease and connection. Persist possible filesystem-write capability before a grant, effective writable turn, remembered grant after rotation, repair/incorporation or accepted approval. This records potential capability even if a later request is refused; it never grants permission.

Journal storage failures use the stable `JOURNAL_FAILURE` category and retain their original cause. Keep the first custody fault separately from the primary action refusal; fencing/cleanup must not mask that action error. A later admission refusal must not replace the original custody fault. Shutdown still exposes an independently failed closure-save tail, even after the external database lock is released.

Normal task retirement does not close the native process. Physical close is cached before invoking the original owner's captured close function. Only its successful completion may persist closure, and the stored connection must still match the original binding. A changed binding, failed close or failed persistence retains uncertainty. Original failures, including falsy values, remain intact. Observation persistence faults fence subsequent admission.

## Migration and evidence boundaries

Adding custody does not relabel legacy action/task outcomes; existing pending-request restart recovery remains unchanged. Do not reconstruct closed leases from terminal task labels. A pre-v5 journal containing unexpected custody metadata is refused before migration writes; a v5 journal must contain the exact custody schema. Future and invalid versions are refused. Retain the existing4096-entry bound without eviction.

Native transport closure does not prove descendant-process containment, proposal-worker closure, Studio import custody, Blender job closure or human acceptance. Those resource journals and limits remain independent.

## Independent chat recovery

At service startup, `native-recovery-quarantine.ts` seals original action and task payload fingerprints. It groups exact native lease, connection and allocated/reused request identities, retains unresolved resource charges, and blocks continuation of their old threads. Historical records stay inspectable and are never replayed, relabelled or treated as closed from a terminal task status.

A fresh human connection, new thread and Send use new native/task ownership and the normal explicit write and asset permissions. Existing same-project task concurrency already permits independent owners; recovery does not add an exclusive filesystem writer rule or require a host reboot. Earlier staging and write-ceiling research was an additional restriction, not the existing product contract.

Recovery applies a conservative128 native-owner admission ceiling, separately from the coordinator's existing128 task-owner bound and the4096-row journal retention limits. Original unresolved charges cannot be released from later metadata. Fresh closed leases cease charging their own resources only after original physical closure is persisted. Request mappings prevent the first turn's reuse of its connected client from being counted as a separate unknown allocation.

Proposal-worker closure is persisted separately in task journal version5, independently from native journal version6. Original factory invocation, captured worker close and durable closure marking remain separate facts. Historical unclosed proposal IDs reserve the existing two-worker proposal budget; that debt does not prevent ordinary fresh chat. SDK import and Blender custody retain their own checks.

Controlled verification uses actual SQLite reopen, local stdio fixtures, held original closures, persistence refusals, connection-binding changes and migration checks. Exact results belong in [[Operations/Current State]]. Authenticated customer and Studio acceptance remain separate.

## Recovery research, not implementation

A general supported Windows per-boot identity has not been established. A sealed challenge with a trusted monotonic counter decrease may provide a narrower one-time process-lifetime barrier, but same-host provenance, counter semantics and actual restart validation remain unresolved. Do not use wall-clock changes or guessed boot identifiers as closure evidence, and do not treat a host restart as settlement of remote effects. See [Microsoft counter semantics](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps) and [system-information API limits](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntquerysysteminformation). This research grants no recovery authority or permission to restart the machine.

[[Architecture/Task Lifetimes]] · [[Architecture/Chat and Sessions]] · [[Delivery/G04 Task Lifetimes]]
