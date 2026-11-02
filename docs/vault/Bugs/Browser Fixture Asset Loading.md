---
type: bug
project: Arcane
tags: [arcane, browser, fixtures, verification]
---
# Browser fixture asset loading

Original meter-source2815329 Windows release job125549822818 failed while loading the synthetic key-controls page: the original20-second navigation deadline expired before DOMContentLoaded/load, with39 requests started,31 finished and eight pending JavaScript responses. The pending URLs were compiled production modules, not a key Show/Copy operation. No failed request was reported. The precise hosted filesystem/scheduler cause remains unproven; the original failure was not retried.

The fixture now reads its exact public HTML/CSS/fonts and compiled desktop modules into private in-memory maps before opening Edge. HTTP handlers serve those fixed bytes and perform no lazy source reads. The actual production module graph, synthetic key routes, native-bridge double, trusted input checks, privacy assertions, original20-second navigation and six-second control deadlines remain. Dynamic key/API responses are not cached. This isolates the key interaction checks from lazy fixture file loading; it is not proof that production HTTP startup performance is fixed.

All eight frozen key-control browser cases pass with strict660 compilation, no skips/cancellations and unchanged source/compiled hashes. The full-module graph still exercises masked mount, trusted Show/Copy, legacy preload, generation/storage failures and close/project/pagehide privacy. Hosted validation of this new fixture still remains to observe.

[[Bugs/Windows Native Worker Query]] ? [[Bugs/Browser Key Action Evidence]] ? [[Operations/Next Session]]
