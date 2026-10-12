# Local asset pipeline and custom recipe contract

The pipeline accepts the bundled `hero-prop` and `environment-kit` templates plus `custom-assembly`. Custom assets are built from caller-supplied JSON geometry, transforms, PBR materials, explicit roles and sockets. The worker runs installed Blender with factory startup, autoexec disabled, two threads and CPU Cycles. Client Python, eval, imports, file paths, URLs, shell commands and external asset references are not accepted.

## Daemon integration

`createAssetService({cwd, projectPath?, outputRoot?, workerRoot?, blenderExecutable?, pythonExecutable?, jobDeadlineMs?})` is asynchronous. These are trusted host options; HTTP clients cannot supply them. The output root defaults to `cwd/runtime/assets`, and the fixed worker root to `cwd/workers/blender`. The selected project does not select worker code.

`assetRoutes(service)` returns `(request, response, url, controlToken, origin, agentToken?) => Promise<boolean>`. The parent calls it inside its bound loopback server and calls `await service.close()` on shutdown. Both distinct bearers are accepted except artifact downloads, which require the human control bearer. Host must be the exact literal `127.0.0.1:PORT`; Origin must match when present. Preview clients fetch authenticated PNG bytes and create a blob URL; tokens are never query parameters.

| Route | Input | Result |
| --- | --- | --- |
| POST `/v1/assets/probe` | `{}` | 200 `{probe}` |
| POST `/v1/assets/start` | `AssetInput` | 202 `{job}` |
| GET `/v1/assets/jobs?limit=32&after=UUID` | optional limit/cursor | 200 `AssetJobPage` |
| POST `/v1/assets/cancel` | `{jobId}` | 200 `{job}` after native exit |
| GET `/v1/assets/manifest?jobId=UUID` | indexed UUID | 200 `{manifest}` after file verification |
| GET `/v1/assets/preview?jobId=UUID&path=preview-hero.png` | one of two fixed names | raw `image/png` |
| GET `/v1/assets/artifact?jobId=UUID&path=asset.glb` | exact indexed UUID and approved basename; human bearer | verified attachment bytes, at most 64 MiB |

The other preview is `preview-side.png`. Query keys must be unique and exact. All POST bodies have an absolute eight-second deadline. Fixed template bodies and control bodies are limited to 16 KiB; only custom start bodies may use 256 KiB. Normalized custom requests also must fit 256 KiB. Rejected complete small uploads leave the connection reusable; oversized or stalled rejected uploads have bounded discard and connection closure. Error responses are `{error,message}`. Invalid input is 400, authentication 401, host/origin 403, unknown job/cursor 404, busy/state/history/reconciliation 409, body limit 413, body deadline 408, and retained artifact/hash/manifest integrity failures 422.

## Human artifact downloads

Fetch `GET /v1/assets/artifact?jobId=<exact-job-UUID>&path=<manifest-artifact-basename>` with `Authorization: Bearer <human-control-token>`. Both query keys are required, unique and exact; no additional keys or request body are accepted. The agent bearer is denied with 401, including a configuration that reuses it as the human bearer. Host and optional Origin must match the exact daemon origin. Optional Referer must have that origin and no URL credentials. `Sec-Fetch-Site`, when present, must be `same-origin` or `none`; cross-site and same-site browser requests are refused with 403.

| Exact basename | Required manifest role | Content-Type |
| --- | --- | --- |
| `asset.glb` | `export` | `model/gltf-binary` |
| `collision.glb` | `export` | `model/gltf-binary` |
| `asset-lod1.glb` | `export`, only when present | `model/gltf-binary` |
| `asset.fbx` | `export` | `application/octet-stream` |
| `asset.blend` | `scene` | `application/octet-stream` |

Only these current pipeline outputs are downloadable. OBJ/MTL are not produced by this pipeline. Checkpoints, PNG previews, scripts, journals, request/audit JSON and arbitrary paths or URLs are rejected. Every download requires `succeeded` and a verified available manifest, and reruns the existing complete manifest, artifact hash and structural evidence checks. The returned bytes must match the exact manifest size and SHA-256. The manifest and artifact are pinned across verification and rereading: symlinks/junctions, hardlinks, identity replacements, size/timestamp changes and disappearing evidence fail explicitly. A changed or missing manifest never falls back to files currently on disk.

Responses use `Content-Disposition: attachment; filename="<safe-fixed-basename>"`, exact Content-Length, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin` and restrictive CSP. The browser client can fetch the bytes, create a blob URL, and use the approved basename for the save action. No bearer belongs in a URL. Download GET performs no Blender generation/probe/deep validation, Studio import, inference, remote URL fetch or mesh execution.

Each artifact is capped at 67,108,864 bytes (64 MiB). Oversized files fail before download allocation/full manifest validation with 413 `ARTIFACT_LIMIT`. One download is admitted per mounted route through verification and socket delivery; concurrent requests receive 409 `BUSY`. Verification and delivery have an absolute 30-second deadline: 408 `ARTIFACT_TIMEOUT` before headers, or a closed connection if delivery already began. A timed-out filesystem operation retains admission until it settles, preventing repeated allocations. Job-state errors are 409; retained hash/manifest/file-integrity errors are 422. The service method is required: `artifact(jobId, path): Promise<{bytes: Buffer; filename: string; contentType: string}>`. MCP exposes no download tool.

## Contract for MCP agent Maxwell (apps/mcp only)

The existing `AssetInput`, `AssetRequest`, `AssetJobRecord` and manifest `schemaVersion: 1` remain. The jobs envelope now adds explicit pagination without changing a job's request shape:

```ts
interface AssetJobPage {
  schemaVersion: 1;
  jobs: AssetJobRecord[];  // complete normalized requests, including complete custom recipes
  total: number;          // 0..256 retained jobs
  nextCursor: string | null;
  byteLimit: 524288;
}
```

`limit` is 1..64 (default 32). The 512 KiB UTF-8 response cap can return fewer jobs than the count limit. Follow `nextCursor` via `after` until null. It is the UUID of the last returned record. Order is descending immutable `startedAt`, then descending UUID. Concurrent new jobs appear ahead of a previous cursor and can be obtained by refreshing the first page. Unknown cursors fail with 404. No recipe, artifact, socket or stage evidence is silently removed from a returned job. The service's `jobPage({limit?,after?})` implements the HTTP contract; `jobs()` remains the internal complete snapshot. Single start/cancel responses contain the complete job.

MCP output parsers must preserve these newly measured custom mesh fields. Stripping them before calling shared `validateAudit` makes valid custom manifests fail:

```ts
position?: [number, number, number];  // custom parts require [0,0,0] floor origin
geometrySha256?: string;             // custom parts require SHA-256
bounds?: { min: Vec3; max: Vec3 };    // transformed measured world bounds
materialProperties?: {
  name: string;
  color: Vec3;
  metallic: number;
  roughness: number;
  emission: { color: Vec3; strength: number };
}[]; // one entry for render/LOD; [] for collision
```

These fields are optional at the general schema level for compatibility with retained fixed-template manifests; custom audit validation requires them. Existing `exports[].sockets`, `validation.assembly`, manifest `assembly` and `sourceRequestSha256` also must survive parsing. The authoritative public types are `packages/asset-pipeline/src/types.ts`; the input JSON Schema is `packages/asset-pipeline/assembly.schema.json`. Reuse `normalizeRequest` for semantic preflight; JSON Schema alone cannot prove topology or cross-references. Never replace custom input with fixed defaults or remove a recipe to make a schema parse. The exact native example is `workers/blender/custom-machine.json`.

The delegated MCP agent's current schemas were compiled into ignored package output and checked against the actual native manifest, original custom input and paginated complete recipe. All parsed without dropping evidence; the parsed manifest matched the source exactly, including position and materialProperties. No apps/mcp source was edited by this asset worker.

## Data-only custom recipe

A custom input requires `template: "custom-assembly"`, a safe slug `name`, and `recipe`. Seed, render settings and triangle budget are optional. Custom `sizeMeters` and `color` are derived from recipe bounds/first material; clients cannot override them. A normalized request includes `schemaVersion: 1` and may be replayed only with matching derived values.

| Recipe item | Shape and bounds |
| --- | --- |
| Recipe | `schemaVersion: 1`; 2..96 parts; 1..8 materials; 0..64 sockets |
| Material | unique safe slug `id`, RGB `color` in 0..1; metallic/roughness 0..1 (defaults 0 / 0.5); optional emission color and strength 0..10 |
| Part | unique safe slug `name`; role `render`, `collision` or `lod1`; geometry, dimensions and position required |
| Geometry | `box`; `cylinder` / `cone` with 8..64 segments divisible by four (default 24); `sphere` with those segments and 4..32 rings (default 12); or indexed triangle `mesh` |
| Mesh | 4..4096 vertices inside unit cube [-0.5,0.5]; 4..8192 triangles; flat complete triangle indices; no external buffers |
| Transforms | dimensions scale the unit geometry and are 0.01..20 m per axis; position -40..40 m; optional XYZ Euler `rotationDegrees` -360..360, default zero |
| Bevel | optional for render/LOD box/cylinder/cone; width 0.00001..10% of smallest dimension; 1..3 segments (default 1) |
| Socket | unique safe slug name; kind `socket` or `attachment`; reference to a render part; local metre position -20..20 and optional XYZ rotation |
| Budgets | render 100..50000 (custom default 15000); collision 12..4096 (default 2048); LOD 12..render budget (default render budget) |

Safe slugs are lowercase ASCII, start with a letter, allow digits/hyphens and are at most 48 characters; Windows device names are rejected. Render and collision roles are mandatory. LOD is optional and must reduce total render geometry when supplied. Render/LOD parts reference a declared material; collision has no material or bevel. Unused materials, duplicate identifiers and missing references fail.

Preflight snapshots plain JSON without invoking getters/toJSON, bounds bytes/nodes/depth, and validates all counts, finite values, mesh indices, duplicate/collapsed/degenerate triangles, closed consistently wound edge incidence, manifold vertex fans and positive volume for every connected component. It conservatively budgets bevel triangles and vertices, limiting the aggregate vertex estimate to 20,000. Render geometry must touch Z=0 and fit within 40 m on each world axis; all geometry/socket positions must remain within +/-60 m. Preflight happens before output creation/native launch. No arbitrary script execution is exposed.

Part geometry is baked into mesh coordinates with floor origin, unit object scale and zero object rotation. Socket offsets use the part's rotation and translation, without multiplying by part dimensions. Evidence matrices are row-major 4x4 Blender Z-up world matrices in metres. Named nodes use `SOCK_` or `ATT_`; render/LOD meshes use `SM_`, collision meshes `COL_`, materials `MAT_`. GLB and FBX use Y-up export settings and are imported back into Blender for socket comparison.

## Evidence, supervision and retained history

Each job uses a fresh UUID directory, authoritative compact `job.json`, original `input.json`, normalized `request.json`, copied fixed scripts and a blockout checkpoint. Custom jobs additionally copy `assembly.py` and retain `assembly.json`. Successful jobs contain `asset.blend`, GLB/FBX, separate collision GLB, optional LOD GLB, two PNGs, audit and manifest. Artifact names/roles, byte counts and SHA-256 hashes are checked; the original input digest and normalized recipe digest bind request provenance. Full recipes remain in the journals, request files and per-job manifests.

The atomic advisory index now stores only `{jobId,events}` records under the existing `schemaVersion: 1`. Startup remains compatible with prior fuller index records; only bounded observed events are used. It rebuilds authority from at most 256 direct job directories (scan bound 1024 entries), verifies journal identities and successful manifests, and restores up to 64 observed events per job. Stored index paths, requests and states do not direct reads or override journals. No retained journal or manifest is truncated. History full/scan overflow reports an explicit error and requires a fresh trusted output root.

Structural gates cover topology, winding, finite coordinates, applied transforms, UV completeness/finite areas, named connected PBR materials and budgets. Custom gates additionally compare part roles, names, counts, geometry digests, transformed bounds, floor origins and measured numeric PBR inputs to the recipe, plus socket matrices in the saved scene and both render exports. Export audits reimport actual GLB/FBX/collision/LOD bytes. Host checks independently parse GLB position/normal/index buffers and triangle areas, PNG CRCs and decoded pixel variation, and all artifact hashes. Deep validation reopens the saved scene with autoexec disabled and compares every measured mesh and assembly/socket evidence.

Cancellation/deadline termination waits for native process close and preserves partial output. A lost running journal becomes `interrupted`/`SUPERVISION_LOST`, blocks new jobs in that root, and is never replayed. A caller wait timeout is not proof the worker stopped; inspect live processes before considering a new native run. One Node worker admits one Blender operation across pipeline instances; one service actor owns each output root in that process. This is supervised execution, not a sandbox for arbitrary Python or an OS-wide mutex.

Preview reads only fixed manifest-approved files, refuses linked files/ancestors, bounds allocations and checks the opened file and exact returned bytes. No install, upload, publish, inference, Studio test/import or Hunted work occurs in this component.

## Verification

Compile scoped source into the ignored package runtime, using existing dependencies:

```powershell
node node_modules/typescript/bin/tsc --ignoreConfig --target ES2023 --module NodeNext --moduleResolution NodeNext --rootDir . --outDir packages/asset-pipeline/.runtime/compiled --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck --types node packages/asset-pipeline/src/index.ts apps/daemon/src/asset-service.ts apps/daemon/src/asset-routes.ts tests/unit/assets.test.ts tests/unit/asset-http.test.ts
node --test packages/asset-pipeline/.runtime/compiled/tests/unit/assets.test.js packages/asset-pipeline/.runtime/compiled/tests/unit/asset-http.test.js
node workers/blender/verify-custom.mjs
node workers/blender/verify.mjs
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

Inspect relevant live test/Blender processes before launching native acceptance. Native runners load no synthetic asset fixture. Unit/controller tests explicitly use synthetic data where appropriate.

Current scoped tests: **41/41 passed**; repository-wide TypeScript **passed**. They exercise custom preservation/preflight/mesh topology/PBR/socket gates, rejection of executable fields, source snapshots, custom HTTP body limits, full-recipe restart, byte/count pagination, existing integrity checks, process supervision and request deadlines.

Actual custom acceptance: installed **Blender 4.5.3 LTS**, embedded **Python 3.11.11**, all import/export/Cycles capabilities verified. Bespoke induction press: **19 named meshes** (10 render, 2 collision, 7 LOD), **4 PBR materials**, **1,102 render / 116 LOD / 56 collision triangles**, **2 sockets/attachments**. GLB, FBX, collision and LOD exports reimported; original scene reopened; separate native deep validation passed. Actual GLB numeric PBR factors and named render/collision/LOD nodes with preserved role/part extras were checked independently. Both preview files matched through both bearers; tampered bytes were refused. Service restart recovered the full custom recipe.

Retained evidence: `packages/asset-pipeline/.runtime/custom-verification-6ee38b20-5cd5-4f8e-bef4-1b4cd923f178/acceptance.json`; manifest: `induction-press-a03b713c-da0d-4097-8bfd-8fc5e1533c42/manifest.json` under that directory. Both 384 px preview views were opened and inspected: housing, wheel, piston, orange guard and control lamp read clearly. This validates a data-driven mechanical assembly and its interchange evidence. It does not establish artistic fidelity to an external reference, self-intersection freedom, UV packing/texel density, target-engine PBR fidelity, Roblox scale/collision behavior or Studio import. Manifest `artisticFidelity` and `robloxImport` remain `unverified`.

Existing-template native regression acceptance also passed: both templates and repeated hero GLB determinism, real saved-scene deep audits, cancellation/checkpoint recovery, deadline termination, actual budget rejection, both-bearer HTTP preview integrity and seven-job restart (four verified successes). Retained current evidence: `packages/asset-pipeline/.runtime/verification-9b7d908a-e40d-4577-bdfa-196df57a2adb/acceptance.json`.

## Paths changed by this continuation

- `packages/asset-pipeline/src/types.ts`
- `packages/asset-pipeline/src/recipe.ts`
- `packages/asset-pipeline/src/validation.ts`
- `workers/blender/audit.py`
- `workers/blender/custom-machine.json`
- `workers/blender/verify-custom.mjs`
- `apps/daemon/src/asset-service.ts`
- `apps/daemon/src/asset-routes.ts`
- `tests/unit/assets.test.ts`
- `tests/unit/asset-http.test.ts`
- `docs/build/ASSETS.md`

Existing custom builder, orchestration and input schema edits were inspected and preserved. Generated compile/test/native output is retained only under the ignored package runtime and normal temporary probe/test directories. No root package/lock, shared server/protocol/store, UI or MCP client source was changed by this continuation. The broader project goal remains incomplete; Studio testing remains deferred by the user.
