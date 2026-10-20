"""Bake inputs for library materials: per-texel world samples over an asset's own UV charts.

``rasterise`` reuses the natural-rock world-space bake of textures.py (``_rasterise``): every
covered texel gets its world position, shading normal, smoothed normal and metres per texel along
u and v from the UV triangles, with a 1.5 px extension and a nearest-texel gutter fill so mip
filtering never pulls in foreign colour. ``mesh_masks`` (Blender) then measures, per texel, edge
convexity (how quickly the surface turns away nearby: worn arrises) and cavity occlusion (short
hemisphere rays: dirt in creases and contact seams) against a BVH of the whole asset.
"""
import math

import textures


def part_frames(np, corners, tri_verts):
    """Connected parts (triangles sharing vertices) and each part's principal axes, area weighted:
    rows = (longest: grain, middle: across, shortest: depth). Returns (part id per triangle,
    (K, 3, 3) axes, (K, 3) centres)."""
    t = len(tri_verts)
    parent = list(range(int(tri_verts.max()) + 1 if t else 0))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b, c in tri_verts.tolist():
        ra, rb, rc = find(a), find(b), find(c)
        parent[rb] = ra
        parent[find(rc)] = ra
    roots = np.array([find(int(v)) for v in tri_verts[:, 0]]) if t else np.zeros(0, dtype=np.int64)
    _, part = np.unique(roots, return_inverse=True)
    k = int(part.max()) + 1 if t else 0
    area = np.linalg.norm(np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]), axis=1) / 2 + 1e-12
    axes = np.zeros((k, 3, 3))
    centres = np.zeros((k, 3))
    for i in range(k):
        sel = part == i
        w = area[sel]
        pts = corners[sel].reshape(-1, 3)
        ww = np.repeat(w, 3)
        c = (pts * ww[:, None]).sum(0) / ww.sum()
        d = pts - c
        cov = (d * ww[:, None]).T @ d / ww.sum()
        vals, vecs = np.linalg.eigh(cov)
        order = np.argsort(vals)[::-1]
        frame = vecs[:, order].T
        # Deterministic signs: grain points up/+x, the frame is right handed.
        for r in range(2):
            j = int(np.argmax(np.abs(frame[r])))
            if frame[r, j] < 0:
                frame[r] = -frame[r]
        frame[2] = np.cross(frame[0], frame[1])
        axes[i], centres[i] = frame, c
    return part, axes, centres


def rasterise(np, corners, corner_normals, smooth_normals, uvs, size, tri_verts=None):
    """``corners`` (T, 3, 3) world positions, ``corner_normals``/``smooth_normals`` (T, 3, 3),
    ``uvs`` (T, 3, 2) in 0..1. Returns the sample grids (rows bottom-up, bpy pixel order)."""
    t = len(corners)
    if tri_verts is None:
        tri_verts = np.arange(3 * t).reshape(t, 3)
    part, axes, centres = part_frames(np, corners, tri_verts)
    # The part id rides in the (otherwise unused) tunnel channel: constant over each triangle.
    bake = {"vertices": corners.reshape(-1, 3), "faces": np.arange(3 * t).reshape(t, 3), "uvs": uvs,
            "normals": corner_normals.reshape(-1, 3), "mossNormals": smooth_normals.reshape(-1, 3),
            "cavity": np.zeros(3 * t), "tunnel": np.repeat(part.astype(float), 3)}
    maps, filled, texels = textures._rasterise(np, bake, size)
    grid = maps.reshape(size, size, -1)
    pid = np.clip(np.rint(grid[..., 10]).astype(np.int64), 0, max(len(axes) - 1, 0))
    return {"part": pid, "partAxes": axes, "partCentres": centres,"position": grid[..., 0:3], "normal": grid[..., 3:6], "smoothNormal": grid[..., 6:9],
            "mu": np.maximum(grid[..., 11], 1e-6), "mv": np.maximum(grid[..., 12], 1e-6),
            "filled": filled.reshape(size, size), "covered": texels.reshape(size, size)}


def object_samples(obj, size, uv_name=None):
    """Rasterised samples for a Blender mesh object (world space, evaluated mesh)."""
    import bpy
    np = textures._np()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(depsgraph)
    me = ev.to_mesh()
    try:
        me.calc_loop_triangles()
        layer = me.uv_layers[uv_name] if uv_name else me.uv_layers.active
        if layer is None:
            raise ValueError("Library bake needs a UV layer")
        nt = len(me.loop_triangles)
        loops = np.zeros(nt * 3, dtype=np.int64)
        verts = np.zeros(nt * 3, dtype=np.int64)
        me.loop_triangles.foreach_get("loops", loops)
        me.loop_triangles.foreach_get("vertices", verts)
        co = np.zeros(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        uv = np.zeros(len(me.loops) * 2)
        layer.data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
        if hasattr(me, "corner_normals"):
            cn = np.array([n.vector[:] for n in me.corner_normals])
        else:  # pragma: no cover - Blender < 4.1
            me.calc_normals_split()
            cn = np.array([l.normal[:] for l in me.loops])
        vn = np.zeros(len(me.vertices) * 3)
        me.vertices.foreach_get("normal", vn)
        vn = vn.reshape(-1, 3)
        mw = np.array(obj.matrix_world)
        rot = np.linalg.inv(mw[:3, :3]).T
        world = co @ mw[:3, :3].T + mw[:3, 3]
        unit = lambda a: a / np.maximum(np.linalg.norm(a, axis=-1, keepdims=True), 1e-9)
        corners = world[verts].reshape(nt, 3, 3)
        corner_n = unit(cn[loops] @ rot.T).reshape(nt, 3, 3)
        smooth_n = unit(vn[verts] @ rot.T).reshape(nt, 3, 3)
        return rasterise(np, corners, corner_n, smooth_n, uv[loops].reshape(nt, 3, 2), size, verts.reshape(nt, 3))
    finally:
        ev.to_mesh_clear()


def world_bvh(objects):
    """One BVH over several objects in world space (wear and occlusion see neighbouring parts)."""
    import bpy
    from mathutils.bvhtree import BVHTree
    depsgraph = bpy.context.evaluated_depsgraph_get()
    verts, polys = [], []
    for obj in objects:
        ev = obj.evaluated_get(depsgraph)
        me = ev.to_mesh()
        base = len(verts)
        mw = obj.matrix_world
        verts.extend(tuple(mw @ v.co) for v in me.vertices)
        polys.extend(tuple(base + i for i in p.vertices) for p in me.polygons)
        ev.to_mesh_clear()
    return BVHTree.FromPolygons(verts, polys), verts


def mesh_masks(samples, bvh, span, step=2, edge_radius=None, reach=None, rays=10):
    """Adds ``edge`` (convexity, 0..1) and ``cavity`` (occlusion, 0..1) grids to ``samples``.

    Measured every ``step`` texels and spread back with a small blur (both masks are broad).
    ``edge_radius`` (metres) is how far round an arris wear reaches; ``reach`` the occlusion ray
    length. Defaults scale with the asset ``span``."""
    from mathutils import Vector
    np = textures._np()
    import mat_noise
    size = samples["filled"].shape[0]
    texel = float(np.median(np.maximum(samples["mu"], samples["mv"])[samples["filled"]])) if samples["filled"].any() else .004
    r = edge_radius or max(.003, min(.03, span * .018, 4 * texel))
    reach = reach or max(.03, min(.45, span * .16))
    pos = samples["position"][::step, ::step]
    nrm = samples["normal"][::step, ::step]
    ok = samples["filled"][::step, ::step]
    edge = np.zeros(ok.shape)
    cav = np.zeros(ok.shape)
    golden = math.pi * (3 - math.sqrt(5))
    dirs = []
    for k in range(rays):
        z = .12 + .82 * (k + .5) / rays
        rr = math.sqrt(1 - z * z)
        dirs.append((math.cos(golden * k) * rr, math.sin(golden * k) * rr, z))
    ys, xs = np.nonzero(ok)
    for y, x in zip(ys.tolist(), xs.tolist()):
        p = Vector(pos[y, x].tolist())
        n = Vector(nrm[y, x].tolist())
        if n.length < .5:
            continue
        n.normalize()
        t = n.orthogonal().normalized()
        b = n.cross(t)
        conv = 0.0
        for d in (t, -t, b, -b, (t + b).normalized(), -(t + b).normalized(), (t - b).normalized(), (b - t).normalized()):
            loc, nn, _, _ = bvh.find_nearest(p + d * r)
            if loc is not None:
                conv += (nn - n).dot(loc - p) / r
        edge[y, x] = conv / 8
        hits = 0.0
        for d in dirs:
            w = t * d[0] + b * d[1] + n * d[2]
            loc, _, _, dist = bvh.ray_cast(p + n * 5e-4, w, reach)
            if loc is not None:
                hits += 1 - dist / reach
        cav[y, x] = hits / rays
    edge = np.clip(edge / .16, 0, 1)
    up = lambda a: np.repeat(np.repeat(a, step, 0), step, 1)[:size, :size]
    samples["edge"] = np.clip(mat_noise.box_blur(np, up(edge), max(1, step // 2 + 1), periodic=False), 0, 1)
    samples["cavity"] = np.clip(mat_noise.box_blur(np, up(cav), max(1, step // 2 + 1), periodic=False) * 1.4, 0, 1)
    return samples
