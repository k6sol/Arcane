---
name: arcane-safe-edits
description: "Apply and restore bounded Luau or scene changes while preserving concurrent manual work; use for live mutations and reimports."
license: MIT
---

# Conflict-safe Studio edits

## Bound the change
Read current editor content and relevant conventions. Capture exact base text or typed property values, session identity and the user's permitted scope. Produce a reviewable diff with dependency-aware partial acceptance. A previous approval does not authorize a different place or an expanded task.

For source commits, check the baseline again inside the supported editor update callback. Keep the callback deterministic: no logging side effects, remote calls or unrelated edits. If the adapter cannot enforce this check, expose the weaker guarantee and use an appropriate reviewed fallback.

For scene batches, validate the plan first, then retain each actual operation's receipt. History recordings group changes but do not make an external multi-file batch atomic. Resolve unknown outcomes before retries.

## Restore carefully
Compare current state to the recorded after-state. Restore matching owned operations; report conflicts without resetting unrelated work. New session handles and lost writer leases invalidate old commands.

## Verification
Simulate an open-buffer manual edit, a partial batch failure, duplicate delivery and a later unrelated edit. Preserve both proposal and manual source. Never call a timed-out mutation definitely failed without reconciliation.
