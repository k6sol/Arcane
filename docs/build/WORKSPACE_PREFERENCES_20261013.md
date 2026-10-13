# Workspace preferences bridge — 2026-10-13

## Controller contract

`window.arcaneDesktop.workspacePreferences` is a frozen version 1 bridge exposing only `read()` and `save(snapshot)`.

- `read()` resolves `{ available: true, preferences: null | Snapshot }` on supported storage. A missing record is `null`. Disabled smoke mode, unsupported operating systems, or unavailable Windows safeStorage resolve `{ available: false, preferences: null }` without disk access.
- `save(snapshot)` resolves `{ saved: true }` only after an encrypted atomic write and current owner/project recheck. Invalid, unavailable, locked, redirected, changed, or unknown storage rejects with the generic `Arcane workspace preferences are unavailable.` error. Never show “saved” before this acknowledgement.
- Ordinary browsers have no native bridge. Controllers must retain an honest in-memory fallback; browser localStorage is not proof of restart persistence.

```ts
type Snapshot = {
  version: 1;
  projectPath: string;
  provider: 'codex' | 'claude';
  tabs: Array<{
    localId: string;
    title: string;
    provider: 'codex' | 'claude';
    threadId: string | null;
    sessionId: string | null;
    draft: string;
    modelId: string | null;
    effort: string | null;
    tool: 'all' | 'blender' | 'roblox';
    previewOpen: boolean;
  }>;
  activeTabId: string | null;
};
```

Every listed field is required; no extra fields are accepted. Maximum **16 tabs**, matching the agreed conservative chat-controller cap. Local IDs are unique and at most 128 bytes. `activeTabId` must be null or match a tab. Title: 512 UTF-8 bytes with no control characters. Thread/session IDs: null or at most 256 bytes. Model IDs: null or at most 256 bytes. Effort: null or at most 64 bytes. All IDs start with an ASCII letter/digit and use only ASCII letters/digits/underscore/hyphen/dot/colon. Draft: at most 131,072 UTF-8 bytes, preserved exactly without trimming or content logging; malformed UTF-16 is rejected. Serialized plaintext, including the sealed host project binding, is capped at 512 KiB; the complete encrypted disk envelope is capped at 1 MiB. Oversized input rejects without truncating drafts or changing previous storage.

`projectPath` is required inside `Snapshot` on save and read. It is advisory and compared only with the host's trusted current canonical project path, using case-insensitive Windows equality. Other projects, traversal, alternate separators, network paths and child paths reject. It never selects any file, project or authority. Save persists the host canonical path; read returns the host's current canonical path even after a case-only spelling change. The main-owned project SHA and state root remain the only storage selectors. The save acknowledgement remains exactly `{ saved: true }`.

These are presentation preferences only. Do not persist credentials, authentication, grants, permissions, daemon tokens, current authority, or live runs. Thread/session IDs are advisory and must be reconfirmed against the current project's canonical native inventory before resume. Hydration must not start providers, paid turns, Studio, MCP, installation, or native connections.

The chat/workspace controller owns complete snapshot writes. A provider-only controller must notify that owner of provider changes instead of saving an empty tab list. Hydrate before the first save; serialize/debounce complete snapshot saves and retain unsaved status on rejection. Preserve current native model/effort authority when restoring advisory selections. Read failures preserve unknown/locked files; do not auto-repair or replace them. No change to the global in-memory `arcane-workspace` partition is needed: disk identity is the canonical project SHA, independent of daemon port and browser origin.

The native bridge returns a read **envelope**, not a bare snapshot. An adapter for `ChatTabsOptions.preferences.read()` must unwrap `reply.preferences` when `reply.available === true`, and treat unavailable separately so it never advertises native persistence. Missing supported storage is null. The agreed native tool values are `'all' | 'blender' | 'roblox'`; a chat controller's internal `'chat'` must map to `'all'` before saving. Tabs currently owned by the chat controller may remain Codex-only; the native schema accepts both provider labels as presentation data, and the top-level provider can be Codex or Claude.

## Scope and verification

Implemented in `apps/desktop/electron/workspace-preferences.cjs` with bounded preload validation and minimal main wiring. Storage is exclusively `<owned userData>/runtime/projects/<SHA256(lowercase canonical Windows project path)>/workspace-preferences.v1.json`. The encrypted payload includes that host project ID. Renderer input never selects a project, directory, filename or credential source. Construction/IPC registration create no directories and perform no storage work.

All effects require the exact current owner window, its main frame and canonical workspace URL, origin, project session epoch and direct pinned directory chains. Save uses an exclusive owned `.lock`, a UUID stage created with `wx`, flush, checks of previous/staged/lock file identities, atomic rename, bounded read-back, safe cleanup and another read-back after lock release before acknowledgement. Links, physical redirections, hardlinks, unknown versions, corrupt/noncanonical payloads, changed paths/files, foreign locks and unavailable encryption stop the operation. A changed stage or lock is retained rather than adopted for cleanup. Generic errors carry no stored values or filesystem paths. No provider credential/authentication files, CLI, daemon endpoints, Studio or MCP are accessed by this module.

Production encryption calls only Electron safeStorage on Windows with `isEncryptionAvailable() === true`. Linux and macOS are unsupported; disabled smoke mode and unavailable encryption have no plaintext fallback. The desktop smoke report truthfully marks preferences disabled and encryption round trip untested, and checks its read returns unavailable/empty.

Private verification:

```text
node --test tests/release/workspace-preferences-host.test.mjs tests/release/studio-key-vault-host.test.mjs
39 passed, 0 failed (26 new preferences fixtures; 13 unchanged key-vault fixtures)
```

The fixtures execute the actual production main session accessor, host module/IPC handlers, preload and path policy with an in-memory Windows filesystem and an AES-GCM **safeStorage test double**. They prove fixture restart/port-change recovery, project separation, byte-preserved Unicode drafts, bounds, sender/frame/epoch/path gates, unavailable modes, malformed records, concurrent requests, foreign locks/stages and error/acknowledgement behavior. They are **not** a native Electron window, DPAPI, packaged EXE or frontend-controller proof. Source syntax checks pass for the host, main and preload. No shared compilation, packaging, native launch, install or paid turn was performed. Existing release FKUT9G is not updated or revalidated by this work.

Only the five assigned files were edited. The existing Studio key-vault module and its tests were left untouched. The coordinator owns frontend integration, any later fresh canonical build/native proof, and updating `tests/release/desktop-host.test.mjs`'s exact public bridge allowlist to include `workspacePreferences` (that shared file is outside this sidecar's edit scope). The contract is published here and in commentary/final handoff. The app's thread-messaging tool refused delivery to a native ancestor; no native collaboration messaging API is exposed in this sidecar session.
