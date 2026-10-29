# Arcane working context

At the start of Arcane work, read `docs/vault/Home.md`,
`docs/vault/Operations/Current State.md` and
`docs/vault/Operations/Next Session.md`. Read the linked goal, architecture and
skill notes relevant to the task, rather than loading the entire vault. The
developer skills are discoverable in `.agents/skills/arcane-*`; load the relevant
`SKILL.md` for delivery, chat, assets, lifetimes, release or knowledge work.

The vault preserves context; Git, current source and actual runtime evidence
remain authoritative. Revalidate revisions, live jobs and installed versions.
Distinguish proposed work, implemented work, controlled tests, packaged smoke
and actual customer/native acceptance. Never infer completion from a note.

Keep reusable shared knowledge in `docs/vault`; keep executable skill sources
in `skills/arcane`. Update the current-state and next-session notes after a
meaningful verified milestone. Record decisions with reasons and evidence.
Use `docs/vault/Delivery/Goal Board.md` to choose and track work. Mark acceptance
items complete with evidence; check off a whole goal only when every criterion
passes. Reopen goals when a regression contradicts acceptance.
Never put credentials, private keys, raw personal conversations or machine-local
operational receipts in the shared vault. Preserve attribution and licenses.

The Obsidian vault is a projection of committed notes and existing skill sources.
Use `scripts/sync-obsidian-vault.py` with an explicit revision and vault path;
check first, then apply. A local-note conflict must be reviewed and merged,
never overwritten. Do not change personal `.obsidian` settings.

Preserve other contributors' work, use concise SSH-signed commits and validate
changes at their actual scope. Current user scope is Arcane; do not work on
ArchLiquid or operate Roblox Studio without a subsequent explicit instruction.
