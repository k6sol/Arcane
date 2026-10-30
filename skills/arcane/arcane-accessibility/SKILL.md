---
name: arcane-accessibility
description: "Identify and remove Roblox barriers in essential information, controls, motion, audio and GUI while preserving intended challenge and testing the actual accommodated play path."
license: MIT
---

# Access to the intended challenge

## Audit the required path
Identify what a player must perceive, decide and do from entry to an actual success/failure and recovery. Read existing audience/device needs and settings. For a full game include onboarding, gameplay cues, menus/results and reconnect/respawn where relevant; for a focused issue test its affected action rather than inventing a settings overhaul.

Separate intentional challenge from avoidable barriers: tiny or clipped labels, colour-only team/danger cues, inaudible instructions, hover-only actions, trapped focus, accidental camera shake and overlapping touch controls. Preserve the chosen game difficulty and art direction; accessibility does not mean making every challenge trivial.

## Make information available
Use redundant essential cues: shape/text/location as well as colour, visible feedback for an important sound, and clear labels for unfamiliar icons. Captions should identify meaningful dialogue or directional/event information without covering the action or transcribing every irrelevant ambient sound. Do not claim supported screen-reader behavior or platform accessibility integration without testing the actual capability.

Use readable hierarchy, wrapping and appropriate text scaling. As design targets, check approximately 4.5:1 ordinary text contrast and 3:1 important graphical/control boundaries against their actual backgrounds, including focus and failure states. A nominal palette ratio does not cover text over moving scenery, translucent panels or a colour-corrected game. Check the real smallest supported layout and translated strings.

## Make actions and preferences work
Use the supported mouse/touch/controller routes and deliberate focus order, including modal open, confirm, cancel, back and close. Targets need usable size/separation; a 44px starting target still requires a real device/layout check. Avoid hover-only instructions and release controls on interruption. Consider hold-versus-toggle, repeated-input burden, remapping or time adjustments when they address the actual need and preserve the intended rules.

Offer reduced shake/flash/motion and separate meaningful audio controls when relevant. Bind settings to the real camera, animation/VFX and sound groups rather than storing unused toggles. Preserve essential telegraph timing/information under a reduced effect; removing a danger warning is not accommodation. Do not add purchase or success barriers to access settings.

## Acceptance
Run the critical path using each advertised input and the selected accommodations, including rejection/failure and recovery. Check focus restoration, text entry, safe areas, touch overlap, colour-independent interpretation, mute/captions and reduced-motion effect behavior. Confirm settings remain effective through round change and respawn, and persist only when the product actually supports that.

Use actual action traces, observed state, measured layout/contrast where available and representative player feedback. Supported human-approved playtests provide bounded evidence; captures are appearance context and unsupported assistive technology remains untested. Record specific barriers, fixes and remaining gaps. One automated contrast result or a successful source check cannot establish accessibility compliance or complete player inclusion.
