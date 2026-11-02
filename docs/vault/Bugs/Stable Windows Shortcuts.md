---
type: bug
project: Arcane
tags: [arcane, delivery, updates]
---
# Stable Windows shortcuts

The desktop Arcane shortcut targeted the stable installed launcher, but the Start Menu shortcut still targeted an older recorded release executable. Opening that entry could run the older bundle and show the newer-project-record refusal. The installation selection itself was correct.

Local desktop installation now maintains the fixed Arcane shortcut in both Windows locations. Existing links are migrated only when they have no arguments and target the stable launcher or a release recorded by this installation. An unrelated Arcane-named link is preserved; all links are preflighted before any write. Repeated updates replace the same entries rather than adding version-named apps. The running app is not restarted by shortcut repair.

All nine focused release cases pass, including native Windows COM in owned fixture directories, repeated updates with exactly two fixed entries, legacy migration and foreign-link refusal before writes. The first native fixture exposed PowerShell's null-string conversion at File.Replace; the corrected test passes. Actual repair initially refused before writing because Windows PowerShell wrapped the decoded target array. Both original shortcut hashes were confirmed unchanged, the flat-array parser was corrected and covered, then a separately recorded repair succeeded.

Actual readback confirms the person's existing Desktop and Start Menu Arcane links now target the same stable launcher with empty arguments and the installation root as working directory. Original shortcut bytes are retained privately. The separate Design Test entry was untouched. No app was reinstalled, restarted or duplicated by this repair. The stable launcher had already been observed opening the current verified7d release. The new install-script behavior is pushed separately from the installed app; Windows shell-cache and future shortcut launches remain separate acceptance boundaries.

[[Sessions/2026-11-02 Chat Update Delivery]] · [[Delivery/G03 Persistent Sessions]] · [[Delivery/G10 Customer Release]]
