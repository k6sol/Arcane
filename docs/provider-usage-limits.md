# Provider usage limits

Arcane reads Codex account usage through the supported native App Server interface. This is account metadata, separate from the exact thread token counters and from monetary charges. The selected model and effort stay explicit.

## Native client surface

The desktop's Advanced settings contain an Account usage disclosure beside the native account details. It shows the last provider observation, actual window percentages, reported reset times and classified limit reasons. Refresh usage makes one human-control request for the exact current native connection. It does not send the draft, select a model, grant permissions or create a lifecycle journal entry. The disclosure remains quiet in the ordinary conversation view.

`POST /v1/codex/usage` accepts only `{connectionId}` with the human control bearer, exact loopback Host and Origin, no query and a maximum 1 KiB JSON body. Agents cannot call it. Connection retirement fences an in-flight refresh. The desktop validates the returned public shape and then reads current state; it does not adopt an older refresh response over newer polling results. A failed observation does not create an uncertain chat action or retry work.

`CodexClient.readRateLimits({initiatedBy:'human'})` performs one `account/rateLimits/read` request. `Snapshot.rateLimits` contains the last accepted full read or `account/rateLimits/updated` notification. Connecting alone does not request usage or start inference.

The public observation contains at most sixteen metered buckets, their bounded display labels, reported quota windows, credit-availability flags, the provider's classified limit reason and spending-limit state. Reset timestamps are Unix seconds; `observedAt` is Arcane's local observation time in milliseconds. Percentages retain the actual finite reported value, including values above 100. Missing fields remain unknown. Account IDs, balances, reset-credit handles, banners and arbitrary provider fields are omitted.

A full read replaces the observation. Rolling updates merge available bucket metadata into the last observation. They never establish recovery from a previously blocked account; a new full read is required. A null spending-limit state means unavailable. Reaching a reported reset time does not change the observation or grant permission to send work.

## Ownership and recovery

Account-change notifications and changed account identity clear prior observations. A pending refresh cannot attach its response across an account revision. A newer rolling update also wins over an in-flight full read, whose backend sampling time is unknown. Callers receive `RATE_LIMITS_CHANGED` and retain the newer observation.

An optional usage-read timeout returns `RATE_LIMITS_TIMEOUT` at the existing request deadline. It retires only that read, preserves the active model turn and ignores the late reply. Lifecycle request deadlines and their reconciliation behavior remain unchanged. Unsupported or malformed reads do not replace the last accepted observation. There is no automatic retry.

This surface does not redeem earned resets, send emails, buy credits, change billing modes, expose a reserve fallback or authorize another model. It requests `supportsLunaReserve:false` and excludes reset-credit detail handles. Reported availability is display evidence, never a substitute for current account, task, workspace or Studio permissions.

## Verification scope

The parser and spawned synthetic JSONL peer tests cover typed bounds, sparse metadata, private-field omission, full-read/update races, account changes, unsupported methods, deadlines and late replies. They do not access installed provider credentials, run inference or contact Studio. Installed-provider and complete customer acceptance remain separate gates.

Protocol references: [official App Server account usage documentation](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt), plus the repository's generated native protocol snapshot for `RateLimitSnapshot`, `GetAccountRateLimitsResponse` and `AccountRateLimitsUpdatedNotification`.
