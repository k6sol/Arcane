---
name: arcane-knowledge
description: "Maintain Arcane Obsidian context, developer skills, decisions and evidence-backed goals across work sessions."
---

# Arcane knowledge

Obsidian is the single source of truth for Arcane project context, requirements, decisions and goals; docs/vault is its versioned shared mirror. Start from Home, Current State, Next Session and the active goal, not the entire vault. Review local vault edits before syncing. Reconcile notes against current source/runtime evidence rather than carrying contradictory status forward. Put reusable project knowledge in shared notes and keep device-private receipts, credentials and raw private conversations outside Git.

For each milestone record changed behavior, exact revision, verification scope, unresolved issue and next action. Record new user requirements promptly and preserve earlier scope. Update a goal's acceptance items with evidence; check the full goal off only when all pass. Reopen it when a regression contradicts acceptance. Use the templates for meaningful decisions, bugs and sessions rather than logging every command. Consolidate Next Session when superseded instructions accumulate, retaining the earlier note in a clearly labelled archive.

Keep executable product skills in skills/arcane and developer skills in .agents/skills. Preserve their references, license and actual experimental/approval status. Validate meaningful skill behavior; do not imply that adding instructions trains a model.

Sync an explicit committed revision with scripts/sync-obsidian-vault.py. Check before apply. Merge local Obsidian edits back into shared source after review; never overwrite conflicts or publish personal notes automatically. Keep Current State and Next Session short enough to be useful on resume.
