/**
 * Hangar: a standalone viewer for the procedural airframes, lit like the game.
 *
 *   npx esbuild tools/hangar.ts --bundle --format=iife --outfile=<dir>/hangar.js
 *   open <dir>/hangar.html?type=camel&livery=standard&view=34
 *
 * Query parameters:
 *   type     camel | spad | dr1 | albatros | dh4 | gotha | all (a line-up)
 *   livery   livery key ('standard' by default)
 *   view     34 | side | top | chase | cockpit | engine | far | rear | belly | wing | front | gun | tail
 *   pose     ground (parked, the physics' sit) | air
 *   rpm, dmg, fire, gyaw, gpitch, elev, ail, rud, speed   animation state
 *   sun      sun elevation in degrees (default 38)
 *   fov      camera field of view
 *
 * Sets document.title to 'ready' once the frame is drawn, and logs build stats.
 */
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { buildAirframe, airframeStats, LIVERIES, type AirframeRig, type AnimState } from '../src/combat/Airframes';
import { TYPES, type AirframeId } from '../src/combat/Types';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (q.has(k) ? Number(q.get(k)) : d);
const typeParam = (q.get('type') ?? 'camel') as AirframeId | 'all';
const view = q.get('view') ?? '34';
const pose = q.get('pose') ?? (view === 'chase' || view === 'far' ? 'air' : 'ground');

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', 0.58);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.style.margin = '0';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 60), window.innerWidth / window.innerHeight, 0.05, 120000);

// Sky exactly as the game sets it up.
const sky = new Sky();
sky.scale.setScalar(450000);
const u = sky.material.uniforms;
u.turbidity.value = 4.2;
u.rayleigh.value = 2.0;
u.mieCoefficient.value = 0.005;
u.mieDirectionalG.value = 0.87;
sky.material.fragmentShader = sky.material.fragmentShader.replace(
  'gl_FragColor = vec4( retColor, 1.0 );',
  'gl_FragColor = vec4( min( retColor, vec3( 1.0e4 ) ), 1.0 );',
);
const elev = THREE.MathUtils.degToRad(num('sun', 38));
const azim = THREE.MathUtils.degToRad(num('azim', 220));
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - elev, azim);
u.sunPosition.value.copy(sunDir);

const skyScene = new THREE.Scene();
skyScene.add(sky);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(skyScene as unknown as THREE.Scene).texture;
scene.add(sky);

// World.applyAtmosphere at high sun: (0.5 + 1.95) * sun weight; hemisphere 0.5.
const high = THREE.MathUtils.smoothstep(num('sun', 38), 0, 35);
const sun = new THREE.DirectionalLight(0xfff2e0, num('sunI', (0.5 + high * 1.95) * 0.98));
sun.color.setRGB(1.0, Math.min(1, 0.62 + high * 0.35), Math.min(1, 0.38 + high * 0.6));
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbcd6f2, 0x4a4436, num('hemi', (0.16 + high * 0.34) * 0.95));
scene.add(hemi);
scene.fog = new THREE.FogExp2(0xa8c2d8, 0.0000185 * 4);

// Grass airfield.
{
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#5a6a3a';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = `rgba(${40 + Math.random() * 60},${60 + Math.random() * 50},${20 + Math.random() * 30},0.35)`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 6, 1 + Math.random() * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(400, 400);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

const state: AnimState = {
  elevator: num('elev', 0), aileron: num('ail', 0), rudder: num('rud', 0), rpm: num('rpm', pose === 'air' ? 1 : 0.1),
  firing: q.get('fire') === '1', gunnerYaw: num('gyaw', 0), gunnerPitch: num('gpitch', 0), gunnerFiring: q.get('gfire') === '1',
  damage: num('dmg', 0), onGround: pose === 'ground', speed: num('speed', pose === 'air' ? 50 : 0), time: 0,
};

const rigs: { rig: AirframeRig; id: AirframeId }[] = [];
const t0 = performance.now();
const ids: AirframeId[] = typeParam === 'all' ? ['camel', 'spad', 'dr1', 'albatros', 'dh4', 'gotha'] : [typeParam];
let x = 0;
for (const id of ids) {
  const tb = performance.now();
  airframeStats(id);
  const tTemplate = performance.now() - tb;
  const rig = buildAirframe(id, q.get('livery') ?? 'standard');
  const built = performance.now() - tb;
  const tc = performance.now();
  const second = buildAirframe(id, q.get('livery') ?? 'standard');
  const tClone = performance.now() - tc;
  second.dispose();
  console.log(`${id}: template ${tTemplate.toFixed(0)} ms, livery+instance ${(built - tTemplate).toFixed(0)} ms, cached instance ${tClone.toFixed(1)} ms`);
  const st = airframeStats(id);
  console.log(`${id}: built in ${built.toFixed(0)} ms; tris LOD0/1/2 = ${st.triangles.join('/')}; draw calls ${st.drawCalls} (+${st.cockpitDrawCalls} cockpit); size L${st.size.length.toFixed(2)} span${st.size.span.toFixed(2)} H${st.size.height.toFixed(2)}; atlas ${st.atlasScale} px/m; liveries ${LIVERIES[id].join(',')}`);
  if (ids.length > 1) { x += rig.size.span / 2 + 2; }
  const gh = TYPES[id].gearHeight;
  if (pose === 'ground') {
    rig.root.position.set(x, gh, 0);
    rig.root.quaternion.setFromEuler(new THREE.Euler(0.19, num('heading', 0), 0, 'YXZ'));
  } else {
    rig.root.position.set(x, 60, 0);
    rig.root.quaternion.setFromEuler(new THREE.Euler(num('pitch', 0.04), num('heading', 0), num('bank', 0), 'YXZ'));
  }
  if (ids.length > 1) x += rig.size.span / 2 + 2;
  scene.add(rig.root);
  rigs.push({ rig, id });
}
console.log(`total build ${(performance.now() - t0).toFixed(0)} ms`);

// Parked height: highest point above the ground in the sit attitude (near LOD, no prop).
for (const { rig, id } of rigs) {
  rig.root.updateMatrixWorld(true);
  const lod = rig.root.children.find((c) => c instanceof THREE.LOD) as THREE.LOD;
  const b = new THREE.Box3();
  let low = '';
  lod.levels[0].object.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.userData.slot === 'disc' || o.userData.slot === 'flash') return;
    if (/^(prop|disc)\d|^cockpit/.test(o.name)) return;
    const ob = new THREE.Box3().setFromObject(o, true);
    if (ob.min.y < 0.02) {
      // Report where the lowest vertex is, in body space, to find the culprit.
      const pos = o.geometry.attributes.position;
      let best = Infinity, at = new THREE.Vector3();
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (v.y < best) { best = v.y; at = v.clone(); }
      }
      const body = rig.root.worldToLocal(at.clone());
      low += ` ${o.name}:${ob.min.y.toFixed(3)}@(${body.x.toFixed(2)},${body.y.toFixed(2)},${body.z.toFixed(2)})`;
    }
    b.union(ob);
  });
  if (pose === 'ground') console.log(`${id}: parked top ${b.max.y.toFixed(2)} m, lowest ${b.min.y.toFixed(3)} m;${low}`);
}

const main = rigs[Math.floor(rigs.length / 2)].rig;
if (q.has('lod')) {
  // Pin a level of detail to inspect the far models up close.
  for (const { rig } of rigs) {
    const lod = rig.root.children.find((c) => c instanceof THREE.LOD) as THREE.LOD & { pinned: number };
    lod.pinned = num('lod', 0);
  }
}
if (view === 'cockpit') main.setCockpitVisible(true);
for (let i = 0; i < 4; i++) {
  state.time += 0.05;
  for (const { rig } of rigs) rig.animate(state, 0.05);
}

// Camera.
const s = typeParam === 'all' ? 3 : main.size.span / 8.5;
const P = main.root.position.clone();
const Q = main.root.quaternion.clone();
const body = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).applyQuaternion(Q).add(P);
let eye: THREE.Vector3, look: THREE.Vector3;
switch (view) {
  case 'side': eye = body(10 * s, 0.6, 0.6); look = body(0, 0.1, 0.6 * s); break;
  case 'top': eye = body(0.01, 16 * s, 0.6); look = body(0, 0, 0.6); break;
  case 'chase': eye = body(0, 2.4, 10); look = body(0, 0.6, -6); break;
  case 'cockpit': eye = body(main.eyePoint.x, main.eyePoint.y, main.eyePoint.z); look = body(main.eyePoint.x, main.eyePoint.y - num('down', 0.25), main.eyePoint.z - 1); break;
  case 'engine': eye = body(-1.9 * s, 0.7, -3.4 * s); look = body(0, 0.1, -1.2 * s); break;
  case 'far': eye = body(-250, 60, -300); look = body(0, 0, 0); break;
  case 'rear': eye = body(5 * s, 2.5 * s, 7.5 * s); look = body(0, 0.3, 0); break;
  case 'belly': eye = body(-4 * s, -3.5, -4 * s); look = body(0, 0, 0); break;
  case 'wing': eye = body(1.4 * s, 2.2 * s, 0.4); look = body(3.2 * s, 0.9, 0.2); break;
  case 'front': eye = body(0, 0.6, -9 * s); look = body(0, 0.4, 0); break;
  case 'gun': eye = body(2.2 * s, 1.8, 3.2 * s); look = body(0, 0.5, 0.8 * s); break;
  case 'tail': eye = body(2.4 * s, 1.0, 6.5 * s); look = body(0, 0.1, 3.6 * s); break;
  default: eye = body(-6.2 * s, 2.2 * s, -6.8 * s); look = body(0, 0.1, 0.2);
}
if (typeParam === 'all') { eye = new THREE.Vector3(x * 0.62, 7, -38); look = new THREE.Vector3(x * 0.46, 1.2, 0); }
if (q.has('cx')) eye = body(num('cx', 0), num('cy', 0), num('cz', 0));
if (q.has('lx')) look = body(num('lx', 0), num('ly', 0), num('lz', 0));
camera.position.copy(eye);
camera.up.set(0, 1, 0).applyQuaternion(view === 'cockpit' ? Q : new THREE.Quaternion());
camera.lookAt(look);

// Shadow frustum around the subject.
const span = typeParam === 'all' ? x + 10 : main.size.span + 4;
sun.position.copy(P).addScaledVector(sunDir, 200);
sun.target.position.copy(typeParam === 'all' ? new THREE.Vector3(x / 2, 0, 0) : P);
const sc = sun.shadow.camera;
sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 50; sc.far = 400;
sc.updateProjectionMatrix();

let frames = 0;
function frame(): void {
  renderer.render(scene, camera);
  frames++;
  if (frames === 1) console.log(`draw calls: ${renderer.info.render.calls}, triangles: ${renderer.info.render.triangles}`);
  if (frames < 2) requestAnimationFrame(frame);
  else document.title = 'ready';
}
requestAnimationFrame(frame);
(window as unknown as { rigs: typeof rigs }).rigs = rigs;
