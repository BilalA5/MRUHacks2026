# BoardSketch workbench: FreeCAD as the laptop screen of the sketch-to-part pipeline.
# Choosing the workbench connects to the laptop server and shows each part built from the iPad drawing.
import FreeCADGui as Gui


class BoardSketchWorkbench(Gui.Workbench):
    MenuText = "BoardSketch"
    ToolTip = "Parts sketched on the iPad, built live"

    def Initialize(self):
        from boardsketch_commands import COMMANDS
        self.appendToolbar("BoardSketch", COMMANDS)
        self.appendMenu("BoardSketch", COMMANDS)

    def Activated(self):
        import boardsketch_theme
        from boardsketch_live import LIVE
        boardsketch_theme.apply()
        LIVE.start()

    def Deactivated(self):
        import boardsketch_theme
        boardsketch_theme.restore()

    def GetClassName(self):
        return "Gui::PythonWorkbench"


Gui.addWorkbench(BoardSketchWorkbench())
