# Desktop Arcane Studio key vault

Arcane Settings can retain its own locally issued Arcane Studio API keys across
reloads. The Electron main process seals the complete project-bound payload with
`safeStorage.encryptString`; only ciphertext reaches the cache file. The renderer
receives a key only after an explicit human Show action. This vault does not store
Codex, Claude, cloud-provider credentials, authentication files, or session tokens.

## Frozen version 1 bridge

`window.arcaneDesktop.studioKeys` is frozen and has exactly these members:
`version: 1`, `list`, `remember`, `reveal`, and `forget`. There is no general IPC,
file/path, environment, URL, process, provider, or grant interface.

| Intent | Exact arguments | Exact successful reply |
| --- | --- | --- |
| `list()` | None | `{ available: boolean, items: [{ keyId: string }] }` |
| `remember(...)` | `{ keyId: string, apiKey: string }` | `{ remembered: true }` |
| `reveal(...)` | `{ keyId: string }` | `{ apiKey: string }` |
| `forget(...)` | `{ keyId: string }` | `{ forgotten: true }` |

Replies contain no additional version, project, path, status, or credential fields.
Unavailable encryption or disabled storage makes `list()` return
`{ available: false, items: [] }`; mutation/reveal requests reject. A missing key
cannot be revealed. Forget is idempotent. Identical remember requests are
idempotent; an existing UUID cannot be rebound to a different secret.

Inputs must be exact plain data objects, with no extra fields, symbols, accessors,
or extra arguments. Key IDs are canonical lowercase UUID v4 values issued by the
Arcane daemon. Keys must have the exact format
`arcane_local_v1_<port>_<64 lowercase hex characters>`, where the canonical port is
the currently owned IPv4-loopback daemon's port. This validates the local credential
format and scope; it does not authenticate a key, issue one, grant writes, or
connect Studio. Authorization and revocation remain the daemon's responsibility.

All rejections expose only `Arcane Studio key storage is unavailable.` through the
preload. The implementation does not log key contents or native error details.

## Storage and host fences

The main process supplies the current owner window, project session/epoch,
project path/ID, physical Arcane profile, runtime state root, and origin. Only the
exact owner's live main frame at the canonical current root or `/studio` document
can call an intent. Closing, switching, missing ownership, changed frame/URL,
changed epoch/project/profile, and redirected directories revoke the operation.
These identities and pinned directory chains are rechecked after the async boundary
and before key access, encryption, and commit.

The sole cache path is:

```text
<trusted physical Arcane profile>/runtime/projects/<project SHA-256>/studio-key-vault.v1.json
```

The project ID is recomputed from the canonical Windows project path. No renderer
path is accepted, and the vault creates no directories. The outer exact JSON
envelope has only `version: 1` and base64 `ciphertext`. The encrypted payload binds
the project ID, IDs, and keys together. Listing decrypts inside the main process
but returns IDs only. No plaintext fallback, renderer localStorage, or plaintext
cache migration exists.

Storage is enabled only on Windows and only when native
`safeStorage.isEncryptionAvailable()` returns `true`. Electron's synchronous
Windows safeStorage uses DPAPI. Its protection is against other Windows users;
applications running as the same logged-in user are within the OS trust boundary.
See [Electron safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage).
Other platforms deliberately return unavailable instead of accepting weak stores.

There are at most 32 entries, an 8 KiB decrypted payload, a 16 KiB ciphertext,
and a 32 KiB cache file. One in-flight intent fences reentry. Reads are bounded and
check descriptor identity, file size/content, and direct parent chains. Observed
symlinks, junctions, physical redirection, hardlinks, special files, traversal,
network/device/ADS paths, corrupt data, and foreign lock files are refused.

Writes use an exclusive fixed lock and an exclusive unpredictable sibling stage,
write only sealed bytes, flush, recheck identities, close Windows handles, and
atomically rename over the previous cache. Failure before rename preserves the old
cache. Cleanup removes only identifiable owned stages/locks; changed or foreign
files remain untouched. Stale foreign locks are not automatically reset. These
Node filesystem checks do not claim native syscall-level protection against every
hostile same-user concurrent path swap. Forget removes an entry from the current
encrypted cache, without promising erasure from external filesystem backups.

## Frontend and smoke integration

FrontCurie owns `studio.ts`, `studio-key-settings.ts`, HTML/CSS, and shell wiring.
The frontend remembers a human-issued key, lists IDs on reload, and reveals only
through the human Show control. It must clear displayed plaintext when hidden,
closed, revoked, or disposed. It must call `forget({ keyId })` after confirmed
revocation and when authoritative key metadata reports revocation, and never
auto-reveal or persist plaintext in localStorage. Browser-only contexts have no
native vault. The separately authorized Studio plugin settings persistence is
owned by the parent and does not expand this desktop bridge's credential scope.

`createStudioKeyVault({ safeStorage, getSession, enabled: false })` and IPC
installation are inert. Smoke passes `enabled: false`: list reports unavailable,
all other valid intents reject, and no vault filesystem/encryption/decryption work
runs. The executable smoke report separately checks the frozen bridge and records
native encryption availability only, with `encryptionRoundTripTested: false`.

## Evidence and release closure

`tests/release/studio-key-vault-host.test.mjs` executes the production host module,
the actual main-process factory/session wiring and IPC gate, and the real preload
in VMs. Its AES-GCM safeStorage **test double** exercises encrypted cache recovery,
exact schemas, ownership/project changes, path/link guards, limits/reentry,
failed writes, sanitized errors, and forget. These tests are not native DPAPI proof.

On 2026-10-13 an actual `node_modules/electron/dist/electron.exe` availability-only
probe with a fresh temporary profile reported Electron `44.7.0`, platform `win32`,
and `encryptionAvailable: true`. It called no encrypt/decrypt operation and read no
credential files. Native encrypted vault round-trip, packaged Arcane EXE recovery,
and Settings interaction verification remain for the parent's rebuilt executable;
none are claimed as passed by this backend patch.

A later independent [native key vault proof](NATIVE_KEY_VAULT_PROOF.md) now
exercises the unchanged production vault and preload through real Electron
44.7.0 IPC and Windows safeStorage across three fresh processes. Remember,
encrypted restart recovery, IDs-only list, reveal, forget and real foreign-frame/
project rejection pass using a synthetic fixture key. All owned processes and
the fixture server closed. This extends the crypto/IPC evidence, not the disabled
smoke mode: packaged Settings interactions and real daemon key authorization are
still separate unverified gates.

The Windows package's fixed host closure includes `studio-key-vault.cjs` alongside
main/preload/policy and the existing host helpers. Packaging tests require the
file, reject a missing file, and verify its source-snapshot identity. Local release
collection already includes `.cjs` source files. The frontend controller's source,
compiled module, and source map are also required release assets. No release-scanner
exception or runtime-secret allowlist expansion was added.

At this backend handoff, the new `studio.ts` import also needs an exact
`/studio-key-settings.js` static route in `apps/daemon/src/lab-server.ts`. That file
is outside this patch's ownership. FrontCurie was notified; the integration owner
must add the route before the parent's rebuilt executable can mount the controller.
