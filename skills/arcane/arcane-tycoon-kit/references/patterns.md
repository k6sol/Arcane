# Tycoon code patterns (--!strict, server-authoritative)

## Integration boundary: compose one owned business

The retained fragments assume shared Config, profiles, remotes and helper functions; they are not ready-to-run complete services. Connect plot ownership, purchase prerequisites, production, collector credit and requested saves under one lifecycle before enabling. Build the first chain, then the useful alternative branches and visible build-out promised by the brief. Reference prices are tuning hypotheses, not a tested economy.

Bind every drop/spout/upgrader to the original plot epoch and owner so leaving/reclaiming cannot credit another business. Collector processing needs one authoritative claim before credit, not repeated touch awards. Hide/reveal is presentation; server validation still checks current owner, prerequisite and affordability. Purchase/reset mutation must not strand cash and ownership if a helper throws. A busy flag and in-memory Owned attribute do not settle durable commerce or rebirth after a crash.

The save fragment shows a session claim, not every lock-renewal/deadline/recovery condition. Use the actual datastore-safety contract, retain failed-load protection and join original leaving cleanup before resetting/reassigning a plot. Cap drops and remove scheduler entries as original objects disappear; no script per drop. Measure the intended fully developed business, not only the free machine.

GUI/signage should show actual price, benefit, dependencies, balance and reset consequences. Machinery motion, throughput audio and purchase effects must agree with confirmed state and use real authorized media. Test simultaneous claims, another owner's button, insufficient cash, duplicate collection, old drops after release, rapid reset and requested save/rejoin. Full plot/content operation and multiplayer claims remain separate from a passing purchase fragment.

Scripts are created disabled (`scene_create` + `script_update`) and enabled after `script_read` + `script_set_enabled`. Saving code stays disabled unless the user asked for saving (`arcane-datastore-safety`).

## TycoonConfig (ReplicatedStorage.Shared)
```lua
--!strict
return {
	Buttons = {
		{ id = "B01", price = 0, kind = "Dropper", value = 1, interval = 2 },
		{ id = "B02", price = 50, kind = "Dropper", value = 3, interval = 2 },
		{ id = "B03", price = 150, kind = "Upgrader", multiplier = 1.5 },
		{ id = "B04", price = 400, kind = "Dropper", value = 10, interval = 2 },
	},
	RebirthBase = 25000, RebirthGrowth = 2.5, RebirthBonus = 0.5,
	MaxDropsPerPlot = 60, DropLifetime = 20,
}
```

## PlotService (claim and release)
```lua
local Players = game:GetService("Players")
local PlotService = {}
local owners: { [Model]: Player } = {}
function PlotService.plotOf(player: Player): Model?
	for plot, owner in owners do if owner == player then return plot end end
	return nil
end
function PlotService.start(onClaim: (Player, Model) -> ())
	for _, plot in workspace.Plots:GetChildren() do
		local pad = plot:WaitForChild("ClaimPad") :: BasePart
		pad.Touched:Connect(function(hit)
			local player = Players:GetPlayerFromCharacter(hit.Parent)
			if not player or owners[plot] or PlotService.plotOf(player) then return end
			owners[plot] = player
			player:SetAttribute("PlotId", tonumber(string.match(plot.Name, "%d+")))
			onClaim(player, plot)
		end)
	end
	Players.PlayerRemoving:Connect(function(player)
		local plot = PlotService.plotOf(player)
		if plot then owners[plot] = nil end -- after DataService saved; then reset the plot from the template
	end)
end
return PlotService
```

## PurchaseService (touch buttons, validated)
```lua
local busy: { [Player]: boolean } = {}
function PurchaseService.try(player: Player, plot: Model, button: { id: string, price: number })
	if busy[player] or player:GetAttribute("Owned_" .. button.id) then return end
	if PlotService.plotOf(player) ~= plot then return end -- only the owner buys
	local cash = player:GetAttribute("Cash") :: number? or 0
	if cash < button.price then Notify:FireClient(player, "Need $" .. button.price) return end
	busy[player] = true
	player:SetAttribute("Cash", cash - button.price)
	player:SetAttribute("Owned_" .. button.id, true)
	reveal(plot, button.id) -- parent stored Buyables/<id>_* back into the plot, show next button
	busy[player] = nil
end
```
Buttons that are not yet unlocked are not in Workspace, so they cannot be touched early.

## DropperService (one loop, capped drops)
`reveal()` tags each bought dropper's `Spout` with `TycoonSpout` and sets its `Value`/`Interval` attributes from the config (scene_build cannot add tags or attributes).
```lua
local RunService = game:GetService("RunService")
local CollectionService = game:GetService("CollectionService")
local Debris = game:GetService("Debris")
local live: { [Model]: number } = {}
local nextTick: { [BasePart]: number } = {}
CollectionService:GetInstanceRemovedSignal("TycoonSpout"):Connect(function(spout) nextTick[spout] = nil end)
RunService.Heartbeat:Connect(function()
	local now = os.clock()
	for _, spout in CollectionService:GetTagged("TycoonSpout") do
		if (nextTick[spout] or 0) > now then continue end
		local plot = plotOfPart(spout) -- the ancestor that is a direct child of workspace.Plots
		nextTick[spout] = now + (spout:GetAttribute("Interval") :: number? or 2)
		if (live[plot] or 0) >= Config.MaxDropsPerPlot then continue end
		local drop = Instance.new("Part")
		drop.Size = Vector3.new(1, 1, 1); drop.CollisionGroup = "Drops"; drop.CanTouch = true
		drop:SetAttribute("Value", spout:GetAttribute("Value"))
		drop.CFrame = spout.CFrame * CFrame.new(0, -1.5, 0)
		drop.Parent = plot.Drops
		drop:SetNetworkOwner(nil) -- server owns physics
		live[plot] = (live[plot] or 0) + 1
		drop.Destroying:Once(function() live[plot] -= 1 end)
		Debris:AddItem(drop, Config.DropLifetime)
	end
end)
```
Collector: `Touched` -> if the part is in `plot.Drops`, add `Value * multiplier` to the owner's Cash, then `Destroy()`. Upgrader: a thin part on the belt that multiplies `Value` once per drop (`Upgraded` attribute guard).

## RebirthService (RemoteFunction, idempotent)
```lua
Rebirth.OnServerInvoke = function(player)
	if busy[player] then return false end
	local rebirths = player:GetAttribute("Rebirths") :: number? or 0
	local cost = Config.RebirthBase * Config.RebirthGrowth ^ rebirths
	if (player:GetAttribute("Cash") :: number? or 0) < cost then return false end
	busy[player] = true
	player:SetAttribute("Rebirths", rebirths + 1)
	player:SetAttribute("Cash", 0)
	clearOwned(player) -- reset Owned_* and rebuild the plot from the template
	busy[player] = nil
	return true
end
```

## DataService record (session-locked UpdateAsync)
```lua
local ok, record = pcall(function()
	return store:UpdateAsync("u_" .. player.UserId, function(old)
		old = old or { version = 1, data = { cash = 0, rebirths = 0, owned = {}, lifetimeCash = 0 } }
		if old.lock and old.lock.jobId ~= game.JobId and os.time() - old.lock.time < 1800 then return nil end
		old.lock = { jobId = game.JobId, time = os.time() }
		return old
	end)
end)
local claimed = ok and record and record.lock and record.lock.jobId == game.JobId
```
Retry this pcall with `GetRequestBudgetForRequestType` checks and 1/2/4/8 s backoff. If the claim fails, do not create a plot or save anything for that player. Saves write `data` only when `old.lock.jobId == game.JobId`; the leaving save sets `lock = nil`. BindToClose saves all loaded players in parallel and waits (<= 25 s).

## Conditional tuning examples from the original kit

These inherited figures describe one starting configuration, not universal limits, verified performance or required mechanics. Choose relevant values for the actual brief, bind total resources to the intended audience/device and measure them in real play. Vehicle/platform motion, threat readability and commerce/persistence still require the integration checks above. Do not weaken supported-tool or production bounds to fit an example.

### Balancing (starting numbers)
| Item | Price | Effect |
|---|---|---|
| Dropper 1 | 0 (free) | drop $1 every 2 s |
| Dropper 2 | 50 | $3 / 2 s |
| Upgrader | 150 | x1.5 on pass |
| Dropper 3 | 400 | $10 / 2 s |
| Walls / decor | 100-600 | cosmetic, unlock pacing |
| Dropper 4 | 1,500 | $35 / 2 s |
| Dropper 5 | 6,000 | $120 / 2 s |
Next item price ~ 2.2-2.8x previous; each purchase pays back in 40-120 s. First purchase within 30 s, full plot in 25-40 min. Rebirth cost `25,000 * 2.5 ^ rebirths`; reward multiplier `1 + 0.5 * rebirths`; resets cash and owned, keeps rebirths.

### Performance budgets
<= 60 live drops per plot (oldest destroyed; Debris 20 s lifetime), drops CanTouch only on collector, 1 server loop ticking all droppers, <= 800 parts per plot, <= 4 plots per server; drops `CanCollide` with belt only via CollisionGroup `Drops`.
