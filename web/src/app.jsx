// Engineering board built on Excalidraw (MIT, https://github.com/excalidraw/excalidraw).
// Excalidraw supplies the canvas, tools and undo. This file adds a sidebar of engineering tools.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, convertToExcalidrawElements as toElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { ICONS } from "./icons.js";

const PAPER = "#FBFBF7";        // drawing paper
const INK = "#1F2A36";          // graphite lines
const BLUE = "#2563EB";         // dimensions, marks and centre lines
const GRID = 20;                // grid cell in scene px
const MM_PER_PX = 0.25;         // calibration: one 20 px grid cell = 5 mm. Change here to recalibrate.

// Engineering drawings use straight lines and a clean font, not Excalidraw's hand-sketched style.
const CLEAN = { roughness: 0, fontFamily: 2 };
const convertToExcalidrawElements = skeletons => toElements(skeletons.map(s => ({ ...CLEAN, ...s })));

const rnd = () => Math.floor(Math.random() * 1e9);
const bump = el => ({ ...el, version: el.version + 1, versionNonce: rnd() });
const endsOf = el => {
  const a = el.points[0], b = el.points[el.points.length - 1];
  return [{ x: el.x + a[0], y: el.y + a[1] }, { x: el.x + b[0], y: el.y + b[1] }];
};
const withEnds = (el, p1, p2) => bump({ ...el, x: p1.x, y: p1.y, points: [[0, 0], [p2.x - p1.x, p2.y - p1.y]] });

const selected = api => {
  const ids = api.getAppState().selectedElementIds;
  return api.getSceneElements().filter(el => ids[el.id] && !el.isDeleted);
};
const selectedOfType = (api, types) => selected(api).filter(el => types.includes(el.type));

// Centre of what is on screen, in scene coordinates.
function screenCentre(api) {
  const s = api.getAppState();
  return { x: -s.scrollX + s.width / (2 * s.zoom.value), y: -s.scrollY + s.height / (2 * s.zoom.value) };
}

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
  const minX = Math.min(...pts.map(p => p.x)), minY = Math.min(...pts.map(p => p.y));
  return { type: "line", x: minX, y: minY, points: pts.map(p => [p.x - minX, p.y - minY]), ...style };
}

// DXF export: lines, arrows, rectangles, ellipses and text, in mm with Y up.
// Plain R12-style entities that AutoCAD, Fusion and most CAD programs open.
function toDxf(elements) {
  const out = [];
  const ent = (type, pairs) => { out.push("0", type); pairs.forEach(([code, val]) => out.push(String(code), String(val))); };
  const X = x => x * MM_PER_PX, Y = y => -y * MM_PER_PX;
  const poly = (pts, closed) => {
    ent("LWPOLYLINE", [[8, 0], [90, pts.length], [70, closed ? 1 : 0], ...pts.flatMap(([x, y]) => [[10, X(x).toFixed(3)], [20, Y(y).toFixed(3)]])]);
  };
  for (const el of elements) {
    if (el.isDeleted) continue;
    if (el.type === "line" || el.type === "arrow" || el.type === "freedraw") {
      const pts = el.points.map(([px, py]) => [el.x + px, el.y + py]);
      if (pts.length >= 2) poly(pts, false);
    } else if (el.type === "rectangle") {
      poly([[el.x, el.y], [el.x + el.width, el.y], [el.x + el.width, el.y + el.height], [el.x, el.y + el.height]], true);
    } else if (el.type === "ellipse") {
      const cx = el.x + el.width / 2, cy = el.y + el.height / 2, rx = el.width / 2, ry = el.height / 2;
      if (Math.abs(el.width - el.height) < 1) {
        ent("CIRCLE", [[8, 0], [10, X(cx).toFixed(3)], [20, Y(cy).toFixed(3)], [40, X(rx).toFixed(3)]]);
      } else {
        poly(Array.from({ length: 48 }, (_, i) => [cx + rx * Math.cos(i / 48 * 2 * Math.PI), cy + ry * Math.sin(i / 48 * 2 * Math.PI)]), true);
      }
    } else if (el.type === "text") {
      ent("TEXT", [[8, 0], [10, X(el.x).toFixed(3)], [20, Y(el.y + el.fontSize).toFixed(3)], [40, (el.fontSize * MM_PER_PX).toFixed(3)], [1, el.text]]);
    }
  }
  return ["0", "SECTION", "2", "ENTITIES", ...out, "0", "ENDSEC", "0", "EOF", ""].join("\n");
}

// ---- Tools. Each one reports what it did, or why it could not run. ----

function centreLine(api, flash) {
  const c = screenCentre(api);
  api.updateScene({ elements: [...api.getSceneElements(), ...convertToExcalidrawElements([
    { type: "line", x: c.x - 200, y: c.y, points: [[0, 0], [400, 0]], strokeStyle: "dashed", strokeColor: BLUE, strokeWidth: 1 },
  ])] });
  flash("Centre line added");
}

// Centre mark: a small cross at the centre of each selected circle or rectangle.
function centreMark(api, flash) {
  const shapes = selectedOfType(api, ["ellipse", "rectangle"]);
  if (!shapes.length) return flash("Select a circle or rectangle first", "warn");
  const els = [];
  for (const el of shapes) {
    const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
    els.push(...convertToExcalidrawElements([
      { type: "line", x: cx - 12, y: cy, points: [[0, 0], [24, 0]], strokeColor: BLUE, strokeWidth: 1 },
      { type: "line", x: cx, y: cy - 12, points: [[0, 0], [0, 24]], strokeColor: BLUE, strokeWidth: 1 },
    ]));
  }
  api.updateScene({ elements: [...api.getSceneElements(), ...els] });
  flash(`Centre mark on ${shapes.length} shape${shapes.length > 1 ? "s" : ""}`);
}

// Mirror: reflect the selected lines, arrows, rectangles and ellipses across the selected dashed centre line.
function mirror(api, flash) {
  const axis = selected(api).find(el => el.type === "line" && el.strokeStyle === "dashed");
  if (!axis) return flash("Select a dashed centre line and the shapes to mirror", "warn");
  const [a, b] = endsOf(axis);
  const d = { x: b.x - a.x, y: b.y - a.y };
  const targets = selected(api).filter(el => el !== axis && ["line", "arrow", "rectangle", "ellipse"].includes(el.type));
  if (!targets.length) return flash("Select the shapes to mirror as well", "warn");
  const made = targets.map(el => {
    const style = { strokeColor: el.strokeColor, strokeWidth: el.strokeWidth };
    if (el.type === "line" || el.type === "arrow") {
      const pts = endsOf(el).map(p => reflect(p, a, d));
      return polyline(pts, false, style);
    }
    if (el.type === "rectangle") {
      const corners = [[el.x, el.y], [el.x + el.width, el.y], [el.x + el.width, el.y + el.height], [el.x, el.y + el.height]]
        .map(([x, y]) => reflect({ x, y }, a, d));
      return polyline(corners, true, style);
    }
    const cx = el.x + el.width / 2, cy = el.y + el.height / 2, rx = el.width / 2, ry = el.height / 2;
    const ring = Array.from({ length: 48 }, (_, i) => reflect({ x: cx + rx * Math.cos(i / 48 * 2 * Math.PI), y: cy + ry * Math.sin(i / 48 * 2 * Math.PI) }, a, d));
    return polyline(ring, true, style);
  });
  api.updateScene({ elements: [...api.getSceneElements(), ...convertToExcalidrawElements(made)] });
  flash(`Mirrored ${made.length} item${made.length > 1 ? "s" : ""}`);
}

// Dimension: a dimension line with ticks and the length in mm, offset from each selected line.
function dimension(api, flash) {
  const lines = selectedOfType(api, ["line", "arrow", "freedraw"]);
  if (!lines.length) return flash("Select a line or pen stroke first", "warn");
  const els = [];
  for (const el of lines) {
    const [p1, p2] = endsOf(el);
    const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy);
    if (!len) continue;
    const nx = -dy / len * 24, ny = dx / len * 24;
    const mm = (len * MM_PER_PX).toFixed(1);
    const mid = { x: (p1.x + p2.x) / 2 + nx, y: (p1.y + p2.y) / 2 + ny };
    els.push(...convertToExcalidrawElements([
      { type: "line", x: p1.x, y: p1.y, points: [[0, 0], [nx * 1.2, ny * 1.2]], strokeColor: BLUE, strokeWidth: 1 },
      { type: "line", x: p2.x, y: p2.y, points: [[0, 0], [nx * 1.2, ny * 1.2]], strokeColor: BLUE, strokeWidth: 1 },
      { type: "arrow", x: p1.x + nx, y: p1.y + ny, points: [[0, 0], [dx, dy]], startArrowhead: "bar", endArrowhead: "bar", strokeColor: BLUE, strokeWidth: 1 },
      { type: "text", x: mid.x - 22, y: mid.y - 22, text: `${mm} mm`, fontSize: 14, strokeColor: BLUE },
    ]));
  }
  if (!els.length) return flash("Selected line has no length", "warn");
  api.updateScene({ elements: [...api.getSceneElements(), ...els] });
  flash("Dimension added");
}

// Diameter: a leader and "Ø mm" label on each selected circle.
function diameter(api, flash) {
  // Hand-drawn circles are rarely exact, so anything within 15% of round counts.
  const circles = selectedOfType(api, ["ellipse"]).filter(el => Math.min(el.width, el.height) / Math.max(el.width, el.height) >= 0.85);
  if (!circles.length) return flash("Select a circle or ellipse first", "warn");
  const els = [];
  for (const el of circles) {
    const r = (el.width + el.height) / 4, cx = el.x + el.width / 2, cy = el.y + el.height / 2;
    const edge = { x: cx + r * Math.SQRT1_2, y: cy - r * Math.SQRT1_2 };
    const end = { x: edge.x + 28, y: edge.y - 28 };
    const mm = (2 * r * MM_PER_PX).toFixed(1);
    els.push(...convertToExcalidrawElements([
      { type: "line", x: edge.x, y: edge.y, points: [[0, 0], [28, -28]], strokeColor: BLUE, strokeWidth: 1 },
      { type: "text", x: end.x + 4, y: end.y - 22, text: `Ø ${mm} mm`, fontSize: 14, strokeColor: BLUE },
    ]));
  }
  api.updateScene({ elements: [...api.getSceneElements(), ...els] });
  flash("Diameter added");
}

// Hatch: give each selected closed shape a hachure fill.
function hatch(api, flash) {
  const ids = api.getAppState().selectedElementIds;
  const shapes = api.getSceneElements().filter(el => ids[el.id] && ["rectangle", "ellipse", "diamond"].includes(el.type));
  if (!shapes.length) return flash("Select a rectangle, ellipse or diamond first", "warn");
  api.updateScene({
    elements: api.getSceneElements().map(el => ids[el.id] && ["rectangle", "ellipse", "diamond"].includes(el.type)
      ? { ...el, fillStyle: "hachure", backgroundColor: "#DDE3EE", version: el.version + 1, versionNonce: rnd() }
      : el),
  });
  flash("Hatched");
}

// Constrain: a selected line snaps to 0, 45, 90 or 135 degrees when within 5 degrees,
// and each end joins an existing line end within 10 px.
function constrain(api, flash) {
  const sel = selectedOfType(api, ["line", "arrow"]);
  if (!sel.length) return flash("Select a line first", "warn");
  const ids = new Set(sel.map(el => el.id));
  const anchors = api.getSceneElements()
    .filter(el => !el.isDeleted && !ids.has(el.id) && (el.type === "line" || el.type === "arrow"))
    .flatMap(endsOf);
  const join = p => {
    let best = null, bestD = 10;
    for (const a of anchors) { const d = Math.hypot(a.x - p.x, a.y - p.y); if (d < bestD) { bestD = d; best = a; } }
    return best || p;
  };
  const fixed = new Map(sel.map(el => {
    const [p1, p2] = endsOf(el);
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const step = Math.PI / 4;
    let ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const near = Math.round(ang / step) * step;
    if (Math.abs(ang - near) < 5 * Math.PI / 180) ang = near;
    const end = { x: p1.x + Math.cos(ang) * len, y: p1.y + Math.sin(ang) * len };
    return [el.id, withEnds(el, join(p1), join(end))];
  }));
  api.updateScene({ elements: api.getSceneElements().map(el => fixed.get(el.id) || el) });
  flash("Constrained");
}

// Offset: a parallel copy of each selected line, or an inset copy of each rectangle, 20 px away.
function offset(api, flash) {
  const OFFSET = 20;
  const out = [];
  for (const el of selected(api)) {
    if (el.type === "rectangle" && el.width > 2 * OFFSET && el.height > 2 * OFFSET) {
      out.push(...convertToExcalidrawElements([{ type: "rectangle", x: el.x + OFFSET, y: el.y + OFFSET, width: el.width - 2 * OFFSET, height: el.height - 2 * OFFSET, strokeColor: el.strokeColor, strokeWidth: el.strokeWidth, backgroundColor: "transparent" }]));
    } else if (el.type === "line" || el.type === "arrow") {
      const [p1, p2] = endsOf(el);
      const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy);
      if (!len) continue;
      const nx = -dy / len * OFFSET, ny = dx / len * OFFSET;
      out.push(...convertToExcalidrawElements([{ type: "line", x: p1.x + nx, y: p1.y + ny, points: [[0, 0], [dx, dy]], strokeColor: el.strokeColor, strokeWidth: el.strokeWidth }]));
    }
  }
  if (!out.length) return flash("Select a line or rectangle first", "warn");
  api.updateScene({ elements: [...api.getSceneElements(), ...out] });
  flash("Offset copy added");
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
    { label: "Centre mark", icon: "Plus", run: centreMark },
    { label: "Mirror", icon: "Mirror", run: mirror },
  ] },
  { title: "Dimensions", items: [
    { label: "Dimension", icon: "Frame2", run: dimension },
    { label: "Diameter", icon: "Frame", run: diameter },
  ] },
  { title: "Edit", items: [
    { label: "Hatch", icon: "Hashtag", run: hatch },
    { label: "Constrain", icon: "VectorSquare", run: constrain },
    { label: "Offset", icon: "Squares", run: offset },
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

  // Debug handle: lets the browser console inspect and drive the board.
  useEffect(() => { window.board = api; }, [api]);

  // Every tool reports through here. kind is "ok" or "warn" (the tool could not run).
  const flash = (text, kind = "ok") => {
    setToast({ id: Date.now(), text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  };

  const run = (item) => {
    if (!api) return;
    item.run(api, flash);
  };

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
            currentItemFontFamily: 2,
          },
        }}
        onChange={(_, appState) => setGridOn(!!appState.gridModeEnabled)}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, changeViewBackgroundColor: false, clearCanvas: true } }}
      />
      <aside className="eng-side" aria-label="Engineering tools">
        {SECTIONS.map(section => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            {section.items.map(item => {
              const pressed = item.toggle ? gridOn : undefined;
              return (
                <button
                  key={item.label}
                  onClick={() => run(item)}
                  aria-pressed={pressed}
                  className={item.toggle && gridOn ? "on" : ""}
                >
                  <span className="ico" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[item.icon] }} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </section>
        ))}
      </aside>
      {toast && <div key={toast.id} className={"eng-toast " + toast.kind} role="status" aria-live="polite">{toast.text}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
