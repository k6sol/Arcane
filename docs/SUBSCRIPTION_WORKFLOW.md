# Arcane — getting real value from existing AI access
Version 1.2 · verified documentation reviewed 11 October 2026. Native metadata discovery and model/effort preference saving now exist in the local connection lab. Reasoning, MCP tools and direct-plan/API integrations below remain planned; no inference has run. See [native-feature implementation and design](PROVIDER_NATIVE_FEATURES.md).

## 1. Product goal

Arcane should make an existing capable model more productive through good tools, task-specific instructions, current project context, deterministic helpers and real verification. It should not make users buy a second inference service merely to access local Roblox tools. Subscription efficiency means more correctly completed work per allowance, not aggressive consumption of the allowance or weaker unverified output.

The same project and tools must work with different supported clients and providers. Hunted is a benchmark, not the default template, visual style or business model for other games.

## 2. Four distinct access modes

| Mode | Who runs reasoning / owns credentials | Arcane responsibility | Billing truth |
|---|---|---|---|
| External MCP client | User's configured Codex, Claude Code or another supported client | Local Studio/Blender tools, skills, artifacts and policy | Usage stays with that client/account; Arcane may not see it |
| Supported direct plan connection | Arcane's own provider-authorized local connection | Consent, protected credentials, compatible harness and limits | Uses granted plan allowance only within the supported route |
| Personal API key | User's chosen API account through local daemon | Protected key, spend controls and provider adapter | API usage can be billed separately from a consumer subscription |
| Managed API service | Arcane backend/provider account | Entitlements, reservations, ledger and cost reporting | Separate Arcane service charges; never disguised as existing-plan usage |

Mode is visible on every task. Switching to an API/managed fallback needs an explicit user choice because it can change cost and data routing. Never silently switch when a plan limit is reached.

## 3. External-client mode comes first

Install/register Arcane's local MCP tools through the client's supported configuration, only within the user's chosen scope. Preserve existing servers and instruction files. Generate a reviewable proposed config rather than overwriting home-directory configuration.

The client remains responsible for login, selected model/effort and its own permission system. Arcane still enforces target, scope and capability checks at the daemon/plugin boundary. A permissive client cannot bypass those checks.

Serve concise skill discovery and selective reads through the planned registry tools/resources; optionally package native client skills using supported mechanisms. Never paste all fifty bodies into every task. Use references and large evidence as scoped artifacts.

Codex supports MCP configuration through its documented integration, and Claude Code documents local/project/user MCP scopes. Their details must be verified for the installed client before configuration. [OpenAI MCP configuration example](https://developers.openai.com/learn/docs-mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp).

Claude Code's authentication modes are documented separately. Environment/API/cloud overrides can change the actual route; future execution must preflight them. [Claude Code authentication](https://code.claude.com/docs/en/authentication). Consumer guidance restricts third-party embedded subscription traffic: retain native Claude Code sessions with Arcane as a tool provider, or implement an explicitly authorized API/cloud route. Never extract OAuth tokens or misrepresent the app. [Third-party access guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account).

Cloud/browser clients cannot reach a user's loopback daemon by assumption. A remote/tunnel integration is a separate capability requiring authentication and risk review. Do not expose Studio to the internet just to make a demo connection work.

## 4. Direct ChatGPT plan integration is now a legitimate candidate

Current official documentation describes optional ChatGPT plan usage for eligible open-source/local apps, using an explicit authorized connection. It is not automatic access for every app/account; paid or remotely hosted offerings require separate availability review. Arcane's present private local development does not prove public commercial eligibility. [Official overview](https://developers.openai.com/siwc/token-sharing-open-source), [integration example](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt).

Proposed Arcane adapter:
- Display the exact requested identity/plan permissions and current eligibility limitation.
- Give each installation a stable opaque host identity; maintain the app's own user/workspace connection.
- Use the supported browser authorization flow and validate state, nonce, PKCE, issued identity and granted permissions.
- Keep tokens in the protected local runtime, never the renderer, project repository, logs or a managed inference proxy.
- Refresh/revoke correctly. A cancelled or interrupted run is not successful completion.
- Discover model candidates, then verify actual entitlement through the supported request result; a catalog entry alone is not entitlement.

Codex app-server is a documented harness option with its own initialization, thread and turn lifecycle; this is a candidate to evaluate rather than reinventing the entire reasoning loop. Arcane must supply its own authorized tokens instead of reading another application's credential files. [Official app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

The plan route has preview-specific request/tool/media constraints. Enforce those in a separate adapter: streaming and non-stored requests are required; ordinary hosted tools and some media capabilities are not supported. Local Arcane MCP execution is a distinct path. Reject unsupported options before sending; do not reuse a generic API request unchanged. Image/voice generation is not presumed included. [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Arcane's own direct-plan login, OAuth registration and inference have not been attempted. The connection lab separately reads an already installed client's sanitized native metadata; that is not this program's authorization or an entitlement test. Release this mode only after authorized real-account testing and eligibility review. External native-client MCP remains the design baseline, with the actual bridge still to build.

## 5. How Arcane improves useful work per allowance

1. **Task-sized retrieval:** inspect the selected feature, search exact code, read relevant spans and retrieve dependencies only as needed.
2. **Progressive skills:** metadata first, selected entrypoints next, only relevant genre/reference detail last.
3. **Revision-aware reuse:** cached facts and artifact references avoid repeated dumps; fresh reads remain mandatory for writes/conflicts.
4. **Deterministic helpers:** reuse tested parsers, manifests, conversions and checks rather than making the model reinvent mechanical work every turn.
5. **Evidence selection:** a small number of useful captures and structured assertions replace huge logs or repeated vague visual reviews.
6. **Bounded repair:** preserve the first failure, stop repetitive attempts without new evidence and checkpoint unfinished work.
7. **Model intent respected:** retain an explicitly selected model/effort. Suggestions distinguish quality, speed and observed cost; no silent downgrade.
8. **Purposeful concurrency:** parallelize independent work only when it actually helps. Multiple agents share account limits; they do not multiply allowance.
9. **Portable continuation:** a handoff contains scope, current revision, changes, unresolved failures and the next acceptance step—not a lossy feel-good summary.

The offline `skill-pack.mjs` helper implements selective, byte-bounded packing of the authored skill files. It does not measure model tokens, estimate hidden quota or prove improved game quality.

## 6. Usage interface and safeguards

Show access mode, chosen model, reported usage, applicable limits when available, current task budgets and checkpoint status. Distinguish provider-reported values from estimates and unavailable data. Do not pretend to know subscription reset times from local output size.

On rate limits or revoked permissions, pause new inference, reconcile in-flight work and preserve artifacts. Offer resume later, another explicitly chosen mode or a smaller next scope. Never rotate accounts, host IDs or credentials to evade limits. Retrying a failed transport is not permission to duplicate chargeable inference.

## 7. Value benchmark

Measure representative code, debugging, GUI, physics, asset and complete-slice tasks across several genres. Record acceptance completion, unresolved regressions, human corrections, elapsed time, actual available usage and context bytes. Compare the same starting project/model/configuration with and without the relevant skill/context strategy.

Do not claim a savings percentage or that all models become equally capable. A smaller context that omits necessary evidence is a regression. A game that compiles but feels generic is not the target outcome. No inference/behavior benchmarks have run yet.
