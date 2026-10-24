# Where the bridge hands a finished drawing to the AI stage.
# The AI plan replaces the body of on_build. Nothing else in the bridge needs to change.
#
# build = {"build": "b0003", "session", "seq", "receivedAt",
#          "png": path to sketch.png, "part": partSketch() in mm, "elements": raw Excalidraw elements}


def on_build(build):
    part = build["part"]
    features = part.get("features", [])
    holes = sum(len(f.get("holes", [])) for f in features)
    print(f"[handoff] {build['build']}: {len(features)} features, {holes} holes, "
          f"{len(part.get('dimensions', []))} dimensions, image {build['png']}")
    for f in features:
        size = f"{f['depth']} mm deep" if f["type"] == "extrude" else f"{f.get('angle')}°"
        print(f"  {f['type']} {size}, profile {f['profile']['type']}, {len(f.get('holes', []))} holes")
