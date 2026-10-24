# The laptop end of the bridge inside FreeCAD: listens to the server's live feed and shows each
# finished part in the 3D view.
#
# The feed (GET /api/stream) sends `scene` while the user draws and `build` when a drawing goes to the
# builder. The builder (CadQuery) writes sessions/<session>/<build>/part.step; this module waits for that
# file and loads it. A `model` event with {"step": path} loads a file straight away.
import json
import os
import queue
import threading
import time
import urllib.request
from pathlib import Path

import FreeCAD as App
import FreeCADGui as Gui
from PySide import QtCore

import boardsketch_overlay as overlay
import boardsketch_pulse as pulse

SERVER = os.environ.get("BOARDSKETCH_SERVER", "http://127.0.0.1:8001")
# This file lives in <repo>/freecad/BoardSketch/, and the server keeps sessions/ in <repo>.
ROOT = Path(os.environ.get("BOARDSKETCH_ROOT") or Path(__file__).resolve().parents[2])
DOC = "BoardSketch"
STEP_WAIT_S = 120          # how long to wait for the builder before saying it did not answer
BUILD_UP_MS = 1400         # length of the animation that builds the part up from the bottom
SCENE_EVERY_S = 0.5        # the card shows the drawing's progress at most this often

PART_COLOR = (0.62, 0.69, 0.78)     # light steel on the dark background
EDGE_COLOR = (0.04, 0.06, 0.09)


def listen(events, stop):
    """Reads the server's Server-Sent Events into the events queue, reconnecting until stopped."""
    while not stop.is_set():
        try:
            with urllib.request.urlopen(SERVER + "/api/stream", timeout=30) as feed:
                events.put(("connected", None))
                name, data = None, []
                for raw in feed:
                    if stop.is_set():
                        return
                    line = raw.decode("utf-8").rstrip("\r\n")
                    if line.startswith("event:"):
                        name = line[6:].strip()
                    elif line.startswith("data:"):
                        data.append(line[5:].strip())
                    elif not line:
                        if name and data:
                            # Scenes carry the whole drawing and arrive often; they stay text until the
                            # newest one is needed (see Live.tick), so older ones are never decoded.
                            text = "\n".join(data)
                            events.put((name, text if name == "scene" else json.loads(text)))
                        name, data = None, []
        except Exception as e:
            events.put(("offline", str(e)))
        stop.wait(2)


class Live(QtCore.QObject):
    """Runs on FreeCAD's main thread: drains the feed every 100 ms and updates the view."""

    def __init__(self):
        super().__init__()
        self.events = queue.Queue()
        self.stop = threading.Event()
        self.thread = None
        self.waiting = None        # {"build", "path", "since", "size", "part"}: a build whose model is not in yet
        self.shown = None          # the build on screen
        self.last_scene = 0
        self.scene_text = None     # the newest scene, not decoded yet
        self.timer = QtCore.QTimer(self)
        self.timer.setInterval(100)
        self.timer.timeout.connect(self.tick)
        self.card = None
        self.border = None

    # ---- start and stop ----

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop.clear()
        self.thread = threading.Thread(target=listen, args=(self.events, self.stop), daemon=True)
        self.thread.start()
        self.timer.start()
        self.card = overlay.attach()
        self.border = pulse.attach(self.card.parentWidget())
        self.card.raise_()
        self.card.show_state("waiting", "Connecting to the laptop server", SERVER)
        self.show_latest_on_disk()

    def close(self):
        self.stop.set()
        self.timer.stop()
        if self.card:
            self.card.hide()
        if self.border:
            self.border.play(False)

    @property
    def running(self):
        return self.timer.isActive()

    # ---- the feed ----

    def tick(self):
        while True:
            try:
                name, data = self.events.get_nowait()
            except queue.Empty:
                break
            if name == "scene":
                self.scene_text = data             # only the newest scene matters
            elif name == "build":
                self.expect(data)
            elif name == "model":
                self.load(data["build"], ROOT / data["step"], data.get("part"))
            elif name == "connected":
                self.card.show_state("live", "Connected", "Waiting for the iPad")
            elif name == "offline":
                self.card.show_state("offline", "Laptop server not answering", f"Retrying {SERVER}")
        if self.scene_text and time.time() - self.last_scene >= SCENE_EVERY_S:
            scene, self.scene_text = json.loads(self.scene_text), None
            self.on_scene(scene)
        if self.waiting:
            self.check_waiting()

    def on_scene(self, scene):
        self.last_scene = time.time()
        if self.waiting:
            return
        part = scene.get("part") or {}
        n = len(part.get("features", []))
        detail = f"{n} feature{'s' if n != 1 else ''} marked" if n else "Sketch, no profile marked yet"
        self.card.show_state("drawing", "Sketching on the iPad", f"Snapshot #{scene['seq']} · {detail}")

    def expect(self, build):
        path = ROOT / Path(build["png"]).parent / "part.step"
        self.waiting = {"build": build["build"], "path": path, "since": time.time(), "size": -1, "part": build.get("part")}
        self.card.show_state("building", f"Building {build['build']}", summary(build.get("part")))
        self.border.play(True)
        self.card.raise_()

    def check_waiting(self):
        w = self.waiting
        if w["path"].exists():
            size = w["path"].stat().st_size
            if size > 0 and size == w["size"]:     # the same size twice in a row: the builder has finished writing
                self.waiting = None
                self.load(w["build"], w["path"], w["part"])
                return
            w["size"] = size
        elif time.time() - w["since"] > STEP_WAIT_S:
            self.waiting = None
            self.border.play(False)
            self.card.show_state("offline", f"No 3D model for {w['build']}", "The builder did not write part.step")

    # ---- the model ----

    def show_latest_on_disk(self):
        """On start, show the newest model already built, so the view is never empty."""
        steps = sorted(ROOT.glob("sessions/*/b*/part.step"), key=lambda p: p.stat().st_mtime)
        if steps:
            part_json = steps[-1].parent / "part.json"
            part = json.loads(part_json.read_text()) if part_json.exists() else None
            self.load(steps[-1].parent.name, steps[-1], part, animate=False)

    def load(self, build, path, part=None, animate=True):
        import Part

        doc = App.getDocument(DOC) if DOC in App.listDocuments() else App.newDocument(DOC)
        shape = Part.Shape()
        try:
            shape.read(str(path))
        except Exception as e:
            self.border.play(False)
            self.card.show_state("offline", f"Could not open {build}", str(e))
            return
        for obj in doc.Objects:
            doc.removeObject(obj.Name)
        obj = doc.addObject("Part::Feature", "Part")
        obj.Label = f"Part {build}"
        obj.Shape = shape
        doc.recompute()
        Gui.ActiveDocument = Gui.getDocument(doc.Name)
        style(obj)
        view = Gui.getDocument(doc.Name).activeView()
        view.viewIsometric()
        view.fitAll()
        if animate:
            build_up(obj, BUILD_UP_MS, done=lambda: self.border.play(False))
        else:
            self.border.play(False)
        self.shown = build
        box = shape.BoundBox
        size = f"{box.XLength:.1f} × {box.YLength:.1f} × {box.ZLength:.1f} mm"
        self.card.show_state("live", f"Part {build}", f"{size} · {shape.Volume / 1000:.2f} cm³" + (f" · {summary(part)}" if part else ""))


def summary(part):
    """A short line about the part: features and holes."""
    if not part:
        return ""
    features = part.get("features", [])
    holes = sum(len(f.get("holes", [])) + (f.get("boltCircle") or {}).get("count", 0) for f in features)
    kinds = " + ".join(sorted({f["type"] for f in features})) or "no features"
    return f"{kinds}, {holes} hole{'s' if holes != 1 else ''}"


def style(obj):
    vo = obj.ViewObject
    vo.ShapeColor = PART_COLOR
    vo.LineColor = EDGE_COLOR
    vo.LineWidth = 1.5
    vo.DisplayMode = "Flat Lines"


def build_up(obj, ms, done=None):
    """Reveals the part from the bottom up with a moving clipping plane, like it is being made layer by layer."""
    from pivy import coin

    box = obj.Shape.BoundBox
    root = obj.ViewObject.RootNode
    clip = coin.SoClipPlane()
    root.insertChild(clip, 0)
    start = time.time()
    timer = QtCore.QTimer()

    def frame():
        t = min(1.0, (time.time() - start) * 1000 / ms)
        eased = 1 - (1 - t) ** 3                          # ease-out: fast at first, settling at the top
        z = box.ZMin + (box.ZMax - box.ZMin) * eased + 1e-3
        # Keeps everything with z <= the plane: the normal points down, so -z >= -h.
        clip.plane.setValue(coin.SbPlane(coin.SbVec3f(0, 0, -1), -z))
        if t >= 1.0:
            timer.stop()
            if root.findChild(clip) >= 0:
                root.removeChild(clip)
            if done:
                done()

    frame()
    timer.timeout.connect(frame)
    timer.start(33)             # 30 frames a second is smooth enough and halves the work
    build_up.timer = timer      # keeps the timer alive until it finishes


LIVE = Live()
