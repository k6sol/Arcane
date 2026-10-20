# Roblox playback

Put the generated `Runtime.luau` and `Effect.luau` in ModuleScripts accessible to a client controller. Upload your generated atlases through the user's authorized asset workflow, then map each used texture name to its `rbxassetid://...` string. The runtime never uploads or fetches arbitrary source.

```lua
--!strict
local Runtime = require(script.Parent.Runtime)
local effect = require(script.Parent.Effect)
local handle = Runtime.play(workspace, CFrame.new(0, 4, 0), effect, {
    spark = "rbxassetid://YOUR_SPARK_TEXTURE_ID",
    flare = "rbxassetid://YOUR_FLARE_TEXTURE_ID",
})
-- Cancel when the action is interrupted or its owner disappears.
handle:Cancel()
```

The effect owns its host and emitters. It schedules bounded bursts with `Rate = 0`, stops emitting at the end of each window, and keeps the final particles only through their finite lifetime. Cancel clears particles, disconnects its update and destroys its own host. It does not modify its parent, lighting, terrain or other effects. Confirm behavior after replacing placeholder IDs; unresolved or nonnumeric texture strings fail before playback.

Inspect `handle:IsFinished()` and `handle:GetError()` when playback ends. The runtime preflights a complete due frame before emitting. If a long frame stall would exceed the live-particle budget or the authored schedule expires, it cancels explicitly with an error instead of emitting an unbounded backlog. Successfully delayed emissions receive their actual lifetime tail. Admission is bounded to 24 simultaneous effects and 6000 reserved peak particles across those effects; each effect reserves its declared peak budget until it finishes. This is a work limit, not a device performance guarantee.

The preview's seeded radial cone and exponential drag are analytic approximations. Native spread, draw order, flipbook filtering and simulation vary. Verify motion and appearance in a client playtest and measure overlapping instances on the intended device. Do not claim an offline preview proves native quality.

For a Beam, author two Attachments with meaningful tangents; configure segment count to support curvature and the transparency/color keys across its spatial span. For a Trail, attach two edges to the moving object; lifetime describes the trail segment's age, not the whole action. Disable emission on interruption, then clear or retain only the bounded tail appropriate to the action. Test the attachments in motion rather than judging a stationary screenshot.

Official references: [ParticleEmitter](https://create.roblox.com/docs/reference/engine/classes/ParticleEmitter), [particle textures and flipbooks](https://create.roblox.com/docs/effects/particle-emitters), [Beam](https://create.roblox.com/docs/reference/engine/classes/Beam), [Trail](https://create.roblox.com/docs/reference/engine/classes/Trail).
