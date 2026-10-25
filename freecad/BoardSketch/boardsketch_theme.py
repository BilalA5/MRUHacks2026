# The BoardSketch look for FreeCAD: a calm dark theme in the pulsing border's palette (navy, blue, cyan),
# and a focus mode that leaves the 3D part the whole screen. Everything is undone when the workbench is left.
import FreeCAD as App
import FreeCADGui as Gui
from PySide import QtCore, QtWidgets

# Design tokens, shared with the status card.
BG = "#0B0F17"          # window
SURFACE = "#111723"     # toolbars, panels, cards
RAISED = "#182131"      # hover
BORDER = "#1F2937"
TEXT = "#E5EAF0"
MUTED = "#8B98A9"
ACCENT = "#35C4E8"      # the shader's cyan

QSS = f"""
QMainWindow, QMainWindow::separator {{ background: {BG}; }}
QWidget {{ color: {TEXT}; font-size: 13px; }}
QToolBar {{ background: {SURFACE}; border: 0; border-bottom: 1px solid {BORDER}; padding: 6px 8px; spacing: 4px; }}
QToolBar::separator {{ background: {BORDER}; width: 1px; margin: 6px 6px; }}
QToolButton {{ background: transparent; color: {TEXT}; border: 1px solid transparent; border-radius: 8px; padding: 6px 10px; }}
QToolButton:hover {{ background: {RAISED}; }}
QToolButton:pressed {{ background: {BORDER}; }}
QToolButton:checked {{ background: rgba(53, 196, 232, 0.14); border-color: rgba(53, 196, 232, 0.35); color: {ACCENT}; }}
QMenuBar {{ background: {BG}; }}
QMenu {{ background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 10px; padding: 6px; }}
QMenu::item {{ padding: 6px 14px; border-radius: 6px; }}
QMenu::item:selected {{ background: {RAISED}; }}
QComboBox {{ background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 8px; padding: 4px 10px; }}
QDockWidget {{ titlebar-close-icon: none; }}
QDockWidget::title {{ background: {BG}; color: {MUTED}; padding: 8px 10px; text-transform: uppercase; }}
QTreeView, QListView {{ background: {SURFACE}; border: 0; selection-background-color: rgba(53, 196, 232, 0.18); selection-color: {TEXT}; }}
QHeaderView::section {{ background: {SURFACE}; color: {MUTED}; border: 0; padding: 6px; }}
QStatusBar {{ background: {BG}; color: {MUTED}; border-top: 1px solid {BORDER}; }}
QMdiArea {{ background: {BG}; }}
QTabBar::tab {{ background: transparent; color: {MUTED}; padding: 6px 12px; border: 0; }}
QTabBar::tab:selected {{ color: {TEXT}; border-bottom: 2px solid {ACCENT}; }}
QScrollBar:vertical, QScrollBar:horizontal {{ background: transparent; width: 8px; height: 8px; }}
QScrollBar::handle {{ background: {BORDER}; border-radius: 4px; min-height: 24px; min-width: 24px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; width: 0; }}
"""

VIEW = "User parameter:BaseApp/Preferences/View"
# The 3D background: a soft vertical gradient from slate to the window colour, and cyan selection.
VIEW_SETTINGS = {
    "Simple": ("Bool", False), "Gradient": ("Bool", True), "RadialGradient": ("Bool", False),
    "BackgroundColor2": ("Unsigned", 0x182234FF), "BackgroundColor3": ("Unsigned", 0x0B0F17FF),
    "UseBackgroundColorMid": ("Bool", False),
    "HighlightColor": ("Unsigned", 0x35C4E8FF), "SelectionColor": ("Unsigned", 0x35C4E8FF),
}

_saved = None
_focused = False    # focus mode is on
_watched = set()    # panels already set to hide again when FreeCAD shows them


def _param(kind, group, name, value=None):
    get, set_ = getattr(group, "Get" + kind), getattr(group, "Set" + kind)
    if value is None:
        return get(name)
    set_(name, value)


def apply():
    """Dark theme and focus mode on; remembers what it changed so restore() can put it back."""
    global _saved
    if _saved is not None:
        return
    mw = Gui.getMainWindow()
    group = App.ParamGet(VIEW)
    _saved = {
        "qss": mw.styleSheet(),
        "params": {name: (kind, _param(kind, group, name)) for name, (kind, _) in VIEW_SETTINGS.items()},
        "hidden": [],
    }
    for name, (kind, value) in VIEW_SETTINGS.items():
        _param(kind, group, name, value)
    mw.setStyleSheet(QSS)
    focus(True)


def focus(on):
    """Focus mode: only the BoardSketch toolbar and the 3D view; panels, other toolbars and tabs are hidden."""
    global _focused
    _focused = on
    mw = Gui.getMainWindow()
    if on:
        # FreeCAD pops the Report view back up on any warning, so panels are hidden again whenever they show
        for dock in mw.findChildren(QtWidgets.QDockWidget):
            if dock not in _watched:
                dock.visibilityChanged.connect(lambda shown, d=dock: shown and _focused and QtCore.QTimer.singleShot(0, d.hide))
                _watched.add(dock)
        hide = [w for w in mw.findChildren(QtWidgets.QDockWidget) if w.isVisible()]
        hide += [t for t in mw.findChildren(QtWidgets.QToolBar) if t.isVisible() and t.objectName() != "BoardSketch"]
        hide += [s for s in [mw.statusBar()] if s.isVisible()]
        for w in hide:
            w.hide()
        _saved["hidden"] += hide
        mdi = mw.findChild(QtWidgets.QMdiArea)
        for sub in mdi.subWindowList():
            if sub.windowTitle().startswith("Start"):   # FreeCAD's start page is not needed here
                sub.close()
        mdi.setViewMode(QtWidgets.QMdiArea.TabbedView)
        bar = mdi.findChild(QtWidgets.QTabBar)
        if bar:
            bar.hide()
            _saved["hidden"].append(bar)
    else:
        for w in _saved["hidden"]:
            w.show()
        _saved["hidden"] = []


def restore():
    global _saved
    if _saved is None:
        return
    focus(False)
    Gui.getMainWindow().setStyleSheet(_saved["qss"])
    group = App.ParamGet(VIEW)
    for name, (kind, value) in _saved["params"].items():
        _param(kind, group, name, value)
    _saved = None
