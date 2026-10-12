# First run on Windows

Arcane currently runs from your own cloned repository or unsigned local source release. Use your own writable folder and an ordinary Windows terminal. The bootstrap supports Windows PowerShell 5.1 and needs Node 24+ with npm. It does not require administrator rights or an existing provider login to check, build or open the workbench.

## 1. Get Node and npm

Use the [official Node.js download page](https://nodejs.org/en/download) and choose a stable Node 24 or newer Windows distribution containing npm. A Windows ZIP can be extracted into a folder you own if an installer needs administrator rights. Make that distribution available in your current terminal's PATH, then open a terminal at your Arcane folder. See [npm's Node/npm setup guide](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm). The bootstrap locates `node.exe` and the installed `npm.cmd`, then runs npm's adjacent `node_modules/npm/bin/npm-cli.js` directly with Node. Custom shim layouts are reported with instructions; they are not executed as a fallback.

## 2. Check this copy

From your Arcane folder, run:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-arcane.ps1
```

Once npm is available, `npm run setup:arcane` does the same check. The script derives its repository from its own location, checks the Arcane package and fixed build/launch entries, verifies Node/npm, and uses the local doctor to inspect compiled files, package-local dependencies and plugin source/artifact digests. A clean clone normally reports missing dependencies and build outputs with the next steps. A failed check returns a nonzero exit code.

The default check does not install, build, launch, contact providers, read provider credentials or create user runtime state. A successful check establishes local launch prerequisites only; it does not prove that provider inference, images, Studio or Blender workflows work.

[`-ExecutionPolicy RemoteSigned`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1#-executionpolicy) applies to this PowerShell process. The launcher does not persist an execution-policy change. If Windows or your organization's policy blocks a script, review the files and follow your local policy; do not disable antivirus or change machine policy for Arcane.

## 3. Explicitly install and prepare

Choose these actions when you are ready:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-arcane.ps1 -InstallDependencies -Prepare
```

`-InstallDependencies` runs `npm ci --ignore-scripts --no-audit --no-fund --include=dev` using this repository's lockfile. It installs local runtime and build dependencies, replaces this copy's `node_modules`, and may download packages and use npm's cache. It does not install global tools or change npm login/settings. [Official npm ci documentation](https://docs.npmjs.com/cli/v11/commands/npm-ci/) describes the frozen lockfile behavior and replacement of existing dependencies. Installation failure stops setup before any build or launch.

`-Prepare` runs the existing `npm run build` followed by `npm run build:plugin`, sequentially. These explicit npm script calls use `--ignore-scripts` to skip pre/post lifecycle hooks while running the requested script. It does not install dependencies implicitly. A failed product build skips the plugin build; a failed plugin build skips launch. Review the visible output and fix the failure before retrying. Build artifacts are written inside your checkout; building the plugin does not install it into Studio.

You may use each switch separately. `npm run setup:arcane -- -InstallDependencies -Prepare` also forwards the explicit switches.

## 4. Open Arcane

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup-arcane.ps1 -Launch
```

Or open `scripts\launch-arcane.cmd`. That wrapper invokes only its fixed sibling PowerShell script with `-Launch`. It does not forward arbitrary command-line text. It launches in the current window and pauses on failure so you can read the instructions. It never opts into installing or building.

To explicitly do all three steps in order, append `-InstallDependencies -Prepare -Launch` to the PowerShell command. Launch runs the existing `npm run start:arcane` in the foreground after the doctor succeeds. Open the private workbench link printed by that launcher and keep this window open; stop Arcane with Ctrl+C. The launched product creates local runtime state under the checkout's ignored `runtime` folders. No detached background process is started by the bootstrap. npm, build, doctor and launch failures retain their exit codes; setup prerequisite failures use code 2, and a not-ready report uses code 1 when the doctor supplied no failure code.

## 5. Connect your own native CLI

Before clicking **Connect**, install the supported native CLI yourself and log in through that CLI with your own account. For Codex, follow the [official Codex CLI setup guide](https://learn.chatgpt.com/docs/codex/cli) and [authentication guide](https://learn.chatgpt.com/docs/auth); complete `codex login` in your own terminal. Arcane setup does not run login, install or update a CLI, copy someone else's credentials, or require a session from the development machine.

In Arcane's native Codex panel, a human clicks **Connect** to initialize the installed native client and read account/model metadata. Choose an exact model and reasoning effort reported by that client. Starting or resuming a thread and sending a message are separate human actions; connection alone does not start an inference turn. See [the native client contract](CODEX_CLIENT.md) for scope and approval details. A reported account, model or plan does not prove successful inference or complete provider feature coverage. Images/design capabilities and other provider features still need their own acceptance evidence. Arcane does not provide a shared SaaS subscription: each user supplies their own supported account and access, subject to the provider's terms and availability.

## Studio testing is deferred

The plugin artifact check establishes local availability and matching source digests. It does not install the plugin, open Studio, connect to a place, or run Studio tests. Genuine plugin transport, write, dirty-buffer and restore testing is explicitly deferred. When that work is authorized later, use [the plugin guide](PLUGIN.md) and a separately approved disposable place. These bootstrap steps make no live Studio calls and do not modify an existing place.

## If a step fails

- **Node/npm missing or too old:** get Node 24+ with npm from the official links above and reopen the terminal. For an unsupported npm shim, use the standard Windows distribution; setup will not evaluate a custom wrapper.
- **Not an Arcane copy / missing source files:** keep the script inside `scripts` in a complete Arcane clone or source release. It uses that copy even when invoked from another working directory.
- **Dependencies missing:** run with `-InstallDependencies` explicitly. Do not use a global compiler or dependencies inherited from another repository.
- **Installation failed:** read npm's visible error. Check network access, write permission and that `package-lock.json` matches your clone. The script will not fall back to `npm install` or rewrite the lockfile.
- **Compiled output or plugin missing/stale:** run with `-Prepare` after dependencies are installed. A successful build is not proof of native runtime functionality.
- **Launch failed:** read the foreground launcher's message. Resolve the reported failure, then retry `-Launch`; the helper preserves the launcher's exit code.
- **Native client signed out or unsupported:** complete that CLI's own setup and login yourself, then use human **Connect**. Arcane can still check local launch prerequisites while signed out.

The setup scripts make no antivirus, firewall, machine policy, global tool or authentication changes. They do not recursively delete or move files. The only dependency replacement is npm's own `ci` operation after the explicit installation switch.
