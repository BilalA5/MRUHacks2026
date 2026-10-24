// Engineering board built on Excalidraw (MIT, https://github.com/excalidraw/excalidraw).
// Excalidraw supplies the canvas, tools and undo. This file adds a sidebar of engineering tools
// and partSketch(), the clean mm description of the part that the laptop builds from.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw, CaptureUpdateAction, viewportCoordsToSceneCoords,
  convertToExcalidrawElements as toElements,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { ICONS } from "./icons.js";

const PAPER = "#FBFBF7";        // drawing paper
const INK = "#1F2A36";          // graphite lines
const BLUE = "#2563EB";         // dimensions, marks and centre lines
const PART_FILL = "#DCE6FB";    // material of a marked profile
const GRID = 20;                // grid cell in scene px
const MM_PER_PX = 0.25;         // scale until the first dimension is typed: one 20 px grid cell = 5 mm

// Engineering drawings use straight lines, sharp corners and a clean font, not Excalidraw's hand-sketched style.
// Excalidraw sizes a converted line from its first segment only, so lines get their size from all their points.
const CLEAN = { roughness: 0, fontFamily: 2, roundness: null };
const convertToExcalidrawElements = skeletons => toElements(skeletons.map(s => ({ ...CLEAN, ...s }))).map(el => {
  if (!el.points) return el;
  const xs = el.points.map(p => p[0]), ys = el.points.map(p => p[1]);
  return { ...el, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
});

const rnd = () => Math.floor(Math.random() * 1e9);
const bump = el => ({ ...el, version: el.version + 1, versionNonce: rnd() });
const fmt = n => String(Math.round(n * 100) / 100);
const r2 = n => Math.round(n * 100) / 100;
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

// Tool edits go straight onto the undo stack.
const commit = (api, elements) => api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });

const isNote = el => !!el.customData?.note;     // dimension or label made by a tool, not part geometry
const live = api => api.getSceneElements().filter(el => !el.isDeleted);
const selected = api => {
  const ids = api.getAppState().selectedElementIds;
  return live(api).filter(el => ids[el.id]);
};

// ---- Geometry ----

// Distance from p to the segment a-b.
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const bounds = pts => {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};

// A line or pen stroke counts as closed when it ends where it started.
function endsMeet(pts, type) {
  const b = bounds(pts), size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const gap = dist(pts[0], pts[pts.length - 1]);
  return type === "freedraw"
    ? pts.length >= 8 && gap <= Math.max(20, 0.2 * size)
    : pts.length >= 4 && gap <= Math.max(8, 0.05 * size);
}

// Scene points of an element's outline with its rotation applied, or null for text.
// A closed outline does not repeat its first point; edge i runs from pts[i] to pts[i + 1], wrapping round.
function outline(el) {
  const { x, y, width: w, height: h } = el;
  let pts, closed = true;
  if (el.type === "rectangle") pts = [[0, 0], [w, 0], [w, h], [0, h]];
  else if (el.type === "diamond") pts = [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
  else if (el.type === "ellipse") pts = Array.from({ length: 48 }, (_, i) => [w / 2 + w / 2 * Math.cos(i / 24 * Math.PI), h / 2 + h / 2 * Math.sin(i / 24 * Math.PI)]);
  else if (el.points?.length >= 2) pts = el.points;
  else return null;
  let abs = pts.map(([px, py]) => ({ x: x + px, y: y + py }));
  if (el.angle) {
    const b = bounds(abs), c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    const cos = Math.cos(el.angle), sin = Math.sin(el.angle);
    abs = abs.map(p => ({ x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos }));
  }
  if (el.points) {
    closed = endsMeet(abs, el.type);
    if (closed && el.type !== "freedraw") abs = abs.slice(0, -1);
  }
  return { pts: abs, closed };
}

const isRound = el => el.type === "ellipse" && Math.min(el.width, el.height) / Math.max(el.width, el.height) >= 0.85;
const centreOf = el => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });
const area = pts => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;

function inside(p, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
const within = (inner, outer) => inner.every(p => inside(p, outer));

// Closed outlines that can be part geometry. Dashed lines are construction lines, never material.
const closedShapes = els => els.filter(el => !isNote(el) && el.type !== "text" && el.strokeStyle !== "dashed" && outline(el)?.closed);

// Mirror a point across the infinite line through a in direction d.
function reflect(p, a, d) {
  const len2 = d.x * d.x + d.y * d.y;
  const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len2;
  const foot = { x: a.x + t * d.x, y: a.y + t * d.y };
  return { x: 2 * foot.x - p.x, y: 2 * foot.y - p.y };
}

// A polyline element from absolute points, placed so its first point is at its origin.
function polyline(points, closed, style) {
  const pts = closed ? [...points, points[0]] : points;
  const b = bounds(pts);
  return { type: "line", x: b.minX, y: b.minY, points: pts.map(p => [p.x - b.minX, p.y - b.minY]), ...style };
}

// The same line element with new absolute points, keeping its id and style.
function reshape(el, points, closed) {
  const pl = polyline(points, closed, {});
  const b = bounds(points);
  return bump({ ...el, x: pl.x, y: pl.y, angle: 0, points: pl.points, width: b.maxX - b.minX, height: b.maxY - b.minY });
}

// Square up a segment: if a→p is within 6° of 0, 45, 90 or 135 degrees, slide p onto that direction.
function squareUp(a, p) {
  const step = Math.PI / 4, ang = Math.atan2(p.y - a.y, p.x - a.x), near = Math.round(ang / step) * step;
  if (Math.abs(ang - near) > 6 * Math.PI / 180) return p;
  const d = { x: Math.cos(near), y: Math.sin(near) }, t = (p.x - a.x) * d.x + (p.y - a.y) * d.y;
  return { x: a.x + d.x * t, y: a.y + d.y * t };
}

// Square up every segment of a polyline. A closed outline is kept closed: its last corner
// takes the start's x or y when the closing edge is level or upright.
function squarePath(pts, closed, join = p => p) {
  const q = [join(pts[0])];
  for (let i = 1; i < pts.length; i++) q.push(squareUp(q[i - 1], pts[i]));
  const last = q.length - 1;
  if (closed) {
    const s = squareUp(q[last], q[0]);
    if (s !== q[0]) {
      if (Math.abs(q[last].y - q[0].y) < Math.abs(q[last].x - q[0].x)) q[last] = { ...q[last], y: q[0].y };
      else q[last] = { ...q[last], x: q[0].x };
    }
  } else q[last] = join(q[last]);
  return q;
}

// ---- Dimensions ----
// A dimension is a group of blue elements. Its text carries customData.dim:
// { target: element id, kind: "linear" | "diameter", edge: edge index (linear only), mm: typed value }.

function edgeEnds(el, edge) {
  const o = outline(el);
  if (!o) return null;
  if (el.type === "freedraw") return [o.pts[0], o.pts[o.pts.length - 1]];
  const a = o.pts[edge], b = o.pts[(edge + 1) % o.pts.length];
  return a && b ? [a, b] : null;
}

// Drawn size of a dimension's target in scene px, or NaN when the target no longer has that edge.
function measure(el, dim) {
  if (dim.kind === "diameter") return (el.width + el.height) / 2;
  const ends = edgeEnds(el, dim.edge);
  return ends ? dist(ends[0], ends[1]) : NaN;
}

const dimsOf = els => els.filter(el => !el.isDeleted && el.customData?.dim);

// mm per scene px. Typed dimensions set the scale (the median of them, as a sketch is never exactly to scale).
function mmPerPx(els) {
  const byId = new Map(els.filter(el => !el.isDeleted).map(el => [el.id, el]));
  const ratios = dimsOf(els).map(t => {
    const target = byId.get(t.customData.dim.target), px = target && measure(target, t.customData.dim);
    return px > 0 ? t.customData.dim.mm / px : null;
  }).filter(Boolean).sort((a, b) => a - b);
  return ratios.length ? ratios[Math.floor(ratios.length / 2)] : MM_PER_PX;
}

// The edge or circle nearest a scene point, within tol scene px, or an existing dimension text there.
function pickAt(els, p, tol) {
  const text = dimsOf(els).find(t => p.x >= t.x - 4 && p.x <= t.x + t.width + 4 && p.y >= t.y - 4 && p.y <= t.y + t.height + 4);
  if (text) return { editing: text };
  let best = null;
  const offer = (d, hit) => { if (d <= tol && (!best || d < best.d)) best = { d, ...hit }; };
  for (const el of els) {
    if (el.isDeleted || isNote(el) || el.type === "text") continue;
    if (isRound(el)) {
      offer(Math.abs(dist(p, centreOf(el)) - (el.width + el.height) / 4), { el, kind: "diameter" });
      continue;
    }
    if (el.type === "ellipse") continue;               // an oval has no edge or diameter to measure
    const o = outline(el);
    if (!o) continue;
    if (el.type === "freedraw") {
      if (o.closed) continue;                          // a closed pen loop has no straight edge to measure
      const d = Math.min(...o.pts.slice(1).map((q, i) => segDist(p, o.pts[i], q)));
      offer(d, { el, kind: "linear", edge: 0 });
      continue;
    }
    const n = o.closed ? o.pts.length : o.pts.length - 1;
    for (let i = 0; i < n; i++) offer(segDist(p, o.pts[i], o.pts[(i + 1) % o.pts.length]), { el, kind: "linear", edge: i });
  }
  return best;
}

// The blue elements of one dimension, grouped so they move and delete together.
function dimensionElements(el, dim) {
  const gid = "dim-" + rnd();
  const text = `${dim.kind === "diameter" ? "Ø " : ""}${fmt(dim.mm)} mm`;
  const tw = text.length * 7.6;
  let skeletons;
  if (dim.kind === "diameter") {
    const r = (el.width + el.height) / 4, c = centreOf(el);
    const edge = { x: c.x + r * Math.SQRT1_2, y: c.y - r * Math.SQRT1_2 };
    skeletons = [
      { type: "line", x: edge.x, y: edge.y, points: [[0, 0], [28, -28]], strokeColor: BLUE, strokeWidth: 1 },
      { type: "text", x: edge.x + 32, y: edge.y - 50, text, fontSize: 14, strokeColor: BLUE },
    ];
  } else {
    const [p1, p2] = edgeEnds(el, dim.edge);
    const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy);
    let ux = -dy / len, uy = dx / len;
    // On a closed outline the dimension sits outside the shape.
    const o = outline(el);
    if (o.closed) {
      const c = o.pts.reduce((s, q) => ({ x: s.x + q.x / o.pts.length, y: s.y + q.y / o.pts.length }), { x: 0, y: 0 });
      if (((p1.x + p2.x) / 2 - c.x) * ux + ((p1.y + p2.y) / 2 - c.y) * uy < 0) { ux = -ux; uy = -uy; }
    }
    const nx = ux * 24, ny = uy * 24;
    const mid = { x: (p1.x + p2.x) / 2 + ux * 38, y: (p1.y + p2.y) / 2 + uy * 38 };
    skeletons = [
      { type: "line", x: p1.x, y: p1.y, points: [[0, 0], [nx * 1.2, ny * 1.2]], strokeColor: BLUE, strokeWidth: 1 },
      { type: "line", x: p2.x, y: p2.y, points: [[0, 0], [nx * 1.2, ny * 1.2]], strokeColor: BLUE, strokeWidth: 1 },
      { type: "arrow", x: p1.x + nx, y: p1.y + ny, points: [[0, 0], [dx, dy]], startArrowhead: "bar", endArrowhead: "bar", strokeColor: BLUE, strokeWidth: 1 },
      { type: "text", x: mid.x - tw / 2, y: mid.y - 9, text, fontSize: 14, strokeColor: BLUE },
    ];
  }
  return convertToExcalidrawElements(skeletons).map(e => ({
    ...e,
    groupIds: [gid],
    customData: e.type === "text" ? { note: "dim", dim: { target: el.id, ...dim } } : { note: "dim" },
  }));
}

// ---- Hold to snap: a pen stroke held still at its end becomes a clean line, circle, rectangle or outline. ----
const HOLD_MS = 450;    // how long the pen must stay still before lifting
const HOLD_MOVE = 8;    // screen px the pen may drift and still count as still

// Ramer–Douglas–Peucker: the few corners that describe a hand-drawn path within eps px.
function corners(pts, eps) {
  if (pts.length < 3) return pts;
  let worst = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= eps) return [pts[0], pts[pts.length - 1]];
  return [...corners(pts.slice(0, at + 1), eps).slice(0, -1), ...corners(pts.slice(at), eps)];
}

// Drop corners where the outline barely turns (under 20°), going round a closed loop.
function dropStraight(pts) {
  let out = pts, changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const turn = Math.abs(Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)));
      if (turn < 20 * Math.PI / 180) { out = out.filter((_, j) => j !== i); changed = true; break; }
    }
  }
  return out;
}

// Returns {name, skeleton} for a line, circle, rectangle or straight-sided outline, or null.
function recogniseStroke(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  const { minX, maxX, minY, maxY } = bounds(pts);
  const w = maxX - minX, h = maxY - minY, size = Math.max(w, h);
  if (size < 20) return null;
  const len = dist(a, b);
  if (len >= 0.7 * size && Math.max(...pts.map(p => segDist(p, a, b))) <= 6) {
    return { name: "line", skeleton: { type: "line", x: a.x, y: a.y, points: [[0, 0], [b.x - a.x, b.y - a.y]] } };
  }
  if (len > 0.25 * size) return null;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  if (Math.min(w, h) / Math.max(w, h) >= 0.77) {          // closer to round than 1.3 : 1
    const r = (w + h) / 4;
    if (pts.every(p => Math.abs(dist(p, { x: cx, y: cy }) - r) <= 0.15 * r)) {
      return { name: "circle", skeleton: { type: "ellipse", x: cx - r, y: cy - r, width: 2 * r, height: 2 * r } };
    }
  }
  const tol = 0.12 * Math.min(w, h);
  const near = pts.filter(p => Math.min(Math.abs(p.x - minX), Math.abs(p.x - maxX), Math.abs(p.y - minY), Math.abs(p.y - maxY)) <= tol).length;
  const outlineCorners = dropStraight(corners(pts, 0.05 * size).slice(0, -1));
  if (w >= 20 && h >= 20 && Math.max(w, h) / Math.min(w, h) <= 4 && near / pts.length >= 0.85 && outlineCorners.length <= 4) {
    return { name: "rectangle", skeleton: { type: "rectangle", x: minX, y: minY, width: w, height: h } };
  }
  if (outlineCorners.length >= 3 && outlineCorners.length <= 16) {
    return { name: `outline with ${outlineCorners.length} sides`, skeleton: polyline(squarePath(outlineCorners, true), true, {}) };
  }
  return null;
}

// Replaces a freehand stroke with the recognised shape, keeping its colour and stroke width.
function snapStroke(api, el, flash) {
  const pts = el.points.map(([px, py]) => ({ x: el.x + px, y: el.y + py }));
  const found = recogniseStroke(pts);
  if (!found) return flash("Held stroke is not a line, circle, rectangle or straight-sided outline", "warn");
  const style = { strokeColor: el.strokeColor, strokeWidth: el.strokeWidth, strokeStyle: el.strokeStyle };
  const replacement = convertToExcalidrawElements([{ ...found.skeleton, ...style }]);
  commit(api, [...api.getSceneElements().filter(e => e.id !== el.id), ...replacement]);
  flash(`Snapped to ${found.name}`);
}

// ---- Part features ----
// A marked profile carries customData.part = { feature: "extrude", depthMm } or { feature: "revolve", angleDeg, axis: line id }.
// Closed shapes inside it are holes, cut through: customData.part = { hole: true, of: profile id }.

// What Mark profile would do with the selection: the outer outlines, the holes inside each, and the centre line.
function planPart(api) {
  const sel = selected(api).filter(el => !isNote(el));
  const axis = sel.find(el => el.type === "line" && el.strokeStyle === "dashed");
  const picked = closedShapes(sel);
  if (!picked.length) return null;
  const pts = new Map(closedShapes(live(api)).map(el => [el.id, outline(el).pts]));
  const outers = [];
  for (const el of [...picked].sort((a, b) => area(pts.get(b.id)) - area(pts.get(a.id)))) {
    if (!outers.some(o => within(pts.get(el.id), pts.get(o.el.id)))) outers.push({ el, holes: [] });
  }
  const outerIds = new Set(outers.map(o => o.el.id));
  for (const o of outers) {
    // Every closed shape inside the profile is a hole, selected or not, unless it sits inside another hole.
    const inner = closedShapes(live(api)).filter(s => !outerIds.has(s.id) && within(pts.get(s.id), pts.get(o.el.id)));
    o.holes = inner.filter(s => !inner.some(t => t !== s && within(pts.get(s.id), pts.get(t.id))));
  }
  let crossesAxis = false;
  if (axis) {
    const [a, b] = [axis.points[0], axis.points[axis.points.length - 1]].map(([px, py]) => ({ x: axis.x + px, y: axis.y + py }));
    const sides = outers.flatMap(o => pts.get(o.el.id)).map(p => Math.sign(Math.round((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))));
    crossesAxis = sides.includes(1) && sides.includes(-1);
  }
  return { outers, axis, crossesAxis };
}

function applyPart(api, plan, feature, flash) {
  const holeOf = new Map(), outerFeature = new Map(), groups = new Map();
  for (const o of plan.outers) {
    const gid = "part-" + rnd();
    groups.set(o.el.id, gid);
    outerFeature.set(o.el.id, feature.feature === "revolve" ? { ...feature, axis: plan.axis.id } : feature);
    o.holes.forEach(h => holeOf.set(h.id, o.el.id));
  }
  const labels = plan.outers.map(o => {
    const b = bounds(outline(o.el).pts);
    const holes = o.holes.length ? ` · ${o.holes.length} hole${o.holes.length > 1 ? "s" : ""} through` : "";
    const text = feature.feature === "revolve" ? `Revolve ${fmt(feature.angleDeg)}°${holes}` : `Extrude ${fmt(feature.depthMm)} mm${holes}`;
    return { type: "text", x: b.minX, y: b.minY - 72, text, fontSize: 14, strokeColor: BLUE };   // above, clear of dimensions and the centre line
  });
  const labelEls = convertToExcalidrawElements(labels).map((e, i) => ({
    ...e, groupIds: [groups.get(plan.outers[i].el.id)], customData: { note: "label", of: plan.outers[i].el.id },
  }));
  const marked = el => {
    if (outerFeature.has(el.id)) {
      return bump({ ...el, groupIds: [groups.get(el.id)], backgroundColor: PART_FILL, fillStyle: "solid",
        customData: { ...(el.customData || {}), part: outerFeature.get(el.id) } });
    }
    const of = holeOf.get(el.id);
    return bump({ ...el, groupIds: [groups.get(of)], backgroundColor: PAPER, fillStyle: "solid",
      customData: { ...(el.customData || {}), part: { hole: true, of } } });
  };
  // Drop old labels of these profiles, then lay each profile's holes just above it so they show as cut-outs.
  const rest = api.getSceneElements().filter(el => !holeOf.has(el.id) && !(el.customData?.note === "label" && groups.has(el.customData.of)));
  const holesByOuter = new Map(plan.outers.map(o => [o.el.id, o.holes]));
  const next = rest.flatMap(el => outerFeature.has(el.id) ? [marked(el), ...holesByOuter.get(el.id).map(marked)] : [el]);
  commit(api, [...next, ...labelEls]);
  const holes = plan.outers.reduce((n, o) => n + o.holes.length, 0);
  flash(`${plan.outers.length > 1 ? plan.outers.length + " profiles" : "Profile"} marked${holes ? `, ${holes} hole${holes > 1 ? "s" : ""}` : ""}`);
}

// Dimensions drive the drawing one axis at a time. Every corner's x (or y) is a breakpoint; a level
// dimension fixes the distance between two x breakpoints by stretching the gaps between them, and
// undimensioned gaps keep their drawn size at scale s. Smaller spans are solved first, so a part's
// thickness is kept when its overall width is then set. Returns px → mm along the axis, plus any
// dimensions that could not be met because every gap inside them was already fixed.
function axisMap(values, spans, s) {
  const xs = [...new Set(values.map(v => Math.round(v)))].sort((a, b) => a - b)
    .filter((v, i, arr) => i === 0 || v - arr[i - 1] > 2);
  const at = v => xs.reduce((best, x, i) => Math.abs(x - v) < Math.abs(xs[best] - v) ? i : best, 0);
  const gap = xs.slice(1).map((x, i) => (x - xs[i]) * s), fixed = gap.map(() => false), conflicts = [];
  const solved = spans.map(sp => ({ ...sp, i: at(Math.min(sp.a, sp.b)), j: at(Math.max(sp.a, sp.b)) }))
    .filter(sp => sp.j > sp.i).sort((p, q) => (p.j - p.i) - (q.j - q.i));
  for (const sp of solved) {
    const ks = gap.map((_, k) => k).filter(k => k >= sp.i && k < sp.j);
    const free = ks.filter(k => !fixed[k]), fixedSum = ks.filter(k => fixed[k]).reduce((t, k) => t + gap[k], 0);
    const freeSum = free.reduce((t, k) => t + gap[k], 0);
    if (!free.length || sp.mm - fixedSum <= 0) { if (Math.abs(fixedSum - sp.mm) > 0.01) conflicts.push(sp.dim); continue; }
    free.forEach(k => { gap[k] *= (sp.mm - fixedSum) / freeSum; fixed[k] = true; });
  }
  const pos = gap.reduce((acc, g) => [...acc, acc[acc.length - 1] + g], [0]);
  const map = v => {
    if (!xs.length) return v * s;
    if (v <= xs[0]) return (v - xs[0]) * s;
    for (let k = 0; k < gap.length; k++) {
      if (v <= xs[k + 1]) return pos[k] + (v - xs[k]) / (xs[k + 1] - xs[k]) * gap[k];
    }
    return pos[pos.length - 1] + (v - xs[xs.length - 1]) * s;
  };
  return { map, conflicts };
}

// ---- partSketch: the drawing as a part, in mm with Y up. This is what the laptop builds from. ----
//   { units, mmPerPx, scaleFrom, features: [{ type: "extrude" | "revolve", depth | angle, axis, profile, holes }],
//     dimensions, conflicts, other, notes }
// Shapes: { type: "rect", center, width, height } · { type: "circle", center, diameter }
//         { type: "ellipse", center, rx, ry } · { type: "polygon" | "polyline", points, edgeDims }
// Level and upright dimensions drive the coordinates (see axisMap) and diameters set circle sizes;
// anything without a dimension is taken from the drawing at mmPerPx.
function partSketch(elements) {
  const els = elements.filter(el => !el.isDeleted);
  const s = mmPerPx(els);
  const byId = new Map(els.map(el => [el.id, el]));
  const dims = dimsOf(els).map(t => t.customData.dim).filter(d => byId.has(d.target) && measure(byId.get(d.target), d) > 0);
  const dimsFor = id => dims.filter(d => d.target === id);
  const profiles = els.filter(el => el.customData?.part?.feature);
  const geometry = els.filter(el => !isNote(el) && el.type !== "text" && outline(el));

  // Breakpoints come from clean corners; pen strokes and circles are placed by the map, not shaping it.
  const vertices = geometry.filter(el => el.type !== "freedraw" && el.type !== "ellipse").flatMap(el => outline(el).pts);
  const circleEdges = geometry.filter(el => el.type === "ellipse").flatMap(el => [{ x: el.x, y: el.y }, { x: el.x + el.width, y: el.y + el.height }]);
  const spans = { x: [], y: [] };
  for (const d of dims.filter(d => d.kind === "linear")) {
    const [p, q] = edgeEnds(byId.get(d.target), d.edge);
    if (Math.abs(p.y - q.y) <= 0.02 * Math.abs(p.x - q.x)) spans.x.push({ a: p.x, b: q.x, mm: d.mm, dim: d });
    else if (Math.abs(p.x - q.x) <= 0.02 * Math.abs(p.y - q.y)) spans.y.push({ a: p.y, b: q.y, mm: d.mm, dim: d });
  }
  const mx = axisMap(vertices.map(p => p.x), spans.x, s), my = axisMap(vertices.map(p => p.y), spans.y, s);
  const sized = [...(profiles.length ? profiles : geometry).flatMap(el => outline(el).pts), ...(profiles.length ? [] : circleEdges)];
  const ox = sized.length ? Math.min(...sized.map(p => mx.map(p.x))) : 0;
  const oy = sized.length ? Math.max(...sized.map(p => my.map(p.y))) : 0;
  const P = p => [r2(mx.map(p.x) - ox), r2(oy - my.map(p.y))];

  const shape = el => {
    const d = dimsFor(el.id);
    if (isRound(el)) {
      const dia = d.find(k => k.kind === "diameter");
      const [l] = P({ x: el.x, y: 0 }), [r] = P({ x: el.x + el.width, y: 0 });
      return { type: "circle", center: P(centreOf(el)), diameter: dia ? dia.mm : r2(r - l), dimensioned: !!dia };
    }
    const o = outline(el);
    if (!el.angle && (el.type === "rectangle" || el.type === "ellipse")) {
      const [x1, y1] = P({ x: el.x, y: el.y + el.height }), [x2, y2] = P({ x: el.x + el.width, y: el.y });
      const centre = [r2((x1 + x2) / 2), r2((y1 + y2) / 2)];
      return el.type === "rectangle"
        ? { type: "rect", center: centre, width: r2(x2 - x1), height: r2(y2 - y1) }
        : { type: "ellipse", center: centre, rx: r2((x2 - x1) / 2), ry: r2((y2 - y1) / 2) };
    }
    return { type: o.closed ? "polygon" : "polyline", points: o.pts.map(P), edgeDims: d.map(k => ({ edge: k.edge, mm: k.mm })) };
  };

  const features = profiles.map(el => {
    const part = el.customData.part;
    const holes = els.filter(h => h.customData?.part?.hole && h.customData.part.of === el.id).map(shape);
    if (part.feature === "revolve") {
      const axis = byId.get(part.axis);
      const ends = axis ? [axis.points[0], axis.points[axis.points.length - 1]].map(([px, py]) => P({ x: axis.x + px, y: axis.y + py })) : null;
      return { id: el.id, type: "revolve", angle: part.angleDeg, axis: ends, profile: shape(el), holes };
    }
    return { id: el.id, type: "extrude", depth: part.depthMm, profile: shape(el), holes };
  });

  const used = new Set([...profiles.map(el => el.id), ...els.filter(el => el.customData?.part?.hole).map(el => el.id)]);
  return {
    units: "mm",
    mmPerPx: r2(s * 1000) / 1000,
    scaleFrom: dims.length ? "dimensions" : "default",
    features,
    dimensions: dims.map(d => ({ target: d.target, kind: d.kind, edge: d.edge, mm: d.mm })),
    conflicts: [...mx.conflicts, ...my.conflicts].map(d => ({ target: d.target, edge: d.edge, mm: d.mm })),
    other: geometry.filter(el => !used.has(el.id)).map(el => ({ id: el.id, role: el.strokeStyle === "dashed" ? "centre line" : "sketch", ...shape(el) })),
    notes: els.filter(el => el.type === "text" && !isNote(el)).map(el => ({ text: el.text, at: P({ x: el.x, y: el.y }) })),
  };
}

// DXF export: every outline in mm with Y up, using the dimension scale.
// Plain R12-style entities that AutoCAD, Fusion and most CAD programs open.
function toDxf(elements) {
  const s = mmPerPx(elements);
  const out = [];
  const ent = (type, pairs) => { out.push("0", type); pairs.forEach(([code, val]) => out.push(String(code), String(val))); };
  const X = x => (x * s).toFixed(3), Y = y => (-y * s).toFixed(3);
  for (const el of elements) {
    if (el.isDeleted) continue;
    if (el.type === "text") {
      ent("TEXT", [[8, 0], [10, X(el.x)], [20, Y(el.y + el.fontSize)], [40, (el.fontSize * s).toFixed(3)], [1, el.text]]);
    } else if (el.type === "ellipse" && Math.abs(el.width - el.height) < 1) {
      const c = centreOf(el);
      ent("CIRCLE", [[8, 0], [10, X(c.x)], [20, Y(c.y)], [40, (el.width / 2 * s).toFixed(3)]]);
    } else {
      const o = outline(el);
      if (o) ent("LWPOLYLINE", [[8, 0], [90, o.pts.length], [70, o.closed ? 1 : 0], ...o.pts.flatMap(p => [[10, X(p.x)], [20, Y(p.y)]])]);
    }
  }
  return ["0", "SECTION", "2", "ENTITIES", ...out, "0", "ENDSEC", "0", "EOF", ""].join("\n");
}

// ---- Tools. Each one reports what it did, or why it could not run. ----

// Centre of what is on screen, in scene coordinates.
function screenCentre(api) {
  const s = api.getAppState();
  return { x: -s.scrollX + s.width / (2 * s.zoom.value), y: -s.scrollY + s.height / (2 * s.zoom.value) };
}

function centreLine(api, flash) {
  const c = screenCentre(api);
  commit(api, [...api.getSceneElements(), ...convertToExcalidrawElements([
    { type: "line", x: c.x - 200, y: c.y, points: [[0, 0], [400, 0]], strokeStyle: "dashed", strokeColor: BLUE, strokeWidth: 1 },
  ])]);
  flash("Centre line added");
}

// Mirror: reflect the selected shapes across the selected dashed centre line.
// Circles stay circles so they can still be dimensioned and used as holes.
function mirror(api, flash) {
  const axis = selected(api).find(el => el.type === "line" && el.strokeStyle === "dashed");
  if (!axis) return flash("Select a dashed centre line and the shapes to mirror", "warn");
  const [a, b] = [axis.points[0], axis.points[axis.points.length - 1]].map(([px, py]) => ({ x: axis.x + px, y: axis.y + py }));
  const d = { x: b.x - a.x, y: b.y - a.y };
  const targets = selected(api).filter(el => el !== axis && !isNote(el) && el.type !== "text" && outline(el));
  if (!targets.length) return flash("Select the shapes to mirror as well", "warn");
  const made = targets.map(el => {
    const style = { strokeColor: el.strokeColor, strokeWidth: el.strokeWidth, strokeStyle: el.strokeStyle };
    if (isRound(el)) {
      const c = reflect(centreOf(el), a, d);
      return { type: "ellipse", x: c.x - el.width / 2, y: c.y - el.height / 2, width: el.width, height: el.height, ...style };
    }
    const o = outline(el);
    return polyline(o.pts.map(p => reflect(p, a, d)), o.closed, style);
  });
  commit(api, [...api.getSceneElements(), ...convertToExcalidrawElements(made)]);
  flash(`Mirrored ${made.length} item${made.length > 1 ? "s" : ""}`);
}

// Hatch: give each selected closed shape a hachure fill.
function hatch(api, flash) {
  const ids = new Set(closedShapes(selected(api)).map(el => el.id));
  if (!ids.size) return flash("Select a closed shape first", "warn");
  commit(api, api.getSceneElements().map(el => ids.has(el.id) ? bump({ ...el, fillStyle: "hachure", backgroundColor: "#DDE3EE" }) : el));
  flash("Hatched");
}

// Constrain: square up every segment of the selected lines to 0, 45, 90 or 135 degrees when close,
// and join open ends to a nearby corner of another shape within 10 px.
function constrain(api, flash) {
  const sel = selected(api).filter(el => (el.type === "line" || el.type === "arrow") && !isNote(el));
  if (!sel.length) return flash("Select a line first", "warn");
  const ids = new Set(sel.map(el => el.id));
  const anchors = live(api).filter(el => !ids.has(el.id) && !isNote(el) && el.type !== "freedraw" && el.type !== "ellipse" && outline(el)).flatMap(el => outline(el).pts);
  const join = p => {
    let best = p, bestD = 10;
    for (const a of anchors) { const d = dist(a, p); if (d < bestD) { bestD = d; best = a; } }
    return best;
  };
  const fixed = new Map(sel.map(el => {
    const o = outline(el);
    return [el.id, reshape(el, squarePath(o.pts, o.closed, join), o.closed)];
  }));
  commit(api, api.getSceneElements().map(el => fixed.get(el.id) || el));
  flash("Constrained");
}

// Offset: a parallel copy of each selected straight line, or an inset copy of each rectangle, 5 mm away.
function offset(api, flash) {
  const gap = 5 / mmPerPx(api.getSceneElements());
  const out = [];
  for (const el of selected(api)) {
    if (isNote(el)) continue;
    if (el.type === "rectangle" && el.width > 2 * gap && el.height > 2 * gap) {
      out.push({ type: "rectangle", x: el.x + gap, y: el.y + gap, width: el.width - 2 * gap, height: el.height - 2 * gap, angle: el.angle, strokeColor: el.strokeColor, strokeWidth: el.strokeWidth, backgroundColor: "transparent" });
    } else if ((el.type === "line" || el.type === "arrow") && el.points.length === 2) {
      const [p1, p2] = outline(el).pts;
      const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy);
      if (!len) continue;
      const nx = -dy / len * gap, ny = dx / len * gap;
      out.push({ type: "line", x: p1.x + nx, y: p1.y + ny, points: [[0, 0], [dx, dy]], strokeColor: el.strokeColor, strokeWidth: el.strokeWidth });
    }
  }
  if (!out.length) return flash("Select a straight line or a rectangle first", "warn");
  commit(api, [...api.getSceneElements(), ...convertToExcalidrawElements(out)]);
  flash("Offset copy added, 5 mm");
}

function toggleGrid(api) {
  api.updateScene({ appState: { gridModeEnabled: !api.getAppState().gridModeEnabled } });
}

// DXF: download the drawing as a CAD file.
function exportDxf(api, flash) {
  const url = URL.createObjectURL(new Blob([toDxf(api.getSceneElements())], { type: "application/dxf" }));
  const a = document.createElement("a");
  a.href = url; a.download = "drawing.dxf";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash("DXF downloaded");
}

const SECTIONS = [
  { title: "Lines", items: [
    { label: "Centre line", icon: "Minus", run: centreLine },
    { label: "Mirror", icon: "Mirror", run: mirror },
  ] },
  { title: "Dimensions", items: [
    { label: "Dimension", icon: "Frame2", run: "dimension" },
  ] },
  { title: "Edit", items: [
    { label: "Hatch", icon: "Hashtag", run: hatch },
    { label: "Constrain", icon: "VectorSquare", run: constrain },
    { label: "Offset", icon: "Squares", run: offset },
  ] },
  { title: "Part", items: [
    { label: "Mark profile", icon: "Layers", run: "profile" },
  ] },
  { title: "Sheet", items: [
    { label: "Snap grid", icon: "Grid", run: toggleGrid, toggle: true },
    { label: "Export DXF", icon: "Upload", run: exportDxf },
  ] },
];

function App() {
  const [api, setApi] = useState(null);
  const [gridOn, setGridOn] = useState(true);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const [dialog, setDialog] = useState(null);   // { type: "dim", pick, value } or { type: "part", plan, mode, depth, angle }
  const [picking, setPicking] = useState(false); // Dimension is waiting for a tap on an edge or circle
  const pickingRef = useRef(false);
  const seenStrokes = useRef(new Set());   // freedraw ids already seen in onChange
  const activeStroke = useRef(null);       // the freedraw stroke being drawn now
  const holdPending = useRef(false);       // set when a pen lifts after being still
  const pressAt = useRef(null);            // where and when the current pen press went still

  // Every tool reports through here. kind is "ok" or "warn" (the tool could not run). A sticky toast stays until replaced.
  const flash = (text, kind = "ok", sticky = false) => {
    setToast({ id: Date.now(), text, kind });
    clearTimeout(toastTimer.current);
    if (!sticky) toastTimer.current = setTimeout(() => setToast(null), 2800);
  };

  const setPick = on => {
    pickingRef.current = on;
    setPicking(on);
    if (on) flash("Tap an edge or a circle to dimension it", "ok", true);
    else setToast(null);
  };

  // Dimension picking: the next tap on the board chooses what to dimension and does not reach Excalidraw.
  const pickTap = e => {
    const s = api.getAppState();
    const p = viewportCoordsToSceneCoords(e, s);
    const hit = pickAt(api.getSceneElements(), p, 16 / s.zoom.value);
    setPick(false);
    if (!hit) return flash("Nothing to dimension there. Tap closer to a line or circle", "warn");
    if (hit.editing) {
      const dim = hit.editing.customData.dim;
      const el = live(api).find(x => x.id === dim.target);
      if (!el) return flash("That dimension's shape was deleted", "warn");
      return setDialog({ type: "dim", pick: { el, kind: dim.kind, edge: dim.edge, replaces: hit.editing.groupIds[0] }, value: fmt(dim.mm) });
    }
    const drawn = measure(hit.el, hit) * mmPerPx(api.getSceneElements());
    setDialog({ type: "dim", pick: hit, value: fmt(Math.round(drawn * 2) / 2) });
  };

  // Hold to snap: note when the pen went still, and whether it was still when it lifted.
  useEffect(() => {
    const root = document.querySelector(".board");
    if (!api || !root) return;
    const down = e => {
      if (pickingRef.current && e.target.tagName === "CANVAS") {
        e.stopPropagation(); e.preventDefault();
        pressAt.current = null;
        return pickTap(e);
      }
      if (api.getAppState().activeTool.type !== "freedraw") { pressAt.current = null; return; }
      pressAt.current = { x: e.clientX, y: e.clientY, still: performance.now() };
    };
    const move = e => {
      const p = pressAt.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > HOLD_MOVE) { p.x = e.clientX; p.y = e.clientY; p.still = performance.now(); }
    };
    const up = () => {
      const p = pressAt.current;
      pressAt.current = null;
      if (p && performance.now() - p.still >= HOLD_MS) holdPending.current = true;
    };
    const esc = e => { if (e.key === "Escape" && pickingRef.current) setPick(false); };
    root.addEventListener("pointerdown", down, true);
    root.addEventListener("pointermove", move, true);
    root.addEventListener("pointerup", up, true);
    window.addEventListener("keydown", esc);
    return () => {
      root.removeEventListener("pointerdown", down, true);
      root.removeEventListener("pointermove", move, true);
      root.removeEventListener("pointerup", up, true);
      window.removeEventListener("keydown", esc);
    };
  }, [api]);

  // Every board change: remember the newest pen stroke, and snap it if it was held still.
  const handleChange = (elements, appState) => {
    setGridOn(!!appState.gridModeEnabled);
    const strokes = elements.filter(e => e.type === "freedraw" && !e.isDeleted);
    const fresh = strokes.filter(e => !seenStrokes.current.has(e.id));
    seenStrokes.current = new Set(strokes.map(e => e.id));
    if (fresh.length) activeStroke.current = fresh[fresh.length - 1].id;
    if (holdPending.current) {
      holdPending.current = false;
      const el = elements.find(e => e.id === activeStroke.current && e.type === "freedraw" && !e.isDeleted);
      if (el) snapStroke(api, el, flash);
    }
  };

  const confirmDim = () => {
    const mm = parseFloat(dialog.value);
    if (!(mm > 0)) return flash("Enter a size above 0 mm", "warn");
    const { el, kind, edge, replaces } = dialog.pick;
    const firstDim = !dimsOf(api.getSceneElements()).length;
    const kept = api.getSceneElements().filter(x => !(replaces && x.groupIds.includes(replaces)));
    const els = [...kept, ...dimensionElements(el, { kind, edge, mm })];
    commit(api, els);
    setDialog(null);
    flash(firstDim ? `Scale set: one grid square is ${fmt(GRID * mmPerPx(els))} mm` : replaces ? "Dimension changed" : "Dimension added");
  };

  const confirmPart = () => {
    const { plan, mode } = dialog;
    if (mode === "extrude") {
      const d = parseFloat(dialog.depth);
      if (!(d > 0)) return flash("Enter a depth above 0 mm", "warn");
      applyPart(api, plan, { feature: "extrude", depthMm: d }, flash);
    } else {
      const a = parseFloat(dialog.angle);
      if (!(a > 0 && a <= 360)) return flash("Enter an angle from 1 to 360°", "warn");
      if (!plan.axis) return flash("Select a dashed centre line with the profile to revolve", "warn");
      if (plan.crossesAxis) return flash("The profile crosses the centre line. Keep it on one side to revolve", "warn");
      applyPart(api, plan, { feature: "revolve", angleDeg: a }, flash);
    }
    setDialog(null);
  };

  // Debug and bridge handles: the browser console can drive the board and read the part.
  useEffect(() => {
    window.board = api;
    window.partSketch = () => partSketch(api.getSceneElements());
  }, [api]);

  const run = (item) => {
    if (!api) return;
    if (item.run === "dimension") return setPick(!pickingRef.current);
    if (pickingRef.current) setPick(false);
    if (item.run === "profile") {
      const plan = planPart(api);
      if (!plan) return flash("Select a closed outline: a shape, or a line or stroke that ends where it started", "warn");
      return setDialog({ type: "part", plan, mode: plan.axis ? "revolve" : "extrude", depth: "10", angle: "360" });
    }
    item.run(api, flash);
  };

  const holes = dialog?.type === "part" ? dialog.plan.outers.reduce((n, o) => n + o.holes.length, 0) : 0;

  return (
    <div className="board">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={{
          appState: {
            viewBackgroundColor: PAPER,
            gridModeEnabled: true,
            gridSize: GRID,
            currentItemStrokeColor: INK,
            currentItemStrokeWidth: 1.5,
            currentItemRoughness: 0,
            currentItemRoundness: "sharp",   // straight lines and square corners, not curves
            currentItemArrowType: "sharp",
            currentItemFontFamily: 2,
            penMode: true,          // palm rejection: with pen mode on, a resting hand does not draw
          },
        }}
        onChange={handleChange}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, changeViewBackgroundColor: false, clearCanvas: true } }}
      />
      <aside className="eng-side" aria-label="Engineering tools">
        {SECTIONS.map(section => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            {section.items.map(item => {
              const on = item.toggle ? gridOn : item.run === "dimension" && picking;
              return (
                <button
                  key={item.label}
                  onClick={() => run(item)}
                  aria-pressed={item.toggle || item.run === "dimension" ? on : undefined}
                  className={on ? "on" : ""}
                >
                  <span className="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[item.icon] }} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </section>
        ))}
      </aside>
      {dialog?.type === "dim" && (
        <div className="eng-dialog-wrap" onClick={() => setDialog(null)}>
          <form className="eng-dialog" role="dialog" aria-label="Dimension" onClick={e => e.stopPropagation()}
            onSubmit={e => { e.preventDefault(); confirmDim(); }}>
            <h2>{dialog.pick.kind === "diameter" ? "Diameter" : "Length"}</h2>
            <label>{dialog.pick.kind === "diameter" ? "Diameter (mm)" : "Length (mm)"}
              <input type="number" min="0" step="any" value={dialog.value} autoFocus
                onFocus={e => e.target.select()} onChange={e => setDialog({ ...dialog, value: e.target.value })} />
            </label>
            <div className="eng-dialog-actions">
              <button type="button" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="primary">Set</button>
            </div>
          </form>
        </div>
      )}
      {dialog?.type === "part" && (
        <div className="eng-dialog-wrap" onClick={() => setDialog(null)}>
          <form className="eng-dialog" role="dialog" aria-label="Mark profile" onClick={e => e.stopPropagation()}
            onSubmit={e => { e.preventDefault(); confirmPart(); }}>
            <h2>Part feature</h2>
            <div className="eng-seg" role="radiogroup" aria-label="Feature">
              {["extrude", "revolve"].map(m => (
                <button key={m} type="button" role="radio" aria-checked={dialog.mode === m} className={dialog.mode === m ? "on" : ""}
                  onClick={() => setDialog({ ...dialog, mode: m })}>{m === "extrude" ? "Extrude" : "Revolve"}</button>
              ))}
            </div>
            {dialog.mode === "extrude" ? (
              <label>Depth (mm)
                <input type="number" min="0" step="any" value={dialog.depth} autoFocus
                  onFocus={e => e.target.select()} onChange={e => setDialog({ ...dialog, depth: e.target.value })} />
              </label>
            ) : (
              <label>Angle (°)
                <input type="number" min="1" max="360" step="any" value={dialog.angle}
                  onFocus={e => e.target.select()} onChange={e => setDialog({ ...dialog, angle: e.target.value })} />
              </label>
            )}
            <p className={"eng-note" + (dialog.mode === "revolve" && (!dialog.plan.axis || dialog.plan.crossesAxis) ? " warn" : "")}>
              {dialog.mode === "revolve" && !dialog.plan.axis ? "Select a dashed centre line with the profile to revolve round it."
                : dialog.mode === "revolve" && dialog.plan.crossesAxis ? "The profile crosses the centre line. Keep it on one side."
                : `${dialog.plan.outers.length > 1 ? dialog.plan.outers.length + " profiles" : "1 profile"}` +
                  (holes ? `, ${holes} hole${holes > 1 ? "s" : ""} cut through` : ", no holes")}
            </p>
            <div className="eng-dialog-actions">
              <button type="button" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="primary">Mark</button>
            </div>
          </form>
        </div>
      )}
      {toast && <div key={toast.id} className={"eng-toast " + toast.kind} role="status" aria-live="polite">{toast.text}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
