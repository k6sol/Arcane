# Workflow file evidence builder

`apps/daemon/src/workflow-evidence-builder.ts` exports the synchronous, host-only API:

```ts
prepareWorkflowFileEvidence({
  projectPath: string,
  step: WorkflowStep,
  inputArtifacts: readonly PinnedWorkflowArtifact[],
  files: readonly { path: string; role: ArtifactRole }[],
  excludedRoots: readonly string[],
}): WorkflowSubmission
```

The result is detached, frozen metadata only:

```ts
{
  key: step.key,
  artifacts: [{ path, role, sha256, bytes }], // sorted by relative path
  subjectHashes: [/* sorted, unique, actual verified input SHA-256 values */],
  checks: [],
}
```

The host must authorize the human request and supply the canonical trusted project, current step, actual service-pinned input metadata, and every Arcane state/receipt root to exclude. The helper cannot authenticate those metadata origins or determine whether a supplied otherwise-valid project is the authorized project. It grants no approval, native execution, review, receipt, association, or handoff authority. Parent service/host/routes integration remains separate.

## Bounds and evidence semantics

- New outputs: 1–20 files and at most 16 MiB aggregate, using `WORKFLOW_LIMITS`. Nonempty regular files only. Their role set must exactly match `step.quality.roles`; output paths and output SHA-256 digests must be unique.
- Trusted inputs: at most 24 declared subject steps, each with at most 20 artifacts and 16 MiB aggregate. Every declared subject requires pins; undeclared subject pins are rejected. Input metadata is bounded to 480 entries, independently of the 20 new outputs.
- Repeated input paths across distinct subject steps/roles are allowed only with identical expected SHA-256 and byte counts. They share one actual file descriptor and are rehashed against every supplied pin. Duplicate `(stepKey, path)` entries or conflicting pins are rejected. Windows path identity is case-insensitive.
- At most 500 distinct files are opened. Actual distinct bytes are additionally capped at `(declaredSubjectSteps + 1) * 16 MiB` (400 MiB maximum). Expected input sizes must match actual sizes before content reads. Each input step's declared byte budget and the outputs' actual byte budget remain independent.
- Reads use at most 64 KiB of working buffer at a time. The bounded file set is hashed twice to detect earlier files changing while later files are read. No file bytes are included in the result or raw error messages.
- Outputs must remain under an exact current step scope (component boundary or direct file scope). Subject files may be outside that output scope, but must remain inside the trusted project and obey all exclusions and safety rules. Their supplied hashes are not trusted without reading and matching the actual files.
- Local-verification execution and any nonempty required quality-check list are rejected. `checks: []` is intentional; hashes and byte counts do not invent quality checks.

## Read-only and fail-closed filesystem checks

The builder never creates directories, writes files, starts processes, invokes a CLI/provider/Studio, or reads provider credentials. It rejects private/config/provider directory and filename patterns, credential extensions, excluded roots, absolute artifact paths, traversal, UNC/device/ADS syntax, unsafe Unicode, and ambiguous path components. Relative paths are limited to 300 UTF-8 bytes; absolute project/exclusion paths to 4,096 bytes; path depth to 64; excluded roots to 64. The project must be a canonical local absolute non-root directory. Exclusions may be absent, but existing exclusions must be ordinary directories.

Every existing ancestor, including those above the project, is checked using `lstat` and native physical-path equality. Symbolic links, junctions/redirected physical ancestors, hard-linked files, and nonregular files are rejected. All content descriptors are opened read-only. Descriptor/path identity, size, high-resolution modification/change times, physical ancestors, and the whole selected set are checked before/after reads; growth, shrinkage, replacement, changed pins, and later-file/earlier-file races fail closed. All opened descriptors are closed on success or failure.

Inputs must be bounded own-data objects and dense arrays. Unknown fields, accessors, proxies, hidden/symbol fields, and incompatible metadata are rejected without invoking user accessors. The helper does not replace recipe/service authority checks or an OS sandbox against malicious local processes; no filesystem sequence can guarantee an indefinitely stable snapshot after return. The service must retain its own pin/revalidation rules.

Failures use existing `ArcaneError` codes: `WORKFLOW_INPUT` for malformed metadata, `WORKFLOW_VERIFIER` for unsupported verification requirements, and `WORKFLOW_EVIDENCE` for unsafe/changed/out-of-bounds files or conflicting pins. Filesystem error paths and contents are not echoed.

## Focused offline proof

`tests/unit/workflow-evidence-builder.test.ts` uses owned temporary filesystem fixtures only. It covers actual hashes/bytes, frozen detached output, exact roles/scopes, trusted input rehashing, separate per-subject budgets, repeated-path coalescing and conflicting pins, output count/byte limits, strict parsers, private/excluded roots, links/native ancestor equality, descriptor closure, and actual file mutations/replacement/read races. No live provider, credentials, native model, Studio, Git, approval, or execution is exercised.

### Validation result (2026-10-12)

Dependency-closed strict TypeScript compilation of the actual source and focused test passed with no diagnostics. It extended the repository's strict `tsconfig.json` and emitted only into the owned temporary check directory `C:/Users/alexk/AppData/Local/Temp/arcane-workflow-evidence-check-94bb7dab7f1f4112bf72c5abb53bf3e2/out`, using an existing TypeScript native compiler from the clean-build dependency directory (the main checkout's launcher had a missing executable). No dependencies or shared build outputs were changed.

```text
node --test --test-concurrency=1 <owned-check>/out/tests/unit/workflow-evidence-builder.test.js
21 tests; 21 passed; 0 failed; 0 skipped (5.35 seconds)
```

The corrected tests include 40 subject artifacts plus 20 outputs, two input subject byte budgets totaling more than 16 MiB, identical cross-subject paths opened once, and rejection of conflicting hashes/byte counts and duplicate same-subject paths. Only the builder, its focused test, and this document are in this worker's source write scope. No security guard was relaxed.
