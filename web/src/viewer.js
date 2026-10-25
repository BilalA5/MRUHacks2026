// The 3D preview in the browser: the laptop's model of this drawing (a GLB, already Y-up and in mm),
// lit and outlined like a CAD view, with orbit, pan and zoom by mouse or fingers.
// It asks the laptop for the model's version every POLL_MS rather than holding a live stream open,
// because the tunnel the web demo uses does not pass streams through.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { api } from "./api.js";

const POLL_MS = 700;
const BG = "#0B0F17", EDGE = 0x0a0f17, ACCENT = 0x35c4e8;
const REFIT = 0.2;   // re-fit the camera when the part's size changes by more than this

// session(): the drawing to follow. onInfo(info | null): the latest model info, for a status line.
export function createViewer(host, session, onInfo) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1e5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3546, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(0.6, 1, 0.8);
  camera.add(sun);                 // the light follows the camera, so every side reads clearly
  scene.add(camera);
  const grid = new THREE.GridHelper(400, 40, ACCENT, 0x1f2937);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  let part = null, size = 0, seq = null, stopped = false, timer = null;
  const loader = new GLTFLoader();

  const resize = () => {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

  function clear() {
    if (!part) return;
    scene.remove(part);
    part.traverse(o => { o.geometry?.dispose(); [].concat(o.material || []).forEach(m => m.dispose()); });
    part = null;
  }

  function fit(box) {
    const length = box.getSize(new THREE.Vector3()).length() || 100, centre = box.getCenter(new THREE.Vector3());
    controls.target.copy(centre);
    camera.position.copy(centre).add(new THREE.Vector3(1, 0.85, 1.1).normalize().multiplyScalar(length * 1.5));
    camera.near = length / 200;
    camera.far = length * 200;
    camera.updateProjectionMatrix();
  }

  async function show(url) {
    const gltf = await loader.loadAsync(api(url));
    if (stopped) return;
    // Dark edges where faces meet at a crease, as in a CAD view
    gltf.scene.traverse(o => {
      if (o.isMesh) o.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 25), new THREE.LineBasicMaterial({ color: EDGE })));
    });
    clear();
    part = gltf.scene;
    scene.add(part);
    const box = new THREE.Box3().setFromObject(part), now = box.getSize(new THREE.Vector3()).length();
    if (!size || Math.abs(now - size) > REFIT * size) fit(box);
    size = now;
    grid.position.y = box.min.y;
  }

  async function poll() {
    timer = null;
    try {
      const res = await fetch(api(`/api/model/info?session=${session()}`), { cache: "no-store" });
      const info = res.ok ? await res.json() : null;
      if (stopped) return;
      onInfo?.(info);
      if (!info || info.status === "empty") { clear(); size = 0; seq = null; }   // nothing closed on the canvas: nothing here
      else if (info.status === "ok" && info.seq !== seq && info.files?.glb) { await show(info.files.glb); seq = info.seq; }
    } catch {
      onInfo?.({ status: "offline" });
    }
    if (!stopped) timer = setTimeout(poll, POLL_MS);
  }
  poll();

  return {
    refit() { if (part) fit(new THREE.Box3().setFromObject(part)); },
    dispose() {
      stopped = true;
      clearTimeout(timer);
      renderer.setAnimationLoop(null);
      observer.disconnect();
      clear();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
