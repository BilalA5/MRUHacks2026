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
import { createBridge } from "./bridge.js";

const PAPER = "#FBFBF7";        // drawing paper
const INK = "#1F2A36";          // graphite lines
const BLUE = "#2563EB";         // dimensions, marks and centre lines
const PART_FILL = "#DCE6FB";    // material of a marked profile
const FILLS = { boss: "#C3D4F8", pocket: "#EEF3FC" };   // a boss shows a shade deeper, a pocket a shade lighter
const SOLID = ["extrude", "boss"];                    // features with a flat top that a boss or pocket can sit on
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

// Tool edits go straight onto the undo stack. Lines they make count as tidy already (see tidyLine).
const tidyLines = new Set();
const commit = (api, elements) => {
  elements.forEach(el => { if (el.type === "line") tidyLines.add(el.id); });
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
};

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
// The first dimension typed fixes the scale (its customData.dim.scale), and editing dimensions later keeps it,
// so changing one size never stretches the sizes nobody typed. Drawings from before that use the median.
function mmPerPx(els) {
  const fixed = dimsOf(els).find(t => t.customData.dim.scale > 0);
  if (fixed) return fixed.customData.dim.scale;
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

// ---- Snapping: a pen stroke becomes a clean line, arc, circle or rectangle when the Pencil lifts, ----
// ---- and held still at its end, any straight-sided outline. ----
const HOLD_MS = 450;    // how long the pen must stay still before lifting
const HOLD_MOVE = 8;    // screen px the pen may drift and still count as still
const TAP_PX = 6;       // a stroke smaller than this is a Pencil tap, not a drawing
const JOIN_PX = 12;     // line ends this close are joined into one line

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

// Drop corners where the outline barely turns (under maxDeg), going round a closed loop.
function dropStraight(pts, maxDeg = 20) {
  let out = pts, changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const turn = Math.abs(Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)));
      if (turn < maxDeg * Math.PI / 180) { out = out.filter((_, j) => j !== i); changed = true; break; }
    }
  }
  return out;
}

// The circle through three points, or null when they lie in a line.
function circleThrough(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return null;
  const s = p => p.x * p.x + p.y * p.y;
  const x = (s(a) * (b.y - c.y) + s(b) * (c.y - a.y) + s(c) * (a.y - b.y)) / d;
  const y = (s(a) * (c.x - b.x) + s(b) * (a.x - c.x) + s(c) * (b.x - a.x)) / d;
  return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}

// An open stroke that follows a circle: its points, every 7.5° from its start. A sweep within 10° of a
// quarter or half turn is made exactly that, as drawings use them for rounded corners and slot ends.
function recogniseArc(pts) {
  const c = circleThrough(pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]);
  if (!c || c.r > 2000 || !pts.every(p => Math.abs(dist(p, c) - c.r) <= Math.max(4, 0.08 * c.r))) return null;
  const ang = p => Math.atan2(p.y - c.y, p.x - c.x);
  let sweep = 0;
  for (let i = 1; i < pts.length; i++) sweep += (ang(pts[i]) - ang(pts[i - 1]) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  const deg = Math.abs(sweep) * 180 / Math.PI, nice = Math.round(deg / 90) * 90;
  if (deg < 25 || deg > 300) return null;
  const turn = (nice && Math.abs(deg - nice) <= 10 ? nice : deg) * Math.PI / 180 * Math.sign(sweep);
  const n = Math.max(6, Math.ceil(Math.abs(turn) / (Math.PI / 24))), a0 = ang(pts[0]);
  return Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + c.r * Math.cos(a0 + turn * i / n), y: c.y + c.r * Math.sin(a0 + turn * i / n) }));
}

// Returns {name, skeleton} for a line, arc, circle, rectangle or straight-sided outline, or null.
// Straight-sided outlines are only made from a held stroke (held), as a quick sketch is often meant freehand.
function recogniseStroke(pts, held = true) {
  const a = pts[0], b = pts[pts.length - 1];
  const { minX, maxX, minY, maxY } = bounds(pts);
  const w = maxX - minX, h = maxY - minY, size = Math.max(w, h);
  if (size < 20) return null;
  const len = dist(a, b);
  // A long line is allowed more wobble: 6 px, or 2.5% of its length
  if (len >= 0.7 * size && Math.max(...pts.map(p => segDist(p, a, b))) <= Math.max(6, 0.025 * len)) {
    return { name: "line", skeleton: { type: "line", x: a.x, y: a.y, points: [[0, 0], [b.x - a.x, b.y - a.y]] } };
  }
  if (len > 0.25 * size) {
    const arc = recogniseArc(pts);
    return arc ? { name: "arc", skeleton: polyline(arc, false, {}) } : null;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  if (Math.min(w, h) / Math.max(w, h) >= 0.77) {          // closer to round than 1.3 : 1
    const r = (w + h) / 4;
    // A held stroke asked to be snapped, so a rougher loop still counts as a circle rather than a many-sided outline
    if (pts.every(p => Math.abs(dist(p, { x: cx, y: cy }) - r) <= (held ? 0.25 : 0.15) * r)) {
      return { name: "circle", skeleton: { type: "ellipse", x: cx - r, y: cy - r, width: 2 * r, height: 2 * r } };
    }
  }
  const tol = 0.12 * Math.min(w, h);
  const near = pts.filter(p => Math.min(Math.abs(p.x - minX), Math.abs(p.x - maxX), Math.abs(p.y - minY), Math.abs(p.y - maxY)) <= tol).length;
  const outlineCorners = dropStraight(corners(pts, 0.05 * size).slice(0, -1));
  if (w >= 20 && h >= 20 && Math.max(w, h) / Math.min(w, h) <= 4 && near / pts.length >= 0.85 && outlineCorners.length <= 4) {
    return { name: "rectangle", skeleton: { type: "rectangle", x: minX, y: minY, width: w, height: h } };
  }
  if (held && outlineCorners.length >= 3 && outlineCorners.length <= 16) {
    return { name: `outline with ${outlineCorners.length} sides`, skeleton: polyline(squarePath(outlineCorners, true), true, {}) };
  }
  return null;
}

// Replaces a freehand stroke with the recognised shape, keeping its colour and stroke width.
// held: the pen was held still at the end, so any outline may be made and a miss is reported.
function snapStroke(api, el, flash, held) {
  const pts = el.points.map(([px, py]) => ({ x: el.x + px, y: el.y + py }));
  const others = api.getSceneElements().filter(e => e.id !== el.id);
  const b = bounds(pts);
  if (!held && Math.max(b.maxX - b.minX, b.maxY - b.minY) < TAP_PX) return commit(api, others);   // a tap, not a drawing
  const found = recogniseStroke(pts, held);
  if (!found) return held && flash("Held stroke is not a line, arc, circle, rectangle or straight-sided outline", "warn");
  const style = { strokeColor: el.strokeColor, strokeWidth: el.strokeWidth, strokeStyle: el.strokeStyle };
  const [shape] = convertToExcalidrawElements([{ ...found.skeleton, ...style }]);
  const joined = shape.type === "line" ? joinLines([...others, shape], shape) : null;
  commit(api, joined ? joined.elements : [...others, shape]);
  flash(joined?.closed ? "Outline closed" : `Snapped to ${found.name}`);
}

// Joins a line to the open lines whose ends meet its ends, so an outline drawn one side at a time
// becomes one closed outline that Profile, Hole and the 3D preview can use.
// Returns {elements, closed} with the lines merged into this one, or null when nothing meets it.
function joinLines(els, line) {
  const open = el => el.type === "line" && !el.isDeleted && !isNote(el) && el.strokeStyle !== "dashed" && !outline(el).closed;
  if (!open(line)) return null;
  let pts = outline(line).pts;
  const gone = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const other of els) {
      if (other.id === line.id || gone.has(other.id) || !open(other)) continue;
      const q = outline(other).pts, a = pts[0], b = pts[pts.length - 1];
      const merged = dist(b, q[0]) <= JOIN_PX ? [...pts, ...q.slice(1)]
        : dist(b, q[q.length - 1]) <= JOIN_PX ? [...pts, ...q.slice(0, -1).reverse()]
        : dist(a, q[q.length - 1]) <= JOIN_PX ? [...q, ...pts.slice(1)]
        : dist(a, q[0]) <= JOIN_PX ? [...q.slice(1).reverse(), ...pts] : null;
      if (merged) { pts = merged; gone.add(other.id); grew = true; }
    }
  }
  const closed = pts.length >= 4 && dist(pts[0], pts[pts.length - 1]) <= JOIN_PX;
  if (!gone.size && !closed) return null;
  const joined = reshape(line, closed ? pts.slice(0, -1) : pts, closed);
  return { elements: els.filter(e => !gone.has(e.id)).map(e => e.id === line.id ? joined : e), closed };
}

// ---- Part features ----
// A marked profile carries customData.part = { feature: "extrude", depthMm } or { feature: "revolve", angleDeg, axis: line id }.
// Closed shapes inside it are holes, cut through: customData.part = { hole: true, of: profile id }.

const isCentreLine = el => el.type === "line" && el.strokeStyle === "dashed" && !isNote(el);
const lineEnds = el => [el.points[0], el.points[el.points.length - 1]].map(([px, py]) => ({ x: el.x + px, y: el.y + py }));

// Whether points lie on both sides of a centre line.
function crosses(axis, pts) {
  const [a, b] = lineEnds(axis);
  const sides = pts.map(p => Math.sign(Math.round((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))));
  return sides.includes(1) && sides.includes(-1);
}

// What Profile would do with the picked outlines: the outer outlines, the holes inside each, and the centre line.
// With no centre line given, the nearest one the outlines do not cross is used, if it is close by.
function planPart(api, picked, axis) {
  if (!picked.length) return null;
  const pts = new Map(closedShapes(live(api)).map(el => [el.id, outline(el).pts]));
  const outers = [];
  for (const el of [...picked].sort((a, b) => area(pts.get(b.id)) - area(pts.get(a.id)))) {
    if (!outers.some(o => within(pts.get(el.id), pts.get(o.el.id)))) outers.push({ el, holes: [] });
  }
  const outerIds = new Set(outers.map(o => o.el.id));
  for (const o of outers) {
    // Every closed shape inside the profile is a hole, selected or not, unless it sits inside another hole.
    // A boss or pocket drawn on it, and the holes in those, belong to them instead.
    const nested = closedShapes(live(api)).filter(t => t.customData?.part?.feature && !outerIds.has(t.id) && within(pts.get(t.id), pts.get(o.el.id)));
    const inner = closedShapes(live(api)).filter(s => !outerIds.has(s.id) && !s.customData?.part?.feature && within(pts.get(s.id), pts.get(o.el.id))
      && !nested.some(t => within(pts.get(s.id), pts.get(t.id))));
    o.holes = inner.filter(s => !inner.some(t => t !== s && within(pts.get(s.id), pts.get(t.id))));
  }
  const all = outers.flatMap(o => pts.get(o.el.id));
  if (!axis) {
    const b = bounds(all), reach = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const gap = line => { const [a, c] = lineEnds(line); return Math.min(...all.map(p => segDist(p, a, c))); };
    axis = live(api).filter(el => isCentreLine(el) && !crosses(el, all) && gap(el) <= reach).sort((p, q) => gap(p) - gap(q))[0];
  }
  return { outers, axis, crossesAxis: !!axis && crosses(axis, all) };
}

function applyPart(api, plan, feature, flash) {
  const holeIn = new Map(), outerFeature = new Map(), groups = new Map(), regroup = new Map();
  for (const o of plan.outers) {
    const gid = "part-" + rnd();
    groups.set(o.el.id, gid);
    const old = o.el.groupIds.find(g => g.startsWith("part-"));
    if (old) regroup.set(old, gid);
    outerFeature.set(o.el.id, feature.feature === "revolve" ? { ...feature, axis: plan.axis.id } : feature);
    o.holes.forEach(h => holeIn.set(h.id, o.el.id));
  }
  const labels = plan.outers.map(o => {
    const b = bounds(outline(o.el).pts);
    const edge = feature.topEdge ? `, top edges ${feature.topEdge.kind === "fillet" ? "R" : "C"}${fmt(feature.topEdge.size)}` : "";
    const text = { revolve: `Revolve ${fmt(feature.angleDeg)}°`, boss: `Boss ${fmt(feature.heightMm)} mm`,
      pocket: `Pocket ${fmt(feature.depthMm)} mm deep` }[feature.feature] || `Extrude ${fmt(feature.depthMm)} mm`;
    return { type: "text", x: b.minX, y: b.minY - 72, text: text + edge, fontSize: 14, strokeColor: BLUE };   // above, clear of dimensions and the centre line
  });
  const labelEls = convertToExcalidrawElements(labels).map((e, i) => ({
    ...e, groupIds: [groups.get(plan.outers[i].el.id)], customData: { note: "label", of: plan.outers[i].el.id },
  }));
  const marked = el => {
    if (outerFeature.has(el.id)) {
      return bump({ ...el, groupIds: [groups.get(el.id)], backgroundColor: FILLS[feature.feature] || PART_FILL, fillStyle: "solid",
        customData: { ...(el.customData || {}), part: outerFeature.get(el.id) } });
    }
    // A hole keeps its Hole-tool spec and its own group inside the part's group.
    const of = holeIn.get(el.id);
    return bump({ ...el, groupIds: [...el.groupIds.filter(g => g.startsWith("hole-")), groups.get(of)], backgroundColor: PAPER, fillStyle: "solid",
      customData: { ...(el.customData || {}), part: { ...(holeOf(el) || {}), hole: true, of } } });
  };
  // Notes that belonged to the profile's earlier marking move into its new group.
  const moved = el => el.groupIds.some(g => regroup.has(g)) ? { ...el, groupIds: el.groupIds.map(g => regroup.get(g) || g) } : el;
  // Drop old labels and bolt circles of these profiles, then lay each profile's holes just above it so they show as cut-outs.
  const stale = el => ["label", "bolts"].includes(el.customData?.note) && groups.has(el.customData.of);
  const rest = api.getSceneElements().filter(el => !holeIn.has(el.id) && !stale(el)).map(moved);
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
  const unmap = m => {
    if (!xs.length) return m / s;
    if (m <= 0) return xs[0] + m / s;
    for (let k = 0; k < gap.length; k++) {
      if (m <= pos[k + 1]) return xs[k] + (m - pos[k]) / gap[k] * (xs[k + 1] - xs[k]);
    }
    return xs[xs.length - 1] + (m - pos[pos.length - 1]) / s;
  };
  return { map, unmap, conflicts };
}

// ---- The sheet: scene px ↔ part mm (Y up), with typed dimensions applied. ----
// Level and upright dimensions drive the coordinates (see axisMap); anything without a dimension
// is taken from the drawing at mmPerPx.
function sheetFrame(elements) {
  const els = elements.filter(el => !el.isDeleted);
  const s = mmPerPx(els);
  const byId = new Map(els.map(el => [el.id, el]));
  const dims = dimsOf(els).map(t => t.customData.dim).filter(d => byId.has(d.target) && measure(byId.get(d.target), d) > 0);
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
  const toPx = ([X, Y]) => ({ x: mx.unmap(X + ox), y: my.unmap(oy - Y) });
  return { els, s, byId, dims, profiles, geometry, conflicts: [...mx.conflicts, ...my.conflicts], P, toPx };
}

// A closed outline on the sheet: its corners in mm and its box. Holes are placed from the box's left and bottom.
function profileBox(f, el) {
  const pts = outline(el).pts.map(f.P).map(([x, y]) => ({ x, y }));
  return { ...bounds(pts), pts };
}

// ---- Holes ----
// A hole made with the Hole tool is a paper-filled circle with customData.part =
// { hole: true, of: profile id, spec, pattern?, copyOf? }. spec = { kind, diameter, x, y, ... } in mm,
// x and y measured from the profile's left and bottom edges. kind is through, blind (depth),
// counterbore (cbDiameter, cbDepth) or countersink (cskDiameter, 90°).
const HOLE_KINDS = { through: "Through", blind: "Blind", counterbore: "C'bore", countersink: "C'sink" };

function holeCallout(spec, count = 1) {
  const n = count > 1 ? `${count}× ` : "", d = `Ø${fmt(spec.diameter)}`;
  if (spec.kind === "blind") return `${n}${d} ↧ ${fmt(spec.depth)}`;
  if (spec.kind === "counterbore") return `${n}${d} THRU\n⌴ Ø${fmt(spec.cbDiameter)} ↧ ${fmt(spec.cbDepth)}`;
  if (spec.kind === "countersink") return `${n}${d} THRU\n⌵ Ø${fmt(spec.cskDiameter)} × 90°`;
  return `${n}${d} THRU`;
}

const holeOf = el => el.customData?.part?.hole ? el.customData.part : null;
const partDepth = profile => profile.customData?.part?.feature === "extrude" ? profile.customData.part.depthMm : null;

// The widest circle a hole cuts, which must stay inside the profile.
function holeFits(box, spec) {
  const r = Math.max(spec.diameter, spec.cbDiameter || 0, spec.cskDiameter || 0) / 2;
  const cx = box.minX + spec.x, cy = box.minY + spec.y;
  return within(Array.from({ length: 24 }, (_, i) => ({ x: cx + r * Math.cos(i / 12 * Math.PI), y: cy + r * Math.sin(i / 12 * Math.PI) })), box.pts);
}

function holeProblem(box, depth, spec) {
  if (!(spec.diameter > 0)) return "Enter a diameter above 0 mm";
  if (!Number.isFinite(spec.x) || !Number.isFinite(spec.y)) return "Enter where the hole goes";
  if (spec.kind === "blind" && !(spec.depth > 0)) return "Enter a depth above 0 mm";
  if (spec.kind === "blind" && depth && spec.depth >= depth) return `Deeper than the part (${fmt(depth)} mm). Choose Through`;
  if (spec.kind === "counterbore" && !(spec.cbDiameter > spec.diameter)) return "The counterbore must be wider than the hole";
  if (spec.kind === "counterbore" && !(spec.cbDepth > 0 && (!depth || spec.cbDepth < depth))) return "Enter a counterbore depth inside the part";
  if (spec.kind === "countersink" && !(spec.cskDiameter > spec.diameter)) return "The countersink must be wider than the hole";
  if (!holeFits(box, spec)) return "The hole breaks out of the profile's edge";
  return null;
}

// The holes a pattern adds beside the first one. Row: count holes, spacing apart, in a direction.
// Circle: count holes evenly round the profile's centre, through the first hole.
const DIRECTIONS = { right: [1, 0], left: [-1, 0], up: [0, 1], down: [0, -1] };
function patternCopies(box, spec, pattern) {
  if (!pattern || pattern.count < 2) return [];
  const ks = Array.from({ length: pattern.count - 1 }, (_, i) => i + 1);
  if (pattern.mode === "row") {
    const [dx, dy] = DIRECTIONS[pattern.dir];
    return ks.map(k => ({ ...spec, x: r2(spec.x + dx * k * pattern.spacing), y: r2(spec.y + dy * k * pattern.spacing) }));
  }
  const cx = (box.maxX - box.minX) / 2, cy = (box.maxY - box.minY) / 2;
  const R = Math.hypot(spec.x - cx, spec.y - cy), a0 = Math.atan2(spec.y - cy, spec.x - cx);
  return ks.map(k => ({ ...spec, x: r2(cx + R * Math.cos(a0 + 2 * Math.PI * k / pattern.count)), y: r2(cy + R * Math.sin(a0 + 2 * Math.PI * k / pattern.count)) }));
}
const pitchDiameter = (box, spec) => 2 * Math.hypot(spec.x - (box.maxX - box.minX) / 2, spec.y - (box.maxY - box.minY) / 2);

function patternProblem(box, spec, pattern) {
  if (!(Number.isInteger(pattern.count) && pattern.count >= 1 && pattern.count <= 50)) return "Enter a count from 1 to 50";
  if (pattern.mode === "row" && pattern.count > 1 && !(pattern.spacing > 0)) return "Enter a spacing above 0 mm";
  if (pattern.mode === "circle" && pitchDiameter(box, spec) < spec.diameter) return "The hole sits on the profile's centre. Move it out to repeat it round";
  const bad = patternCopies(box, spec, pattern).findIndex(c => !holeFits(box, c));
  return bad >= 0 ? `Hole ${bad + 2} breaks out of the profile's edge` : null;
}

// Where a hole lands on the drawing: centre and radius in scene px.
function holeOnSheet(f, box, spec) {
  const X = box.minX + spec.x, Y = box.minY + spec.y, c = f.toPx([X, Y]);
  const k = (Math.abs(f.toPx([X + 1, Y]).x - c.x) + Math.abs(f.toPx([X, Y + 1]).y - c.y)) / 2;
  return { c, r: spec.diameter / 2 * k, k };
}

// A hole's circle plus its blue notes: a centre mark and, on the first hole of a pattern or a lone hole,
// its distances from the profile's left and bottom edges and a callout.
function holeElements(f, profile, box, spec, { circle, gid, first, count = 1, extra = "" }) {
  const { c, r } = holeOnSheet(f, box, spec);
  const partGid = profile.groupIds.find(g => g.startsWith("part-"));
  const groupIds = partGid ? [gid, partGid] : [gid];
  const base = circle || convertToExcalidrawElements([{ type: "ellipse", x: 0, y: 0, width: 1, height: 1, strokeColor: INK, strokeWidth: 1.5 }])[0];
  const { pattern, copyOf, ...was } = base.customData?.part || {};
  const hole = bump({ ...base, x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r, angle: 0, groupIds,
    backgroundColor: PAPER, fillStyle: "solid", customData: { ...(base.customData || {}), part: { ...was, hole: true, of: profile.id, spec } } });
  const m = r + 6, sk = [
    { type: "line", x: c.x - m, y: c.y, points: [[0, 0], [2 * m, 0]], strokeColor: BLUE, strokeWidth: 1 },
    { type: "line", x: c.x, y: c.y - m, points: [[0, 0], [0, 2 * m]], strokeColor: BLUE, strokeWidth: 1 },
  ];
  if (first) {
    const left = f.toPx([box.minX, box.minY + spec.y]).x, bottom = f.toPx([box.minX + spec.x, box.minY]).y;
    if (c.x - left > 12) sk.push(
      { type: "arrow", x: left, y: c.y, points: [[0, 0], [c.x - left, 0]], startArrowhead: "bar", endArrowhead: "bar", strokeColor: BLUE, strokeWidth: 1 },
      { type: "text", x: (left + c.x) / 2 - 10, y: c.y - 19, text: fmt(spec.x), fontSize: 12, strokeColor: BLUE });
    if (bottom - c.y > 12) sk.push(
      { type: "arrow", x: c.x, y: c.y, points: [[0, 0], [0, bottom - c.y]], startArrowhead: "bar", endArrowhead: "bar", strokeColor: BLUE, strokeWidth: 1 },
      { type: "text", x: c.x + 5, y: (c.y + bottom) / 2 - 7, text: fmt(spec.y), fontSize: 12, strokeColor: BLUE });
    const e = { x: c.x + r * Math.SQRT1_2, y: c.y - r * Math.SQRT1_2 };
    const text = holeCallout(spec, count) + extra;
    sk.push({ type: "line", x: e.x, y: e.y, points: [[0, 0], [24, -24]], strokeColor: BLUE, strokeWidth: 1 },
      { type: "text", x: e.x + 28, y: e.y - 26 - 17 * text.split("\n").length, text, fontSize: 14, strokeColor: BLUE });
  }
  const notes = convertToExcalidrawElements(sk).map(n => ({ ...n, groupIds, customData: { note: "hole", of: hole.id } }));
  return { hole, notes };
}

// Writes a hole and its pattern into the scene, replacing the hole's earlier circle, copies and notes.
// With spec null the hole and its copies are deleted.
function writeHole(api, profile, existing, spec, pattern) {
  const els = api.getSceneElements();
  const old = existing ? live(api).filter(el => el.id === existing.id || holeOf(el)?.copyOf === existing.id) : [];
  const oldIds = new Set(old.map(el => el.id));
  const rest = els.filter(el => !oldIds.has(el.id) && !(el.customData?.note === "hole" && oldIds.has(el.customData.of))
    && !(el.customData?.dim && oldIds.has(el.customData.dim.target)));
  const dimGroups = new Set(els.filter(el => el.customData?.dim && oldIds.has(el.customData.dim.target)).flatMap(el => el.groupIds));
  const kept = rest.filter(el => !(el.customData?.note === "dim" && el.groupIds.some(g => dimGroups.has(g))));
  if (!spec) return commit(api, kept);

  const f = sheetFrame(kept), box = profileBox(f, profile);
  const copies = patternCopies(box, spec, pattern), count = copies.length + 1;
  const gid = existing?.groupIds.find(g => g.startsWith("hole-")) || "hole-" + rnd();
  const extra = pattern?.mode === "circle" && count > 1 ? `\nEQ SP on Ø${fmt(pitchDiameter(box, spec))}` : "";
  const main = holeElements(f, profile, box, spec, { circle: existing, gid, first: true, count, extra });
  main.hole.customData.part = { ...main.hole.customData.part, ...(count > 1 ? { pattern } : {}) };
  const made = copies.map(cs => {
    const m = holeElements(f, profile, box, cs, { gid });
    m.hole.customData.part = { ...m.hole.customData.part, copyOf: main.hole.id };
    return m;
  });
  // A circular pattern shows its pitch circle; a row shows the spacing between its first two holes.
  const extraNotes = [];
  if (count > 1 && pattern.mode === "circle") {
    const cpx = f.toPx([box.minX + (box.maxX - box.minX) / 2, box.minY + (box.maxY - box.minY) / 2]);
    const R = pitchDiameter(box, spec) / 2 * holeOnSheet(f, box, spec).k;
    extraNotes.push({ type: "ellipse", x: cpx.x - R, y: cpx.y - R, width: 2 * R, height: 2 * R, strokeColor: BLUE, strokeWidth: 1, strokeStyle: "dashed", backgroundColor: "transparent" });
  } else if (count > 1) {
    const a = holeOnSheet(f, box, spec), b = holeOnSheet(f, box, copies[0]);
    const [dx, dy] = DIRECTIONS[pattern.dir], off = a.r + 18;
    const o = { x: dy ? off : 0, y: dx ? off : 0 };
    extraNotes.push(
      { type: "arrow", x: a.c.x + o.x, y: a.c.y + o.y, points: [[0, 0], [b.c.x - a.c.x, b.c.y - a.c.y]], startArrowhead: "bar", endArrowhead: "bar", strokeColor: BLUE, strokeWidth: 1 },
      { type: "text", x: (a.c.x + b.c.x) / 2 + o.x + (dy ? 5 : -10), y: (a.c.y + b.c.y) / 2 + o.y + (dx ? 4 : -7), text: fmt(pattern.spacing), fontSize: 12, strokeColor: BLUE });
  }
  const patternNotes = convertToExcalidrawElements(extraNotes).map(n => ({ ...n, groupIds: main.hole.groupIds, customData: { note: "hole", of: main.hole.id } }));
  const at = kept.findIndex(el => el.id === profile.id);
  const holes = [main.hole, ...made.map(m => m.hole)];
  commit(api, [...kept.slice(0, at + 1), ...holes, ...kept.slice(at + 1), ...main.notes, ...made.flatMap(m => m.notes), ...patternNotes]);
}

// A plain circle drawn inside a profile, read as a through hole so the Hole and Pattern tools can take it over.
function specFromCircle(f, box, circle) {
  const [x, y] = f.P(centreOf(circle));
  const dia = f.dims.find(d => d.target === circle.id && d.kind === "diameter");
  const [l] = f.P({ x: circle.x, y: 0 }), [r] = f.P({ x: circle.x + circle.width, y: 0 });
  return { kind: "through", diameter: dia ? dia.mm : Math.round((r - l) * 10) / 10, x: Math.round((x - box.minX) * 10) / 10, y: Math.round((y - box.minY) * 10) / 10 };
}

// ---- Bolt circle on a revolved part: holes parallel to the axis on a pitch circle, through all. ----

// Where the infinite line o + u·t passes through a closed outline: [[t in, t out], ...].
function chords(poly, o, u) {
  const ts = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q.x - p.x, ey = q.y - p.y, den = u.x * ey - u.y * ex;
    if (Math.abs(den) < 1e-9) continue;
    const w = ((p.x - o.x) * u.y - (p.y - o.y) * u.x) / den;
    if (w >= 0 && w < 1) ts.push(((p.x - o.x) * ey - (p.y - o.y) * ex) / den);
  }
  ts.sort((a, b) => a - b);
  return ts.reduce((out, t, i) => i % 2 ? [...out.slice(0, -1), [out[out.length - 1][0], t]] : [...out, [t]], []).filter(c => c.length === 2);
}

// The revolved profile's axis and reach in mm: how far its material sits from the axis.
function revolveFrame(f, profile) {
  const axis = f.byId.get(profile.customData.part.axis);
  if (!axis) return null;
  const [a, b] = [axis.points[0], axis.points[axis.points.length - 1]].map(([px, py]) => f.P({ x: axis.x + px, y: axis.y + py })).map(([x, y]) => ({ x, y }));
  const len = dist(a, b), u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const box = profileBox(f, profile);
  const side = p => (p.x - a.x) * -u.y + (p.y - a.y) * u.x;
  const sign = Math.sign(box.pts.reduce((t, p) => t + side(p), 0)) || 1;
  const n = { x: -u.y * sign, y: u.x * sign };
  const reach = box.pts.map(p => Math.abs(side(p)));
  return { a, u, n, box, minR: Math.min(...reach), maxR: Math.max(...reach) };
}

function boltProblem(rf, bolts) {
  if (!(Number.isInteger(bolts.count) && bolts.count >= 1 && bolts.count <= 50)) return "Enter a count from 1 to 50";
  if (!(bolts.diameter > 0)) return "Enter a hole diameter above 0 mm";
  if (!(bolts.pcd > 0)) return "Enter a pitch circle diameter above 0 mm";
  if (bolts.pcd / 2 + bolts.diameter / 2 > rf.maxR + 0.01) return `The holes break out of the outside (Ø${fmt(2 * rf.maxR)})`;
  if (bolts.pcd / 2 - bolts.diameter / 2 < rf.minR - 0.01) return `The holes break into the bore (Ø${fmt(2 * rf.minR)})`;
  const o = { x: rf.a.x + rf.n.x * bolts.pcd / 2, y: rf.a.y + rf.n.y * bolts.pcd / 2 };
  if (!chords(rf.box.pts, o, rf.u).length) return "There is no material on that pitch circle";
  return null;
}

// Stores the bolt circle on the profile and draws the holes as they cut the section:
// a blue centre line on the pitch circle and dashed hole edges, only where there is material.
function writeBolts(api, profile, bolts) {
  const els = api.getSceneElements();
  const kept = els.filter(el => !(el.customData?.note === "bolts" && el.customData.of === profile.id));
  const { boltCircle, ...part } = profile.customData.part;
  const marked = bump({ ...profile, customData: { ...profile.customData, part: bolts ? { ...part, boltCircle: bolts } : part } });
  const next = kept.map(el => el.id === profile.id ? marked : el);
  if (!bolts) return commit(api, next);
  const f = sheetFrame(next), rf = revolveFrame(f, marked);
  const sk = [];
  for (const [r, centre] of [[bolts.pcd / 2, true], [(bolts.pcd - bolts.diameter) / 2, false], [(bolts.pcd + bolts.diameter) / 2, false]]) {
    const o = { x: rf.a.x + rf.n.x * r, y: rf.a.y + rf.n.y * r };
    for (const [t0, t1] of chords(rf.box.pts, o, rf.u)) {
      const ext = centre ? 3 : 0;   // a centre line runs a little past the material
      const p = f.toPx([o.x + rf.u.x * (t0 - ext), o.y + rf.u.y * (t0 - ext)]), q = f.toPx([o.x + rf.u.x * (t1 + ext), o.y + rf.u.y * (t1 + ext)]);
      sk.push({ type: "line", x: p.x, y: p.y, points: [[0, 0], [q.x - p.x, q.y - p.y]], strokeStyle: "dashed", strokeWidth: 1, strokeColor: centre ? BLUE : INK });
    }
  }
  const b = bounds(outline(profile).pts);
  sk.push({ type: "text", x: b.maxX + 16, y: b.minY, text: `${bolts.count}× Ø${fmt(bolts.diameter)} THRU\nEQ SP on Ø${fmt(bolts.pcd)}`, fontSize: 14, strokeColor: BLUE });
  const partGid = profile.groupIds.find(g => g.startsWith("part-"));
  const notes = convertToExcalidrawElements(sk).map(n => ({ ...n, groupIds: partGid ? [partGid] : [], customData: { note: "bolts", of: profile.id } }));
  commit(api, [...next, ...notes]);
}

// ---- partSketch: the drawing as a part, in mm with Y up. This is what the laptop builds from. ----
//   { units, mmPerPx, scaleFrom, features: [{ type: "extrude" | "revolve" | "boss" | "pocket", depth | angle | height,
//     on (boss, pocket: the profile it sits on), edge ({kind, size}: top edges), axis, profile, holes, boltCircle }],
//     dimensions, conflicts, other, notes }
// Shapes: { type: "rect", center, width, height, corners? } · { type: "circle", center, diameter }
//         { type: "ellipse", center, rx, ry } · { type: "polygon" | "polyline", points, edgeDims, corners? }
//         corners: [{ at: [x, y], kind: "fillet" | "chamfer", size }] from the Round tool
// Holes:  { type: "hole", kind, center, diameter, depth? | cbDiameter, cbDepth? | cskDiameter, cskAngle? }
//         (pattern copies are listed as holes of their own), or a drawn shape cut through.
// boltCircle: { count, diameter, pcd }, holes parallel to the axis, through all, the first in the sketch plane.
function partSketch(elements) {
  const f = sheetFrame(elements);
  const { els, s, byId, dims, profiles, geometry, P } = f;
  const dimsFor = id => dims.filter(d => d.target === id);
  // Corners made with Round, as {at: corner in mm, kind: fillet | chamfer, size}
  const cornersOf = el => {
    const o = outline(el), cs = (el.customData?.corners || []).filter(c => o?.pts[c.i]);
    return cs.length ? { corners: cs.map(c => ({ at: P(o.pts[c.i]), kind: c.kind, size: c.size })) } : {};
  };

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
        ? { type: "rect", center: centre, width: r2(x2 - x1), height: r2(y2 - y1), ...cornersOf(el) }
        : { type: "ellipse", center: centre, rx: r2((x2 - x1) / 2), ry: r2((y2 - y1) / 2) };
    }
    return { type: o.closed ? "polygon" : "polyline", points: o.pts.map(P), edgeDims: d.map(k => ({ edge: k.edge, mm: k.mm })), ...(o.closed ? cornersOf(el) : {}) };
  };
  const hole = el => {
    const { spec, of } = holeOf(el);
    const owner = spec && byId.get(of);
    if (!owner) return shape(el);
    const box = profileBox(f, owner), { kind, diameter, x, y, ...more } = spec;
    return { type: "hole", kind, center: [r2(box.minX + x), r2(box.minY + y)], diameter, ...more, ...(kind === "countersink" ? { cskAngle: 90 } : {}) };
  };

  const features = profiles.map(el => {
    const part = el.customData.part;
    const holes = els.filter(h => holeOf(h)?.of === el.id).map(hole);
    if (part.feature === "revolve") {
      const axis = byId.get(part.axis);
      const ends = axis ? [axis.points[0], axis.points[axis.points.length - 1]].map(([px, py]) => P({ x: axis.x + px, y: axis.y + py })) : null;
      return { id: el.id, type: "revolve", angle: part.angleDeg, axis: ends, profile: shape(el), holes, ...(part.boltCircle ? { boltCircle: part.boltCircle } : {}) };
    }
    const edge = part.topEdge ? { edge: part.topEdge } : {};
    if (part.feature === "boss") return { id: el.id, type: "boss", on: part.on, height: part.heightMm, profile: shape(el), holes, ...edge };
    if (part.feature === "pocket") return { id: el.id, type: "pocket", on: part.on, depth: part.depthMm, profile: shape(el), holes };
    return { id: el.id, type: "extrude", depth: part.depthMm, profile: shape(el), holes, ...edge };
  });

  const used = new Set([...profiles.map(el => el.id), ...els.filter(el => profiles.some(p => p.id === holeOf(el)?.of)).map(el => el.id)]);
  return {
    units: "mm",
    mmPerPx: r2(s * 1000) / 1000,
    scaleFrom: dims.length ? "dimensions" : "default",
    features,
    dimensions: dims.map(d => ({ target: d.target, kind: d.kind, edge: d.edge, mm: d.mm })),
    conflicts: f.conflicts.map(d => ({ target: d.target, edge: d.edge, mm: d.mm })),
    other: geometry.filter(el => !used.has(el.id)).map(el => ({ id: el.id, role: holeOf(el) ? "hole" : el.strokeStyle === "dashed" ? "centre line" : "sketch", ...(holeOf(el) ? hole(el) : shape(el)) })),
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

// Mirror: reflect shapes across the nearest centre line, or across their right edge when none is drawn.
// The copy keeps every style of the original. An open outline whose two ends sit on the centre line
// becomes one closed, symmetric outline, so half a part can be drawn and mirrored into a whole one.
const STYLE = ["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "roundness"];
function mirrorShapes(api, targets, flash, chosen) {
  const b = bounds(targets.flatMap(el => outline(el).pts)), mid = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  const axis = chosen || live(api).filter(el => isCentreLine(el) && !targets.includes(el))
    .sort((p, q) => segDist(mid, ...lineEnds(p)) - segDist(mid, ...lineEnds(q)))[0];
  const [a, e] = axis ? lineEnds(axis) : [{ x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }];
  const d = { x: e.x - a.x, y: e.y - a.y }, len = Math.hypot(d.x, d.y);
  const onAxis = p => Math.abs((p.x - a.x) * d.y - (p.y - a.y) * d.x) / len <= 10;
  const level = Math.abs(d.x) < 0.01 * len || Math.abs(d.y) < 0.01 * len;   // the axis is upright or level
  const styleOf = el => Object.fromEntries(STYLE.map(k => [k, el[k]]));
  const made = [], joined = new Map();
  for (const el of targets) {
    const o = outline(el);
    if (el.type === "line" && !o.closed && o.pts.length >= 3 && onAxis(o.pts[0]) && onAxis(o.pts[o.pts.length - 1])) {
      const foot = p => { const m = reflect(p, a, d); return { x: (p.x + m.x) / 2, y: (p.y + m.y) / 2 }; };
      const half = [foot(o.pts[0]), ...o.pts.slice(1, -1), foot(o.pts[o.pts.length - 1])];
      joined.set(el.id, reshape(el, dropStraight([...half, ...half.slice(1, -1).reverse().map(p => reflect(p, a, d))], 1), true));
    } else if (["rectangle", "diamond", "ellipse"].includes(el.type) && (isRound(el) || (level && !el.angle))) {
      const c = reflect(centreOf(el), a, d);
      made.push({ type: el.type, x: c.x - el.width / 2, y: c.y - el.height / 2, width: el.width, height: el.height });
    } else {
      made.push(polyline(o.pts.map(p => reflect(p, a, d)), o.closed, {}));
    }
  }
  const sources = targets.filter(el => !joined.has(el.id));
  const copies = convertToExcalidrawElements(made).map((m, i) => ({ ...m, ...styleOf(sources[i]) }));
  commit(api, [...api.getSceneElements().map(el => joined.get(el.id) || el), ...copies]);
  const what = joined.size ? "Mirrored into a closed outline" : targets.length > 1 ? `Mirrored ${targets.length} items` : "Mirrored";
  flash(what + (axis ? "" : " across its right edge"));
}

// New lines are tidied as soon as they are finished: each segment within 6° of level, upright or 45°
// is squared, open ends join a nearby corner of another shape, and a line that ends near its start is closed.
// Lines made by the tools are already clean and are skipped (see commit).
function tidyLine(api, el) {
  const anchors = live(api).filter(x => x.id !== el.id && !isNote(x) && x.type !== "freedraw" && x.type !== "ellipse" && outline(x)).flatMap(x => outline(x).pts);
  const join = p => {
    let best = p, bestD = 10;
    for (const q of anchors) { const dd = dist(q, p); if (dd < bestD) { bestD = dd; best = q; } }
    return best;
  };
  let { pts, closed } = outline(el);
  const b = bounds(pts), size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  if (!closed && pts.length >= 4 && dist(pts[0], pts[pts.length - 1]) <= Math.max(14, 0.08 * size)) { pts = pts.slice(0, -1); closed = true; }
  const q = squarePath(pts, closed, join);
  const same = q.length === pts.length && q.every((p, i) => dist(p, pts[i]) < 0.01) && closed === outline(el).closed;
  return same ? null : reshape(el, q, closed);
}

// ---- Round: a corner of a straight-sided outline rounded (fillet) or cut off (chamfer). ----
// Stored on the outline as customData.corners = [{ i: corner index, kind, size in mm }], with a blue
// R or C note by each corner. A rectangle cut-out with its corners rounded to half its width is a slot.

// The biggest size the picked corners take, in mm: a corner's sides limit it, halved when the corner at a
// side's other end is rounded too, and a fillet in a sharp corner needs room for its tangents.
function cornerLimit(f, el, picked, kind) {
  const pts = outline(el).pts.map(f.P), n = pts.length;
  const rounded = new Set([...(el.customData?.corners || []).map(c => c.i), ...picked]);
  return Math.min(...picked.map(i => {
    const [a, b, c] = [pts[(i - 1 + n) % n], pts[(i + 1) % n], pts[i]];
    const u = [a[0] - c[0], a[1] - c[1]], v = [b[0] - c[0], b[1] - c[1]];
    const side = Math.min(Math.hypot(...u) / (rounded.has((i - 1 + n) % n) ? 2 : 1), Math.hypot(...v) / (rounded.has((i + 1) % n) ? 2 : 1));
    const angle = Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v)))));
    return side * (kind === "fillet" ? Math.tan(angle / 2) : 1);
  }));
}

function writeCorners(api, el, corners) {
  const o = outline(el), c = o.pts.reduce((t, q) => ({ x: t.x + q.x / o.pts.length, y: t.y + q.y / o.pts.length }), { x: 0, y: 0 });
  const partGid = el.groupIds.find(g => g.startsWith("part-"));
  const notes = convertToExcalidrawElements(corners.filter(k => o.pts[k.i]).map(k => {
    const q = o.pts[k.i], d = Math.hypot(q.x - c.x, q.y - c.y) || 1;
    return { type: "text", x: q.x + (q.x - c.x) / d * 16 - 10, y: q.y + (q.y - c.y) / d * 16 - 8,
      text: `${k.kind === "fillet" ? "R" : "C"}${fmt(k.size)}`, fontSize: 12, strokeColor: BLUE };
  })).map(n => ({ ...n, groupIds: partGid ? [partGid] : [], customData: { note: "corner", of: el.id } }));
  const kept = api.getSceneElements().filter(x => !(x.customData?.note === "corner" && x.customData.of === el.id));
  commit(api, [...kept.map(x => x.id === el.id ? bump({ ...x, customData: { ...(x.customData || {}), corners } }) : x), ...notes]);
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

// The sidebar follows the order of the work: sketch the outline, size it, then make it a part.
// Each tool works on what is selected when that fits; otherwise it waits for a tap on the drawing (its mode).
const SECTIONS = [
  { title: "Sketch", items: [
    { label: "Centre line", icon: "Minus", mode: "centre" },
    { label: "Mirror", icon: "Mirror", mode: "mirror" },
  ] },
  { title: "Measure", items: [
    { label: "Dimension", icon: "Frame2", mode: "dim" },
  ] },
  { title: "Part", items: [
    { label: "Profile", icon: "Layers", mode: "profile" },
    { label: "Round", icon: "Frame", mode: "round" },
    { label: "Hole", icon: "Crosshairs", mode: "hole" },
    { label: "Pattern", icon: "Category", mode: "pattern" },
  ] },
];

const PICK_HINTS = {
  centre: "Draw the centre line",
  mirror: "Tap the shape to mirror",
  profile: "Tap inside the outline to make it a part, or a shape on a part for a boss or pocket",
  round: "Tap a corner to round or chamfer it",
  dim: "Tap an edge or a circle to dimension it",
  hole: "Tap inside a profile where the hole goes",
  pattern: "Tap a hole to repeat it, or a revolved profile for bolt holes",
};

// Small form pieces shared by the dialogs. They live outside App so a re-render keeps the field being typed in.
const Dialog = ({ label, onSubmit, onClose, children, actions }) => (
  <div className="eng-dialog-wrap" onClick={onClose}>
    <form className="eng-dialog" role="dialog" aria-label={label} onClick={e => e.stopPropagation()}
      onSubmit={e => { e.preventDefault(); onSubmit(); }}>
      <h2>{label}</h2>
      {children}
      <div className="eng-dialog-actions">{actions}</div>
    </form>
  </div>
);
const Num = ({ label, value, onChange, autoFocus }) => (
  <label>{label}
    <input type="number" inputMode="decimal" min="0" step="any" value={value} autoFocus={autoFocus}
      onFocus={e => e.target.select()} onChange={e => onChange(e.target.value)} />
  </label>
);
const Seg = ({ label, options, value, onChange }) => (
  <div className="eng-seg" role="radiogroup" aria-label={label}>
    {Object.entries(options).map(([k, text]) => (
      <button key={k} type="button" role="radio" aria-checked={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>{text}</button>
    ))}
  </div>
);

function App() {
  const [api, setApi] = useState(null);
  const [gridOn, setGridOn] = useState(true);
  const [empty, setEmpty] = useState(true);       // nothing drawn yet: show how to start
  const [link, setLink] = useState({ state: "offline", text: "Connecting" });   // whether the laptop has the latest drawing
  const bridgeRef = useRef(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const [dialog, setDialog] = useState(null);     // the open dialog: dim, part, hole, pattern or bolts
  const [picking, setPicking] = useState(null);   // the tool waiting for a tap: "dim", "hole" or "pattern"
  const pickingRef = useRef(null);
  const lastHole = useRef({ kind: "through", diameter: "6" });   // a new hole starts like the last one
  const seenStrokes = useRef(new Set());   // freedraw ids already seen in onChange
  const activeStroke = useRef(null);       // the freedraw stroke being drawn now
  const holdPending = useRef(null);        // "held" when a pen lifts after being still, "lift" otherwise
  const [autoSnap, setAutoSnap] = useState(true);   // snap lines, arcs, circles and rectangles on lift
  const pressAt = useRef(null);            // where and when the current pen press went still

  // Every tool reports through here. kind is "ok" or "warn" (the tool could not run).
  // A sticky toast stays until replaced and offers Cancel for the tool waiting for a tap.
  const flash = (text, kind = "ok", sticky = false) => {
    setToast({ id: Date.now(), text, kind, sticky });
    clearTimeout(toastTimer.current);
    if (!sticky) toastTimer.current = setTimeout(() => setToast(t => t && { ...t, leaving: true }), 2800);
  };

  const setPick = mode => {
    if (pickingRef.current === "centre" && !mode) api?.setActiveTool({ type: "selection" });
    if (mode === "centre") api.setActiveTool({ type: "line" });   // Centre line waits for a drawn line, not a tap
    pickingRef.current = mode;
    setPicking(mode);
    if (mode) flash(PICK_HINTS[mode], "ok", true);
    else setToast(t => t?.sticky ? null : t);
  };

  // The tap a waiting tool was waiting for. It never reaches Excalidraw.
  const pickTap = e => {
    const mode = pickingRef.current, s = api.getAppState();
    const p = viewportCoordsToSceneCoords(e, s), tol = 16 / s.zoom.value;
    setPick(null);
    if (mode === "dim") pickDimension(p, tol);
    else if (mode === "hole") pickHole(p, tol);
    else if (mode === "pattern") pickPattern(p, tol);
    else if (mode === "mirror") pickMirror(p, tol);
    else if (mode === "round") pickRound(p, tol);
    else pickProfile(p, tol);
  };

  const pickMirror = (p, tol) => {
    const hit = pickAt(api.getSceneElements(), p, tol);
    const el = hit?.el || partAt(p, tol)?.profile;
    if (!el) return flash("Nothing to mirror there. Tap a shape or its edge", "warn");
    mirrorShapes(api, [el], flash);
  };

  // A shape drawn inside a part can be a boss on it or a pocket in it: base is the smallest flat-topped part round it.
  const openPart = plan => {
    const el = plan.outers[0].el, was = el.customData?.part, pts = outline(el).pts;
    const base = closedShapes(live(api)).filter(o => o.id !== el.id && SOLID.includes(o.customData?.part?.feature) && within(pts, outline(o).pts))
      .sort((a, b) => area(outline(a).pts) - area(outline(b).pts))[0] || null;
    const mode = was?.feature && (base || !["boss", "pocket"].includes(was.feature)) ? was.feature : base ? "boss" : plan.axis ? "revolve" : "extrude";
    setDialog({ type: "part", plan, base, mode, depth: fmt(was?.depthMm ?? was?.heightMm ?? (base ? 5 : 10)), angle: fmt(was?.angleDeg ?? 360),
      edgeKind: was?.topEdge?.kind || "none", edgeSize: fmt(was?.topEdge?.size ?? 1) });
  };

  const pickRound = (p, tol) => {
    let best = null;
    for (const el of closedShapes(live(api)).filter(el => el.type !== "ellipse" && el.type !== "freedraw")) {
      outline(el).pts.forEach((q, i) => { const d = dist(p, q); if (d <= 1.5 * tol && (!best || d < best.d)) best = { d, el, i }; });
    }
    if (!best) return flash("Tap a corner of a straight-sided outline. Snap a pen stroke first", "warn");
    const was = best.el.customData?.corners?.find(c => c.i === best.i);
    setDialog({ type: "round", el: best.el, corner: best.i, kind: was?.kind || "fillet", size: fmt(was?.size ?? 5), scope: "one", had: !!was });
  };

  const pickProfile = (p, tol) => {
    const hit = partAt(p, tol, true);
    if (!hit) return flash("Tap inside a closed outline: a shape, or a line or stroke that ends where it started", "warn");
    openPart(planPart(api, [hit.profile], null));
  };

  const pickDimension = (p, tol) => {
    const hit = pickAt(api.getSceneElements(), p, tol);
    if (!hit) return flash("Nothing to dimension there. Tap closer to a line or circle", "warn");
    if (hit.el && holeOf(hit.el)?.spec) return flash("Change this hole's size with the Hole tool", "warn");
    if (hit.editing) {
      const dim = hit.editing.customData.dim;
      const el = live(api).find(x => x.id === dim.target);
      if (!el) return flash("That dimension's shape was deleted", "warn");
      return setDialog({ type: "dim", pick: { el, kind: dim.kind, edge: dim.edge, replaces: hit.editing.groupIds[0], scale: dim.scale }, value: fmt(dim.mm) });
    }
    const drawn = measure(hit.el, hit) * mmPerPx(api.getSceneElements());
    setDialog({ type: "dim", pick: hit, value: fmt(Math.round(drawn * 2) / 2) });
  };

  // What a tap on the drawing lands in: a hole (or a circle drawn inside an outline) and its profile,
  // or else the smallest part round the tap, or the largest outline when nothing there is a part yet.
  // forProfile: a shape drawn on a part, plain cut-outs included, is picked itself, to become a boss or pocket.
  const partAt = (p, tol, forProfile = false) => {
    const els = live(api), byId = new Map(els.map(el => [el.id, el]));
    const outlines = closedShapes(els).filter(el => !holeOf(el) || (forProfile && !holeOf(el).spec));
    const isPart = el => [...SOLID, "pocket"].includes(el.customData?.part?.feature);
    if (forProfile) {
      const all = outlines.filter(o => inside(p, outline(o).pts)).sort((a, b) => area(outline(b).pts) - area(outline(a).pts));
      return all.length ? { profile: isPart(all[0]) ? all[all.length - 1] : all[0] } : null;
    }
    const around = q => outlines.filter(o => inside(q, outline(o).pts)).sort((a, b) => area(outline(b).pts) - area(outline(a).pts));
    const circle = els.find(el => isRound(el) && dist(p, centreOf(el)) <= el.width / 2 + tol && (holeOf(el) || around(centreOf(el)).some(o => o.id !== el.id)));
    if (circle) {
      const first = byId.get(holeOf(circle)?.copyOf) || circle;
      const profile = byId.get(holeOf(first)?.of) || around(centreOf(first)).find(o => o.id !== first.id);
      if (profile) return { hole: first, profile };
    }
    const profile = [...around(p)].reverse().find(isPart) || around(p)[0];
    return profile ? { profile } : null;
  };

  const holeDialog = (profile, hole, spec) => {
    const st = v => v === undefined ? "" : fmt(v);
    const d = parseFloat(spec.diameter) || 6;
    setDialog({ type: "hole", profile, hole, kind: spec.kind, diameter: st(d), x: st(spec.x), y: st(spec.y),
      depth: st(spec.depth ?? d * 1.5), cbDiameter: st(spec.cbDiameter ?? Math.round(d * 1.8)), cbDepth: st(spec.cbDepth ?? Math.round(d * 0.6 * 2) / 2),
      cskDiameter: st(spec.cskDiameter ?? d * 2), pattern: holeOf(hole || {})?.pattern || null });
  };

  const pickHole = (p, tol) => {
    const hit = partAt(p, tol);
    if (!hit) return flash("Tap inside a closed outline to put a hole in it", "warn");
    if (hit.profile.customData?.part?.feature === "revolve") return flash("Holes go in extruded profiles. For a flange's bolt holes, use Pattern", "warn");
    const f = sheetFrame(api.getSceneElements()), box = profileBox(f, hit.profile);
    if (hit.hole) return holeDialog(hit.profile, hit.hole, holeOf(hit.hole)?.spec || specFromCircle(f, box, hit.hole));
    const [x, y] = f.P(p);
    holeDialog(hit.profile, null, { ...lastHole.current, x: Math.round((x - box.minX) * 2) / 2, y: Math.round((y - box.minY) * 2) / 2 });
  };

  const pickPattern = (p, tol) => {
    const hit = partAt(p, tol);
    if (hit?.hole) {
      if (hit.profile.customData?.part?.feature === "revolve") return flash("For a revolved part, tap the profile for bolt holes", "warn");
      const f = sheetFrame(api.getSceneElements()), box = profileBox(f, hit.profile);
      const spec = holeOf(hit.hole)?.spec || specFromCircle(f, box, hit.hole);
      // A new pattern starts with the longest row that fits, spaced 2.5 hole diameters.
      const spacing = Math.max(5, Math.ceil(spec.diameter * 2.5 / 5) * 5);
      const tries = [4, 3, 2].flatMap(count => ["right", "down", "left", "up"].map(dir => ({ mode: "row", count, spacing, dir })));
      const pattern = holeOf(hit.hole)?.pattern || tries.find(t => !patternProblem(box, spec, t)) || tries[0];
      return setDialog({ type: "pattern", ...hit, mode: pattern.mode, count: String(pattern.count), spacing: fmt(pattern.spacing ?? 10), dir: pattern.dir || "right" });
    }
    if (hit?.profile.customData?.part?.feature === "revolve") {
      const rf = revolveFrame(sheetFrame(api.getSceneElements()), hit.profile);
      if (!rf) return flash("This revolve's centre line was deleted. Mark the profile again", "warn");
      const b = hit.profile.customData.part.boltCircle;
      const d = b?.diameter ?? Math.max(2, Math.round((rf.maxR - rf.minR) / 4));
      return setDialog({ type: "bolts", profile: hit.profile, count: String(b?.count ?? 6), diameter: fmt(d), pcd: fmt(b?.pcd ?? Math.round(2 * (rf.maxR - d))) });
    }
    flash("Tap a hole to repeat it, or a revolved profile for bolt holes", "warn");
  };

  // Hole dialog values as a spec, keeping only the fields its kind uses.
  const holeSpec = d => {
    const n = k => parseFloat(d[k]);
    const spec = { kind: d.kind, diameter: n("diameter"), x: n("x"), y: n("y") };
    if (d.kind === "blind") spec.depth = n("depth");
    if (d.kind === "counterbore") Object.assign(spec, { cbDiameter: n("cbDiameter"), cbDepth: n("cbDepth") });
    if (d.kind === "countersink") spec.cskDiameter = n("cskDiameter");
    return spec;
  };
  const patternOf = d => ({ mode: d.mode, count: parseInt(d.count, 10), spacing: parseFloat(d.spacing), dir: d.dir });
  const boltsOf = d => ({ count: parseInt(d.count, 10), diameter: parseFloat(d.diameter), pcd: parseFloat(d.pcd) });

  // What is wrong with the open dialog's values, shown under the fields; Set stays off until it is fixed.
  const problem = (() => {
    if (!dialog || !api) return null;
    if (dialog.type === "hole") {
      const f = sheetFrame(api.getSceneElements()), box = profileBox(f, dialog.profile), spec = holeSpec(dialog);
      return holeProblem(box, partDepth(dialog.profile), spec) || (dialog.pattern && patternProblem(box, spec, dialog.pattern));
    }
    if (dialog.type === "pattern") {
      const f = sheetFrame(api.getSceneElements()), box = profileBox(f, dialog.profile);
      return patternProblem(box, holeOf(dialog.hole)?.spec || specFromCircle(f, box, dialog.hole), patternOf(dialog));
    }
    if (dialog.type === "round") {
      const size = parseFloat(dialog.size), limit = cornerLimit(sheetFrame(api.getSceneElements()), dialog.el, roundPicked(dialog), dialog.kind);
      if (!(size > 0)) return "Enter a size above 0 mm";
      if (size > limit + 0.01) return `Too big: ${dialog.scope === "all" ? "these corners take" : "this corner takes"} at most ${fmt(Math.floor(limit * 10) / 10)} mm`;
      return null;
    }
    if (dialog.type === "bolts") {
      const rf = revolveFrame(sheetFrame(api.getSceneElements()), dialog.profile);
      return rf ? boltProblem(rf, boltsOf(dialog)) : "This revolve's centre line was deleted";
    }
    return null;
  })();

  // Pointer handling on the board, in the capture phase so it runs before Excalidraw:
  // - Fingers pan and pinch-zoom while a drawing tool is active. In pen mode Excalidraw ignores fingers
  //   there and locks the zoom while the pen tool is chosen, so the board moves the view itself.
  //   Fingers are ignored while the pen is down, so a resting palm cannot move the drawing.
  // - A tool waiting for a tap (Dimension, Hole, Pattern) takes the next pen or mouse tap.
  // - Hold to snap notes when the pen went still, and whether it was still when it lifted.
  useEffect(() => {
    const root = document.querySelector(".board");
    if (!api || !root) return;
    const fingers = new Map();   // pointerId → {x, y} of each finger moving the view
    let start = null;            // view and finger positions when the current finger gesture began
    let penId = null;            // the pen or mouse pointer that is down, if any
    const centre = () => {
      const ps = [...fingers.values()];
      return { x: ps.reduce((t, p) => t + p.x, 0) / ps.length, y: ps.reduce((t, p) => t + p.y, 0) / ps.length };
    };
    const spread = () => {
      const [a, b] = [...fingers.values()];
      return b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    // Called whenever a finger lands or lifts, so the view carries on from where it is.
    const begin = () => {
      const s = api.getAppState();
      start = fingers.size ? { zoom: s.zoom.value, scrollX: s.scrollX, scrollY: s.scrollY, c: centre(), d: spread() } : null;
    };
    const moveView = () => {
      const s = api.getAppState(), c = centre(), d = spread();
      const zoom = start.d && d ? Math.min(30, Math.max(0.1, start.zoom * d / start.d)) : start.zoom;
      // The scene point that was under the fingers stays under them.
      const sx = (start.c.x - s.offsetLeft) / start.zoom - start.scrollX, sy = (start.c.y - s.offsetTop) / start.zoom - start.scrollY;
      api.updateScene({ appState: { zoom: { value: zoom }, scrollX: (c.x - s.offsetLeft) / zoom - sx, scrollY: (c.y - s.offsetTop) / zoom - sy } });
    };
    const fingerMovesView = e => {
      const s = api.getAppState();
      return e.pointerType === "touch" && s.penMode && !["selection", "text", "image", "hand"].includes(s.activeTool.type);
    };

    const down = e => {
      if (e.target.tagName !== "CANVAS") return;
      if (fingerMovesView(e)) {
        e.stopPropagation();
        if (penId !== null) return;
        fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        return begin();
      }
      if (e.pointerType === "touch" && api.getAppState().penMode) return;   // fingers never pick or snap
      penId = e.pointerId;
      if (pickingRef.current && pickingRef.current !== "centre") {
        e.stopPropagation(); e.preventDefault();
        pressAt.current = null;
        return pickTap(e);
      }
      if (api.getAppState().activeTool.type !== "freedraw") { pressAt.current = null; return; }
      pressAt.current = { id: e.pointerId, x: e.clientX, y: e.clientY, still: performance.now() };
    };
    const move = e => {
      if (fingers.has(e.pointerId)) {
        e.stopPropagation();
        fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        return moveView();
      }
      const p = pressAt.current;
      if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > HOLD_MOVE) { p.x = e.clientX; p.y = e.clientY; p.still = performance.now(); }
    };
    const up = e => {
      if (fingers.has(e.pointerId)) {
        e.stopPropagation();
        fingers.delete(e.pointerId);
        return begin();
      }
      if (e.pointerId === penId) penId = null;
      const p = pressAt.current;
      if (!p || p.id !== e.pointerId) return;
      pressAt.current = null;
      if (e.type === "pointerup") holdPending.current = performance.now() - p.still >= HOLD_MS ? "held" : "lift";
    };
    const esc = e => { if (e.key === "Escape" && pickingRef.current) setPick(null); };
    root.addEventListener("pointerdown", down, true);
    root.addEventListener("pointermove", move, true);
    root.addEventListener("pointerup", up, true);
    root.addEventListener("pointercancel", up, true);
    window.addEventListener("keydown", esc);
    return () => {
      root.removeEventListener("pointerdown", down, true);
      root.removeEventListener("pointermove", move, true);
      root.removeEventListener("pointerup", up, true);
      root.removeEventListener("pointercancel", up, true);
      window.removeEventListener("keydown", esc);
    };
  }, [api]);

  // Every board change: remember the newest pen stroke, and snap it if it was held still.
  const handleChange = (elements, appState) => {
    bridgeRef.current?.changed(elements);
    setGridOn(!!appState.gridModeEnabled);
    setEmpty(!elements.some(e => !e.isDeleted));
    const strokes = elements.filter(e => e.type === "freedraw" && !e.isDeleted);
    const fresh = strokes.filter(e => !seenStrokes.current.has(e.id));
    seenStrokes.current = new Set(strokes.map(e => e.id));
    if (fresh.length) activeStroke.current = fresh[fresh.length - 1].id;
    if (holdPending.current) {
      const held = holdPending.current === "held";
      holdPending.current = null;
      const el = elements.find(e => e.id === activeStroke.current && e.type === "freedraw" && !e.isDeleted);
      if (el && (held || autoSnap)) snapStroke(api, el, flash, held);
    }
    // A line just finished: tidy it, and if Centre line was waiting, make it the centre line.
    if (api && !appState.multiElement && !appState.newElement && !appState.editingLinearElement) {
      const done = elements.filter(e => e.type === "line" && !e.isDeleted && !isNote(e) && !tidyLines.has(e.id));
      if (!done.length) return;
      done.forEach(e => tidyLines.add(e.id));
      const fixed = new Map(done.map(e => [e.id, tidyLine(api, e)]).filter(([, t]) => t));
      const centre = pickingRef.current === "centre" ? done[done.length - 1] : null;
      if (centre) fixed.set(centre.id, bump({ ...(fixed.get(centre.id) || centre), strokeStyle: "dashed", strokeColor: BLUE, strokeWidth: 1 }));
      let scene = api.getSceneElements().map(e => fixed.get(e.id) || e), merged = false, closedOne = false;
      for (const d of done) {
        const joined = d !== centre && joinLines(scene, scene.find(e => e.id === d.id));
        if (joined) { scene = joined.elements; merged = true; closedOne ||= joined.closed; }
      }
      if (fixed.size || merged) commit(api, scene);
      if (closedOne && !centre) flash("Outline closed");
      if (centre) { setPick(null); flash("Centre line added"); }
    }
  };

  const confirmDim = () => {
    const mm = parseFloat(dialog.value);
    if (!(mm > 0)) return flash("Enter a size above 0 mm", "warn");
    const { el, kind, edge, replaces, scale: was } = dialog.pick;
    const firstDim = !dimsOf(api.getSceneElements()).length;
    const kept = api.getSceneElements().filter(x => !(replaces && x.groupIds.includes(replaces)));
    // The first dimension sets the scale from its drawn size; an edited one keeps the scale it set
    const scale = was || (firstDim ? mm / measure(el, { kind, edge }) : 0);
    const els = [...kept, ...dimensionElements(el, { kind, edge, mm, ...(scale ? { scale } : {}) })];
    commit(api, els);
    setDialog(null);
    flash(firstDim ? `Scale set: one grid square is ${fmt(GRID * mmPerPx(els))} mm` : replaces ? "Dimension changed" : "Dimension added");
  };

  const confirmPart = () => {
    const { plan, mode } = dialog;
    const edge = SOLID.includes(mode) && dialog.edgeKind !== "none" ? { kind: dialog.edgeKind, size: parseFloat(dialog.edgeSize) } : null;
    if (edge && !(edge.size > 0)) return flash("Enter an edge size above 0 mm", "warn");
    if (mode !== "revolve") {
      const d = parseFloat(dialog.depth);
      if (!(d > 0)) return flash(`Enter a ${mode === "boss" ? "height" : "depth"} above 0 mm`, "warn");
      if (mode !== "extrude" && !dialog.base) return flash("Draw it inside a part to stack it on top", "warn");
      const feature = mode === "boss" ? { feature: "boss", heightMm: d, on: dialog.base.id }
        : mode === "pocket" ? { feature: "pocket", depthMm: d, on: dialog.base.id } : { feature: "extrude", depthMm: d };
      applyPart(api, plan, edge ? { ...feature, topEdge: edge } : feature, flash);
    } else {
      const a = parseFloat(dialog.angle);
      if (!(a > 0 && a <= 360)) return flash("Enter an angle from 1 to 360°", "warn");
      if (!plan.axis) return flash("Draw a centre line beside the profile to revolve round it", "warn");
      if (plan.crossesAxis) return flash("The profile crosses the centre line. Keep it on one side to revolve", "warn");
      applyPart(api, plan, { feature: "revolve", angleDeg: a }, flash);
    }
    setDialog(null);
  };

  const roundPicked = d => d.scope === "all" ? [...Array(outline(d.el).pts.length).keys()] : [d.corner];
  const confirmRound = remove => {
    if (!remove && problem) return;
    const { el, kind } = dialog, size = parseFloat(dialog.size), picked = roundPicked(dialog);
    const now = live(api).find(x => x.id === el.id) || el;
    const kept = (now.customData?.corners || []).filter(c => !picked.includes(c.i));
    writeCorners(api, now, remove ? kept : [...kept, ...picked.map(i => ({ i, kind, size }))]);
    flash(remove ? `${picked.length > 1 ? "Corners" : "Corner"} made sharp`
      : `${picked.length > 1 ? "All corners" : "Corner"} ${kind === "fillet" ? "rounded R" : "chamfered C"}${fmt(size)}`);
    setDialog(null);
  };

  const confirmHole = () => {
    if (problem) return;
    const spec = holeSpec(dialog);
    writeHole(api, dialog.profile, dialog.hole, spec, dialog.pattern);
    lastHole.current = { kind: spec.kind, diameter: dialog.diameter };
    flash(dialog.hole ? "Hole changed" : `Hole added: ${holeCallout(spec).replace("\n", ", ")}`);
    setDialog(null);
  };

  const deleteHole = () => {
    writeHole(api, dialog.profile, dialog.hole, null);
    flash(dialog.pattern ? "Holes deleted" : "Hole deleted");
    setDialog(null);
  };

  const confirmPattern = () => {
    if (problem) return;
    const f = sheetFrame(api.getSceneElements()), box = profileBox(f, dialog.profile);
    const pattern = patternOf(dialog), spec = holeOf(dialog.hole)?.spec || specFromCircle(f, box, dialog.hole);
    writeHole(api, dialog.profile, dialog.hole, spec, pattern);
    flash(pattern.count > 1 ? `${pattern.count} holes ${pattern.mode === "row" ? "in a row" : "round the centre"}` : "Pattern removed");
    setDialog(null);
  };

  const confirmBolts = remove => {
    if (!remove && problem) return;
    writeBolts(api, dialog.profile, remove ? null : boltsOf(dialog));
    flash(remove ? "Bolt holes removed" : `${dialog.count} bolt holes on Ø${dialog.pcd}`);
    setDialog(null);
  };

  // Debug and bridge handles: the browser console can drive the board and read the part.
  useEffect(() => {
    window.board = api;
    window.partSketch = () => partSketch(api.getSceneElements());
  }, [api]);

  // The bridge streams the drawing to the laptop while the user draws (bridge.js).
  useEffect(() => {
    if (!api) return;
    // A part is ready for the AI once it has at least one marked profile.
    const bridge = createBridge({ api, partOf: partSketch, ready: part => part.features?.length > 0, onStatus: setLink,
      onBuildError: message => flash(`Could not send to the AI: ${message}`, "warn") });
    bridgeRef.current = window.bridge = bridge;
    return () => bridge.stop();
  }, [api]);

  // A tool works on the selection when that fits, otherwise it waits for a tap. Tapping it again cancels.
  const run = (item) => {
    if (!api) return;
    const mode = item.mode, again = pickingRef.current === mode;
    if (pickingRef.current) setPick(null);
    if (again) return;
    const sel = selected(api).filter(el => !isNote(el));
    if (mode === "mirror") {
      const shapes = sel.filter(el => el.type !== "text" && outline(el) && !isCentreLine(el));
      if (shapes.length) return mirrorShapes(api, shapes, flash, sel.find(isCentreLine));
    }
    if (mode === "profile" && closedShapes(sel).length) return openPart(planPart(api, closedShapes(sel), sel.find(isCentreLine)));
    setPick(mode);
  };

  // 3D file: download the live 3D model the laptop built from this drawing, or open it in the laptop's slicer.
  const modelOf = async () => {
    bridgeRef.current?.flush();
    const res = await fetch(`/api/model/info?session=${bridgeRef.current?.session}`).catch(() => null);
    const info = res?.ok ? await res.json() : null;
    return info?.status === "ok" ? info : null;
  };
  const downloadModel = async () => {
    const format = dialog.format;
    if (!(await modelOf())) return flash("No 3D part yet. Draw a closed outline first", "warn");
    const a = document.createElement("a");
    a.href = `/api/model?session=${bridgeRef.current.session}&format=${format}&download=1`;
    a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
    setDialog(null);
    flash(`${format.toUpperCase()} downloaded`);
  };
  const printModel = async () => {
    if (!(await modelOf())) return flash("No 3D part yet. Draw a closed outline first", "warn");
    const res = await fetch(`/api/print?session=${bridgeRef.current.session}`, { method: "POST" }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    setDialog(null);
    if (res?.ok) flash(`Opened in ${body.slicer} on the laptop. Slice it there and print`);
    else flash(body.detail ? `Could not print: ${body.detail}` : "Laptop not answering", "warn");
  };

  const field = key => ({ value: dialog[key], onChange: v => setDialog(d => ({ ...d, [key]: v })) });
  const close = () => setDialog(null);
  // The note under a dialog's fields: what is wrong with them, or what the tool will do.
  const note = ok => <p className={"eng-note" + (problem ? " warn" : "")} role={problem ? "alert" : undefined}>{problem || ok}</p>;
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
              const on = picking === item.mode;
              return (
                <button key={item.label} onClick={() => run(item)} aria-pressed={on} className={on ? "on" : ""}>
                  <span className="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[item.icon] }} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </section>
        ))}
        <div className="eng-sheet">
          <button onClick={() => toggleGrid(api)} aria-pressed={gridOn} className={gridOn ? "on" : ""} title="Snap to grid">
            <span className="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS.Grid }} /><span>Grid</span>
          </button>
          <button onClick={() => setAutoSnap(v => !v)} aria-pressed={autoSnap} className={autoSnap ? "on" : ""}
            title="Straighten lines, arcs, circles and rectangles when the Pencil lifts">
            <span className="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS.VectorSquare }} /><span>Snap</span>
          </button>
          <button onClick={() => api && exportDxf(api, flash)} title="Download the drawing as DXF">
            <span className="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS.Upload }} /><span>DXF</span>
          </button>
          <button onClick={() => setDialog({ type: "print", format: "stl" })} title="Download the 3D part, or print it">
            <span className="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS.Squares }} /><span>3D file</span>
          </button>
        </div>
        <div className="eng-send">
          <p className={"eng-link " + link.state} role="status" aria-live="polite">{link.text}</p>
        </div>
      </aside>

      {dialog?.type === "dim" && (
        <Dialog onClose={close} label={dialog.pick.kind === "diameter" ? "Diameter" : "Length"} onSubmit={confirmDim}
          actions={<><button type="button" onClick={close}>Cancel</button><button type="submit" className="primary">Set</button></>}>
          <Num label={dialog.pick.kind === "diameter" ? "Diameter (mm)" : "Length (mm)"} autoFocus {...field("value")} />
        </Dialog>
      )}

      {dialog?.type === "part" && (
        <Dialog onClose={close} label="Profile" onSubmit={confirmPart}
          actions={<><button type="button" onClick={close}>Cancel</button><button type="submit" className="primary">Mark</button></>}>
          <Seg label="Feature" options={dialog.base ? { boss: "Boss", pocket: "Pocket", extrude: "Extrude", revolve: "Revolve" } : { extrude: "Extrude", revolve: "Revolve" }}
            value={dialog.mode} onChange={m => setDialog(d => ({ ...d, mode: m }))} />
          {dialog.mode === "revolve" ? <Num label="Angle (°)" {...field("angle")} />
            : <Num label={dialog.mode === "boss" ? "Height (mm)" : "Depth (mm)"} autoFocus {...field("depth")} />}
          {SOLID.includes(dialog.mode) && <>
            <Seg label="Top edges" options={{ none: "Sharp edges", fillet: "Round", chamfer: "Chamfer" }} value={dialog.edgeKind}
              onChange={k => setDialog(d => ({ ...d, edgeKind: k }))} />
            {dialog.edgeKind !== "none" && <Num label={dialog.edgeKind === "fillet" ? "Edge radius (mm)" : "Edge chamfer (mm)"} {...field("edgeSize")} />}
          </>}
          <p className={"eng-note" + (dialog.mode === "revolve" && (!dialog.plan.axis || dialog.plan.crossesAxis) ? " warn" : "")}>
            {dialog.mode === "revolve" && !dialog.plan.axis ? "Draw a centre line beside the profile to revolve round it."
              : dialog.mode === "revolve" && dialog.plan.crossesAxis ? "The profile crosses the centre line. Keep it on one side."
              : dialog.mode === "boss" ? "Stands on top of the part it is drawn on" + (holes ? `, ${holes} hole${holes > 1 ? "s" : ""} through all` : "")
              : dialog.mode === "pocket" ? "Cut down into the part it is drawn on" + (holes ? `, ${holes} hole${holes > 1 ? "s" : ""} through all` : "")
              : `${dialog.plan.outers.length > 1 ? dialog.plan.outers.length + " profiles" : "1 profile"}` +
                (holes ? `, ${holes} hole${holes > 1 ? "s" : ""} cut through` : ", no holes")}
          </p>
        </Dialog>
      )}

      {dialog?.type === "hole" && (
        <Dialog onClose={close} label={dialog.hole ? "Change hole" : "Hole"} onSubmit={confirmHole}
          actions={<>
            {dialog.hole && <button type="button" className="danger" onClick={deleteHole}>Delete</button>}
            <button type="button" onClick={close}>Cancel</button>
            <button type="submit" className="primary" disabled={!!problem}>{dialog.hole ? "Update" : "Add hole"}</button>
          </>}>
          <Seg label="Hole type" options={HOLE_KINDS} value={dialog.kind} onChange={k => setDialog(d => ({ ...d, kind: k }))} />
          <div className="eng-row">
            <Num label="Diameter (mm)" autoFocus {...field("diameter")} />
            {dialog.kind === "blind" && <Num label="Depth (mm)" {...field("depth")} />}
            {dialog.kind === "countersink" && <Num label="Countersink Ø" {...field("cskDiameter")} />}
          </div>
          {dialog.kind === "counterbore" && (
            <div className="eng-row"><Num label="Counterbore Ø" {...field("cbDiameter")} /><Num label="Counterbore depth" {...field("cbDepth")} /></div>
          )}
          <div className="eng-row">
            <Num label="From left edge (mm)" {...field("x")} />
            <Num label="From bottom edge (mm)" {...field("y")} />
          </div>
          {note(dialog.pattern ? `Repeated ${dialog.pattern.count}× by its pattern` : holeCallout(holeSpec(dialog)).replace("\n", " · "))}
        </Dialog>
      )}

      {dialog?.type === "pattern" && (
        <Dialog onClose={close} label="Pattern" onSubmit={confirmPattern}
          actions={<><button type="button" onClick={close}>Cancel</button><button type="submit" className="primary" disabled={!!problem}>Repeat</button></>}>
          <Seg label="Pattern" options={{ row: "Row", circle: "Round centre" }} value={dialog.mode} onChange={m => setDialog(d => ({ ...d, mode: m }))} />
          <div className="eng-row">
            <Num label="Holes in all" autoFocus {...field("count")} />
            {dialog.mode === "row" && <Num label="Spacing (mm)" {...field("spacing")} />}
          </div>
          {dialog.mode === "row" && (
            <Seg label="Direction" options={{ right: "→", left: "←", up: "↑", down: "↓" }} value={dialog.dir} onChange={v => setDialog(d => ({ ...d, dir: v }))} />
          )}
          {note(dialog.mode === "row" ? "Copies of the hole, spaced from its centre" : "Copies spaced evenly round the profile's centre, through this hole")}
        </Dialog>
      )}

      {dialog?.type === "round" && (
        <Dialog onClose={close} label="Round corner" onSubmit={() => confirmRound(false)}
          actions={<>
            {dialog.had && <button type="button" className="danger" onClick={() => confirmRound(true)}>Sharp</button>}
            <button type="button" onClick={close}>Cancel</button>
            <button type="submit" className="primary" disabled={!!problem}>Set</button>
          </>}>
          <Seg label="Kind" options={{ fillet: "Round", chamfer: "Chamfer" }} value={dialog.kind} onChange={k => setDialog(d => ({ ...d, kind: k }))} />
          <Num label={dialog.kind === "fillet" ? "Radius (mm)" : "Chamfer (mm)"} autoFocus {...field("size")} />
          <Seg label="Corners" options={{ one: "This corner", all: "All corners" }} value={dialog.scope} onChange={v => setDialog(d => ({ ...d, scope: v }))} />
          {note(dialog.kind === "fillet" ? "Round a cut-out's corners to half its width for a slot" : "Cut off at 45°, the same size along both sides")}
        </Dialog>
      )}

      {dialog?.type === "print" && (
        <Dialog onClose={close} label="3D file" onSubmit={downloadModel}
          actions={<><button type="button" onClick={printModel}>Print on laptop</button><button type="submit" className="primary">Download</button></>}>
          <Seg label="Format" options={{ stl: "STL", "3mf": "3MF", step: "STEP" }} value={dialog.format} onChange={f => setDialog(d => ({ ...d, format: f }))} />
          {note(dialog.format === "step" ? "STEP keeps exact curves, for other CAD programs" : "For a slicer and a 3D printer")}
        </Dialog>
      )}

      {dialog?.type === "bolts" && (
        <Dialog onClose={close} label="Bolt holes" onSubmit={() => confirmBolts(false)}
          actions={<>
            {dialog.profile.customData.part.boltCircle && <button type="button" className="danger" onClick={() => confirmBolts(true)}>Remove</button>}
            <button type="button" onClick={close}>Cancel</button>
            <button type="submit" className="primary" disabled={!!problem}>Add</button>
          </>}>
          <div className="eng-row">
            <Num label="Holes" autoFocus {...field("count")} />
            <Num label="Diameter (mm)" {...field("diameter")} />
          </div>
          <Num label="Pitch circle Ø (mm)" {...field("pcd")} />
          {note("Drilled through, parallel to the centre line, evenly round it")}
        </Dialog>
      )}

      {toast ? (
        <div key={toast.id} className={"eng-toast " + toast.kind + (toast.sticky ? " sticky" : "") + (toast.leaving ? " leaving" : "")}
          role="status" aria-live="polite" onAnimationEnd={() => toast.leaving && setToast(null)}>
          <span>{toast.text}</span>
          {toast.sticky && <button type="button" onClick={() => setPick(null)}>Cancel</button>}
        </div>
      ) : empty && !dialog && (
        <div className="eng-hint">Draw the part's outline with the Pencil. Lines, arcs, circles and rectangles straighten as you lift, and sides that meet join up. Hold still at the end for any straight-sided outline.</div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
