# Sheet metal: folds a flat plate along its bend lines, the way a press brake does.
#
# The user draws the flat pattern (the blank the laser cuts) and marks each bend line with an angle,
# a direction (up or down, seen from the sketch) and an inside radius. Each bend line splits off a flange
# from the base (the side with more material). Around the line, a strip as wide as the bend allowance
# becomes the curved bend; the flange beyond it swings round the bend axis.
#
#   bend allowance = angle (rad) × (inside radius + K × thickness), with K = 0.44 (steel and aluminium, air bending)
#
# Holes are cut in the flat before folding, as they are on a real blank.
import math

import cadquery as cq
from cadquery import Vector

K_FACTOR = 0.44


def allowance(bend, t):
    return math.radians(bend["angle"]) * (bend["radius"] + K_FACTOR * t)


def _halfspace(a, m, offset, size, t, keep_positive):
    """A big slab of the half-plane m·(p - a) >= offset (or <= offset), as tall as the sheet and more."""
    u = Vector(-m.y, m.x, 0)
    base = a + m * offset
    far = m * (size if keep_positive else -size)
    pts = [base - u * size, base + u * size, base + u * size + far, base - u * size + far]
    face = cq.Face.makeFromWires(cq.Wire.makePolygon([p - Vector(0, 0, 1) for p in pts], close=True))
    return cq.Solid.extrudeLinear(face, Vector(0, 0, t + 2))


def _volume(shape):
    try:
        return shape.Volume()
    except Exception:
        return 0.0


def fold(flat, bends, t):
    """flat: the plate as a solid, z from 0 to t. Returns (folded solid, notes about each bend)."""
    box = flat.BoundingBox()
    size = 4 * max(box.xlen, box.ylen, 1)
    base = flat
    pieces, notes = [], []
    for bend in bends:
        a, b = Vector(*bend["a"], 0), Vector(*bend["b"], 0)
        if (b - a).Length < 1e-6:
            continue
        u = (b - a).normalized()
        n = Vector(-u.y, u.x, 0)
        ba = allowance(bend, t)
        # The flange is the smaller side of the line; the base keeps the rest.
        plus = _volume(flat.intersect(_halfspace(a, n, 0, size, t, True)))
        minus = _volume(flat.intersect(_halfspace(a, n, 0, size, t, False)))
        if min(plus, minus) < 1e-6:
            notes.append({"bend": bend, "error": "the bend line does not cross the part"})
            continue
        m = n if plus < minus else -n
        flange = flat.intersect(_halfspace(a, m, ba / 2, size, t, True))
        zone = flat.intersect(_halfspace(a, m, -ba / 2, size, t, True)).intersect(_halfspace(a, m, ba / 2, size, t, False))
        base = base.cut(_halfspace(a, m, -ba / 2, size, t, True))

        # The bend axis runs along the line, at the inside radius above (up) or below (down) the sheet.
        up = bend.get("up", True)
        origin = a - m * (ba / 2) + Vector(0, 0, t + bend["radius"] if up else -bend["radius"])
        s = 1 if m.dot(n) > 0 else -1          # m = s·n, and u × m = s·z, so +s turns the flange up
        angle = bend["angle"] * (s if up else -s)
        # The flange's near edge is pulled back onto the start of the bend, then swung round the axis.
        flange = flange.translate(m * -ba).rotate(origin, origin + u, angle)
        # The bend itself: the sheet's cross-section at the start of the bend, swept round the axis.
        along = [(v.toTuple(), (Vector(*v.toTuple()) - a).dot(u)) for v in zone.Vertices()]
        u0, u1 = min(d for _, d in along), max(d for _, d in along)
        start = a - m * (ba / 2)
        section = [start + u * u0, start + u * u1, start + u * u1 + Vector(0, 0, t), start + u * u0 + Vector(0, 0, t)]
        arc = cq.Solid.revolve(cq.Face.makeFromWires(cq.Wire.makePolygon(section, close=True)), angle, origin, origin + u)
        pieces += [arc, flange]
        notes.append({"bend": bend, "allowance": round(ba, 3), "flangeVolume": round(_volume(flange), 1)})
    solid = base.fuse(*pieces).clean() if pieces else base
    return solid, notes
