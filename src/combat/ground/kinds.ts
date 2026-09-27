import * as THREE from 'three';
import {
  M, mul, Parts, V, gridGeometry, flipped, ragged, vnoise3, displace,
  type HitSphere, type PartOpts, type Vec3,
} from './util';
import { TILE } from './atlas';
import { soldier, type Side } from './figures';
import {
  PAL, COL, SAND, PAINT, WOOD, ROPE, sandRing, sandWall, wheel, drum, shell, shellStack, crate, guy,
  lorryBase, lorryTilt,
} from './blocks';

/**
 * The ground targets, each as a function of (side, detail) that fills Parts.
 *
 * q = 0 is the full model; q = 1 is the far LOD (no ropes, no crew, fewer
 * segments) that is merged into a single mesh. Moving parts (gun mounts,
 * searchlight heads, a winch drum) are returned separately with their pivot.
 */

export type GroundKind = 'hangar' | 'aagun' | 'artillery' | 'mgnest' | 'lorry' | 'dump' | 'hq' | 'hut' | 'tent' | 'winch' | 'searchlight';

export interface DynSpec {
  name: string;
  parent: string | null;
  /** Pivot relative to the parent frame (root for top-level parts). */
  pivot: Vec3;
  parts: Parts;
  /** Axis this part turns about: yaw (Y), pitch (X) or spin (X, continuous). */
  axis: 'yaw' | 'pitch' | 'spin';
  rest: number;
}

export interface KindBuild {
  s: Parts;
  c: Parts;
  dyn: DynSpec[];
  hit: HitSphere[];
  height: number;
  radius: number;
  /** AO blob half-extents (x, z). */
  blob: [number, number];
  /** Muzzle in the named dyn part's frame, or in body space when part is null. */
  muzzle?: { part: string | null; p: Vec3 };
  /** Balloon-cable exit (winch) in body space. */
  anchor?: Vec3;
  /** Searchlight lens: disc in the named part's frame, facing -Z. */
  lens?: { part: string; p: Vec3; r: number };
  aim?: { yawLimit: number; pitchMin: number; pitchMax: number; yawRate: number; pitchRate: number };
}

export interface WreckBuild {
  s: Parts;
  c: Parts;
  scorch: number;
}

const sph = (x: number, y: number, z: number, r: number): HitSphere => ({ o: V(x, y, z), r });
const dyn = (name: string, parent: string | null, pivot: Vec3, axis: DynSpec['axis'], rest: number, seed: number): DynSpec =>
  ({ name, parent, pivot, axis, rest, parts: new Parts(seed) });

/* ================================================================= hangar */

const HANGAR_HALF: [number, number][] = [
  [10.05, 0], [9.95, 1.8], [9.8, 3.5], [9.0, 4.35], [7.4, 5.25], [5.3, 5.92], [2.9, 6.36], [0, 6.52],
];
const HD = 12;

function hangarProfile(dense: boolean): [number, number][] {
  const half = HANGAR_HALF;
  const full: [number, number][] = [...half.map(([x, y]) => [-x, y] as [number, number]), ...half.slice(0, -1).reverse()];
  if (!dense) return full;
  // Catmull-Rom densify so the roof reads as a curve, not a polygon.
  const out: [number, number][] = [];
  for (let i = 0; i < full.length - 1; i++) {
    const p0 = full[Math.max(0, i - 1)], p1 = full[i], p2 = full[i + 1], p3 = full[Math.min(full.length - 1, i + 2)];
    const n = i < 1 || i >= full.length - 2 ? 2 : 3;
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(full[full.length - 1]);
  return out;
}

function profileY(x: number): number {
  const ax = Math.abs(x);
  const h = HANGAR_HALF;
  for (let i = 0; i < h.length - 1; i++) {
    const [x0, y0] = h[i], [x1, y1] = h[i + 1];
    if (ax <= x0 && ax >= x1) return y0 + ((y1 - y0) * (x0 - ax)) / (x0 - x1 || 1);
  }
  return h[h.length - 1][1];
}

/** Members of one Bessonneau roof truss at z (pairs of points + section). */
function hangarTruss(z: number): [Vec3, Vec3, number][] {
  const m: [Vec3, Vec3, number][] = [];
  const h = HANGAR_HALF;
  for (const s of [-1, 1]) {
    m.push([V(s * 9.85, 0, z), V(s * 9.8, 3.5, z), 0.24]);
    for (let i = 2; i < h.length - 1; i++) m.push([V(s * h[i][0], h[i][1], z), V(s * h[i + 1][0], h[i + 1][1], z), 0.2]);
    m.push([V(s * 9.83, 2.5, z), V(s * 8.2, 4.25, z), 0.14]);
  }
  m.push([V(-9.05, 4.25, z), V(9.05, 4.25, z), 0.2]);
  const xs = [-8.4, -6.3, -4.2, -2.1, 0, 2.1, 4.2, 6.3, 8.4];
  for (let i = 0; i < xs.length - 1; i++) {
    const lower = i % 2 === 0;
    const xa = xs[i], xb = xs[i + 1];
    m.push([V(xa, lower ? 4.25 : profileY(xa) - 0.05, z), V(xb, lower ? profileY(xb) - 0.05 : 4.25, z), 0.12]);
  }
  m.push([V(0, 4.25, z), V(0, 6.45, z), 0.16]);
  return m;
}

function hangar(side: Side, q: number): KindBuild {
  const s = new Parts(11), c = new Parts(12);
  const canvasCol = side === 'allied' ? 0xab9a74 : 0x979379;
  const timber = side === 'allied' ? 0x8a7152 : 0x7a6a52;
  const prof = hangarProfile(!q);
  const lens = [0];
  for (let i = 1; i < prof.length; i++) lens.push(lens[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
  const nrm = prof.map((_, j) => {
    const a = prof[Math.max(0, j - 1)], b = prof[Math.min(prof.length - 1, j + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    return [-ty / l, tx / l];
  });
  const nz = q ? 6 : 42;
  const skin = (inset: number) => gridGeometry(nz, prof.length - 1, (i, j) => {
    const z = -HD + (2 * HD * i) / nz;
    const frac = ((z + HD) / 4) % 1;
    // Canvas sags between trusses, more on the roof than the walls.
    const sag = Math.sin(Math.PI * frac) * (0.05 + 0.14 * Math.min(1, prof[j][1] / 6)) + inset;
    return V(prof[j][0] - nrm[j][0] * sag, prof[j][1] - nrm[j][1] * sag, z);
  }, (i, j) => [((-HD + (2 * HD * i) / nz)) / 2, -lens[j] / 2]);
  const canvas: PartOpts = { color: canvasCol, tile: TILE.CANVAS, uv: 'keep', rough: 0.93, ember: 1, jitter: 0 };
  s.add(skin(0), null, canvas);
  const inside: PartOpts = { color: 0x2a241c, tile: TILE.CANVAS, uv: 'keep', rough: 1, jitter: 0 };
  s.add(flipped(skin(0.05)), null, inside);
  // Back gable, closed.
  const shape = new THREE.Shape();
  HANGAR_HALF.forEach(([x, y], i) => (i ? shape.lineTo(-x, y) : shape.moveTo(-x, y)));
  [...HANGAR_HALF].reverse().slice(1).forEach(([x, y]) => shape.lineTo(x, y));
  const gable = new THREE.ShapeGeometry(shape, 3);
  s.add(gable, M(0, 0, HD), { color: canvasCol, tile: TILE.CANVAS, scale: 2, rough: 0.93, ember: 1 });
  s.add(gable, M(0, 0, HD - 0.05, 0, Math.PI), { color: 0x221d17, tile: TILE.CANVAS, scale: 2, rough: 1 });
  // Front gable above the lower chord.
  const top = new THREE.Shape();
  top.moveTo(-9.05, 4.25);
  HANGAR_HALF.filter(([, y]) => y > 4.25).forEach(([x, y]) => top.lineTo(-x, y));
  [...HANGAR_HALF].reverse().slice(1).filter(([, y]) => y > 4.25).forEach(([x, y]) => top.lineTo(x, y));
  top.lineTo(9.05, 4.25);
  const fg = new THREE.ShapeGeometry(top, 3);
  s.add(fg, M(0, 0, -HD + 0.18, 0, Math.PI), { color: canvasCol, tile: TILE.CANVAS, scale: 2, rough: 0.93, ember: 1 });
  s.add(fg, M(0, 0, -HD + 0.23), { color: 0x221d17, tile: TILE.CANVAS, scale: 2, rough: 1 });
  // Dark floor and a rear shadow wall so the doorway reads as a deep interior.
  s.box(19.6, 0.04, 23.8, M(0, 0.02, 0), { color: 0x2e281f, tile: TILE.EARTH, scale: 3, rough: 1 });
  // Curtains, drawn back to either side of the doorway, pleated.
  const curtain = (x0: number, x1: number): void => {
    const nx = q ? 4 : 28, ny = q ? 1 : 4;
    const g = gridGeometry(nx, ny, (i, j) => {
      const x = x0 + ((x1 - x0) * i) / nx;
      const yTop = Math.min(4.25, profileY(x) - 0.05);
      const y = (yTop * j) / ny;
      const gather = 0.18 + 0.12 * (j / ny);
      return V(x, y, -HD - 0.1 - gather * (0.5 + 0.5 * Math.sin((x * Math.PI * 2) / 0.62)));
    }, (i, j) => [(x0 + ((x1 - x0) * i) / nx) / 2, -(4.25 * j) / ny / 2], true);
    s.add(g, null, { color: canvasCol, tile: TILE.CANVAS, uv: 'keep', rough: 0.95, ember: 1, jitter: 0.03 });
  };
  curtain(-10.05, -6.1);
  curtain(4.9, 10.05);
  // Trusses: the front one is the signature of the Bessonneau.
  const tw = WOOD(timber);
  const frames = q ? [-HD] : [-HD, -8, -4, 0, 4, 8, HD - 0.1];
  for (const z of frames) for (const [a, b, w] of hangarTruss(z)) s.beam(a, b, w, tw);
  if (!q) {
    // Ridge pole, guy ropes, pegs.
    s.beam(V(0, 6.45, -HD), V(0, 6.45, HD), 0.18, tw);
    for (let k = 0; k <= 6; k++) {
      const z = -HD + k * 4;
      for (const sd of [-1, 1]) {
        guy(s, V(sd * 9.9, 3.45, z), V(sd * 13.4, 0, z + 0.3));
        guy(s, V(sd * 7.4, 5.2, z), V(sd * 15.0, 0, z - 0.3));
      }
    }
    for (const sd of [-1, 1]) {
      guy(s, V(sd * 3.0, 6.3, -HD), V(sd * 4.2, 0, -HD - 4.0));
      guy(s, V(sd * 3.0, 6.3, HD), V(sd * 4.2, 0, HD + 4.0));
    }
    // Clutter at the door: drums, a trestle, chocks.
    drum(s, -8.4, 0, -13.2, 0x4c5a3c);
    drum(s, -7.7, 0, -13.5, 0x4c5a3c);
    drum(s, -8.1, 0, -14.2, 0x6b4a2a, 1, 0.4);
    s.box(1.6, 0.08, 0.6, M(7.6, 0.85, -13.6, 0, 0.2), WOOD(COL.timberDark));
    for (const dx of [-0.6, 0.6]) s.box(0.08, 0.85, 0.5, M(7.6 + dx, 0.42, -13.6, 0, 0.2), WOOD(COL.timberDark));
    crate(s, 6.3, 0, -13.0, 0.9, 0.6, 0.6, 0.3);
  }
  return {
    s, c, dyn: [],
    hit: [sph(0, 3, -8, 8.5), sph(0, 3, 0, 8.5), sph(0, 3, 8, 8.5)],
    height: 6.6, radius: 16, blob: [12.5, 14.5],
  };
}

function hangarWreck(side: Side): WreckBuild {
  const s = new Parts(111), c = new Parts(112);
  s.char = 1;
  const r = s.rnd;
  const tw = WOOD(COL.timber);
  // Standing posts, mostly burnt down to stumps.
  for (let k = 0; k <= 6; k++) {
    const z = -HD + k * 4;
    for (const sd of [-1, 1]) {
      if (r() < 0.25) continue;
      const hgt = 0.6 + r() * 2.8;
      s.beam(V(sd * 9.85, 0, z), V(sd * (9.85 - r() * 0.8), hgt, z + (r() - 0.5) * 0.8), 0.24, tw);
    }
  }
  // Fallen roof trusses: pieces of the frame lying at angles, some broken off.
  for (const z of [-10, -5, 1, 6, 10.5]) {
    const tilt = (r() < 0.5 ? -1 : 1) * (1.1 + r() * 0.35);
    const m = mul(M(r() - 0.5, 0.3 + r() * 0.3, z, tilt, (r() - 0.5) * 0.3, (r() - 0.5) * 0.25), M(0, -3.2, 0));
    for (const [a, b, w] of hangarTruss(0)) {
      if (r() < 0.35) continue;
      const aa = a.clone().applyMatrix4(m), bb = b.clone().applyMatrix4(m);
      aa.y = Math.max(0.05, aa.y); bb.y = Math.max(0.05, bb.y);
      s.beam(aa, bb, w, tw);
    }
  }
  // What is left of the canvas: a crumpled, holed sheet over the debris.
  const sheet = gridGeometry(30, 26, (i, j) => {
    const x = -10.5 + (21 * j) / 26, z = -HD + (2 * HD * i) / 30;
    const n = vnoise3(x * 0.35, 0, z * 0.35) * 0.7 + vnoise3(x * 1.1, 3, z * 1.1) * 0.3;
    return V(x + (n - 0.5) * 0.6, 0.08 + Math.max(0, n - 0.35) * 2.2 + (Math.abs(x) > 9 ? 0.3 : 0), z);
  }, (i, j) => [j / 2, i / 2]);
  ragged(sheet, (x, _y, z) => vnoise3(x * 0.4 + 7, 1, z * 0.4) > 0.42);
  sheet.computeVertexNormals();
  s.add(sheet, null, { color: 0x3a2e22, tile: TILE.CANVAS, uv: 'keep', rough: 1, ember: 1 });
  // A burnt-out aeroplane inside: engine, wheels, a skeleton of wing ribs.
  s.box(0.9, 0.75, 1.0, M(1.5, 0.45, -3, 0.2, 0.5, 0.3), PAINT(COL.steel, 0.7, 0.3));
  s.box(0.12, 2.4, 0.18, M(1.2, 0.35, -3.6, 0.1, 0.5, 1.4), WOOD(COL.timberDark));
  wheel(s, M(0.3, 0.1, -1.5, 0, 0.4, Math.PI / 2 - 0.1), 0.35, 0.1, 0x222222, 1);
  wheel(s, M(2.6, 0.35, -2.2, 0, 0.2, 0.2), 0.35, 0.1, 0x222222, 1);
  for (let k = 0; k < 9; k++) s.beam(V(-2 + k * 0.5, 0.1, 0.4), V(-2 + k * 0.5 + 0.3, 0.15 + r() * 0.3, 1.8), 0.05, tw);
  s.beam(V(-2.2, 0.15, 0.6), V(2.4, 0.2, 0.7), 0.08, tw);
  s.beam(V(-2.2, 0.15, 1.5), V(2.4, 0.3, 1.7), 0.08, tw);
  void side;
  return { s, c, scorch: 17 };
}

/* ================================================================= AA gun */

function aaAllied(q: number): KindBuild {
  const side: Side = 'allied';
  const s = new Parts(31), c = new Parts(32);
  const tur = dyn('turret', null, V(0, 0.95, 0), 'yaw', 0, 33);
  const gun = dyn('gun', 'turret', V(0, 0.62, 0), 'pitch', 0.75, 34);
  const sb = SAND(side);
  const body = PAL.allied.body;
  const paint = PAINT(body, 0.6, 0.2);
  const steel = PAINT(COL.gunmetal, 0.45, 0.6);
  sandRing(s, V(0, 0, 0), 3.3, 1.1, 0.9, 0.45, Math.PI * 2 - 0.45, sb, q ? 12 : 32);
  s.add(new THREE.CircleGeometry(3.35, q ? 12 : 28), M(0, 0.03, 0, -Math.PI / 2), { color: COL.earthDark, tile: TILE.EARTH, scale: 3, rough: 1 });
  s.box(3.0, 0.14, 3.0, M(0, 0.1, 0), WOOD(0x7a6448));
  s.cyl(0.34, 0.58, 0.8, 14, M(0, 0.58, 0), paint);
  s.cyl(0.85, 0.85, 0.08, 14, M(0, 0.21, 0), steel);
  for (let k = 0; k < 4; k++) s.box(0.18, 0.12, 1.6, M(0, 0.24, 0, 0, (k * Math.PI) / 2 + Math.PI / 4), steel);
  // Traversing mount: turntable, trunnion cheeks, layer's seat and handwheels.
  const t = tur.parts;
  t.cyl(0.55, 0.55, 0.1, 14, null, paint);
  for (const sx of [-1, 1]) t.box(0.07, 0.78, 0.95, M(sx * 0.3, 0.38, 0.05), paint);
  t.box(0.36, 0.06, 0.3, M(-0.85, 0.14, 0.45), PAINT(COL.black, 0.6));
  t.rod(V(-0.85, 0.12, 0.45), V(-0.3, 0.05, 0.3), 0.035, paint, 5);
  if (!q) {
    t.add(new THREE.TorusGeometry(0.16, 0.02, 4, 12), M(-0.42, 0.38, -0.05, 0, Math.PI / 2), steel);
    t.add(new THREE.TorusGeometry(0.14, 0.02, 4, 12), M(-0.42, 0.12, 0.25, Math.PI / 2), steel);
    soldier(t, M(-0.85, -0.4, 0.55), side, 'sit');
  }
  // The gun: 3-inch 20 cwt, long thin barrel with recoil cylinder beneath.
  const g = gun.parts;
  g.rod(V(0, 0, 0.95), V(0, 0, -3.0), 0.105, steel, q ? 6 : 12, 0.07);
  g.rod(V(0, 0, 0.75), V(0, 0, -0.95), 0.14, steel, q ? 6 : 12, 0.125);
  g.rod(V(0, -0.21, 0.55), V(0, -0.21, -1.45), 0.095, paint, q ? 6 : 10);
  g.box(0.3, 0.3, 0.42, M(0, 0, 1.1), steel);
  g.box(0.06, 0.34, 1.9, M(-0.2, -0.1, -0.15), paint);
  g.box(0.06, 0.34, 1.9, M(0.2, -0.1, -0.15), paint);
  if (!q) {
    g.cyl(0.085, 0.085, 0.12, 10, M(0, 0, -2.98, Math.PI / 2), steel);
    g.box(0.08, 0.1, 0.35, M(-0.3, 0.16, 0.2), PAINT(COL.black, 0.4, 0.5));
    g.rod(V(-0.3, 0.2, 0.05), V(-0.3, 0.2, 0.35), 0.03, PAINT(COL.brass, 0.3, 0.8), 6);
    for (const sx of [-1, 1]) g.rod(V(sx * 0.18, 0.13, 0.5), V(sx * 0.18, 0.13, -0.7), 0.045, paint, 6);
  }
  if (!q) {
    // Ready-use ammunition and the rest of the detachment.
    for (let k = 0; k < 3; k++) crate(s, -2.2 + k * 0.1, 0.17 + k * 0.32, -1.6, 0.8, 0.32, 0.45, 0.6);
    for (let k = 0; k < 2; k++) crate(s, 2.3, 0.17 + k * 0.32, -1.3, 0.8, 0.32, 0.45, -0.7);
    s.box(0.9, 0.5, 0.35, M(2.0, 0.42, 1.3, 0, -0.4), WOOD(COL.timberDark));
    for (let i = 0; i < 6; i++) {
      shell(s, M(1.72 + (i % 3) * 0.2, 0.2, 1.2 + Math.floor(i / 3) * 0.2 - 0.1 * (i % 3)), 0.04, 0.75, COL.brass, false);
    }
    soldier(s, M(0.9, 0.17, 1.35, 0, 0.6), 'allied', 'load');
    soldier(s, M(-1.7, 0.17, 1.3, 0, -0.3), 'allied', 'binoc');
  }
  return {
    s, c, dyn: [tur, gun],
    hit: [sph(0, 0.7, 0, 4.4), sph(0, 1.9, 0, 2.2)],
    height: 4, radius: 5, blob: [5, 5],
    muzzle: { part: 'gun', p: V(0, 0, -3.05) },
    aim: { yawLimit: Math.PI, pitchMin: 0.05, pitchMax: 1.45, yawRate: 0.9, pitchRate: 0.6 },
  };
}

function aaCentral(q: number): KindBuild {
  const side: Side = 'central';
  const s = new Parts(41), c = new Parts(42);
  const { bedY, bedZ0, bedZ1, halfW } = lorryBase(s, { side, q, cabRoof: false, bed: 4.1, flat: true });
  const tur = dyn('turret', null, V(0, bedY + 0.62, 1.55), 'yaw', 0, 43);
  const gun = dyn('gun', 'turret', V(0, 0.55, 0), 'pitch', 0.7, 44);
  const body = PAL.central.body;
  const paint = PAINT(body, 0.6, 0.15);
  const steel = PAINT(COL.gunmetal, 0.45, 0.6);
  const mid = (bedZ0 + bedZ1) / 2;
  // Side boards folded down as working platforms, and screw jacks.
  for (const sd of [-1, 1]) {
    s.box(0.05, 0.6, bedZ1 - bedZ0, M(sd * (halfW + 0.26), bedY - 0.2, mid, 0, 0, -sd * 0.5), { ...WOOD(body), tile: TILE.BOARDS });
    if (!q) for (const z of [bedZ0 + 0.3, bedZ1 - 0.3]) s.rod(V(sd * (halfW - 0.1), bedY - 0.1, z), V(sd * (halfW + 0.35), 0, z), 0.045, PAINT(COL.black, 0.5, 0.4), 6);
  }
  s.cyl(0.3, 0.46, 0.62, 12, M(0, bedY + 0.31, 1.55), paint);
  const t = tur.parts;
  t.cyl(0.5, 0.5, 0.09, 14, null, paint);
  for (const sx of [-1, 1]) t.box(0.07, 0.7, 0.85, M(sx * 0.28, 0.33, 0.05), paint);
  // Curved gun shield.
  t.add(new THREE.CylinderGeometry(1.2, 1.2, 1.15, q ? 5 : 12, 1, true, Math.PI - 0.62, 1.24), M(0, 0.62, 0.75), { ...paint, rough: 0.55 });
  t.add(new THREE.CylinderGeometry(1.17, 1.17, 1.15, q ? 5 : 12, 1, true, Math.PI - 0.62, 1.24), M(0, 0.62, 0.75), PAINT(0x3f4438, 0.6, 0.1));
  t.box(0.36, 0.06, 0.3, M(-0.8, 0.1, 0.4), PAINT(COL.black, 0.6));
  if (!q) {
    t.add(new THREE.TorusGeometry(0.15, 0.02, 4, 12), M(-0.38, 0.32, 0.0, 0, Math.PI / 2), steel);
    soldier(t, M(-0.8, -0.45, 0.5), side, 'sit');
  }
  const g = gun.parts;
  g.rod(V(0, 0, 0.8), V(0, 0, -2.75), 0.105, steel, q ? 6 : 12, 0.072);
  g.rod(V(0, 0.2, 0.5), V(0, 0.2, -1.4), 0.085, paint, q ? 6 : 10);
  g.rod(V(0, -0.2, 0.5), V(0, -0.2, -1.2), 0.085, paint, q ? 6 : 10);
  g.box(0.3, 0.32, 0.4, M(0, 0, 0.95), steel);
  g.box(0.05, 0.5, 1.6, M(-0.18, 0, -0.2), paint);
  g.box(0.05, 0.5, 1.6, M(0.18, 0, -0.2), paint);
  if (!q) {
    g.cyl(0.08, 0.08, 0.1, 10, M(0, 0, -2.72, Math.PI / 2), steel);
    g.box(0.08, 0.1, 0.3, M(-0.27, 0.18, 0.2), PAINT(COL.black, 0.4, 0.5));
    // Wicker shell baskets and crew on the platform.
    for (let k = 0; k < 4; k++) {
      s.cyl(0.17, 0.15, 0.8, 10, M(-0.7 + k * 0.4, bedY + 0.4, bedZ1 - 0.35), { color: 0x9c8052, tile: TILE.WICKER, scale: 0.35, rough: 0.9, ember: 1 });
    }
    soldier(s, M(0.75, bedY, 2.9, 0, 0.5), side, 'load');
    soldier(s, M(0.4, 0.95, -1.05), side, 'sit');
    soldier(s, M(-1.9, 0, 3.4, 0, -0.5), side, 'point');
  }
  return {
    s, c, dyn: [tur, gun],
    hit: [sph(0, 1.4, -2.2, 2.2), sph(0, 1.8, 0.2, 2.2), sph(0, 2.2, 2.2, 2.4)],
    height: 4.2, radius: 5.2, blob: [2.6, 4.6],
    muzzle: { part: 'gun', p: V(0, 0, -2.8) },
    aim: { yawLimit: Math.PI, pitchMin: 0.02, pitchMax: 1.4, yawRate: 0.8, pitchRate: 0.6 },
  };
}

function aaWreck(side: Side): WreckBuild {
  const s = new Parts(131), c = new Parts(132);
  const r = s.rnd;
  if (side === 'allied') {
    s.char = 0.55;
    sandRing(s, V(0, 0, 0), 3.3, 0.8, 1.1, 0.45, 2.2, SAND(side), 16);
    sandRing(s, V(0, 0, 0), 3.4, 0.55, 1.2, 3.2, Math.PI * 2 - 0.45, SAND(side), 16);
    for (let k = 0; k < 14; k++) {
      const a = 2.3 + r() * 0.8, d = 3 + r() * 3;
      s.box(0.55, 0.22, 0.32, M(Math.sin(a) * d, 0.11, Math.cos(a) * d, r() * 0.3, r() * 3, r() * 0.3), { ...SAND(side), uv: 'box' });
    }
    s.char = 1;
    s.cyl(0.34, 0.58, 0.8, 10, M(0.1, 0.35, 0.1, 0.3, 0, 0.2), PAINT(PAL.allied.body));
    // Barrel blown off its cradle, lying across the pit.
    s.rod(V(-1.4, 0.3, 1.2), V(1.6, 0.9, -1.8), 0.1, PAINT(COL.gunmetal, 0.6, 0.4), 10, 0.07);
    s.box(0.3, 0.3, 0.42, M(-1.5, 0.25, 1.35, 0.3, 0.8), PAINT(COL.gunmetal));
    s.box(0.07, 0.78, 0.95, M(0.6, 0.3, -0.6, 1.2, 0.4), PAINT(PAL.allied.body));
    s.box(3.0, 0.14, 3.0, M(0, 0.08, 0, 0.04, 0.2, -0.03), WOOD(0x7a6448));
    for (let k = 0; k < 6; k++) crate(s, -2 + r() * 4, 0.1, -2 + r() * 4, 0.8, 0.3, 0.45, r() * 3, r() * 0.4, r() * 0.4);
  } else {
    s.char = 1;
    const base = new Parts(133); base.char = 1;
    lorryBase(base, { side, q: 1, cabRoof: false, bed: 4.1, flat: true });
    const g = base.merge();
    // Settle the whole lorry onto its burnt-out wheels, nose down on the left.
    s.addRaw(g, M(0, -0.28, 0, 0.04, 0.12, 0.09));
    s.cyl(0.3, 0.46, 0.62, 10, M(0.05, 1.3, 1.5, 0.1, 0, 0.1), PAINT(PAL.central.body));
    s.rod(V(-0.4, 1.65, 2.2), V(1.6, 0.25, -0.6), 0.1, PAINT(COL.gunmetal), 10, 0.072);
    s.add(new THREE.CylinderGeometry(1.2, 1.2, 1.15, 8, 1, true, Math.PI - 0.62, 1.24), M(2.3, 0.3, 1.8, 1.3, 0.5, 0.2), PAINT(PAL.central.body));
    wheel(s, M(-2.2, 0.08, -1.8, 0, 0.3, Math.PI / 2), 0.46, 0.14, 0x222222, 1);
  }
  return { s, c, scorch: 7.5 };
}

/* ============================================================== artillery */

function artillery(side: Side, q: number): KindBuild {
  const s = new Parts(51), c = new Parts(52);
  const how = side === 'central';
  const body = side === 'allied' ? 0x5c5c3e : 0x5a6150;
  const paint = PAINT(body, 0.65, 0.15);
  const steel = PAINT(COL.gunmetal, 0.45, 0.55);
  const sb = SAND(side);
  // The pit: a sandbag revetment inside an earth berm, open at the rear.
  sandRing(s, V(0, 0, 0.2), 3.4, 0.95, 0.8, 0.95, Math.PI * 2 - 0.95, sb, q ? 12 : 28);
  const berm = gridGeometry(q ? 12 : 28, 5, (i, j) => {
    const a = 0.8 + ((Math.PI * 2 - 1.6) * i) / (q ? 12 : 28);
    const pr = [[0, 0.95], [0.4, 1.0], [1.0, 0.9], [1.7, 0.5], [2.4, 0.15], [2.9, 0]][j];
    const rr = 4.2 + pr[0] + (vnoise3(a * 5, j, 1) - 0.5) * 0.3;
    return V(Math.sin(a) * rr, pr[1] * (0.8 + vnoise3(a * 7, 2, j) * 0.4), 0.2 + Math.cos(a) * rr);
  }, (i, j) => [i * 0.5, j * 0.4], true);
  s.add(berm, null, { color: COL.earth, tile: TILE.TURF, uv: 'keep', rough: 1, jitter: 0 });
  s.add(new THREE.CircleGeometry(3.45, q ? 10 : 24), M(0, 0.03, 0.2, -Math.PI / 2), { color: COL.earthDark, tile: TILE.EARTH, scale: 3, rough: 1 });
  // Carriage: wheels, axle, shield, box trail and spade.
  for (const sx of [-1, 1]) wheel(s, M(sx * 0.82, 0.7, 0), 0.7, 0.1, body, q);
  s.rod(V(-0.85, 0.7, 0), V(0.85, 0.7, 0), 0.06, steel, 6);
  if (how) {
    s.box(1.95, 1.25, 0.04, M(0, 1.28, -0.28, -0.1), paint);
    s.box(1.2, 0.25, 0.04, M(0, 2.0, -0.35, -0.1), paint);
  } else {
    s.box(1.85, 1.2, 0.04, M(0, 1.3, -0.28, -0.08), paint);
    s.box(1.4, 0.45, 0.04, M(0, 0.35, -0.2, 0.1), paint);
  }
  s.beam(V(0, 0.75, 0.1), V(0, 0.18, 3.1), 0.32, paint, 0.26);
  s.box(0.7, 0.4, 0.06, M(0, 0.05, 3.15, 0.3), steel);
  if (!q) {
    for (const sx of [-1, 1]) s.box(0.3, 0.05, 0.25, M(sx * 0.55, 0.95, 0.35), PAINT(COL.black));
    s.add(new THREE.TorusGeometry(0.13, 0.02, 4, 10), M(-0.42, 1.0, 0.45, 0, Math.PI / 2), steel);
  }
  // Barrel on its cradle, elevated.
  const elev = how ? 0.62 : 0.2;
  const len = how ? 1.85 : 2.4;
  const bm = M(0, 1.12, 0, elev);
  s.rod(V(0, 0, 0.65).applyMatrix4(bm), V(0, 0, -len).applyMatrix4(bm), how ? 0.13 : 0.09, steel, q ? 6 : 12, how ? 0.115 : 0.068);
  s.box(0.28, 0.28, 0.4, mul(bm, M(0, 0, 0.8)), steel);
  s.rod(V(0, how ? -0.2 : 0.18, 0.4).applyMatrix4(bm), V(0, how ? -0.2 : 0.18, -1.3).applyMatrix4(bm), 0.09, paint, q ? 6 : 10);
  const muzzle = V(0, 0, -len - 0.05).applyMatrix4(bm);
  // Camouflage net on poles.
  const nn = q ? 6 : 14;
  const net = gridGeometry(nn, nn, (i, j) => {
    const x = -5.4 + (10.8 * j) / nn, z = -5.2 + (10.4 * i) / nn;
    const d2 = x * x + (z - 0.2) * (z - 0.2);
    const y = Math.max(0.12, 2.95 - 0.1 * d2) + (vnoise3(x, z, 3) - 0.5) * 0.35;
    return V(x + (vnoise3(z, x, 9) - 0.5) * 0.5, y, z);
  }, (i, j) => [j * 0.55, i * 0.55]);
  c.add(net, null, { color: 0xffffff, tile: TILE.NET, uv: 'keep', rough: 1, jitter: 0.05, ember: 1 });
  for (const [px, pz] of [[-2.6, -2.2], [2.6, -2.2], [-2.6, 2.6], [2.6, 2.6]]) {
    const hgt = 2.95 - 0.1 * (px * px + (pz - 0.2) * (pz - 0.2));
    s.rod(V(px, 0, pz), V(px, hgt, pz), 0.05, WOOD(COL.timber), 5);
  }
  if (!q) {
    shellStack(s, -2.1, 2.3, 0.3, 4, 3, 0.055, 0.55, COL.brass);
    for (let k = 0; k < 5; k++) {
      s.cyl(0.16, 0.14, 0.7, 10, M(1.9 + (k % 3) * 0.36, 0.35, 2.0 + Math.floor(k / 3) * 0.36), { color: 0x9c8052, tile: TILE.WICKER, scale: 0.35, rough: 0.9, ember: 1 });
    }
    crate(s, -2.6, 0, 1.3, 0.9, 0.35, 0.5, 0.8);
    crate(s, -2.55, 0.35, 1.35, 0.9, 0.35, 0.5, 0.7);
    soldier(s, M(-0.6, 0, 1.0), side, 'kneel');
    soldier(s, M(0.75, 0, 1.4, 0, 0.3), side, 'load');
    soldier(s, M(2.0, 0, 3.0, 0, -0.5), side, 'point');
  }
  return {
    s, c, dyn: [],
    hit: [sph(0, 1.0, 0, 4.6)],
    height: 3.2, radius: 7, blob: [5.5, 5.5],
    muzzle: { part: null, p: muzzle },
  };
}

function artilleryWreck(side: Side): WreckBuild {
  const s = new Parts(151), c = new Parts(152);
  const r = s.rnd;
  s.char = 0.5;
  sandRing(s, V(0, 0, 0.2), 3.4, 0.7, 0.9, 0.95, 2.4, SAND(side), 12);
  sandRing(s, V(0, 0, 0.2), 3.5, 0.45, 1.0, 3.3, 4.4, SAND(side), 10);
  for (let k = 0; k < 18; k++) {
    const a = 2.4 + r() * 3.5, d = 3.5 + r() * 4;
    s.box(0.55, 0.22, 0.32, M(Math.sin(a) * d, 0.11, Math.cos(a) * d, r() * 0.3, r() * 3, r() * 0.3), { ...SAND(side), uv: 'box' });
  }
  s.char = 1;
  const body = side === 'allied' ? 0x5c5c3e : 0x5a6150;
  // Gun thrown onto its side: one wheel gone, shield twisted.
  wheel(s, M(0.6, 0.12, 0.4, 0, 0.3, Math.PI / 2 - 0.05), 0.7, 0.1, body, 1);
  wheel(s, M(-2.8, 0.1, -1.5, 0.1, 1.2, Math.PI / 2), 0.7, 0.1, body, 1);
  s.box(1.85, 1.2, 0.04, M(-0.4, 0.5, -0.9, 1.2, 0.5, 0.3), PAINT(body));
  s.beam(V(-0.2, 0.6, 0.2), V(0.5, 0.15, 3.0), 0.32, PAINT(body), 0.26);
  s.rod(V(0.3, 0.9, 0.4), V(-1.5, 0.2, -1.6), 0.1, PAINT(COL.gunmetal), 10, 0.07);
  for (const [px, pz] of [[-2.6, -2.2], [2.6, 2.6]]) s.rod(V(px, 0, pz), V(px + 0.2, 0.9 + r(), pz + 0.3), 0.05, WOOD());
  for (let k = 0; k < 10; k++) {
    shell(s, M(-3 + r() * 6, 0.07, -3 + r() * 6, Math.PI / 2, r() * 6), 0.055, 0.55, COL.brass, false);
  }
  // Charred net shreds hanging from the surviving pole.
  const shred = gridGeometry(4, 4, (i, j) => V(2.2 + j * 0.4, 1.8 - i * 0.4 - j * 0.1, 2.4 + (vnoise3(i, j, 1) - 0.5) * 0.4), undefined);
  c.char = 1;
  c.add(shred, null, { color: 0x2b2620, tile: TILE.NET, uv: 'keep', rough: 1 });
  return { s, c, scorch: 8 };
}

/* ================================================================ MG nest */

function vickers(g: Parts, side: Side, q: number): void {
  const steel = PAINT(COL.gunmetal, 0.45, 0.55);
  const jacket = PAINT(side === 'allied' ? 0x6e6a50 : 0x4f5a45, 0.5, 0.3);
  g.rod(V(0, 0, 0), V(0, 0, -0.8), 0.07, jacket, q ? 6 : 10);
  g.box(0.13, 0.16, 0.45, M(0, 0.01, 0.2), steel);
  g.rod(V(0, 0, -0.8), V(0, 0, -0.95), 0.03, steel, 6, 0.045);
  if (!q) {
    g.box(0.1, 0.12, 0.16, M(-0.15, -0.05, 0.1), PAINT(0x4a5238, 0.7));
    g.rod(V(-0.05, 0.04, 0.42), V(-0.05, 0.04, 0.52), 0.015, steel, 4);
    g.rod(V(0.05, 0.04, 0.42), V(0.05, 0.04, 0.52), 0.015, steel, 4);
  }
}

function mgnest(side: Side, q: number): KindBuild {
  const s = new Parts(61), c = new Parts(62);
  const sb = SAND(side);
  if (side === 'allied') {
    const tur = dyn('turret', null, V(0, 1.22, -1.35), 'yaw', 0, 63);
    const gun = dyn('gun', 'turret', V(0, 0.12, 0), 'pitch', 0.05, 64);
    sandRing(s, V(0, 0, 0.2), 1.6, 1.05, 0.85, 0.6, Math.PI * 2 - 0.6, sb, q ? 10 : 24);
    s.add(new THREE.CircleGeometry(1.65, 14), M(0, 0.03, 0.2, -Math.PI / 2), { color: COL.earthDark, tile: TILE.EARTH, scale: 3, rough: 1 });
    // Corrugated roof on four posts over the back of the nest, sandbagged.
    for (const [px, pz, h] of [[-1.35, -0.35, 1.75], [1.35, -0.35, 1.75], [-1.35, 1.7, 1.5], [1.35, 1.7, 1.5]]) {
      s.beam(V(px, 0, pz), V(px, h, pz), 0.12, WOOD(COL.timber));
    }
    s.box(3.3, 0.04, 2.6, M(0, 1.66, 0.68, 0.11), { color: 0x7d7b74, tile: TILE.CORRUGATED, scale: 1.3, rough: 0.6, metal: 0.45 });
    if (!q) {
      for (let k = 0; k < 9; k++) {
        const x = -1.2 + (k % 3) * 1.2 + (s.rnd() - 0.5) * 0.3, z = 0.0 + Math.floor(k / 3) * 0.75;
        s.box(0.62, 0.2, 0.36, M(x, 1.72 + 0.1 - z * 0.1 + 0.07, z, 0.11, (s.rnd() - 0.5) * 0.6), { ...sb, uv: 'box' });
      }
    }
    // Tripod on the parapet.
    const tri = PAINT(COL.gunmetal, 0.5, 0.5);
    s.rod(V(0, 1.2, -1.35), V(0, 1.02, -1.95), 0.03, tri, 4);
    s.rod(V(0, 1.2, -1.35), V(-0.45, 0.9, -1.0), 0.03, tri, 4);
    s.rod(V(0, 1.2, -1.35), V(0.45, 0.9, -1.0), 0.03, tri, 4);
    tur.parts.box(0.12, 0.1, 0.18, M(0, 0.04, 0), tri);
    vickers(gun.parts, side, q);
    if (!q) {
      soldier(s, M(0.05, 0, -0.55), side, 'crouch');
      soldier(s, M(0.75, 0, -0.35, 0, 0.6), side, 'kneel');
      for (let k = 0; k < 3; k++) s.box(0.3, 0.18, 0.16, M(-0.9, 0.09 + k * 0.18, -0.6), PAINT(0x4a5238));
    }
    return {
      s, c, dyn: [tur, gun],
      hit: [sph(0, 0.9, 0.2, 2.8)],
      height: 2.0, radius: 3.2, blob: [3.2, 3.3],
      muzzle: { part: 'gun', p: V(0, 0, -0.97) },
      aim: { yawLimit: 1.1, pitchMin: -0.1, pitchMax: 0.9, yawRate: 1.6, pitchRate: 1.2 },
    };
  }
  // German concrete pillbox (MEBU) with a firing slit.
  const tur = dyn('turret', null, V(0, 1.05, -1.4), 'yaw', 0, 65);
  const gun = dyn('gun', 'turret', V(0, 0.02, 0), 'pitch', 0.02, 66);
  const con: PartOpts = { color: COL.concrete, tile: TILE.CONCRETE, scale: 1.4, rough: 0.95, jitter: 0.02, ember: 0.2 };
  const W = 4.2, D = 3.4;
  s.box(W, 0.95, 0.55, M(0, 0.475, -D / 2), con);
  s.box(W, 0.35, 0.55, M(0, 1.38, -D / 2), con);
  for (const sx of [-1, 1]) s.box(1.25, 0.25, 0.55, M(sx * 1.48, 1.075, -D / 2), con);
  for (const sx of [-1, 1]) s.box(0.55, 1.55, D, M(sx * (W / 2 - 0.27), 0.775, 0), con);
  s.box(1.6, 1.55, 0.55, M(-1.3, 0.775, D / 2), con);
  s.box(0.9, 1.55, 0.55, M(1.65, 0.775, D / 2), con);
  s.box(W + 0.3, 0.42, D + 0.35, M(0, 1.76, 0), con);
  s.box(W - 1.0, 1.4, D - 1.0, M(0, 0.72, 0), { color: 0x0c0c0b, tile: TILE.PAINT, rough: 1 });
  s.box(W - 0.2, 0.04, D, M(0, 2.0, 0.1, 0.03), { color: 0x6f6b62, tile: TILE.CORRUGATED, scale: 1.3, rough: 0.6, metal: 0.4 });
  // Earth heaped against the sides and back.
  const mound = gridGeometry(q ? 8 : 20, 4, (i, j) => {
    const a = -1.35 + (2.7 * 2 * i) / (q ? 8 : 20) / 2 + Math.PI / 2;
    const ang = -Math.PI * 0.35 + (Math.PI * 1.7 * i) / (q ? 8 : 20);
    void a;
    const pr = [[0, 1.5], [0.4, 1.35], [1.0, 0.9], [1.6, 0.35], [2.1, 0]][j];
    const ex = Math.sin(ang), ez = Math.cos(ang);
    const rx = W / 2 + pr[0], rz = D / 2 + pr[0];
    return V(ex * rx * 1.02, pr[1] * (0.85 + vnoise3(i, j, 2) * 0.3), ez * rz * 1.02 + 0.2);
  }, (i, j) => [i * 0.6, j * 0.5], true);
  s.add(mound, null, { color: COL.earth, tile: TILE.TURF, uv: 'keep', rough: 1, jitter: 0 });
  if (!q) {
    for (let k = 0; k < 8; k++) {
      s.box(0.62, 0.2, 0.36, M(-1.5 + (k % 4) * 1.0, 2.12 + Math.floor(k / 4) * 0.2, -0.6 + Math.floor(k / 4) * 0.9, 0, (s.rnd() - 0.5) * 0.5), { ...sb, uv: 'box' });
    }
    sandWall(s, V(0.2, 0, D / 2 + 1.3), V(1.9, 0, D / 2 + 1.3), 1.2, 0.6, sb);
    soldier(s, M(0.9, 0, D / 2 + 0.6, 0, Math.PI - 0.4), side, 'stand');
  }
  const tri = PAINT(COL.gunmetal, 0.5, 0.5);
  tur.parts.box(0.12, 0.08, 0.2, M(0, -0.02, 0.05), tri);
  vickers(gun.parts, side, q);
  return {
    s, c, dyn: [tur, gun],
    hit: [sph(0, 1.0, 0, 3.1)],
    height: 2.4, radius: 3.8, blob: [3.4, 3.0],
    muzzle: { part: 'gun', p: V(0, 0, -0.97) },
    aim: { yawLimit: 0.55, pitchMin: -0.08, pitchMax: 0.35, yawRate: 1.4, pitchRate: 1.0 },
  };
}

function mgWreck(side: Side): WreckBuild {
  const s = new Parts(161), c = new Parts(162);
  const r = s.rnd;
  if (side === 'allied') {
    s.char = 0.5;
    sandRing(s, V(0, 0, 0.2), 1.6, 0.6, 1.0, 0.6, 2.6, SAND(side), 10);
    sandRing(s, V(0, 0, 0.2), 1.7, 0.4, 1.1, 3.6, Math.PI * 2 - 0.6, SAND(side), 10);
    for (let k = 0; k < 12; k++) {
      const a = r() * 6.28, d = 2 + r() * 3;
      s.box(0.55, 0.22, 0.32, M(Math.sin(a) * d, 0.11, Math.cos(a) * d, r() * 0.3, r() * 3, r() * 0.3), { ...SAND(side), uv: 'box' });
    }
    s.char = 1;
    s.box(3.3, 0.04, 2.6, M(0.3, 0.55, 0.6, 0.35, 0.3, 0.2), { color: 0x6d6b64, tile: TILE.CORRUGATED, scale: 1.3, rough: 0.7, metal: 0.3 });
    s.beam(V(-1.35, 0, -0.35), V(-1.1, 0.9, -0.2), 0.12, WOOD());
    s.beam(V(1.35, 0, 1.7), V(0.9, 1.1, 1.5), 0.12, WOOD());
    s.rod(V(-0.4, 0.2, -0.8), V(0.4, 0.35, -1.5), 0.07, PAINT(COL.gunmetal), 8);
  } else {
    s.char = 0.7;
    const con: PartOpts = { color: COL.concrete, tile: TILE.CONCRETE, scale: 1.4, rough: 0.95 };
    // The box stands but the roof slab is cracked and tipped in.
    s.box(4.2, 1.3, 0.55, M(0, 0.65, -1.7), con);
    s.box(0.55, 1.4, 3.4, M(-1.83, 0.7, 0), con);
    s.box(0.55, 0.9, 3.4, M(1.83, 0.45, 0, 0, 0, 0.05), con);
    s.box(2.4, 0.42, 3.6, M(-0.9, 1.55, 0, 0.05, 0, 0.12), con);
    s.box(2.0, 0.42, 3.4, M(1.2, 0.8, 0.3, 0.1, 0.1, -0.6), con);
    for (let k = 0; k < 10; k++) {
      s.box(0.3 + r() * 0.6, 0.2 + r() * 0.3, 0.3 + r() * 0.5, M(-3 + r() * 6, 0.1, -3 + r() * 6, r(), r() * 3, r()), con);
    }
    s.box(4.0, 1.4, 2.4, M(0, 0.7, 0), { color: 0x0c0c0b, tile: TILE.PAINT, rough: 1 });
  }
  return { s, c, scorch: 5 };
}

/* ================================================================== lorry */

function lorry(side: Side, q: number): KindBuild {
  const s = new Parts(71), c = new Parts(72);
  const { bedY, bedZ0, bedZ1, halfW } = lorryBase(s, { side, q, cabRoof: true, bed: 3.9 });
  lorryTilt(s, side, bedY, bedZ0 + 0.05, bedZ1, halfW, q);
  if (!q) {
    crate(s, -0.45, bedY, bedZ1 - 0.6, 0.8, 0.5, 0.5, 0.1);
    crate(s, 0.45, bedY, bedZ1 - 0.55, 0.8, 0.5, 0.5, -0.1);
    crate(s, 0.1, bedY + 0.5, bedZ1 - 0.6, 0.8, 0.45, 0.5, 0.05);
    soldier(s, M(0.4, 0.9, -0.95), side, 'sit');
  }
  return {
    s, c, dyn: [],
    hit: [sph(0, 1.3, -2.2, 1.9), sph(0, 1.8, 0.2, 2.1), sph(0, 1.9, 2.3, 2.1)],
    height: 3.2, radius: 3.8, blob: [1.9, 3.9],
  };
}

function lorryWreck(side: Side): WreckBuild {
  const s = new Parts(171), c = new Parts(172);
  s.char = 1;
  const r = s.rnd;
  const base = new Parts(173); base.char = 1;
  const { bedY, bedZ0, bedZ1, halfW } = lorryBase(base, { side, q: 1, cabRoof: false, bed: 3.9 });
  // Bare tilt hoops, one buckled.
  for (let k = 0; k < 4; k++) {
    const z = bedZ0 + 0.3 + k * ((bedZ1 - bedZ0 - 0.5) / 3);
    const buckle = k === 2 ? 0.5 : 0;
    const pts: Vec3[] = [];
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI - (i / 6) * Math.PI;
      pts.push(V(Math.cos(a) * halfW, bedY + 1.35 + Math.sin(a) * 0.5 - buckle * Math.sin(a) * 0.8, z + buckle * Math.sin(a) * 0.4));
    }
    base.beam(V(-halfW, bedY + 0.4, z), pts[0], 0.05, PAINT(COL.steel));
    base.beam(V(halfW, bedY + 0.4, z), pts[6], 0.05, PAINT(COL.steel));
    for (let i = 0; i < 6; i++) base.beam(pts[i], pts[i + 1], 0.05, PAINT(COL.steel));
  }
  const g = base.merge();
  s.addRaw(g, M(0.1, -0.32, 0, -0.05, 0.06, 0.11));
  wheel(s, M(-2.3, 0.08, -3.2, 0, 0.7, Math.PI / 2), 0.46, 0.14, 0x222222, 1);
  for (let k = 0; k < 5; k++) crate(s, -2.5 + r() * 5, 0, 3 + r() * 2, 0.8, 0.45, 0.5, r() * 3, r() * 0.4, r() * 0.3);
  return { s, c, scorch: 6 };
}

/* =================================================================== dump */

function tarpStack(p: Parts, x: number, z: number, w: number, h: number, d: number, yaw: number, col: number, q: number): void {
  const g = new THREE.BoxGeometry(w, h, d, q ? 2 : 8, q ? 2 : 4, q ? 2 : 8);
  displace(g, (v) => {
    // Round the corners like cloth over stacked boxes, sag between, and pleat at the ground.
    const nx = v.x / (w / 2), ny = (v.y + h / 2) / h, nz = v.z / (d / 2);
    const edge = Math.max(Math.abs(nx), Math.abs(nz));
    v.y -= Math.max(0, edge - 0.7) * ny * h * 0.35;
    v.y += (vnoise3(v.x * 1.3, v.y, v.z * 1.3 + x) - 0.5) * 0.18 * ny;
    if (ny < 0.05) { v.x *= 1.08; v.z *= 1.08; }
  });
  p.add(g, M(x, h / 2, z, 0, yaw), { color: col, tile: TILE.TARP, scale: 2.2, rough: 0.8, ember: 1 });
}

function dump(side: Side, q: number): KindBuild {
  const s = new Parts(81), c = new Parts(82);
  const sb = SAND(side);
  const tarp = side === 'allied' ? 0x5a5a44 : 0x55594a;
  // Duckboard paths and a trampled floor.
  s.box(13, 0.04, 10, M(0, 0.02, 0), { color: COL.earthDark, tile: TILE.EARTH, scale: 4, rough: 1 });
  s.box(1.0, 0.08, 10.5, M(0.4, 0.06, 0), WOOD(0x7d6a4c));
  s.box(12, 0.08, 1.0, M(0, 0.07, 0.5), WOOD(0x7d6a4c));
  // Blast walls.
  sandWall(s, V(-6.8, 0, -4.8), V(-6.8, 0, 3.8), 1.3, 0.8, sb);
  sandWall(s, V(-5.5, 0, -5.4), V(-1.5, 0, -5.4), 1.3, 0.8, sb);
  // Shell stacks.
  shellStack(s, -4.2, -3.2, 0, q ? 4 : 6, q ? 2 : 4, 0.1, 0.85);
  shellStack(s, -4.2, -1.3, 0, q ? 4 : 6, q ? 2 : 4, 0.1, 0.85);
  shellStack(s, -2.2, -3.0, 0, q ? 3 : 5, q ? 2 : 3, 0.1, 0.85, 0x6a6048);
  // Crate stacks.
  const cs: [number, number, number, number][] = [
    [2.5, -3.2, 3, 0.1], [3.6, -3.1, 2, -0.05], [4.7, -3.3, 3, 0.08], [2.6, -2.2, 2, 0], [3.7, -2.1, 1, 0.3],
    [-3.8, 2.6, 2, 0.2], [-2.7, 2.7, 3, 0.05], [-3.4, 3.7, 1, -0.3],
  ];
  for (const [x, z, n, yaw] of cs) {
    for (let k = 0; k < (q ? Math.min(n, 2) : n); k++) crate(s, x + (s.rnd() - 0.5) * 0.08, k * 0.5, z, 1.0, 0.5, 0.6, yaw + (s.rnd() - 0.5) * 0.15);
  }
  tarpStack(s, 3.6, 2.4, 3.2, 1.6, 2.4, 0.1, tarp, q);
  tarpStack(s, 4.2, -0.5, 2.2, 1.2, 1.6, -0.2, tarp, q);
  // Fuel and oil drums.
  const dc = side === 'allied' ? 0x4a5a3c : 0x3f4a3f;
  for (let k = 0; k < (q ? 4 : 10); k++) drum(s, -1.8 + (k % 5) * 0.62, 0, 3.2 + Math.floor(k / 5) * 0.62, k % 3 ? dc : 0x7a3a22);
  if (!q) {
    drum(s, 0.6, 0, 4.0, dc, 1, 0.6);
    drum(s, -0.2, 0, 4.5, 0x7a3a22, 1, 1.4);
    for (let k = 0; k < 8; k++) shell(s, M(-1.6 + k * 0.28, 0.12, -1.6, 0, 0, 0), 0.1, 0.85, COL.shell);
    soldier(s, M(1.2, 0.08, -0.8, 0, 0.8), side, 'stand');
    soldier(s, M(-0.8, 0.08, 1.4, 0, 2.4), side, 'load');
    // Sign post.
    s.rod(V(5.8, 0, -4.4), V(5.8, 1.8, -4.4), 0.05, WOOD(), 5);
    s.box(0.9, 0.4, 0.04, M(5.8, 1.6, -4.43), { color: 0xd9d0b8, tile: TILE.PAINT, rough: 0.8 });
    s.box(0.7, 0.08, 0.05, M(5.8, 1.62, -4.46), { color: 0x8a1c14, tile: TILE.PAINT, rough: 0.8 });
  }
  return {
    s, c, dyn: [],
    hit: [sph(-3.5, 1, -2, 3.5), sph(3.5, 1, -2.5, 3.2), sph(3.5, 1, 1.8, 3.2), sph(-2.5, 1, 3, 3.2), sph(0, 0.8, 0, 3)],
    height: 2.2, radius: 8.5, blob: [7.5, 6.2],
  };
}

function dumpWreck(side: Side): WreckBuild {
  const s = new Parts(181), c = new Parts(182);
  const r = s.rnd;
  // Crater with a thrown-up rim.
  const rim = gridGeometry(24, 4, (i, j) => {
    const a = (i / 24) * Math.PI * 2;
    const pr = [[1.5, -0.2], [2.6, 0.5], [3.4, 0.75], [4.4, 0.35], [5.6, 0]][j];
    const rr = pr[0] * (0.85 + vnoise3(a * 2, j, 5) * 0.3);
    return V(Math.cos(a) * rr - 1, pr[1] * (0.7 + vnoise3(a * 3, 1, j) * 0.6), Math.sin(a) * rr);
  }, (i, j) => [i * 0.5, j * 0.5]);
  s.add(rim, null, { color: 0x4c4133, tile: TILE.EARTH, uv: 'keep', rough: 1 });
  s.add(new THREE.CircleGeometry(1.6, 12), M(-1, 0.02, 0, -Math.PI / 2), { color: 0x151210, tile: TILE.EARTH, scale: 2, rough: 1 });
  s.char = 0.6;
  sandWall(s, V(-6.8, 0, -4.8), V(-6.8, 0, -0.5), 0.8, 0.9, SAND(side));
  s.char = 1;
  // Debris thrown outward: crates, staves, shells, drums.
  for (let k = 0; k < 40; k++) {
    const a = r() * Math.PI * 2, d = 3 + r() * 6;
    const x = Math.cos(a) * d - 1, z = Math.sin(a) * d;
    const t = r();
    if (t < 0.4) crate(s, x, 0, z, 0.4 + r() * 0.6, 0.2 + r() * 0.3, 0.3 + r() * 0.3, r() * 3, r() * 0.5, r() * 0.5);
    else if (t < 0.7) s.beam(V(x, 0.05, z), V(x + (r() - 0.5) * 1.5, 0.05 + r() * 0.3, z + (r() - 0.5) * 1.5), 0.08, WOOD());
    else if (t < 0.9) shell(s, M(x, 0.1, z, Math.PI / 2, r() * 6), 0.1, 0.85, COL.shell, false);
    else drum(s, x, 0, z, 0x3a3a30, 1, r() * 3);
  }
  tarpStack(s, 3.8, 2.4, 3.0, 0.7, 2.2, 0.3, 0x2a2620, 1);
  for (let k = 0; k < 4; k++) crate(s, 2.6 + k * 0.9, 0, -3.1, 0.9, 0.45, 0.6, (r() - 0.5) * 0.6, 0, (r() - 0.5) * 0.3);
  return { s, c, scorch: 10 };
}

/* ===================================================================== HQ */

function farmhouse(p: Parts, q: number, ruined: boolean, r: () => number): void {
  const L = 10, D = 6.5, H = 3.2, T = 0.45;
  const plaster: PartOpts = { color: 0xd6cdb8, tile: TILE.PLASTER, scale: 2.4, rough: 0.95, jitter: 0.03, ember: 0.2 };
  const plinth: PartOpts = { color: 0x8a8274, tile: TILE.CONCRETE, scale: 1.5, rough: 0.95 };
  if (!ruined) {
    p.box(L, H, T, M(0, H / 2, -D / 2 + T / 2), plaster);
    p.box(L, H, T, M(0, H / 2, D / 2 - T / 2), plaster);
    p.box(T, H, D - 2 * T, M(-L / 2 + T / 2, H / 2, 0), plaster);
    p.box(T, H, D - 2 * T, M(L / 2 - T / 2, H / 2, 0), plaster);
  } else {
    // Walls reduced to jagged stubs.
    const seg = (x0: number, z0: number, x1: number, z1: number): void => {
      const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.9);
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        const hgt = 0.4 + Math.pow(r(), 1.5) * (H - 0.4);
        const ax = x0 + (x1 - x0) * t0, az = z0 + (z1 - z0) * t0, bx = x0 + (x1 - x0) * t1, bz = z0 + (z1 - z0) * t1;
        const len = Math.hypot(bx - ax, bz - az);
        p.box(len + 0.02, hgt, T, M((ax + bx) / 2, hgt / 2, (az + bz) / 2, 0, Math.atan2(bz - az, bx - ax) * -1), plaster);
      }
    };
    seg(-L / 2, -D / 2 + T / 2, L / 2, -D / 2 + T / 2);
    seg(-L / 2, D / 2 - T / 2, L / 2, D / 2 - T / 2);
    seg(-L / 2 + T / 2, -D / 2, -L / 2 + T / 2, D / 2);
    seg(L / 2 - T / 2, -D / 2, L / 2 - T / 2, D / 2);
  }
  p.box(L + 0.1, 0.45, D + 0.1, M(0, 0.22, 0), plinth);
  p.box(L - 1, 0.2, D - 1, M(0, 0.1, 0), { color: 0x0e0c0a, tile: TILE.PAINT, rough: 1 });
  if (ruined) return;
  // Gables and a pantile roof.
  const ridge = 6.2, pitch = Math.atan2(ridge - H, D / 2);
  const gable = new THREE.Shape();
  gable.moveTo(-D / 2, 0); gable.lineTo(D / 2, 0); gable.lineTo(0, ridge - H); gable.closePath();
  const gg = new THREE.ExtrudeGeometry(gable, { depth: T, bevelEnabled: false });
  for (const sx of [-1, 1]) p.add(gg, M(sx * (L / 2 - (sx > 0 ? T : 0)), H, 0, 0, Math.PI / 2), { ...plaster, uv: 'box' });
  const slope = Math.hypot(D / 2 + 0.5, ridge - H + 0.35);
  for (const sz of [-1, 1]) {
    p.box(L + 0.8, 0.12, slope, M(0, (H + ridge) / 2 - 0.05, sz * (D / 4 + 0.22), -pitch, sz > 0 ? Math.PI : 0), { color: 0xffffff, tile: TILE.ROOFTILE, scale: 2.0, rough: 0.85, jitter: 0.05, ember: 0.5 });
  }
  p.box(L + 0.8, 0.16, 0.3, M(0, ridge + 0.1, 0), { color: 0x8c4a32, tile: TILE.PAINT, rough: 0.8 });
  // Chimney.
  p.box(0.7, 2.0, 0.7, M(L / 2 - 1.2, ridge - 0.1, 0.9), { color: 0xffffff, tile: TILE.BRICK, scale: 1.2, rough: 0.9 });
  p.box(0.85, 0.12, 0.85, M(L / 2 - 1.2, ridge + 0.95, 0.9), plinth);
  // Windows and doors (with open shutters).
  const win = (x: number, z: number, face: number): void => {
    p.add(new THREE.PlaneGeometry(1.0, 1.25), M(x, 1.8, z + face * 0.012, 0, face > 0 ? 0 : Math.PI), { color: 0xa9ae9f, tile: TILE.WINDOW, uv: 'decal', rough: 0.3, metal: 0.1 });
    if (!q) {
      for (const sx of [-1, 1]) p.box(0.5, 1.25, 0.04, M(x + sx * 0.78, 1.8, z + face * 0.03), { color: 0x5b6b58, tile: TILE.BOARDS, scale: 0.9, rough: 0.8, ember: 1 });
      p.box(1.2, 0.08, 0.14, M(x, 1.14, z + face * 0.05), plinth);
    }
  };
  for (const x of [-3.2, 2.8]) { win(x, -D / 2, -1); win(x, D / 2, 1); }
  p.add(new THREE.PlaneGeometry(1.1, 2.1), M(-0.2, 1.05 + 0.2, -D / 2 - 0.012, 0, Math.PI), { color: 0x7b6a52, tile: TILE.DOOR, uv: 'decal', rough: 0.8, ember: 1 });
}

function hq(side: Side, q: number): KindBuild {
  const s = new Parts(91), c = new Parts(92);
  const sb = SAND(side);
  farmhouse(s, q, false, s.rnd);
  // Lean-to shed on the east gable.
  s.box(0.08, 2.2, 4.0, M(7.3, 1.1, 0.4), WOOD(COL.creosote));
  s.box(2.3, 0.05, 4.4, M(6.2, 2.45, 0.4, 0, 0, -0.18), { color: 0x7b766d, tile: TILE.CORRUGATED, scale: 1.3, rough: 0.6, metal: 0.4 });
  for (const z of [-1.6, 2.4]) s.box(2.3, 2.2, 0.08, M(6.15, 1.1, z), WOOD(COL.creosote));
  // Sandbagged doorway.
  sandWall(s, V(-1.6, 0, -3.8), V(-1.6, 0, -5.3), 1.5, 0.7, sb);
  sandWall(s, V(1.2, 0, -3.8), V(1.2, 0, -5.3), 1.5, 0.7, sb);
  sandWall(s, V(-1.6, 0, -5.8), V(1.2, 0, -5.8), 1.2, 0.7, sb);
  // Wireless mast with guys, and the aerial run to the chimney.
  const mx = -7.8, mz = 2.5, mh = 17;
  s.rod(V(mx, 0, mz), V(mx, mh, mz), 0.13, WOOD(0x6d5a44), 7, 0.06);
  s.box(1.4, 0.06, 0.06, M(mx, mh - 0.3, mz), WOOD(0x6d5a44));
  if (!q) {
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4;
      s.rope(V(mx, mh * 0.8, mz), V(mx + Math.cos(a) * 7, 0, mz + Math.sin(a) * 7), 0.02, ROPE, 0.2, 3);
    }
    for (const dz of [-0.6, 0.6]) s.rope(V(mx + (dz > 0 ? 0.6 : -0.6), mh - 0.3, mz), V(3.8, 7.2, 0.9 + dz * 0.5), 0.015, { ...ROPE, color: 0x3a3a38 }, 0.9, 5);
    s.rope(V(mx, mh * 0.6, mz), V(-4.2, 2.9, 3.3), 0.015, { ...ROPE, color: 0x3a3a38 }, 0.6, 3);
    // Staff car, bicycles, dispatch clutter.
    const car = new Parts(93);
    car.box(1.6, 0.6, 3.6, M(0, 0.85, 0), PAINT(PAL[side].body, 0.5, 0.2));
    car.box(1.5, 0.5, 1.4, M(0, 1.35, 0.5), { color: 0x2c2a26, tile: TILE.CANVAS, scale: 1, rough: 0.8 });
    car.box(1.0, 0.45, 1.1, M(0, 1.0, -1.65), PAINT(PAL[side].body, 0.5, 0.2));
    for (const sx of [-1, 1]) for (const z of [-1.2, 1.2]) wheel(car, M(sx * 0.75, 0.4, z), 0.4, 0.12, 0x2a2a2a, 1);
    const cg = car.merge();
    s.addRaw(cg, M(4.2, 0, -6.5, 0, 0.3));
    soldier(s, M(-2.2, 0, -4.8, 0, -0.3), side, 'stand');
    soldier(s, M(3.0, 0, -5.8, 0, 2.6), side, 'point');
    crate(s, -4.5, 0, -3.9, 0.9, 0.5, 0.6, 0.1);
    drum(s, 7.8, 0, -2.3, 0x4a5a3c);
  }
  return {
    s, c, dyn: [],
    hit: [sph(-2.5, 3, 0, 5), sph(2.5, 3, 0, 5), sph(6.3, 1.2, 0.4, 2.6), sph(-7.8, 8, 2.5, 1.5)],
    height: 17, radius: 11, blob: [8.2, 5.6],
  };
}

function hqWreck(side: Side): WreckBuild {
  const s = new Parts(191), c = new Parts(192);
  const r = s.rnd;
  s.char = 0.65;
  farmhouse(s, 1, true, r);
  s.char = 1;
  // Rubble heaps inside and spilling out, charred rafters, the fallen mast.
  for (let k = 0; k < 6; k++) {
    const g = new THREE.SphereGeometry(1, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    displace(g, (v) => { v.multiplyScalar(0.8 + vnoise3(v.x * 2 + k, v.y * 2, v.z * 2) * 0.5); });
    const x = -3.5 + r() * 7, z = -2 + r() * 4;
    s.add(g, M(x, 0, z, 0, r() * 3, 0, 1.4 + r(), 0.5 + r() * 0.5, 1.2 + r()), { color: r() < 0.5 ? 0x8a6a52 : 0x9a9082, tile: r() < 0.5 ? TILE.BRICK : TILE.PLASTER, scale: 1.5, rough: 1, ember: 0.7 });
  }
  for (let k = 0; k < 9; k++) {
    const x = -4.5 + k * 1.1;
    s.beam(V(x, 0.2 + r() * 0.8, -2.8 + r()), V(x + (r() - 0.5), 1.5 + r() * 2.2, 0.2 + r() * 2), 0.14, WOOD(COL.timberDark));
  }
  for (let k = 0; k < 20; k++) {
    s.box(0.3 + r() * 0.4, 0.04, 0.2, M(-6 + r() * 12, 0.05, -5 + r() * 10, r() * 0.3, r() * 3, r() * 0.3), { color: 0x8c4a32, tile: TILE.PAINT, rough: 0.9 });
  }
  s.rod(V(-7.8, 0, 2.5), V(-7.7, 4.5, 2.6), 0.13, WOOD(0x6d5a44), 7, 0.11);
  s.rod(V(-7.3, 0.2, 3.2), V(2.2, 0.35, 9.5), 0.11, WOOD(0x6d5a44), 7, 0.06);
  s.box(0.7, 3.0, 0.7, M(3.8, 1.5, 0.9, 0, 0, 0.05), { color: 0xffffff, tile: TILE.BRICK, scale: 1.2, rough: 0.9 });
  s.box(2.3, 0.05, 4.4, M(6.2, 0.6, 0.4, 0.1, 0.2, 0.45), { color: 0x6b675f, tile: TILE.CORRUGATED, scale: 1.3, rough: 0.7, metal: 0.3 });
  void side;
  return { s, c, scorch: 11 };
}

/* ==================================================================== hut */

function hut(side: Side, q: number): KindBuild {
  const s = new Parts(101), c = new Parts(102);
  if (side === 'allied') {
    // Nissen hut: corrugated half-cylinder, boarded ends.
    const R = 2.75, L = 8.4, na = q ? 8 : 20, nz = q ? 1 : 6;
    const shellG = gridGeometry(nz, na, (i, j) => {
      const a = (j / na) * Math.PI;
      return V(Math.cos(a) * R, 0.15 + Math.sin(a) * R, -L / 2 + (L * i) / nz);
    }, (i, j) => [(-L / 2 + (L * i) / nz) / 1.0, -((j / na) * Math.PI * R) / 1.0], true);
    s.add(shellG, null, { color: 0x6f6e66, tile: TILE.CORRUGATED, uv: 'keep', rough: 0.55, metal: 0.45, jitter: 0, ember: 0.3 });
    const inner = gridGeometry(1, na, (i, j) => {
      const a = (j / na) * Math.PI;
      return V(Math.cos(a) * (R - 0.05), 0.15 + Math.sin(a) * (R - 0.05), -L / 2 + L * i);
    });
    s.add(inner, null, { color: 0x1a1714, tile: TILE.PAINT, rough: 1 });
    const end = new THREE.CircleGeometry(R - 0.02, na, 0, Math.PI);
    for (const sz of [-1, 1]) {
      s.add(end, M(0, 0.15, sz * (L / 2 - 0.1), 0, sz > 0 ? 0 : Math.PI), { color: 0x7a6a50, tile: TILE.BOARDS, scale: 1.4, rough: 0.9, ember: 1 });
      s.add(new THREE.PlaneGeometry(0.95, 2.0), M(0, 1.15, sz * (L / 2 - 0.08), 0, sz > 0 ? 0 : Math.PI), { color: 0x6b5a44, tile: TILE.DOOR, uv: 'decal', rough: 0.85, ember: 1 });
      for (const sx of [-1.45, 1.45]) {
        s.add(new THREE.PlaneGeometry(0.75, 0.75), M(sx, 1.6, sz * (L / 2 - 0.08), 0, sz > 0 ? 0 : Math.PI), { color: 0xc8c4b8, tile: TILE.WINDOW, uv: 'decal', rough: 0.3 });
      }
    }
    s.box(2 * R + 0.3, 0.15, L + 0.2, M(0, 0.075, 0), { color: COL.concrete, tile: TILE.CONCRETE, scale: 1.5, rough: 0.95 });
    s.rod(V(1.3, 2.2, 2.0), V(1.3, 3.7, 2.0), 0.08, PAINT(COL.black, 0.6, 0.3), 6);
    s.cyl(0.16, 0.12, 0.12, 8, M(1.3, 3.75, 2.0), PAINT(COL.black, 0.6, 0.3));
    if (!q) {
      s.box(1.3, 0.2, 0.7, M(0, 0.1, -L / 2 - 0.45), WOOD(COL.timberDark));
      drum(s, 2.4, 0, -L / 2 - 0.8, 0x4a5a3c);
      soldier(s, M(-1.6, 0, -L / 2 - 1.4, 0, 0.5), side, 'stand');
    }
    return { s, c, dyn: [], hit: [sph(0, 1.4, -2.3, 3.3), sph(0, 1.4, 2.3, 3.3)], height: 3.8, radius: 5.2, blob: [3.4, 4.9] };
  }
  // German timber barrack with tarred-felt roof.
  const L = 12, D = 5.6, H = 2.6, ridge = 4.3;
  const wall: PartOpts = { color: 0x6a5238, tile: TILE.BOARDS, scale: 1.3, rough: 0.9, ember: 1 };
  s.box(L, H, 0.12, M(0, H / 2 + 0.3, -D / 2), wall);
  s.box(L, H, 0.12, M(0, H / 2 + 0.3, D / 2), wall);
  const gable = new THREE.Shape();
  gable.moveTo(-D / 2, 0); gable.lineTo(D / 2, 0); gable.lineTo(D / 2, H); gable.lineTo(0, ridge); gable.lineTo(-D / 2, H); gable.closePath();
  const gg = new THREE.ExtrudeGeometry(gable, { depth: 0.12, bevelEnabled: false });
  for (const sx of [-1, 1]) s.add(gg, M(sx * L / 2 - (sx > 0 ? 0.12 : 0), 0.3, 0, 0, Math.PI / 2), { ...wall, uv: 'box' });
  s.box(L - 0.3, 0.3, D - 0.3, M(0, 1.5, 0), { color: 0x0e0c0a, tile: TILE.PAINT, rough: 1 });
  const pitch = Math.atan2(ridge - H, D / 2);
  const sl = Math.hypot(D / 2 + 0.4, ridge - H + 0.3);
  for (const sz of [-1, 1]) {
    s.box(L + 0.6, 0.08, sl, M(0, 0.3 + (H + ridge) / 2 - 0.02, sz * (D / 4 + 0.2), sz * pitch), { color: 0x2c2a27, tile: TILE.FELT, scale: 1.6, rough: 0.75, ember: 1 });
    if (!q) for (let k = 0; k < 9; k++) {
      s.box(0.05, 0.05, sl, M(-L / 2 + 0.5 + k * ((L - 1) / 8), 0.3 + (H + ridge) / 2 + 0.03, sz * (D / 4 + 0.2), sz * pitch), WOOD(COL.timberDark));
    }
  }
  s.box(L, 0.3, D, M(0, 0.15, 0), WOOD(COL.timberDark));
  for (const sz of [-1, 1]) for (let k = 0; k < 4; k++) {
    s.add(new THREE.PlaneGeometry(0.9, 0.9), M(-4.2 + k * 2.8, 1.9, sz * (D / 2 + 0.07), 0, sz > 0 ? 0 : Math.PI), { color: 0xc9c2b0, tile: TILE.WINDOW, uv: 'decal', rough: 0.3 });
  }
  s.add(new THREE.PlaneGeometry(1.0, 2.0), M(L / 2 + 0.02, 1.3, 0, 0, Math.PI / 2), { color: 0x5a4632, tile: TILE.DOOR, uv: 'decal', rough: 0.85, ember: 1 });
  s.rod(V(-3, 3.6, 1.2), V(-3, 4.8, 1.2), 0.09, PAINT(COL.black, 0.6, 0.3), 6);
  if (!q) {
    s.box(0.8, 0.3, 1.2, M(L / 2 + 0.45, 0.15, 0), WOOD(COL.timberDark));
    soldier(s, M(L / 2 + 1.4, 0, 1.0, 0, 1.9), side, 'stand');
  }
  return { s, c, dyn: [], hit: [sph(-3, 1.8, 0, 3.8), sph(3, 1.8, 0, 3.8)], height: 4.4, radius: 6.8, blob: [6.6, 3.4] };
}

function hutWreck(side: Side): WreckBuild {
  const s = new Parts(201), c = new Parts(202);
  const r = s.rnd;
  s.char = 1;
  if (side === 'allied') {
    const R = 2.75, L = 8.4;
    // The arch has folded down on itself, torn open along one side.
    const g = gridGeometry(8, 16, (i, j) => {
      const a = (j / 16) * Math.PI, z = -L / 2 + (L * i) / 8;
      const crush = 0.45 + 0.3 * vnoise3(z * 0.4, 1, 2);
      return V(Math.cos(a) * R * (1.1 + (1 - crush) * 0.2), 0.1 + Math.sin(a) * R * crush + (vnoise3(j, z, 1) - 0.5) * 0.3, z);
    }, (i, j) => [(-L / 2 + (L * i) / 8), -(j / 16) * Math.PI * R], true);
    ragged(g, (x, _y, z) => !(x > 0.5 && vnoise3(x, 1, z * 0.6) > 0.45));
    g.computeVertexNormals();
    s.add(g, null, { color: 0x4d4b45, tile: TILE.CORRUGATED, uv: 'keep', rough: 0.7, metal: 0.3 });
    s.box(2 * R + 0.3, 0.15, L + 0.2, M(0, 0.075, 0), { color: COL.concrete, tile: TILE.CONCRETE, scale: 1.5, rough: 0.95 });
    for (let k = 0; k < 8; k++) s.beam(V(-2.5 + r() * 5, 0.1, -L / 2), V(-2.5 + r() * 5, 0.2 + r() * 1.4, -L / 2 - 0.5 + r()), 0.1, WOOD());
  } else {
    s.box(12, 0.3, 5.6, M(0, 0.15, 0), WOOD(COL.timberDark));
    for (let k = 0; k < 14; k++) {
      const x = -5.8 + (k % 7) * 1.9, z = k < 7 ? -2.8 : 2.8;
      s.beam(V(x, 0.3, z), V(x + (r() - 0.5) * 0.4, 0.5 + r() * 2, z), 0.14, WOOD());
    }
    s.box(6.4, 0.08, 3.4, M(-2.5, 1.1, -0.6, 0.35, 0.1, 0.1), { color: 0x222120, tile: TILE.FELT, scale: 1.6, rough: 0.8 });
    s.box(5.4, 0.08, 3.4, M(3.2, 0.7, 0.9, -0.3, -0.2, -0.15), { color: 0x222120, tile: TILE.FELT, scale: 1.6, rough: 0.8 });
    for (let k = 0; k < 16; k++) s.beam(V(-6 + r() * 12, 0.35, -3 + r() * 6), V(-6 + r() * 12, 0.4 + r() * 0.4, -3 + r() * 6), 0.1, WOOD());
  }
  return { s, c, scorch: 7 };
}

/* =================================================================== tent */

function tent(side: Side, q: number): KindBuild {
  const s = new Parts(211), c = new Parts(212);
  const col = PAL[side].tent;
  if (side === 'allied') {
    // Bell tent: a cone on a short wall, sagging between its twelve seams.
    const R = 2.2, H = 3.1, wallH = 0.4, n = 12, sub = q ? 1 : 4, rings = q ? 3 : 8;
    const cone = gridGeometry(rings, n * sub, (i, j) => {
      const a = (j / (n * sub)) * Math.PI * 2;
      const t = i / rings;
      const sag = Math.sin(((j % sub) / sub) * Math.PI) * 0.12 * Math.sin(t * Math.PI);
      const rr = R * (1 - t) - sag;
      return V(Math.cos(a) * rr, wallH + (H - wallH) * t, Math.sin(a) * rr);
    }, (i, j) => [(j / (n * sub)) * Math.PI * 2 * R / 2, -((H - wallH) * i) / rings / 1.5]);
    s.add(cone, null, { color: col, tile: TILE.CANVAS, uv: 'keep', rough: 0.92, ember: 1, jitter: 0 });
    s.add(new THREE.CylinderGeometry(R, R + 0.05, wallH, n * sub, 1, true), M(0, wallH / 2, 0), { color: col, tile: TILE.CANVAS, scale: 1.5, rough: 0.92, ember: 1 });
    // Open door: dark gap with the flap tied back.
    s.add(new THREE.PlaneGeometry(0.9, 1.6), M(0, 0.85, -R + 0.25, 0.28, Math.PI), { color: 0x14110d, tile: TILE.PAINT, rough: 1 });
    s.box(0.35, 1.5, 0.08, M(0.62, 0.8, -R + 0.18, 0.25, 0.3), { color: col, tile: TILE.CANVAS, scale: 1, rough: 0.92, ember: 1 });
    s.sphere(0.07, M(0, H + 0.1, 0), WOOD(COL.timberDark), 6, 4);
    if (!q) {
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + 0.1;
        guy(s, V(Math.cos(a) * R * 0.72, wallH + (H - wallH) * 0.33, Math.sin(a) * R * 0.72), V(Math.cos(a) * 4.4, 0, Math.sin(a) * 4.4), 0.018);
      }
      soldier(s, M(1.6, 0, -3.0, 0, -0.4), side, 'stand');
    }
    return { s, c, dyn: [], hit: [sph(0, 1.2, 0, 2.6)], height: 3.2, radius: 4.6, blob: [3.0, 3.0] };
  }
  // Marquee: walled ridge tent.
  const L = 6.4, D = 4.4, wh = 1.7, rh = 3.3;
  const wall: PartOpts = { color: col, tile: TILE.CANVAS, scale: 2, rough: 0.92, ember: 1 };
  s.box(L, wh, 0.04, M(0, wh / 2, -D / 2), wall);
  s.box(L, wh, 0.04, M(0, wh / 2, D / 2), wall);
  const gable = new THREE.Shape();
  gable.moveTo(-D / 2, 0); gable.lineTo(D / 2, 0); gable.lineTo(D / 2, wh); gable.lineTo(0, rh); gable.lineTo(-D / 2, wh); gable.closePath();
  const gg = new THREE.ShapeGeometry(gable);
  s.add(gg, M(L / 2, 0, 0, 0, Math.PI / 2), { ...wall, uv: 'box' });
  s.add(gg, M(-L / 2, 0, 0, 0, -Math.PI / 2), { ...wall, uv: 'box' });
  const pitch = Math.atan2(rh - wh, D / 2);
  const sl = Math.hypot(D / 2 + 0.35, rh - wh + 0.25);
  const roof = (sz: number) => gridGeometry(q ? 1 : 8, 2, (i, j) => {
    const x = -L / 2 - 0.2 + ((L + 0.4) * i) / (q ? 1 : 8);
    const t = j / 2;
    const sag = q ? 0 : Math.sin(((x + L / 2) / L) * Math.PI * 3) ** 2 * 0.1 * Math.sin(t * Math.PI);
    return V(x, rh - (rh - wh + 0.25) * t - sag, sz * (D / 2 + 0.35) * t);
  }, (i, j) => [(-L / 2 + ((L + 0.4) * i) / (q ? 1 : 8)) / 2, -(sl * j) / 2 / 2], sz > 0);
  for (const sz of [-1, 1]) s.add(roof(sz), null, { color: col, tile: TILE.CANVAS, uv: 'keep', rough: 0.92, ember: 1 });
  void pitch;
  s.box(L - 0.2, 0.1, D - 0.2, M(0, 1.5, 0), { color: 0x14110d, tile: TILE.PAINT, rough: 1 });
  s.add(new THREE.PlaneGeometry(1.2, 1.6), M(L / 2 + 0.01, 0.8, 0, 0, Math.PI / 2), { color: 0x14110d, tile: TILE.PAINT, rough: 1 });
  if (!q) {
    for (let k = 0; k < 4; k++) {
      const x = -L / 2 + 0.6 + k * ((L - 1.2) / 3);
      for (const sz of [-1, 1]) guy(s, V(x, wh, sz * (D / 2 + 0.3)), V(x, 0, sz * (D / 2 + 2.2)), 0.018);
    }
    for (const sx of [-1, 1]) guy(s, V(sx * (L / 2 + 0.1), rh - 0.1, 0), V(sx * (L / 2 + 2.5), 0, 0), 0.018);
    soldier(s, M(L / 2 + 1.5, 0, -1.2, 0, 1.2), side, 'stand');
  }
  return { s, c, dyn: [], hit: [sph(-1.6, 1.4, 0, 2.8), sph(1.6, 1.4, 0, 2.8)], height: 3.4, radius: 5.4, blob: [4.0, 3.0] };
}

function tentWreck(side: Side): WreckBuild {
  const s = new Parts(221), c = new Parts(222);
  s.char = 1;
  const r = s.rnd;
  const g = new THREE.CircleGeometry(side === 'allied' ? 2.6 : 3.4, 16, 0, Math.PI * 2);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i, 0.05 + Math.max(0, vnoise3(x * 0.9, y * 0.9, 4) - 0.35) * 1.0);
  }
  g.computeVertexNormals();
  ragged(g, (x, y) => vnoise3(x * 0.8 + 3, y * 0.8, 1) > 0.33);
  s.add(g, M(0, 0, 0, -Math.PI / 2, 0, 0, side === 'allied' ? 1 : 1.3, 1, 1), { color: 0x2a241c, tile: TILE.CANVAS, scale: 2, rough: 1 });
  s.beam(V(0, 0, 0), V(1.2, 0.5, 0.8), 0.08, WOOD());
  s.beam(V(1.3, 0.1, 0.2), V(2.8, 0.1, 1.5), 0.08, WOOD());
  for (let k = 0; k < 5; k++) crate(s, -3 + r() * 6, 0, -3 + r() * 6, 0.5, 0.3, 0.4, r() * 3, r() * 0.3, 0);
  return { s, c, scorch: 5 };
}

/* ================================================================== winch */

function winch(side: Side, q: number): KindBuild {
  const s = new Parts(231), c = new Parts(232);
  const { bedY, bedZ1 } = lorryBase(s, { side, q, cabRoof: true, bed: 4.0 });
  const drumSpec = dyn('drum', null, V(0, bedY + 0.95, 1.2), 'spin', 0, 233);
  const paint = PAINT(PAL[side].body, 0.6, 0.15);
  const steel = PAINT(COL.gunmetal, 0.45, 0.6);
  // Winch engine housing with louvres.
  s.box(1.5, 1.1, 1.1, M(0, bedY + 0.55, 0.2), paint);
  if (!q) for (const sx of [-1, 1]) s.add(new THREE.PlaneGeometry(0.8, 0.5), M(sx * 0.755, bedY + 0.65, 0.2, 0, sx * Math.PI / 2), { color: PAL[side].body, tile: TILE.GRILLE, uv: 'decal', rough: 0.7 });
  s.rod(V(0.4, bedY + 1.1, 0.0), V(0.4, bedY + 1.9, 0.0), 0.07, PAINT(COL.black, 0.6, 0.3), 6);
  // A-frames carrying the drum.
  for (const sx of [-1, 1]) {
    s.beam(V(sx * 0.85, bedY, 0.7), V(sx * 0.85, bedY + 1.0, 1.2), 0.1, steel);
    s.beam(V(sx * 0.85, bedY, 1.7), V(sx * 0.85, bedY + 1.0, 1.2), 0.1, steel);
  }
  const d = drumSpec.parts;
  d.cyl(0.55, 0.55, 1.4, q ? 8 : 18, M(0, 0, 0, 0, 0, Math.PI / 2), { color: 0x4a4a46, tile: TILE.RIVET, scale: 0.8, rough: 0.5, metal: 0.6 });
  for (const sx of [-1, 1]) d.cyl(0.78, 0.78, 0.06, q ? 8 : 18, M(sx * 0.72, 0, 0, 0, 0, Math.PI / 2), steel);
  if (!q) for (let k = 0; k < 6; k++) d.box(1.4, 0.05, 0.05, M(0, 0, 0, (k / 6) * Math.PI * 2, 0, 0).multiply(M(0, 0.56, 0)), PAINT(0x2a2826, 0.4, 0.8));
  // Fairlead gantry at the tail: the cable leaves over this pulley.
  const top = V(0, bedY + 2.55, bedZ1 + 0.1);
  for (const sx of [-1, 1]) s.beam(V(sx * 0.9, bedY, bedZ1 - 0.2), V(sx * 0.18, top.y, top.z), 0.1, steel);
  s.add(new THREE.TorusGeometry(0.28, 0.07, 6, 14), M(top.x, top.y - 0.05, top.z, 0, Math.PI / 2), steel);
  s.rod(V(0, bedY + 0.95 + 0.55, 1.2), V(top.x, top.y - 0.3, top.z), 0.02, PAINT(0x2a2826, 0.4, 0.8), 4);
  // Ground anchors: sandbags and a spade.
  if (!q) {
    for (const sx of [-1.8, 1.8]) {
      for (let k = 0; k < 3; k++) s.box(0.62, 0.22, 0.36, M(sx, 0.11 + k * 0.22, bedZ1 + 0.8, 0, (s.rnd() - 0.5) * 0.4), { ...SAND(side), uv: 'box' });
    }
    soldier(s, M(0.85, bedY, 2.4, 0, -1.5), side, 'stand');
    soldier(s, M(-1.9, 0, 1.0, 0, -1.2), side, 'point');
    soldier(s, M(0.4, 0.9, -0.95), side, 'sit');
  }
  return {
    s, c, dyn: [drumSpec],
    hit: [sph(0, 1.3, -2.2, 1.9), sph(0, 1.8, 0.4, 2.2), sph(0, 2.2, 2.6, 2.0)],
    height: 3.9, radius: 4.2, blob: [1.9, 4.0],
    anchor: top.clone().setY(top.y + 0.25),
  };
}

function winchWreck(side: Side): WreckBuild {
  const s = new Parts(241), c = new Parts(242);
  s.char = 1;
  const base = new Parts(243); base.char = 1;
  const { bedY } = lorryBase(base, { side, q: 1, cabRoof: false, bed: 4.0 });
  base.box(1.5, 1.1, 1.1, M(0, bedY + 0.4, 0.2, 0.1), PAINT(PAL[side].body));
  const g = base.merge();
  s.addRaw(g, M(0, -0.3, 0, 0.05, -0.05, -0.1));
  // Drum torn off its frames, coils of cable spilled.
  s.cyl(0.55, 0.55, 1.4, 12, M(2.2, 0.6, 1.5, 0.3, 0.6, Math.PI / 2 - 0.2), PAINT(0x3a3a36, 0.6, 0.5));
  for (let k = 0; k < 5; k++) s.add(new THREE.TorusGeometry(0.6 + k * 0.15, 0.025, 4, 16), M(3.2 + k * 0.1, 0.05, 3.0, Math.PI / 2 + 0.1, 0, 0), PAINT(0x2a2826, 0.5, 0.6));
  return { s, c, scorch: 6 };
}

/* ============================================================ searchlight */

function searchlight(side: Side, q: number): KindBuild {
  const s = new Parts(251), c = new Parts(252);
  const tur = dyn('turret', null, V(0, 1.02, 0), 'yaw', 0, 253);
  const head = dyn('gun', 'turret', V(0, 0.72, 0), 'pitch', 0.55, 254);
  const body = side === 'allied' ? 0x4f5236 : 0x555b4d;
  const paint = PAINT(body, 0.55, 0.25);
  const steel = PAINT(COL.gunmetal, 0.45, 0.6);
  // Low sandbag ring, timber platform, tripod pedestal.
  sandRing(s, V(0, 0, 0), 2.1, 0.6, 0.7, 0.6, Math.PI * 2 - 0.6, SAND(side), q ? 10 : 22);
  s.cyl(1.25, 1.3, 0.16, 12, M(0, 0.08, 0), WOOD(0x7a6448));
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    s.beam(V(Math.cos(a) * 0.9, 0.16, Math.sin(a) * 0.9), V(Math.cos(a) * 0.18, 0.95, Math.sin(a) * 0.18), 0.1, steel);
  }
  s.cyl(0.22, 0.25, 0.2, 10, M(0, 0.95, 0), paint);
  const t = tur.parts;
  t.cyl(0.42, 0.42, 0.08, 14, null, paint);
  for (const sx of [-1, 1]) t.box(0.08, 0.85, 0.22, M(sx * 0.64, 0.38, 0), paint);
  t.box(1.36, 0.08, 0.26, M(0, 0.02, 0), paint);
  if (!q) t.rod(V(0.35, 0.05, 0.2), V(0.35, 0.05, 0.9), 0.02, steel, 4);
  // Lamp drum: 90 cm projector with louvred ventilator on top.
  const h = head.parts;
  h.cyl(0.55, 0.55, 1.1, q ? 10 : 20, M(0, 0, 0, Math.PI / 2), paint, true);
  h.cyl(0.6, 0.6, 0.12, q ? 10 : 20, M(0, 0, -0.56, Math.PI / 2), steel, true);
  h.add(new THREE.SphereGeometry(0.56, q ? 10 : 18, 6, 0, Math.PI * 2, 0, Math.PI / 2), M(0, 0, 0.55, Math.PI / 2, 0, 0, 1, 0.35, 1), paint);
  h.cyl(0.14, 0.14, 0.3, 8, M(0, 0.62, 0.1), paint);
  h.cyl(0.24, 0.24, 0.06, 8, M(0, 0.78, 0.1), paint);
  for (const sx of [-1, 1]) h.cyl(0.07, 0.07, 0.12, 8, M(sx * 0.58, 0, 0, 0, 0, Math.PI / 2), steel);
  if (!q) {
    for (const sx of [-1, 1]) h.add(new THREE.PlaneGeometry(0.5, 0.35), M(sx * 0.556, 0.12, 0.15, 0, sx * Math.PI / 2), { color: body, tile: TILE.GRILLE, uv: 'decal', rough: 0.7 });
    h.rod(V(-0.3, -0.45, 0.3), V(-0.3, -0.8, 0.75), 0.02, steel, 4);
    // Generator crate and cable.
    s.box(1.3, 0.9, 0.9, M(2.9, 0.45, 1.4, 0, 0.4), paint);
    s.add(new THREE.PlaneGeometry(0.9, 0.5), M(2.9 + 0.66 * Math.cos(0.4), 0.5, 1.4 - 0.66 * Math.sin(0.4), 0, Math.PI / 2 + 0.4), { color: body, tile: TILE.GRILLE, uv: 'decal', rough: 0.7 });
    s.rope(V(0.2, 0.9, 0.2), V(2.3, 0.05, 1.3), 0.025, PAINT(COL.black), 0.3, 3);
    soldier(s, M(0.55, 0.16, 1.1, 0, 0.3), side, 'stand');
    soldier(s, M(-1.3, 0, 1.7, 0, -0.4), side, 'binoc');
  }
  return {
    s, c, dyn: [tur, head],
    hit: [sph(0, 1.3, 0, 2.2), sph(2.9, 0.5, 1.4, 1.0)],
    height: 2.6, radius: 3.5, blob: [3.0, 3.0],
    muzzle: { part: 'gun', p: V(0, 0, -0.62) },
    lens: { part: 'gun', p: V(0, 0, -0.6), r: 0.5 },
    aim: { yawLimit: Math.PI, pitchMin: -0.1, pitchMax: 1.5, yawRate: 0.7, pitchRate: 0.5 },
  };
}

function searchlightWreck(side: Side): WreckBuild {
  const s = new Parts(261), c = new Parts(262);
  s.char = 0.5;
  sandRing(s, V(0, 0, 0), 2.1, 0.45, 0.8, 0.6, 3.5, SAND(side), 10);
  s.char = 1;
  s.cyl(1.25, 1.3, 0.16, 10, M(0, 0.08, 0, 0.05, 0, -0.04), WOOD(0x7a6448));
  s.beam(V(0.9, 0.16, 0), V(0.4, 0.6, 0.3), 0.1, PAINT(COL.gunmetal));
  s.beam(V(-0.45, 0.16, 0.78), V(-0.1, 0.3, 1.6), 0.1, PAINT(COL.gunmetal));
  // The drum on its side, glass gone.
  s.cyl(0.55, 0.55, 1.1, 12, M(-0.6, 0.55, -0.9, 0.2, 0.7, Math.PI / 2 + 0.3), PAINT(0x3a3a34, 0.7, 0.3), true);
  s.add(new THREE.CircleGeometry(0.5, 12), M(-0.6, 0.55, -0.9, 0.2, 0.7, Math.PI / 2 + 0.3).multiply(M(0, 0.5, 0, -Math.PI / 2)), { color: 0x0a0a0a, tile: TILE.PAINT, rough: 1 });
  s.box(1.3, 0.7, 0.9, M(2.9, 0.3, 1.4, 0.1, 0.5, 0.2), PAINT(0x3a3a34));
  return { s, c, scorch: 4.5 };
}

/* ================================================================ registry */

export function buildKind(kind: GroundKind, side: Side, q: number): KindBuild {
  switch (kind) {
    case 'hangar': return hangar(side, q);
    case 'aagun': return side === 'allied' ? aaAllied(q) : aaCentral(q);
    case 'artillery': return artillery(side, q);
    case 'mgnest': return mgnest(side, q);
    case 'lorry': return lorry(side, q);
    case 'dump': return dump(side, q);
    case 'hq': return hq(side, q);
    case 'hut': return hut(side, q);
    case 'tent': return tent(side, q);
    case 'winch': return winch(side, q);
    case 'searchlight': return searchlight(side, q);
  }
}

export function buildWreck(kind: GroundKind, side: Side): WreckBuild {
  switch (kind) {
    case 'hangar': return hangarWreck(side);
    case 'aagun': return aaWreck(side);
    case 'artillery': return artilleryWreck(side);
    case 'mgnest': return mgWreck(side);
    case 'lorry': return lorryWreck(side);
    case 'dump': return dumpWreck(side);
    case 'hq': return hqWreck(side);
    case 'hut': return hutWreck(side);
    case 'tent': return tentWreck(side);
    case 'winch': return winchWreck(side);
    case 'searchlight': return searchlightWreck(side);
  }
}

export { ROPE };
