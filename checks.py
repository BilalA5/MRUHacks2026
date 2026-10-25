# Manufacturing checks: what would make the part hard or impossible to make, in the words a shop would use.
# Each check is {"level": "warn" | "note", "message": text, "target": the canvas element it is about}.
# Rules depend on the process: "laser" (laser, waterjet, plasma), "cnc" (milling), "print" (FDM 3D printing)
# and "sheet" (laser-cut blank, then bent). With no process given, only the rules that hold for all apply.
import math

# Thickest plate each material is commonly laser cut in (mm), by material family.
LASER_MAX = {"steel": 20, "stainless": 15, "aluminium": 12, "acrylic": 20, "wood": 18, "plastic": 10}
SHARP = 0.5            # an inside corner with less radius than this counts as sharp
CNC_RADIUS = 3         # smallest inside radius a common 6 mm end mill leaves


def _seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy or 1e-12
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def _edge_dist(p, poly):
    return min(_seg_dist(p, poly[i], poly[(i + 1) % len(poly)]) for i in range(len(poly)))


def _hole_size(h):
    """(nominal diameter, widest diameter at the surface) of a hole or slot."""
    if h.get("kind") == "slot":
        return h["width"], h["width"]
    if h["type"] != "hole":
        return h.get("diameter", 0), h.get("diameter", 0)
    d = h["diameter"]
    return d, max(d, h.get("cbDiameter", 0), h.get("cskDiameter", 0))


def _label(h, i):
    if h.get("fastener"):
        return f"{h['fastener']} {h.get('kind', 'hole').replace('through', 'clearance hole')}"
    if h.get("kind") == "slot":
        return f"{h['width']:g} mm slot"
    return f"Ø{_hole_size(h)[0]:g} hole" if h["type"] == "hole" else f"cut-out {i + 1}"


def _rounded(poly, corners):
    """Indexes of the corners the Round tool filleted by at least SHARP (corners are found by where they are)."""
    return {min(range(len(poly)), key=lambda i: math.dist(poly[i], c["at"])) for c in corners
            if c["kind"] == "fillet" and c["size"] >= SHARP}


def _sharp(poly, corners, every=False):
    """Indexes of sharp inside corners: concave corners of an outline, or every corner of a pocket."""
    area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))
    rounded, out = _rounded(poly, corners), []
    for i, p in enumerate(poly):
        a, b = poly[i - 1], poly[(i + 1) % len(poly)]
        cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])
        if (every or cross * area < -1e-9) and i not in rounded:
            out.append(i)
    return out


def run(features, info):
    from model import outline_points   # model imports this module, so import it when first used

    process = info.get("process") or ("sheet" if any(f.get("bends") for f in features) else None)
    family = (info.get("material") or {}).get("family")
    found = []

    def add(level, message, target=None):
        found.append({"level": level, "message": message, "target": target})

    for f in features:
        if f["type"] == "revolve":
            continue
        poly = outline_points(f["profile"])
        if not poly:
            continue
        t = f.get("height") if f["type"] == "boss" else f.get("depth", 0)
        holes = f.get("holes", [])
        second_op = []

        for i, h in enumerate(holes):
            d, widest = _hole_size(h)
            c = h.get("center")
            if not c:
                continue
            from model import inside
            if not inside(c, poly):
                add("warn", f"{_label(h, i)} is outside the part", h.get("id"))
                continue
            ligament = _edge_dist(c, poly) - widest / 2
            need = max(1.0, 0.5 * d, t if process == "sheet" else 0)
            if ligament < need:
                add("warn", f"{_label(h, i)} leaves {max(ligament, 0):.1f} mm to the edge; keep at least {need:.1f} mm so it doesn't tear out", h.get("id"))
            for j in range(i + 1, len(holes)):
                o = holes[j]
                if not o.get("center"):
                    continue
                gap = math.dist(c, o["center"]) - widest / 2 - _hole_size(o)[1] / 2
                if gap < max(1.0, 0.5 * min(d, _hole_size(o)[0])):
                    add("warn", f"{_label(h, i)} and {_label(o, j)} are {max(gap, 0):.1f} mm apart; leave at least {max(1.0, 0.5 * min(d, _hole_size(o)[0])):.1f} mm between them", h.get("id"))
            if h.get("thread"):
                engaged = h.get("depth") or t
                nominal = h.get("nominal", d)
                factor = 1.0 if family in ("steel", "stainless") else 1.5
                if engaged < factor * nominal:
                    add("warn", f"{h['thread']} thread gets only {engaged:g} mm of engagement; use {factor * nominal:g} mm or more of material, or a nut", h.get("id"))
            if h.get("kind") in ("blind", "counterbore", "countersink", "tapped"):
                second_op.append(h)
            if process in ("laser", "sheet") and h["type"] == "hole" and h.get("kind") != "slot" and d < t:
                add("warn", f"{_label(h, i)} is smaller than the {t:g} mm thickness; a laser can't cut it cleanly, drill it instead", h.get("id"))
            if process == "print" and d < 2:
                add("warn", f"{_label(h, i)} is under 2 mm and will close up when printed; drill it out after printing", h.get("id"))

        if process in ("laser", "sheet"):
            if second_op:
                kinds = sorted({h["kind"] for h in second_op})
                add("note", f"{len(second_op)} hole{'s' if len(second_op) > 1 else ''} ({', '.join(kinds)}) need a second operation: the laser only cuts straight through", f.get("id"))
            limit = LASER_MAX.get(family)
            if limit and t > limit:
                add("warn", f"{t:g} mm is thick for laser cutting {family}; most shops cut up to {limit} mm, use waterjet or milling", f.get("id"))
            if f["type"] in ("boss", "pocket"):
                add("warn", "a boss or pocket can't be laser cut; it needs milling", f.get("id"))
        if process == "cnc":
            sharp = _sharp(poly, f["profile"].get("corners", []), every=f["type"] == "pocket")
            if sharp and f["profile"]["type"] in ("polygon", "rect"):
                where = "pocket" if f["type"] == "pocket" else "outline"
                add("warn", f"{len(sharp)} sharp inside corner{'s' if len(sharp) > 1 else ''} in the {where} can't be milled; round them to R{CNC_RADIUS} or more with the Round tool", f.get("id"))
        if process == "print":
            if t and t < 1.2:
                add("warn", f"{t:g} mm is too thin to print reliably; use 1.2 mm or more", f.get("id"))
            threaded = [h for h in holes if h.get("thread")]
            if threaded:
                add("note", f"for {threaded[0]['thread'].split('x')[0]} threads in a print, tap the tap-drill hole or press in heat-set inserts", f.get("id"))
        for bend in f.get("bends", []):
            if bend["radius"] < t:
                add("warn", f"bend radius R{bend['radius']:g} is under the {t:g} mm thickness and may crack; use R{t:g} or more", bend.get("id"))
            a, b = bend["a"], bend["b"]
            ux, uy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(ux, uy) or 1
            nx, ny = -uy / length, ux / length
            side = [(p[0] - a[0]) * nx + (p[1] - a[1]) * ny for p in poly]
            flange = min(max(side), -min(side))
            if flange < 3 * t + bend["radius"]:
                add("warn", f"the flange past this bend is {flange:.1f} mm; a press brake needs at least {3 * t + bend['radius']:.1f} mm", bend.get("id"))
            for i, h in enumerate(holes):
                if h.get("center"):
                    off = abs((h["center"][0] - a[0]) * nx + (h["center"][1] - a[1]) * ny) - _hole_size(h)[1] / 2
                    if off < 2 * t + bend["radius"]:
                        add("warn", f"{_label(h, i)} is {max(off, 0):.1f} mm from a bend and will stretch; keep {2 * t + bend['radius']:.1f} mm away", h.get("id"))
    return found
