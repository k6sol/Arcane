---
name: arcane-localization
description: "Prepare Roblox interfaces and permitted player-facing text for multiple languages with real layout, filtering and fallback checks."
license: MIT
---

# Localization and text presentation

## Inventory the actual strings
Identify UI copy, plural/numeric/date formats, subtitles and permitted user-authored text. Keep content keys separate from presentation and preserve source/context for translators. Do not confuse machine-generated translations with reviewed localization.

Use the current platform localization and filtering paths appropriate to each text type. Provide fallback behavior for missing entries. Avoid concatenating sentence fragments that cannot reorder naturally or hard-coding widths based on English.

Check expanded text, directionality where supported, font coverage and controller/touch navigation. Keep critical instructions short but meaningful. Owner names, protected branding and game-specific terms need explicit handling.

## Verification
Run representative long/missing translations and selected locales in engine. Inspect clipping, sorting/formatting and subtitle timing, plus filtered user text where relevant. Do not claim all-language support from a single translated screenshot. Preserve the requested voice/tone rather than replacing copy wholesale.
