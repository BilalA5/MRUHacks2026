// Engineering board built on Excalidraw (MIT, https://github.com/excalidraw/excalidraw).
// Excalidraw supplies the canvas, tools and undo. This file adds the grid and the engineering tools.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, convertToExcalidrawElements as toElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

const PAPER = "#FBFBF7";        // drawing paper
const INK = "#1F2A36";          // graphite lines
const BLUE = "#2563EB";         // dimensions and centre lines
const GRID = 20;                // grid cell in scene px
const MM_PER_PX = 0.25;         // calibration: one 20 px grid cell = 5 mm. Change here to recalibrate.

// Engineering drawings use straight lines and a clean font, not Excalidraw's hand-sketched style.
const CLEAN = { roughness: 0, fontFamily: 2 };   // font 2 = Helvetica-style
const convertToExcalidrawElements = skeletons => toElements(skeletons.map(s => ({ ...CLEAN, ...s })));

// Centre of what is on screen, in scene coordinates.
function screenCentre(api) {
  const s = api.getAppState();
  return { x: -s.scrollX + s.width / (2 * s.zoom.value), y: -s.scrollY + s.height / (2 * s.zoom.value) };
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

function App() {
  const [api, setApi] = useState(null);
  const [message, setMessage] = useState("");
  const [gridOn, setGridOn] = useState(true);

  const flash = text => {
    setMessage(text);
    setTimeout(() => setMessage(""), 2200);
  };

  // Adds elements to the scene and keeps existing ones as they are.
  const addElements = els => api.updateScene({ elements: [...api.getSceneElements(), ...els] });
  const selectedLines = () => {
    const ids = api.getAppState().selectedElementIds;
    return api.getSceneElements().filter(el => ids[el.id] && (el.type === "line" || el.type === "arrow"));
  };

  const centreLine = () => {
    const c = screenCentre(api);
    addElements(convertToExcalidrawElements([
      { type: "line", x: c.x - 200, y: c.y, points: [[0, 0], [400, 0]], strokeStyle: "dashed", strokeColor: BLUE, strokeWidth: 1 },
    ]));
  };

  // Dimension: a dimension line with ticks and the length in mm, offset from each selected line.
  const dimension = () => {
    const lines = selectedLines();
    if (!lines.length) return flash("Select a line first");
    const els = [];
    for (const el of lines) {
      const first = el.points[0], last = el.points[el.points.length - 1];
      const p1 = { x: el.x + first[0], y: el.y + first[1] }, p2 = { x: el.x + last[0], y: el.y + last[1] };
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
    if (els.length) addElements(els);
  };

  // Hatch: give each selected closed shape a hachure fill.
  const hatch = () => {
    const ids = api.getAppState().selectedElementIds;
    const scene = api.getSceneElements();
    let changed = 0;
    const next = scene.map(el => {
      if (!ids[el.id] || !["rectangle", "ellipse", "diamond"].includes(el.type)) return el;
      changed++;
      return { ...el, fillStyle: "hachure", backgroundColor: "#DDE3EE", version: el.version + 1, versionNonce: Math.floor(Math.random() * 1e9) };
    });
    if (!changed) return flash("Select a rectangle, ellipse or diamond first");
    api.updateScene({ elements: next });
  };

  // Shared helpers for the editing tools below.
  const rnd = () => Math.floor(Math.random() * 1e9);
  const bump = el => ({ ...el, version: el.version + 1, versionNonce: rnd() });
  const endsOf = el => {
    const a = el.points[0], b = el.points[el.points.length - 1];
    return [{ x: el.x + a[0], y: el.y + a[1] }, { x: el.x + b[0], y: el.y + b[1] }];
  };
  const withEnds = (el, p1, p2) => bump({ ...el, x: p1.x, y: p1.y, points: [[0, 0], [p2.x - p1.x, p2.y - p1.y]] });

  // Constrain: a selected line snaps to 0, 45, 90 or 135 degrees when within 5 degrees,
  // and each end joins an existing line end within 10 px.
  const constrain = () => {
    const sel = selectedLines();
    if (!sel.length) return flash("Select a line first");
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
  };

  // Offset: a parallel copy of each selected line, or an inset copy of each rectangle, 20 px away.
  const OFFSET = 20;
  const offset = () => {
    const ids = api.getAppState().selectedElementIds;
    const out = [];
    for (const el of api.getSceneElements()) {
      if (!ids[el.id] || el.isDeleted) continue;
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
    if (!out.length) return flash("Select a line or rectangle first");
    addElements(out);
  };

  // DXF: download the sheet as a CAD file.
  const exportDxf = () => {
    const url = URL.createObjectURL(new Blob([toDxf(api.getSceneElements())], { type: "application/dxf" }));
    const a = document.createElement("a");
    a.href = url; a.download = "drawing.dxf";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash("DXF downloaded");
  };

  // Undo and redo use Excalidraw's own history, so its disabled states and shortcuts stay in step.
  const clickExcalidraw = label => {
    const b = document.querySelector(`button[aria-label="${label}"]`);
    if (b && !b.disabled) b.click();
  };

  const toggleGrid = () => {
    const on = !gridOn;
    setGridOn(on);
    api.updateScene({ appState: { gridModeEnabled: on } });
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
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, changeViewBackgroundColor: false, clearCanvas: true } }}
      />
      <div className="eng-tools" role="toolbar" aria-label="Engineering tools">
        <button onClick={() => clickExcalidraw("Undo")}>Undo</button>
        <button onClick={() => clickExcalidraw("Redo")}>Redo</button>
        <button onClick={centreLine}>Centre line</button>
        <button onClick={dimension}>Dimension</button>
        <button onClick={hatch}>Hatch</button>
        <button onClick={constrain}>Constrain</button>
        <button onClick={offset}>Offset</button>
        <button onClick={exportDxf}>Export DXF</button>
        <button className={gridOn ? "on" : ""} onClick={toggleGrid} aria-pressed={gridOn}>Snap grid</button>
        {message && <span className="eng-msg" role="status">{message}</span>}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
