# The laptop end of the bridge inside FreeCAD: follows the server's live feed and shows the part as it is drawn.
#
# The feed (GET /api/stream) sends `scene` whenever the drawing changes, `model` when the CadQuery builder
# (model.py) has turned it into a solid, and `build` when a drawing goes to the AI. A model event carries
# {session, seq, status: ok | empty | error, preview, features, volume, bbox, warnings, sketch, files: {brep: url}}.
# The BREP file is downloaded in the background and loaded into the 3D view; `sketch` holds the loose lines.
import json
import os
import queue
import tempfile
import threading
import time
import urllib.request

import FreeCAD as App
import FreeCADGui as Gui
from PySide import QtCore

import boardsketch_overlay as overlay
import boardsketch_pulse as pulse

SERVER = os.environ.get("BOARDSKETCH_SERVER", "http://127.0.0.1:8000")
DOC = "BoardSketch"
BUILD_UP_MS = 1400         # length of the animation that builds the part up from the bottom
QUIET_S = 2.5              # a drawing change with no new model after this long left the part as it was
REFIT = 0.2                # re-fit the camera when the part's size changes by more than this

PART_COLOR = (0.62, 0.69, 0.78)     # light steel on the dark background
EDGE_COLOR = (0.04, 0.06, 0.09)
PREVIEW_TRANSPARENCY = 55           # an outline not yet marked as a profile shows see-through
SKETCH_COLOR = (0.13, 0.83, 0.93)   # loose iPad lines, in the BoardSketch accent


def document():
    return App.getDocument(DOC) if DOC in App.listDocuments() else App.newDocument(DOC)


def listen(events, stop):
    """Reads the server's Server-Sent Events into the events queue, reconnecting until stopped.
    Scenes are only counted, never decoded: the view needs to know the drawing changed, not what it holds."""
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
                        if name == "scene":
                            events.put(("scene", None))
                        elif name and data:
                            info = json.loads("\n".join(data))
                            if name == "model" and info.get("files", {}).get("brep"):
                                try:
                                    info["path"] = fetch(SERVER + info["files"]["brep"])
                                except Exception as e:   # keep listening; this model just is not shown
                                    info.update(status="error", warnings=[f"could not download the model: {e}"])
                            events.put((name, info))
                        name, data = None, []
        except Exception as e:
            events.put(("offline", str(e)))
        stop.wait(2)


def fetch(url):
    """Downloads a model file to a temporary path (on the listening thread, so the view never waits)."""
    fd, path = tempfile.mkstemp(prefix="boardsketch-", suffix=".brep")
    with os.fdopen(fd, "wb") as out, urllib.request.urlopen(url, timeout=30) as res:
        out.write(res.read())
    return path


class Live(QtCore.QObject):
    """Runs on FreeCAD's main thread: drains the feed every 100 ms and updates the view."""

    def __init__(self):
        super().__init__()
        self.events = queue.Queue()
        self.stop = threading.Event()
        self.thread = None
        self.last_scene = 0        # when the drawing last changed
        self.generating = False    # a drawing change is waiting for its model
        self.session = None        # the session whose part is on screen
        self.shown = None          # the model info on screen
        self.sketch_session = None # the session whose loose lines are on screen
        self.last_build = None     # the newest build sent to the AI
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
        model = None
        while True:
            try:
                name, data = self.events.get_nowait()
            except queue.Empty:
                break
            if name == "scene":
                self.on_scene()
            elif name == "model":
                if model and model.get("path"):
                    os.remove(model["path"])          # a newer model replaces it before it was shown
                model = data
            elif name == "build":
                self.last_build = data["build"]
                if self.shown:
                    self.describe(self.shown)
            elif name == "connected":
                self.card.show_state("live", "Connected", "Waiting for the iPad")
            elif name == "offline":
                self.generating = False
                self.border.play(False)
                self.card.show_state("offline", "Laptop server not answering", f"Retrying {SERVER}")
        if model:
            self.on_model(model)
        if self.generating and time.time() - self.last_scene > QUIET_S:
            self.generating = False                   # the change did not alter the part: no new model comes
            self.border.play(False)

    def on_scene(self):
        self.last_scene = time.time()
        if not self.generating:
            self.generating = True
            self.border.play(True)
            self.card.raise_()
        if not self.shown:
            self.card.show_state("drawing", "Sketching on the iPad", "The part appears as soon as there is an outline")

    def on_model(self, info):
        self.generating = False
        self.draw_sketch(info)
        if info["status"] != "ok" or not info.get("path"):
            self.border.play(False)
            first = (info.get("warnings") or [""])[0]
            if info["status"] == "empty":
                # Nothing closed on the iPad any more, so no part here either: the view matches the canvas
                self.clear_part()
                hint = "No closed outline yet" if info.get("sketch") else "Nothing drawn yet"
                self.card.show_state("drawing", "Sketching on the iPad", hint)
            else:
                self.card.show_state("offline", "Could not build the part", first)   # the last good part stays
            return
        try:
            self.load(info)
        finally:
            os.remove(info["path"])

    # ---- the model ----

    def clear_part(self):
        doc = document()
        if doc.getObject("Part"):
            doc.removeObject("Part")
            doc.recompute()
        self.shown = None

    def draw_sketch(self, info):
        """The iPad's loose lines and shapes, drawn on the sketch plane: thin lines, centre lines dashed."""
        import Part

        doc = document()
        for name, roles, style_ in (("Sketch", ("sketch", "hole"), "Solid"), ("CentreLines", ("centre line",), "Dashed")):
            wires = [Part.makePolygon([App.Vector(x, y, 0) for x, y in s["points"] + s["points"][:1] * s["closed"]])
                     for s in info.get("sketch", []) if s["role"] in roles]
            obj = doc.getObject(name)
            if not wires:
                if obj:
                    doc.removeObject(name)
                continue
            obj = obj or doc.addObject("Part::Feature", name)
            obj.Shape = Part.makeCompound(wires)
            obj.ViewObject.LineColor, obj.ViewObject.LineWidth, obj.ViewObject.DrawStyle = SKETCH_COLOR, 2, style_
        doc.recompute()
        if not self.shown and info.get("sketch") and info["session"] != self.sketch_session:
            Gui.getDocument(doc.Name).activeView().viewTop()   # a new drawing: look down on the sketch
            Gui.getDocument(doc.Name).activeView().fitAll()
        self.sketch_session = info["session"]

    def load(self, info):
        import Part

        shape = Part.Shape()
        try:
            shape.read(info["path"])
        except Exception as e:
            self.border.play(False)
            self.card.show_state("offline", "Could not open the model", str(e))
            return
        doc = document()
        obj = doc.getObject("Part") or doc.addObject("Part::Feature", "Part")
        before = self.shown
        new_session = info["session"] != self.session
        obj.Label = "Preview" if info.get("preview") else "Part"
        obj.Shape = shape
        doc.recompute()
        style(obj, info.get("preview"), info.get("material"))
        view = Gui.getDocument(doc.Name).activeView()

        # The camera and the build-up animation follow big changes only, not every stroke.
        def size(i):
            return max(b - a for a, b in zip(i["bbox"]["min"], i["bbox"]["max"]))
        grew = before and abs(size(info) - size(before)) > REFIT * max(size(before), 1e-6)
        if new_session or not before:
            view.viewIsometric()
            view.fitAll()
        elif grew:
            view.fitAll()
        changed = new_session or not before or before.get("preview") != info.get("preview") \
            or before.get("features") != info.get("features")
        if changed:
            build_up(obj, BUILD_UP_MS, done=lambda: self.border.play(False))
        else:
            self.border.play(False)
        self.session, self.shown = info["session"], info
        self.describe(info)

    def describe(self, info):
        lo, hi = info["bbox"]["min"], info["bbox"]["max"]
        size = " × ".join(f"{b - a:.1f}" for a, b in zip(lo, hi)) + " mm"
        n = info.get("features", 0)
        detail = f"{size} · {info.get('volume', 0) / 1000:.2f} cm³ · {n} feature{'s' if n != 1 else ''}"
        if self.last_build:
            detail += f" · AI has {self.last_build}"
        if info.get("warnings"):
            detail += f"\n{info['warnings'][0]}"
        title = "Preview: mark a profile to make it a part" if info.get("preview") else "Part, live from the iPad"
        self.card.show_state("live", title, detail)


def style(obj, preview=False, material=None):
    vo = obj.ViewObject
    # The material picked on the iPad colours the part (and acrylic shows see-through); otherwise light steel
    vo.ShapeColor = tuple(material["color"]) if material and material.get("color") else PART_COLOR
    vo.LineColor = EDGE_COLOR
    vo.LineWidth = 1.5
    vo.DisplayMode = "Flat Lines"
    vo.Transparency = PREVIEW_TRANSPARENCY if preview else int((material or {}).get("transparency") or 0)


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

    previous = getattr(build_up, "running", None)
    if previous:
        previous()              # a newer part replaces one still building up: finish that one at once
    frame()
    timer.timeout.connect(frame)
    timer.start(33)             # 30 frames a second is smooth enough and halves the work

    def finish():
        timer.stop()
        if root.findChild(clip) >= 0:
            root.removeChild(clip)
    build_up.running = finish
    build_up.timer = timer      # keeps the timer alive until it finishes


LIVE = Live()
