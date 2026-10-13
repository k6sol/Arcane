# Provider setup IPC source verification

`tests/release/provider-setup-ipc.test.mjs` exercises the production Electron parent registration, its context accessors, the complete sandboxed preload, the provider helper, and the actual origin/navigation policy. It uses native Node and VM source extraction; it does not start Electron. Missing or ambiguous extraction markers fail the suite.

Only trusted native dependencies are substituted: an in-memory filesystem, synthetic process streams, a fake native dialog, and an external-page recorder. Production guards and `getWindow`, `getOrigin`, `getProjectPath`, and `enabled` wiring remain intact. Native fallback calls are trapped. IPC replies are structured-cloned; renderer mutations cannot alter the helper's frozen snapshots or cache. Fixture paths, versions, authentication output, and terminal commands are synthetic.

The 21 tests cover:

- Four fixed channels and a frozen versioned preload bridge. Exactly one literal `codex` or `claude` enum is accepted. Missing, coercible, malformed, command/path/object, and extra arguments are rejected at both preload and parent boundaries.
- Owner webContents identity, current top-frame identity, canonical current loopback origin, supported document paths, closing/switching, and missing/destroyed contents. Matching URLs alone grant no authority.
- The current host project and refusal of a native executable that resolves inside that project.
- Context revocation after executable/cwd resolution, version/auth replies, confirmation, executable revalidation, and terminal resolution. Every staged mutation asserts that its targeted await was reached.
- The parent `getWindow` seam returning `null` during closing/switching. A deferred-dialog regression changes only those flags while the original window, project, and origin remain intact, then verifies that approving the pending dialog opens no page or process.
- Verification mode, generic error sanitization, concurrent-action fencing, fixed status probes, fixed official-page targets, fixed vendor terminal intents, literal path quoting, default-cancel confirmations, and sanitized child environments.

Run only this source suite:

```powershell
node --test tests/release/provider-setup-ipc.test.mjs
```

The retained final run used the TAP reporter with Node v24.21.0: **21 passed, 0 failed, 0 cancelled, 0 skipped**. Source hashes were unchanged across the run.

- [Run manifest](../../runtime/verification/provider-setup-ipc-5c0d1f1c-49b6-4748-b292-232bef81a461/verification.json)
- [Complete TAP output](../../runtime/verification/provider-setup-ipc-5c0d1f1c-49b6-4748-b292-232bef81a461/node-test.tap)

These are bounded component checks. No credential files, network, native provider, inference, real login, installation, or Studio operation was used. Actual Electron IPC transport and native UI/provider acceptance remain outside this suite.
