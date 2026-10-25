# Sets FreeCAD's preferences for a light, fast laptop screen, and repairs a saved layout with its tools hidden. Edits user.cfg directly, so FreeCAD never
# has to run; it must be closed, because it rewrites user.cfg when it quits. A backup is kept next to it.
#   python3 freecad/lite.py
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

CFG = Path.home() / "Library/Preferences/FreeCAD/v1-1/user.cfg"

# group path under BaseApp/Preferences → [(type, name, value)]
SETTINGS = {
    "General": [
        ("FCText", "AutoloadModule", "BoardSketchWorkbench"),   # start straight in BoardSketch, not PartDesign
        ("FCBool", "ShowSplasher", "0"),
    ],
    "View": [
        ("FCInt", "AntiAliasing", "0"),          # no multisampling: the biggest saving on the graphics card
        ("FCBool", "ShowNaviCube", "0"),         # the cube redraws with every frame
        ("FCBool", "EnablePreselection", "0"),   # no hover highlighting, which picks on every mouse move
    ],
    "Document": [
        ("FCBool", "AutoSaveEnabled", "0"),
        ("FCBool", "CreateBackupFiles", "0"),
    ],
    "OutputWindow": [                            # never pop the Report view up over the 3D view
        ("FCBool", "checkShowReportViewOnWarning", "0"),
        ("FCBool", "checkShowReportViewOnError", "0"),
        ("FCBool", "checkShowReportViewOnNormalMessage", "0"),
        ("FCBool", "checkShowReportViewOnLogMessage", "0"),
    ],
    "NotificationArea": [
        ("FCBool", "NotificationAreaEnabled", "0"),
    ],
}

# Saved window state that can leave FreeCAD with its tools missing, in every workbench: the layout and toolbar
# and panel visibility saved while BoardSketch's focus mode had them hidden, and the overlay switch an earlier
# version of this script turned off. Removing them gives FreeCAD back its own defaults.
REPAIR = {
    ("BaseApp", "Preferences", "DockWindows"): ["ActivateOverlay"],
    ("BaseApp", "Preferences", "MainWindow"): ["MainWindowState"],
    ("BaseApp", "MainWindow", "Toolbars"): "all",
    ("BaseApp", "MainWindow", "DockWindows"): ["Std_ComboView", "Std_TaskView", "Std_ReportView", "Std_PythonView",
                                               "Std_SelectionView", "Std_TreeView", "Std_PropertyView"],
}


def group(parent, name):
    for g in parent.findall("FCParamGroup"):
        if g.get("Name") == name:
            return g
    return ET.SubElement(parent, "FCParamGroup", Name=name)


def main():
    if subprocess.run(["pgrep", "-f", "FreeCAD.app/Contents"], capture_output=True).returncode == 0:
        sys.exit("Close FreeCAD first: it rewrites user.cfg when it quits.")
    if CFG.exists():
        shutil.copy(CFG, CFG.with_name(f"user.cfg.bak-{time.strftime('%Y%m%d-%H%M%S')}"))
        tree = ET.parse(CFG)
    else:
        CFG.parent.mkdir(parents=True, exist_ok=True)
        tree = ET.ElementTree(ET.fromstring('<FCParameters><FCParamGroup Name="Root"/></FCParameters>'))
    root = group(tree.getroot(), "Root")
    for path, names in REPAIR.items():
        g = root
        for name in path:
            g = group(g, name)
        for old in [e for e in g if e.tag != "FCParamGroup" and (names == "all" or e.get("Name") in names)]:
            g.remove(old)
    prefs = group(group(root, "BaseApp"), "Preferences")
    for path, entries in SETTINGS.items():
        g = group(prefs, path)
        for kind, name, value in entries:
            for old in [e for e in g if e.get("Name") == name]:
                g.remove(old)
            if kind == "FCText":
                ET.SubElement(g, kind, Name=name).text = value
            else:
                ET.SubElement(g, kind, Name=name, Value=value)
    ET.indent(tree, "  ")
    tree.write(CFG, encoding="UTF-8", xml_declaration=True)
    print(f"FreeCAD set up for BoardSketch: {CFG}")


if __name__ == "__main__":
    main()
