import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Shared plumbing for the procedural combat models: a seeded random, matrix
 * shorthands, and `Parts`, the accumulator every model is built with.
 *
 * Every static piece of a model is pushed into a `Parts` with a colour, an
 * atlas tile and a roughness, then merged into ONE geometry. All ground models
 * share one material (see atlas.ts), so a hangar with forty trusses, a hundred
 * guy ropes and a canvas skin is still a single draw call.
 */

export type Vec3 = THREE.Vector3;
export const V = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** mulberry32: small, fast, deterministic — models look the same every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export function smooth(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Translate / rotate (yaw-pitch-roll order, radians) / scale in one call. */
export function M(
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = sx, sz = sx,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    _p.set(x, y, z),
    _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')),
    _s.set(sx, sy, sz),
  );
}

const _up = new THREE.Vector3(0, 1, 0);
/** Matrix taking a unit-length, Y-aligned, origin-centred part onto segment a→b. */
export function along(a: Vec3, b: Vec3, roll = 0): THREE.Matrix4 {
  const d = _p.subVectors(b, a);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(_up, d.clone().divideScalar(len || 1));
  if (roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(_up, roll));
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return new THREE.Matrix4().compose(mid, q, _s.set(1, 1, 1));
}

/** Multiply matrices left to right: mul(A, B, C) = A·B·C. */
export function mul(...ms: THREE.Matrix4[]): THREE.Matrix4 {
  const r = new THREE.Matrix4();
  for (const m of ms) r.multiply(m);
  return r;
}

export interface PartOpts {
  color: THREE.ColorRepresentation;
  /** Atlas tile (see TILE in atlas.ts). */
  tile?: number;
  rough?: number;
  metal?: number;
  /** 0..1: how much this part smoulders once it is a wreck. */
  ember?: number;
  /** 'box' projects metre-scaled UVs from the local shape; 'keep' scales the geometry's own UVs. */
  uv?: 'box' | 'keep' | 'decal';
  /** Metres per texture repeat for 'box'; UV multiplier for 'keep'. */
  scale?: number | [number, number];
  /** Random brightness spread applied per part (natural variation). */
  jitter?: number;
}

const CHAR_A = new THREE.Color(0x1b1510);
const CHAR_B = new THREE.Color(0x0e0d0c);
const _c = new THREE.Color();
const _n = new THREE.Vector3();

/**
 * Accumulates coloured, tiled pieces and merges them into one BufferGeometry
 * with position / normal / uv / color / aMat (tile, roughness, metalness, ember).
 */
export class Parts {
  readonly list: THREE.BufferGeometry[] = [];
  readonly rnd: () => number;
  /** 0 = intact colours; >0 blends everything toward charcoal (wreck builds). */
  char = 0;

  constructor(seed = 1) {
    this.rnd = rng(seed);
  }

  get count(): number {
    return this.list.length;
  }

  add(src: THREE.BufferGeometry, m: THREE.Matrix4 | null, o: PartOpts): this {
    const g = src.clone();
    // Keep exactly the attributes the merged mesh carries.
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!g.index) {
      const n = g.getAttribute('position').count;
      const idx: number[] = new Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(idx);
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const n = pos.count;
    const mode = o.uv ?? 'box';
    const sc = o.scale ?? 1;
    const su = Array.isArray(sc) ? sc[0] : sc;
    const sv = Array.isArray(sc) ? sc[1] : sc;
    const uv = new Float32Array(n * 2);
    if (mode === 'box' || !g.getAttribute('uv')) {
      // Planar projection along the dominant normal axis, in metres — texture
      // density stays constant whatever size the part is.
      for (let i = 0; i < n; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
        let u: number, v: number;
        if (ax >= ay && ax >= az) { u = z; v = y; } else if (ay >= az) { u = x; v = z; } else { u = x; v = y; }
        uv[i * 2] = u / su;
        uv[i * 2 + 1] = -v / sv;
      }
    } else {
      const src2 = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < n; i++) {
        let u = src2.getX(i), v = src2.getY(i);
        if (mode === 'decal') {
          // Decal tiles are sampled once; keep clear of the fract() seam.
          u = 0.01 + clamp01(u) * 0.98;
          v = 0.01 + clamp01(1 - v) * 0.98;
        } else {
          u *= su; v *= sv;
        }
        uv[i * 2] = u;
        uv[i * 2 + 1] = v;
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (m) g.applyMatrix4(m);

    const col = new Float32Array(n * 3);
    _c.set(o.color);
    const j = o.jitter ?? 0.06;
    const k = 1 + (this.rnd() - 0.5) * 2 * j;
    _c.multiplyScalar(k);
    let ember = o.ember ?? 0;
    let rough = o.rough ?? 0.86;
    let metal = o.metal ?? 0;
    if (this.char > 0) {
      const t = Math.min(1, this.char * (0.72 + this.rnd() * 0.34));
      _c.lerp(this.rnd() < 0.5 ? CHAR_A : CHAR_B, t);
      if (o.ember === undefined) ember = 0.35 + this.rnd() * 0.65;
      rough = Math.max(rough, 0.9);
      metal *= 0.3;
    }
    for (let i = 0; i < n; i++) {
      col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      mat[i * 4] = o.tile ?? 0;
      mat[i * 4 + 1] = rough;
      mat[i * 4 + 2] = metal;
      mat[i * 4 + 3] = ember;
    }
    g.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
    this.list.push(g);
    return this;
  }

  /** Push an already-attributed geometry (e.g. another Parts' merge) as-is. */
  addRaw(g: THREE.BufferGeometry, m: THREE.Matrix4 | null = null): this {
    const c = g.clone();
    if (m) c.applyMatrix4(m);
    this.list.push(c);
    return this;
  }

  /* ------------------------------------------------------------ shorthands */

  box(w: number, h: number, d: number, m: THREE.Matrix4 | null, o: PartOpts): this {
    return this.add(new THREE.BoxGeometry(w, h, d), m, o);
  }

  cyl(rt: number, rb: number, h: number, seg: number, m: THREE.Matrix4 | null, o: PartOpts, open = false): this {
    return this.add(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), m, o);
  }

  sphere(r: number, m: THREE.Matrix4 | null, o: PartOpts, ws = 10, hs = 7): this {
    return this.add(new THREE.SphereGeometry(r, ws, hs), m, o);
  }

  /** A square-section member from a to b (timber, girder, strut). */
  beam(a: Vec3, b: Vec3, w: number, o: PartOpts, d = w, roll = 0): this {
    const len = a.distanceTo(b);
    if (len < 1e-4) return this;
    return this.add(new THREE.BoxGeometry(w, len, d), along(a, b, roll), o);
  }

  /** A round member (pole, barrel, rope) from a to b. */
  rod(a: Vec3, b: Vec3, r: number, o: PartOpts, seg = 6, r2 = r): this {
    const len = a.distanceTo(b);
    if (len < 1e-4) return this;
    return this.add(new THREE.CylinderGeometry(r2, r, len, seg, 1, true), along(a, b), o);
  }

  /** A rope with a little catenary sag, as a few thin segments. */
  rope(a: Vec3, b: Vec3, r: number, o: PartOpts, sag = 0, segs = 3): this {
    let prev = a;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const p = a.clone().lerp(b, t);
      p.y -= sag * 4 * t * (1 - t);
      this.rod(prev, p, r, o, 3);
      prev = p;
    }
    return this;
  }

  merge(opts: { groundAO?: number; aoMin?: number } = {}): THREE.BufferGeometry {
    if (this.list.length === 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9), 3));
      g.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(12), 4));
      g.setIndex([0, 1, 2]);
      return g;
    }
    const g = mergeGeometries(this.list, false)!;
    if (opts.groundAO) {
      // Cheap ambient occlusion: everything darkens toward where it meets the
      // ground. It is what makes a model sit ON the terrain rather than float.
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const col = g.getAttribute('color') as THREE.BufferAttribute;
      const nor = g.getAttribute('normal') as THREE.BufferAttribute;
      const lo = opts.aoMin ?? 0.5;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        _n.set(nor.getX(i), nor.getY(i), nor.getZ(i));
        // Downward faces near the ground see mostly dirt.
        const f = lerp(lo, 1, smooth(0, opts.groundAO, y)) * (_n.y < -0.5 ? 0.75 : 1);
        col.setXYZ(i, col.getX(i) * f, col.getY(i) * f, col.getZ(i) * f);
      }
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    for (const p of this.list) p.dispose();
    this.list.length = 0;
    return g;
  }
}

/** A surface from a grid of points (rows × cols), with explicit UVs. */
export function gridGeometry(
  rows: number, cols: number,
  at: (i: number, j: number) => Vec3,
  uvAt?: (i: number, j: number) => [number, number],
  flip = false,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      const p = at(i, j);
      pos.push(p.x, p.y, p.z);
      const t = uvAt ? uvAt(i, j) : [j / cols, i / rows];
      uv.push(t[0], t[1]);
    }
  }
  const w = cols + 1;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * w + j, b = a + 1, c = a + w, d = c + 1;
      if (flip) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Quad in the XY plane facing +Z, UV 0..1 (for decals / windows / wheels). */
export function quad(w: number, h: number): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, h);
}

/** Flip a geometry's winding and normals (for inside surfaces). */
export function flipped(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = g.clone();
  const idx = c.index!;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, a);
  }
  const n = c.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return c;
}

/** Hash noise in [0,1) for a 3D point — for per-vertex crumple and jitter. */
export function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 3D value noise in [0,1]. */
export function vnoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const h = (a: number, b: number, c: number) => hash3(xi + a, yi + b, zi + c);
  const x00 = lerp(h(0, 0, 0), h(1, 0, 0), u), x10 = lerp(h(0, 1, 0), h(1, 1, 0), u);
  const x01 = lerp(h(0, 0, 1), h(1, 0, 1), u), x11 = lerp(h(0, 1, 1), h(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

/** Displace every vertex of a geometry by a function (used for crumpled wrecks). */
export function displace(g: THREE.BufferGeometry, f: (p: Vec3) => void): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const p = V();
  for (let i = 0; i < pos.count; i++) {
    p.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    f(p);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Body-space centre + radius used for bullet hits. */
export interface HitSphere { o: THREE.Vector3; r: number; }

/** Drop triangles whose centroid fails `keep` (burnt-through holes, torn edges). */
export function ragged(g: THREE.BufferGeometry, keep: (x: number, y: number, z: number) => boolean): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const idx = g.index!;
  const out: number[] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    if (keep(x, y, z)) out.push(a, b, c);
  }
  g.setIndex(out);
  return g;
}
