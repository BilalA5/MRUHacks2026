import asyncio
import base64
import json
import re
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import handoff
import model

# Paths are absolute so the server works no matter which folder it starts from
ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
SESSION_DIR = ROOT / "sessions"

app = FastAPI()

latest = {}          # session -> its newest snapshot
newest = None        # the session that sent most recently
listeners = set()    # one queue per open /api/stream
loop = None          # the server's event loop, so the model worker can publish to it


@app.on_event("startup")
async def startup():
    global loop
    loop = asyncio.get_running_loop()


# The 3D model follows the stream: every snapshot goes to the builder, which publishes a "model" event.
# It runs in its own thread, so it hands events to the event loop rather than touching the queues itself.
def on_model(info):
    if loop:
        loop.call_soon_threadsafe(publish, "model", info)

builder = model.LiveBuilder(SESSION_DIR, on_model=on_model)


# After a restart, pick up each session's newest snapshot from disk
def restore():
    global newest
    for path in SESSION_DIR.glob("*/latest.json"):
        snap = json.loads(path.read_text())
        latest[snap["session"]] = snap
        if newest is None or snap["receivedAt"] > latest[newest]["receivedAt"]:
            newest = snap["session"]
    if newest:
        builder.submit(latest[newest])

restore()


async def read_payload(request):
    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="body is not valid JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    session, seq = payload.get("session"), payload.get("seq")
    # The session names a folder, so only short plain names are allowed
    if not (isinstance(session, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,32}", session)):
        raise HTTPException(status_code=400, detail="session must be 1-32 letters, digits, - or _")
    if not (type(seq) is int and seq > 0):
        raise HTTPException(status_code=400, detail="seq must be a positive integer")
    if not isinstance(payload.get("elements"), list):
        raise HTTPException(status_code=400, detail="elements must be a list")
    if not isinstance(payload.get("part"), dict):
        raise HTTPException(status_code=400, detail="part must be an object")
    return payload


def publish(event, data):
    for queue in listeners:
        queue.put_nowait((event, data))


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.post("/api/scene")
async def post_scene(request: Request):
    global newest
    snap = await read_payload(request)
    session, seq = snap["session"], snap["seq"]
    have = latest.get(session)
    if have and seq <= have["seq"]:
        return {"ok": True, "ack": have["seq"]}   # older or repeated: already covered

    # Write to disk before acking, so an acked snapshot survives a crash
    snap["receivedAt"] = int(time.time() * 1000)
    folder = SESSION_DIR / session
    folder.mkdir(parents=True, exist_ok=True)
    line = json.dumps(snap)
    with open(folder / "scene.jsonl", "a") as f:
        f.write(line + "\n")
    (folder / "latest.tmp").write_text(line)
    (folder / "latest.tmp").replace(folder / "latest.json")
    latest[session], newest = snap, session

    delay = f"  delay {snap['receivedAt'] - snap['sentAt']} ms" if type(snap.get("sentAt")) is int else ""
    print(f"[scene] {session} #{seq}  {len(snap['elements'])} elements  "
          f"{len(snap['part'].get('features', []))} features{delay}")
    publish("scene", snap)
    builder.submit(snap)
    return {"ok": True, "ack": seq}


@app.post("/api/build")
async def post_build(request: Request):
    payload = await read_payload(request)
    png_url = payload.get("png")
    if not (isinstance(png_url, str) and png_url.startswith("data:image/png;base64,")):
        raise HTTPException(status_code=400, detail="png must be a PNG data URL")
    try:
        png_bytes = base64.b64decode(png_url.split(",", 1)[1], validate=True)
    except ValueError:
        raise HTTPException(status_code=400, detail="png data is not valid base64")

    session = payload["session"]
    folder = SESSION_DIR / session
    build_id = f"b{len(list(folder.glob('b*'))) + 1:04d}"
    out = folder / build_id
    out.mkdir(parents=True)
    (out / "sketch.png").write_bytes(png_bytes)
    (out / "part.json").write_text(json.dumps(payload["part"], indent=2))
    (out / "elements.json").write_text(json.dumps(payload["elements"]))

    build = {"build": build_id, "session": session, "seq": payload["seq"],
             "receivedAt": int(time.time() * 1000), "png": str(out.relative_to(ROOT) / "sketch.png"),
             "part": payload["part"], "elements": payload["elements"]}
    print(f"[build] {session} {build_id} from snapshot #{payload['seq']}")
    publish("build", {k: v for k, v in build.items() if k != "elements"})
    # The AI step runs in the background so it never holds up the iPad
    threading.Thread(target=run_handoff, args=(build,), daemon=True).start()
    return {"ok": True, "build": build_id}


def run_handoff(build):
    try:
        handoff.on_build(build)
    except Exception as e:
        print(f"[handoff] {build['build']} failed: {e!r}")


@app.get("/api/scene")
async def get_scene(session: str | None = None):
    snap = latest.get(session or newest)
    if not snap:
        raise HTTPException(status_code=404, detail="no snapshot received yet")
    return snap


# The live 3D model: what was built (GET /api/model/info) and its files (GET /api/model?format=stl|step|glb)
@app.get("/api/model/info")
async def model_info(session: str | None = None):
    info = builder.latest.get(session or newest)
    if not info:
        raise HTTPException(status_code=404, detail="no model built yet")
    return info


@app.get("/api/model")
async def model_file(session: str | None = None, format: str = "stl"):
    session = session or newest
    if format not in model.FORMATS:
        raise HTTPException(status_code=400, detail=f"format must be one of {', '.join(model.FORMATS)}")
    if session not in latest:   # only known sessions, so the name can't reach outside sessions/
        raise HTTPException(status_code=404, detail="no such session")
    path = SESSION_DIR / session / "model" / model.FORMATS[format]
    if not path.exists():
        raise HTTPException(status_code=404, detail="no model built yet")
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


# Server-Sent Events: the current snapshot and model first, then every new snapshot, model and build
@app.get("/api/stream")
async def stream():
    queue = asyncio.Queue()
    if newest:
        queue.put_nowait(("scene", latest[newest]))
    if newest in builder.latest:
        queue.put_nowait(("model", builder.latest[newest]))
    listeners.add(queue)

    async def events():
        try:
            while True:
                try:
                    event, data = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"   # also lets the server notice a closed viewer
                    continue
                yield f"event: {event}\ndata: {json.dumps(data)}\n\n"
        finally:
            listeners.discard(queue)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# Serves web/index.html at "/" (must stay last so the /api routes win)
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
