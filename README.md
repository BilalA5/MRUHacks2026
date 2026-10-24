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

## Live 3D model (laptop backend)

`model.py` turns the canvas's part description (`partSketch()`, in mm) into a CadQuery solid while the user draws. No AI call is needed for this: extrudes, revolves, through/blind/counterbore/countersink holes, drawn cut-outs, hole patterns and bolt circles all come straight from the drawing. Until a profile is marked, closed outlines show as a 10 mm preview plate.

Every snapshot from the iPad goes to a background builder. It builds the newest one, skips any that went stale while it was busy, and reuses unchanged features. For the frontend:

| What | Where |
|---|---|
| Live updates | `GET /api/stream`, event `model` (sent first on connect, then after every rebuild) |
| Latest model info | `GET /api/model/info` (add `?session=<id>` for one session) |
| Model files | `GET /api/model?format=glb` (or `stl`, `step`). The `files` URLs in each event already carry the session and a version |

A `model` event looks like:

```json
{"session": "k3f9a2", "seq": 42, "status": "ok", "preview": false, "features": 1,
 "volume": 146272.6, "bbox": {"min": [0, -80, -60], "max": [15, 40, 60]}, "buildMs": 27,
 "warnings": [], "files": {"glb": "/api/model?session=k3f9a2&format=glb&v=42", "stl": "...", "step": "..."}}
```

- `status`: `ok`, `empty` (nothing closed drawn yet) or `error` (see `warnings`). On `empty` or `error`, keep showing the last good model.
- `preview`: true while nothing is marked as a part yet.
- Units are mm. The sketch is the XY plane seen from +Z, and extrudes rise along +Z. The GLB is already turned Y-up for three.js; the STL and STEP stay Z-up.

Each build (`sessions/<id>/b000N/`) also gets its own `model.step`, `.stl` and `.glb`.

## Files

- `BoardSketch_Build_Spec.pdf`: earlier concept (labeled circuit checker), kept for comparison.
