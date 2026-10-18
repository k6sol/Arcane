<p align="center">
  <img src="apps/desktop/electron/icon.png" width="88" alt="Arcane logo">
</p>

<h1 align="center">Arcane</h1>

<p align="center"><strong>Build worlds faster.</strong></p>

Arcane is a Windows desktop app for building Roblox games by chatting. You describe what you want, and Arcane builds it in your open Roblox Studio place through the Arcane Studio plugin: scenes, terrain, lighting, effects, scripts, Creator Store assets and Blender meshes. You use your own ChatGPT or Claude subscription, and you can switch between them in the same chat.

Arcane is a development preview. The Windows build is unsigned and has no installer yet. See [current status](docs/build/PRODUCT_BUILD.md).

## Requirements

- **Windows 10 or 11.**
- **Roblox Studio.**
- **A ChatGPT or Claude subscription, signed in through its official command-line client.** Arcane does not bundle the clients and never sees your password.
  - ChatGPT: install the Codex CLI (`codex`). Arcane runs its browser sign-in, or you can run `codex login` yourself.
  - Claude: install the Claude Code CLI (`claude`). Arcane runs `claude auth login` in a visible terminal. Only a claude.ai subscription login counts as a subscription. Arcane warns when the CLI is using API or cloud billing instead.
- **Blender (optional).** You only need it for Blender asset generation. Arcane finds `blender.exe` under `Program Files\Blender Foundation` or on `PATH`, and checks that it works (including Cycles) before using it.
- **Node.js 24 or later**, only to run from source.

## Install and run

**Portable build.** Run **Arcane.exe** and keep its whole folder together. You do not need Node.

**From source:**

```powershell
npm run setup:arcane -- -InstallDependencies -Prepare   # npm ci, build, build the plugin
npm run start:desktop                                   # open the desktop app
```

`npm run start:arcane` runs the same product in your browser instead. It checks the build, starts the local service and prints a private link. Keep that window open and press Ctrl+C to stop. [First run on Windows](docs/build/FIRST_RUN.md) covers every setup option.

## First run

The setup checklist on the home screen walks you through four steps:

1. **Sign in.** Choose **Sign in with ChatGPT** or sign in to Claude. If the CLI isn't installed, **Install** opens its official instructions.
2. **Install the Studio plugin.** Click **Install plugin**. This copies `ArcaneLocalBridge.rbxmx` into `%LOCALAPPDATA%\Roblox\Plugins`, then restart Roblox Studio. You can also run `npm run install:plugin`.
3. **Connect Studio.** Click **Connect Studio** in Arcane. Arcane shows a 6-digit code. In Studio, open the Arcane plugin, type the code and click **Connect**. Arcane then shows the place that asked; click **Approve** if it is yours. If one-click pairing isn't available, use **Use API key** and paste the key into the plugin instead. See [Studio pairing](docs/studio-pairing.md).
4. **Open a project.** Use **File → Open project…** (Ctrl+O) to choose your game's folder. Until then, Arcane uses a starter folder. Each project keeps its own chats, Studio keys and asset jobs.

The **Guide** in Settings repeats these steps and has tips.

## What you can ask for

- **Scenes and levels**, for example "a realistic forest clearing with a campfire", "an obby with checkpoints" or "a sci-fi lab". Large builds are made in one batch as a single undo step.
- **Terrain**: hills, mountains, valleys, rivers, paths, lakes and flattened clearings.
- **Mood and lighting** with presets (clear day, golden hour, foggy forest, night, horror, sci-fi), atmosphere, post-processing and material variants.
- **Effects**: particles, beams, trails, lights, fire, smoke, highlights, decals and textures. Sound support is in progress.
- **Scripts**: read, search, write and enable scripts. A script is syntax-checked before it is enabled.
- **Assets**: search the free Creator Store and insert assets (scripts are removed unless you ask to keep them), use Roblox Studio's built-in AI generators, or make procedural trees, rocks, columns and foliage in Blender.
- **Visual checks**: Arcane captures the Studio viewport to look at its own work.
- **Playtests**: with the **Playtest** switch on, Arcane may run one short, bounded playtest after building.

**Starters** on an empty chat fill in example prompts for you to edit. Type `@selection` to mean your current Studio selection. The slash commands are `/new`, `/clear-draft`, `/model` and `/help`. Arcane saves project notes such as art style and naming in **`ARCANE.md`** in your project folder, and both providers read it. You can edit it under **Settings → Project memory**.

Every tool, with its limits, is listed in the [MCP tool reference](docs/TOOLS.md).

## Permissions and safety

- Studio changes go only to the paired place, inside the roots its key grants, and only while Studio is in Edit mode.
- **Undo.** Each change returns a receipt, and the change card offers **Restore**. Terrain and environment changes are undone with Studio Undo.
- **Auto-approval** (**Settings → General → Permissions**) is saved per project.
  - "Let Claude use Arcane tools in this project" controls whether Claude chat can use Arcane's tools.
  - "Auto-approve edits and tool use" lets ChatGPT edit inside the project folder without asking.
  - Arcane always asks first before deleting files, touching version-control or credential files, using the network or installing, publishing, reading secrets, making system changes, or doing anything outside the project.
- Claude chat runs with only Arcane's tools. Its shell, file and web tools are turned off.
- Arcane never buys, publishes or uploads assets for you. Meshes made in Blender and placed into Studio last only for that Studio session. To keep one, upload it yourself.
- Confirmations appear as in-app dialogs. **Stop** and **Revoke** are always available.

## Costs

- **Your AI usage** counts against your own ChatGPT or Claude plan. Arcane doesn't resell model access.
- **Cost estimates** (**Settings → Display → Show cost estimates**) show approximate API-price equivalents. They are not charges.
- **Arcane actions.** An action is one finished build turn or one applied Studio change. Undo is free. You can see the count in **Settings → Plans & credits** and in the top bar. It is only informational and never blocks you.
- **Checkout isn't connected yet.** Buy buttons say so, and nothing is charged. See [Arcane actions, plans and credits](docs/ARCANE_CREDITS.md).

## Troubleshooting

- **"Update the Studio plugin" / `PLUGIN_UPDATE_REQUIRED`.** Click **Update plugin** on the checklist or in Settings, restart Studio, then connect again. Newer tools such as batch building, effects, terrain and viewport capture need the current plugin.
- **Studio says "Click Connect Studio in Arcane first".** Click **Connect Studio** in Arcane, then **Connect** in the plugin again. A pairing code lasts 10 minutes.
- **After restarting Studio or Arcane:** the plugin reconnects with its saved key. If it doesn't, click **Connect** in the plugin. An old session that shows as offline after a restart is expected.
- **The plugin doesn't appear:** restart Roblox Studio after installing or updating it.
- **"Usage limit reached":** your message goes back into the composer. If the other provider is signed in, use **Switch to Claude** or **Switch to ChatGPT**, and your draft moves with you. Otherwise wait for the reset time shown.
- **Sign-in problems:** run `codex login` or `claude auth login` in your own terminal, then check status in Settings.
- **Something else isn't working? Run `npm run doctor` first.** It checks Node and Electron, whether `dist/` is older than the sources, the plugin build, whether the installed Studio plugin is current and whether Studio needs a restart to load it. It also checks Claude Code and Codex (installed, version, signed in), Blender, Studio's built-in MCP server, free disk space, large leftovers under `runtime/`, and the Edge/playwright-core setup for UI tests. Each line says `ok`, `WARN` or `FAIL`, and every problem comes with a one-line fix. Add `--json` for machine-readable output. The doctor only reads. It never uses the network, installs, deletes or shows account emails or keys.

## Development

Requires Node.js 24 or later.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build            # compile to dist/
npm run typecheck        # type-check only
npm test                 # build, then unit, skill and release suites
npm run build:plugin     # build the Studio plugin into plugin/build
npm run test:plugin      # plugin tests
npm run start:desktop    # Electron app (after build)
npm run start:mcp        # Arcane MCP server on stdio (needs ARCANE_DAEMON_URL and ARCANE_LOCAL_TOKEN)
node scripts/generate-tool-docs.mjs   # regenerate docs/TOOLS.md after changing a tool (after build)
```

To package Windows: `npm run package:windows` builds a portable folder, and `npm run check:desktop` checks that packaged executable. The [full product plan](docs/PRODUCT_PLAN.md) and [build evidence](docs/build/PRODUCT_BUILD.md) track scope and verification.

## Licence

Arcane is proprietary software. First-party source, designs and assets are covered by the [Arcane Proprietary Licence](LICENSE). Third-party components retain their own licences.
