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

Journal storage failures use the stable `JOURNAL_FAILURE` category and retain their original cause. Keep the first custody fault separately from the primary action refusal; fencing/cleanup must not mask that action error. A later admission refusal must not replace the original custody fault. Shutdown still exposes an independently failed closure-save tail, even after the external database lock is released.

Normal task retirement does not close the native process. Physical close is cached before invoking the original owner's captured close function. Only its successful completion may persist closure, and the stored connection must still match the original binding. A changed binding, failed close or failed persistence retains uncertainty. Original failures, including falsy values, remain intact. Observation persistence faults fence subsequent admission.

## Migration and evidence boundaries

Adding custody does not relabel legacy action/task outcomes; existing pending-request restart recovery remains unchanged. Do not reconstruct closed leases from terminal task labels. A pre-v5 journal containing unexpected custody metadata is refused before migration writes; a v5 journal must contain the exact custody schema. Future and invalid versions are refused. Retain the existing4096-entry bound without eviction.

Native transport closure does not prove descendant-process containment, proposal-worker closure, Studio import custody, Blender job closure or human acceptance. Those resource journals and limits remain independent. This implementation records future evidence; it does not resolve the customer's retained historical tasks or admit a fresh recovery session by itself.

Controlled verification uses actual SQLite reopen, local stdio fixtures, held original closures, persistence refusals, connection-binding changes and migration checks. Exact results belong in [[Operations/Current State]]. Authenticated customer and Studio acceptance remain separate.

## Recovery research, not implementation

A general supported Windows per-boot identity has not been established. A sealed challenge with a trusted monotonic counter decrease may provide a narrower one-time process-lifetime barrier, but same-host provenance, counter semantics and actual restart validation remain unresolved. Do not use wall-clock changes or guessed boot identifiers as closure evidence, and do not treat a host restart as settlement of remote effects. See [Microsoft counter semantics](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps) and [system-information API limits](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntquerysysteminformation). This research grants no recovery authority or permission to restart the machine.

[[Architecture/Task Lifetimes]] · [[Architecture/Chat and Sessions]] · [[Delivery/G04 Task Lifetimes]]
