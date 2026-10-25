# Toolbar commands of the Bevel workbench. They live in their own module because FreeCAD runs
# InitGui.py in a namespace that its later calls cannot see.
import FreeCADGui as Gui


class Live:
    def GetResources(self):
        return {"MenuText": "Live from iPad", "ToolTip": "Show parts from the iPad as they are built", "Checkable": True}

    def Activated(self, checked=True):
        from bevel_live import LIVE
        LIVE.start() if checked else LIVE.close()

    def IsActive(self):
        return True


class Fit:
    def GetResources(self):
        return {"MenuText": "Fit part", "ToolTip": "Isometric view, fitted to the part"}

    def Activated(self):
        view = Gui.ActiveDocument and Gui.ActiveDocument.ActiveView
        if view:
            view.viewIsometric()
            view.fitAll()

    def IsActive(self):
        return Gui.ActiveDocument is not None


class Focus:
    def GetResources(self):
        return {"MenuText": "Focus", "ToolTip": "Hide FreeCAD's panels and toolbars so the part has the screen", "Checkable": True}

    def Activated(self, checked=True):
        import bevel_theme
        bevel_theme.focus(checked)

    def IsActive(self):
        return True


class Download:
    def GetResources(self):
        return {"MenuText": "Download", "ToolTip": "Save the part as STEP (for CAD), or STL or 3MF (for 3D printing)"}

    def Activated(self):
        import urllib.request
        from PySide import QtWidgets
        from bevel_live import LIVE, SERVER
        info = LIVE.shown
        name = f"part-{info['session']}-{info['seq']}"
        path, chosen = QtWidgets.QFileDialog.getSaveFileName(
            Gui.getMainWindow(), "Download part", name + ".step", "STEP (*.step);;STL (*.stl);;3MF (*.3mf)")
        if not path:
            return
        kind = path.rsplit(".", 1)[-1].lower() if "." in path else chosen.split("*.")[1].rstrip(")")
        url = f"{SERVER}/api/model?session={info['session']}&format={kind}"
        with urllib.request.urlopen(url, timeout=60) as res, open(path, "wb") as out:
            out.write(res.read())
        LIVE.card.show_state("live", "Part downloaded", path)

    def IsActive(self):
        from bevel_live import LIVE
        return LIVE.shown is not None


class Print:
    def GetResources(self):
        return {"MenuText": "Print", "ToolTip": "Open the part in the slicer, ready to send to the 3D printer"}

    def Activated(self):
        import json
        import urllib.error
        import urllib.request
        from bevel_live import LIVE, SERVER
        req = urllib.request.Request(f"{SERVER}/api/print?session={LIVE.shown['session']}", method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                LIVE.card.show_state("live", f"Opened in {json.load(res)['slicer']}", "Slice it there and send it to the printer")
        except urllib.error.HTTPError as e:
            LIVE.card.show_state("offline", "Could not print", json.load(e).get("detail", str(e)))

    def IsActive(self):
        from bevel_live import LIVE
        return LIVE.shown is not None


Gui.addCommand("Bevel_Live", Live())
Gui.addCommand("Bevel_Fit", Fit())
Gui.addCommand("Bevel_Focus", Focus())
Gui.addCommand("Bevel_Download", Download())
Gui.addCommand("Bevel_Print", Print())
COMMANDS = ["Bevel_Live", "Bevel_Fit", "Bevel_Focus", "Bevel_Download", "Bevel_Print"]
