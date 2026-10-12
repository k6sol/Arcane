# Windows directory package

Arcane's Windows build is an unpacked directory containing a real **Arcane.exe**.
Copy the entire directory together; end users do not need an installed Node.js,
npm, or Electron. This build has no installer and is unsigned. The actual build also applies the controlled Arcane icon and product/version resources using the pinned build-only resource editor. This does not provide code signing or a signing certificate. The resource editor is an archived upstream tool, never a runtime dependency or remotely reachable app capability.

From a prepared checkout, run this exact packaging command with the current
standalone Windows x64 Node authority:

~~~powershell
& 'C:\Program Files\nodejs\node.exe' .\scripts\package-windows.mjs
~~~

The current build environment uses Node **v24.21.0** and pinned Electron
**44.7.0**. The packager checks the actual Node executable's version, platform,
architecture, standalone identity and PE header; Node must be stable **>=24**,
Windows x64. It copies that regular executable directly to
resources/node/node.exe, without links or an ElectronRunAsNode fallback.
Electron's installed package, lockfile pin and dist/version must agree exactly.

The parent build owns preparation: the current compiled product and source maps,
plugin build, secure host files, and the installed pinned Electron distribution
in node_modules/electron/dist. Installing Electron with ignore-scripts alone
does not populate that distribution. Packaging performs no dependency install,
download or lifecycle-script execution. It retains create-local-release.mjs's
current-source/compiled-map checks, so changed TypeScript must be rebuilt before
packaging. Never ignore a stale or missing source-map provenance failure.

Required host inputs are apps/desktop/electron/main.cjs, policy.cjs and
preload.cjs. If apps/desktop/electron/icon.png exists, its PNG signature is checked
and it is copied to resources/app/icon.png. The separately maintained
apps/desktop/public/brand/arcane-ridges.png remains a product asset.

The complete Node LICENSE, including all third-party notices, is required.
The packager first checks LICENSE or LICENSE.txt beside the selected node.exe,
then apps/desktop/electron/node-LICENSE.txt. The parent can obtain the latter
from the [official Node v24.21.0 LICENSE](https://github.com/nodejs/node/blob/v24.21.0/LICENSE)
for this exact runtime. A short MIT extract is rejected. For a different runtime,
supply its matching complete official license; no license text is fabricated.
An explicit absolute license-file path takes precedence:

~~~powershell
& 'C:\Program Files\nodejs\node.exe' .\scripts\package-windows.mjs --node-license 'D:\Build Inputs\Node-v24.21.0-LICENSE.txt'
~~~

Every successful invocation prints JSON with directory, executable and a SHA-256
manifest digest. It creates a fresh runtime/windows/arcane-win32-x64-* directory.
It also retains the verified source snapshot under runtime/releases. Existing
outputs are neither overwritten nor recursively deleted. On failure, any new
partial output remains for diagnosis and must not be distributed.

The directory layout is:

~~~text
arcane-win32-x64-*/
  Arcane.exe
  LICENSE
  LICENSES.chromium.html
  locales/
  [Electron DLLs, data, snapshots and version]
  resources/
    app/
      package.json             main: "main.cjs", type: "commonjs"
      main.cjs
      policy.cjs
      preload.cjs
      icon.png                 optional
    node/
      node.exe
      LICENSE                  complete Node distribution license
    product/
      release-manifest.json
      package.json
      package-lock.json
      dist/
      apps/, packages/, plugin/, scripts/, skills/, workers/, docs/, tests/, ...
      node_modules/            selected production packages only
  windows-manifest.json
~~~

This follows Electron's [manual application packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution):
an explicit resources/app folder and a renamed Windows executable. The
[Electron 44.7.0 startup source](https://github.com/electron/electron/blob/v44.7.0/shell/common/node_bindings.cc)
searches app.asar, app, then default_app.asar. Arcane ships neither
resources/app.asar nor resources/default_app.asar, leaving the explicit app
entry as the sole application. default_app.asar is deliberately omitted from
the installed Electron distribution during copying, rather than removed later.

resources/product is the immutable source snapshot produced by the existing
createLocalRelease API, with its release manifest preserved. Only the installed
lockfile closure of @modelcontextprotocol/sdk and zod is added: production
dependencies, compatible installed optional dependencies and required peers,
including nested versions. Development packages such as Electron and TypeScript,
unrelated installed packages and workspace links are excluded. No root runtime,
provider authentication, generated client configuration, user projects or personal
state is copied. Package test/cache/hidden directories are omitted. Packaging
uses lstat and canonical paths, rather than treating OneDrive reparse attributes
as proof of a symlink, and rejects redirects, symlinks and hardlinked files.

The host uses resources/product only for immutable code and assets. It runs the
bundled Node with cwd set to its trusted writable userDataArcane directory and:

~~~text
ARCANE_RESOURCE_DIRECTORY = resources/product (absolute)
ARCANE_STATE_DIRECTORY    = userDataArcane/runtime/projects/<project-path-sha256> (absolute)
ARCANE_PROJECT            = userDataArcane/projects/Untitled (absolute)
~~~

User state belongs outside the bundle. The host owns navigation, preload,
IPC, lifecycle and launch security. "Immutable" here describes the runtime
contract and checked snapshot, not a Windows ACL or cryptographic signature.

Verify a package without executing Arcane's daemon or Electron:

~~~powershell
$bundle = 'D:\Arcane Builds\arcane-win32-x64-EXAMPLE'
& "$bundle\resources\node\node.exe" "$bundle\resources\product\scripts\package-windows.mjs" --verify $bundle
~~~

The verifier checks every inventoried file's size and SHA-256, rejects unlisted
payloads throughout the directory (including product dependencies), and checks
the x64 EXE headers, Node license, app entry, source-release digest, Electron pin,
required product files, matching host/source snapshot files and complete production
dependency inventory.
windows-manifest.json records relative paths, versions, sizes and hashes; it
does not record machine paths, auth material or session links. The manifest
itself is represented by the returned digest, rather than a self-referential
inventory entry. Keep that digest separately if an external integrity reference
is needed. Integrity verification does not authenticate the publisher or prove
that the UI launched; applicationLaunchVerified remains false.

The parent host supports this separate bounded application smoke invocation:

~~~powershell
& "$bundle\Arcane.exe" --arcane-smoke 'D:\Arcane Smoke\New Empty Report Directory'
~~~

The report directory must be absolute and empty. Smoke is a separate host check,
not a packager action or a claim that providers, Roblox Studio or Blender were
tested. Review the host's report and exit code before describing the application
as launch-verified. Normal launch is Arcane.exe with no extra arguments.

Run just the packaging fixture suite:

~~~powershell
& 'C:\Program Files\nodejs\node.exe' --test .\tests\release\windows-package.test.mjs
~~~

The tests inject tiny Electron/Node PE fixtures and a Node metadata probe, while
using the actual createLocalRelease API. They perform no Electron download,
application launch, provider/Studio/Blender operation, login or inference.

