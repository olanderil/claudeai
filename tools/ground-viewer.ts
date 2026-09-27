import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { PostFX } from '../src/render/PostFX';
import { clampSunlight } from '../src/world/SkyClamp';
import { buildGround, buildKiteBalloon, buildZeppelin, type GroundKind, type ModelRig } from '../src/combat/GroundModels';

/**
 * Standalone look-dev viewer for the combat models (GroundModels.ts), lit the
 * way the game is: Preetham sky, warm sun with PCF soft shadows, hemisphere
 * fill, PMREM environment from the sky, ACES at 0.58 through the game's own
 * PostFX chain (HDR, bloom threshold 4, MSAA).
 *
 * Build: npx esbuild tools/ground-viewer.ts --bundle --format=iife --outfile=<dir>/gv.js
 * Drive it from a headless browser with window.show({...}).
 */

type Kind = GroundKind | 'balloon' | 'zeppelin' | 'grid';
interface Spec {
  kind: Kind;
  side?: 'allied' | 'central';
  /** Seconds since destruction (0 = intact). */
  t?: number;
  dist?: number;
  /** Camera elevation (deg) and azimuth (deg, 0 = looking from -Z toward +Z... see below). */
  elev?: number;
  az?: number;
  fov?: number;
  /** Look-at height offset. */
  ty?: number;
  tx?: number;
  tz?: number;
  sunElev?: number;
  sunAz?: number;
  /** Model altitude above the ground plane (balloons, Zeppelin). */
  alt?: number;
  lit?: number;
  /** Rotate the model (deg). */
  yaw?: number;
  aim?: [number, number, number];
}

const renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance', stencil: false });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.58;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
document.body.style.margin = '0';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, 300000);
const fx = new PostFX(renderer, scene, camera, {
  bloom: true, bloomStrength: 0.62, bloomThreshold: 4, samples: 4, grain: 0.02, vignette: 0.3, depthOfField: false,
});
fx.setSize(window.innerWidth, window.innerHeight);

const sky = new Sky();
sky.scale.setScalar(450000);
sky.material.fragmentShader = clampSunlight(sky.material.fragmentShader);
const su = sky.material.uniforms;
su.turbidity.value = 4.2; su.rayleigh.value = 2.0; su.mieCoefficient.value = 0.005; su.mieDirectionalG.value = 0.87;
sky.renderOrder = -100;
scene.add(sky);
const sun = new THREE.DirectionalLight(0xfff2e0, 2.45);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbcd6f2, 0x4a4436, 0.48);
scene.add(hemi);
scene.fog = new THREE.FogExp2(0xa8c2d8, 0.0000185);

// Ground: a grass field with a painted mottle so scale reads.
function grassTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const x = c.getContext('2d')!;
  x.fillStyle = '#5b6b3a'; x.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = Math.random();
    x.fillStyle = `rgba(${60 + v * 60},${80 + v * 50},${35 + v * 25},0.35)`;
    x.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 6, 2 + Math.random() * 6);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(400, 400);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 0.95, color: 0xc8d0b0 }));
ground.receiveShadow = true;
scene.add(ground);

const pmrem = new THREE.PMREMGenerator(renderer);
let envRT: THREE.WebGLRenderTarget | null = null;
function setSun(elev: number, az: number): void {
  const dir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), THREE.MathUtils.degToRad(az));
  su.sunPosition.value.copy(dir);
  const high = THREE.MathUtils.smoothstep(elev, 0, 35);
  sun.intensity = 0.5 + high * 1.95;
  sun.color.setRGB(1.0, Math.min(1, 0.62 + high * 0.35), Math.min(1, 0.38 + high * 0.6));
  hemi.intensity = (0.16 + high * 0.34) * 0.95;
  sun.userData.dir = dir;
  const skyScene = new THREE.Scene();
  skyScene.add(sky);
  envRT?.dispose();
  envRT = pmrem.fromScene(skyScene);
  scene.environment = envRT.texture;
  scene.add(sky);
}

let models: { rig: ModelRig; kind: Kind }[] = [];
const clock = { time: 0 };
let spec: Spec = { kind: 'hangar' };

function clear(): void {
  for (const m of models) { scene.remove(m.rig.root); m.rig.dispose(); }
  models = [];
}

function place(kind: Kind, side: 'allied' | 'central', pos: THREE.Vector3, yaw: number, t: number): ModelRig {
  const rig = kind === 'balloon' ? buildKiteBalloon(side) : kind === 'zeppelin' ? buildZeppelin() : buildGround(kind as GroundKind, side);
  rig.root.position.copy(pos);
  rig.root.rotation.y = yaw;
  scene.add(rig.root);
  rig.root.updateMatrixWorld(true);
  rig.setDestroyed(t);
  models.push({ rig, kind });
  return rig;
}

const GRID: GroundKind[] = ['hangar', 'aagun', 'artillery', 'mgnest', 'lorry', 'dump', 'hq', 'hut', 'tent', 'winch', 'searchlight'];

function show(s: Spec): string {
  spec = s;
  clear();
  const side = s.side ?? 'allied';
  const t = s.t ?? 0;
  setSun(s.sunElev ?? 38, s.sunAz ?? 215);
  const target = new THREE.Vector3(s.tx ?? 0, s.ty ?? 0, s.tz ?? 0);
  const yaw = THREE.MathUtils.degToRad(s.yaw ?? 0);
  let focus = 30;
  if (s.kind === 'grid') {
    GRID.forEach((k, i) => {
      const col = i % 4, row = Math.floor(i / 4);
      place(k, side, new THREE.Vector3((col - 1.5) * 34, 0, (row - 1) * 34), yaw, t);
    });
    focus = 90;
  } else {
    const alt = s.alt ?? (s.kind === 'balloon' ? 300 : s.kind === 'zeppelin' ? 900 : 0);
    const rig = place(s.kind, side, new THREE.Vector3(0, alt, 0), yaw, t);
    target.y += alt;
    focus = s.kind === 'zeppelin' ? 120 : s.kind === 'balloon' ? 40 : Math.max(12, rig.radius * 1.4);
    if (s.lit !== undefined) rig.setLit?.(s.lit);
  }
  const dist = s.dist ?? 150;
  const el = THREE.MathUtils.degToRad(s.elev ?? 45);
  const az = THREE.MathUtils.degToRad(s.az ?? 30);
  camera.fov = s.fov ?? 58;
  camera.position.set(target.x + Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z - Math.cos(az) * Math.cos(el) * dist);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  // Shadow frustum around the subject, as the game centres it on the action.
  const dir = sun.userData.dir as THREE.Vector3;
  sun.position.copy(target).addScaledVector(dir, 1500);
  sun.target.position.copy(target);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -focus; sc.right = sc.top = focus; sc.near = 1; sc.far = 4000;
  sc.updateProjectionMatrix();
  for (const m of models) m.rig.animate(0.016, clock.time, s.aim ? new THREE.Vector3(...s.aim).normalize() : undefined);
  const tris = renderer.info.render.triangles;
  return `ok ${s.kind} tris(last)=${tris}`;
}

function stats(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  renderer.info.autoReset = false;
  renderer.info.reset();
  fx.render(0.016);
  out.calls = renderer.info.render.calls;
  out.triangles = renderer.info.render.triangles;
  renderer.info.autoReset = true;
  return out;
}

/** Per-model draw calls / triangles (shadow pass excluded) at a given camera distance. */
function measure(kind: Kind, side: 'allied' | 'central', dist: number, t = 0): Record<string, unknown> {
  show({ kind, side, dist, elev: 45, t });
  ground.visible = false; sky.visible = false;
  const shadows = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  renderer.info.autoReset = false;
  renderer.info.reset();
  renderer.render(scene, camera);
  const r = { kind, side, dist, t, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  renderer.info.autoReset = true;
  renderer.shadowMap.enabled = shadows;
  ground.visible = true; sky.visible = true;
  return r;
}

let last = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock.time += dt;
  for (const m of models) m.rig.animate(dt, clock.time, spec.aim ? new THREE.Vector3(...spec.aim).normalize() : undefined);
  fx.render(dt);
  requestAnimationFrame(frame);
}

Object.assign(window as unknown as Record<string, unknown>, { show, stats, measure });
const params = new URLSearchParams(location.search);
const initial = params.get('spec');
show(initial ? (JSON.parse(initial) as Spec) : { kind: 'grid', dist: 220, elev: 40 });
requestAnimationFrame(frame);
(window as unknown as Record<string, unknown>).ready = true;
