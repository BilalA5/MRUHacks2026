// Engineering board built on Excalidraw (MIT, https://github.com/excalidraw/excalidraw).
// Excalidraw supplies the canvas, tools and undo. This file adds the drawing sheet, the grid,
// the title block, engineering quick tools, and the Send button.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, exportToBlob, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

const PAPER = "#FBFBF7";        // drawing paper
const INK = "#1F2A36";          // graphite lines
const BLUE = "#2563EB";         // dimensions and centre lines
const GRID = 20;                // grid cell in scene px
const MM_PER_PX = 0.25;         // calibration: one 20 px grid cell = 5 mm. Change here to recalibrate.
const SHEET = { x: 0, y: 0, w: 1123, h: 794 };   // A4 landscape at 96 dpi

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

// Centre of what is on screen, in scene coordinates.
function screenCentre(api) {
  const s = api.getAppState();
  return { x: -s.scrollX + s.width / (2 * s.zoom.value), y: -s.scrollY + s.height / (2 * s.zoom.value) };
}

function sheetElements() {
  return convertToExcalidrawElements([
    { type: "rectangle", x: SHEET.x, y: SHEET.y, width: SHEET.w, height: SHEET.h, strokeColor: INK, strokeWidth: 1.5, backgroundColor: "transparent" },
  ]);
}

// Title block in the bottom-right corner of the sheet: Part, Drawing no., Drawn by, Date.
function titleBlockElements() {
  const w = 320, h = 110;
  const x = SHEET.x + SHEET.w - w - 24, y = SHEET.y + SHEET.h - h - 24;
  const label = (text, dx, dy) => ({ type: "text", x: x + dx, y: y + dy, text, fontSize: 12, strokeColor: "#65717C" });
  return convertToExcalidrawElements([
    { type: "rectangle", x, y, width: w, height: h, strokeColor: INK, strokeWidth: 1, backgroundColor: "transparent" },
    { type: "line", x, y: y + 36, points: [[0, 0], [w, 0]], strokeColor: INK, strokeWidth: 1 },
    { type: "line", x, y: y + 73, points: [[0, 0], [w, 0]], strokeColor: INK, strokeWidth: 1 },
    { type: "line", x: x + 200, y, points: [[0, 0], [0, h]], strokeColor: INK, strokeWidth: 1 },
    label("Part", 8, 6),
    label("Drawing no.", 208, 6),
    label("Drawn by", 8, 43),
    label("Date", 208, 43),
  ].map(el => el.type === "text" ? { ...el } : el));
}

function App() {
  const [api, setApi] = useState(null);
  const [message, setMessage] = useState("");
  const [gridOn, setGridOn] = useState(true);

  const flash = text => {
    setMessage(text);
    setTimeout(() => setMessage(""), 2200);
  };

  // Put the sheet and title block on an empty board, once.
  useEffect(() => {
    if (!api || api.getSceneElements().length) return;
    api.updateScene({ elements: [...sheetElements(), ...titleBlockElements()] });
  }, [api]);

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

  const toggleGrid = () => {
    const on = !gridOn;
    setGridOn(on);
    api.updateScene({ appState: { gridModeEnabled: on } });
  };

  const send = async () => {
    if (!api) return;
    const elements = api.getSceneElements().filter(el => !el.isDeleted);
    if (!elements.length) return flash("Draw something first");
    flash("Sending…");
    try {
      const blob = await exportToBlob({
        elements,
        files: api.getFiles(),
        appState: { exportBackground: true, viewBackgroundColor: PAPER },
        mimeType: "image/png",
      });
      const res = await fetch("/api/sketch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ png: await blobToDataUrl(blob), strokes: elements }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      flash("Sent to laptop");
    } catch (err) {
      flash("Could not reach laptop. Check Wi-Fi and try again.");
    }
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
          },
        }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, changeViewBackgroundColor: false, clearCanvas: true } }}
      />
      <div className="eng-tools" role="toolbar" aria-label="Engineering tools">
        <button onClick={centreLine}>Centre line</button>
        <button onClick={dimension}>Dimension</button>
        <button onClick={hatch}>Hatch</button>
        <button className={gridOn ? "on" : ""} onClick={toggleGrid} aria-pressed={gridOn}>Snap grid</button>
      </div>
      <div className="send-bar">
        {message && <span className="send-msg" role="status">{message}</span>}
        <button className="send-btn" onClick={send} disabled={!api}>Send</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
