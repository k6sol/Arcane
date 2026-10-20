# Model spec: any original object as a part graph

`assets_procedural` with `generator: {kind:"spec", ...}` compiles a declarative part graph into one clean game-ready model: watertight welds and cuts, triangle budget, auto-smooth normals, base pivot, packed UV0 atlas, baked PBR with edge wear and cavity dirt, collision boxes and a review.

## Loop: spec -> build -> look -> adjust
1. Decide real dimensions (metres) and 3-8 key parts before writing JSON. Model what the silhouette needs; skip what no one will see.
2. Call assets_procedural, poll assets_jobs, then `assets_preview view:"both"`. The side image is a 2x2 sheet: front | right / top | wireframe.
3. Read `review` and fix the spec, never the story: `size.ratio` far from 1 -> wrong part sizes; `floating` -> move parts into contact (gap in metres); `thickness.min` < 0.005 -> thicken; `uv.hiddenFaces` > 0.2 -> drop buried parts or weld them; `silhouette.*.iou` < 0.9 -> raise triangleBudget; `warnings`/`hints` list compiler fixes. One or two rebuilds are normal.
4. Seed changes scatter/noise only; geometry is otherwise deterministic.

## Frame and units
Metres, Z up, front faces -Y, rotations are XYZ Euler degrees. 1 m = 3.57 studs. The compiler centres the base on X/Y and puts the lowest point on z=0 (`pivot:"origin"` keeps X/Y).

## Top level
`{kind:"spec", size:[x,y,z], materials:[...], parts:[...], pivot?, smoothAngle?(35), finish?("natural"|"flat")}`. Budget: `triangleBudget` 2500-20000 (default 8000); the compiler picks one global edge length so every part's tessellation fits.

## Materials (1-3; one mesh each)
`{id, finish, color?, roughness?, metallic?, wear?, cavity?}`. `finish`: wood, stone, metal, plaster, ceramic, leather, fabric, plastic, glass. Colours are linear RGB: oak 0.2,0.11,0.05; pine 0.45,0.3,0.15; iron 0.05,0.05,0.055; steel 0.6,0.6,0.63; gold 0.78,0.55,0.2; granite 0.45,0.43,0.4; marble 0.82,0.8,0.76. `wear` (0-1) lightens or polishes convex edges; `cavity` (0-1) darkens crevices and contact seams.

## Part fields (all parts)
`id` (lowercase), `op`, `material`, `at` [x,y,z], `rot` [deg], `scale` (n or [3]), `parent` (inherits that part's transform), `smooth` (angle or false for faceted), `detail` (0.1-8 triangle priority), `grain` x|y|z (wood/metal direction, default longest axis), `segments` (force round segment count, e.g. 4 for a square roof), `noise` {amp, scale, octaves, warp, mask:{axis,from,to}}.
Copies: `mirror` "x"|"xy"|... (across world planes through the origin; centred parts are not duplicated); `radial` {count, axis?, center?, offset?}; `array` {count, step [m], rotStep [deg]} or {grid [nx,ny,nz], step} (centred) or {count, path {points, curve, closed}, align}; `scatter` {on: partId, count, spacing, align 0-1, minUp -1..1, scaleRange, yaw, sink} = seeded Poisson points on another part, aligned to its normals.
CSG: `csg:"union"` welds all union parts of one material into one watertight solid; `csg:"subtract"|"intersect"` makes a cutter (no material) applied to `with:[ids]` or every solid it overlaps. Plain overlapping parts are fine (each stays a closed shell) but cost hidden faces.

## Operators
Local origins: box, cylinder, sphere are centred on `at`; revolve, extrude, loft, sweep, sdf use their own coordinates moved by `at`.
- `box` {size [x,y,z], bevel}: rounded edges with `bevel` radius.
- `cylinder` {radius, height, radiusTop? (0 = cone), bevel}: axis Z.
- `sphere` {radius} (use `scale` for ellipsoids).
- `revolve` {profile [[r,z],...], curve linear|smooth, closed?, flutes?}: lathe about Z. Open profiles may end on the axis (r=0); interior r > 0. `closed:true` = ring/hoop from a closed (r,z) loop. `flutes` {count, depth 0-1 of half-width, width 0.02-1 of pitch, from, to}: rounded channels (column flutes, stave seams, grip ridges).
- `extrude` {shape, height, bevel?, inset? {width, depth}}: 2D footprint in local XY pushed up Z; rotate it ([90,0,0] stands it in XZ, extruding toward -Y). `round` corners must exceed bevel + inset width.
- `loft` {sections [{z, shape, at?[x,y], scale? n|[sx,sy] (0 = point at an end), rot?}], curve}: skin between ascending-z sections (blades, legs, necks, tapered posts).
- `sweep` {path {points [[x,y,z]], curve catmull|bezier|linear, closed}, shape, twist (deg), taper [[t,scale],...]}: tubes, rails, handles, arms, hoops (closed path).
- `sdf` {shapes [{prim, at, rot, ..., op union|subtract|intersect, blend}], resolution?}: organic or carved forms meshed watertight (then decimated). Prims: sphere {r}, box {size, round}, capsule {a, b, r, r2}, torus {r, r2 (tube)}, cone/cylinder {r (bottom), r2 (top), h, round}, ellipsoid {radii}. The first shape is a union; `blend` > 0 melts it into the previous result.
2D `shape`: {type circle r | ellipse rx ry | rect w h | ngon n r | star n r r2 | polygon points [[x,y],...], round?}.

## Worked examples (abbreviated; units m)
- Lantern 0.22x0.22x0.47: iron box base 0.2x0.2x0.03 bevel .006; glass box 0.15 core; iron posts box .016 at [.08,.08,.15] mirror "xy"; rails box [.16,.012,.014] array {count 2, step [0,0,.218]} mirror "y" (+ x twin); roof revolve [[0,0],[.16,0],[.16,.012],[.095,.06],[.04,.085],[0,.088]] segments 4 rot [0,0,45]; brass finial sphere .016; brass handle sweep closed path [[.045,0,.415],[0,0,.46],[-.045,0,.415],[0,0,.392]] circle r .0055.
- Barrel h 0.9 (build centred on z=0, then mirror "z"): oak revolve smooth [[0,-.43],[.255,-.43],[.27,-.45],[.3,-.25],[.315,0],[.3,.25],[.27,.45],[.255,.43],[0,.43]] flutes {count 18, depth .25, width .07} (stave seams, recessed heads); iron hoops revolve closed [[.28,.36],[.293,.36],[.297,.4],[.284,.4]] mirror "z"; rivets sphere .006 radial 6 mirror "z"; bung cylinder rot [0,90,0].
- Park bench: iron side frame extrude polygon (x = depth, y = height) rot [90,0,90] mirror "x"; teak slats box [1.64,.072,.034] bevel .008 array {count 5, step [0,.08,0]} resting on the frame; back slats rot [84,0,0] array step [0,.012,.1]; arms sweep rect w .04 h .022 round .008 along the frame top; bolt heads sphere .007 array matching the slats.
- Chair: legs cylinder r .018 h .45 radiusTop .015 at [.2,.2,.225] mirror "xy"; seat box [.44,.42,.03] bevel .006 at z .465; back posts box [.03,.03,.5] rot [-8,0,0] at [.2,.2,.72] mirror "x"; top rail sweep rect between the post tops; csg "union" on legs, seat, posts and rail welds one wooden solid.
- Stone arch: wall box [2.8,.6,3] csg union + plinths/imposts/cornice csg union; cutters box [1.6,1,2.15] at [0,0,1.075] csg subtract and cylinder r .8 h 1 rot [90,0,0] at [0,0,2.15] csg subtract; keystone/voussoir extrude polygons rot [90,0,0].
- Fountain: basin revolve cup [[0,0],[1.22,0],[1.3,.06],[1.3,.44],[1.24,.5],[1.12,.5],[1.08,.46],[1.08,.14],[0,.14]]; water cylinder (glass, dark blue-green) just below the rim; smooth fluted pedestal revolve; upper bowl revolve; spout revolve; lion masks sdf (ellipsoid + blended spheres/torus, box subtract flattens the back) radial 4.
- Sword: steel blade loft of a 6-point diamond polygon at z .2/.55/.95 with scale [1.12,1] / [.75,.85] and a point (scale 0) at 1.1, curve smooth, grain z; gold guard sweep rect along a shallow curve with taper [[0,.55],[.5,1.15],[1,.55]]; guard tips sphere mirror "x"; leather grip revolve smooth + flutes {count 9}; gold pommel sdf sphere + blended cylinder + torus.
- Crate 0.8: pine planks box [.74,.022,.24] bevel .004 array {count 3, step [0,0,.25]} mirror "y" (+ x twin); lid boards; corner posts box mirror "xy"; diagonal braces box rot [0,-42,0] mirror "y"; iron corner caps; nails sphere .0055 scatter {on "edge_y", count 40, spacing .07, align 1, sink .002}.
- Fluted column 3.18: plinth box bevel; base revolve smooth torus mouldings; shaft revolve smooth with entasis [[0,.34],[.3,.34],[.31,1.2],[.29,2.2],[.26,2.86],[0,2.86]] flutes {count 20, depth .8, width .82, from .45, to 2.75}; echinus revolve; abacus box.

## Pitfalls
- Overlaps of 1-5 mm read as joints; gaps read as floating. Put rails on posts, slats on frames, tops on legs.
- Thin flat parts (blades, panes) need at least 4-6 mm thickness.
- Use mirror/radial/array for repeats instead of listing copies; a spec over 640 instances or the budget fails fast.
- `PROCEDURAL_LIMIT` from a spec job means an outline self-intersects, a bevel/inset is too large for its footprint, or the parts exceed the budget even at the coarsest resolution: simplify or raise triangleBudget.
