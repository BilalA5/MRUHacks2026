# A status card over FreeCAD's 3D view: whether the iPad is sketching, a part is building, or which part is shown.
# Styled with the BoardSketch theme: a dark surface card, light text and the cyan accent.
from PySide import QtCore, QtWidgets

import FreeCADGui as Gui
from boardsketch_theme import ACCENT, BORDER, MUTED, SURFACE, TEXT

COLORS = {"live": "#22c55e", "drawing": ACCENT, "building": ACCENT, "waiting": MUTED, "offline": "#f59e0b"}

STYLE = f"""
#bsCard {{ background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 12px; }}
#bsTitle {{ color: {TEXT}; font-size: 14px; font-weight: 600; }}
#bsDetail {{ color: {MUTED}; font-size: 12px; }}
"""


# Kept cheap on purpose: no blur shadow (it redraws the card offscreen) and nothing animating inside it;
# the pulsing border round the view already shows when a part is building.
class Card(QtWidgets.QFrame):
    def __init__(self, area):
        super().__init__(area)
        self.setObjectName("bsCard")
        self.setStyleSheet(STYLE)
        self.setAttribute(QtCore.Qt.WA_TransparentForMouseEvents)

        self.dot = QtWidgets.QLabel(self)
        self.dot.setFixedSize(8, 8)
        self.title = QtWidgets.QLabel(self, objectName="bsTitle")
        self.detail = QtWidgets.QLabel(self, objectName="bsDetail")

        head = QtWidgets.QHBoxLayout()
        head.setSpacing(8)
        head.addWidget(self.dot, 0, QtCore.Qt.AlignVCenter)
        head.addWidget(self.title, 1)
        box = QtWidgets.QVBoxLayout(self)
        box.setContentsMargins(14, 10, 14, 12)
        box.setSpacing(4)
        box.addLayout(head)
        box.addWidget(self.detail)
        area.installEventFilter(self)
        self.shown = None

    def show_state(self, state, title, detail=""):
        if self.shown == (state, title, detail) and self.isVisible():
            return                              # nothing changed: no relayout, no repaint
        self.shown = (state, title, detail)
        self.dot.setStyleSheet(f"background: {COLORS.get(state, MUTED)}; border-radius: 4px;")
        self.title.setText(title)
        self.detail.setText(detail)
        self.detail.setVisible(bool(detail))
        self.adjustSize()
        self.place()
        self.show()
        self.raise_()

    def place(self):
        area = self.parentWidget()
        self.setFixedWidth(min(360, max(240, area.width() // 3)))
        self.adjustSize()
        self.move(24, area.height() - self.height() - 24)   # clear of the pulsing border

    def eventFilter(self, obj, event):
        if event.type() == QtCore.QEvent.Resize:
            self.place()
        return False


_card = None


def attach():
    """The card, placed in the bottom-left corner of FreeCAD's view area."""
    global _card
    if _card is None:
        area = Gui.getMainWindow().findChild(QtWidgets.QMdiArea)
        _card = Card(area)
    _card.raise_()
    return _card
