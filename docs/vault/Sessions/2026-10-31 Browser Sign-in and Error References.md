---
type: session
project: Arcane
tags: [arcane, chat, diagnostics]
---
# Browser sign-in and error references

## Required outcome

Connect Codex opens the supported ChatGPT sign-in flow rather than Settings. Reuse a genuinely verified saved account, retain it when a new login is cancelled, and distinguish successful authentication from a blocked workspace connection. Errors must not move the page. Show stable numbers and explanations, with correlation IDs under Technical details.

## Implementation

The primary Connect action now invokes the existing native login bridge. Only a validated subscription result may request metadata connection. The original provider, connection and workspace revisions are rechecked across waits, including switching away and back. No thread or model turn is created by login.

The shared browser catalogue supplies references for login, connection, recovery, model stages, import and preview failures. Recovery notices sit outside the scrolling page layout; their action buttons remain available while their explanations and technical evidence are collapsed. Login messages have reserved space. Failed tool rows show their actual safe cause with an error number and a separate technical disclosure.

## Recovery boundary

The installed runtime remains `4472706` until a subsequent installation is independently verified. The customer workspace retains one old unbound connection failure and three persisted tasks with unknown outcomes. Account login is independent of those records, but successful login does not settle them or establish a usable native workspace.

Startup marks interrupted tasks unknown without replay. Their original in-memory owners cannot be reconstructed after restart. Turn completion is not physical process closure; individual worker exits and Studio connection custody do not prove complete native task closure. Keep the original records and admission guards intact. A future historical-notice review change needs a backend unresolved-task admission barrier before relaxing its UI guard.

## Verification

Strict compilation verifies all652 product sources. The frozen focused run retains379 passes and one onboarding geometry assertion; its corrected four-case companion then passes without changing production files, target requirements or deadlines. The companion waits for the actual entrance animation and loaded fonts before measuring the final controls. Hash comparison proves every compiled desktop production file matches the frozen build. Four-width Edge checks prove that showing and expanding the recovery notice, or receiving a login failure, leaves the sign-in button bounds unchanged. Desktop and narrow screenshots were inspected.

The earlier broad run retains807 passes, nine failures and one skipped check, including complete frontend required-file packaging coverage. Obsolete error-text/action-count assertions and a busy-paint-versus-dispatch race were corrected; recovery actions remain outside the collapsed explanation. One original browser page-load timeout has no established cause and is retained; a later isolated check does not explain it. Final focused checks include that permission surface and preserve its original timing and authorization assertions.

Hosted/package delivery is pending for this source. Controlled browser/native-protocol fixtures are not authenticated customer acceptance or a Studio test. The three legacy unknown tasks remain unresolved.

[[Architecture/Error References]] · [[Delivery/G02 Reliable Chat]] · [[Delivery/G08 Diagnostics]] · [[Operations/Next Session]]
