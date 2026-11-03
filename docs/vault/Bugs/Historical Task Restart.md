---
type: bug
project: Arcane
tags: [arcane, chat, updates]
---
# Historical task restart

An idle disconnected window could refuse an update after an unknown connection failure when its task list contained a host-quarantined historical row still labelled working, despite explicit retained:false ownership. Restart treated the row's state as current activity.

The restart checkpoint now excludes an active-state row only when the current host lists its exact task identity as historical and explicitly reports retained:false. Retained owners, missing retention evidence and unquarantined active tasks still block. This does not clear any action/task/custody record, settle an unknown connection, reconnect, dispatch or skip native draft/queue acknowledgements.

The focused reproducer fails before the change with Finish or stop the current chat before restarting. After the change, strict660 compilation and all96 draft-persistence/update UI cases pass with frozen source/compiled inputs, no skips or cancellations. The new case saves the exact draft without a POST and checks that retained:true, omitted retention and an unquarantined row each still refuse. A test fixture initially attempted to mutate readonly recovery metadata; replacing the whole fixture object resolves the strict compilation error. This is controlled UI/state and actual Edge update verification, not installed customer acceptance.

[[Bugs/Draft Storage Recovery]] - [[Delivery/G03 Persistent Sessions]] - [[Operations/Next Session]]
