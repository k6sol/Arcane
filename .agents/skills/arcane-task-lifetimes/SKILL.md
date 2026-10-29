---
name: arcane-task-lifetimes
description: "Fix Arcane work accounting, cancellation, normal retirement and shutdown races across tasks, providers and assets."
---

# Arcane task lifetimes

Trace the original owner, signal, request and resource before changing status logic. Register work before allocation/first await and retain its actual allocation, publication, persistence and cleanup tails.

Separate ordinary request failure from physical/owned cleanup failure. Preserve the first actual cleanup fault including null, undefined, false or zero. Classify intentional interruption only through original provenance, never copied error codes/messages or revoked state alone.

Normal retirement must not abort accepted work. Explicit Stop must still escalate the same original lifecycle without self-joining, double cancellation or dropping late work. Unknown ACK/custody/worker outcomes remain held; an empty map, timeout, Edit mode or reconstructed IDs are not closure proof.

Use held-operation schedules to prove ordering, not timing guesses. Cover reentrant callbacks, late allocation/publication, persistence failures, exact identity, unrelated tasks and repeated cached close. Do not increase caps or release pins to hide a leak.
