---
type: reference
project: Arcane
tags: [arcane]
---
# System map

```mermaid
flowchart LR
  Chat[Desktop chat] --> Daemon[Project daemon]
  Chat --> Providers[Supported model adapters]
  Providers --> Daemon
  Daemon --> Assets[Blender and asset workers]
  Assets --> Review[Interactive asset review]
  Review --> Import[Conversion and import staging]
  Import --> Plugin[Arcane plugin]
  Daemon --> Tasks[Task and test coordinator]
  Daemon --> Store[SQLite, journals, manifests]
  Tasks --> Evidence[Reports and acceptance]
```

| Responsibility | Source entry points |
|---|---|
| Desktop and chat | `apps/desktop/src`, `apps/desktop/electron` |
| Project services | `apps/daemon/src` |
| Model transport and continuation | `packages/codex-client/src` and provider adapters |
| Assets | `packages/asset-pipeline/src`, `workers/blender` |
| Plugin | `plugin`, `scripts/build-plugin.mjs` |
| Persistence | `packages/storage/src` |
| Tests and delivery | `tests`, `.github/workflows`, desktop release scripts |

[[Architecture/Chat and Sessions]] · [[Architecture/Asset Pipeline]] · [[Architecture/Task Lifetimes]] · [[Architecture/Plugin and Import]] · [[Architecture/Diagnostics and Services]]
