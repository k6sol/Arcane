# Embedded Codex discovery authority

This bounded change separates inherited-server discovery from the final authority-bearing embedded Codex child. It implements only the discovery/helper launch requirement from [NATIVE_MCP_CHAT_AUTHORITY_PLAN.md](NATIVE_MCP_CHAT_AUTHORITY_PLAN.md), not the native asset authority registry, scoped routes, grants or turn provenance design.

## Launch contract

With no Arcane profile, the public factory retains its original app-server argv, sanitized environment, native-config policy and public history helper.

With an Arcane profile:

1. Validate the fixed final profile before spawning anything. Existing host Node/bundled-entry/project checks, loopback URL validation, bearer validation and secret-free argv checks remain intact.
2. Spawn discovery with a fresh sanitized native environment, never the profile environment. It receives no Arcane local token, daemon URL or other inherited Arcane environment keys. Reset the entire top-level Arcane entry to a harmless host-Node command with `args=["-e","process.exit(0)"]`, `enabled=false` and `enabled_tools=[]`. The reset drops inherited Arcane command, URL, env and remote settings. These are the same existing process-local configuration fields used by the isolation builder; no provider RPC/config fields are introduced.
3. Use the existing strict Arcane-only inventory parser for discovery. Require an explicit non-plugin `arcane` row with runtime status `disabled`. Missing/active/unknown/plugin Arcane state, incomplete isolation metadata, malformed inventory or unsafe inherited server/plugin keys refuse the connection. An installed contract that omits disabled servers is refused rather than guessed or probed.
4. Compute the existing inherited-server/plugin isolation overrides, await discovery close, then launch the separate final specification with its original fixed profile and exact bearer in environment only. Existing exact-thread setup and per-turn isolation checks remain in force. Initialization/inventory/isolation failures close the affected session and propagate; there is no generic launch, retry or route fallback.

Discovery still inventories inherited third-party servers. This is not proof that those servers are harmless or that credentials stored in third-party provider configuration are absent. Arcane supplies no mutation authority to discovery and does not read/rewrite provider config or auth.

## Secret-free embedded history

`CodexSession` now provides a narrow protected host-code `historyProcessSpec()` seam. Its default returns the original private process specification, preserving generic/direct-session behavior. `readThreadHistory` consults the seam only after its existing exact argument envelope, human initiation, live connection, bounded identity, exact thread/session and busy checks.

The final embedded client's private subclass stores a frozen history-only template built from the secret-free discovery specification plus the existing inherited-server/plugin isolation overrides. The template preserves the canonical executable and original project cwd. Its Arcane entry stays explicitly disabled with the harmless host-Node command; every other inventoried server/plugin remains disabled. The template never clones the final live specification and contains no bearer, daemon URL or bundled authority-bearing Arcane entry. Each read receives fresh argument/environment copies, so a helper cannot alter subsequent launches.

Public embedded history remains available, including refresh of a durable binding after connect without selecting a model or starting/resuming a thread. The existing one-shot helper still sends only `initialize`, `initialized` and `thread/read` with the exact requested native thread ID and `includeTurns:true`. Its parser retains exact project/thread/session validation and public projection rules. Reads do not grant writes, select a model, resume/create a thread or start inference. Busy checks, disconnect cancellation and post-read live/scope checks remain unchanged. Failure never clones the final spec, retries or falls back to a generic launch.

## Offline evidence and limitations

`tests/unit/codex-discovery-authority.test.ts` exercises byte-identical emitted product modules in a private ESM mirror. Only their Node spawn boundary is redirected to inline synthetic Node JSONL peers. The synthetic executable and bundled-entry files are validation fixtures and are never executed. No factory/profile/session/isolation implementation is replaced.

Fixtures check generic argv/environment/history compatibility; discovery with ambient synthetic authority and an explicitly disabled Arcane entry; final fixed argv, exact environment bearer hash and existing inherited/plugin overrides; discovery process close before final spawn; exact-thread final isolation; actual secret-free isolated embedded helpers and complete exact-scoped public history; human/live/foreign-scope/busy/cancellation regressions; fresh helper-spec copies; and initialization, inventory, metadata, profile and isolation failures without fallback or replay. Audit files contain only synthetic metadata and bearer hashes, never bearer values.

Compile explicit scoped inputs with the repository compiler options into a unique temporary output directory, including explicit Node type roots and ESM package metadata. Do not run a root compile or use shared root dist as test output. Temporary mirrors and audit files are confined to test-owned directories.

Synthetic close-order receipts demonstrate the fixture's actual child close ordering. Production still uses the existing bounded transport close operation; installed process/config behavior is unverified. This change does not mint/revoke per-incarnation credentials, attest native conversation authority, change daemon permissions, prove native invocation provenance or complete the broader plan.

Installed Codex/Claude tests and every Studio call remain **USER-DEFERRED**. No installed CLI probes/inference, provider config/auth reads or rewrites, workflow edits, receipt-latency work, security/AV/Git changes or shared compiler output are part of this slice. The parent owns local receipt-latency work.

## Validation on 2026-10-13

- Scoped TypeScript compilation passed with the repository's strict options, explicit Node type roots and a private output tree. The test imports the exact factory explicitly so its module is included in scoped compiler output.
- Refined discovery/history synthetic Node suite: **26/26 passed**, zero skips (the original 13 startup tests plus embedded-history regressions).
- Existing MCP isolation synthetic Node suite: **47/47 passed**, zero skips.
- Existing generic/direct-session history-service synthetic Node suite: **37/37 passed**, zero skips.
- Private compiler configuration, emitted artifacts and the workspace-dependency preload were retained at `C:/Users/alexk/AppData/Local/Temp/arcane-codex-history-check-vRtk9a/`. The preload resolves pinned bare imports such as `zod` from the workspace; use its `file:///` URL with Node `--import` on Windows. No workspace dependency files or links were changed. Each fixture removed its own temporary mirror/audit directory.
- No shared root compile, installed-native/PowerShell fixture run or Studio call was performed. Shared compilation and targeted workflow regressions belong to the parent and are not claimed here.

## Changed files

- `packages/codex-client/src/index.ts`
- `packages/codex-client/src/mcp-profile.ts`
- `packages/codex-client/src/session.ts`
- `tests/unit/codex-discovery-authority.test.ts`
- `docs/build/CODEX_DISCOVERY_AUTHORITY.md`
