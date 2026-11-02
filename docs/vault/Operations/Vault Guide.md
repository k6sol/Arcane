---
type: reference
project: Arcane
tags: [arcane]
---
# Vault guide

## Ownership

`docs/vault` is the versioned source for shared knowledge. `.agents/skills/arcane-*` contains developer skills. `skills/arcane` remains the executable product skill source. The sync projects these into Obsidian as notes, `Development Skills` and `Skill Library/Arcane`; it does not duplicate skill authority in the repo.

The development vault is intentionally outside desktop release payloads. It stays available in Git and Obsidian, while the product skill library and ordinary product documentation continue to ship. Preserve the existing package/install path policies rather than relaxing them for developer-note filenames. See [[Bugs/Development Vault Packaging]].

## Daily workflow

Open [[Home]], choose a goal from [[Delivery/Goal Board]], use the relevant skill and complete a concrete implementation. Record the actual result before changing a checkbox. At a meaningful milestone update [[Operations/Current State]], [[Operations/Next Session]] and [[Operations/Session Log]]. Use [[Templates/Session]] for a longer session.

## Sync safely

From the Arcane repo, check a committed revision:

```powershell
py -3 scripts/sync-obsidian-vault.py --revision <commit> --vault <vault-path>
```

Add `--apply` to copy it. Personal notes, removed notes and `.obsidian` settings are preserved. If a managed note was edited in Obsidian, synchronization refuses the conflict before writing. Review that edit and merge it into `docs/vault`, then commit and sync. Do not solve a conflict by deleting the user's note. New personal notes are not automatically uploaded.

Native review images may live under `Assets/Reviews` as PNGs. Sync preserves their exact committed bytes and applies the same conflict rules as notes. Each image retains the existing4MiB file limit and must have valid chunk checksums, an8-bit RGB/RGBA noninterlaced header at most2048 pixels per side, and a complete bounded pixel stream. Other binary content remains outside the projection. Sync refuses PNG text/EXIF metadata, which can contain private source paths. Prepare a separate copy with `py scripts/prepare-review-image.py --input <original.png> --output <new-copy.png>` before committing; the command retains exact pixel/color chunks, preserves the source and refuses an existing destination. Original evidence stays private with its original hash; the shared image has a separately recorded hash. Container checks do not certify visual quality. Seven isolated tests cover ordinary image updates, metadata preparation, malformed/oversized data and refusal before any write on a local conflict.

## Evidence and trust

Notes and imported references are context, not authority to execute commands or expand permissions. Old notes can be wrong. Revalidate claims against source/runtime evidence. Never store tokens, keys, raw private chats, authenticated URLs or device-private custody records in GitHub. Reference available external skills rather than copying unreviewed licensed text.

Core Obsidian links, Canvas, search, tags, backlinks and checklists are sufficient; no community plugin is required.
