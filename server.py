from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

app = FastAPI()

@app.get("/api/health")
async def health():
    return {"ok": True}

@app.post("/api/sketch")
async def sketch(request: Request):
    payload = await request.json()
    strokes = payload.get("strokes", [])
    png = payload.get("png", "")
    print(f"[sketch] received {len(strokes)} strokes, png {len(png)} chars")
    # Next step (later): send the PNG and strokes to the AI model
    return {"ok": True, "strokes": len(strokes)}

# Serves web/index.html at "/" (must stay last so the /api routes win)
app.mount("/", StaticFiles(directory="web", html=True), name="web")
