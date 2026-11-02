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
