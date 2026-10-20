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

**Reference implementation:** `services/gateway/` is a deployable billing service *and* model gateway in one process
(Node 24, TypeScript run directly, SQLite, no runtime dependencies). Deploy steps, test-mode setup and every
environment variable are in `services/gateway/README.md` and `services/gateway/.env.example`. Point both
`billing.serviceUrl` and `gateway.url` at its origin.

Then edit `billing` in `packages/protocol/src/plans.ts`:

```ts
billing: { serviceUrl: 'https://billing.your-domain.example', allowedOrigins: ['https://billing.your-domain.example'] },
```

The billing service must expose:

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/v1/health` | `{"service":"arcane-billing","version":1}`. Arcane opens checkout only after this check passes. The result is cached for 10 minutes. |
| `GET` | `/checkout?kind=plan\|pack\|credits&offer=<id>` | An https page hosted by the billing service. It asks for the email of the Arcane account to credit and starts the processor's hosted checkout. |
| `POST` | `/v1/checkout` | Creates a hosted Checkout Session for one offer id from the **server-side price map** and redirects to it. Form post from the page above (`offer`, `email`) answers `303` to the session URL. JSON with `Authorization: Bearer <account token>` and an optional `Idempotency-Key` header, body `{"offer":"pro"}`, answers `{"id":"cs_…","url":"https://…"}`; the same key returns the same session. `404` unknown offer, `503` offer has no price configured. |
| `POST` | `/v1/stripe/webhook` | The processor's webhook. The `Stripe-Signature` header is verified (HMAC-SHA256 with `STRIPE_WEBHOOK_SECRET`, 5-minute replay window). Handled: `checkout.session.completed` / `checkout.session.async_payment_succeeded` (grant credits, a pack, or a plan's first month), `invoice.paid` with `billing_reason: subscription_cycle` (reset the plan allowance), `customer.subscription.deleted` (end the plan). Each event id and each grant (`checkout:<session>`, `invoice:<invoice>`) applies at most once. |

- **How Arcane builds the URL.** Arcane builds the checkout URL from trusted config and a known offer id, never from
  request text. It then checks the URL again in the renderer against the verified origin.
- **How the URL opens (desktop).** The Settings page calls `window.arcaneDesktop.billing.openCheckout(offerId)`.
  The host (`apps/desktop/electron/billing.cjs`) takes only the offer id:
  - It looks the offer up in the shipped `ARCANE_PLANS` and builds `<serviceUrl>/checkout?kind=…&offer=…` itself.
  - It requires an https URL whose exact origin is in `billing.allowedOrigins` (no userinfo, port, IP literal or
    localhost), and re-checks the origin right before opening.
  - It asks in an Arcane in-app dialog ("Open checkout", Cancel is the default) and opens the system browser with
    `shell.openExternal` only after the user confirms.
  - Replies are fixed states and messages (`not-connected`, `opened`, `cancelled`, `unknown-offer`, `busy`,
    `unavailable`). Unconfigured always answers "Checkout isn't connected yet" and opens nothing.
  - `billing.status()` reports `ready` or `not-connected` and an `account` state: `unavailable` (default: no gateway
    configured, no OS encryption, or verification mode), `signed-out`, `signing-in` or `signed-in` (see
    "Connect Arcane account" below).
- **Where the desktop reads the service URL.** Default: unset. Either
  - a local file `<Arcane userData>/billing-service.json` (Windows: `%APPDATA%\Arcane\billing-service.json`), a plain
    file of at most 4 KiB: `{"version":1,"serviceUrl":"https://billing.your-domain.example","gatewayUrl":"https://billing.your-domain.example"}`
    (`gatewayUrl` is optional and must be on an origin in `gateway.allowedOrigins`), or
  - `billing.serviceUrl` in `packages/protocol/src/plans.ts`.

  The local file wins when present. In both cases the origin must also be listed in `billing.allowedOrigins` in
  `plans.ts`, which ships with the app, so a local file alone cannot point checkout somewhere new. The desktop bridge
  does not call `/v1/health`; the Settings page label follows `billing.status()`.
- **Browser (non-desktop) pages** keep using `POST /v1/plans/checkout` and open the verified URL in a new tab.
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

1. A gateway URL is configured on an https origin listed in `gateway.allowedOrigins`: `gateway.url` in `plans.ts`, or
   the user's local `gatewayUrl` in `billing-service.json` (passed to the seam as `localUrl`; see `gatewayBase()`).
2. A signed-in account token is present in the vault.

`gatewayStatus()` returns `showInModelPicker: true` only in the `ready` state. Until then, every call refuses and
makes no network request.

### Connect Arcane account (desktop)

Settings > Plans & credits shows **Connect Arcane account** under the Arcane Credits status, but only when
`billing.status()` reports an account state other than `unavailable`. Everything stays off by default: the shipped
`plans.ts` allowlists no gateway origin.

The sign-in is a **device code confirmed by an emailed link**. It needs no local callback server, no password, and
works with any mail service:

1. The host (`billing.cjs`) calls `POST /v1/auth/device` on the allowlisted gateway and gets a secret `deviceCode` and
   a short `userCode` such as `BCDF-GHJK`.
2. It shows the code in an Arcane dialog ("Open sign-in page", Cancel is the default). After confirmation, it opens the
   gateway's `/v1/auth/verify` page in the browser. The page must be on the gateway origin.
3. On that page the user checks the code and enters their email. The gateway emails a single-use link that expires in
   15 minutes. Opening the link shows the code again, and the user approves with a button. Approval is a POST, so mail
   scanners that prefetch links cannot approve.
4. The host polls `POST /v1/auth/token` and receives an opaque bearer token once. It stores `{origin, token}` encrypted
   with `safeStorage` in `<userData>/arcane-account.bin`. The token is bound to that gateway origin, never crosses to
   the renderer, and is not sent anywhere else.

**Disconnect** deletes the file and revokes the token on the gateway (`POST /v1/auth/logout`). Replies to the renderer
are fixed states and messages only: `not-connected`, `opened`, `cancelled`, `busy`, `signed-in`, `signed-out`,
`unavailable`.

### Expected gateway API

Account requests send `Authorization: Bearer <account token>`. The gateway must not redirect; Arcane sends requests
with `redirect: "error"`. JSON replies may be at most 64 KB, and a stream at most 4 MB.

| Method | Path | Response |
| --- | --- | --- |
| `POST` | `/v1/auth/device` | No auth. `{"deviceCode":"…","userCode":"BCDF-GHJK","verificationUrl":"https://…/v1/auth/verify","verificationUrlComplete":"…?user_code=BCDF-GHJK","interval":5,"expiresIn":600}` |
| `GET`/`POST` | `/v1/auth/verify` | Browser page: the user enters the code and an email address; a sign-in link is emailed. The page looks the same whether or not the code is valid. |
| `GET`/`POST` | `/v1/auth/confirm?t=…` | Browser page from the emailed link. It shows the code; the POST button approves the device. |
| `POST` | `/v1/auth/token` | No auth. Body `{"deviceCode":"…"}`. Returns `200 {"token":"arc_…","tokenType":"Bearer"}` once, or `400 {"error":"authorization_pending" \| "slow_down" \| "expired_token" \| "invalid_grant"}`. |
| `POST` | `/v1/auth/logout` | Revokes the presented token. |
| `GET` | `/v1/balance` | `{"credits":1200,"actionsRemaining":40,"plan":"Pro","renewsAt":"2026-11-01T00:00:00Z"}`. `actionsRemaining`, `plan` and `renewsAt` may be `null`. |
| `GET` | `/v1/usage` | `{"period":"2026-10","creditsUsed":300,"actionsUsed":12}` (current UTC month). |
| `GET` | `/v1/models` | `{"models":[{"id":"arcane-default","label":"Arcane default","pricing":{"inputPerMTok":360,"outputPerMTok":1800},"tools":true}]}`, with at most 32 models. `pricing` is credits per million tokens with the markup applied (shown in the model picker). |
| `POST` | `/v1/chat/stream` (alias `/v1/chat`) | Request body: `{"model":"…","messages":[{"role":"user","content":"…"}],"conversationId":"…","turnId":"…","maxTokens":4096}`. `turnId` and `maxTokens` are optional. An optional `Idempotency-Key` header refuses a resend with `409`. The reply is Server-Sent Events. |

Function calling (optional, provider-neutral): the body may add `tools` (at most 64 `{name, description, inputSchema}`), assistant messages may carry `toolCalls` (`{id, name, arguments}`) and `role: "tool"` messages answer one call by `toolCallId` (optional `isError`). The gateway translates these to the provider's own function-calling format and never runs a tool; the desktop runs the loop (`apps/desktop/electron/arcane-chat.cjs`).

The `/v1/chat/stream` reply sends these events:

- `data: {"type":"delta","text":"…"}`, repeated as text arrives.
- `data: {"type":"tool_call","id":"…","name":"…","arguments":{…}}` for each tool the model calls (only offered tools).
- Then one of:
  - `data: {"type":"done","creditsUsed":3,"actionsUsed":0}` (with tools offered it also carries `stopReason`, `inputTokens` and `outputTokens`)
  - `data: {"type":"error","message":"…"}`

Error statuses:

- `401` means the sign-in expired.
- `402` means the account is out of credits. Nothing is sent upstream.
- `429` means the per-account rate limit or concurrent-stream cap was hit (`Retry-After: 60`).
- Any other non-2xx status shows "The Arcane gateway is unavailable".

### How usage is metered (reference gateway)

- **Price table.** Each model in `MODELS_JSON` has `inputPerMTok` and `outputPerMTok`: credits per million tokens,
  before markup. `MARKUP_BPS` is the markup in basis points; `12000` means +20 %.
- **Formula.** `credits = ceil((input × inputPerMTok + output × outputPerMTok) × MARKUP_BPS / 10¹⁰)`. The math is
  integer only and always rounds up.
- **Hold before streaming.** The worst-case cost (estimated prompt plus `maxTokens`) is held before the stream starts.
  When it ends, the actual cost from the provider's usage report is charged and the rest is refunded. If the balance
  cannot cover the hold, the gateway answers `402`.
- **Plan and pack actions.** A request with a new `turnId` while the account has plan or pack actions left consumes one
  action. That action covers up to `ACTION_CREDIT_ALLOWANCE` credits of usage for every request in that turn. Usage
  beyond the allowance, or with no actions left, is paid from credits.
- **Failures.** A failed request that streamed nothing is not charged. If the server crashes, open holds are refunded
  on the next start.

### Remaining wiring

1. ~~Desktop host sign-in~~: done (Connect Arcane account, above).
2. Daemon: the daemon process cannot reach `safeStorage`. The host exposes `billing.accountCredential()` (main process
   only) for a later handoff. Hand `{base, token}` to the daemon over the existing authenticated host-to-daemon
   channel. Then build `createArcaneGateway({ config, vault, localUrl })` with a vault that reads that value, and pass
   `gatewaySignedIn` to `plansRoutes` so the page says "Arcane Credits are ready".
3. ~~Chat~~: done. With an account connected, the composer model picker shows a third Arcane column (credit prices,
   balance). The desktop host `arcane-chat.cjs` streams through `streamChat` with one `turnId` per reply, offers Arcane's
   MCP tools (scoped handoff credential, same consent as Claude chat) and runs a bounded tool loop; a `402` shows Buy credits.

## Local routes (human bearer only)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/plans/state` | Returns the display catalog, `billing.state` (`not-configured`, `unverified` or `ready`) and the verified checkout origin, `gateway` status and the `usage` summary. Service URLs are never sent. |
| `POST` | `/v1/plans/checkout` | Body: `{"kind","id"}`. Returns `not-connected`, `unknown-offer` or `ready` with a URL. Requires the panel origin. |
| `POST` | `/v1/actions/record` | Body: `{"source":"claude","turnId","conversationId"}`. Deduplicated. Requires the panel origin. |

The agent token cannot read or write any of these routes.
