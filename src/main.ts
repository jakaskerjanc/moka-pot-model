// Model viewer for the procedural moka pot.
// URL params: view=front|three-quarter|side|rear|top, lid=0..1, explode=0..1, zoom, yaw (deg), tx/ty (target, m),
// w/h = fixed render size (for reference-matched captures), bg=hex or "transparent",
// solo=<partId> shows only that part's meshes (flip=1 turns the model upside down, like a part photo),
// env=<hdri name in public/hdri> or "studio" (procedural softbox room), envYaw (deg) rotates the environment,
// envI scales its intensity, table=none removes the wooden tabletop (solo views never show it).

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createMokaPotModel, getMokaPotRuntime } from './model/createMokaPotModel';
import { createStudioEnvironment, loadHdriEnvironment } from './scene/studioEnvironment';
import { createTable } from './scene/table';

const params = new URLSearchParams(location.search);
const fixedWidth = Number(params.get('w')) || 0;
const fixedHeight = Number(params.get('h')) || 0;
const background = params.get('bg') ?? 'ffffff';
const tableVisible = params.get('table') !== 'none' && !params.get('solo');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(fixedWidth ? 1 : Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
if (background === 'transparent') {
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
}
else scene.background = new THREE.Color(`#${background}`);
// Photographed studio (Poly Haven "white_studio_03", CC0). Rotation and intensity were fitted to the
// reference photo by sweeping both and comparing per-facet luminance (.img2threejs/region_values.py).
const environmentName = params.get('env') ?? 'white_studio_03';
let environmentReady = environmentName === 'studio';
scene.environmentRotation.y = THREE.MathUtils.degToRad(Number(params.get('envYaw') ?? (environmentReady ? 0 : 30)));
// 2.5 matches the white-background reference photo; on the wooden table that reads blown-out, so it drops to 1.
scene.environmentIntensity = Number(params.get('envI')) || (environmentReady || tableVisible ? 1 : 2.5);
if (environmentReady) scene.environment = createStudioEnvironment(renderer);
else {
  loadHdriEnvironment(renderer, `${import.meta.env.BASE_URL}hdri/${environmentName}.hdr`).then(
    (texture) => {
      scene.environment = texture;
      environmentReady = true;
    },
    (error) => {
      console.error(`HDRI "${environmentName}" failed to load, using the procedural studio`, error);
      scene.environment = createStudioEnvironment(renderer);
      scene.environmentRotation.y = 0;
      scene.environmentIntensity = 1;
      environmentReady = true;
    },
  );
}

// Hard overhead key from front-left: the contact shadow pools under the base, as in the
// reference photo, with a crisp edge.
const key = new THREE.DirectionalLight(0xffffff, 1.3);
key.position.set(-0.2, 1.0, 0.2);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -0.25;
key.shadow.camera.right = 0.25;
key.shadow.camera.top = 0.25;
key.shadow.camera.bottom = -0.25;
key.shadow.camera.near = 0.1;
key.shadow.camera.far = 1.5;
key.shadow.bias = -0.0005;
key.shadow.radius = 2;
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.1);
fill.position.set(0.4, 0.2, 0.2);
scene.add(fill);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.3 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Wooden tabletop under the pot; it receives the key light's shadow itself, so the shadow-only ground steps aside.
if (tableVisible) {
  scene.add(createTable(renderer));
  ground.visible = false;
}

// Soft contact shadow pooled under the base (ambient occlusion against the floor), matching the
// photo's dark band under the boiler. A radial gradient on a floor quad slightly wider than the base.
function createContactShadow(): THREE.Mesh {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(size / 2, size / 2, size * 0.22, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0.75)');
  gradient.addColorStop(0.45, 'rgba(0,0,0,0.3)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.13, 0.13),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.0002;
  shadow.renderOrder = -1;
  return shadow;
}
const contactShadow = createContactShadow();
scene.add(contactShadow);

const model = createMokaPotModel();
scene.add(model);
// mode=clay: every surface gets one matte material and no maps (map-stripped silhouette/form check).
if (params.get('mode') === 'clay') {
  const clay = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.85, metalness: 0 });
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.visible = !(mesh.material as THREE.Material).transparent;
    mesh.material = clay;
  });
}
const runtime = getMokaPotRuntime(model);
const solo = params.get('solo');
if (solo) {
  model.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) object.visible &&= object.userData.partId === solo;
  });
  contactShadow.visible = false;
}
if (params.get('flip') === '1') {
  model.rotation.x = Math.PI;
  model.position.y = 0.16;
}

// Reference framing (solved by silhouette sweep, IoU 0.97): long-lens product shot, fov 12°,
// face-on facet, 5° elevation, aimed at
// the pot's axis. The photo is cropped off-centre, which we reproduce with a film shift
// (view offset) rather than by moving the camera — moving it would skew the perspective.
// Measured from the reference (1126×1294 px, 0.14423 mm/px): axis at x = 486 px.
const REFERENCE = {
  target: new THREE.Vector3(0, Number(params.get('ty')) || 0.0792, 0),
  halfHeight: 0.0933,
  pitchDeg: Number(params.get('pitch')) || 5,
  fov: Number(params.get('fov')) || 12,
  shiftX: 77 / 1126,
  shiftY: Number(params.get('sy')) || 0,
};
const camera = new THREE.PerspectiveCamera(REFERENCE.fov, 1, 0.01, 20);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

function setView(view: string): void {
  const zoom = Number(params.get('zoom')) || 1;
  const distance = REFERENCE.halfHeight / Math.tan(THREE.MathUtils.degToRad(REFERENCE.fov / 2)) / zoom;
  const yawDeg: Record<string, number> = { front: 0, 'three-quarter': 40, side: 90, rear: 180, left: -90 };
  const pitch = THREE.MathUtils.degToRad(view === 'top' ? 45 : REFERENCE.pitchDeg);
  const yaw = THREE.MathUtils.degToRad(Number(params.get('yaw') ?? NaN) || (yawDeg[view] ?? 0));
  const target = view === 'front' ? REFERENCE.target.clone() : new THREE.Vector3(Number(params.get('tx')) || 0.004, Number(params.get('ty')) || 0.082, 0);
  filmShift = view === 'front' ? REFERENCE.shiftX : 0;
  camera.position.set(
    target.x + distance * Math.cos(pitch) * Math.sin(yaw),
    target.y + distance * Math.sin(pitch),
    target.z + distance * Math.cos(pitch) * Math.cos(yaw),
  );
  controls.target.copy(target);
  camera.lookAt(target);
  controls.update();
}

let filmShift = 0;
function resize(): void {
  const width = fixedWidth || innerWidth;
  const height = fixedHeight || innerHeight;
  renderer.setSize(width, height, false);
  renderer.domElement.style.width = `${width}px`;
  renderer.domElement.style.height = `${height}px`;
  camera.aspect = width / height;
  if (filmShift) camera.setViewOffset(width, height, filmShift * width, REFERENCE.shiftY * height, width, height);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
setView(params.get('view') ?? 'front');
resize();

// --- interaction: click a part to select it, L toggles the lid, E toggles explode.
const label = document.createElement('div');
label.style.cssText =
  'position:fixed;left:12px;top:12px;font:13px/1.4 system-ui,sans-serif;color:#222;background:#ffffffd0;padding:6px 10px;border-radius:6px;pointer-events:none';
label.textContent = 'Click a part · L lid · E explode';
if (!fixedWidth) document.body.appendChild(label);

const selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0xff6a00);
selectionBox.visible = false;
scene.add(selectionBox);
let selected: THREE.Object3D | null = null;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDown = new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown', (event) => pointerDown.set(event.clientX, event.clientY));
renderer.domElement.addEventListener('pointerup', (event) => {
  if (pointerDown.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 4) return; // orbit drag, not a click
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(Object.values(runtime.meshes), false).find((h) => h.object.visible);
  selected = hit ? runtime.nodes[hit.object.userData.partId] ?? null : null;
  selectionBox.visible = !!selected;
  label.textContent = selected ? `Part: ${selected.name}` : 'Click a part · L lid · E explode';
});

const targets = { lid: Number(params.get('lid')) || 0, explode: Number(params.get('explode')) || 0 };
const current = { ...targets };
addEventListener('keydown', (event) => {
  if (event.key === 'l' || event.key === 'L') targets.lid = targets.lid > 0.5 ? 0 : 1;
  if (event.key === 'e' || event.key === 'E') targets.explode = targets.explode > 0.5 ? 0 : 1;
});

const clock = new THREE.Clock();
let frames = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const ease = 1 - Math.exp(-dt * 8);
  current.lid += (targets.lid - current.lid) * ease;
  current.explode += (targets.explode - current.explode) * ease;
  runtime.setLidOpen(current.lid);
  runtime.setExplode(current.explode);
  if (selected) selectionBox.box.setFromObject(selected);
  controls.update();
  renderer.render(scene, camera);
  if (environmentReady) frames += 1;
  if (frames === 3) (window as unknown as { __MOKA_READY: boolean }).__MOKA_READY = true;
});

/** Runtime dump of the built part tree, for the img2threejs part-coverage gate. */
function partManifest() {
  const triangles = (mesh: THREE.Mesh) => {
    const geometry = mesh.geometry;
    return (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
  };
  const meshes = Object.values(runtime.meshes);
  const parts = Object.keys(runtime.nodes).map((name) => {
    const own = meshes.filter((mesh) => mesh.userData.partId === name);
    return { name, kind: 'part', module: name, meshes: own.length, triangles: own.reduce((sum, mesh) => sum + triangles(mesh), 0) };
  });
  const unnamedMeshes = meshes.filter((mesh) => !runtime.nodes[mesh.userData.partId]).length;
  return { model: 'bialetti-moka-express-3-cup', parts, unnamedMeshes, integralMeshes: meshes.length };
}

Object.assign(window, { __MOKA: { runtime, setView, scene, camera, renderer, model, partManifest } });
