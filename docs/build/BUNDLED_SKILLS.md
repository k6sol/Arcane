# Bundled MCP skills and code authority

The old MCP registry imported `PROJECT/scripts/skill-pack.mjs` and read
`PROJECT/skills/registry.json`, where `PROJECT` came from `--project`. This was a
critical code-authority bug: requesting a skill could execute an untrusted user
project's JavaScript inside the MCP process holding its daemon bearer. It also
prevented an empty arbitrary workspace from loading Arcane's bundled skills.

`--project` identifies the execution workspace. It does not authorize that
workspace to provide executable skill code, registry approval metadata, skill
text or references. Production `SkillRegistry` now derives all of those from
its own module location, independently of the workspace, cwd and environment.
There is no search through parent bundles and no project-module fallback.

## Physical bundle layout

| Running MCP module | Fixed skill bundle root |
| --- | --- |
| `ROOT/dist/apps/mcp/src/skills.js` | `ROOT` |
| `BUNDLE/resources/product/dist/apps/mcp/src/skills.js` | `BUNDLE/resources/product` |
| `ROOT/apps/mcp/src/skills.ts` | `ROOT` |
| `ROOT/apps/mcp/.test-build/apps/mcp/src/skills.js` | `ROOT` (existing focused TypeScript test output) |

The parser is always `scripts/skill-pack.mjs` in that bundle. The default data
root is the same bundle, with `skills/registry.json` and its declared content.
Paths become file URLs with `pathToFileURL`; spaces, `#` and `%` in installation
directories cannot reinterpret the module URL. Missing code or data fails closed.

Before importing the parser, MCP checks the running registry module, the fixed
parser file and the selected registry file with `lstat` and `realpath`. Each
file must be regular, have exactly one hardlink and fit the existing 128 KiB
bound. Every parent directory must be direct and canonical. Symlinks, Windows
junctions, canonical redirects and hardlinks fail with `BUNDLE_INTEGRITY`;
missing files retain their filesystem error. OneDrive file attributes alone do
not decide whether a path is a redirect.

## Integrity and skill policy

`scripts/create-local-release.mjs` inventories the named `dist`, `scripts` and
`skills` roots together. Its source-release checks include exact SHA-256 bytes,
compiled-source provenance, direct paths, single-link files and copy stability.
`scripts/package-windows.mjs` projects that release into `resources/product`,
retains the source manifest and verifies the deployment inventory. Its exclusion
of tests and mutable state does not remove the bundled parser or skill data.
No packaging script or acceptance manifest was changed for this fix.

The MCP path checks preserve that physical-root design; they do not replace
release verification or authenticate a publisher. The release inventories are
unsigned, and MCP does not reverify the entire release manifest on every call.
The launcher must select an already trusted, accepted bundle and keep its
immutable payload protected from concurrent replacement. Skill-content hashes
alone cannot establish trust in executable parser code or registry approvals.

MCP continues to use the existing bundled parser, approval validation,
SHA-256 checks, metadata consistency checks, contained-file reader and byte
budgets. Approved-only remains the default. Experimental entries require
explicit opt-in and are never promoted; quarantined/deprecated entries remain
unavailable. References must be declared and explicitly selected. Content
grants no tools, permissions, publishing or provider spend. Nothing is silently
truncated, and no integrity hashes or approval records are refreshed.

## Explicit code-only fixtures

Trusted test code may construct a data fixture and inject it into the server:

```ts
const skillRegistry = new SkillRegistry({ fixtureRoot: disposableDataRoot });
const server = createMcpServer({ client, projectRoot: emptyWorkspace, skillRegistry });
```

This seam selects fixture **data** only. It still executes the fixed same-bundle
parser; `fixtureRoot/scripts/skill-pack.mjs` is never imported. The CLI accepts
only its existing `--project` option. MCP tool schemas expose no fixture, root,
path or module selector, and reject unknown fields. There is no HTTP selector.

The new `tests/unit/mcp-bundled-skills.test.ts` preserves the two original MCP
skill-fixture scenarios through this explicit seam: experimental opt-in/budget/
checksum enforcement, and approved content excluding quarantined/deprecated
entries. It also checks recorded approval evidence, selected references,
reference checksums and escaping declared paths.

The corresponding existing tests in `tests/unit/mcp.test.ts` now pass
`new SkillRegistry({ fixtureRoot: project })` through their code-only `linked`
helper explicitly. All prior policy, budget, checksum and quarantine/deprecation
assertions remain. This test-file addition to the disjoint write set was
explicitly authorized during review; no project-root discovery or special-case
test-process behavior was restored in production.

## Verification scope

The regression suite checks a fresh empty arbitrary project, an attacker-owned
project registry and malicious `scripts/skill-pack.mjs`, and fresh official MCP
stdio with both `--project` and cwd pointing at that hostile workspace. It
compares returned metadata against Arcane's real registry, verifies the selected
content against its recorded hash and asserts the malicious execution marker
was never written. The current bundled registry contains no approved entries;
an empty default list is authentic. Positive approved loading is tested only in
explicit disposable data fixtures with synthetic evidence.

The packaged-layout smoke copies compiled MCP/daemon schema/package code, the
parser and the authored skills into a disposable `resources/product` tree, then
launches its `dist/apps/mcp/src/main.js` against a separate hostile workspace.
It uses a synthetic bearer and skill tools only. SDK dependencies resolve from
the trusted checkout for this fixture; this is shipped-root-layout regression
proof, not a new release inventory, a standalone dependency acceptance run or
verification of the parent's immutable accepted bundle.

Additional physical fixtures reject hardlinked MCP code, parser and registry
files plus a parser directory redirected through an internal junction/symlink.
These tests require a runner permitted to create disposable filesystem links.
Existing MCP compatibility tests require synthetic loopback HTTP access; sandbox
denials of either capability are environmental failures, not passing evidence.

Use the existing explicit TypeScript compiler pattern to include the new unit
test. A standard full build includes it automatically:

```text
npm run typecheck
npm run build
node --test --test-concurrency=1 dist/tests/unit/mcp-bundled-skills.test.js
node --test tests/skills/*.test.mjs
```

For a focused build, use a disposable config extending the root `tsconfig.json`,
with explicit files for `apps/mcp/src/main.ts` and the new test, empty include/
exclude arrays and `outDir` set to `apps/mcp/.test-build`. Run the emitted test
under that directory. The existing `apps/mcp/tsconfig.json` lists only the old
MCP test and will not select the new file by itself.

Observed verification on 2026-10-13:

- Repository-wide `npm run typecheck`: passed, 155 explicit product sources.
- Focused explicit-file compile into `apps/mcp/.test-build`: passed.
- Combined existing MCP, new bundled-skill and native MCP suites: **82/82
  passed**, comprising 46 existing MCP tests, 15 new checks (including physical
  link subtests) and 21 existing native MCP tests; zero failures or skips.
- Existing offline skill contracts/catalogue: **32/32 passed**, zero skips.
- Packaged `resources/product` MCP stdio smoke and hostile-workspace execution
  marker checks passed as part of the new suite. This is fixture-level code,
  policy and layout proof; it makes no behavioral approval or paid-turn claim.

The combined regression command used the three emitted files under
`apps/mcp/.test-build/tests/unit/` with `node --test --test-concurrency=1`.
Filesystem-link and loopback suites ran on a runner allowed those capabilities;
the earlier sandbox-denied attempts were not counted as successful proof.

Work in this change is limited to `apps/mcp/src/skills.ts`, the essential server
construction/description changes in `apps/mcp/src/server.ts`, this new unit test
and this document, plus the authorized fixture-helper migration in
`tests/unit/mcp.test.ts`. It performs no live Studio work, installed-provider CLI
launch, paid inference, installation, credential/configuration reads or user
project module execution. It leaves the parent's runner, paid-turn acceptance
and Hubble's plugin acceptance preparation under their existing owners.
