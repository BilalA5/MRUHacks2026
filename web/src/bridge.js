// The sending side of the bridge: streams the drawing to the laptop while the user draws.
// See Bridge_Plan.md for the shared contract with the laptop (server.py).
//
// Nothing gets lost because every message is a full snapshot with a sequence number. The outbox keeps
// only the newest unsent snapshot and retries it until the laptop acks it, so a dropped, repeated or
// late message never matters: the next one replaces it completely.
import { exportToBlob } from "@excalidraw/excalidraw";

const QUIET_MS = 250;         // send this long after the last change...
const MAX_WAIT_MS = 1000;     // ...but never later than this while the user keeps drawing
const SLOW_BYTES = 500000;    // a snapshot this big slows sending to one a second, to spare the hotspot
const BACKOFF_MS = [500, 1000, 2000, 4000];

const newSession = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
const wait = ms => new Promise(r => setTimeout(r, ms));
const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// POST JSON. Resolves with the body on 2xx; a 4xx rejects with the server's reason and is not retried;
// a 5xx or a network failure rejects with retry set.
async function post(path, body) {
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  } catch {
    throw Object.assign(new Error("Laptop not answering"), { retry: true });
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  throw Object.assign(new Error(data.detail || `Laptop answered ${res.status}`), { retry: res.status >= 500 });
}

// api: the Excalidraw API. partOf(elements): the part in mm (partSketch).
// onStatus({ state: "live" | "syncing" | "offline" | "error", waiting, text }) runs whenever the link changes.
export function createBridge({ api, partOf, onStatus }) {
  const session = newSession();
  let seq = 0;               // the newest snapshot made
  let acked = 0;             // the newest snapshot the laptop has confirmed
  let pending = null;        // the newest snapshot not yet sent
  let inFlight = null;       // the snapshot being sent now
  let lastSnap = null;       // the newest snapshot made, for Build
  let version = -1;          // scene version of the newest snapshot
  let firstChange = null;    // when the current run of unsent changes began
  let timer = null;          // waits out QUIET_MS / MAX_WAIT_MS
  let retryTimer = null, tries = 0;
  let reachable = false;     // the laptop answered last time we tried
  let error = null;          // a reason the laptop refused a snapshot
  let slow = false;
  const ackWaiters = [];
  let stopped = false;

  const status = () => {
    const waiting = seq - acked;
    let state, text;
    if (error) { state = "error"; text = `Laptop refused: ${error}`; }
    else if (!reachable) { state = "offline"; text = waiting ? `Offline · ${waiting} change${waiting > 1 ? "s" : ""} waiting` : "Offline"; }
    else if (waiting || inFlight || timer) { state = "syncing"; text = "Syncing"; }
    else { state = "live"; text = "Live"; }
    onStatus?.({ state, waiting, text });
  };

  // The scene changes whenever any element's version goes up, deleted ones included, so the sum only grows.
  const sceneVersion = elements => elements.reduce((t, el) => t + el.version, 0);

  function snapshotNow() {
    clearTimeout(timer);
    timer = null;
    firstChange = null;
    const elements = api.getSceneElements().filter(el => !el.isDeleted);
    let part;
    try { part = partOf(elements); } catch (e) { part = { error: String(e) }; }
    const s = api.getAppState();
    seq += 1;
    lastSnap = pending = {
      session, seq, sentAt: 0, elements, part,
      view: { width: s.width, height: s.height, zoom: s.zoom.value, scrollX: s.scrollX, scrollY: s.scrollY },
    };
    pump();
  }

  // Sends the newest pending snapshot, one request at a time, retrying forever with backoff.
  async function pump() {
    status();
    if (stopped || inFlight || !pending || retryTimer) return;
    inFlight = pending;
    pending = null;
    status();
    try {
      const body = JSON.stringify({ ...inFlight, sentAt: Date.now() });
      slow = body.length > SLOW_BYTES;
      const res = await post("/api/scene", body);
      acked = Math.max(acked, res.ack);
      reachable = true;
      tries = 0;
      error = null;
    } catch (e) {
      if (e.retry) {
        reachable = false;
        pending = pending || inFlight;    // never drop the newest snapshot
        retryTimer = setTimeout(() => { retryTimer = null; pump(); }, BACKOFF_MS[Math.min(tries++, BACKOFF_MS.length - 1)]);
      } else {
        error = e.message;                // a bad snapshot is not retried; the next change sends a new one
        reachable = true;
        while (ackWaiters.length && ackWaiters[0].seq <= inFlight.seq) ackWaiters.shift().reject(new Error(`Laptop refused the drawing: ${e.message}`));
      }
    }
    inFlight = null;
    while (ackWaiters.length && acked >= ackWaiters[0].seq) ackWaiters.shift().resolve();
    pump();
  }

  // Every board change. Panning and zooming leave the version alone and send nothing.
  function changed(elements) {
    const v = sceneVersion(elements);
    if (v === version) return;
    version = v;
    const now = Date.now();
    firstChange = firstChange ?? now;
    clearTimeout(timer);
    const quiet = slow ? MAX_WAIT_MS : QUIET_MS;
    timer = setTimeout(snapshotNow, Math.max(0, Math.min(quiet, firstChange + MAX_WAIT_MS - now)));
    status();
  }

  // Send now: unsent changes go out at once, and a waiting retry is tried straight away.
  function flush() {
    if (timer) snapshotNow();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; tries = 0; }
    pump();
  }

  // Resolves once the laptop has snapshot n, however long that takes.
  const acknowledged = n => acked >= n ? Promise.resolve() : new Promise((resolve, reject) => ackWaiters.push({ seq: n, resolve, reject }));

  // Build: the drawing exactly as it is now, once the laptop has it, with a picture for the AI.
  // onWaiting runs if the laptop is slow to confirm. Resolves with the build id.
  let building = null;
  async function build(onWaiting) {
    if (building) throw new Error("Already sending a build");
    building = { cancelled: false };
    const me = building;
    try {
      if (timer || !lastSnap) snapshotNow();
      const snap = lastSnap;
      const hint = setTimeout(() => onWaiting?.(), 300);
      await acknowledged(snap.seq).finally(() => clearTimeout(hint));
      if (me.cancelled) throw new Error("Build cancelled");
      const blob = await exportToBlob({
        elements: snap.elements,
        appState: { exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
        files: api.getFiles(),
        mimeType: "image/png",
        exportPadding: 24,
        getDimensions: (w, h) => { const scale = Math.min(2, 2400 / Math.max(w, h)); return { width: w * scale, height: h * scale, scale }; },
      });
      const body = JSON.stringify({ session, seq: snap.seq, png: await blobToDataUrl(blob), elements: snap.elements, part: snap.part });
      for (let i = 0; ; i++) {
        try {
          return (await post("/api/build", body)).build;
        } catch (e) {
          if (!e.retry || me.cancelled) throw e;
          onWaiting?.();
          await wait(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
          if (me.cancelled) throw new Error("Build cancelled");
        }
      }
    } finally {
      building = null;
    }
  }
  function cancelBuild() {
    if (!building) return;
    building.cancelled = true;
    while (ackWaiters.length) ackWaiters.shift().reject(new Error("Build cancelled"));
  }

  // Safari pauses a page in the background: send when it hides and again when it comes back,
  // and as soon as the network returns.
  const onVisible = () => flush();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onVisible);

  // Find out straight away whether the laptop is there, so the status is right before the first stroke.
  (async function checkHealth() {
    for (let i = 0; !stopped && !reachable; i++) {
      try {
        const res = await fetch("/api/health");
        if (res.ok) { reachable = true; status(); return; }
      } catch {}
      status();
      await wait(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
    }
  })();

  const bridge = {
    get session() { return session; },
    get seq() { return seq; },
    get acked() { return acked; },
    get pending() { return pending; },
    changed, flush, build, cancelBuild,
    stop() {
      stopped = true;
      clearTimeout(timer); clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    },
  };
  status();
  return bridge;
}
