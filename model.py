# Turns the canvas's part description (partSketch, in mm with Y up) into a CadQuery solid.
#
# The sketch is the XY plane, seen from +Z. An extrude rises from z = 0 to its depth, and its top
# face (z = depth) is the face the user drew on, so counterbores and countersinks open there.
# A revolve turns its profile round the centre line, sweeping up out of the sketch plane.
#
# The stream sends a new snapshot several times a second, so building runs in one background
# worker that always takes the newest snapshot and skips any that went stale while it was busy.
# Each feature's solid is cached, so drawing on one feature does not rebuild the others.
import json
import math
import threading
import time
from pathlib import Path

import cadquery as cq
from cadquery import Vector

PREVIEW_DEPTH = 10      # mm, for closed outlines not yet made into a part (the canvas's default depth)
PREVIEW_MIN = 3         # mm: smaller closed outlines are Pencil taps, not shapes, and get no preview
EXTRA = 1               # mm that cutting tools run past the faces they cut, so no skin is left
# brep is OpenCascade's own format: the fastest to write and for FreeCAD to read, so the live view uses it.
# The others are made when someone downloads or prints the part: 3mf and stl for printers, step for CAD.
FORMATS = {"brep": "model.brep", "stl": "model.stl", "3mf": "model.3mf", "step": "model.step", "glb": "model.glb"}

build_lock = threading.Lock()   # OpenCascade is not safe to call from two threads at once
feature_cache = {}              # feature JSON -> solid


# ---- 2D shapes from partSketch, as closed outlines on the sketch plane ----

def outline_points(shape, n=48):
    t = shape["type"]
    if t == "rect":
        (cx, cy), w, h = shape["center"], shape["width"] / 2, shape["height"] / 2
        return [(cx - w, cy - h), (cx + w, cy - h), (cx + w, cy + h), (cx - w, cy + h)]
    if t in ("circle", "hole", "ellipse"):
        cx, cy = shape["center"]
        rx = shape["rx"] if t == "ellipse" else shape["diameter"] / 2
        ry = shape["ry"] if t == "ellipse" else rx
        return [(cx + rx * math.cos(2 * math.pi * i / n), cy + ry * math.sin(2 * math.pi * i / n)) for i in range(n)]
    if t == "polygon":
        pts = [tuple(p) for p in shape["points"]]
        pts = [p for i, p in enumerate(pts) if i == 0 or math.dist(p, pts[i - 1]) > 1e-3]
        if len(pts) > 1 and math.dist(pts[0], pts[-1]) <= 1e-3:
            pts.pop()
        return untangle(pts)
    return None   # an open polyline encloses nothing


def crossing(p, q, r, s):
    """Where segment p-q crosses segment r-s, or None."""
    d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0])
    if abs(d) < 1e-12:
        return None
    t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d
    u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d
    return (p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])) if 0 < t < 1 and 0 < u < 1 else None


def signed_area(pts):
    return sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(pts, pts[1:] + pts[:1])) / 2


# A freehand outline often crosses itself, where the Pencil runs past its start or loops back.
# At each crossing, split the outline in two and keep the bigger loop, until none cross.
def untangle(pts):
    while len(pts) > 3:
        n, hit = len(pts), None
        for i in range(n):
            for j in range(i + 2, n if i else n - 1):   # skip the edges next to edge i
                x = crossing(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])
                if x:
                    hit = i, j, x
                    break
            if hit:
                break
        if not hit:
            return pts
        i, j, x = hit
        inner, outer = [x] + pts[i + 1:j + 1], pts[j + 1:] + pts[:i + 1] + [x]
        pts = max(inner, outer, key=lambda loop: abs(signed_area(loop)))
    return pts


def face(shape):
    t = shape["type"]
    if t in ("circle", "hole"):
        wire = cq.Wire.makeCircle(shape["diameter"] / 2, Vector(*shape["center"], 0), Vector(0, 0, 1))
    elif t == "ellipse":
        wire = cq.Wire.makeEllipse(shape["rx"], shape["ry"], Vector(*shape["center"], 0), Vector(0, 0, 1), Vector(1, 0, 0))
    else:
        pts = outline_points(shape)
        if not pts or len(pts) < 3:
            raise ValueError(f"a {t} with no area")
        wire = cq.Wire.makePolygon([Vector(x, y, 0) for x, y in pts], close=True)
    f = cq.Face.makeFromWires(wire)
    if not f.isValid():
        f = f.fix()
    return f


def inside(p, poly):
    x, y, hit = p[0], p[1], False
    for (ax, ay), (bx, by) in zip(poly, poly[-1:] + poly[:-1]):
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            hit = not hit
    return hit


# ---- Features ----

def prism(f, z0, z1):
    return cq.Solid.extrudeLinear(f.translate(Vector(0, 0, z0)), Vector(0, 0, z1 - z0))


# The tool that drills one hole down from the top face (z = depth) of an extrude
def hole_tool(h, depth):
    c, r = Vector(*h["center"], 0), h["diameter"] / 2
    kind = h.get("kind", "through")
    if kind == "blind":
        return cq.Solid.makeCylinder(r, h["depth"] + EXTRA, c + Vector(0, 0, depth - h["depth"]))
    tool = cq.Solid.makeCylinder(r, depth + 2 * EXTRA, c - Vector(0, 0, EXTRA))
    if kind == "counterbore":
        bore = cq.Solid.makeCylinder(h["cbDiameter"] / 2, h["cbDepth"] + EXTRA, c + Vector(0, 0, depth - h["cbDepth"]))
        tool = tool.fuse(bore)
    elif kind == "countersink":
        slope = math.tan(math.radians(h.get("cskAngle", 90) / 2))
        sink = (h["cskDiameter"] / 2 - r) / slope
        cone = cq.Solid.makeCone(r, h["cskDiameter"] / 2 + EXTRA * slope, sink + EXTRA, c + Vector(0, 0, depth - sink))
        tool = tool.fuse(cone)
    return tool


def extrude(profile, holes, depth):
    solid = prism(face(profile), 0, depth)
    tools = [hole_tool(h, depth) if h["type"] == "hole" else prism(face(h), -EXTRA, depth + EXTRA) for h in holes]
    return solid.cut(*tools) if tools else solid


def revolve(feature):
    (ax, ay), (bx, by) = feature["axis"]
    a, b, angle = Vector(ax, ay, 0), Vector(bx, by, 0), feature["angle"]
    solid = cq.Solid.revolve(face(feature["profile"]), angle, a, b)
    # Shapes inside the section revolve into rings cut out of the part
    tools = [cq.Solid.revolve(face(h), angle, a, b) for h in feature["holes"]]
    bolts = feature.get("boltCircle")
    if bolts:
        tools += bolt_holes(feature, bolts, a, b)
    return solid.cut(*tools) if tools else solid


# Holes parallel to the axis, evenly round it on the pitch circle, through all.
# The first one lies in the sketch plane, on the profile's side of the axis.
def bolt_holes(feature, bolts, a, b):
    u = (b - a).normalized()
    n = Vector(-u.y, u.x, 0)
    pts = outline_points(feature["profile"])
    if sum((Vector(x, y, 0) - a).dot(n) for x, y in pts) < 0:
        n = -n
    along = [(Vector(x, y, 0) - a).dot(u) for x, y in pts]
    start = a + u * (min(along) - EXTRA) + n * (bolts["pcd"] / 2)
    first = cq.Solid.makeCylinder(bolts["diameter"] / 2, max(along) - min(along) + 2 * EXTRA, start, u)
    return [first.rotate(a, b, 360 * k / bolts["count"]) for k in range(bolts["count"])]


def build_feature(feature):
    key = json.dumps(feature, sort_keys=True)
    if key not in feature_cache:
        if feature["type"] == "revolve":
            if not feature.get("axis"):
                raise ValueError("its centre line was deleted")
            feature_cache[key] = revolve(feature)
        else:
            feature_cache[key] = extrude(feature["profile"], feature["holes"], feature["depth"])
    return key, feature_cache[key]


# While nothing is marked as a part, closed outlines show as plates PREVIEW_DEPTH thick,
# with any closed shape inside one cut through it, the same way the Profile tool reads them.
def preview_features(part):
    def big_enough(s):
        pts = outline_points(s)
        return pts and max(max(p[i] for p in pts) - min(p[i] for p in pts) for i in (0, 1)) >= PREVIEW_MIN
    shapes = [s for s in part.get("other", []) if s.get("role") != "centre line" and big_enough(s)]
    outlines = {id(s): outline_points(s) for s in shapes}
    def within(s, t):
        return s is not t and all(inside(p, outlines[id(t)]) for p in outlines[id(s)])
    outers = [s for s in shapes if not any(within(s, t) for t in shapes)]
    return [{"type": "extrude", "depth": PREVIEW_DEPTH, "profile": o,
             "holes": [s for s in shapes if within(s, o) and not any(within(s, t) for t in shapes if t is not o and within(t, o))]}
            for o in outers]


def build(part):
    """partSketch -> (solid or None, info). info says what was built and anything that went wrong."""
    warnings = [f"dimension {d['mm']} mm conflicts with other dimensions and was not met" for d in part.get("conflicts", [])]
    if "error" in part:
        return None, {"status": "error", "warnings": [f"the canvas could not describe the part: {part['error']}"]}
    features, preview = part.get("features", []), False
    if not features:
        features, preview = preview_features(part), True
    solids, used = [], set()
    with build_lock:
        for i, feature in enumerate(features):
            try:
                key, solid = build_feature(feature)
                solids.append(solid)
                used.add(key)
            except Exception as e:
                warnings.append(f"feature {i + 1} ({feature['type']} of a {feature['profile']['type']}) was skipped: {e}")
        for key in set(feature_cache) - used:
            del feature_cache[key]   # forget features that are gone from the drawing
        if not solids:
            status = "error" if features else "empty"
            return None, {"status": status, "preview": preview, "features": 0, "warnings": warnings}
        solid = solids[0].fuse(*solids[1:]).clean() if len(solids) > 1 else solids[0]
        bb = solid.BoundingBox()
    return solid, {"status": "ok", "preview": preview, "features": len(solids), "warnings": warnings,
                   "volume": round(solid.Volume(), 1),
                   "bbox": {"min": [round(bb.xmin, 2), round(bb.ymin, 2), round(bb.zmin, 2)],
                            "max": [round(bb.xmax, 2), round(bb.ymax, 2), round(bb.zmax, 2)]}}


def export(solid, folder, kinds=FORMATS):
    """Writes the model in each of kinds into folder, replacing earlier files only once complete."""
    folder.mkdir(parents=True, exist_ok=True)
    with build_lock:
        for kind in kinds:
            name = FORMATS[kind]
            tmp = folder / f"tmp-{name}"
            if kind == "brep":
                solid.exportBrep(str(tmp))
            elif kind == "glb":
                cq.Assembly(solid, color=cq.Color(0.55, 0.62, 0.72)).export(str(tmp), "GLTF")
            else:
                cq.exporters.export(solid, str(tmp), kind.upper(), tolerance=0.05, angularTolerance=0.1)
            tmp.replace(folder / name)


# The drawing's loose lines and shapes in mm (everything not yet part of the solid), so the laptop
# can show them on the sketch plane and match the iPad even before there is a closed outline.
def sketch_lines(part):
    lines = []
    for s in part.get("other", []):
        closed = outline_points(s) if s["type"] != "polyline" else None
        pts = closed or [tuple(p) for p in s.get("points", [])]
        if len(pts) >= 2:
            lines.append({"points": [[round(x, 2), round(y, 2)] for x, y in pts], "closed": bool(closed),
                          "role": s.get("role", "sketch")})
    return lines


# ---- Live builds from the stream ----

class LiveBuilder:
    """Builds the newest snapshot in the background and reports each result through on_model(info)."""

    def __init__(self, session_dir, on_model):
        self.session_dir, self.on_model = session_dir, on_model
        self.pending, self.built = None, {}      # built: session -> part JSON of its current model
        self.latest = {}                         # session -> info of its current model
        self.solids = {}                         # session -> (seq, its current solid or None)
        self.exported = {}                       # (session, format) -> seq of the model in that file
        self.wake = threading.Condition()
        threading.Thread(target=self.run, daemon=True).start()

    def file(self, session, kind):
        """Path of the session's current model as kind, written now if this version is not on disk yet."""
        seq, solid = self.solids.get(session, (None, None))
        if solid is None:
            return None
        folder = self.session_dir / session / "model"
        if self.exported.get((session, kind)) != seq:
            export(solid, folder, [kind])
            self.exported[(session, kind)] = seq
        return folder / FORMATS[kind]

    def submit(self, snap):
        with self.wake:
            self.pending = snap    # replaces any older snapshot still waiting
            self.wake.notify()

    def run(self):
        while True:
            with self.wake:
                while self.pending is None:
                    self.wake.wait()
                snap, self.pending = self.pending, None
            try:
                self.build_snapshot(snap)
            except Exception as e:
                print(f"[model] {snap['session']} #{snap['seq']} failed: {e!r}")

    def build_snapshot(self, snap):
        session, part = snap["session"], snap["part"]
        key = json.dumps(part, sort_keys=True)
        if self.built.get(session) == key:
            return   # the drawing changed but the part did not (a stroke moved, a note was retyped)
        started = time.perf_counter()
        solid, info = build(part)
        info = {"session": session, "seq": snap["seq"], **info, "sketch": sketch_lines(part)}
        self.built[session], self.latest[session], self.solids[session] = key, info, (snap["seq"], solid)
        if solid is not None:
            self.file(session, "brep")   # only the live view's format now; the rest on request
            info["files"] = {kind: f"/api/model?session={session}&format={kind}&v={snap['seq']}" for kind in FORMATS}
        info["buildMs"] = round((time.perf_counter() - started) * 1000)
        extra = f"  {len(info['warnings'])} warnings" if info["warnings"] else ""
        print(f"[model] {session} #{snap['seq']}  {info['status']}{' (preview)' if info.get('preview') else ''}  "
              f"{info.get('features', 0)} features  {info['buildMs']} ms{extra}")
        self.on_model(info)
