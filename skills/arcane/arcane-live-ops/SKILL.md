---
name: arcane-live-ops
description: "Design and operate Roblox events, balance updates and feature flags as versioned content with safe rewards, lifecycle transitions and measurable player-facing outcomes."
license: MIT
---

# Add live content without breaking the base game

## Define the experience, not only a timer
State the event/update's player goal, meaningful activities, content variations, progression and reward rules. Reuse core systems deliberately while giving the update real decisions and feedback; a countdown over unchanged gameplay is not deep event content. Keep scope aligned with the request rather than attaching a season system to every balance fix.

Specify start/end in an unambiguous time basis, eligibility, server/config revision, cooldowns and behavior for players or servers spanning a boundary. Server-owned time/config determines eligibility; client clocks drive presentation only. Menus, HUD, world markers and relevant models/animation/VFX/SFX must agree with the active content version and loading/failure state.

## Make rewards and expiry recoverable
Use stable event/content IDs and durable claim identities. Repeated input, reconnect, duplicate delivery or a server retry must not award twice. Define whether unfinished progress carries over, converts or expires, and communicate it clearly. Never delete permanent purchases or player work as an incidental expiry action.

Check data and asset compatibility across old/new servers. Configuration changes need validation and controlled application, not arbitrary live script edits or remote code loading. Define safe behavior for missing definitions, failed config fetch and unavailable assets. Keep the ordinary game playable when an optional event is disabled.

## Roll out with an actual stop path
Use an authorized staging or limited cohort when available. Define observable stop conditions, a versioned rollback and a kill switch for risky optional behavior. Model how each takes effect on existing rounds and pending claims; immediately changing a flag must not strand a transaction or half-start a boss/round. Publication/scheduling is a separate authorized effect, not implied by writing the event plan.

Balance from observed play patterns and stated design goals. Examine completion, frustration, dominant strategies and reward pace with `arcane-analytics`, but do not treat one short-term metric as proof of retention or apply manipulative pressure as a substitute for satisfying content.

## Acceptance around boundaries
Test just before/at/after activation and expiry, long-running servers, rejoin, party/eligibility changes, repeated claims, lost service and rollback. Verify UI/state/rewards remain consistent and permanent progress survives. Capture exact config/content revision and actual player observations. Distinguish authored plans, deterministic time fixtures and real live rollout evidence.
