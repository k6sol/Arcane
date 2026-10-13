# ReceiptKey I/O component evidence

The source-extracted regression in `tests/release/workflow-receipt-io.test.mjs` passes **23 tests / 179 synthetic scenarios**. It proves ReceiptKey composition against explicitly labelled filesystem/native ACL boundary **DOUBLES**. It is component evidence, not native product acceptance or a measured native performance result.

## Retained run

- Date: 2026-10-13 UTC.
- Host runtime: Windows, Node v24.21.0.
- Command: `node --test tests/release/workflow-receipt-io.test.mjs`.
- Final result: 23 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Final reported duration: 10565.9106 ms.
- Simulated platform branches: `win32` and `linux` (POSIX).
- Each of the 21 scenario groups executes in a separate owned Node helper, externally bounded by `spawnSync` at **3000 ms**, with `SIGKILL`, a 64 KiB output limit, no shell, and an empty environment.
- One separate watchdog test deliberately spins an owned helper and asserts `ETIMEDOUT` at the same fixed deadline. The helper deadline is never widened.
- The other test verifies extraction and emits the source pins.

## Exact source pins

The test reads the current host source once, slices from the unique `class ReceiptKey {` to the following `function representation(`, and passes those unchanged source bytes plus their SHA-256 pin to every helper. Each helper verifies the pin, uses Node 24 `stripTypeScriptTypes` in strip mode, and evaluates that exact class in a fresh VM context. The class is not copied, rewritten, exported, or instrumented in production. Pins are recalculated on each future invocation rather than freezing this historical revision.

| Source | SHA-256 used in the retained run |
| --- | --- |
| Entire `apps/daemon/src/workflow-host.ts` | `1f1771af4286135438264fb84adfc8930954280dfbb4249faba11707ab06a03d` |
| Exact extracted private ReceiptKey class | `b421d82a5c9d75048a02a05d5a8b8b939483f7f1ec91bbe623199af4507654bd` |
| Inspected `apps/daemon/src/workflow-private-storage.ts` | `b68b82d385db3bc0ef6a52432aa4234e50fa90fdd60b6c733f143f515042640f` |

The private-storage source is inspected and hashed; its native PowerShell operation is not executed by this suite.

## Scenario counts

| Group | Windows | POSIX |
| --- | ---: | ---: |
| Existing key / fragmented existing reads | 2 | 2 |
| Full ACL refusal: directory, key, ancestor | 3 | 0 |
| Missing, damaged, linked, or nonprivate existing storage | 10 | 14 |
| Descriptor/path identity races, in-place changes, extra byte, late link | 9 | 9 |
| New key / fragmented writes and reads | 2 | 2 |
| Unapproved preparation / missing prepared directory | 9 | 0 |
| Full ACL refusal after new key creation | 3 | 0 |
| Invalid writes, before progress and after 5 bytes | 20 | 20 |
| Invalid reads / early EOF, before progress and after 5 bytes | 20 | 20 |
| Valid zero EOF after exactly 32 bytes | 2 | 2 |
| I/O exceptions, exclusive collision, owned cleanup | 7 | 8 |
| Independent checks, synchronous assessment, changed key | 3 | 2 |
| **Total** | **100** | **79** |

POSIX uses the real boundary's null-return contract and has no simulated native ACL preparation/refusal groups. Windows exercises an absent `O_NOFOLLOW`; POSIX exercises its presence. Flag values and file identities belong to the filesystem double.

## Assertions and observed ordering

The in-memory filesystem contains exact synthetic bytes and metadata, with an unrelated sentinel file and foreign descriptor. Every successfully opened owned descriptor must close exactly once; the foreign descriptor stays open. Fresh write and staging read buffers must be erased.

Existing constructor trace, on both simulated branches:

```text
direct parent/directory checks
FULL privateWorkflowReceiptStorage(parent, false, true)
direct key + directory/key stat contracts
read-only key open
descriptor stat + selected identity match
read 32 bytes; read 0 at offset 32 with 1 byte remaining
descriptor stat + current direct path/identity match
close owned descriptor
```

There is exactly one full boundary invocation and no directory-only preparation/check. Full ACL refusal opens/reads no key and leaves the complete synthetic filesystem unchanged. Missing, malformed, linked, raced, or changed keys are refused without creation, rewriting, permission repair, fsync, or replacement.

New Windows constructor trace:

```text
privateWorkflowReceiptStorage(parent, true, false), requiring created === true
exclusive 0600 key open
generate exactly 32 synthetic bytes
bounded writes; fsync key; erase fresh buffer; close write descriptor
FULL privateWorkflowReceiptStorage(parent, false, true)
read-only key open + exact 32-byte/identity verification
erase staging buffer; close read descriptor
```

The POSIX branch instead creates the directory with mode 0700 and fsyncs/closes its own directory descriptor before the full boundary seam and key read.

Invalid-count variants are zero, negative, NaN, positive/negative infinity, fractional, oversized relative to remaining bytes, unsafe integer, string, and undefined. Each is tested immediately and after five valid bytes. Invalid writes preserve exactly the bytes already stored and never fsync, read, or retry. A separate reopen of each partial key also refuses without regenerating it. Invalid nonzero reads close immediately, before post-read identity checks; stored bytes remain unchanged and staging buffers are erased. Zero read is permitted EOF: early EOF refuses the key without another read, while EOF after exactly 32 bytes succeeds.

Independent sign/verify calls each perform a full check. A synchronous assessment performs full checks before and after evaluation; inner MAC operations still reopen and pin the key without extra full native checks. Changed key bytes and a failed final assessment check refuse rather than regenerate.

## Boundary of this evidence

`workflowReceiptParent`, path/directPath, privateMode, sameFile, filesystem operations, random bytes, and native ACL results are controlled seams. Their event logs verify the exact class's use of those contracts. Real path/link detection, DACL rules, ancestor inspection, descriptor parsing, app-owned parent relocation, and native process behavior require their own acceptance evidence.

This run performs no real receipt-file creation, native ACL operation, ACL/policy/AV change, compiler invocation, product HTTP acceptance, installed Codex/Claude probe, provider turn, authentication/configuration/token read, or Studio interaction. Those product gates and deferred native actions are outside this component suite.

Only the new test and this new evidence note were written by this sidecar.
