---
type: bug
project: Arcane
tags: [arcane, chat, persistence, recovery]
---
# Draft storage recovery

[[../Sessions/2026-11-01 Native Draft Recovery|Native verification follow-up]] now exercises actual Windows encryption and production IPC in a separate sandboxed Electron window. Exact retained bytes and encrypted roundtrip pass with no customer profile access. This adds native crypto evidence; installed customer acceptance remains open.

The privacy-safe, read-only Windows diagnostic uses Arcane's app identity and a private copy of its encrypted key context. Shared history and Claude preferences decrypt; the older workspace draft record does not. Every original file remains byte-for-byte unchanged and no decrypted content is logged. This narrows the record-specific failure, while the diagnostic Electron version/profile remains separate from loaded customer acceptance.

An explicit **Save open drafts** action now recovers presentation storage. The host pins the existing unreadable record and first retains its exact bytes in a content-addressed sibling file. Only after verifying that retained copy does the existing atomic encrypted save replace the active checkpoint with the window's current drafts. Readable records, foreign owners, missing encryption, locks and conflicting or redirected retained copies are refused. Failed encryption leaves the original and retained copy intact. Ordinary reads/saves never invoke recovery automatically. Previous unreadable drafts are retained, not claimed to have been decrypted or restored.

The controller restores its exact current draft identity only after a confirmed checkpoint. Edits during recovery are saved afterwards. A lost recovery reply triggers one read-only exact-checkpoint inspection; it never repeats the recovery write, adopts another project/draft or submits a message. Existing native approvals, ownership and shared history guards remain unchanged. The action explains that nothing was sent; Send still requires a separate gesture.

Strict compilation covers 660 sources. All 61 offline host/preload cases pass, including actual production host validation with an explicitly labelled AES-GCM encryption test double. All 150 final compiled/browser cases pass with zero skips/cancellations and frozen inputs: actual controller recovery, lost replies, retained text, edits during saving, shared draft ownership and nearby four-width error geometry. All 37 fixture native connections close; no live Studio calls occur. These are controlled results. Installed e813 remains open and unchanged; customer recovery and successful Send remain unverified until the exact-source package is delivered and exercised.
