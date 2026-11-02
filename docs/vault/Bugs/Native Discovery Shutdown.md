---
type: bug
project: Arcane
tags: [arcane, native, connection, shutdown]
---
# Native discovery shutdown

After the verified2d update actually reopened, the original connect was rejected with PROCESS_EXIT_UNCONFIRMED. The sign-in page displayed generic Error499. This proves unconfirmed native cleanup, not expired credentials, and does not establish which factory phase failed. The original request and custody remain retained; it was not retried.

The client previously terminated the secret-free discovery process immediately after reading its MCP inventory. A new unconfigured/idle close path ends stdin first, giving discovery peers their normal EOF shutdown before the existing force escalation. It is used only at the successful metadata-discovery transition. Configured threads, history peers and pending requests cannot take this path. Ordinary cancellation/error shutdown keeps its original behavior.

Both original one-second close waits and actual child-close event requirements remain. A signal, stdin EOF, parent exit or timer alone cannot certify closure. Concurrent/repeated close calls retain their original joined result. Unconfirmed older requests/custody are not released. Public Error440 now explains unconfirmed process/output closure and distinguishes it from authentication expiry.

Strict660 compilation and all245 frozen client, transport, isolation, bootstrap, custody and error-reference cases pass with no skips/cancellations. New schedules prove one EOF/no kill for cooperative discovery, actual close before success, refusal of pending requests and refusal of configured threads. Existing never-close, exit-only, forced-close and thrown-signal cases remain passing. These are controlled fixtures, not proof that the customer's startup is repaired. A separate original installed-CLI metadata check is the next verification step; do not replay the failed app request or invoke Studio/model inference.

[[Sessions/2026-11-02 Folder Context Desktop Delivery]] · [[Delivery/G02 Reliable Chat]] · [[Operations/Next Session]]

## Actual installed-CLI discovery check

A separately owned metadata-only check of the installed CLI passed after the change. It recognized the saved subscription and returned eight models. The original discovery inventory exposed zero Arcane tools, no plugin authority and no tool error. The same original child received exactly one stdin end, no kill signal, exited0 and emitted both stdout/stderr EOF and child close. Source and compiled input hashes remained unchanged. No thread, model prompt, Arcane bearer or Studio call was created. This is actual native discovery/closure evidence; final factory connection, the original retained failed request and packaged customer Send are not thereby accepted. The original failed app operation was not retried or acknowledged.

A complete factory metadata check subsequently passed too. Its original discovery and final children each received one stdin end, no kill signal, exited0 and emitted both stream EOFs and child close. Saved subscription/eight-model discovery remained available. The final profile used an unregistered synthetic local credential and no live daemon authority; no thread, turn, tool execution or Studio call occurred. Source/compiled inputs remained unchanged. The first factory observer rejected Windows-normalized executable spelling before invoking spawn; that failed harness record was retained, the path identity was checked directly, and a separate corrected observer attempt produced the native evidence. Neither completed native attempt may be replayed. Customer packaged connection/Send acceptance remains open.

## Installed f8 outcome

The matching-source package installed, passed payload verification and reopened through the stable launcher. A NEW startup connect failed with PROCESS_EXIT_UNCONFIRMED after roughly50seconds; Error440 is now shown. Earlier successful metadata-only checks did not establish customer startup acceptance. Original request/custody is retained, not reviewed or retried. The local workspace restored the exact unsent draft. Inspect this original failure before changing the lifecycle: the phase/stream cause is not established. [[Sessions/2026-11-02 Local Chat Desktop Delivery]] records scope and retained observer failure.
