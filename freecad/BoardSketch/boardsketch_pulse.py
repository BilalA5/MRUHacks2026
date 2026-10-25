# The border beam: a light that runs round the edge of FreeCAD's 3D view while the part is being made.
#
# Drawn with Qt's painter on a transparent layer over the view, in the colours of the "Pulsing Border" shader
# (21st.dev Shader Builder, adapted from Paper Shaders, Apache-2.0): navy, blue, cyan, and a white head.
# A faint track marks the edge; the beam travels it at a constant speed and fades in and out with the build.
# Only the strip the beam passes through is repainted each frame, so it costs little while it runs, and
# nothing at all when no part is building.
import time

from PySide6 import QtCore, QtGui, QtWidgets

TRAIL = [(5, 7, 13), (18, 97, 160), (53, 196, 232), (242, 251, 255)]   # tail to head
LAP_S = 2.6            # one trip round the view
BEAM = 0.24            # the beam's length, as a share of the edge
INSET = 3              # px in from the view's edge
RADIUS = 12            # corner radius of the track
FADE_IN_S, FADE_OUT_S = 0.2, 0.15   # exits are quicker than entrances
FPS = 30


def _mix(t):
    """The trail colour at t: 0 at the tail, 1 at the head."""
    t = max(0.0, min(1.0, t)) * (len(TRAIL) - 1)
    i = min(int(t), len(TRAIL) - 2)
    f = t - i
    return [round(a + (b - a) * f) for a, b in zip(TRAIL[i], TRAIL[i + 1])]


class BorderBeam(QtWidgets.QWidget):
    def __init__(self, area):
        super().__init__(area)
        self.setAttribute(QtCore.Qt.WA_TransparentForMouseEvents)
        self.setAttribute(QtCore.Qt.WA_TranslucentBackground)
        self.setAttribute(QtCore.Qt.WA_NoSystemBackground)
        self.alpha, self.target, self.last, self.start = 0.0, 0.0, time.time(), time.time()
        self.dirty = QtCore.QRect()
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self.step)
        area.installEventFilter(self)
        self.setGeometry(area.rect())
        self.hide()

    def play(self, on):
        """Fades the beam in (on) or out."""
        self.target = 1.0 if on else 0.0
        if on and not self.isVisible():
            self.setGeometry(self.parentWidget().rect())
            self.show()
            self.raise_()
            self.update()
        if not self.timer.isActive() and (on or self.alpha > 0):
            self.last = time.time()
            self.timer.start(int(1000 / FPS))

    def eventFilter(self, obj, event):
        if event.type() == QtCore.QEvent.Resize:
            self.setGeometry(obj.rect())
        return False

    def track(self):
        path = QtGui.QPainterPath()
        path.addRoundedRect(QtCore.QRectF(self.rect()).adjusted(INSET, INSET, -INSET, -INSET), RADIUS, RADIUS)
        return path

    def head(self):
        return ((time.time() - self.start) / LAP_S) % 1.0

    def beam_rect(self):
        path, h = self.track(), self.head()
        pts = [path.pointAtPercent((h - BEAM * i / 8) % 1.0) for i in range(9)]
        xs, ys = [p.x() for p in pts], [p.y() for p in pts]
        return QtCore.QRect(int(min(xs)), int(min(ys)), int(max(xs) - min(xs)) + 1, int(max(ys) - min(ys)) + 1)

    def step(self):
        now = time.time()
        dt, self.last = now - self.last, now
        rate = dt / (FADE_IN_S if self.target > self.alpha else FADE_OUT_S)
        self.alpha = min(self.target, self.alpha + rate) if self.target > self.alpha else max(self.target, self.alpha - rate)
        if self.alpha <= 0 and self.target == 0:
            self.timer.stop()
            self.hide()
            return
        # Repaint only where the beam was and where it is now; the whole edge while fading, for the track
        here = self.beam_rect()
        self.update(self.rect() if 0 < self.alpha < 1 else (here | self.dirty).adjusted(-16, -16, 16, 16))
        self.dirty = here

    def paintEvent(self, event):
        if self.alpha <= 0:
            return
        eased = 1 - (1 - self.alpha) ** 3
        p = QtGui.QPainter(self)
        p.setRenderHint(QtGui.QPainter.Antialiasing)
        path = self.track()
        # The track: a faint line round the whole edge
        p.setPen(QtGui.QPen(QtGui.QColor(53, 196, 232, int(46 * eased)), 1.2))
        p.drawPath(path)
        # The beam: one smooth stroke along the edge from tail to head, coloured tail (navy, clear) to
        # head (white), drawn as a wide soft glow and then a bright core, with a glowing point at the head.
        h, n = self.head(), 48
        pts = [path.pointAtPercent((h - BEAM * (1 - i / n)) % 1.0) for i in range(n + 1)]
        beam = QtGui.QPainterPath(pts[0])
        for q in pts[1:]:
            beam.lineTo(q)
        for width, strength in ((10.0, 0.32), (2.6, 1.0)):
            grad = QtGui.QLinearGradient(pts[0], pts[-1])
            for stop, (r, g, b), a in ((0.0, TRAIL[0], 0.0), (0.45, TRAIL[1], 0.55), (0.8, TRAIL[2], 0.95), (1.0, TRAIL[3], 1.0)):
                grad.setColorAt(stop, QtGui.QColor(r, g, b, int(255 * a * strength * eased)))
            p.setPen(QtGui.QPen(QtGui.QBrush(grad), width, QtCore.Qt.SolidLine, QtCore.Qt.RoundCap, QtCore.Qt.RoundJoin))
            p.drawPath(beam)
        glow = QtGui.QRadialGradient(pts[-1], 12)
        glow.setColorAt(0, QtGui.QColor(242, 251, 255, int(220 * eased)))
        glow.setColorAt(0.4, QtGui.QColor(53, 196, 232, int(120 * eased)))
        glow.setColorAt(1, QtGui.QColor(53, 196, 232, 0))
        p.setPen(QtCore.Qt.NoPen)
        p.setBrush(glow)
        p.drawEllipse(pts[-1], 12, 12)
        p.end()


_beam = None


def attach(area):
    global _beam
    if _beam is None:
        _beam = BorderBeam(area)
    return _beam
