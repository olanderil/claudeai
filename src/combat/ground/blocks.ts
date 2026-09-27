import * as THREE from 'three';
import { M, mul, Parts, V, gridGeometry, vnoise3, type PartOpts, type Vec3 } from './util';
import { TILE } from './atlas';
import type { Side } from './figures';

/**
 * Reusable building blocks shared by several ground models: sandbag walls,
 * spoked wheels, lorry chassis, ammunition, crates, drums, guy ropes.
 */

export const PAL = {
  allied: {
    body: 0x59593a, // khaki-green service drab
    body2: 0x6b6444,
    canvas: 0x877c58,
    canvasDark: 0x7a7152,
    sandbag: 0xa7926a,
    tent: 0xa99d7c,
    metal: 0x3d3f36,
  },
  central: {
    body: 0x5f6557, // Feldgrau
    body2: 0x4a5540, // dunkelgrün
    canvas: 0x777660,
    canvasDark: 0x6c6c5a,
    sandbag: 0x978c6e,
    tent: 0x7c7a60,
    metal: 0x363a33,
  },
} as const;

export const COL = {
  earth: 0x7a6a55,
  earthDark: 0x665846,
  turf: 0x7a7c50,
  timber: 0x8a6c4a,
  timberDark: 0x5a4632,
  steel: 0x2f3133,
  gunmetal: 0x34373a,
  brass: 0xb08a3c,
  rope: 0x9c8a66,
  black: 0x161616,
  glass: 0x1c2228,
  shell: 0x6d6a55,
  rubber: 0x1b1a19,
  creosote: 0x4a3a2a,
  concrete: 0x9a978c,
} as const;

export const SAND = (side: Side): PartOpts => ({ color: PAL[side].sandbag, tile: TILE.SANDBAG, scale: 1.2, rough: 0.97, jitter: 0.04, ember: 0.04 });
export const PAINT = (c: number, rough = 0.7, metal = 0.1): PartOpts => ({ color: c, tile: TILE.PAINT, scale: 1.5, rough, metal });
export const WOOD = (c: number = COL.timber): PartOpts => ({ color: c, tile: TILE.BOARDS, scale: 1.2, rough: 0.9, ember: 1 });
export const ROPE: PartOpts = { color: COL.rope, tile: TILE.PAINT, rough: 1, jitter: 0.02, ember: 0.6 };

/**
 * A curved sandbag wall (ring sector) around `c`: inner radius r, height h.
 * Angles are measured from +Z (the rear), so the gap of a gun pit that opens
 * to the back is centred on 0. The outer face is battered like a real
 * revetment and the vertices are nudged so it is not CG-perfect.
 */
export function sandRing(
  p: Parts, c: Vec3, r: number, h: number, thick: number,
  a0: number, a1: number, o: PartOpts, seg = 24,
): void {
  const prof: [number, number][] = [
    [0, 0], [0.04, h * 0.5], [0.06, h], [thick * 0.35, h + 0.1], [thick * 0.7, h + 0.06],
    [thick, h * 0.7], [thick + 0.22, 0],
  ];
  const lens = [0];
  for (let i = 1; i < prof.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
  }
  const arc = (a1 - a0) * r;
  const geo = gridGeometry(seg, prof.length - 1, (i, j) => {
    const a = a0 + ((a1 - a0) * i) / seg;
    const rr = r + prof[j][0];
    const jit = (vnoise3(a * 9, prof[j][1] * 3, r) - 0.5) * 0.12 * (j > 0 && j < prof.length - 1 ? 1 : 0.3);
    return V(c.x + Math.sin(a) * (rr + jit), c.y + prof[j][1] + (j >= 2 && j <= 4 ? jit * 0.6 : 0), c.z + Math.cos(a) * (rr + jit));
  }, (i, j) => [(arc * i) / seg, -lens[j]], true);
  p.add(geo, null, { ...o, uv: 'keep', scale: 1 / 1.2 });
}

/** A straight sandbag wall from a to b (on the ground), height h. */
export function sandWall(p: Parts, a: Vec3, b: Vec3, h: number, thick: number, o: PartOpts): void {
  const len = a.distanceTo(b);
  const ang = Math.atan2(b.x - a.x, b.z - a.z);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const box = new THREE.BoxGeometry(thick, h, len, 1, 2, Math.max(1, Math.round(len)));
  const pos = box.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), x = pos.getX(i), z = pos.getZ(i);
    // Batter: the base spreads, the top rounds off.
    const t = (y + h / 2) / h;
    pos.setX(i, x * (1.25 - t * 0.35) + (vnoise3(z * 2, y * 3, a.x) - 0.5) * 0.08);
    if (t > 0.99) pos.setY(i, y + 0.05 - Math.abs(x) * 0.15);
  }
  box.computeVertexNormals();
  p.add(box, M(mid.x, a.y + h / 2, mid.z, 0, ang), { ...o, uv: 'box', scale: 1.2 });
}

/** Spoked wheel with a solid rubber tyre; axle along X. `m` places the hub. */
export function wheel(p: Parts, m: THREE.Matrix4, r: number, w: number, paint: number, q = 0): void {
  const seg = q ? 10 : 18;
  p.cyl(r, r, w, seg, mul(m, M(0, 0, 0, 0, 0, Math.PI / 2)), { color: COL.rubber, tile: TILE.PAINT, rough: 0.95 }, true);
  const face = new THREE.CircleGeometry(r * 0.995, seg);
  for (const s of [-1, 1]) {
    p.add(face, mul(m, M(s * w * 0.5, 0, 0, 0, s * Math.PI / 2)), { color: paint, tile: TILE.WHEEL, uv: 'decal', rough: 0.8, ember: 0.8 });
  }
  if (!q) p.cyl(r * 0.16, r * 0.16, w * 1.3, 8, mul(m, M(0, 0, 0, 0, 0, Math.PI / 2)), PAINT(COL.steel, 0.5, 0.5));
}

/** Fuel / oil drum standing (or lying when `lie`). */
export function drum(p: Parts, x: number, y: number, z: number, c: number, lie = 0, yaw = 0): void {
  const m = M(x, y + (lie ? 0.29 : 0.44), z, lie ? Math.PI / 2 : 0, yaw, 0);
  p.cyl(0.29, 0.29, 0.88, 12, m, { color: c, tile: TILE.PAINT, scale: 0.8, rough: 0.55, metal: 0.4, ember: 0.5 });
  for (const t of [-0.22, 0.22]) p.cyl(0.3, 0.3, 0.035, 12, mul(m, M(0, t, 0)), { color: c, tile: TILE.PAINT, rough: 0.5, metal: 0.4 });
}

/** Shell: body + ogive, lying along Z (or standing when `stand`). */
const SHELL_PTS = [
  [0, 0], [0.99, 0], [1, 0.06], [1, 0.62], [0.97, 0.7], [0.82, 0.85], [0.55, 0.96], [0.2, 1.0], [0, 1.0],
].map(([r, y]) => new THREE.Vector2(r, y));
let shellGeo: THREE.BufferGeometry | null = null;
export function shell(p: Parts, m: THREE.Matrix4, r: number, len: number, c: number = COL.shell, band = true): void {
  shellGeo ??= new THREE.LatheGeometry(SHELL_PTS, 8);
  p.add(shellGeo, mul(m, M(0, 0, 0, 0, 0, 0, r, len, r)), { color: c, tile: TILE.PAINT, rough: 0.5, metal: 0.3, ember: 0.4 });
  if (band) p.cyl(r * 1.04, r * 1.04, len * 0.06, 8, mul(m, M(0, len * 0.2, 0)), { color: 0xa8683a, tile: TILE.PAINT, rough: 0.4, metal: 0.7 });
}

/** A pyramid of shells lying on timber bearers. `n` shells in the bottom row. */
export function shellStack(p: Parts, x: number, z: number, yaw: number, n: number, rows: number, r = 0.075, len = 0.6, c: number = COL.shell): void {
  const base = M(x, 0, z, 0, yaw);
  for (const bz of [-len * 0.3, len * 0.3]) p.box(n * r * 2 + 0.2, 0.08, 0.1, mul(base, M(0, 0.04, bz)), WOOD(COL.timberDark));
  for (let k = 0; k < rows; k++) {
    const cnt = n - k;
    for (let i = 0; i < cnt; i++) {
      const sx = (i - (cnt - 1) / 2) * r * 2.02;
      const sy = 0.08 + r + k * r * 1.75;
      shell(p, mul(base, M(sx, sy, len / 2, -Math.PI / 2)), r, len, c, k === rows - 1 || i % 2 === 0);
    }
  }
}

/** Wooden crate (stencilled ends). */
export function crate(p: Parts, x: number, y: number, z: number, w: number, h: number, d: number, yaw = 0, pitch = 0, roll = 0): void {
  p.add(new THREE.BoxGeometry(w, h, d), M(x, y + h / 2, z, pitch, yaw, roll), { color: 0xd8c9aa, tile: TILE.CRATE, uv: 'decal', rough: 0.85, jitter: 0.12, ember: 1 });
}

/** A guy rope from a to a peg on the ground at b. */
export function guy(p: Parts, a: Vec3, b: Vec3, r = 0.022): void {
  p.rope(a, b, r, ROPE, 0.04, 2);
  const dir = b.clone().sub(a).normalize();
  p.beam(b.clone().addScaledVector(dir, -0.05).setY(b.y + 0.18), b.clone().addScaledVector(dir, 0.08).setY(b.y - 0.1), 0.05, WOOD(0xb09a74));
}

export interface LorryOpts {
  side: Side;
  q: number;
  cabRoof: boolean;
  /** Bed length behind the cab (m). */
  bed: number;
  /** Body paint override. */
  paint?: number;
  /** Omit side boards (for platform lorries). */
  flat?: boolean;
}

/**
 * The common 3-ton lorry: chassis, bonnet, radiator, cab and wheels.
 * Front at -Z; returns the bed-top height and z-range so callers can load it.
 * Built round an AEC Y-type / Daimler-Büssing shape: long bonnet, open-sided
 * cab, solid tyres, rear wheels doubled.
 */
export function lorryBase(p: Parts, o: LorryOpts): { bedY: number; bedZ0: number; bedZ1: number; halfW: number } {
  const { side, q } = o;
  const body = o.paint ?? PAL[side].body;
  const paint = PAINT(body, 0.72, 0.05);
  const dark = PAINT(COL.black, 0.6, 0.2);
  const halfW = 1.08;
  const zf = -3.2;
  // Chassis rails and cross members.
  for (const s of [-1, 1]) p.box(0.1, 0.22, 6.3, M(s * 0.45, 0.82, -0.05), dark);
  if (!q) for (const z of [-2.6, -0.8, 1.2, 2.8]) p.box(0.9, 0.08, 0.1, M(0, 0.78, z), dark);
  // Axles, springs, differential.
  const fz = -2.3, rz = 1.55;
  p.cyl(0.05, 0.05, 1.7, 6, M(0, 0.47, fz, 0, 0, Math.PI / 2), dark);
  p.cyl(0.06, 0.06, 1.8, 6, M(0, 0.52, rz, 0, 0, Math.PI / 2), dark);
  if (!q) {
    p.sphere(0.2, M(0, 0.52, rz), dark, 8, 6);
    p.rod(V(0, 0.55, rz), V(0, 0.7, -1.4), 0.05, dark, 6);
    for (const s of [-1, 1]) {
      p.box(0.08, 0.08, 1.0, M(s * 0.45, 0.66, fz), dark);
      p.box(0.08, 0.1, 1.2, M(s * 0.45, 0.68, rz), dark);
    }
  }
  // Wheels: singles in front, twins at the back.
  const wp = PAL[side].metal;
  for (const s of [-1, 1]) {
    wheel(p, M(s * 0.86, 0.46, fz), 0.46, 0.14, wp, q);
    wheel(p, M(s * 0.8, 0.52, rz), 0.52, 0.14, wp, q);
    if (!q) wheel(p, M(s * 0.98, 0.52, rz), 0.52, 0.14, wp, q);
  }
  // Bonnet with rounded top, louvred sides, radiator.
  const bz0 = zf + 0.12, bz1 = -1.75;
  const bl = bz1 - bz0, bm = (bz0 + bz1) / 2;
  p.box(0.84, 0.52, bl, M(0, 1.2, bm), paint);
  p.add(new THREE.CylinderGeometry(0.42, 0.42, bl, 12, 1, true, -Math.PI / 2, Math.PI), M(0, 1.46, bm, -Math.PI / 2, 0, 0, 1, 1, 0.45), paint);
  if (!q) {
    for (const s of [-1, 1]) {
      p.add(new THREE.PlaneGeometry(bl * 0.7, 0.3), M(s * 0.425, 1.24, bm, 0, s * Math.PI / 2), { color: body, tile: TILE.GRILLE, uv: 'decal', rough: 0.7 });
    }
  }
  p.box(0.92, 1.0, 0.14, M(0, 1.2, zf + 0.05), PAINT(COL.gunmetal, 0.5, 0.4));
  p.add(new THREE.PlaneGeometry(0.8, 0.86), M(0, 1.2, zf - 0.025, 0, Math.PI), { color: 0xb8a070, tile: TILE.RADIATOR, uv: 'decal', rough: 0.45, metal: 0.6 });
  if (!q) {
    p.cyl(0.05, 0.05, 0.08, 8, M(0, 1.74, zf + 0.05), PAINT(COL.brass, 0.35, 0.8));
    // Starting handle, dumb irons, headlamps.
    p.rod(V(0, 0.8, zf - 0.02), V(0, 0.8, zf - 0.25), 0.02, dark, 4);
    for (const s of [-1, 1]) {
      p.cyl(0.11, 0.09, 0.2, 10, M(s * 0.55, 1.52, zf + 0.3, Math.PI / 2), PAINT(COL.black, 0.4, 0.5));
      p.add(new THREE.CircleGeometry(0.1, 10), M(s * 0.55, 1.52, zf + 0.19, 0, Math.PI), PAINT(0xd8d0b0, 0.1, 0.8));
    }
  }
  // Front mudguards: curved sheets over the wheels, continued as running boards.
  for (const s of [-1, 1]) {
    p.add(new THREE.CylinderGeometry(0.58, 0.58, 0.3, 10, 1, true, Math.PI * 0.05, Math.PI * 0.8), M(s * 0.86, 0.46, fz, 0, 0, Math.PI / 2), paint);
    p.box(0.3, 0.04, 1.9, M(s * 0.9, 0.86, -0.85), paint);
  }
  // Cab: scuttle, seat, back panel, roof on posts.
  const cz0 = -1.75, cz1 = -0.55;
  p.box(1.4, 0.6, 0.25, M(0, 1.3, cz0 + 0.1), paint);
  p.box(1.9, 0.08, cz1 - cz0, M(0, 1.02, (cz0 + cz1) / 2), dark);
  p.box(1.5, 0.35, 0.55, M(0, 1.25, cz1 - 0.35), { color: 0x3b2a1e, tile: TILE.CANVAS, scale: 0.6, rough: 0.8 });
  p.box(1.5, 0.55, 0.12, M(0, 1.6, cz1 - 0.1, -0.2), { color: 0x3b2a1e, tile: TILE.CANVAS, scale: 0.6, rough: 0.8 });
  p.box(2.0, 1.25, 0.06, M(0, 1.65, cz1), { ...WOOD(body), tile: TILE.BOARDS });
  if (!q) {
    p.rod(V(0.35, 1.25, cz0 + 0.2), V(0.35, 1.72, cz0 + 0.55), 0.025, dark, 4);
    p.add(new THREE.TorusGeometry(0.19, 0.022, 4, 12), M(0.35, 1.72, cz0 + 0.55, -1.1), PAINT(COL.black, 0.5));
    // Folding windscreen frame.
    p.beam(V(-0.7, 1.6, cz0 + 0.05), V(-0.7, 2.25, cz0 + 0.05), 0.04, dark);
    p.beam(V(0.7, 1.6, cz0 + 0.05), V(0.7, 2.25, cz0 + 0.05), 0.04, dark);
    p.beam(V(-0.7, 2.25, cz0 + 0.05), V(0.7, 2.25, cz0 + 0.05), 0.04, dark);
  }
  if (o.cabRoof) {
    for (const s of [-1, 1]) {
      p.beam(V(s * 0.95, 1.05, cz0 + 0.15), V(s * 0.95, 2.5, cz0 + 0.05), 0.06, WOOD(COL.timberDark));
      p.beam(V(s * 0.95, 1.05, cz1), V(s * 0.95, 2.5, cz1), 0.06, WOOD(COL.timberDark));
    }
    p.box(2.1, 0.06, 1.55, M(0, 2.53, (cz0 + cz1) / 2 - 0.05, 0.03), { color: PAL[side].canvasDark, tile: TILE.CANVAS, scale: 1.5, rough: 0.9, ember: 1 });
  }
  // Bed.
  const bedZ0 = -0.45, bedZ1 = bedZ0 + o.bed, bedY = 1.25;
  p.box(2.16, 0.12, o.bed, M(0, bedY - 0.06, (bedZ0 + bedZ1) / 2), WOOD(COL.timberDark));
  if (!o.flat) {
    for (const s of [-1, 1]) p.box(0.05, 0.5, o.bed, M(s * halfW, bedY + 0.25, (bedZ0 + bedZ1) / 2), { ...WOOD(body), tile: TILE.BOARDS });
    p.box(2.16, 0.5, 0.05, M(0, bedY + 0.25, bedZ1), { ...WOOD(body), tile: TILE.BOARDS });
    p.box(2.16, 0.5, 0.05, M(0, bedY + 0.25, bedZ0), { ...WOOD(body), tile: TILE.BOARDS });
  }
  if (!q) {
    // Fuel tank under the seat, tool box, tail lamp.
    p.cyl(0.2, 0.2, 0.9, 10, M(0.62, 0.95, -1.0, 0, 0, Math.PI / 2), paint);
    p.box(0.35, 0.3, 0.7, M(-0.72, 0.92, 0.3), paint);
    p.box(0.1, 0.12, 0.08, M(-0.9, 1.1, bedZ1 + 0.05), PAINT(0x5a1a14, 0.3, 0.3));
  }
  return { bedY, bedZ0, bedZ1, halfW };
}

/** The arched canvas tilt (hood) over a lorry bed. */
export function lorryTilt(p: Parts, side: Side, bedY: number, z0: number, z1: number, halfW: number, q: number, color?: number): void {
  const prof: [number, number][] = [];
  const n = q ? 6 : 12;
  const top = bedY + 1.85, wallTop = bedY + 1.35;
  prof.push([-halfW, bedY + 0.45]);
  for (let i = 0; i <= n; i++) {
    const a = Math.PI - (i / n) * Math.PI;
    prof.push([Math.cos(a) * halfW, wallTop + Math.sin(a) * (top - wallTop)]);
  }
  prof.push([halfW, bedY + 0.45]);
  const lens = [0];
  for (let i = 1; i < prof.length; i++) lens.push(lens[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
  const nz = q ? 2 : 10;
  const bows = 4;
  const geo = gridGeometry(nz, prof.length - 1, (i, j) => {
    const t = i / nz, z = z0 + (z1 - z0) * t;
    // Canvas sags a little between the hoops.
    const sag = Math.abs(Math.sin(t * Math.PI * bows)) * 0.05;
    const [x, y] = prof[j];
    const k = 1 - sag / Math.max(0.5, Math.hypot(x, y - wallTop));
    return V(x * k, wallTop + (y - wallTop) * k, z);
  }, (i, j) => [(z0 + ((z1 - z0) * i) / nz) / 2, -lens[j] / 2]);
  const col = color ?? PAL[side].canvas;
  p.add(geo, null, { color: col, tile: TILE.CANVAS, uv: 'keep', rough: 0.95, ember: 1 });
  // Closed front, dark open rear with the flap rolled up.
  const shape = new THREE.Shape();
  prof.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  const front = new THREE.ShapeGeometry(shape, 4);
  p.add(front, M(0, 0, z0 + 0.01, 0, Math.PI), { color: col, tile: TILE.CANVAS, scale: 2, rough: 0.95, ember: 1 });
  p.add(front, M(0, 0, z1 - 0.25), { color: 0x16130f, tile: TILE.PAINT, rough: 1 });
  if (!q) p.cyl(0.12, 0.12, halfW * 1.9, 8, M(0, top - 0.12, z1 + 0.02, 0, 0, Math.PI / 2), { color: col, tile: TILE.CANVAS, scale: 0.5, rough: 0.95, ember: 1 });
}
