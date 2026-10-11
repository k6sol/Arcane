# Local asset pipeline and HTTP handoff

The starter pipeline executes two bundled static templates: `hero-prop` (a framed carrying case with a reduced LOD) and `environment-kit` (floor, wall, pillar, step). It is not an arbitrary prompt-to-model or Python execution API. It uses the installed Blender CLI with factory startup, autoexec disabled, two threads, and CPU Cycles.

## Parent integration

The daemon service factory and HTTP handler are ready for the parent to integrate. This work does not edit `lab-server.ts`, shared protocol/stores, the installer, or Studio.

```ts
import { createAssetService } from './asset-service.js';
import { assetRoutes } from './asset-routes.js';

const assetService = await createAssetService({
  cwd: repoRoot,             // trusted installation root
  projectPath,               // selected project may be elsewhere
  // outputRoot defaults to repoRoot/runtime/assets
  // workerRoot defaults to repoRoot/workers/blender
});
const handleAssets = assetRoutes(assetService);

// Inside the parent's bound loopback server:
if (await handleAssets(request, response, url, controlToken, origin, agentToken)) return;

// During shutdown, before disposing the service:
await assetService.close();
```

`createAssetService` is asynchronous. Paths and executable/deadline overrides are trusted launch configuration, never HTTP input. The route factory needs no second `cwd` argument. Its returned handler is `(request, response, url, controlToken, origin, agentToken?) => Promise<boolean>`.

Both the distinct control and agent bearer are accepted on these six asset routes. Exact Origin is required whenever the header is present; native clients may omit it. The supplied host/origin must be the literal `http://127.0.0.1:PORT`, and the connection must come from loopback. This module contains no grant, review, arbitrary evaluation, install, upload, or publication methods.

| Method and route | Input | Output |
| --- | --- | --- |
| POST `/v1/assets/probe` | `{}` | 200 `{probe}` |
| GET `/v1/assets/jobs` | none | 200 `{jobs}` |
| POST `/v1/assets/start` | `AssetInput` below | 202 `{job}` |
| POST `/v1/assets/cancel` | `{jobId}` | 200 `{job}` after native exit |
| GET `/v1/assets/manifest?jobId=UUID` | known job ID | 200 `{manifest}` after verification |
| GET `/v1/assets/preview?jobId=UUID&path=preview-hero.png` | one of two fixed preview names | 200 raw authenticated `image/png` bytes |

The other permitted preview is `preview-side.png`. Browser clients should fetch the PNG with a bearer and use the returned blob. Tokens are never query parameters. Unknown/duplicate query keys and unexpected body fields fail. POST bodies have a 16 KiB byte limit and an absolute eight-second deadline, including chunked/slow uploads. Errors use `{error,message}`.

Busy supervision is a normal 409 response. Cancellation waits for process close and preserves partial output/checkpoints. Repeated cancellation of a terminal job returns its recorded state. Cancellation racing completed generation can return `succeeded`; it never rewrites completed success as cancelled. A job includes `schemaVersion`, `jobId`, computed `directory`, `request`, `state`, real `stage`, observed `events`, timestamps, `manifestPath`, `manifestAvailable`, and `error`. Success and verified manifest availability become visible together.

```json
{
  "template": "hero-prop",
  "name": "supply-case",
  "seed": 1,
  "sizeMeters": [1, 0.65, 0.7],
  "color": [0.12, 0.32, 0.27],
  "triangleBudget": 5000,
  "renderResolution": 384,
  "renderSamples": 16
}
```

Only `template` and `name` are required. Names are lowercase safe slugs of at most 48 characters; Windows device names, traversal, stream syntax and executable/script fields are rejected. Bounds: seed 0..2147483647; each size 0.1..20 metres; color channels 0..1; triangle budget 100..50000; render resolution 128..1024; samples 4..64. Environment size defaults to `[3,3,2.8]`. An insufficient triangle budget produces failure.

## Evidence and durable history

Each job gets a fresh fixed-output-root directory, UUID, authoritative `job.json`, normalized request, copied worker scripts, and a retained blockout checkpoint. Successful jobs additionally get saved scene, GLB/FBX, separate collision GLB, hero LOD GLB when applicable, two PNG review views, audit, and manifest. Manifest artifact names/roles are restricted to bundled outputs, with byte counts and SHA-256 hashes. No client-supplied absolute file path is read.

Audits gate manifold topology, loose/duplicate/degenerate geometry, winding, finite coordinates, applied scale/rotation, UV completeness and finite/nondegenerate UVs, material naming/counts, triangle budgets, preview variance, export reimport triangle counts, and full saved-scene mesh equality after reopen. Host verification independently parses actual GLB vertex/normal/index buffers and triangle areas, checks PNG CRCs and decoded nonuniform pixels, and verifies all artifact hashes plus original request/audit evidence. Deep validation reopens the scene in Blender and compares every measured mesh.

History is indexed in atomic `index.json`. Startup rebuilds authority from at most 256 direct job directories, verifies successful manifests and journal/job identities, and restores up to 64 observed stage events per job from the bounded advisory index. Stored index paths and states never direct reads or override journals. The scan is bounded to 1024 directory entries. Corrupt successful evidence is reported as failed integrity rather than a usable manifest.

A retained `running` journal becomes `interrupted` with `SUPERVISION_LOST`; it is not replayed. The old native process could still exist, so generation in that root is blocked pending inspection. There is no automatic resume or overwrite. Use a fresh trusted output root after confirming an old worker has stopped. Each Node process admits one Blender operation across pipeline instances, and one service actor per output root. This is cooperative supervision, not an OS sandbox or a mutex between independent daemon processes.

Preview delivery rereads only fixed manifest-approved PNGs, requires regular files with one hard link, refuses symlink/junction ancestors, bounds allocation, checks the opened file's identity/size/metadata before and after reading, and hashes the exact returned bytes. Even a same-sized modification is refused. Responses are no-store; preview responses are PNG with `nosniff`.

## Verification commands

With the parent's existing dependencies installed, compile only the scoped modules into the ignored package runtime directory:

```powershell
node node_modules/typescript/bin/tsc --ignoreConfig --target ES2023 --module NodeNext --moduleResolution NodeNext --rootDir . --outDir packages/asset-pipeline/.runtime/compiled --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck --types node packages/asset-pipeline/src/index.ts apps/daemon/src/asset-service.ts apps/daemon/src/asset-routes.ts tests/unit/assets.test.ts tests/unit/asset-http.test.ts
node --test packages/asset-pipeline/.runtime/compiled/tests/unit/assets.test.js packages/asset-pipeline/.runtime/compiled/tests/unit/asset-http.test.js
node workers/blender/verify.mjs
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

Unit suites use explicitly synthetic fixture bytes for validation/controller tests. The native runner loads no synthetic fixture. It probes installed Blender, generates both templates and repeated hero geometry, deep-audits real scenes, compares GLB hashes, cancels a native render, tests deadline/budget failure, serves real PNGs through both tokens, refuses altered bytes, and verifies restart history. Each run retains `packages/asset-pipeline/.runtime/verification-UUID/acceptance.json`.

Final verification: **32/32 scoped unit and HTTP tests passed**, and the repository-wide TypeScript check passed. The final service recovered seven retained jobs, reverified four successful manifests, and matched the current bundled worker digests to native evidence.

Observed native acceptance on 2026-10-11: Blender **4.5.3 LTS**, embedded Python **3.11.11**; all five import/export/Cycles capabilities passed. Successful evidence directory:

`packages/asset-pipeline/.runtime/verification-81e000dc-ca19-4e3b-a7da-24f029bf1dc2/`

| Template | Render tris | LOD1 tris | Collision tris | Materials | Main GLB SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- |
| hero-prop | 1080 | 480 | 12 | 3 | `517de97816254424edd7800e258510920c50095000e2ee9b00a2167c1a3dcb18` |
| environment-kit | 432 | 0 | 48 | 3 | `b878640f9b7b79802ef870d0529f77aa34163cca93863788d90ed2b36a7d0639` |

Hero job `43ff6d56-fe95-45b2-92d2-405e136c4d7b` and environment job `4171541c-3d76-4e4b-aeb2-8d9f8ec85d98` contain their own manifests, geometry audits and hero/profile PNGs. Repeated hero main/collision/LOD GLBs matched byte hashes. BLEND/FBX files include run-specific metadata or paths; bit identity for those formats is not claimed. Both formats passed actual Blender reimport triangle/coordinate checks.

Native cancellation returned `cancelled` and recovered a blockout checkpoint. Deadline returned `timed_out` without a usable manifest; a 100-triangle budget failed the actual mesh audit. Native HTTP job `dbd64682-12fb-49a2-be40-52bc0a17eab7` passed PNG-byte equality through control and agent tokens and refused a modified preview. Restart loaded seven jobs, including four verified successes, with observed HTTP stages retained.

Visual QA: **SHIP WITH NOTES for the two static starter templates.** Hero and profile renders were opened and reviewed; carrying-case silhouette/handle and module separation are readable. The side view has a minor backdrop-edge artifact, and the environment is a demonstration assembly with common floor pivots. UV overlap/packing/texel density, inter-object contacts, target-engine materials, scale mapping and collision behavior need production review. This worker performed no Studio/Roblox import, plugin install, upload, or Hunted modification. Exports are listed and hashed for a future parent-owned download/import route.

## Changed paths in this work

- `packages/asset-pipeline/src/index.ts`
- `packages/asset-pipeline/src/types.ts`
- `packages/asset-pipeline/src/paths.ts`
- `packages/asset-pipeline/src/validation.ts`
- `packages/asset-pipeline/testing/fixture.ts`
- `packages/asset-pipeline/.gitignore`
- `workers/blender/asset_worker.py`
- `workers/blender/verify.mjs`
- `workers/blender/.gitignore`
- `apps/daemon/src/asset-service.ts`
- `apps/daemon/src/asset-routes.ts`
- `tests/unit/assets.test.ts`
- `tests/unit/asset-http.test.ts`
- `docs/build/ASSETS.md`

Generated evidence is retained under the ignored package `.runtime/`. Root dependencies, protocol, stores, shared server/routes, Studio fixture and installer are outside these edits. No Git commit/push was made.
