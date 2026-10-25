# Bevel workbench: FreeCAD as the laptop screen of the sketch-to-part pipeline.
# Choosing the workbench connects to the laptop server and shows each part built from the iPad drawing.
import FreeCADGui as Gui


class BevelWorkbench(Gui.Workbench):
    MenuText = "Bevel"
    ToolTip = "Parts sketched on the iPad, built live"

    def Initialize(self):
        from bevel_commands import COMMANDS
        self.appendToolbar("Bevel", COMMANDS)
        self.appendMenu("Bevel", COMMANDS)

    def Activated(self):
        import bevel_theme
        from bevel_live import LIVE
        bevel_theme.apply()
        LIVE.start()

    def Deactivated(self):
        import bevel_theme
        bevel_theme.restore()

    def GetClassName(self):
        return "Gui::PythonWorkbench"


Gui.addWorkbench(BevelWorkbench())
