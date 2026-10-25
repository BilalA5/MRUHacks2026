#!/bin/sh
# Opens FreeCAD straight into the Bevel workbench, live from the laptop server.
# Run the server first: python3 server.py (port 8000, the same one the iPad uses)
#
# Every FreeCAD workbench stays available (PartDesign, Sketcher, TechDraw, ...): pick one from the workbench
# list, or turn off Focus in the Bevel toolbar to see FreeCAD's own toolbars and panels.
# On a slow machine, `sh freecad/start.sh lite` loads only what Bevel needs: Part (shapes and STEP),
# Import, Material, Measure and Show. The other bundled workbenches are skipped with --disable-addon.
HERE="$(cd "$(dirname "$0")" && pwd)"
ARGS=""
if [ "$1" = "lite" ]; then
  UNUSED="AddonManager Assembly BIM CAM Draft Fem Help Idf Inspection Mesh MeshPart OpenSCAD PartDesign
          Plot Points ReverseEngineering Robot Sketcher Spreadsheet Start Surface TechDraw Test Tux Web"
  for m in $UNUSED; do ARGS="$ARGS --disable-addon $m"; done
fi
exec /Applications/FreeCAD.app/Contents/MacOS/FreeCAD $ARGS "$HERE/start.FCMacro"
