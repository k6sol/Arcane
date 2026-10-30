---
name: arcane-game-design
description: "Design coherent Roblox games with meaningful decisions, complete player journeys, appropriate content breadth and testable gameplay hypotheses."
license: MIT
---

# Design a game that holds together

## Define the player's experience
State the fantasy, audience, camera/input assumptions, social format and intended session length. Describe the repeated action, readable feedback, consequence and reason to try again. Identify the decisions, their trade-offs and counterplay. A theme, lobby or list of systems is not a core loop.

Choose a few distinctive pillars that change play and presentation. Make mechanics, environments, models, interface, animation and sound reinforce those pillars. Do not add grinding, random loot, PvP, paid advantages or jump scares merely because another genre uses them. Respect an existing game's identity and the user's requested scope.

## Specify the complete journey
Map first launch→learn controls→first success→develop mastery→setback/recovery→session result→return. Define what the player can do and what the game communicates at every stage. Include empty, waiting, loading, insufficient-player, disconnect and saved-data-unavailable states where applicable. Choose how a solo test differs from the intended player count without weakening multiplayer rules.

For a full game, make a content matrix: location/challenge, purpose, distinctive geometry or rule, difficulty, reward/consequence, art identity, dependencies and acceptance. Build enough meaningful variation to support the intended session. A short narrative game may use one coherent location with several developed situations; a multi-course game needs genuinely different courses and tested transitions. Do not invent a universal map count or count cosmetic duplicates as depth.

Define progression only when it serves the loop: unlock conditions, resource sources/sinks, caps, recovery and content pacing. Keep ownership and rewards authoritative. Avoid a progression curve that needs unrequested purchases or hours of empty repetition to conceal little content. Refer to the actual economy, persistence and monetization skills for their contracts.

## Connect rules to production
Create a state graph with entry/exit conditions, authoritative owner, player actions, visible UI, animation, sound/VFX feedback and cleanup for each state. Specify cancellation and denial feedback as well as the happy path. For example, a charged action needs wind-up/readability, a legitimate cancel, impact/outcome and recovery; an unused animation hook is not that feature.

Identify the highest-risk mechanic, import or interaction and prove a representative slice early. Use that evidence to tune the plan, then finish the requested content and supporting systems. A slice is not the final full-game deliverable. Assign `arcane-project-director` the dependency and completion register.

## Evaluate the actual game
Write observable questions: does a new player find the first objective, understand success/failure, make different choices, recover without restarting everything, and encounter new decisions later? Test with real input and representative players/devices when available. Record observed behavior and unresolved assumptions; do not invent retention data, market success or a fun score.

Acceptance requires a functioning loop, completed planned content, integrated presentation and usable recovery. Inspect polished scenes and gameplay together: visual spectacle cannot replace interaction, and functional grayboxes cannot satisfy a finished art brief. Keep capability-blocked assets/audio/imports explicit instead of silently reducing the design after promising completion.
