# Standalone Luau tests

Scenario VM tests are mandatory on Windows x64 and Linux x64. They execute the fixed production scenario program with explicit synthetic engine/input fixtures; they do not connect to Studio or a provider. Missing or mismatched runtime/compiler paths fail the tests instead of skipping them.

Acquire the official, pinned Luau 0.742 test tools once for a local test run. The installer verifies the complete release archive and exact interpreter/compiler members, then runs bounded marker and compilation probes. It prints JSON paths; a child process cannot set its parent shell's environment.

PowerShell:

```powershell
$luauTest = node scripts/luau-test-runtime.mjs --install | ConvertFrom-Json
$env:ARCANE_LUAU_BIN = $luauTest.runtime
$env:ARCANE_LUAU_COMPILE = $luauTest.compiler
npm test
npm run test:plugin
```

POSIX shell on Linux:

```sh
luau_test_json="$(node scripts/luau-test-runtime.mjs --install)"
export ARCANE_LUAU_BIN="$(node -p 'JSON.parse(process.argv[1]).runtime' "$luau_test_json")"
export ARCANE_LUAU_COMPILE="$(node -p 'JSON.parse(process.argv[1]).compiler' "$luau_test_json")"
npm test
npm run test:plugin
```

An existing installation can be checked without downloading or executing anything:

```sh
node scripts/luau-test-runtime.mjs --verify ABSOLUTE_INSTALLATION_DIRECTORY
```

Export its returned `runtime` and `compiler` paths as above. Both files must remain together, ordinary, and match the shared official member pins; the scenario fixture rechecks them before execution. CI runs `--install --github-env` before the existing test steps, so both operating systems execute VM cases without optional skips or a sibling checkout dependency. No test deadline is widened.

The helper is test tooling only. Product startup does not download or install a runtime. The existing managed Windows compiler keeps its separate product verification path. Release metadata: [Luau 0.742](https://github.com/luau-lang/luau/releases/tag/0.742), [official asset digests](https://api.github.com/repos/luau-lang/luau/releases/tags/0.742).
