import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { aerodromes, fieldFrame, fieldPoint, type Aerodrome } from './Front';
import { terrainHeight } from './Worlds';

/**
 * Everything on a 1917 aerodrome that is not an aeroplane or a hangar: the
 * Nissen huts and timber huts of the squadron, bell tents in rows, a mess
 * marquee, fuel drums stacked by the sheds and a tall windsock at the corner
 * of the landing ground. The grass, the mowing stripes and the white landing T
 * are painted by the terrain; the canvas hangars go in the hangar slots, which
 * the combat layer fills.
 *
 * Instanced by kind across every field, main and minor, so the whole lot is
 * six draw calls however many aerodromes a world has.
 */

type Kind = 'nissen' | 'hut' | 'bell' | 'marquee' | 'drums' | 'sock';
const KINDS: Kind[] = ['nissen', 'hut', 'bell', 'marquee', 'drums', 'sock'];

function paint(geo: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  if (flat !== geo) geo.dispose();
  if (flat.attributes.uv) flat.deleteAttribute('uv');
  const n = flat.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  flat.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return flat;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return paint(g, c);
}

/** A pitched roof, ridge along Z. */
function gable(w: number, h: number, d: number, y: number, c: THREE.Color): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(0, h);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  g.translate(0, y, -d / 2);
  return paint(g, c);
}

const IRON = new THREE.Color(0.10, 0.11, 0.095);
const TIMBER = new THREE.Color(0.20, 0.15, 0.10);
const TAR = new THREE.Color(0.10, 0.10, 0.10);
const CANVAS = new THREE.Color(0.46, 0.43, 0.34);
const CANVAS_DARK = new THREE.Color(0.36, 0.33, 0.25);
const DRUM = new THREE.Color(0.24, 0.26, 0.20);
const WHITE = new THREE.Color(0.85, 0.84, 0.80);
const SOCK = new THREE.Color(0.78, 0.74, 0.66);

/** Nissen hut: a half-cylinder of corrugated iron on a low plinth, long axis along Z. */
function nissen(): THREE.BufferGeometry {
  // Theta from π/2 to 3π/2 is the upper half once the axis is laid along Z.
  const shell = new THREE.CylinderGeometry(4.2, 4.2, 16, 12, 1, false, Math.PI / 2, Math.PI);
  shell.rotateX(Math.PI / 2);
  shell.translate(0, 0.3, 0);
  return mergeGeometries([
    paint(shell, IRON),
    box(8.6, 0.3, 16.2, 0, 0, 0, TIMBER),
    box(1.2, 2.1, 0.2, 0, 0.3, -8.05, TIMBER),
  ], false);
}

function hut(): THREE.BufferGeometry {
  return mergeGeometries([
    box(6, 3, 14, 0, 0, 0, TIMBER),
    gable(6.8, 1.9, 14.6, 3, TAR),
    box(1.0, 2.0, 0.15, 3.05, 0, 2, TAR),
  ], false);
}

function bell(): THREE.BufferGeometry {
  const c = new THREE.ConeGeometry(2.4, 3.2, 10, 1, false);
  c.translate(0, 1.6, 0);
  const wall = new THREE.CylinderGeometry(2.4, 2.4, 0.5, 10, 1, true);
  wall.translate(0, 0.25, 0);
  const cone = paint(c, CANVAS);
  cone.translate(0, 0.45, 0);
  return mergeGeometries([paint(wall, CANVAS_DARK), cone], false);
}

function marquee(): THREE.BufferGeometry {
  return mergeGeometries([
    box(9, 2.3, 16, 0, 0, 0, CANVAS_DARK),
    gable(9.4, 2.6, 16.4, 2.3, CANVAS),
  ], false);
}

function drums(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const spots: [number, number, number][] = [
    [0, 0, 0], [0.62, 0, 0], [1.24, 0, 0], [0.31, 0, 0.55], [0.93, 0, 0.55], [0.62, 0.9, 0.28],
    [2.6, 0, 0.3], [3.2, 0, 0.1],
  ];
  for (const [x, y, z] of spots) {
    const g = new THREE.CylinderGeometry(0.29, 0.29, 0.88, 8);
    g.translate(x, y + 0.44, z);
    parts.push(paint(g, DRUM));
  }
  return mergeGeometries(parts, false);
}

/** A tall mast with a striped sock streaming downwind (toward local +Z). */
function sock(): THREE.BufferGeometry {
  const mast = new THREE.CylinderGeometry(0.08, 0.14, 11, 6);
  mast.translate(0, 5.5, 0);
  const cone = new THREE.CylinderGeometry(0.55, 0.22, 3.6, 8, 1, true);
  cone.rotateX(Math.PI / 2 - 0.28);
  cone.translate(0, 10.4, 1.9);
  const ring = new THREE.TorusGeometry(0.55, 0.05, 4, 10);
  ring.translate(0, 10.9, 0.05);
  return mergeGeometries([paint(mast, WHITE), paint(cone, SOCK), paint(ring, TAR)], false);
}

const GEOMETRY: Record<Kind, () => THREE.BufferGeometry> = {
  nissen, hut, bell, marquee, drums, sock,
};

interface Placed { kind: Kind; x: number; z: number; yaw: number; }

/** Lay out one field's buildings behind its hangar row. */
function dress(a: Aerodrome, out: Placed[]): void {
  const f = fieldFrame(a);
  const hr = (a.headingDeg * Math.PI) / 180;
  // Toward the field (+right) and along the run.
  const doorYaw = Math.atan2(-f.rightX, -f.rightZ);
  const runYaw = -hr;
  const put = (kind: Kind, along: number, right: number, yaw: number): void => {
    const p = fieldPoint(a, along, right);
    out.push({ kind, x: p.x, z: p.z, yaw });
  };
  const L = a.halfLength;
  const W = a.halfWidth;
  // Downwind is −along; the sock streams that way, so it faces the run.
  if (!a.main) {
    put('marquee', -L * 0.35, -(W + 32), doorYaw);
    put('bell', -L * 0.35 + 20, -(W + 48), 0);
    put('bell', -L * 0.35 + 30, -(W + 44), 0);
    put('drums', -L * 0.35 - 16, -(W + 24), runYaw);
    put('sock', -L * 0.8, -(W - 4), runYaw + Math.PI);
    return;
  }
  const start = -L * 0.55;
  // Behind the hangar row: Nissen huts end-on to the field, then the timber
  // offices, the tent lines and the mess.
  for (let i = 0; i < 3; i++) put('nissen', start - 10 + i * 22, -(W + 82), doorYaw);
  put('hut', start + 82, -(W + 74), doorYaw + Math.PI / 2);
  put('hut', start + 104, -(W + 74), doorYaw + Math.PI / 2);
  put('hut', start + 60, -(W + 118), doorYaw);
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 6; i++) put('bell', start + 150 + i * 11, -(W + 70 + r * 14), 0);
  }
  put('marquee', start + 180, -(W + 116), doorYaw + Math.PI / 2);
  // Fuel by the sheds, where the aircraft are run up.
  put('drums', start - 30, -(W + 8), runYaw);
  put('drums', start + 150, -(W + 6), runYaw + 0.4);
  put('sock', -L * 0.85, -(W - 6), runYaw + Math.PI);
  put('sock', L * 0.85, W - 6, runYaw + Math.PI);
}

export function buildAerodromeMeshes(): THREE.Group {
  const group = new THREE.Group();
  const placed: Placed[] = [];
  for (const a of aerodromes()) dress(a, placed);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
  const dummy = new THREE.Object3D();
  for (const kind of KINDS) {
    const list = placed.filter((p) => p.kind === kind);
    if (list.length === 0) continue;
    const mesh = new THREE.InstancedMesh(GEOMETRY[kind](), material, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    list.forEach((p, i) => {
      dummy.position.set(p.x, terrainHeight(p.x, p.z) - 0.05, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    group.add(mesh);
  }
  return group;
}

export function disposeAerodromeMeshes(group: THREE.Group): void {
  const mats = new Set<THREE.Material>();
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const m = mesh.material;
    if (Array.isArray(m)) m.forEach((x) => mats.add(x));
    else mats.add(m);
  });
  mats.forEach((m) => m.dispose());
  group.clear();
}
