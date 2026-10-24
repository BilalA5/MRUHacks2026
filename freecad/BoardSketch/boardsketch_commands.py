# Toolbar commands of the BoardSketch workbench. They live in their own module because FreeCAD runs
# InitGui.py in a namespace that its later calls cannot see.
import FreeCADGui as Gui


class Live:
    def GetResources(self):
        return {"MenuText": "Live from iPad", "ToolTip": "Show parts from the iPad as they are built", "Checkable": True}

    def Activated(self, checked=True):
        from boardsketch_live import LIVE
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
        import boardsketch_theme
        boardsketch_theme.focus(checked)

    def IsActive(self):
        return True


Gui.addCommand("BoardSketch_Live", Live())
Gui.addCommand("BoardSketch_Fit", Fit())
Gui.addCommand("BoardSketch_Focus", Focus())
COMMANDS = ["BoardSketch_Live", "BoardSketch_Fit", "BoardSketch_Focus"]
