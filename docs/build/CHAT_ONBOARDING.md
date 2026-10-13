# First conversation onboarding

The empty chat exposes **Start conversation** after a live Codex connection has
been reported. It sits in the normal conversation surface; technical connection,
thread, permission and recovery controls remain in Settings.

The action starts a read-only thread using the existing HUMAN control transport
and `thread-start` action/acknowledgement lifecycle. It does not submit the draft,
start inference, grant workspace writes or asset admission, connect Studio, or
select a connection, catalogue, model or default effort automatically.

## Interaction and guards

- With an acknowledged exact reported model/effort pair, a trusted unmodified
  mouse click or native keyboard button activation submits one `thread-start`.
  Its envelope contains only `requestId`, `connectionId` and `action`.
- Without that pair, the same action opens the existing composer model picker
  and focuses its search field. Choosing a model leaves effort unset. Staging a
  pair is insufficient: **Use model & effort** must acknowledge the selection.
  A separate **Start conversation** gesture then starts the thread.
- The normal-chat and Settings start buttons share one controller handler.
  A controller predicate guards dispatch independently of DOM `disabled` state.
  The predicate retains fresh, ready, subscription, busy, pending, unknown,
  connecting, closing, display-limit and existing-thread checks, plus equality
  between staged fields and the exact reported selection/catalogue.
- During start, the button reports `aria-busy` and a polite status explains that
  the message has not been sent. Send remains disabled while an acknowledgement
  is pending, including when an early poll already reports a configured thread.
- Unknown or lost acknowledgements retain the request ID and existing explicit
  recorded-state review. Reading a later successful receipt alone does not clear
  that fence. Rejection enables an explicit new attempt; nothing is retried.
  Existing connection/generation fences discard late responses from old scopes.
- After an acknowledged configured thread is available, the start action hides.
  A nonempty draft can enable Send under the existing composer guards. Sending
  still requires its own human action.

The change emits no authority-bearing CustomEvent and does not click a disabled
hidden thread button. The picker and start handler are called directly by the
chat controller. Existing Settings navigation retains its own connection link.

## Appearance and ownership

The existing charcoal/red/system-sans shell is retained. The new button uses
the existing action colour, 44 px minimum height, disabled treatment, and focus
styling. A visually hidden polite status describes the button to assistive
technology; the existing notice shows visible acknowledgement feedback. The
button is explicitly `type="button"` outside the composer form.

Source changes are confined to `apps/desktop/src/codex-chat.ts`,
`apps/desktop/public/studio.html`, `apps/desktop/public/studio.css`,
`tests/unit/chat-onboarding.test.ts`, and this document. The accepted FKUT9G
bundle, task board and `provider-setup.ts` are untouched. Provider-selection
`aria-pressed` must be maintained by the owner of `provider-setup.ts`, which owns
provider selection and render state; static attributes would become stale.

## Verification

Compile using `explicitProjectConfig` from `scripts/compile-product.mjs` into
a unique temporary output directory. Set `ARCANE_UI_BUILD_DIR` to that compiled
tree, `ARCANE_UI_BROWSER_MODULE` to the existing `playwright-core/index.mjs`,
and `ARCANE_UI_BROWSER_EXE` to the installed Edge executable. No installation
or accepted-bundle rebuild is required.

`chat-onboarding.test.ts` serves the real HTML/CSS and compiled chat, shell and
provider setup controllers through bounded localhost fixtures. Its server
accepts only synthetic `select` and `thread-start` POSTs with the HUMAN bearer
and exact request keys; any turn, grant, connection or Studio action fails.
The fixtures cover zero mount actions, one request per direct start gesture,
keyboard start, no automatic effort selection, picker routing, acknowledgement
gates, pending/unknown/rejected/lost/mismatched receipts, later explicit review,
late responses from a replaced connection, manipulated disabled attributes,
fresh/account/busy fences, preserved drafts, unchanged permissions, and mobile
layout. Each browser owns a new temporary profile; screenshots are retained in
its temporary fixture directory. No native provider or Studio is started.

For acknowledgement loss, the fixture completes HTTP without the receipt body.
Destroying an untouched socket can make Chromium retransmit a POST independently
of application retries, so that transport behaviour is not used as the fixture.

Run the existing `codex-chat-ui`, `composer-model-picker`, `provider-setup-ui`,
`workspace-settings-drawer`, `workspace-shell`, `workspace-unified`,
`workspace-preview-toggle`, and `workspace-navigation-ui` suites alongside the
new test. They use existing mock/spawned-node/presentation fixtures only.

Validation on 2026-10-13: strict TypeScript compilation passed for 155 explicit
product/test sources. All 92 focused tests passed with zero skips in installed
Edge 155.0.4283.45, including 12 onboarding cases and the eight existing suites.
After the final mobile spacing/accessibility adjustment, the 17 onboarding,
Settings and navigation tests passed again with zero skips; the mobile test
checks that the whole start button fits above the composer.
The private build and logs are retained under
`C:/Users/alexk/AppData/Local/Temp/arcane-onboarding-proof-e21d20321b0f4fc8b872f416c698107e`.
Edge required an execution environment outside the Windows app sandbox, where
its subprocess crashed before page launch. Its profiles and HTTP data remained
temporary and synthetic.
