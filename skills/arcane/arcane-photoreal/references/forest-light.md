# Forest light presets (Future lighting)

`environment_apply` `preset: "forest-morning"` (or `forest-noon`, `forest-golden-hour`, `forest-overcast`, `forest-dusk`) expands host-side to the exact values below. Each one also sets `technology: "Future"` (an explicit `technology` wins), a subtle `depthOfField`, the built-in `sky` (the default skybox; no custom texture ids) and, when the session has the Workspace grant, `soundService: {AmbientReverb: "Forest"}`. Add only the fields you want to change; explicit section values win per field.

## Lighting
| preset | ClockTime | GeographicLatitude | Brightness | ExposureCompensation | EnvironmentDiffuseScale / SpecularScale | ShadowSoftness | Ambient | OutdoorAmbient | ColorShift_Top |
|---|---|---|---|---|---|---|---|---|---|
| forest-morning | 7.4 | 48 | 2.4 | 0.15 | 0.9 / 0.8 | 0.25 | 0.06,0.065,0.07 | 0.38,0.4,0.44 | 1,0.82,0.6 |
| forest-noon | 12.5 | 40 | 3.2 | -0.1 | 1 / 1 | 0.12 | 0.06,0.065,0.07 | 0.48,0.5,0.52 | 0.18,0.16,0.1 |
| forest-golden-hour | 17.7 | 45 | 2.2 | 0.25 | 0.9 / 0.9 | 0.3 | 0.08,0.065,0.055 | 0.5,0.42,0.36 | 1,0.72,0.42 |
| forest-overcast | 11 | 52 | 1.2 | 0.2 | 1 / 0.5 | 0.9 | 0.1,0.105,0.11 | 0.52,0.55,0.56 | 0,0,0 |
| forest-dusk | 18.6 | 45 | 1 | 0.35 | 0.7 / 0.8 | 0.5 | 0.05,0.05,0.08 | 0.24,0.24,0.34 | 0.75,0.45,0.35 |

Why: in Future, Ambient is the light in places the sky cannot reach, so it stays near 0.06-0.1 to keep deep shade under the canopy; OutdoorAmbient is the sky fill. A higher latitude keeps the sun low across the sky (long morning shadows). ShadowSoftness rises with cloud cover. ColorShift_Top tints sunlit surfaces warm at a low sun.

## Atmosphere and post-processing
| preset | Atmosphere Density / Offset / Haze / Glare | Atmosphere Color / Decay | Bloom Intensity / Size / Threshold | SunRays Intensity / Spread | ColorCorrection Contrast / Saturation / TintColor | DepthOfField Far / FocusDistance / InFocusRadius | Sky |
|---|---|---|---|---|---|---|---|
| forest-morning | 0.36 / 0.12 / 2.2 / 0.45 | 0.85,0.82,0.76 / 0.92,0.72,0.5 | 0.45 / 28 / 1.3 | 0.12 / 0.75 | 0.08 / 0.06 / 1,0.97,0.92 | 0.08 / 60 / 50 | SunAngularSize 16 |
| forest-noon | 0.28 / 0.2 / 1 / 0.15 | 0.78,0.84,0.9 / 0.6,0.68,0.74 | 0.3 / 24 / 1.6 | 0.05 / 0.5 | 0.06 / 0.04 / 1,1,0.98 | 0.05 / 80 / 50 | SunAngularSize 12 |
| forest-golden-hour | 0.34 / 0.1 / 2 / 0.7 | 0.96,0.78,0.6 / 0.92,0.56,0.34 | 0.6 / 30 / 1.15 | 0.14 / 0.85 | 0.1 / 0.12 / 1,0.94,0.86 | 0.1 / 50 / 45 | SunAngularSize 18 |
| forest-overcast | 0.45 / 0.04 / 2.6 / 0 | 0.74,0.77,0.79 / 0.6,0.64,0.66 | 0.25 / 20 / 1.8 | 0 / 0 | 0.04 / -0.12 / 0.95,0.98,1 | 0.12 / 40 / 40 | CelestialBodiesShown false |
| forest-dusk | 0.4 / 0.08 / 2.2 / 0.25 | 0.55,0.5,0.62 / 0.62,0.38,0.32 | 0.7 / 30 / 1 | 0.04 / 0.6 | 0.1 / -0.08 / 0.92,0.92,1 | 0.12 / 40 / 35 | StarCount 1500, MoonAngularSize 11 |

NearIntensity is always 0 (the player's own avatar stays sharp). Sane ranges for tuning: Atmosphere Density 0.25-0.5 in a forest (0.7+ hides the far trees), Haze 1-3, Glare 0-0.7 (only with a visible sun); Bloom Threshold 1 or more; SunRays Intensity 0.03-0.15 for god-rays through the canopy; DepthOfField FarIntensity 0.15 or less, InFocusRadius 35-50 (gameplay stays readable).

## Ambient life and sound (scene_build plinth kit `life`)
- `life: "day"` adds a hidden MoteVolume part over the clearing with a DustMotes emitter (sparkles_main, Rate up to 10, Lifetime 6-10, Rate x Lifetime <= 100), a soft unshadowed PointLight RuneLight in the spawn (Brightness 0.5, Range 6-12, a8d8ff) and an Ambience SoundGroup with Wind (global bed, Volume 0.25) and Birds (positional, InverseTapered 15-120).
- `life: "dusk"` (pair with forest-dusk) brightens the rune light to 1.2, swaps Birds for Crickets and adds a FireflyVolume with Fireflies (Rate 4, Lifetime 6-9, about 36 live).
- No verified built-in wind or bird audio exists, so these Sounds are hooks without a SoundId: use an id the user gives or one from `studio_asset_search` category Audio, set it with Playing true, and tell the user which layer is still silent. Never invent ids.
