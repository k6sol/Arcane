# Arcane VFX

An independently authored effect skill and local toolkit for Roblox. It runs without Arcane, an account, a subscription or downloaded art assets.

Copy `skills/arcane-vfx` into your coding agent's skills directory, preserving its folder name. Start with its `SKILL.md`. The helpers require Python 3.10+; the preview runs in a browser without a server or external libraries.

The `vfx-skill` branch contains only this toolkit and has independent history. Clone it with `git clone --single-branch --branch vfx-skill https://github.com/k6sol/Arcane.git ArcaneVFX`.

```sh
python skills/arcane-vfx/scripts/effect.py validate examples/ember-impact.json
python skills/arcane-vfx/scripts/effect.py build examples/ember-impact.json --out output/ember-impact
```

Open the generated `preview.html` to orbit, scrub, play and compare the effect against dark and light backgrounds. `contact-sheet.png` records eight comparison times listed in `build.json`. Generated texture atlases are transparent PNGs. `Effect.luau` holds the validated data and `Runtime.luau` plays a finite, cancellable client effect after you supply your own uploaded texture IDs.

The local preview is an analytic design aid. Native ParticleEmitter randomness, blending and device quality differ; confirm the final look, cancellation and cost in Studio. No helper uploads assets, starts Studio, connects to a provider or modifies a place.

The examples include an ember impact, an icy spell impact and a portal pulse. They are editable starting points for original effects, not physical ice or fluid simulations.

Run the offline checks with `python -B -m unittest discover -s tests`. `node --test tests/timeline.test.cjs` verifies the preview timeline; set `VFX_TEST_PYTHON` to your Python executable to include cross-language parity. If you have the standalone Luau VM, `python -B tests/run_runtime.py --luau PATH_TO_LUAU` exercises the actual runtime against engine fakes, including cancellation and concurrent admission. That fixture does not establish native rendering. The implementation and assets here are original and distributed under the MIT license.
