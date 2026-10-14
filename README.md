<p align="center">
  <img src="apps/desktop/electron/icon.png" width="88" alt="Arcane logo">
</p>

<h1 align="center">Arcane</h1>

<p align="center"><strong>Build worlds faster.</strong></p>

Arcane is a desktop workspace for Roblox creators. Bring your AI conversations, Studio project and Blender assets together, without constantly switching between tools.

## One workspace, from idea to build

- **Chat-first creation** — keep requests, files and project context in the same conversation.
- **Roblox Studio connection** — connect through the Arcane plugin with a single API key.
- **Blender asset workflows** — generate, export and review models and materials locally.
- **Native AI accounts** — use supported Codex and Claude Code sign-ins rather than sharing provider credentials with Arcane.
- **Model and reasoning controls** — choose from the options reported by your connected client.
- **Recoverable changes** — review edits and retain a recorded path back to earlier work.

Codex supports in-app conversations. Claude Code currently uses a native-client handoff. Provider features depend on the installed client and your account.

## Getting started

1. Open Arcane and sign in to your AI provider.
2. Generate your Arcane API key.
3. Open the Arcane plugin in Roblox Studio, paste the key and connect.
4. Start a chat with what you want to build.

Windows preview builds launch through **Arcane.exe**. Keep the complete build folder together; these builds are currently unsigned.

## Development

Requires **Node.js 24 or later**. Blender and the supported AI clients are needed for their respective integrations.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run typecheck
npm test
```

Build the Studio plugin:

```sh
npm run build:plugin
npm run test:plugin
```

Desktop packaging uses `npm run package:windows` from a prepared Windows development environment.

## Licence

Arcane is proprietary software. First-party source, designs and assets are covered by the [Arcane Proprietary Licence](LICENSE). Third-party components retain their own licences.
