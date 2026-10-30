---
name: arcane-localization
description: "Localize the actual Roblox game text and presentation with contextual keys, safe user-text boundaries, robust fallback and measured layout, subtitle and locale behavior."
license: MIT
---

# Localization that survives real screens and play

## Inventory the player-facing contract
Identify the requested languages and actual audience. For a full game cover onboarding/objectives, HUD/results, menus, interaction errors, item descriptions and dialogue/subtitles that the game uses. For one screen, preserve its voice and scope. Do not claim a locale complete because its title changed.

Give stable keys enough context: who speaks, where text appears, action/subject, variable meaning, character/line limits and translator notes for game-specific terminology. Keep source text and a glossary for recurring items, controls and place names. Usernames, protected branding and proper names need deliberate handling rather than automatic translation.

## Separate content from presentation
Use the current supported localization path appropriate to the actual project; loading this skill does not create a LocalizationTable import/export tool or authorize hosted translation. Keep authored keys/content separate from UI wiring and server state. Avoid concatenating translated sentence fragments or assuming English word order. Prefer complete messages with named variables and locale-aware plural/number/date/time formatting through verified supported facilities.

Treat authored game copy, player-authored text and untrusted network/source data differently. Use the required current platform filtering path for user-visible user text; translation does not replace filtering or make markup safe. Do not let raw player text become RichText commands, executable source or localization keys without validation. Keep permissions and sensitive values out of translator strings.

Define missing-entry, failed-load and unsupported-locale fallback. A readable source-language message is better than an empty action button or a raw key. Machine-written translations are drafts until reviewed by an appropriate speaker; retain provenance and do not describe them as certified.

## Make the layout and media adapt
Allow realistic text expansion and reordering with wrapping, flexible panels and suitable scrolling. Check the actual font's glyph coverage, diacritics, line height and truncation. Numbers, timers, currencies and sorting must match the product's intended semantics, not just translated labels. Directionality depends on the actual supported GUI/text path; do not claim right-to-left support from reversing a string.

For dialogue or timed instructions, fit caption duration to readable localized content and actual audio timing. Keep critical controls reachable and action names consistent with the current input device. Do not bake indispensable instructions into an image without a localized alternative.

## Acceptance
Exercise the actual critical screens and gameplay messages in the requested locales, with long translations, missing keys, zero/one/many counts, long names and relevant non-Latin/directional samples. Inspect phone/controller layouts, clipped text, fallback, ordering/formatting, subtitle timing and error/denial states. Test applicable user-text filtering separately from authored translation.

Use the supported human-approved playtest path and actual observations for behavior; a single translated screenshot is appearance evidence only. Record which strings/locales were authored, speaker-reviewed, engine-tested or still draft, plus unavailable filtering/formatting capabilities. Preserve the game's intended tone without presenting machine translation or a successful table write as all-language acceptance.
