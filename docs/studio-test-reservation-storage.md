# Temporary test setup storage

The trusted test host reserves a paired session with `reserveTest(sessionId, jobId, setup)`. The returned `StudioTestReservation` is a process-local WeakMap capability. Copying its JSON, knowing the job ID, or reconnecting cannot recreate it. Existing smoke tests can omit `setup` and retain their existing string-based release path.

Setup is limited to four approved `scene.update` edits, each with an exact opaque reference, changed properties, and matching expected values. The store snapshots and validates these values against the original write grant, roots, capabilities, and fresh authenticated Edit continuity. Later calls select a sealed edit ID; the store derives command arguments and request IDs. Dispatch rechecks the original authority and fresh proof.

`cancelTestSetup(reservation)` atomically closes future setup and cancels only this original owner's undelivered setup commands. It remains available after proof or scope loss. Dispatched effects remain fenced; late proven succeeded setup receipts still permit their exact restoration. Cancellation never replays a command or clears uncertain effects.

SQLite schema 6 adds durable reservation and command-association journals. The reservation fence commits before a setup command can be delivered. Each setup or restoration command and its exact reservation, request ID, lease, and fingerprint commit together. A setup-bearing reservation fences all other project Studio commands, including generic idempotent lookups and restoration routes. Its legacy string release cannot clear this fence.

The store retains at most 64 setup reservations and 512 associated commands, with at most 64 live smoke owners and 32 KiB of approved setup arguments. Capacity is checked before new allocation, including room for each approved edit's restoration. Completed history is preserved at the bound; it is never evicted to admit another mutation. A state index keeps the recurring fence lookup bounded.

Restoration uses only a succeeded setup receipt from the same private owner. The store derives the immutable inverse from that receipt; the plugin separately checks its retained original receipt, opaque Instance, and current after-state. A matching `restored: true` receipt is required before release. Undelivered setup may instead be cancelled by its original owner. Failed, partial, dispatched, expired, or uncertain effects retain the fence when verified restoration is absent.

Daemon restart revokes old sessions and preserves the durable fence. It never reconstructs private handles, retries a setup or restoration, or treats a fresh pairing as proof that the previous editor effect disappeared. Human reconciliation is outside this API and must use trusted fresh evidence rather than a request-provided release flag. Storage restoration evidence does not establish input release, owned Play shutdown, or native customer acceptance; the controller retains those independent cleanup obligations.
