# Windows installer Node protocol

Internal contract between the setup bootstrapper and `scripts/windows-install-cli.mjs`. It is a protocol foundation, not installer GUI acceptance.

The entry point does only these things:
- installs one verified bundle through `createWindowsInstallation()` with the full production bundle verifier
- reports progress
- returns one result

It never:
- launches Arcane
- writes registration, shortcuts or profile data
- downloads anything
- invokes providers
- retries
- kills the engine

## Invocation

```
"<stage>\bundle\resources\node\node.exe" "<stage>\kit\windows-install-cli.mjs" --bundle <ABSOLUTE> --install-root <ABSOLUTE>
```

- **Arguments:** exactly these four, in this order. Each path is drive-absolute (`X:\…`), with no surrounding spaces, control characters or leading `-`, and at most 4096 characters. The engine then applies its own path rules (`PATH`, `PATH_LENGTH`, `OVERLAP`, `REDIRECT`).
- **Refusal:** any other argv is refused before the engine is created. The result is `code: "ARGUMENTS"`, `published: false`, with exit 1.
- **No other selectors:** no flag or environment variable selects a verifier, root or behaviour.
- **Parent process:** start Node with `UseShellExecute=false`, no shell, and redirected stdin, stdout and stderr.

## stdout: frames

stdout carries UTF-8 newline-delimited JSON. Each frame is at most 1024 bytes, including the newline. Every frame has `schemaVersion: 1`.

### Progress frame

```json
{"schemaVersion":1,"type":"progress","phase":"copying","filesCopied":3,"totalFiles":43,"bytesCopied":1200,"totalBytes":9000}
```

- **Phases:**
  - In order: `verifying-source`, `copying`, `verifying-copy`, `publishing`.
  - Then one of `installed` or `already-active`.
  - An existing or already-active release has no `copying` phase.
- **Counters:** safe non-negative integers. `filesCopied ≤ totalFiles` and `bytesCopied ≤ totalBytes`. `totalFiles` includes the manifest.
- **Throttling:** `copying` frames are throttled to one per 250 ms. While stdout is blocked, an unsent copy counter is replaced by the newer one.
- **Never dropped:**
  - phase changes
  - the final copy counter (`filesCopied === totalFiles`)
  - the last counter reached before a cancellation or failure

### Result frame

Exactly one result frame is sent, and it is always the last frame:

```json
{"schemaVersion":1,"type":"result","state":"installed","published":true,"code":null,
 "installationId":"<uuid>","activeReleaseId":"<sha256>-<uuid>","abort":null,"lockRetained":false,"stagingRetained":false}
```

| state | exit | meaning |
|---|---|---|
| `installed` | 0 | The new active-release record was published and confirmed. `published: true`. |
| `already-active` | 0 | The release was already selected, and nothing was published. `published: false`. |
| `cancelled` | 2 | A requested cancel was observed **before** publication (`code: "CANCELLED"`, `published: false`). The previous selection is retained. |
| `failed` | 1 | Anything else. |

**Fields:**
- **`published`:**
  - `true` means the new record was published.
  - `false` means the previous selection was retained.
  - `null` means publication could not be confirmed. Show this as **unknown**, never as success or rollback.
- **`code`:**
  - **Engine codes:** a fixed engine code, for example `MANIFEST`, `LOCKED`, `PATH_LENGTH` or `PUBLISH_UNCONFIRMED`.
  - **Protocol codes:** `PROTOCOL`, `PARENT_LOST`, `OUTPUT`, `ARGUMENTS`, `RESULT` (an unrecognised engine result shape, `published: null`), `ENGINE` (an unknown typed engine code), and `IO` (an untyped failure, see below).
  - **Never printed:** raw messages, causes, paths and stacks.
- **`installationId` and `activeReleaseId`:** set only on a known success.
- **`abort`:**
  - **Values:** `null`, `cancel`, `protocol`, `parent-lost` or `output`. This is what the CLI requested from the engine.
  - **After a successful publish:** a non-null `abort` beside `installed` means the request arrived after publication. Publication is not undone.
- **`lockRetained` and `stagingRetained`:** the engine retained its lock file or staging directory for inspection. Nothing is deleted on the parent's behalf.

## stdin: control

- **Cancel:** the parent may send **one** frame, `{"type":"cancel"}\n`. A trailing `\r` is accepted. The frame may be at most 1024 bytes.
- **Protocol failure:** any other content aborts unfinished work and reports `PROTOCOL` with exit 1. Refused content includes invalid UTF-8 or JSON, other keys, a second frame, trailing bytes and oversize input.
- **Override:** a protocol violation overrides an earlier cancel. Bytes arriving in a later chunk after a valid cancel report `PROTOCOL`, not `cancelled`. A plain end of stdin after a cancel keeps the cancel.
- **Parent loss:** keep stdin open until the result has been read. End-of-file, close or error on stdin means the parent was lost; unfinished work is aborted and reports `PARENT_LOST`, unless a cancel was already requested.
- **Engine checks:** cancellation is cooperative. The engine checks it between file copies and before the publication rename. A cancel that arrives after the rename reports `installed`.

## Terminal drain and output failure

- **During the install:** a broken stdout pipe aborts unfinished work and is never an unhandled error. The process still waits for the engine's terminal state.
- **Drain deadline:** after the engine settles, the result is written and stdout gets a fixed **5 s** to acknowledge every frame.
  - **When it starts:** the deadline is armed only after the engine's terminal state, so it never times out or kills engine work.
  - **On expiry or a write failure:** the CLI stops owning stdout (destroys only its output handle and closes its stdin reader) and absorbs late errors.
- **Exit codes:**
  - **Exit 0 or 2:** the result write was acknowledged and carries the engine outcome.
  - **Exit 1:** covers a failed install, and also *unknown delivery*: a deadline expiry, or a result write failing after a successful outcome.
- **What the parent must not infer:** exit 1 does **not** mean nothing was published.
  - **Proof of outcome:** the parent may claim an outcome only from a valid result frame it actually read.
  - **Without a frame:** it must report the state as unknown, and may inspect the installation record. The disk outcome is never rolled back.

## Untyped failures (proposal for root)

The engine types every failure after it takes its lock. Failures before the lock can be raw errors, for example `verifyWindowsBundle` rejecting the source or a missing bundle path. These precede any release publication, so the CLI reports them as `code: "IO"`, `published: false`, without the message.

**Proposal:** the engine could wrap pre-lock failures as typed codes (for example `SOURCE` and `IO`). The parent could then distinguish source rejection from I/O, and the CLI would no longer rely on this ordering invariant.

## Host API (tests and composition only)

```js
runWindowsInstallCli({ bundle, installRoot, input, output, installation, now, timers }) // → Promise<exit code>
admitWindowsInstallArguments(argv) // → { bundle, installRoot } | null
```

- **Ports:** `installation` is an explicit engine port. Production `main` always passes `createWindowsInstallation()`, the full verifier. Owned fixtures pass an engine created with their labelled small-inventory verifier.
- **Production entry:** the production entry point has no bypass.
