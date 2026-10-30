# Shooter / tactical combat

Players choose position, timing, range role and team contribution. Start from the requested camera/input and mode; do not automatically turn every shooter into the same elimination arena. Readable cover, fair spawns and reliable hit feedback matter more than the size of the weapon list.

## A complete fight and match

First prove spawn -> move/aim -> fire/defend -> confirmed outcome -> death/respawn or result. A full brief needs the promised maps, objectives, useful equipment variety and replay flow, with each map changing decisions. Design sightlines, flanks, cover height, traversal and objective pressure together. Prevent spawn traps through actual views/routes, not only a minimum distance formula.

Clients may predict cosmetics; the server owns rate/ammo, weapon eligibility, live phase, finite plausible origin/direction, occlusion, damage and score. Bound replay and latency tolerance. A placeholder history query is not working lag compensation, and a client hit list is not authority. Decide assists, teams, simultaneous kills, spawn protection and late join/spectator policy. Use `arcane-combat` and `arcane-arena-kit` for relevant integration, not unverified copy-paste systems.

## The sensory contract

Weapon silhouette, aim/reload/recoil animation, muzzle/impact effects, positional audio, HUD ammo and hit confirmation must describe the same action. Make denied/empty actions legible and avoid constant shake/flash obscuring targets. Support the requested devices and reduce-motion alternatives. Real rigs and authorized sound/animation IDs need actual playback checks; a tracer render does not prove that combat works.

Test near-cover shots, whiffs, edge contacts, rapid switches, duplicate fire, latency and interruption. Play entire matches and repeated map transitions; compare spawn pressure and tactical choices with real participants. Measure query/projectile/effect budgets under intended concurrency. Keep source/security fixtures, single-client aiming and actual multiplayer fairness distinct; no technical pass proves competitive balance or a completed content roster.
