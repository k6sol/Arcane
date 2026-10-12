# Bounded read-only Luau workflow verification

Implementation: [workflow-code-verifier.ts](../../apps/daemon/src/workflow-code-verifier.ts).
Contract: [workflow-service.ts](../../apps/daemon/src/workflow-service.ts).
Recipe requirements: [workflow-recipes.ts](../../packages/core/src/workflow-recipes.ts).
Proofs: [workflow-code-verifier.test.ts](../../tests/unit/workflow-code-verifier.test.ts).

This adapter actually invokes an installed official Luau compiler on the supplied,
hash-pinned source files. Project source is read-only. Its sole project mutation is
one new report file in the host-selected evidence output directory. Compilation
provides syntax evidence; it does not grant gameplay, security or quality approval.

## Host integration API

| Export | Contract |
| --- | --- |
| `createWorkflowCodeVerifier(options)` | Async host-only factory returning exactly a frozen `WorkflowVerifier` with `action: 'verify-code'` and `verify(request)`. Unavailable configuration/preflight returns a fail-closed verifier. |
| `workflowCodeVerifierCapabilities(verifier)` | Frozen capability observations from this factory's actual compiler preflight. An unrelated verifier returns an empty list. Compiler faults invalidate the observation. |
| `WORKFLOW_CODE_VERIFY_LIMITS` | Frozen, non-overridable bounds, also included in every report. |
| `WorkflowCodeVerifierOptions` | Fixed project root, existing relative evidence directory, and an installed compiler's absolute executable path plus trusted lowercase SHA-256. |

Configure these values from trusted host configuration before registering the
verifier. They are not HTTP, browser, recipe, prompt, command-line or model fields.
The factory exposes no executable runner, environment override, extra compiler
arguments, dynamic test command, credential lookup, Studio action or authoring hook.

~~~ts
import {
  createWorkflowCodeVerifier, workflowCodeVerifierCapabilities,
} from './workflow-code-verifier.js';
import { WorkflowService } from './workflow-service.js';

const codeVerifier = await createWorkflowCodeVerifier({
  projectPath: physicalProjectPath,
  evidenceDirectory: 'src/feature/evidence',
  compiler: installedOfficialLuauCompiler,
  // installedOfficialLuauCompiler is a trusted host-owned
  // { executablePath: absoluteInstalledPath, sha256: approvedReleaseDigest }.
});
const codeAvailable = workflowCodeVerifierCapabilities(codeVerifier)
  .some(c => c.id === 'local.code.verify' && c.state === 'available');

const workflow = new WorkflowService({
  directory: projectStateDirectory,
  projectPath: physicalProjectPath,
  workStore: { store: existingWorkStore, projectPath: physicalProjectPath },
  authorizeHuman: command => durableHumanReceipts.verify(command) === true,
  policyContext: () => ({
    connections: currentConnections(),
    studioSessions: currentStudioSessions(),
    capabilities: [
      ...otherHostCapabilities(),
      ...workflowCodeVerifierCapabilities(codeVerifier),
    ],
  }),
  verifiers: codeAvailable ? [codeVerifier] : [],
});
~~~

The named host dependencies in this example belong to the parent integration.
Register only after preflight reports available. The current service synthesizes
`available` for registered verifier actions and filters matching observations from
`policyContext`; the parent registry/host must preserve the adapter's observations
if it needs to display runtime capability invalidation. The adapter itself refuses
execution after compiler invalidation or unconfirmed child cleanup. Passing an
unavailable compiler label from a browser cannot enable it.

The output directory must already exist and be covered by the same exact recipe
scope as the inputs, for example scope `['src/feature']`. The adapter creates no
directories. If the scope names individual files, explicitly include the output
directory. It rejects sources within that output directory. The host owns directory
preparation, receipt authority, registry lifecycle, routes and project selection.

The physical root identity matches `workflowProjectIdentity`: SHA-256 of the
physical absolute root, lowercased on Windows. Both root and project ID must match
the verification request. The adapter rejects linked ancestors rather than silently
resolving a selected project to a different root. Keep one adapter per project and
host lifetime; coordinator journals provide durable attempt/idempotency control
across restart. Recreating the adapter alone must never authorize a terminal retry.

## Actual verification

1. Validate the exact request envelope and the local `verify-code` contract, with
   no provider, Studio target or human gates. Only `implementation` patch subjects
   are supported. Instructions and acceptance text do not become executable input.
2. Require 1–16 explicitly listed `.luau`/`.lua` artifacts. Every supplied artifact
   must qualify; diffs, JSON summaries and mixed unsupported subject sets cannot be
   silently skipped. Validate the set of unique hashes against
   `workflowSubjectDigest`, byte declarations, roles and component-boundary scopes.
3. Check every filesystem ancestor with `lstat` and physical-path comparison.
   Reject symlinks, Windows junctions, non-ordinary files, files with more than one
   hard link, traversal, absolute/UNC/drive-relative artifact paths, Windows device
   names, alternate streams, ambiguous Unicode and private directories. The
   private denylist covers the recipe's directories plus native provider/config,
   credential and secret directories. No discovery walk or credential file read
   occurs.
4. Open sources read-only with no-follow where the platform provides it. Compare
   descriptor/path identity, size, modification/change timestamps and hash, using
   reads capped at the declared bytes plus one. Keep descriptors open through
   compilation. Pin the compiler binary too, including its host-approved hash.
5. Preflight runs only `luau-compile --help` and validates a known compiler help
   protocol. For each source, spawn exactly the fixed executable with
   `['--null', '-O0', '-g0', absoluteValidatedSourcePath]`. Shell execution, PATH
   lookup, arbitrary flags and project test runners are unavailable. CWD is the
   fixed evidence directory. Environment inheritance is disabled; only Windows
   `SystemRoot`, when present, is retained. Stdin is ignored; stdout/stderr are
   separate bounded pipes. Windows child windows are hidden.
6. Validate normal exit and the null-mode output protocol. Only exit 0 with no
   stderr proves compilation success. Exit 1 requires recognized syntax/compiler
   diagnostics naming that exact input. Preserve only kind, line and column;
   discard messages, raw streams and timing output, which may disclose source
   content or make reports unstable. Windows slash-normalized filenames are
   supported.
7. Recheck source bytes/hashes/identities and the compiler after compilation,
   check fixed directory identities, create and hash-check the exclusive report,
   then recheck subjects again before returning the submission.

The fixed flags and expected protocol follow the official
[Luau compile CLI source](https://github.com/luau-lang/luau/blob/master/CLI/src/Compile.cpp).
Host provenance and a pinned release digest establish compiler trust; help text
alone cannot authenticate an official binary.

## Honest recipe results

The code recipe requires all five checks below. Report checks carry the SHA-256 of
the actual report artifact and the exact request `subjectDigest`; submission
`subjectHashes` is the sorted unique set of the actual supplied input hashes.

| Recipe check | Outcome from this adapter |
| --- | --- |
| `artifact-hashes` | Pass only after all source pins survive pre/post verification. |
| `syntax-types` | Unsupported when syntax compilation succeeds: type analysis was not performed. Fail when compilation returns a recognized syntax/compiler error. |
| `regression` | Unsupported; no project code or gameplay regression was executed. |
| `scope-diff` | Unsupported; containment of inputs does not prove an approved baseline/diff. |
| `security-invariants` | Unsupported; compilation does not establish server authority or gameplay security. |

A separate `syntaxCompilation` report field records the real pass/fail result.
Unknown or numeric quality requirements remain unsupported, with no invented
metric. Syntax-only success cannot make the combined `syntax-types` check pass.

The service accepts the partial submission, records a submitted attempt and keeps
the underlying task at `needs_review`. Recipe assessment remains pending because
the required checks are unsupported. Even an explicit valid human review receipt
cannot release this evidence through the service's quality guard. The adapter
never reports workflow completion.

## Bounds and unknown outcomes

| Resource | Limit |
| --- | --- |
| Supplied files / invocations per request | 16; one compile invocation per file |
| Source bytes per file / aggregate | 1 MiB / 4 MiB |
| Compiler binary | 32 MiB |
| Relative / absolute path bytes | 300 / 2048; 64 ancestor components |
| Scope entries / quality checks | 20 / 20 |
| Diagnostics per file | 128 |
| Report bytes | 64 KiB |
| Combined stdout + stderr per child | 64 KiB |
| Aggregate child output per request | 256 KiB |
| Child deadline | 1500 ms |
| Request deadline | 10,000 ms, checked between bounded operations |
| Own-child cleanup wait | 500 ms |
| Cached request identities | 64, with no eviction |
| Pre-execution read attempts | At most the recipe's bound, capped at 3 |

No retry loop exists inside the adapter. It caches terminal evidence and unsupported
outcomes by workflow instance, recipe and step, binding scope, pins, checks and
retry policy. Changing the binding rejects a replay. Cached evidence is re-pinned
before return; tampering makes it terminal unsupported without rerunning a compiler.
At capacity it refuses new identities instead of evicting terminal outcomes.

`evidence-read-busy` is reserved for an observed source read/identity race before
any compilation has started: for example, sharing/busy errors after the ordinary
file was validated or a descriptor/path/timestamp change during a bounded read.
A stable wrong hash, missing-at-entry file, permission failure, compiler fault,
adapter contention, report-write failure or any post-spawn race is unsupported.
Only a later explicit coordinator call with unchanged bindings may retry a busy
read, within the recipe bound. Compiler execution is never automatically retried.

Deadlines, output overflow, signals, unknown exits, unknown diagnostics, malformed
output and spawn errors never establish compilation success. The adapter kills
only its own `ChildProcess` with `SIGKILL` and waits for its close event. It uses no
taskkill command, process-group signal, Studio action, protection change or shared
process cleanup. If close cannot be confirmed within 500 ms, it returns unsupported,
releases its own pipes/reference and permanently disables the adapter. It cannot
claim that an unconfirmed child was successfully cleaned up.

Reports are `luau-verify-<random UUID>.json`, created with `O_CREAT | O_EXCL` and
mode 0600. Their bounded JSON bytes are deterministic for the same request,
compiler and observed results; unique filenames are excluded from report contents.
No existing output is overwritten. Partial/unused files after a write or post-write
validation failure are retained for host inspection, never submitted or deleted.
This adapter performs no unlink, recursive delete, autosave, source write, upload,
model turn, native Studio action or protection change.

The byte/count bounds do not constitute an OS memory quota for the trusted compiler.
Synchronous bounded filesystem calls cannot be forcibly interrupted. Direct filename
compilation with held read descriptors and pre/post checks detects observed races;
it is not an OS-enforced immutable snapshot against an adversarial concurrent
filesystem writer. The host must keep the trusted executable and selected tree
stable during verification. These limitations are recorded in each report.

## Proofs and isolated validation

All simulated-process tests explicitly start with **compiler double:**. They use
real bounded temporary filesystem pins and reports while replacing only the compiler
process boundary (and explicitly labelled read/write race hooks). They cannot be
reported as proof that an official compiler ran.

The suite covers fixed spawn options/environment, deterministic exclusive reports,
correct SHA/byte/subject bindings, unsupported recipe checks, hardlinks/junctions,
scope/path/private-directory rejection, structural bounds, legitimate read races,
terminal failures, unchanged retry limits, compiler mutation, output overflow,
deadline/unknown cleanup, signals/protocol errors, report tampering, cache capacity
and caller mutation. The WorkflowService integration case uses actual SQLite
journals and report bytes with synthetic offline human receipts/catalogues; it
proves partial evidence submission and refusal of release.

The separately labelled **REAL OFFICIAL COMPILER:** test reads
`ARCANE_TEST_OFFICIAL_LUAU_COMPILER` from the test host only. Without that explicit
test environment setting it skips visibly. It compiles two pinned valid
`.luau`/`.lua` files, including source containing an error and infinite loop that
must never run, and an invalid-syntax file. It verifies input/compiler preservation,
report bytes/hashes and the recipe blockers. No fixture executable is substituted.

Scoped proof on 2026-10-12:

- Official executable:
  `C:/Users/alexk/AppData/Local/Temp/arcane-luau-tools/luau-compile.exe`.
- SHA-256:
  `74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8`.
- TypeScript compiled the two assigned source/test files and required imports using
  an explicit file list, the repository's strict options and Node type definitions,
  writing only to a unique temporary `dist`.
- Compiler-double suite: 28 tests passed, including subtests and the actual
  WorkflowService submission/blocked-release case. Official-compiler suite: one
  test passed with no skip. Both ran separately with Node's test runner and
  concurrency 1. No shared root build/package/test command ran.

For another host, create an isolated TypeScript configuration extending the repository
config with `include: []`, `exclude: []`, explicit `files` for these two files,
absolute `typeRoots`, repository `rootDir`, and a unique temporary `outDir`.
Set that output's package type to module. Run only the emitted
`tests/unit/workflow-code-verifier.test.js` with these separate name filters:

~~~text
--test-name-pattern=compiler double:
--test-name-pattern=REAL OFFICIAL COMPILER:
~~~

The parent owns registry/host/routes and capability publication. This change owns
only the new adapter, its tests and this document.