#!/bin/sh
# Opens FreeCAD straight into the BoardSketch workbench, live from the laptop server.
# Run the server first: python3 -m uvicorn server:app --host 0.0.0.0 --port 8001
#
# Only the modules BoardSketch needs are loaded: Part (shapes and STEP), Import, Material, Measure and Show.
# Every other bundled workbench is skipped at startup with --disable-addon, which saves memory and start time.
HERE="$(cd "$(dirname "$0")" && pwd)"
UNUSED="AddonManager Assembly BIM CAM Draft Fem Help Idf Inspection Mesh MeshPart OpenSCAD PartDesign
        Plot Points ReverseEngineering Robot Sketcher Spreadsheet Start Surface TechDraw Test Tux Web"
ARGS=""
for m in $UNUSED; do ARGS="$ARGS --disable-addon $m"; done
exec /Applications/FreeCAD.app/Contents/MacOS/FreeCAD $ARGS "$HERE/start.FCMacro"
