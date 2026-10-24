# Pretends to be the iPad canvas, to test the bridge without it.
# Streams snapshots with some skipped, sent twice, or arriving late (out of order),
# then checks the laptop ended up with exactly the newest one.
#
#   python3 tools/fake_ipad.py            stream test
#   python3 tools/fake_ipad.py --build    then send one build
import argparse
import json
import random
import string
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# A 1x1 white PNG, enough to test the build path
PNG = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
       "/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==")


def call(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


# Like the canvas outbox: keep retrying through network errors and server restarts
def send(url, body):
    wait = 0.5
    while True:
        try:
            return call(url, body)
        except urllib.error.HTTPError as e:
            if e.code < 500:
                raise
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        print(f"  laptop not answering, retrying in {wait:g} s")
        time.sleep(wait)
        wait = min(wait * 2, 4)


def snapshot(session, seq):
    elements = [{"id": f"e{i}", "type": "line", "x": i * 20, "y": 0, "version": seq, "points": [[0, 0], [10, 10]]}
                for i in range(seq % 30 + 1)]
    return {"session": session, "seq": seq, "sentAt": int(time.time() * 1000), "elements": elements,
            "part": {"units": "mm", "features": [], "notes": [{"text": f"snapshot {seq}", "at": [0, 0]}]},
            "view": {"width": 1180, "height": 820, "zoom": 1, "scrollX": 0, "scrollY": 0}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--count", type=int, default=200)
    ap.add_argument("--delay", type=float, default=0.05, help="seconds between snapshots")
    ap.add_argument("--build", action="store_true")
    args = ap.parse_args()
    scene = args.url + "/api/scene"
    session = "fake-" + "".join(random.choices(string.ascii_lowercase, k=4))
    rng = random.Random(1)
    held, problems, acked = [], [], 0
    counts = {"skipped": 0, "twice": 0, "late": 0}

    def post(snap):
        nonlocal acked
        ack = send(scene, snap)["ack"]
        if ack < acked:
            problems.append(f"ack went backwards: {ack} after {acked}")
        acked = max(acked, ack)

    for seq in range(1, args.count + 1):
        snap, r = snapshot(session, seq), rng.random()
        if seq < args.count and r < 0.1:
            counts["skipped"] += 1
            continue
        if seq < args.count and r < 0.2:
            held.append(snap)            # delivered later, after newer ones
            counts["late"] += 1
            continue
        post(snap)
        if r < 0.3:
            post(snap)
            counts["twice"] += 1
        if held and rng.random() < 0.5:
            post(held.pop(0))
        time.sleep(args.delay)
    for snap in held:
        post(snap)

    # The laptop must hold the newest snapshot exactly (sentAt differs per send, so it is not compared)
    got = call(f"{scene}?session={session}")
    want = snapshot(session, args.count)
    want.pop("sentAt")
    if acked != args.count:
        problems.append(f"newest ack is {acked}, expected {args.count}")
    if any(got.get(k) != v for k, v in want.items()):
        problems.append(f"laptop has snapshot {got.get('seq')}, not {args.count}")

    try:
        call(scene, {"session": session, "seq": 0, "elements": [], "part": {}})
        problems.append("a snapshot with seq 0 was accepted")
    except urllib.error.HTTPError as e:
        if e.code != 400:
            problems.append(f"bad snapshot got HTTP {e.code}, expected 400")

    if args.build:
        final = {k: got[k] for k in ("session", "seq", "elements", "part")}
        build = send(args.url + "/api/build", {**final, "png": PNG})["build"]
        folder = ROOT / "sessions" / session / build
        missing = [n for n in ("sketch.png", "part.json", "elements.json") if not (folder / n).exists()]
        if missing:
            problems.append(f"build {build} is missing {', '.join(missing)}")
        print(f"build {build} saved to {folder.relative_to(ROOT)}")

    print(f"session {session}: {args.count} snapshots, {counts['skipped']} skipped, "
          f"{counts['twice']} sent twice, {counts['late']} arrived late")
    print("PASS" if not problems else "FAIL\n  " + "\n  ".join(problems))


if __name__ == "__main__":
    main()
