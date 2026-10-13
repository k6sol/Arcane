# Stable project listener audit — 2026-10-13

The authoritative desktop host already remembered and reused a project listener
port. This work audits and guards that implementation; it introduces no new port
module, migration, renderer API or packaging dependency.

## Existing contract retained

`startDaemon(project)` approves the direct canonical local project path, hashes it
with SHA-256 (lowercase on Windows), and prepares the existing owned
`userRoot/runtime/projects/<hash>` directory. That same state root remains the
daemon's backing store. Only its fixed `listener-port.json` is used for routing:

```json
{"protocolVersion":1,"port":45071}
```

The record contains only metadata. Its two own fields are required, with version
1 and a numeric integer port from 1 through 65535. Existing valid records remain
compatible and are neither rewritten nor rotated. No renderer/model input can
select a port record or daemon server, and inherited Arcane overrides are removed.

Without a record, the host requests `ARCANE_PORT=0`. After a genuine ready ACK
from its spawned child, it exclusively creates the record using the actual
nonzero bound port. Subsequent starts request the remembered port. A conflicting
listener fails startup; there is no scan, fallback port, proxy, retry or attempt
to kill the conflicting process. The failure message suggests checking for
another app using the port; an unknown child failure is not represented as proof
that another listener belongs to Arcane.

## Concrete defects corrected in place

- The previous code assigned `origin` and `token` before comparing the ready
  port with the requested port. Comparison and persistence now precede adoption.
- `new URL(origin).port` normalizes explicit HTTP port 80 to an empty string,
  which previously could persist port 0. The host reads the validated literal
  port instead. This boundary case is tested with a child double, without binding
  a privileged port or claiming end-to-end port-80 support in other components.
- The previous `readFile()` allocated the entire file before enforcing its
  1024-byte limit. The read now uses a fixed 1025-byte buffer and descriptor/path
  identity checks, including direct regular paths, physical aliases and hardlinks.
- Directory and record identities/bytes are rechecked after the ACK wait.
  Replacement, disappearance, or a competing fresh record prevents adoption.
  Creation remains exclusive, with synchronous verification and flush. These
  checks do not promise an atomic filesystem operation against every possible
  concurrent external directory mutation.

The provider `cancelPending`/`dispose` hooks, native key vault and private
workspace preferences are preserved. The existing shutdown owner remains
responsible for its child. Startup timeout itself no longer kills the child;
normal failure handling initiates the existing private shutdown path.

## Legacy routing

Absence of the port record cannot distinguish a fresh profile from legacy state.
The host requests 0 and remembers the newly acknowledged port; it does not claim
that an old plugin key has migrated or reconnects successfully.

Inspection of `StudioStore.issueKey()` shows that `api_keys` persists the key hash
and grant metadata, with no authoritative issued-port field. The hash cannot
recover the embedded port. This audit reads source, never existing key databases,
credential files or DPAPI plaintext. A legacy key for another port may require
explicit replacement by the user in the current workspace. No automatic secret
reveal, guessed routing or false paired/green state is introduced.

## Focused proof and freeze

- `node --test tests/release/project-port-host.test.mjs`: **13 passed**, no skips.
- Existing desktop host/compiler host suites: **49 passed**.
- `node --check apps/desktop/electron/main.cjs`: passed.

The 13 new tests exercise current `startDaemon` source, exact project scope and
reuse, changed project path, bad versions/fields/types/port 0/oversized metadata,
aliases and hardlink stat doubles, record/ancestor races, exclusive creation,
malformed or mismatched ACKs, timeout, child failure and missing legacy records.
Fixtures are created and removed only inside the allowed repository workspace.

The final test runs isolated owned Node children that bind real IPv4 loopback
listeners and use the current production `StudioStore` source, transformed with
Node alongside its three source dependencies in the fixture. It issues a fresh
synthetic test key, authenticates it, stops cleanly, occupies the remembered port
with an unrelated owned listener, verifies failed startup preserves the record
and that listener, then restarts and authenticates the original key against the
same store and exact endpoint. An altered key fails authentication. The key stays
in test memory/private child IPC; the durable store persists its hash.

The sandbox denied a parent loopback HTTP request (`EACCES`), so authentication
is checked through owned private fixture IPC against the actual bound port and
real store. This proves listener reuse, key routing agreement and durable store
authentication, not a complete plugin HTTP reconnect or native Studio session.
No Electron EXE, Studio, inference, provider login, install, remote service,
firewall/ACL change or privilege escalation was used.

Owned files frozen for the parent's canonical release gate:

1. `apps/desktop/electron/main.cjs` — existing startup guard only.
2. `tests/release/project-port-host.test.mjs` — new focused proof.
3. `tests/release/desktop-code-verification.test.mjs` — the existing cold-start
   double now supplies filesystem primitives and expects the one port creation.
4. `docs/build/STABLE_PROJECT_PORT_20261013.md` — this report.

**API/export changes: none. Native host module copy filename: none.
`HOST_FILES` needs no addition.** No TypeScript, frontend or plugin source changed.
