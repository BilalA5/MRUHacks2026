# The status readout over FreeCAD's 3D view: what the iPad is doing and what the part is, at a glance.
# A quiet panel in the top-left corner, not a notification: a small state label (LIVE, BUILDING, ...),
# the part's size as the title, and a muted line or two (material and weight, checks).
# It changes only when what it says changes, with a short fade, and costs nothing in between.
from PySide import QtCore, QtWidgets

import FreeCADGui as Gui
from boardsketch_theme import MUTED, TEXT

STATES = {   # label, colour
    "live": ("LIVE", "#4ade80"), "drawing": ("SKETCHING", "#35C4E8"), "building": ("BUILDING", "#35C4E8"),
    "waiting": ("CONNECTING", MUTED), "offline": ("OFFLINE", "#f59e0b"),
}

STYLE = f"""
#bsCard {{ background: rgba(14, 19, 29, 0.86); border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 12px; }}
#bsState {{ font-size: 10px; font-weight: 600; letter-spacing: 1.2px; }}
#bsTitle {{ color: {TEXT}; font-size: 15px; font-weight: 600; }}
#bsDetail {{ color: {MUTED}; font-size: 12px; }}
"""


class Card(QtWidgets.QFrame):
    def __init__(self, area):
        super().__init__(area)
        self.setObjectName("bsCard")
        self.setStyleSheet(STYLE)
        self.setAttribute(QtCore.Qt.WA_TransparentForMouseEvents)
        self.state = QtWidgets.QLabel(self, objectName="bsState")
        self.title = QtWidgets.QLabel(self, objectName="bsTitle")
        self.detail = QtWidgets.QLabel(self, objectName="bsDetail")
        self.detail.setWordWrap(True)
        box = QtWidgets.QVBoxLayout(self)
        box.setContentsMargins(14, 11, 14, 12)
        box.setSpacing(3)
        box.addWidget(self.state)
        box.addWidget(self.title)
        box.addWidget(self.detail)
        area.installEventFilter(self)
        self.shown = None
        self.fade = None

    def show_state(self, state, title, detail=""):
        if self.shown == (state, title, detail) and self.isVisible():
            return                              # nothing changed: no relayout, no repaint
        changed = self.shown is not None and self.shown[1] != title
        self.shown = (state, title, detail)
        label, colour = STATES.get(state, (state.upper(), MUTED))
        self.state.setText(label)
        self.state.setStyleSheet(f"color: {colour};")
        self.title.setText(title)
        self.detail.setText(detail)
        self.detail.setVisible(bool(detail))
        self.place()
        self.show()
        self.raise_()
        if changed:
            self.flash_in()

    def flash_in(self):
        """A 160 ms ease-out fade as new content arrives; the effect is removed after, so it costs nothing at rest."""
        effect = QtWidgets.QGraphicsOpacityEffect(self)
        self.setGraphicsEffect(effect)
        self.fade = QtCore.QPropertyAnimation(effect, b"opacity", self)
        self.fade.setDuration(160)
        self.fade.setStartValue(0.35)
        self.fade.setEndValue(1.0)
        self.fade.setEasingCurve(QtCore.QEasingCurve.OutCubic)
        self.fade.finished.connect(lambda: self.setGraphicsEffect(None))
        self.fade.start()

    def place(self):
        area = self.parentWidget()
        self.setFixedWidth(min(320, max(240, area.width() // 3)))
        self.adjustSize()
        self.move(20, 20)                       # top left, clear of the beam on the edge

    def eventFilter(self, obj, event):
        if event.type() == QtCore.QEvent.Resize:
            self.place()
        return False


_card = None


def attach():
    """The readout, in the top-left corner of FreeCAD's view area."""
    global _card
    if _card is None:
        area = Gui.getMainWindow().findChild(QtWidgets.QMdiArea)
        _card = Card(area)
    _card.raise_()
    return _card
