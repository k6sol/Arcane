# Racing code patterns (--!strict, server-authoritative timing)

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
