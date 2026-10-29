---
type: reference
project: Arcane
tags: [arcane]
---
# Chat and sessions

The desktop owns conversation presentation and durable drafts. Provider adapters own their native request/turn semantics. The daemon coordinates project-scoped work and receipts.

For a chat bug, trace human submission → local durable state → original request → acknowledgement → stream/history → displayed message. Capture identifiers only as evidence; copied IDs do not recreate original authority. Distinguish a failed request from an uncertain dispatch and from a failed physical shutdown.

Provider/model changes should preserve the shared conversation through supported adapters without resending the entire chat unnecessarily. Reopening an old chat must not manufacture a fresh acknowledgement or silently replay a turn. Automatic developer permissions follow the user's selected project policy.

[[Delivery/G02 Reliable Chat]] · [[Delivery/G03 Persistent Sessions]] · [[Development Skills/arcane-chat-reliability/SKILL]]
