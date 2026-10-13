# Native Codex browser sign-in sidecar — 2026-10-13

Arcane's existing `providerSetup.login('codex')` now uses the discovered native Codex executable and its official app-server ChatGPT browser login RPC. It sends no prompt, thread, inference, model request, sign-out, API-key login, external tokens, install command, or application-owned token exchange. Claude Code retains its existing official CLI login and visible terminal handoff.

## Contract for main, renderer, and packaging owners

- Package **`apps/desktop/electron/provider-login.cjs`** alongside `provider-setup.cjs`. The host directly requires this helper only after the user confirms Codex login. Import, factory construction, and `enabled: false` verification mode have no native effects.
- The enumerable host API and renderer bridge stay version 1: `status`, `login`, `install`, `launch`. Responses retain exactly `version`, `provider`, `installed`, `auth`, `cliVersion`, `busy`, `message`. No OAuth URL, state, login ID, email, callback URI, raw native response, or credential enters these responses.
- A successful browser launch returns `auth: 'unknown'`, `busy: true`, and a message asking the user to finish ChatGPT sign-in. Poll `status('codex')` while pending. Polling returns the current bounded flow without starting new probes. Other setup actions return busy while it runs.
- The final RPC outcome is delivered once by `status('codex')`, with `busy: false`. A later explicit status refresh uses the existing native CLI status validator. Opening a browser or receiving `account/updated` does not establish sign-in.
- Main gets two non-enumerable, trusted owner hooks: **`cancelPending()`** for project/context switches and **`dispose()`** for app shutdown. Do not expose them as renderer-controlled native capabilities. Dispose also prevents future provider actions. Both cancel only the owned pending login and immediately stop its owned native process.
- The helper independently observes the original window's `closed`, and its webContents' `destroyed`, `render-process-gone`, `will-navigate`, and main-frame `did-start-navigation`. It also checks the trusted window/origin/project scope every 100 ms and at asynchronous process/browser boundaries. Owner hooks avoid relying on the timer during shutdown or a brief switch.
- Keep the existing main-frame IPC origin/owner and preload response validators. No main/preload, renderer, packaging, or artifact-list file is changed by this sidecar task.

## Native sequence and bounds

The host uses the existing canonical native executable discovery, project-exclusion checks, safe paths, scrubbed environment, and strict bounded version validator. It rechecks the executable and home working directory before spawn.

The owned child runs `codex app-server --listen stdio://`, with `apps`, `plugins`, `remote_plugin`, and `skill_mcp_dependency_install` disabled. Those native flags are already present in the recorded native evaluation's supported launch configuration. No shell, terminal, websocket, shared daemon/proxy, or inherited provider/Arcane token/proxy/runtime injection is used for this route.

The private newline-delimited stdio client performs:

1. `initialize` with stable client name `arcane_provider_login`, followed by `initialized`. Its returned user-agent must match that client name and the independently verified CLI version.
2. `account/read` with `refreshToken: false`. A recognized existing ChatGPT account returns its native authentication status and stops the child without starting login. API/cloud or unknown authentication never selects another route or overwrites that account.
3. Only a native signed-out account proceeds to `account/login/start` with exactly `{ type: 'chatgpt' }`.
4. The start ACK must contain the ChatGPT response variant and a UUID login ID. The URL must satisfy the allowlist before trusted main-process `shell.openExternal` opens it.
5. A matching `account/login/completed` with boolean `success: true` and `error: null` must be followed by a new recognized ChatGPT `account/read` ACK. Only then does the flow return `auth: 'subscription'`. The existing enum describes native ChatGPT authentication; it does not prove paid-plan entitlement, model access, quota, or a completed inference request.

RPC deadlines reuse the existing 8-second host timeout, configurable by trusted code up to 15 seconds. Browser waiting expires after 180 seconds, configurable up to 300 seconds. Native stdout has a 128 KiB total and 32 KiB partial-frame bound; stderr is discarded with a 16 KiB bound. Malformed frames, wrong IDs, native errors, output overflow, context loss, and expiry stop the flow. Browser opening also races process cancellation, so a stuck `openExternal` promise cannot leave the IPC login request waiting indefinitely.

Cleanup sends `account/login/cancel` only with the ID acknowledged by this owned child. Ordinary cleanup allows at most 250 ms for the ACK, then kills the child; owner navigation/close hooks kill immediately after the cancel request. If login/start has no trustworthy ACK, cleanup kills the child without guessing a cancellation ID. Timers and data/lifecycle listeners are cleared. Arcane does not retry ambiguous native outcomes.

## Browser boundary and exact fallback

Only `https://auth.openai.com/oauth/authorize` is accepted. Credentials in the authority, alternate ports/origins/paths, fragments, controls, backslashes, oversized URLs, and duplicate parameters are refused. The URL must use authorization-code flow, OpenID scope, opaque bounded state, and S256 PKCE. Its canonical HTTP redirect must use `localhost`, `127.0.0.1`, or `[::1]`, an explicit valid port, and exactly `/auth/callback`, without credentials, query, or fragment. The redirect is trusted only as the acknowledged callback of the owned native RPC; Arcane opens no callback listener and never fetches the callback or intercepts credentials. Unknown future vendor URL variants fail closed and need review.

Only an explicit JSON-RPC method-not-found (`-32601`) ACK before any acknowledged login establishes an unsupported browser capability. On Windows the host offers a second Cancel-default dialog explaining the limitation. If the user chooses **Open terminal**, the existing checked system PowerShell launcher opens a visible terminal at the native home directory and runs exactly the checked `codex.exe login` command. It reports sign-in as unverified and asks the user to finish there and check status. Other platforms give the exact manual `codex login` instruction. Unknown process outcomes, malformed URLs, issuer/version mismatches, or native errors do not automatically attempt terminal login, API billing, device-code login, or another browser route.

## Sources and existing evidence

The official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) documents initialize/initialized, ChatGPT login/start, the app-server-owned local callback, login/completed, account/read, and login cancellation. The official [Codex authentication documentation](https://learn.chatgpt.com/docs/auth) describes browser-based native sign-in and the local callback.

Primary implementation inspection also checked OpenAI's native [account processor](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/account_processor.rs), which sets `open_browser: false` for app-server browser login, and native [login server](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs), which constructs the pinned issuer/authorization endpoint and hosts the callback. These source inspections establish the implementation pattern, not successful live acceptance of every future native build.

Existing local evidence, read without starting any new native command:

- `runtime/verification/skill-evaluation-eight-turns-20261013/native-command.json`: native version `0.162.0-alpha.17.2` and supported stdio app-server transport.
- That directory's `preflight.json`: acknowledged initialize and account/read; native ChatGPT authentication with plan `prolite`; `turnsDispatched: 0` in the discovery preflight. The surrounding evaluation is historical evidence and is not rerun or expanded here.
- That directory's generated protocol bindings: `LoginAccountParams`, `LoginAccountResponse`, `AccountLoginCompletedNotification`, `GetAccountParams`, `GetAccountResponse`, `Account`, `PlanType`, and cancel-login types. They are not edited.

## Verification and live acceptance

Run only the scoped fake-process suites:

```text
node --test tests/release/provider-setup-host.test.mjs tests/release/provider-login-browser.test.mjs
```

Fixtures cover native initialization/account/login/cancel ACKs, browser calls, cached native sign-in, malformed URLs/redirects/PKCE/state, wrong RPC/login IDs, failed/duplicate/early completions, split UTF-8 frames, process/stream errors, output bounds, expiry, hanging browser calls, cancellation without an ACK, owner navigation/close/dispose, context revocation, duplicate actions, environment scrubbing, and exact unsupported-capability PowerShell fallback. Every fixture asserts the permitted RPC method set and **inference count 0**. Existing host discovery/path/public-auth/Claude/verification-mode tests remain in place.

Final scoped result: **54 tests passed, 0 failed** (29 existing host tests and 25 browser/host integration tests). No live native process was launched by these fixtures.

The unowned `provider-setup-ipc.test.mjs` successful-login case still expects Codex PowerShell login at line 527 and does not supply the new helper's fake stdio seam. Its owner must adapt that case; the sidecar does not edit it. Packaging/static-artifact owners must include the new helper file.

**Live acceptance is pending a human browser login.** This task does not start a real login, sign out an existing account, read/write authentication files, install software, spend a new inference turn, rerun the eight-turn evaluation, access Studio, run a full build, or perform Git operations. Existing signed-in native accounts continue through native status checks without a new login ceremony.
