# Where the bridge hands a finished drawing on. Each build gets its own 3D model,
# saved next to the drawing (sessions/<id>/b000N/model.step, .stl, .glb, .dxf, drawing.svg), so builds can be compared later.
# The live model that follows the stream is built separately, in model.LiveBuilder.
#
# build = {"build": "b0003", "session", "seq", "receivedAt",
#          "png": path to sketch.png, "part": partSketch() in mm, "elements": raw Excalidraw elements}
from pathlib import Path

import model

ROOT = Path(__file__).resolve().parent


def on_build(build):
    solid, info = model.build(build["part"])
    if solid is not None:
        model.export(solid, ROOT / Path(build["png"]).parent, part=build["part"], info=info)
    print(f"[handoff] {build['build']}: {info['status']}, {info.get('features', 0)} features, "
          f"volume {info.get('volume', 0)} mm³" + "".join(f"\n  warning: {w}" for w in info["warnings"]))
