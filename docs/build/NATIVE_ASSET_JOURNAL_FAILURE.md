# Native asset journal failure fencing

A failure reading or inserting an action receipt, starting its final transaction, or committing it synchronously retires native asset authority before cleanup or rollback. The owned client is detached and closed; a process-local journal fault latch refuses subsequent actions without reconnect or redispatch. Initial INSERT and BEGIN are within protected paths. A failed rollback cannot bypass retirement. Pending/uncertain receipts are retained; no automatic repair or retry occurs.

Regression fixtures use actual SQLite write locks and the real service/registry, with an explicit fake provider. They cover revoke-assets, disconnect, turn-interrupt, revoke-writes, a lock acquired after dispatch, and configured thread metadata whose final receipt cannot commit. Each checks old actors and fresh credential captures are refused before the failed action settles. No installed provider or Studio acceptance is claimed.

An owned SQLite trigger also rejects the receipt UPDATE after staged native-history insertion. The transaction rolls that binding back, authority retires, and the original pending receipt remains retained without replay. This is an actual SQLite transaction refusal, not a fabricated DB result.

Current parent verification: full 145-source private compile passed; all 390 affected native asset, session/transport, HTTP/SDK and UI checks passed with zero skips in runtime/verification/native-assets-final-IFsWsT/verification.json. This includes all seven actual SQLite fault cases. Root compilation and deterministic plugin packaging also passed; no installed provider or Studio run occurred.
