// Drawing board: Excalidraw (MIT, https://github.com/excalidraw/excalidraw) with a Send button.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

function App() {
  const [api, setApi] = useState(null);
  const [message, setMessage] = useState("");

  const send = async () => {
    if (!api) return;
    const elements = api.getSceneElements().filter(el => !el.isDeleted);
    if (!elements.length) { setMessage("Draw something first"); return; }
    setMessage("Sending…");
    try {
      const blob = await exportToBlob({
        elements,
        files: api.getFiles(),
        appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
        mimeType: "image/png",
      });
      const res = await fetch("/api/sketch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ png: await blobToDataUrl(blob), strokes: elements }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      setMessage("Sent to laptop");
    } catch (err) {
      setMessage("Could not reach laptop. Check Wi-Fi and try again.");
    }
    setTimeout(() => setMessage(""), 2500);
  };

  return (
    <div className="board">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={{ appState: { viewBackgroundColor: "#ffffff", currentItemStrokeWidth: 2 } }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, changeViewBackgroundColor: false, clearCanvas: true } }}
      />
      <div className="send-bar">
        {message && <span className="send-msg">{message}</span>}
        <button className="send-btn" onClick={send} disabled={!api}>Send</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
