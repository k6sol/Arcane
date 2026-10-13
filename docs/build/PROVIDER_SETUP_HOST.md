# Native provider setup host

The CommonJS main-process module is `apps/desktop/electron/provider-setup.cjs`. It exposes `createProviderSetup` and has no import-time or factory-time metadata checks, provider processes, Electron access, downloads, installation, login, or inference. This slice owns only that module, `tests/release/provider-setup-host.test.mjs`, and this document. Main, preload, renderer, and IPC integration belong to the parent.

## Integration contract

```js
const { createProviderSetup } = require('./provider-setup.cjs');
const providerSetup = createProviderSetup({
  getWindow: () => window,
  getOrigin: () => origin,
  getProjectPath: () => projectPath,
  enabled: !verificationMode,
});
// Register each handler separately after the parent's exact IPC event guard.
// Pass the one enum string, never the IPC event or a renderer options object.
return providerSetup.status(provider);
```

The returned object is frozen. Its **only** methods are async `status(provider)`, `login(provider)`, `install(provider)`, and `launch(provider)`. Each accepts exactly one string, `codex` or `claude`; invalid values, object envelopes, missing arguments, and additional arguments reject with a fixed error. Parent handlers must reject additional IPC arguments themselves rather than silently discard them. Do not spread renderer input into factory options.

Every successful invocation, including cancelled, unavailable, busy, and failed outcomes, returns a fresh frozen snapshot with exactly these keys:

```ts
{
  version: 1;
  provider: 'codex' | 'claude';
  installed: boolean;
  auth: 'signed-out' | 'subscription' | 'api-or-cloud' | 'unknown';
  cliVersion: string | null;
  busy: boolean;
  message: string | null;
}
```

There is no extra `acknowledged`, `intent`, executable path, command, URL, account identity, plan, token, raw output, or error field. `message` is fixed host-authored text; it reports intent or handoff without claiming installation or completed authentication. `installed` means that a supported executable was located, not publisher attestation or a successful login. Only an explicit `status` refresh verifies the version and authentication metadata. Install returns the last snapshot with its message updated; opening instructions never sets `installed:true`.

Parent main owns validation of the exact owner window, sender, top-level frame, current origin, and enum argument count before dispatch. These host methods are capabilities, not independently authenticated IPC handlers. The module additionally requires a live window and a canonical HTTP loopback origin with an explicit port, then rechecks window identity, origin, and project across awaited preparation and native confirmation. This prevents an old confirmation authorizing a changed host context. UI **Check status** must call `status` only after an explicit human action; do not call it on startup, render, polling, install completion, login completion, or inference preflight without that authorization. Existing parent-owned connected-account metadata can inform the login gate.

`enabled:false` is required for EXE smoke/verification mode. All four methods, for either valid provider, return:

```json
{"version":1,"provider":"codex","installed":false,"auth":"unknown","cliVersion":null,"busy":false,"message":"CLI setup checks are disabled in verification mode."}
```

The provider field follows the requested enum. This branch occurs before calling accessors, home lookup, filesystem metadata, dialogs, browser opens, or processes. Invalid arguments still reject. Verification mode is pinned at construction; later mutation of the original options object cannot enable it. Omission of `enabled` enables actions but does not start anything.

## Trusted factory seams

Only main-process code may supply these optional dependencies:

| Option | Contract/default |
| --- | --- |
| `fs` | `node:fs/promises` metadata subset: async `realpath`, `stat`, and `opendir` returning an async iterable of directory entries. No file-content reader is used. |
| `spawn` | `node:child_process.spawn` contract; child provides `once`, `kill`, and `stdout`/`stderr` streams with `on`/`once`. |
| `dialog` | Electron `dialog`, resolved lazily; `showMessageBox(ownerWindow, options)` returns `{response}`. |
| `openExternal` | Async function accepting the host's fixed official HTTPS page. Default is Electron `shell.openExternal`, resolved lazily. |
| `env` | Trusted host environment snapshot, default `process.env`. Never IPC-supplied. |
| `homedir` | Function returning the trusted native user home, default `os.homedir`. Called only during enabled actions. |
| `platform`, `arch` | Trusted platform/architecture strings, default process values. |
| `timeoutMs` | Integer 1–15000; default 8000 milliseconds per metadata/terminal-launch process. Tests use a short owned deadline. |

One global in-flight action prevents overlapping confirmations and probes across providers. A concurrent request returns its existing snapshot with `busy:true` and a fixed busy message; it performs no side effect and does not queue or retry. Finished requests return `busy:false`. Visible vendor terminal lifetime is user-owned and is not tracked as host `busy`.

## Metadata and executable discovery

`status` runs only native `--version`, followed by `codex login status` or `claude auth status --json`. It does not start an app server, invoke help/doctor/catalogue, query quota, or run a task. A failed or unrecognized version stops before the auth helper. Native process errors, malformed metadata, unrelated exit failures, and unknown auth methods remain `unknown`, never inferred signed-out or subscription state.

Helpers use absolute executables, `shell:false`, an existing neutral user-home cwd, ignored stdin, hidden Windows helper windows, an 8-second default deadline, and a combined 16-KiB stdout/stderr cap. Failure kills the helper and drops collected output. Numeric versions with recognized alpha/beta/rc suffixes are the only version projection. Codex's exact status phrases can be on stderr; its API-key status suffix is discarded. Claude JSON projects only recognized `loggedIn`/`authMethod`/`apiProvider` combinations; identities, configuration directories, plans, and every other property are discarded. `oauth_token` alone does not establish subscription provenance. No raw output is logged or returned.

The child environment allows ordinary OS/home/locale/display variables and bounded absolute PATH entries. It omits Arcane authority, runtime injection variables, provider key/token overrides, and proxy routing. This isolates the setup helper from Arcane's embedded authority and avoids forwarding ambient credentials. Metadata describes native vendor-stored authentication under that environment, not every possible externally configured route. This is not an auth-method restriction: the unmodified vendor client retains all its native sign-in/key/cloud choices. `api-or-cloud` remains valid metadata and does not trigger an API request or a subscription fallback.

Discovery uses filesystem metadata only:

- Up to 64 absolute PATH directories, with a 32768-character PATH bound, for fixed `codex.exe`/`claude.exe` on Windows or `codex`/`claude` on POSIX. Empty/relative paths, Windows device paths, UNC/network paths, controls, and malformed local paths are rejected. Script wrappers, `.cmd`, `.ps1`, JavaScript launchers, npm execution, registry traversal, and shell command lookup are unsupported.
- The native user `~/.local/bin` executable location, including Claude's Windows `claude.exe`.
- Windows Codex desktop-native `LOCALAPPDATA/OpenAI/Codex/bin/<16-lowercase-hex-build-id>/codex.exe`. Enumeration stops above 32 entries; exactly one eligible build is required if PATH did not select one. Opaque build IDs are never sorted as versions or guessed as the active build.
- Windows Codex npm native payloads for x64/arm64 in fixed nested optional-package, sibling optional-package, or legacy vendor layouts beneath a PATH prefix's `node_modules/@openai`. Only the fixed native executable is invoked. No package/config/auth contents are read.

Canonicalized executable paths inside the current project are rejected, including outside symlinks resolving into that project. POSIX files must have an executable mode bit. Paths from these trusted host locations are a local executable trust boundary, **not cryptographic publisher verification**; version output alone cannot establish binary provenance. Windows system PowerShell must resolve to its fixed requested system path. Filesystem checks and process launch cannot atomically pin a mutable executable on all supported hosts. Real installed-client and terminal behavior remains unverified in this slice.

## Human sign-in and native Claude handoff

`login` locates the executable but performs no status/version probe. A parent-owned native message box must explicitly approve opening the native sign-in terminal. Its first/default/cancel button is **Cancel** (`defaultId:0`, `cancelId:0`); only numeric response `1` approves. Dismissal, malformed responses, and a changed host context do nothing.

On Windows, a bounded hidden system PowerShell launcher starts a separate visible PowerShell console with `Start-Process -WindowStyle Normal`. Both use `-NoProfile`; the visible console uses `-NoExit` for the user's interaction. The fixed terminal command is exclusively `codex login` or `claude auth login`, under the neutral user home. Trusted paths are single-quoted PowerShell literals with apostrophes doubled, and scripts travel as UTF-16LE `-EncodedCommand` arguments. No execution-policy flags, elevation, protection changes, custom OAuth URL, device-code extraction, API-key stdin, `setup-token`, login flags, or shell profile are supplied. The native CLI owns terminal/browser sign-in and credential storage; Arcane does not capture the visible child's input/output, relay codes, receive callbacks, read credentials, or decide which native login method the user selects.

`launch('claude')` follows the same confirmation boundary and opens the unmodified native Claude CLI with **zero arguments** in the canonical current project, whose path appears in the native confirmation. It supplies no prompt, resume, model, permission bypass, embedded SDK, server, or API-billing route. The confirmation explains that the native client controls auth, billing, project trust, and tool permissions, and that the user's API/cloud usage can incur charges. `launch('codex')` returns an unavailable message without discovery, processes, or dialogs; Codex connection remains parent-owned.

No version-specific native desktop flag is guessed. The visible launcher only acknowledges a terminal request; it cannot prove a login succeeded or the client is still running. After sign-in the user explicitly checks status. Non-Windows login/handoff returns an unavailable message with instructions to use the native terminal; those platform integrations have not been verified. No hidden login or inference fallback exists. A native CLI can perform its own normal startup/update/configuration behavior; Arcane does not replace or disable vendor security, trust, authentication, or update policy.

## Installation and primary-source basis

`install` is an instructions-page action. It requires the same native Cancel-default confirmation before opening exactly one of these host-constant URLs:

- [Official Codex CLI setup](https://learn.chatgpt.com/docs/codex/cli), including its Windows installation tab and Install Codex link. [Official CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) documents native login and login status.
- [Official Claude Code setup](https://code.claude.com/docs/en/setup). It publishes the WinGet ID `Anthropic.ClaudeCode`; this module does not run WinGet, accept agreements, download scripts, or guess a Codex package ID. [Official Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents native auth commands and the interactive CLI.

The host executes no installer, pipe-to-shell command, curl/iex flow, global npm install, elevated helper, or protection/ACL change. A browser page is not an install receipt. Any later download/installation remains a separate human action; direct native installation requires a future verified design and host confirmation before downloads.

[Anthropic's authentication and product policy](https://code.claude.com/docs/en/legal-and-compliance), reviewed 2026-10-13, distinguishes a user's own unmodified native CLI from third-party applications routing Claude subscription credentials. Arcane's handoff leaves user sign-in and all credentials inside Anthropic's own flow and unmodified client. It neither offers Claude.ai login within Arcane nor routes requests through subscription credentials, collects tokens, resells usage, or restricts built-in auth methods. Native API/cloud auth is not blocked; billing stays with the user's chosen native route. This handoff is not authorization for an embedded subscription inference adapter.

## Owned validation

Run only the owned fixture suite:

```powershell
node --test tests/release/provider-setup-host.test.mjs
```

The suite imports the actual CommonJS module and supplies owned memory filesystems, child-process doubles, native-dialog doubles, and browser doubles. Import/factory checks additionally deny all real metadata, process, home, and Electron access. It covers the exact public shape and enum arguments, disabled-mode zero effects, version/auth sanitation, stderr handling, timeout/error/output bounds, native and npm locators, ambiguous/oversized directory enumeration, project executable rejection, confirmation and host-context revocation, terminal literal quoting, redirected system-shell rejection, native Claude handoff, install honesty, concurrent calls, and non-Windows fail-closed behavior. On 2026-10-13 the owned suite passed **28/28**, with zero skips.

No installed CLI, provider auth/config file, installation, login, browser, network provider request, inference, Studio, root compile, shared dist, AV, ACL, or Git operation is part of these tests. Parent's installed-client checks remain subject to the explicit human authorization boundary recorded in the parent conversation.
