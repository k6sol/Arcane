# Arcane motion and interaction contract

The desktop workbench and provider lab retain the established charcoal/red reference, Segoe UI typography, branded rail, split conversation/artifact workspace and real controls. The supplied house is an example of a user's artifact, never an application demo. This polish changes only studio.css, lab.css, this document and the motion contract test. No HTML, TypeScript, backend, package, Electron host or provider lifecycle changes are required.

## Timing and input

All timed CSS is inside prefers-reduced-motion: no-preference. Control feedback takes 120 ms; sidebar/thumbnail transforms take 180 ms; a surface reveal takes 200 ms. Reveals move 4 px from 94% to full opacity, once, with no delay or backwards fill. Welcome, search results, verified preview figures and the lab setup panel are the only revealed surfaces. Rebuilt streaming message rows, provider refresh rows, errors, loading messages, approvals and dialogs stay immediate.

Press moves an enabled control 1 px. Fine-pointer hover lifts starter actions 1 px and preview figures 2 px. Keyboard focus uses a distinct 2 px red outline; active navigation retains its red edge/underline, and selected preview figures have a persistent border. Hover does not select a model, generate an artifact, submit work, accept an approval or manufacture progress. Touch receives focus/press feedback without sticky hover movement.

The final reduced-motion block disables all CSS transitions and animations, including pseudo-elements, and restores immediate scrolling with important declarations. Navigation and selected-state updates still work. No stylesheet requests smooth scrolling. Static state changes remain visible under reduced motion.

## Rendering and responsive behavior

Transitions name only transform, opacity, background-color, border-color and color. Keyframes use only opacity and transform. There are no recurring animations, animated filters/blur/shadows, geometry transitions, permanent will-change hints, scroll-linked animations, observers or new polling loops.

Only real manifest-verified figures carrying the shell's role=button receive preview motion. Canvas drawing, intrinsic dimensions, image decoding and backing stores are unchanged. Choosing the hero figure updates the existing grid immediately; width, height, max-height, order and grid tracks are never tweened. No reveal is attached to streaming conversation rows because the existing controller rebuilds them on public deltas.

Desktop layout remains the split workspace. Laptop tabs and preview actions remain reachable. Narrow screens use a scrollable tab row and a bounded, scrollable navigation section; the existing sidebar toggle can collapse that section. Composer choices wrap, search results fit the viewport, and preview/approval content keeps its own scroll area. Disabled model selection stays visible. Existing application-owned hidden attributes still govern conditional content.

The parent supplied the Electron first-show capture runtime/verification/exe-dev-8TkRZO/workspace.png (1496 x 921); it motivated a bounded readability pass. Functional status/composer/stage labels use a 10 px minimum, and tool actions, preview guidance, captions and message metadata use 11 px. Tracked wordmark, rail and decorative brand lettering retain their existing sizes. Live status copy wraps so long error text remains readable.

Content panes retain stable scrollbar gutters. The sidebar uses a quiet, transparent-track 6 px Chromium scrollbar; its thumb becomes clearer on pointer hover or keyboard focus. Other browsers retain a thin standard scrollbar. Forced colors restores system scrollbar colors and a system selection/focus mark.

## Verification

Run only:

~~~powershell
node --test --test-isolation=none tests/release/motion.test.mjs
~~~

The in-process option avoids a child-process spawn in restricted Windows sandboxes. All 12 scoped contracts passed. Script-free browser review at 1440 x 900, 1024 x 768 and 390 x 844 found no page-level horizontal overflow; narrow tab overflow stayed inside its scrollable row and model/preview controls remained rendered.

The readability refinement was also reviewed at 1496 x 921, 1024 x 768 and 390 x 844. The sidebar thumb stayed 6 px when keyboard focus increased its opacity from .28 to .65; functional label sizes were confirmed from computed styles, with tracked brand copy unchanged.

The dependency-free deterministic contract parses both complete stylesheets with nested media/keyframe context. It checks full reduced-motion coverage, opt-in gating, explicit transition properties, 200 ms maximum durations, single-iteration reveals without delays, precise-pointer hover transforms, canvas isolation, preserved responsive controls, keyboard focus, functional label sizes, bounded sidebar thumb geometry and forced-color scrollbar behavior. The scanner itself is checked against nested blocks and functional commas.

These contracts do not prove native provider, live Studio or Electron host behavior. This task does not run those tests or the full suites. Any browser review uses script-free local fixtures of the current markup and styles; fixture states are synthetic and make no claim of successful generation or provider access.
