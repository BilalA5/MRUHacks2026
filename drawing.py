# What a shop needs to make the part:
#   write_dxf: the flat profile in mm, true arcs and circles, for laser, waterjet and plasma. Holes are cut at
#              their through diameter; sheet-metal bend lines go on their own BEND layer with the bend noted.
#              A revolved part gives its half section and centre line, for the lathe.
#   write_svg: a one-page shop drawing (A4 landscape, mm): the exact top view (or flat pattern) with overall
#              sizes and tagged holes, an isometric view, a hole table, notes and a title block.
import base64
import time

import cadquery as cq
import ezdxf
from cadquery.occ_impl.exporters.svg import getSVG

PAGE_W, PAGE_H = 297, 210
VIEW = (12, 14, 168, 120)        # x, y, width, height of the top view's box on the page (mm)
SCALES = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05]


def _base(features):
    flat = [f for f in features if f["type"] == "extrude"]
    return flat[0] if flat else None


def _face_with_holes(f):
    from model import face
    outer = face(f["profile"])
    for h in f.get("holes", []):
        outer = outer.cut(face(h))
    return outer


def callout(h):
    """A hole's size in shop words, e.g. 'Ø5.5 THRU, CBORE Ø10 DP 5.4'."""
    if h.get("kind") == "slot":
        return f"SLOT {h['width']:g} × {h['length']:g}"
    if h["type"] != "hole":
        return "CUT-OUT"
    d, kind = h["diameter"], h.get("kind", "through")
    if kind == "tapped":
        tap = f"{h['thread']} TAP " + (f"DP {h['depth']:g}" if h.get("depth") else "THRU")
        return f"{tap}, DRILL Ø{d:g}"
    base = f"Ø{d:g} " + (f"DP {h['depth']:g}" if kind == "blind" else "THRU")
    if kind == "counterbore":
        base += f", CBORE Ø{h['cbDiameter']:g} DP {h['cbDepth']:g}"
    if kind == "countersink":
        base += f", CSK Ø{h['cskDiameter']:g} × {h.get('cskAngle', 90):g}°"
    return (f"{h['fastener']}: " if h.get("fastener") else "") + base


# ---- DXF ----

def write_dxf(features, path):
    """Returns False when there is nothing flat to cut (no extrude or revolve)."""
    base = _base(features)
    revolved = next((f for f in features if f["type"] == "revolve"), None)
    if base:
        shape = _face_with_holes(base)
    elif revolved:
        from model import face
        shape = face(revolved["profile"])
    else:
        return False
    cq.exporters.export(cq.Workplane("XY").add(shape), str(path), "DXF")
    doc = ezdxf.readfile(str(path))
    doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    if base and base.get("bends"):
        doc.layers.add("BEND", color=1, linetype="DASHED")
        for b in base["bends"]:
            msp.add_line(b["a"], b["b"], dxfattribs={"layer": "BEND"})
            mid = ((b["a"][0] + b["b"][0]) / 2, (b["a"][1] + b["b"][1]) / 2)
            msp.add_text(f"{'UP' if b.get('up', True) else 'DOWN'} {b['angle']:g}° R{b['radius']:g}",
                         dxfattribs={"layer": "BEND", "height": 2.5}).set_placement(mid)
    if revolved and not base:
        doc.layers.add("CENTER", color=5, linetype="CENTER")
        msp.add_line(*revolved["axis"], dxfattribs={"layer": "CENTER"})
    doc.saveas(str(path))
    return True


# ---- SVG drawing ----

def _wires_2d(shape):
    """Every edge of a planar face as a list of (x, y) points, finely enough for arcs to look round."""
    paths = []
    for edge in shape.Edges():
        n = 2 if edge.geomType() == "LINE" else 32
        paths.append([(p.x, p.y) for p in (edge.positionAt(i / n) for i in range(n + 1))])
    return paths


def _scale(w, h):
    for s in SCALES:
        if w * s <= VIEW[2] - 20 and h * s <= VIEW[3] - 20:
            return s
    return SCALES[-1]


def _scale_label(s):
    return f"{s:g}:1" if s >= 1 else f"1:{1 / s:g}"


def write_svg(solid, features, info, path):
    from model import face, outline_points
    base = _base(features)
    revolved = next((f for f in features if f["type"] == "revolve"), None)
    shapes, thin, dashed = [], [], []
    holes = []
    if base or not revolved:
        for f in features:
            if f["type"] == "revolve":
                continue
            (thin if f["type"] in ("boss", "pocket") else shapes).append(face(f["profile"]))
            for h in f.get("holes", []):
                holes.append(h)
                shapes.append(face(h))
                for key in ("cbDiameter", "cskDiameter"):
                    if h.get(key):
                        thin.append(face({**h, "type": "circle", "diameter": h[key]}))
        title = "FLAT PATTERN" if base and base.get("bends") else "TOP VIEW"
    else:
        shapes.append(face(revolved["profile"]))
        dashed.append(revolved["axis"])
        title = f"HALF SECTION, REVOLVED {revolved['angle']:g}°"
    outline = [p for f in features if f["type"] != "revolve" for p in (outline_points(f["profile"]) or [])] or \
              outline_points(revolved["profile"])
    xs, ys = [p[0] for p in outline], [p[1] for p in outline]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    s = _scale(x1 - x0, y1 - y0)
    vx, vy, vw, vh = VIEW
    ox, oy = vx + (vw - (x1 - x0) * s) / 2, vy + (vh - (y1 - y0) * s) / 2 + 4

    def P(x, y):   # model mm (Y up) to page mm (Y down)
        return ox + (x - x0) * s, oy + (y1 - y) * s

    def poly(pts, cls):
        return f'<polyline class="{cls}" points="{" ".join(f"{a:.2f},{b:.2f}" for a, b in (P(x, y) for x, y in pts))}"/>'

    body = []
    for sh in shapes:
        body += [poly(p, "line") for p in _wires_2d(sh)]
    for sh in thin:
        body += [poly(p, "thin") for p in _wires_2d(sh)]
    for (ax, ay), (bx, by) in dashed:
        body.append(poly([(ax, ay), (bx, by)], "centre"))
    if base:
        for b in base.get("bends", []):
            body.append(poly([b["a"], b["b"]], "centre"))
            top = max((b["a"], b["b"]), key=lambda q: q[1])      # labelled near the top end, clear of holes
            mx, my = P(*top)
            body.append(f'<text class="small" x="{mx + 1.5:.2f}" y="{my + 4:.2f}">BEND {"UP" if b.get("up", True) else "DOWN"} {b["angle"]:g}° R{b["radius"]:g}</text>')

    # Overall sizes, below and left of the view
    ax, ay = P(x0, y0)
    bx, by = P(x1, y1)
    dims = [
        f'<line class="dim" x1="{ax:.2f}" y1="{ay + 6:.2f}" x2="{bx:.2f}" y2="{ay + 6:.2f}"/>',
        f'<line class="ext" x1="{ax:.2f}" y1="{ay + 1:.2f}" x2="{ax:.2f}" y2="{ay + 8:.2f}"/>',
        f'<line class="ext" x1="{bx:.2f}" y1="{ay + 1:.2f}" x2="{bx:.2f}" y2="{ay + 8:.2f}"/>',
        f'<text class="dimtext" x="{(ax + bx) / 2:.2f}" y="{ay + 10.5:.2f}" text-anchor="middle">{x1 - x0:.1f}</text>',
        f'<line class="dim" x1="{ax - 6:.2f}" y1="{ay:.2f}" x2="{ax - 6:.2f}" y2="{by:.2f}"/>',
        f'<line class="ext" x1="{ax - 1:.2f}" y1="{ay:.2f}" x2="{ax - 8:.2f}" y2="{ay:.2f}"/>',
        f'<line class="ext" x1="{ax - 1:.2f}" y1="{by:.2f}" x2="{ax - 8:.2f}" y2="{by:.2f}"/>',
        f'<text class="dimtext" x="{ax - 8:.2f}" y="{(ay + by) / 2:.2f}" text-anchor="middle" transform="rotate(-90 {ax - 8:.2f} {(ay + by) / 2:.2f})">{y1 - y0:.1f}</text>',
        f'<text class="small" x="{ax:.2f}" y="{ay + 3.2:.2f}">DATUM (0,0)</text>',
    ]

    # Hole tags in the view, and the hole table
    rows = []
    for i, h in enumerate(holes):
        c = h.get("center")
        if not c:
            continue
        tag = f"H{i + 1}"
        tx, ty = P(*c)
        r = (h.get("width") if h.get("kind") == "slot" else h.get("diameter", 0)) / 2 * s
        body.append(f'<text class="tag" x="{tx + r + 1:.2f}" y="{ty - r - 0.6:.2f}">{tag}</text>')
        rows.append((tag, callout(h), c[0] - x0, c[1] - y0))
    table = []
    if rows:
        tx, ty = 188, 14
        table.append(f'<text class="head" x="{tx}" y="{ty}">HOLE TABLE (from datum)</text>')
        table.append(f'<text class="small" x="{tx}" y="{ty + 5}">TAG</text><text class="small" x="{tx + 10}" y="{ty + 5}">SIZE</text>'
                     f'<text class="small" x="{tx + 76}" y="{ty + 5}" text-anchor="end">X</text><text class="small" x="{tx + 94}" y="{ty + 5}" text-anchor="end">Y</text>')
        for k, (tag, size, hx, hy) in enumerate(rows[:12]):
            y = ty + 10 + k * 4.6
            table.append(f'<text class="cell" x="{tx}" y="{y}">{tag}</text><text class="cell" x="{tx + 10}" y="{y}">{size}</text>'
                         f'<text class="cell" x="{tx + 76}" y="{y}" text-anchor="end">{hx:.2f}</text><text class="cell" x="{tx + 94}" y="{y}" text-anchor="end">{hy:.2f}</text>')
        if len(rows) > 12:
            table.append(f'<text class="small" x="{tx}" y="{ty + 10 + 12 * 4.6}">+ {len(rows) - 12} more in the DXF</text>')

    # Isometric view of the finished part
    iso = getSVG(solid, {"width": 300, "height": 220, "marginLeft": 10, "marginTop": 10, "showAxes": False,
                         "projectionDir": (1, -1, 0.9), "strokeWidth": -1, "strokeColor": (31, 42, 54), "showHidden": False})
    iso_uri = "data:image/svg+xml;base64," + base64.b64encode(iso.encode()).decode()
    iso_y = 14 + (12 + min(len(rows), 12)) * 4.6 if rows else 14
    iso_h = max(40, 150 - iso_y)

    # Notes and title block
    notes = ["ALL DIMENSIONS IN MM. TOLERANCE ±0.2 UNLESS STATED.", "BREAK SHARP EDGES 0.3 MAX."]
    if any(h.get("thread") for h in holes):
        notes.append("TAP THREADS AFTER DRILLING; TAP DRILL SIZES AS LISTED.")
    if base and base.get("bends"):
        notes.append("BEND ALLOWANCE WITH K = 0.44. FLAT PATTERN SHOWN; FORM AFTER CUTTING.")
    process = {"laser": "LASER / WATERJET CUT", "cnc": "CNC MILLED", "print": "3D PRINTED (FDM)", "sheet": "LASER CUT AND BENT"}.get(info.get("process") or "", "")
    if process:
        notes.append(f"PROCESS: {process}.")
    mat = info.get("material") or {}
    thick = f"{base['depth']:g} mm" if base else "-"
    size = " × ".join(f"{b - a:.1f}" for a, b in zip(info["bbox"]["min"], info["bbox"]["max"])) if info.get("bbox") else "-"
    block = [("PART", "BoardSketch part"), ("MATERIAL", mat.get("name", "not set")), ("THICKNESS", thick),
             ("SIZE", f"{size} mm"), ("MASS", f"{info['mass']:g} g" if info.get("mass") else "-"),
             ("SCALE", _scale_label(s)), ("DATE", time.strftime("%Y-%m-%d"))]
    bx0, by0 = 188, 160
    tb = [f'<rect class="frame" x="{bx0}" y="{by0}" width="97" height="38"/>']
    for k, (key, val) in enumerate(block):
        y = by0 + 5 + k * 5
        tb.append(f'<text class="small" x="{bx0 + 2}" y="{y}">{key}</text><text class="cell" x="{bx0 + 24}" y="{y}">{val}</text>')

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}mm" height="{PAGE_H}mm" viewBox="0 0 {PAGE_W} {PAGE_H}">
<style>
  .line {{ fill: none; stroke: #111; stroke-width: 0.35; }}
  .thin {{ fill: none; stroke: #111; stroke-width: 0.18; }}
  .centre {{ fill: none; stroke: #111; stroke-width: 0.18; stroke-dasharray: 6 1.5 1 1.5; }}
  .dim, .ext {{ stroke: #111; stroke-width: 0.15; }}
  .frame {{ fill: none; stroke: #111; stroke-width: 0.35; }}
  text {{ font-family: Helvetica, Arial, sans-serif; fill: #111; }}
  .dimtext {{ font-size: 3px; }} .tag {{ font-size: 2.6px; font-weight: bold; }}
  .small {{ font-size: 2.2px; fill: #555; }} .cell {{ font-size: 2.6px; }} .head {{ font-size: 3.2px; font-weight: bold; }}
</style>
<rect width="{PAGE_W}" height="{PAGE_H}" fill="#fff"/>
<rect class="frame" x="6" y="6" width="{PAGE_W - 12}" height="{PAGE_H - 12}"/>
<text class="head" x="{VIEW[0]}" y="{VIEW[1]}">{title}</text>
{"".join(body)}
{"".join(dims)}
{"".join(table)}
<text class="head" x="188" y="{iso_y}">ISOMETRIC</text>
<image x="188" y="{iso_y + 2}" width="97" height="{iso_h - 4}" href="{iso_uri}" preserveAspectRatio="xMidYMid meet"/>
<text class="head" x="{VIEW[0]}" y="{VIEW[1] + VIEW[3] + 18}">NOTES</text>
{"".join(f'<text class="cell" x="{VIEW[0]}" y="{VIEW[1] + VIEW[3] + 23 + k * 4.4}">{k + 1}. {n}</text>' for k, n in enumerate(notes))}
{"".join(tb)}
</svg>'''
    path.write_text(svg)
