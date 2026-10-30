---
name: arcane-safe-edits
description: "Plan, apply and recover scoped Roblox source and scene changes with exact baselines, dependency-aware activation and preservation of concurrent manual work."
license: MIT
---

# Make coherent changes without losing existing work

## Define the edit boundary
Use the user's requested behavior and the exact session/root grants to identify changed artifacts and invariants to preserve. An in-scope request authorizes its ordinary edits; do not add a conversational approval for each part. New publication, data migration or a different place remains a separate operation.

Read full current script source with `script_read`; search excerpts are discovery, not a replacement baseline. For `scene_update`, capture the actual values of exactly the properties being changed. Dirty editor buffers and concurrent changes are conflicts to reconcile, not reasons to force a write. Preserve names, interfaces, content and manual adjustments outside the task.

## Stage a complete dependency slice
Order the change so dependencies exist before consumers activate: shared definitions and contracts, authoritative system, client presentation, then entrypoints. New scripts start disabled. Supply complete implementations through `script_update`, inspect returned advisories, and use the actual `script_set_enabled` source/enabled baselines and pinned syntax gate. A compiler refusal must be fixed, never bypassed through another execution route.

Use `scene_build` for a supported coherent scene layer and single-object tools for isolated changes. A batch receipt covers that command, not an atomic transaction across scripts, assets and later commands. Keep a small operation ledger of command IDs, outcomes and dependencies so partial completion is recoverable. Give UI, animation, effects and audio their real supported instances and connections when the feature needs them; source that names nonexistent assets is incomplete.

## Reconcile before repeating
A timeout or lost acknowledgement is unknown. Use `receipt_status` for the original command and read the affected state when needed; do not resend a mutation automatically. For a refused/conflicting edit, re-read and construct the smallest compatible change. If an old dependency was replaced, reassess its callers rather than restoring an obsolete full file.

`receipt_restore` applies only to eligible succeeded mutations whose after-state is unchanged. Terrain and lighting use Studio Undo. `scene_delete` is available for requested deletions, but deletion/reset uses its actual Undo behavior, not a promise of receipt restoration. Do not turn a local cleanup into a Workspace reset. Reparenting or unsupported changes need a supported operation or a precise manual step.

## Close the edit with evidence
Read back changed interfaces/critical properties, then test the actual feature path under `arcane-playtest-qa` where permitted. Check repeated use, interruption and cleanup when ownership changed. Syntax success, a receipt and a screenshot establish different facts; none alone proves a playable system. Report applied, refused and uncertain parts distinctly, with the next concrete acceptance step.
