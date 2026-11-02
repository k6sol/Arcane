---
type: feature
project: Arcane
tags: [arcane, blender, materials, import]
---
# Rock texture detail

Natural boulders, outcrops and cave rocks now support an explicit textureResolution of512 or1024 with finish:natural. Omitting the option preserves existing canonical requests and512 pixels. Flat/legacy unsupported combinations and other sizes fail before authoring. The MCP schema advertises the option, and natural-scene guidance selects1024 for close-up rocks and512 for background assets without substituting texel count for convincing geometry or inspected materials.

```json
{"name":"detailed-rock","seed":31,"generator":{"kind":"rock","form":"boulder","finish":"natural","size":[1.6,1.2,0.9],"roughness":0.7,"textureResolution":1024}}
```

1024 gives four times the texels and fits the existing connected-image dimension limit. Imported images, aggregate pixel data, packet limits, triangle budgets, worker/query deadlines and human review requirements are unchanged. Explicit resolution must match measured surface evidence; it cannot use the older256-pixel tile fallback. Assembly recipes and tree atlases retain their existing accepted sizes.

The rasterizer handles wide triangles in tiles no larger than512x512 samples while retaining the earlier batch bound. At1024 it clips candidate bounds to actual image pixels and scales gutter fill to preserve physical padding. A frozen hash-pinned full512 production module preserves the original material-control baseline. All512 output-map float32 arrays remain byte-identical, and resolution changes leave the5488-triangle geometry and UV bake unchanged.

## Verification

Strict compilation covers660 sources. The final compiled host/MCP/material/import selection passes45 enabled cases, with two existing native-report cases unconfigured locally. The first run had one invalid positive fixture because its preview dimensions did not match its request; that fixture was corrected before the successful frozen-input run. Five real NumPy map/geometry/raster tests and seven existing material-control tests pass. A strengthened wide-triangle case additionally verifies distant tiles and world-metres-per-texel with the same scratch bound.

All45 skill-pack/catalogue checks pass with no skips. The initial run correctly refused an outdated checksum and CRLF source bytes; stable LF and the refreshed experimental skill checksum resolve those failures without changing approval or behavioral-run status.

One isolated production-pipeline run in installed headless Blender4.5 completes in38.3seconds under the original180-second/two-thread limits, including three1024 maps, export roundtrips and saved-scene reopen. All original workers close. Both actual renders were inspected. This is an incremental texture-density capability; the current geological form/material still requires further art work to meet the requested realism.

![[Assets/Reviews/2026-11-02 Rock Detail Hero.png]]
![[Assets/Reviews/2026-11-02 Rock Detail Side.png]]

The actual generated GLBs also pass production offline adaptation, decoding and transfer construction against an explicitly synthetic target: four PBR maps,16MiB RGBA,107 packets and22639850 serialized bytes. Zero staging commands, uploads or Studio operations occur, and no human approval is granted by that data check. The mandatory hosted native fixture now requests1024 and repeats these production data checks before retaining its real review images. Hosted Blender5.2, packaged/customer UI and actual Studio acceptance remain pending for this newer source. The installed409 runtime is unchanged.

[[Delivery/G05 Blender Quality]] - [[Delivery/G06 Connected Import]] - [[Operations/Next Session]] - [[Skills/Production Upgrade]]

## Native runtime test correction

The original hosted run41547904126 on3d9dfa4 failed on both operating systems before generation: the new resolution suite imported NumPy under runner Python, where NumPy was absent. These original failures remain recorded. The workflow now executes that same five-case suite inside the checksum-verified pinned Blender5.2.3 runtime, after acquisition, through a dedicated native launcher. It requires all five cases with no skips and checks the actual Blender version; the original110-second child and120-second test bounds remain. No dependency fallback, test exclusion or runtime-pin change is introduced.

The corrected Python launcher passes all five cases in local Blender4.5.3 in17.3seconds and exits normally. Node launcher syntax and Git whitespace checks pass. This local check does not establish hosted5.2.3 acceptance.
