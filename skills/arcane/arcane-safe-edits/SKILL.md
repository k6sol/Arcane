---
name: arcane-safe-edits
description: "Apply and restore bounded Luau or scene changes while preserving concurrent manual work; use for live mutations and reimports."
license: MIT
---

# Conflict-safe Studio edits

## Bound the change
- Stay inside the user's request, the paired session and its granted roots. An explicit in-scope request already authorizes the edits; do not ask again per part or per script. A previous approval never covers a different place or a larger task.
- Baselines come from fresh reads: `script_read` for `expectedSource`, `scene_inspect` for `scene_update` `expected` (exactly the changed keys). `script_search` excerpts are never edit baselines.
- Preserve manual work: change only what the task needs, keep the user's names, style and unrelated scripts, and never overwrite a newer editor buffer (a dirty-editor conflict is refused; re-read and redo the change on the real source).
- Prefer one atomic `scene_build` per logical layer over many small writes; it is one undo step and one receipt.

## Uncertain outcomes
- Keep every commandId and receipt. A timeout or lost acknowledgement is unknown, not failed: check `receipt_status` before anything else and never repeat a mutation automatically.
- On a conflict or refusal, read the current state and revise from it; never force or widen scope as a workaround.

## Restore carefully
- `receipt_restore` undoes one of Arcane's own succeeded mutations only while its after-state is unchanged; later manual edits make it refuse, which protects them. Terrain and lighting revert with Studio Undo.
- Delete and reparent are not exposed: name the manual Studio step instead of approximating it.

## Verification
Report each change with its receipt or verified read-back, and list anything uncertain or refused separately.
