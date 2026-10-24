#!/bin/sh
# Links the BoardSketch workbench into FreeCAD's user Mod folder (so FreeCAD loads it from this repo;
# edits show up after restarting FreeCAD) and sets FreeCAD's preferences for a light, fast screen.
# FreeCAD is not started. Run once, with FreeCAD closed: sh freecad/install.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(defaults read /Applications/FreeCAD.app/Contents/Info.plist CFBundleVersion)"   # e.g. 1.1.4
[ -n "$VERSION" ] || { echo "FreeCAD not found in /Applications"; exit 1; }
MOD="$HOME/Library/Application Support/FreeCAD/v$(echo "$VERSION" | cut -d. -f1-2 | tr . -)/Mod"
mkdir -p "$MOD"
ln -sfn "$HERE/BoardSketch" "$MOD/BoardSketch"
echo "Linked $HERE/BoardSketch -> $MOD/BoardSketch"
python3 "$HERE/lite.py"
echo "Start it with: sh freecad/start.sh"
