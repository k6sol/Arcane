# Arcane actions, plans and Arcane Credits

This page covers what works today and what you need to provide to sell plans, action packs and Arcane Credits.

## What works today (no setup)

- **Arcane actions metering.** One Arcane action is one finished build turn in chat (Codex or Claude) or one applied
  Studio change (a succeeded Studio write command; undo/restore is free). The daemon records each action once in
  `<state dir>/arcane-actions/actions-ledger.v1.jsonl`.
  - Each line is hash-chained to the previous line, so the app can tell when the file was edited outside Arcane.
  - External ids are stored only as hashes.
  - The file is bounded: old entries fold into a checkpoint line that keeps the month and day totals.
- **Where actions are counted.**
  - The daemon counts Codex turns (`turnStatus: completed`) and Studio changes (`command_succeeded` events).
  - Claude chat turns finish in the desktop host. The renderer forwards each `done` event with `ok: true` from the
    existing `claudeChat.onEvent` bridge to `POST /v1/actions/record`. That is deduplicated by turn id.
- **Settings > Plans & credits** shows actions used this month, today, and the last 14 days. The top-bar chip shows
  this month's count.
- **Usage is informational and never blocks the user.** It never stands for purchased balance.
- **Every buy button goes through one checkout seam.** Until a billing service is configured and verified, it shows
  "Checkout isn't connected yet". Nothing is charged, and no balance is granted locally.

## Editing prices, allowances and copy

All plans, packs, credit offers and their copy live in one file: **`packages/protocol/src/plans.ts`** (`ARCANE_PLANS`).

- Prices are integer cents. Every value marked `PLACEHOLDER` is an example.
- Set `placeholderPrices: false` only after you enter real, approved prices. While it is `true`, the page says
  "Prices shown are placeholders".
- `validatePlansConfig` runs when the daemon starts. A typo, such as a negative price or a duplicate id, stops the
  page from showing wrong numbers.
- Rebuild (`npm run build`) after you edit the file.

## Connecting checkout (needs your infrastructure)

You provide:

1. A payment processor account (merchant of record, tax handling, refunds) under your own business terms.
2. A hosted **Arcane billing service** that you run over https.

Then edit `billing` in `packages/protocol/src/plans.ts`:

```ts
billing: { serviceUrl: 'https://billing.your-domain.example', allowedOrigins: ['https://billing.your-domain.example'] },
```

The billing service must expose:

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/v1/health` | `{"service":"arcane-billing","version":1}`. Arcane opens checkout only after this check passes. The result is cached for 10 minutes. |
| `GET` | `/checkout?kind=plan\|pack\|credits&offer=<id>` | An https page hosted by the billing service. It signs the user in to their Arcane account and starts the processor's hosted checkout. |

- **How Arcane builds the URL.** Arcane builds the checkout URL from trusted config and a known offer id, never from
  request text. It then checks the URL again in the renderer against the verified origin.
- **How the URL opens.** It opens in the system browser through `window.arcaneDesktop.billing.openCheckout(url)`.
  - This bridge is the only desktop host change still needed. Add it next to the existing provider-setup
    `shell.openExternal` path.
  - The host must accept one https string and re-check its origin against the same allowlist.
  - Until the bridge exists, the desktop says "Checkout can't open here yet" and does nothing else.
- **Balances.** Your service grants plans, packs and credits on its own side, after the processor confirms payment
  through its webhook. Arcane only reads balances back through the gateway (below).

## Arcane Credits provider (needs your infrastructure)

Arcane Credits let people without a ChatGPT or Claude subscription use models through a hosted **Arcane gateway**.

- You run the gateway and hold the model provider API keys there, under terms that permit reselling or relaying access.
- Arcane never ships provider keys and never calls a model vendor directly.

The seam is `apps/daemon/src/arcane-gateway.ts`:

- `ArcaneGatewayProvider`, with provider id `arcane`, provides `status()`, `balance()`, `usage()`, `models()` and
  `streamChat()`.
- `ArcaneCredentialVault` stores the Arcane account token encrypted at rest.
  - `createEncryptedTokenVault` follows the Studio key vault pattern. The host supplies OS encryption, which is
    Electron `safeStorage` on desktop.
  - If no encryptor is available, nothing is stored.

The provider stays **disabled and hidden from the model picker** until two things are true:

1. `gateway.url` in `plans.ts` is https and its origin is in `gateway.allowedOrigins`.
2. A signed-in account token is present in the vault.

`gatewayStatus()` returns `showInModelPicker: true` only in the `ready` state. Until then, every call refuses and
makes no network request.

### Expected gateway API

All requests send `Authorization: Bearer <account token>`. The gateway must not redirect; Arcane sends requests with
`redirect: "error"`. JSON replies may be at most 64 KB, and a stream at most 4 MB.

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/v1/balance` | `{"credits":1200,"actionsRemaining":40,"plan":"Pro","renewsAt":"2026-11-01T00:00:00Z"}`. `actionsRemaining`, `plan` and `renewsAt` may be `null`. |
| `GET` | `/v1/usage` | `{"period":"2026-10","creditsUsed":300,"actionsUsed":12}` |
| `GET` | `/v1/models` | `{"models":[{"id":"arcane-default","label":"Arcane default"}]}`, with at most 32 models. |
| `POST` | `/v1/chat/stream` | Request body: `{"model":"…","messages":[{"role":"user","content":"…"}],"conversationId":"…"}`. The reply is Server-Sent Events. |

The `/v1/chat/stream` reply sends these events:

- `data: {"type":"delta","text":"…"}`, repeated as text arrives.
- Then one of:
  - `data: {"type":"done","creditsUsed":3}`
  - `data: {"type":"error","message":"…"}`

Error statuses:

- `401` means the sign-in expired.
- `402` means the account is out of credits.
- Any other non-2xx status shows "The Arcane gateway is unavailable".

### Remaining wiring once the gateway exists

1. Desktop host: an Arcane account sign-in flow, using a browser handoff like provider login, that stores the token
   with `createEncryptedTokenVault` and `safeStorage`.
2. Daemon: pass `gatewaySignedIn` to `plansRoutes` so the Settings page shows "Arcane Credits are ready".
3. Chat: add the `arcane` provider to the model picker only when `gateway.showInModelPicker` is true. Stream turns
   through `streamChat`. Count each finished turn as an action, like the other providers.

## Local routes (human bearer only)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/plans/state` | Returns the display catalog, `billing.state` (`not-configured`, `unverified` or `ready`) and the verified checkout origin, `gateway` status and the `usage` summary. Service URLs are never sent. |
| `POST` | `/v1/plans/checkout` | Body: `{"kind","id"}`. Returns `not-connected`, `unknown-offer` or `ready` with a URL. Requires the panel origin. |
| `POST` | `/v1/actions/record` | Body: `{"source":"claude","turnId","conversationId"}`. Deduplicated. Requires the panel origin. |

The agent token cannot read or write any of these routes.
