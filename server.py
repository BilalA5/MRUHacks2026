import base64
import json
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles

# Paths are absolute so the server works no matter which folder it starts from
ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
SKETCH_DIR = ROOT / "sketches"

app = FastAPI()

@app.get("/api/health")
async def health():
    return {"ok": True}

@app.post("/api/sketch")
async def sketch(request: Request):
    payload = await request.json()
    strokes = payload.get("strokes", [])
    png_url = payload.get("png", "")
    if not png_url.startswith("data:image/png;base64,"):
        raise HTTPException(status_code=400, detail="png must be a PNG data URL")
    try:
        png_bytes = base64.b64decode(png_url.split(",", 1)[1])
    except ValueError:
        raise HTTPException(status_code=400, detail="png data is not valid base64")

    # Save each sketch so the team can inspect what the canvas sent
    SKETCH_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    (SKETCH_DIR / f"{stamp}.png").write_bytes(png_bytes)
    (SKETCH_DIR / f"{stamp}.json").write_text(
        json.dumps({"meta": payload.get("meta", {}), "strokes": strokes}, indent=2)
    )
    print(f"[sketch] saved {stamp}: {len(strokes)} strokes, {len(png_bytes)} PNG bytes")
    # Next step (later): send the PNG and strokes to the AI model
    return {"ok": True, "strokes": len(strokes), "saved": f"sketches/{stamp}.png"}

# Serves web/index.html at "/" (must stay last so the /api routes win)
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
