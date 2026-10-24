# MRUHacks 2026

Working repo for our MRU Hacks 2026 project.

## Current direction

**Sketch to 3D part, with a CAD-style view.**

- Engineers draw a 2D profile on an iPad (Safari web canvas, no app install).
- The laptop server sends the sketch to an AI model, which returns a fixed set of operations (profile, extrude, hole, cut).
- Code (CadQuery, open source) builds the solid part from those operations.
- The laptop, which is also the projected display, shows the result in a CAD-style browser window (three.js, grid, dimensions, orbit view).
- Edits are made by drawing on the iPad (for example, a circle becomes a hole).

Demo parts, in priority order: mounting bracket, flanged pipe, spur gear (stretch).

## Laptop screen (FreeCAD)

The `freecad/` folder is a FreeCAD workbench, BoardSketch, that shows each part built from the iPad drawing.
It listens to the bridge's live feed (`/api/stream`), waits for the builder to write
`sessions/<session>/<build>/part.step`, and loads it with a build-up animation. A pulsing border runs round the
3D view while a part is being generated.

- Install once, with FreeCAD closed: `sh freecad/install.sh`. It links the workbench into FreeCAD and sets
  FreeCAD's preferences for a light, fast screen (no anti-aliasing, navigation cube, autosave or splash).
- Run, with the server up: `sh freecad/start.sh`. Only the modules BoardSketch needs are loaded; every other
  bundled workbench is skipped with `--disable-addon`.
- For the builder: write `part.step` into the build folder (write a temporary file, then rename it).

## Open items

- Confirm the judging criteria and theme wording on the MRU Hacks 2026 page.
- Confirm CadQuery license and install on every demo machine.
- Run the model gate: 4 of 5 hand sketches must produce valid operation JSON.
- Time a manual CAD baseline for the impact number. Don't use an estimate on stage.

## Files

- `BoardSketch_Build_Spec.pdf`: earlier concept (labeled circuit checker), kept for comparison.
