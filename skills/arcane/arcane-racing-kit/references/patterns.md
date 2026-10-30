# Racing code patterns (--!strict, server-authoritative timing)

## Integration boundary: fragments are not a finished racer

The retained code below illustrates individual responsibilities; Config, RaceService, vehicle ownership and lifecycle wiring are not supplied as a complete module. Keep original project baselines and make only granted edits. Build a small driving proof before the requested full course/event roster, then validate every selectable track through countdown, ordered traversal, finish, results and replay.

The driverOf fallback deliberately recognizes a walking character, which can exercise gate plumbing in a single-client scenario. A production vehicle race must instead bind progress to its actual eligible entrant/vehicle and intended traversal, with direction, reset and shortcut rules. Do not claim that the foot test proves valid driving. The sample gate count assumes a clean ordered inventory; validate names/order and stale round/vehicle callbacks. Timing initialization and finish awards belong to the same current race epoch.

Constraint values are hypotheses for a particular assembly. Verify attachment axes, collisions, steering, mass, traction, network-owner transitions and reset velocities in actual play; the hinge helper is not a tested universal chassis. Restore input/camera on exit and remove only the original owned vehicle. Requested best-time persistence needs track/rules identity and the genuine profile/duplicate-award path, not only board writes.

Compose course selection, useful vehicle choices, race HUD and readable results/retry around actual server events. Engine/skid audio, wheel animation and boost effects use real authorized assets and bounded cleanup. Test reverse/skip gates, reset abuse, countdown, DNF/leaving, repeated races and every delivered course's seams/corners. Multi-car physics and device handling remain untested until exercised; source snippets cannot replace that acceptance.

Scripts start disabled (`scene_create` + `script_update`), then `script_read` + `script_set_enabled`. Constraint tuning and network ownership: `arcane-physics`.

## RaceConfig
```lua
--!strict
return {
	Laps = 3, Countdown = 3, FinishGrace = 30, OffRoadReset = 2,
	Kart = { maxSpeed = 90, torque = 12000, turnSpeed = 1.2, steerAngle = 30, wheelFriction = 1.6 },
}
```

## CheckpointService (ordered gates, laps, timing)
```lua
local Players = game:GetService("Players")
local cps = workspace.Track.Checkpoints
local count = #cps:GetChildren()
local lapStart: { [Player]: number } = {}
Players.PlayerRemoving:Connect(function(player) lapStart[player] = nil end)

local function driverOf(hit: BasePart): Player?
	local model = hit:FindFirstAncestorOfClass("Model")
	local seat = model and model:FindFirstChildWhichIsA("VehicleSeat", true)
	local occupant = seat and seat.Occupant
	return if occupant then Players:GetPlayerFromCharacter(occupant.Parent) else Players:GetPlayerFromCharacter(hit.Parent)
end

for _, gate in cps:GetChildren() do
	local n = tonumber(string.match(gate.Name, "^CP_(%d+)$"))
	if not n then continue end
	gate.Touched:Connect(function(hit)
		local player = driverOf(hit)
		if not player or workspace:GetAttribute("RaceState") ~= "Racing" then return end
		local nextCp = player:GetAttribute("NextCheckpoint") :: number? or 2
		if n ~= nextCp then return end -- wrong way or skipped gate
		player:SetAttribute("LastCheckpoint", n)
		if n == 1 then
			local now = workspace:GetServerTimeNow()
			local lapTime = now - (lapStart[player] or now)
			lapStart[player] = now
			if lapTime > 0 and lapTime < (player:GetAttribute("BestLap") :: number? or math.huge) then
				player:SetAttribute("BestLap", lapTime)
			end
			local lap = (player:GetAttribute("Lap") :: number? or 1) + 1
			player:SetAttribute("Lap", lap)
			if lap > Config.Laps then RaceService.finish(player, now) end
		end
		player:SetAttribute("NextCheckpoint", if n == count then 1 else n + 1)
	end)
end
```
At GO: `lapStart[p] = GetServerTimeNow()`, `Lap = 1`, `NextCheckpoint = 2`, then unanchor karts.

## VehicleService (constraints at spawn)
```lua
local function hinge(a: BasePart, b: BasePart, motor: boolean): HingeConstraint
	local a0, a1 = Instance.new("Attachment"), Instance.new("Attachment")
	a0.Parent, a1.Parent = a, b
	a0.CFrame = a.CFrame:ToObjectSpace(b.CFrame) * CFrame.Angles(0, 0, math.rad(90))
	a1.CFrame = CFrame.Angles(0, 0, math.rad(90))
	local h = Instance.new("HingeConstraint")
	h.Attachment0, h.Attachment1 = a0, a1
	if motor then h.ActuatorType = Enum.ActuatorType.Motor; h.MotorMaxTorque = Config.Kart.torque end
	h.Parent = a
	return h
end
-- Spawn: clone Kart, PivotTo grid slot, weld body parts (WeldConstraint), hinge each wheel to the chassis
-- (front wheels to steering knuckles driven by a Servo hinge, +/- steerAngle).
-- Seat.Changed(Occupant): SetNetworkOwner(driver) while seated, nil when empty; despawn empty after 20 s.
-- Drive loop (server, 20 Hz): motor AngularVelocity = seat.ThrottleFloat * maxSpeed / wheelRadius;
-- servo TargetAngle = seat.SteerFloat * steerAngle.
```

## Reset and out-of-bounds
`ResetVehicle` (rate-limited 1 per 3 s): the server pivots the kart to `CP_<LastCheckpoint>` facing the next gate, zeroes `AssemblyLinearVelocity`/`AssemblyAngularVelocity`. KillZone Touched does the same automatically after `OffRoadReset` seconds.

## Positions (4 Hz)
Sort racers by `(Lap desc, progressIndex desc, distanceToNext asc)` where progressIndex = (NextCheckpoint - 2) mod count; set `Position` attribute; HUD renders it.

## Data record and board
`{ version = 1, lock = { jobId, time }, data = { bestLap = { [trackId] = seconds }, wins, races, coins } }` via session-locked UpdateAsync with budget-checked retries. Best-lap board: OrderedDataStore `BestLap_<trackId>`, UpdateAsync keeping the lower integer milliseconds; refresh the board every 60 s with `GetSortedAsync(true, 10)`.

## Conditional tuning examples from the original kit

These inherited figures describe one starting configuration, not universal limits, verified performance or required mechanics. Choose relevant values for the actual brief, bind total resources to the intended audience/device and measure them in real play. Vehicle/platform motion, threat readability and commerce/persistence still require the integration checks above. Do not weaken supported-tool or production bounds to fit an example.

### Vehicle setup basics
| Kart | Top speed | Motor torque | Steer | Grip F/R |
|---|---|---|---|---|
| Starter | 70 | 10,000 | 32 deg | 1.6 / 1.5 |
| Sport | 90 | 12,000 | 28 deg | 1.6 / 1.4 |
| Pro | 110 | 15,000 | 24 deg | 1.7 / 1.4 |
- Chassis 6 x 1.5 x 10, wheels 3.2 diameter Cylinder parts (friction = grip via CustomPhysicalProperties). A lap of a starter track takes 45-75 s.
- VehicleService adds Attachments + HingeConstraints (Motor, AngularVelocity from Throttle) and front steering HingeConstraint (Servo, +/- the Steer value) at spawn; scene_build has no constraint classes.
- `SetNetworkOwner(driver)` while seated, `nil` when empty; despawn empty karts after 20 s.

### Performance budgets
<= 8 karts per server, <= 25 parts per kart, track <= 6,000 parts with StreamingEnabled, checkpoint checks server-side via Touched on gates (no per-frame scans), position update 4 Hz.
