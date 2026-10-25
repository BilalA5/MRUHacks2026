// Engineering board built on Excalidraw (MIT, https://github.com/excalidraw/excalidraw).
// Excalidraw supplies the canvas, tools and undo. This file adds a sidebar of engineering tools
// and partSketch(), the clean mm description of the part that the laptop builds from.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  Excalidraw, CaptureUpdateAction, viewportCoordsToSceneCoords,
  convertToExcalidrawElements as toElements,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { ICONS } from "./icons.js";
import { createBridge } from "./bridge.js";
import { api as server, REMOTE } from "./api.js";
import { createViewer } from "./viewer.js";

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
// ---- and held still at its end, also an ellipse, a triangle or any straight-sided outline. ----
const HOLD_MS = 450;    // how long the pen must stay still before lifting
const HOLD_MOVE = 8;    // screen px the pen may drift and still count as still
const TAP_PX = 6;       // a stroke smaller than this is a Pencil tap, not a drawing
const JOIN_PX = 12;     // line ends this close are joined into one line
// A mouse or trackpad wobbles far more than a Pencil, and cannot easily be held still at the end of a stroke.
// Its strokes get looser tolerances, and any outline whose ends meet snaps on lift, not only when held.
// Sizes are in screen px (px = scene px per screen px), so snapping works the same at any zoom.
const PEN = { px: 1, loose: false };
const MOUSE = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;   // a laptop, not the iPad

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
function recogniseArc(pts, { px, loose } = PEN) {
  const c = circleThrough(pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]);
  if (!c || c.r > 2000 * px || !pts.every(p => Math.abs(dist(p, c) - c.r) <= Math.max((loose ? 8 : 4) * px, (loose ? 0.12 : 0.08) * c.r))) return null;
  const ang = p => Math.atan2(p.y - c.y, p.x - c.x);
  let sweep = 0;
  for (let i = 1; i < pts.length; i++) sweep += (ang(pts[i]) - ang(pts[i - 1]) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  const deg = Math.abs(sweep) * 180 / Math.PI, nice = Math.round(deg / 90) * 90;
  if (deg < 25 || deg > 300) return null;
  const turn = (nice && Math.abs(deg - nice) <= 10 ? nice : deg) * Math.PI / 180 * Math.sign(sweep);
  const n = Math.max(6, Math.ceil(Math.abs(turn) / (Math.PI / 24))), a0 = ang(pts[0]);
  return Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + c.r * Math.cos(a0 + turn * i / n), y: c.y + c.r * Math.sin(a0 + turn * i / n) }));
}

// Returns {name, skeleton} for a line, arc, circle, rectangle, ellipse, triangle or straight-sided outline, or null.
// Ellipses, triangles and other straight-sided outlines are only made from a held stroke (held), as a quick
// sketch is often meant freehand.
function recogniseStroke(pts, held = true, by = PEN) {
  const { px, loose } = by;
  const a = pts[0], b = pts[pts.length - 1];
  const { minX, maxX, minY, maxY } = bounds(pts);
  const w = maxX - minX, h = maxY - minY, size = Math.max(w, h);
  if (size < 20 * px) return null;
  const len = dist(a, b);
  // A long line is allowed more wobble: 6 px, or 2.5% of its length (12 px or 5% from a mouse)
  if (len >= 0.7 * size && Math.max(...pts.map(p => segDist(p, a, b))) <= (loose ? Math.max(12 * px, 0.05 * len) : Math.max(6 * px, 0.025 * len))) {
    return { name: "line", skeleton: { type: "line", x: a.x, y: a.y, points: [[0, 0], [b.x - a.x, b.y - a.y]] } };
  }
  if (len > 0.25 * size) {
    const arc = recogniseArc(pts, by);
    return arc ? { name: "arc", skeleton: polyline(arc, false, {}) } : null;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  if (Math.min(w, h) / Math.max(w, h) >= 0.77) {          // closer to round than 1.3 : 1
    const r = (w + h) / 4;
    // A held stroke asked to be snapped, so a rougher loop still counts as a circle rather than a many-sided outline
    if (pts.every(p => Math.abs(dist(p, { x: cx, y: cy }) - r) <= (held || loose ? 0.25 : 0.15) * r)) {
      return { name: "circle", skeleton: { type: "ellipse", x: cx - r, y: cy - r, width: 2 * r, height: 2 * r } };
    }
  }
  const tol = (loose ? 0.16 : 0.12) * Math.min(w, h);
  const near = pts.filter(p => Math.min(Math.abs(p.x - minX), Math.abs(p.x - maxX), Math.abs(p.y - minY), Math.abs(p.y - maxY)) <= tol).length;
  const outlineCorners = dropStraight(corners(pts, (loose ? 0.07 : 0.05) * size).slice(0, -1));
  if (w >= 20 * px && h >= 20 * px && Math.max(w, h) / Math.min(w, h) <= 4 && near / pts.length >= (loose ? 0.8 : 0.85) && outlineCorners.length <= 4) {
    return { name: "rectangle", skeleton: { type: "rectangle", x: minX, y: minY, width: w, height: h } };
  }
  // An oval: every point near the ellipse that fills the stroke's box
  const rx = w / 2, ry = h / 2;
  held ||= loose;          // a mouse stroke whose ends meet is meant as a shape
  if (held && rx > 10 * px && ry > 10 * px && outlineCorners.length > 4
    && pts.every(p => Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1) <= (loose ? 0.22 : 0.18))) {
    return { name: "ellipse", skeleton: { type: "ellipse", x: minX, y: minY, width: w, height: h } };
  }
  if (held && outlineCorners.length === 3) {
    return { name: "triangle", skeleton: polyline(squarePath(outlineCorners, true), true, {}) };
  }
  if (held && outlineCorners.length >= 4 && outlineCorners.length <= 16) {
    const named = outlineCorners.length === 4 ? "four-sided outline" : `outline with ${outlineCorners.length} sides`;
    return { name: named, skeleton: polyline(squarePath(outlineCorners, true), true, {}) };
  }
  return null;
}

// Replaces a freehand stroke with the recognised shape, keeping its colour and stroke width.
// held: the pen was held still at the end, so any outline may be made and a miss is reported.
// pointer: "pen", "mouse" or "touch", whatever drew the stroke.
function snapStroke(api, el, flash, held, pointer = "pen") {
  const pts = el.points.map(([px, py]) => ({ x: el.x + px, y: el.y + py }));
  const others = api.getSceneElements().filter(e => e.id !== el.id);
  const b = bounds(pts), by = { px: 1 / api.getAppState().zoom.value, loose: pointer !== "pen" };
  if (!held && Math.max(b.maxX - b.minX, b.maxY - b.minY) < TAP_PX * by.px) return commit(api, others);   // a tap, not a drawing
  const found = recogniseStroke(pts, held, by);
  if (!found) return held && flash("Held stroke is not a line, arc, circle, ellipse, rectangle, triangle or straight-sided outline", "warn");
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
      pocket: `Pocket ${fmt(feature.depthMm)} mm deep` }[feature.feature]
      || (feature.on ? `${fmt(feature.depthMm)} mm ${MATERIALS[feature.material]?.name || "plate"} · ${feature.place === "inside" ? "set in" : "on top"}`
        : `${fmt(feature.depthMm)} mm ${MATERIALS[feature.material]?.name || "plate"}${feature.process ? ` · ${PROCESSES[feature.process]}` : ""}`);
    // Above, clear of dimensions and the centre line; a part drawn on another part labels just above itself,
    // inside the part under it, so the two parts' labels never sit on top of each other
    return feature.feature === "extrude" && feature.on
      ? { type: "text", x: b.minX, y: b.minY - 20, text: text + edge, fontSize: 12, strokeColor: BLUE }
      : { type: "text", x: b.minX, y: b.minY - 72, text: text + edge, fontSize: 14, strokeColor: BLUE };
  });
  const labelEls = convertToExcalidrawElements(labels).map((e, i) => ({
    ...e, groupIds: [groups.get(plan.outers[i].el.id)], customData: { note: "label", of: plan.outers[i].el.id },
  }));
  const marked = el => {
    if (outerFeature.has(el.id)) {
      return bump({ ...el, groupIds: [groups.get(el.id)], backgroundColor: FILLS[feature.feature] || MATERIALS[feature.material]?.tint || PART_FILL, fillStyle: "solid",
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
  const vertices = geometry.filter(el => el.type !== "freedraw" && el.type !== "ellipse" && !el.customData?.bend && !el.customData?.gear)
    .flatMap(el => outline(el).pts);
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
// A tapped hole (thread, nominal; diameter is its tap drill) goes through, or to its thread depth.
// A hole sized for a fastener names it (fastener: "M5"), and its sizes come from the standards below.
const HOLE_KINDS = { through: "Through", blind: "Blind", counterbore: "C'bore", countersink: "C'sink", tapped: "Tapped" };

// ISO metric fasteners: clearance hole (ISO 273 medium), coarse thread pitch and tap drill, socket-head
// counterbore (ISO 4762 head + clearance, depth = head height + 0.4) and 90° countersink (ISO 10642).
const FASTENERS = {
  M2: { clear: 2.4, tap: 1.6, pitch: 0.4, cb: 4.4, cbDepth: 2.4, csk: 4.4 },
  "M2.5": { clear: 2.9, tap: 2.05, pitch: 0.45, cb: 5.5, cbDepth: 2.9, csk: 5.5 },
  M3: { clear: 3.4, tap: 2.5, pitch: 0.5, cb: 6.5, cbDepth: 3.4, csk: 6.9 },
  M4: { clear: 4.5, tap: 3.3, pitch: 0.7, cb: 8, cbDepth: 4.4, csk: 9.2 },
  M5: { clear: 5.5, tap: 4.2, pitch: 0.8, cb: 10, cbDepth: 5.4, csk: 11.5 },
  M6: { clear: 6.6, tap: 5, pitch: 1, cb: 11, cbDepth: 6.5, csk: 13.7 },
  M8: { clear: 9, tap: 6.8, pitch: 1.25, cb: 15, cbDepth: 8.6, csk: 18.3 },
  M10: { clear: 11, tap: 8.5, pitch: 1.5, cb: 18, cbDepth: 10.8, csk: 22.7 },
  M12: { clear: 13.5, tap: 10.2, pitch: 1.75, cb: 20, cbDepth: 13, csk: 27.2 },
};

// Materials a part can be made from: density (g/cm³) for its weight, family for the shop's rules, the plate or
// sheet thicknesses suppliers stock (mm), offered as one-tap depths, and how it looks: tint fills the part on the
// canvas, color (0-1 RGB) and transparency (%) colour the 3D part on the laptop and in the downloaded files.
const MATERIALS = {
  al6061: { name: "Aluminium 6061", density: 2.7, family: "aluminium", stock: [1.5, 2, 3, 4, 5, 6, 8, 10, 12],
    tint: "#E2E7EE", color: [0.8, 0.82, 0.85], transparency: 0 },
  steel: { name: "Mild steel", density: 7.85, family: "steel", stock: [1, 1.5, 2, 3, 4, 5, 6, 8, 10],
    tint: "#D3D9E1", color: [0.5, 0.53, 0.57], transparency: 0 },
  ss304: { name: "Stainless 304", density: 8, family: "stainless", stock: [1, 1.5, 2, 3, 4, 5, 6],
    tint: "#E5E8EC", color: [0.7, 0.72, 0.75], transparency: 0 },
  acrylic: { name: "Acrylic", density: 1.19, family: "acrylic", stock: [2, 3, 4, 5, 6, 8, 10],
    tint: "#DCF0F8", color: [0.68, 0.87, 0.96], transparency: 55 },
  plywood: { name: "Birch plywood", density: 0.68, family: "wood", stock: [3, 4, 6, 9, 12, 18],
    tint: "#F2E4CE", color: [0.86, 0.72, 0.52], transparency: 0 },
  pla: { name: "PLA (3D print)", density: 1.24, family: "plastic", stock: [],
    tint: "#FCE4D4", color: [0.95, 0.52, 0.2], transparency: 0 },
};
const PROCESSES = { cnc: "CNC mill", laser: "Laser / waterjet", sheet: "Sheet metal", print: "3D print" };
const materialOf = key => MATERIALS[key]
  && (({ name, density, family, color, transparency }) => ({ name, density, family, color, transparency }))(MATERIALS[key]);

// A spur gear's outline in mm round (0, 0): involute flanks at a 20° pressure angle, addendum m and
// dedendum 1.25 m (ISO 53). The root between teeth is a straight chord, fine for cut and printed gears.
function gearPoints(module, teeth, pressureDeg = 20) {
  const pa = pressureDeg * Math.PI / 180, inv = a => Math.tan(a) - a, polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
  const r = module * teeth / 2, rb = r * Math.cos(pa), ra = r + module, rf = Math.max(r - 1.25 * module, module);
  const flank = rho => Math.PI / (2 * teeth) + inv(pa) - inv(Math.acos(Math.min(1, rb / rho)));   // tooth half-angle at rho
  const r0 = Math.max(rb, rf), steps = 6, pts = [];
  const radii = Array.from({ length: steps + 1 }, (_, i) => r0 + (ra - r0) * i / steps);
  for (let k = 0; k < teeth; k++) {
    const c = 2 * Math.PI * k / teeth;
    if (rf < rb) pts.push(polar(rf, c - flank(rb)));
    radii.forEach(rho => pts.push(polar(rho, c - flank(rho))));
    [...radii].reverse().forEach(rho => pts.push(polar(rho, c + flank(rho))));
    if (rf < rb) pts.push(polar(rf, c + flank(rb)));
  }
  return pts;
}

function holeCallout(spec, count = 1) {
  const n = count > 1 ? `${count}× ` : "", d = `Ø${fmt(spec.diameter)}`, m = spec.fastener ? `${spec.fastener} ` : "";
  if (spec.kind === "tapped") return `${n}${spec.thread} ${spec.depth ? `↧ ${fmt(spec.depth)}` : "THRU"}`;
  if (spec.kind === "blind") return `${n}${d} ↧ ${fmt(spec.depth)}`;
  if (spec.kind === "counterbore") return `${n}${m}${d} THRU\n⌴ Ø${fmt(spec.cbDiameter)} ↧ ${fmt(spec.cbDepth)}`;
  if (spec.kind === "countersink") return `${n}${m}${d} THRU\n⌵ Ø${fmt(spec.cskDiameter)} × 90°`;
  return `${n}${m}${spec.fastener ? "clear " : ""}${d} THRU`;
}

const holeOf = el => el.customData?.part?.hole ? el.customData.part : null;
const partDepth = profile => profile.customData?.part?.feature === "extrude" ? profile.customData.part.depthMm : null;

// The widest circle a hole cuts (or its thread), which must stay inside the profile.
function holeFits(box, spec) {
  const r = Math.max(spec.diameter, spec.cbDiameter || 0, spec.cskDiameter || 0, spec.nominal || 0) / 2;
  const cx = box.minX + spec.x, cy = box.minY + spec.y;
  return within(Array.from({ length: 24 }, (_, i) => ({ x: cx + r * Math.cos(i / 12 * Math.PI), y: cy + r * Math.sin(i / 12 * Math.PI) })), box.pts);
}

function holeProblem(box, depth, spec) {
  if (spec.kind === "tapped" && !spec.thread) return "Pick a thread size, M2 to M12";
  if (spec.kind === "tapped" && spec.depth && depth && spec.depth >= depth) return `Deeper than the part (${fmt(depth)} mm). Leave thread depth empty for through`;
  if (!(spec.diameter > 0)) return "Enter a diameter above 0 mm";
  if (!Number.isFinite(spec.x) || !Number.isFinite(spec.y)) return "Enter where the hole goes";
  if (spec.fastener && spec.kind === "counterbore" && depth && spec.cbDepth >= depth)
    return `An ${spec.fastener} counterbore is ${fmt(spec.cbDepth)} mm deep, more than this ${fmt(depth)} mm part. Use C'sink, or a thicker part`;
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
  const { c, r, k } = holeOnSheet(f, box, spec);
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
  if (spec.kind === "tapped" && spec.nominal) {         // the thread's major diameter, drawn dashed round the tap drill
    const R = spec.nominal / 2 * k;
    sk.push({ type: "ellipse", x: c.x - R, y: c.y - R, width: 2 * R, height: 2 * R, strokeColor: INK, strokeWidth: 1, strokeStyle: "dashed", backgroundColor: "transparent" });
  }
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
    if (el.customData?.gear) {          // a gear is exact: its outline is made again from module and teeth, in mm
      const { module, teeth } = el.customData.gear, b = bounds(outline(el).pts);
      const [cx, cy] = P({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
      return { type: "polygon", points: gearPoints(module, teeth).map(([x, y]) => [r2(cx + x), r2(cy + y)]), gear: { module, teeth } };
    }
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
    return { id: el.id, type: "hole", kind, center: [r2(box.minX + x), r2(box.minY + y)], diameter, ...more, ...(kind === "countersink" ? { cskAngle: 90 } : {}) };
  };

  const madeOf = part => ({ ...(part.material ? { material: materialOf(part.material) } : {}), ...(part.process ? { process: part.process } : {}) });
  const bendsOf = el => els.filter(b => bendOf(b) && crosses(b, outline(el).pts))
    .map(b => ({ id: b.id, a: P(lineEnds(b)[0]), b: P(lineEnds(b)[1]), ...bendOf(b) }));
  const features = profiles.map(el => {
    const part = el.customData.part;
    const holes = els.filter(h => holeOf(h)?.of === el.id).map(hole);
    if (part.feature === "revolve") {
      const axis = byId.get(part.axis);
      const ends = axis ? [axis.points[0], axis.points[axis.points.length - 1]].map(([px, py]) => P({ x: axis.x + px, y: axis.y + py })) : null;
      return { id: el.id, type: "revolve", angle: part.angleDeg, axis: ends, profile: shape(el), holes, ...madeOf(part), ...(part.boltCircle ? { boltCircle: part.boltCircle } : {}) };
    }
    const edge = part.topEdge ? { edge: part.topEdge } : {};
    if (part.feature === "boss") return { id: el.id, type: "boss", on: part.on, height: part.heightMm, profile: shape(el), holes, ...edge };
    if (part.feature === "pocket") return { id: el.id, type: "pocket", on: part.on, depth: part.depthMm, profile: shape(el), holes };
    const bends = bendsOf(el);
    const placed = part.on && byId.has(part.on) ? { on: part.on, place: part.place || "top" } : {};   // a part of its own, on or in another
    return { id: el.id, type: "extrude", depth: part.depthMm, profile: shape(el), holes, ...edge, ...madeOf(part), ...placed, ...(bends.length ? { bends } : {}) };
  });

  const used = new Set([...profiles.map(el => el.id), ...els.filter(el => profiles.some(p => p.id === holeOf(el)?.of)).map(el => el.id)]);
  return {
    units: "mm",
    mmPerPx: r2(s * 1000) / 1000,
    scaleFrom: dims.length ? "dimensions" : "default",
    features,
    dimensions: dims.map(d => ({ target: d.target, kind: d.kind, edge: d.edge, mm: d.mm })),
    conflicts: f.conflicts.map(d => ({ target: d.target, edge: d.edge, mm: d.mm })),
    other: geometry.filter(el => !used.has(el.id)).map(el => ({ id: el.id,
      role: holeOf(el) ? "hole" : bendOf(el) ? "bend" : el.strokeStyle === "dashed" ? "centre line" : "sketch", ...(holeOf(el) ? hole(el) : shape(el)) })),
    notes: els.filter(el => el.type === "text" && !isNote(el)).map(el => ({ text: el.text, at: P({ x: el.x, y: el.y }) })),
  };
}

// What the laptop's part is made of, in words: one material, or each part's.
const madeOf = made => {
  const names = [...new Set((made.bodies || []).map(b => b.material?.name).filter(Boolean))];
  const parts = made.bodies?.length > 1 ? `${made.bodies.length} parts: ` : "";
  return names.length ? parts + names.join(", ") : made.material?.name || "No material set";
};

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

// ---- Sheet metal ----
// A bend line is a dotted blue line with customData.bend = { angle (°), up (seen from the sketch), radius (inside, mm) }.
// It folds the flat sheet it is drawn across: the profile marked Extrude that it crosses.
const bendOf = el => !el.isDeleted && el.customData?.bend ? el.customData.bend : null;
const bendFields = b => ({ angle: fmt(b.angle), up: b.up ? "up" : "down", radius: fmt(b.radius) });
const sheetOf = (api, line) => live(api).find(el => el.customData?.part?.feature === "extrude" && crosses(line, outline(el).pts));
// The usual inside radius for a bend is the sheet's thickness.
const sheetAt = (api, line) => sheetOf(api, line)?.customData.part.depthMm ?? 2;
const defaultProcess = (material, bends) => bends ? "sheet" : material === "pla" ? "print" : ["acrylic", "plywood"].includes(material) ? "laser" : "cnc";

function writeBend(api, line, bend) {
  const kept = api.getSceneElements().filter(e => !(e.customData?.note === "bend" && e.customData.of === line.id));
  if (!bend) return commit(api, kept.filter(e => e.id !== line.id));
  const [a, b] = lineEnds(line), top = a.y < b.y ? a : b;
  const [label] = convertToExcalidrawElements([{ type: "text", x: top.x + 6, y: top.y - 22, fontSize: 13, strokeColor: BLUE,
    text: `BEND ${bend.up ? "UP" : "DOWN"} ${fmt(bend.angle)}° R${fmt(bend.radius)}` }]);
  commit(api, [...kept.map(e => e.id === line.id ? bump({ ...e, customData: { ...(e.customData || {}), bend } }) : e),
    { ...label, groupIds: line.groupIds, customData: { note: "bend", of: line.id } }]);
}

// ---- Annotations follow their shape ----
// Dimensions, labels and notes are separate elements, so when a shape is moved its notes are moved by
// the same amount, and when it is reshaped its dimensions are drawn again on its new edges.
function noteOwner(el, dimGroups) {
  return el.customData?.dim?.target || el.customData?.of || (el.customData?.note === "dim" ? dimGroups.get(el.groupIds[0]) : null);
}
// Moving a shape changes only x and y; reshaping it changes its size, turn or points.
const shapeKey = el => `${el.width}|${el.height}|${el.angle}|${el.points ? el.points.length + "|" + el.points[el.points.length - 1] : ""}`;

function followNotes(api, elements, seen) {
  // Fast path, run on every change: anything whose version is unchanged is skipped without a look.
  let changed = false;
  for (const el of elements) {
    const was = seen.get(el.id);
    if (!was || was.v !== el.version) { changed = true; break; }
  }
  if (!changed && seen.size === elements.length) return;
  const els = elements.filter(e => !e.isDeleted);
  const dimGroups = new Map(els.filter(e => e.customData?.dim).map(e => [e.groupIds[0], e.customData.dim.target]));
  const byId = new Map(els.map(e => [e.id, e]));
  // Only shapes that have notes or holes matter; a plain stroke being drawn is left alone.
  const owners = new Set(els.map(e => isNote(e) ? noteOwner(e, dimGroups) : holeOf(e)?.of).filter(Boolean));
  const dimmed = new Set(els.filter(e => e.customData?.dim).map(e => e.customData.dim.target));
  const moves = new Map(), redraw = new Set();
  for (const el of els) {
    const was = seen.get(el.id);
    if (!was || was.v === el.version || isNote(el) || !owners.has(el.id)) continue;
    if (was.key !== shapeKey(el)) { if (dimmed.has(el.id)) redraw.add(el.id); }
    else if (was.x !== el.x || was.y !== el.y) moves.set(el.id, { dx: el.x - was.x, dy: el.y - was.y });
  }
  // A hole follows its profile, and a hole's notes follow the hole, so a delta is found up that chain.
  const deltaFor = (id, depth = 0) => moves.get(id) || (depth < 3 && holeOf(byId.get(id) || {})?.of ? deltaFor(holeOf(byId.get(id)).of, depth + 1) : null);
  let next = null;
  if (moves.size || redraw.size) {
    const out = [];
    for (const el of elements) {
      const owner = el.isDeleted ? null : isNote(el) ? noteOwner(el, dimGroups) : holeOf(el)?.of;
      const m = owner && deltaFor(owner), was = seen.get(el.id);
      // A note that already moved with its shape (selected together, or in the same group) stays put.
      if (m && !(was && (el.x - was.x === m.dx) && (el.y - was.y === m.dy))) out.push({ ...el, x: el.x + m.dx, y: el.y + m.dy, version: el.version + 1 });
      else if (owner && redraw.has(owner) && el.customData?.note === "dim") continue;   // drawn again below
      else out.push(el);
    }
    for (const id of redraw) {
      const target = byId.get(id);
      for (const t of els.filter(e => e.customData?.dim?.target === id)) {
        const { target: _, ...dim } = t.customData.dim;
        if (target && measure(target, dim) > 0) out.push(...dimensionElements(target, dim));
      }
    }
    next = out;
    api.updateScene({ elements: out, captureUpdate: CaptureUpdateAction.EVENTUALLY });   // part of the same undo step as the move
  }
  seen.clear();
  for (const el of next || elements) seen.set(el.id, { v: el.version, x: el.x, y: el.y, key: shapeKey(el) });
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
    { label: "Bend", icon: "Bend", mode: "bend" },
    { label: "Gear", icon: "Gear", mode: "gear" },
  ] },
];

const DRAWN = ["centre", "bend"];      // tools that wait for a line to be drawn rather than a tap

const PICK_HINTS = {
  centre: "Draw the centre line",
  bend: "Draw the bend line across the sheet",
  gear: "Tap where the gear's centre goes",
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
const Pick = ({ label, value, options, onChange }) => (
  <label>{label}
    <select value={value} onChange={e => onChange(e.target.value)}>
      {Object.entries(options).map(([k, text]) => <option key={k} value={k}>{text}</option>)}
    </select>
  </label>
);
const Seg = ({ label, options, value, onChange }) => (
  <div className="eng-seg" role="radiogroup" aria-label={label}>
    {Object.entries(options).map(([k, text]) => (
      <button key={k} type="button" role="radio" aria-checked={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>{text}</button>
    ))}
  </div>
);

// The 3D preview: the laptop's model of this drawing, live, in a panel beside the canvas (see viewer.js).
// It lives outside the board, so the board's finger and pen handling never sees its touches.
function Preview({ session, onClose }) {
  const host = useRef(null), viewer = useRef(null);
  const [info, setInfo] = useState(null);
  useEffect(() => {
    viewer.current = createViewer(host.current, session, setInfo);
    return () => viewer.current.dispose();
  }, []);
  const size = i => i.bbox.max.map((b, k) => fmt(b - i.bbox.min[k])).join(" × ") + " mm";
  const status = !info ? "Waiting for the laptop"
    : info.status === "offline" ? "Laptop not answering"
    : info.status === "empty" ? "Draw a closed outline to see it in 3D"
    : info.status === "error" ? info.warnings?.[0] || "Could not build the part"
    : `${info.preview ? "Preview · " : ""}${size(info)}` + (info.mass != null ? ` · ${fmt(info.mass)} g` : "");
  return createPortal(
    <section className="eng-3d" aria-label="3D preview">
      <header>
        <strong>3D</strong>
        <span title={status}>{status}</span>
        <button type="button" onClick={() => viewer.current?.refit()}>Fit</button>
        <button type="button" onClick={onClose} aria-label="Close the 3D preview">✕</button>
      </header>
      <div className="eng-3d-view" ref={host} />
    </section>, document.body);
}

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
  const [autoSnap, setAutoSnap] = useState(true);   // snap lines, arcs, circles and rectangles on lift
  const lastPart = useRef({ material: "al6061" });                 // a new part starts in the last material
  const seen = useRef(new Map());                                  // where each shape was, so its notes can follow it
  const [made, setMade] = useState(null);
  const [preview, setPreview] = useState(REMOTE);   // the 3D panel: open by itself on the web demo, which has no FreeCAD                          // the laptop's latest build: weight and checks
  const seenStrokes = useRef(new Set());   // freedraw ids already seen in onChange
  const activeStroke = useRef(null);       // the freedraw stroke being drawn now
  const holdPending = useRef(null);        // "held" when a pen lifts after being still, "lift" otherwise
  const strokeBy = useRef("pen");          // what drew the last stroke: pen, mouse or touch
  const pressAt = useRef(null);            // where and when the current pen press went still

  // Every tool reports through here. kind is "ok" or "warn" (the tool could not run).
  // A sticky toast stays until replaced and offers Cancel for the tool waiting for a tap.
  const flash = (text, kind = "ok", sticky = false) => {
    setToast({ id: Date.now(), text, kind, sticky });
    clearTimeout(toastTimer.current);
    if (!sticky) toastTimer.current = setTimeout(() => setToast(t => t && { ...t, leaving: true }), 2800);
  };

  const setPick = mode => {
    if (DRAWN.includes(pickingRef.current) && !mode) api?.setActiveTool({ type: "selection" });
    if (DRAWN.includes(mode)) api.setActiveTool({ type: "line" });   // Centre line and Bend wait for a drawn line, not a tap
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
    else if (mode === "gear") setDialog({ type: "gear", at: p, module: "2", teeth: "20", bore: "8", thickness: "6", material: lastPart.current.material });
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
    const material = was?.material || lastPart.current.material;
    const bends = live(api).some(b => bendOf(b) && crosses(b, pts));
    setDialog({ type: "part", plan, base, mode, place: was?.place || "top", depth: fmt(was?.depthMm ?? was?.heightMm ?? (base ? 5 : 10)), angle: fmt(was?.angleDeg ?? 360),
      edgeKind: was?.topEdge?.kind || "none", edgeSize: fmt(was?.topEdge?.size ?? 1),
      material, process: was?.process || (bends ? "sheet" : lastPart.current.process) || defaultProcess(material, bends) });
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
    setDialog({ type: "hole", profile, hole, kind: spec.kind, size: spec.fastener || (spec.kind === "tapped" ? "M5" : "custom"),
      diameter: st(d), x: st(spec.x), y: st(spec.y),
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
  // With a fastener size picked, its sizes come from the standards; Custom takes the typed sizes.
  const holeSpec = d => {
    const n = k => parseFloat(d[k]), F = FASTENERS[d.size];
    const spec = { kind: d.kind, diameter: F ? (d.kind === "tapped" ? F.tap : F.clear) : n("diameter"), x: n("x"), y: n("y") };
    if (F) spec.fastener = d.size;
    if (d.kind === "tapped") {
      if (F) Object.assign(spec, { thread: `${d.size}×${F.pitch}`, nominal: parseFloat(d.size.slice(1)) });
      if (n("depth") > 0) spec.depth = n("depth");
    }
    if (d.kind === "blind") spec.depth = n("depth");
    if (d.kind === "counterbore") Object.assign(spec, F ? { cbDiameter: F.cb, cbDepth: F.cbDepth } : { cbDiameter: n("cbDiameter"), cbDepth: n("cbDepth") });
    if (d.kind === "countersink") spec.cskDiameter = F ? F.csk : n("cskDiameter");
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
    if (dialog.type === "bend") {
      const a = parseFloat(dialog.angle), r = parseFloat(dialog.radius);
      if (!(a > 0 && a <= 180)) return "Enter an angle from 1 to 180°";
      if (!(r >= 0)) return "Enter an inside radius of 0 mm or more";
      return null;
    }
    if (dialog.type === "gear") {
      const m = parseFloat(dialog.module), z = Number(dialog.teeth), bore = parseFloat(dialog.bore) || 0, t = parseFloat(dialog.thickness);
      if (!(Number.isInteger(z) && z >= 8 && z <= 200)) return "Enter 8 to 200 teeth";
      if (!(t > 0)) return "Enter a thickness above 0 mm";
      if (bore >= m * (z - 2.5) - 2 * m) return `The bore must leave material under the teeth: under Ø${fmt(Math.max(0, m * (z - 4.5)))} mm`;
      return null;
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
      if (pickingRef.current && !DRAWN.includes(pickingRef.current)) {
        e.stopPropagation(); e.preventDefault();
        pressAt.current = null;
        return pickTap(e);
      }
      if (api.getAppState().activeTool.type !== "freedraw") { pressAt.current = null; return; }
      pressAt.current = { id: e.pointerId, x: e.clientX, y: e.clientY, still: performance.now() };
      strokeBy.current = e.pointerType || "mouse";
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
    if (api && !appState.newElement && !appState.multiElement) followNotes(api, elements, seen.current);   // not mid-stroke
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
      if (el && (held || autoSnap)) snapStroke(api, el, flash, held, strokeBy.current);
    }
    // A line just finished: tidy it, and if Centre line was waiting, make it the centre line.
    if (api && !appState.multiElement && !appState.newElement && !appState.editingLinearElement) {
      const done = elements.filter(e => e.type === "line" && !e.isDeleted && !isNote(e) && !tidyLines.has(e.id));
      if (!done.length) return;
      done.forEach(e => tidyLines.add(e.id));
      const fixed = new Map(done.map(e => [e.id, tidyLine(api, e)]).filter(([, t]) => t));
      const centre = DRAWN.includes(pickingRef.current) ? done[done.length - 1] : null;
      const bend = centre && pickingRef.current === "bend";
      if (centre) fixed.set(centre.id, bump({ ...(fixed.get(centre.id) || centre), strokeStyle: bend ? "dotted" : "dashed", strokeColor: BLUE, strokeWidth: 1,
        ...(bend ? { customData: { bend: { angle: 90, up: true, radius: sheetAt(api, centre) } } } : {}) }));
      let scene = api.getSceneElements().map(e => fixed.get(e.id) || e), merged = false, closedOne = false;
      for (const d of done) {
        const joined = d !== centre && joinLines(scene, scene.find(e => e.id === d.id));
        if (joined) { scene = joined.elements; merged = true; closedOne ||= joined.closed; }
      }
      if (fixed.size || merged) commit(api, scene);
      if (closedOne && !centre) flash("Outline closed");
      if (centre && bend) { setPick(null); setDialog({ type: "bend", line: centre.id, ...bendFields(fixed.get(centre.id).customData.bend) }); }
      else if (centre) { setPick(null); flash("Centre line added"); }
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
        : mode === "pocket" ? { feature: "pocket", depthMm: d, on: dialog.base.id }
        : { feature: "extrude", depthMm: d, material: dialog.material, process: dialog.process,
            ...(dialog.base ? { on: dialog.base.id, place: dialog.place } : {}) };
      if (mode === "extrude") lastPart.current = { material: dialog.material, process: dialog.process };
      applyPart(api, plan, edge ? { ...feature, topEdge: edge } : feature, flash);
    } else {
      const a = parseFloat(dialog.angle);
      if (!(a > 0 && a <= 360)) return flash("Enter an angle from 1 to 360°", "warn");
      if (!plan.axis) return flash("Draw a centre line beside the profile to revolve round it", "warn");
      if (plan.crossesAxis) return flash("The profile crosses the centre line. Keep it on one side to revolve", "warn");
      applyPart(api, plan, { feature: "revolve", angleDeg: a, material: dialog.material, process: dialog.process }, flash);
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
    lastHole.current = { kind: spec.kind, diameter: dialog.diameter, fastener: spec.fastener };
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
    const bendLine = mode === "bend" && sel.find(el => bendOf(el));
    if (bendLine) return setDialog({ type: "bend", line: bendLine.id, ...bendFields(bendOf(bendLine)) });
    setPick(mode);
  };

  // Bend: the angle, direction and inside radius of a bend line (Remove deletes it)
  const confirmBend = remove => {
    const line = live(api).find(e => e.id === dialog.line);
    if (!line) return setDialog(null);
    if (remove) { writeBend(api, line, null); flash("Bend removed"); return setDialog(null); }
    if (problem) return;
    const bend = { angle: parseFloat(dialog.angle), up: dialog.up === "up", radius: parseFloat(dialog.radius) };
    writeBend(api, line, bend);
    flash(sheetOf(api, line) ? `Bend ${dialog.up} ${fmt(bend.angle)}° R${fmt(bend.radius)}` : "Bend set. Mark the sheet it crosses as a Profile to fold it", sheetOf(api, line) ? "ok" : "warn");
    setDialog(null);
  };

  // Gear: an involute spur gear drawn at the tap, marked as a part of its thickness, with its bore
  const confirmGear = () => {
    if (problem) return;
    const m = parseFloat(dialog.module), z = parseInt(dialog.teeth, 10), bore = parseFloat(dialog.bore) || 0, t = parseFloat(dialog.thickness);
    const s = mmPerPx(api.getSceneElements()), at = dialog.at;
    const pts = gearPoints(m, z).map(([x, y]) => ({ x: at.x + x / s, y: at.y - y / s }));
    const [gear] = convertToExcalidrawElements([{ ...polyline(pts, true, {}), strokeColor: INK, strokeWidth: 1.5 }]);
    commit(api, [...api.getSceneElements(), { ...gear, customData: { gear: { module: m, teeth: z } } }]);
    const plan = planPart(api, [live(api).find(e => e.id === gear.id)], null);
    plan.axis = null;
    lastPart.current = { ...lastPart.current, material: dialog.material };
    applyPart(api, plan, { feature: "extrude", depthMm: t, material: dialog.material, process: defaultProcess(dialog.material) }, flash);
    if (bore > 0) {
      const profile = live(api).find(e => e.id === gear.id), box = profileBox(sheetFrame(api.getSceneElements()), profile);
      writeHole(api, profile, null, { kind: "through", diameter: bore, x: r2((box.maxX - box.minX) / 2), y: r2((box.maxY - box.minY) / 2) });
    }
    setDialog(null);
    flash(`Gear m${fmt(m)}, ${z} teeth: Ø${fmt(m * z)} pitch, Ø${fmt(m * (z + 2))} outside`);
  };

  // What the laptop made of the drawing: its weight, and what a shop would flag. Read once the laptop
  // has the latest drawing, and again a moment later, as building the part takes a little longer.
  useEffect(() => {
    if (link.state !== "live" || !bridgeRef.current) return;
    const read = async () => {
      const res = await fetch(server(`/api/model/info?session=${bridgeRef.current.session}`)).catch(() => null);
      if (res?.ok) setMade(await res.json());
      else if (res?.status === 404) setMade(null);
    };
    const t1 = setTimeout(read, 500), t2 = setTimeout(read, 1800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [link]);

  // A check points at a shape: select it and bring it into view.
  const showCheck = c => {
    const el = c.target && live(api).find(e => e.id === c.target);
    if (el) {
      api.updateScene({ appState: { selectedElementIds: { [el.id]: true } } });
      api.scrollToContent(el, { animate: true });
    }
    flash(c.message, c.level === "warn" ? "warn" : "ok");
  };

  // 3D file: download the live 3D model the laptop built from this drawing, or open it in the laptop's slicer.
  const modelOf = async () => {
    bridgeRef.current?.flush();
    const res = await fetch(server(`/api/model/info?session=${bridgeRef.current?.session}`)).catch(() => null);
    const info = res?.ok ? await res.json() : null;
    return info?.status === "ok" ? info : null;
  };
  const downloadModel = async () => {
    const format = dialog.format;
    if (!(await modelOf())) return flash("No 3D part yet. Draw a closed outline first", "warn");
    if (format === "svg") {   // the shop drawing opens in its own tab, to look at or print
      window.open(server(`/api/model?session=${bridgeRef.current.session}&format=svg`), "_blank");
      setDialog(null);
      return flash("Shop drawing opened");
    }
    const a = document.createElement("a");
    a.href = server(`/api/model?session=${bridgeRef.current.session}&format=${format}&download=1`);
    a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
    setDialog(null);
    flash(`${format.toUpperCase()} downloaded`);
  };
  const printModel = async () => {
    if (!(await modelOf())) return flash("No 3D part yet. Draw a closed outline first", "warn");
    const res = await fetch(server(`/api/print?session=${bridgeRef.current.session}`), { method: "POST" }).catch(() => null);
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
      {preview && <Preview session={() => bridgeRef.current?.session} onClose={() => setPreview(false)} />}
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
          <button onClick={() => setDialog({ type: "print", format: "stl" })} title="Download the 3D part, or print it">
            <span className="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS.Squares }} /><span>3D file</span>
          </button>
          <button onClick={() => setPreview(v => !v)} aria-pressed={preview} className={preview ? "on" : ""} title="Show the part in 3D beside the drawing">
            <span className="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS.Layers }} /><span>3D</span>
          </button>
        </div>
        {/* The laptop's side, on one line: whether it has the drawing, and what the part weighs.
            Shop checks fold into one row that opens the list. */}
        <div className="eng-send">
          <div className="eng-status">
            <p className={"eng-link " + link.state} role="status" aria-live="polite" title={link.text}><span>{link.text}</span></p>
            {made?.status === "ok" && !made.preview && (
              <span className="eng-mass" title={madeOf(made)}>{made.mass != null ? `${fmt(made.mass)} g` : `${fmt(made.volume / 1000)} cm³`}</span>
            )}
          </div>
          {made?.checks?.length > 0 && (
            <button type="button" className={"eng-checkrow " + (made.checks.some(c => c.level === "warn") ? "warn" : "note")}
              onClick={() => made.checks.length === 1 ? showCheck(made.checks[0]) : setDialog({ type: "checks" })}
              title={made.checks.length === 1 ? made.checks[0].message : undefined}>
              <span>{made.checks.length === 1 ? "1 shop check" : `${made.checks.length} shop checks`}</span>
              <span className="chev" aria-hidden="true">›</span>
            </button>
          )}
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
          <Seg label="Feature" options={dialog.base ? { boss: "Boss", pocket: "Pocket", extrude: "New part", revolve: "Revolve" } : { extrude: "Extrude", revolve: "Revolve" }}
            value={dialog.mode} onChange={m => setDialog(d => ({ ...d, mode: m }))} />
          {dialog.mode === "extrude" && dialog.base && (
            <Seg label="Placed" options={{ top: "On top", inside: "Set inside" }} value={dialog.place} onChange={v => setDialog(d => ({ ...d, place: v }))} />
          )}
          {["extrude", "revolve"].includes(dialog.mode) && (
            <div className="eng-row">
              <Pick label="Material" value={dialog.material} options={Object.fromEntries(Object.entries(MATERIALS).map(([k, m]) => [k, m.name]))}
                onChange={v => setDialog(d => ({ ...d, material: v, process: d.process === defaultProcess(d.material) ? defaultProcess(v) : d.process }))} />
              <Pick label="Made by" value={dialog.process} options={PROCESSES} onChange={v => setDialog(d => ({ ...d, process: v }))} />
            </div>
          )}
          {dialog.mode === "revolve" ? <Num label="Angle (°)" {...field("angle")} />
            : <Num label={dialog.mode === "boss" ? "Height (mm)" : dialog.mode === "extrude" ? "Thickness (mm)" : "Depth (mm)"} autoFocus {...field("depth")} />}
          {dialog.mode === "extrude" && MATERIALS[dialog.material].stock.length > 0 && (
            <div className="eng-chips" role="group" aria-label="Stock thicknesses">
              {MATERIALS[dialog.material].stock.map(t => (
                <button type="button" key={t} className={parseFloat(dialog.depth) === t ? "on" : ""}
                  onClick={() => setDialog(d => ({ ...d, depth: String(t) }))}>{t}</button>
              ))}
            </div>
          )}
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
              : dialog.mode === "extrude" && dialog.base ? (dialog.place === "inside"
                ? "A separate part set into the one it is drawn on, which is cut to fit and shows see-through in 3D"
                : "A separate part in its own material, layered on top of the one it is drawn on")
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
          <Seg label="Hole type" options={HOLE_KINDS} value={dialog.kind}
            onChange={k => setDialog(d => ({ ...d, kind: k, size: k === "tapped" && d.size === "custom" ? "M5" : d.size, depth: k === "tapped" ? "" : d.depth }))} />
          <div className="eng-row">
            <Pick label={dialog.kind === "tapped" ? "Thread" : "Fastener"} value={dialog.size} onChange={v => setDialog(d => ({ ...d, size: v }))}
              options={{ ...(dialog.kind === "tapped" ? {} : { custom: "Custom size" }), ...Object.fromEntries(Object.keys(FASTENERS).map(m => [m, m])) }} />
            {dialog.size === "custom" && <Num label="Diameter (mm)" autoFocus {...field("diameter")} />}
            {dialog.kind === "blind" && <Num label="Depth (mm)" {...field("depth")} />}
            {dialog.kind === "tapped" && <Num label="Thread depth (blank: through)" {...field("depth")} />}
            {dialog.kind === "countersink" && dialog.size === "custom" && <Num label="Countersink Ø" {...field("cskDiameter")} />}
          </div>
          {dialog.kind === "counterbore" && dialog.size === "custom" && (
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
          <Seg label="Format" options={{ stl: "STL", "3mf": "3MF", step: "STEP", dxf: "DXF", svg: "Drawing" }} value={dialog.format} onChange={f => setDialog(d => ({ ...d, format: f }))} />
          {note({ step: "STEP keeps exact curves, for CNC and other CAD programs", dxf: "The flat profile for laser, waterjet or plasma; a bent part's flat pattern with its bend lines",
            svg: "A shop drawing: sizes, hole table, material and notes, ready to print" }[dialog.format] || "For a slicer and a 3D printer")}
        </Dialog>
      )}

      {dialog?.type === "checks" && made?.checks && (
        <Dialog onClose={close} label="Checks" onSubmit={close} actions={<button type="submit" className="primary">Done</button>}>
          <ul className="eng-checks wide" aria-label="Manufacturing checks">
            {made.checks.map((c, i) => (
              <li key={i}><button type="button" className={c.level} onClick={() => { setDialog(null); showCheck(c); }}>{c.message}</button></li>
            ))}
          </ul>
          {note("Tap a check to see the shape it is about")}
        </Dialog>
      )}

      {dialog?.type === "bend" && (
        <Dialog onClose={close} label="Bend" onSubmit={() => confirmBend(false)}
          actions={<>
            <button type="button" className="danger" onClick={() => confirmBend(true)}>Remove</button>
            <button type="button" onClick={close}>Cancel</button>
            <button type="submit" className="primary" disabled={!!problem}>Set</button>
          </>}>
          <Seg label="Direction" options={{ up: "Up", down: "Down" }} value={dialog.up} onChange={v => setDialog(d => ({ ...d, up: v }))} />
          <div className="eng-row">
            <Num label="Angle (°)" autoFocus {...field("angle")} />
            <Num label="Inside radius (mm)" {...field("radius")} />
          </div>
          {note("The side with less sheet folds, round the line, as on a press brake")}
        </Dialog>
      )}

      {dialog?.type === "gear" && (
        <Dialog onClose={close} label="Spur gear" onSubmit={confirmGear}
          actions={<><button type="button" onClick={close}>Cancel</button><button type="submit" className="primary" disabled={!!problem}>Add gear</button></>}>
          <div className="eng-row">
            <Pick label="Module" value={dialog.module} options={{ "0.5": "0.5", 1: "1", "1.5": "1.5", 2: "2", "2.5": "2.5", 3: "3", 4: "4" }}
              onChange={v => setDialog(d => ({ ...d, module: v }))} />
            <Num label="Teeth" autoFocus {...field("teeth")} />
          </div>
          <div className="eng-row">
            <Num label="Bore Ø (mm)" {...field("bore")} />
            <Num label="Thickness (mm)" {...field("thickness")} />
          </div>
          <Pick label="Material" value={dialog.material} options={Object.fromEntries(Object.entries(MATERIALS).map(([k, m]) => [k, m.name]))}
            onChange={v => setDialog(d => ({ ...d, material: v }))} />
          {note(`Pitch Ø${fmt(parseFloat(dialog.module) * parseInt(dialog.teeth, 10) || 0)} mm, outside Ø${fmt(parseFloat(dialog.module) * ((parseInt(dialog.teeth, 10) || 0) + 2))} mm. Gears that mesh share a module`)}
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
        <div className="eng-hint">{MOUSE
          ? "Draw the part's outline with the pen tool and the mouse or trackpad. Lines, arcs, circles, rectangles and outlines whose ends meet straighten when you let go, and sides that meet join up."
          : "Draw the part's outline with the Pencil. Lines, arcs, circles and rectangles straighten as you lift, and sides that meet join up. Hold still at the end for any straight-sided outline."}</div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
