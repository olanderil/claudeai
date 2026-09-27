import * as THREE from 'three';

/**
 * Minimal mesh-building kit for the procedural airframes.
 *
 * Everything an aircraft is made of is generated here as a `Geo`: plain arrays
 * of position / normal / uv / colour plus an index list. Parts are built in
 * their own frame, transformed into body space and then concatenated per
 * material, so a whole fighter ends up as a handful of draw calls.
 *
 * Why not three's BufferGeometry primitives: they have no vertex colours, their
 * UVs cannot be pointed into an atlas without a second pass, and merging needs
 * identical attribute sets anyway. Arrays are simpler to transform and append.
 */

export type RGB = readonly [number, number, number];
export type V3 = THREE.Vector3;

const _c = new THREE.Color();
/** Linear-space vertex colour from an sRGB hex/string. */
export function rgb(hex: string | number): RGB {
  _c.set(hex);
  return [_c.r, _c.g, _c.b];
}
export const WHITE: RGB = [1, 1, 1];

export const v3 = (x = 0, y = 0, z = 0): V3 => new THREE.Vector3(x, y, z);

/** A skin-atlas region as far as geometry cares: UVs in its range are metres. */
export interface RegionRef {
  name: string;
}

export class Geo {
  p: number[] = [];
  n: number[] = [];
  t: number[] = [];
  c: number[] = [];
  i: number[] = [];
  /**
   * Vertex ranges whose uv are still *metres inside a skin-atlas region*. They
   * are rewritten to real texture coordinates once the atlas has been packed,
   * which can only happen after every part of the aircraft has asked for space.
   */
  ranges: { start: number; end: number; region: RegionRef }[] = [];

  get count(): number {
    return this.p.length / 3;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, col: RGB = WHITE): number {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.t.push(u, v);
    this.c.push(col[0], col[1], col[2]);
    return this.count - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.i.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.i.push(a, b, c, a, c, d);
  }

  transform(m: THREE.Matrix4): this {
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3();
    for (let k = 0; k < this.p.length; k += 3) {
      v.set(this.p[k], this.p[k + 1], this.p[k + 2]).applyMatrix4(m);
      this.p[k] = v.x; this.p[k + 1] = v.y; this.p[k + 2] = v.z;
      v.set(this.n[k], this.n[k + 1], this.n[k + 2]).applyMatrix3(nm).normalize();
      this.n[k] = v.x; this.n[k + 1] = v.y; this.n[k + 2] = v.z;
    }
    // A mirror turns every triangle inside out; put the winding back.
    if (m.determinant() < 0) this.flip();
    return this;
  }

  flip(): this {
    for (let k = 0; k < this.i.length; k += 3) {
      const t = this.i[k + 1];
      this.i[k + 1] = this.i[k + 2];
      this.i[k + 2] = t;
    }
    return this;
  }

  /** Mirror across the plane x = 0 (left half from the right half). */
  mirrorX(): this {
    return this.transform(new THREE.Matrix4().makeScale(-1, 1, 1));
  }

  append(g: Geo): this {
    const off = this.count;
    for (const r of g.ranges) this.ranges.push({ start: r.start + off, end: r.end + off, region: r.region });
    for (let k = 0; k < g.p.length; k++) { this.p.push(g.p[k]); this.n.push(g.n[k]); this.c.push(g.c[k]); }
    for (let k = 0; k < g.t.length; k++) this.t.push(g.t[k]);
    for (let k = 0; k < g.i.length; k++) this.i.push(g.i[k] + off);
    return this;
  }

  clone(): Geo {
    return new Geo().append(this);
  }

  color(col: RGB): this {
    for (let k = 0; k < this.c.length; k += 3) { this.c[k] = col[0]; this.c[k + 1] = col[1]; this.c[k + 2] = col[2]; }
    return this;
  }

  /** Squeeze natural [0,1] uvs into a sub-rectangle of a texture. */
  mapRect(r: UVRect): this {
    for (let k = 0; k < this.t.length; k += 2) {
      this.t[k] = r.u0 + clamp01(this.t[k]) * (r.u1 - r.u0);
      this.t[k + 1] = r.v0 + clamp01(this.t[k + 1]) * (r.v1 - r.v0);
    }
    return this;
  }

  /** Declare every vertex's uv to be metres inside `region`. */
  inRegion(region: RegionRef): this {
    this.ranges = [{ start: 0, end: this.count, region }];
    return this;
  }

  /** Put every vertex on one point of a region (flat colour from the atlas). */
  pin(region: RegionRef, u: number, v: number): this {
    for (let k = 0; k < this.t.length; k += 2) { this.t[k] = u; this.t[k + 1] = v; }
    return this.inRegion(region);
  }

  /**
   * Make each triangle face the way its vertex normals say. Primitives compute
   * smooth normals analytically; this saves reasoning about winding for every
   * one of them (and for every transform that could flip it).
   */
  orient(): this {
    const p = this.p, n = this.n, I = this.i;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const wx = p[c] - p[a], wy = p[c + 1] - p[a + 1], wz = p[c + 2] - p[a + 2];
      const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
      const sx = n[a] + n[b] + n[c], sy = n[a + 1] + n[b + 1] + n[c + 1], sz = n[a + 2] + n[b + 2] + n[c + 2];
      if (fx * sx + fy * sy + fz * sz < 0) { const t = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = t; }
    }
    return this;
  }

  /** Recompute smooth normals from the triangles (for irregular hand-built meshes). */
  computeNormals(): this {
    const n = new Array(this.p.length).fill(0);
    const p = this.p, I = this.i;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const wx = p[c] - p[a], wy = p[c + 1] - p[a + 1], wz = p[c + 2] - p[a + 2];
      const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
      for (const q of [a, b, c]) { n[q] += fx; n[q + 1] += fy; n[q + 2] += fz; }
    }
    for (let k = 0; k < n.length; k += 3) {
      const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      this.n[k] = n[k] / l; this.n[k + 1] = n[k + 1] / l; this.n[k + 2] = n[k + 2] / l;
    }
    return this;
  }

  get triangles(): number {
    return this.i.length / 3;
  }

  toBufferGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export interface UVRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------- transforms

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Translation, then XYZ Euler rotation (radians), then scale — as Object3D does it. */
export function mat(pos: V3 | [number, number, number], rot?: [number, number, number], scale?: [number, number, number] | number): THREE.Matrix4 {
  const p = Array.isArray(pos) ? new THREE.Vector3(...pos) : pos;
  _q.setFromEuler(_e.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0, 'XYZ'));
  const s = scale === undefined ? [1, 1, 1] : typeof scale === 'number' ? [scale, scale, scale] : scale;
  return new THREE.Matrix4().compose(p, _q, new THREE.Vector3(s[0], s[1], s[2]));
}

/** Matrix taking local +Z (from z=0) onto the segment a→b, local +Y toward `up` where possible. */
export function alongZ(a: V3, b: V3, up: V3 = v3(0, 1, 0)): THREE.Matrix4 {
  const z = b.clone().sub(a).normalize();
  let x = up.clone().cross(z);
  if (x.lengthSq() < 1e-8) x = v3(1, 0, 0).cross(z);
  x.normalize();
  const y = z.clone().cross(x).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(a);
}

// ---------------------------------------------------------------- primitives

/**
 * Surface of revolution about the Z axis (the aircraft's longitudinal axis).
 * `prof` is [radius, z] pairs, front to back. Angle 0 is +Y (top), increasing
 * toward +X, so an open arc can leave the bottom of a cowl out. Repeat a point
 * to put a crease there.
 */
export function lathe(prof: [number, number][], seg: number, o: { a0?: number; a1?: number; col?: RGB } = {}): Geo {
  const g = new Geo();
  const a0 = o.a0 ?? 0;
  const a1 = o.a1 ?? Math.PI * 2;
  const col = o.col ?? WHITE;
  const n = prof.length;
  const L: number[] = [0];
  for (let k = 1; k < n; k++) L.push(L[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]));
  const total = L[n - 1] || 1;
  const nr: number[] = [], nz: number[] = [];
  for (let k = 0; k < n; k++) {
    const pv = prof[Math.max(0, k - 1)], nx = prof[Math.min(n - 1, k + 1)], c = prof[k];
    const same = (a: [number, number], b: [number, number]): boolean => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 1e-7;
    let d0 = pv, d1 = nx;
    if (k > 0 && same(pv, c)) d0 = c; // crease: the incoming edge is a duplicate
    if (k < n - 1 && same(nx, c)) d1 = c;
    if (d0 === d1) { d0 = pv; d1 = nx; }
    let dr = d1[0] - d0[0], dz = d1[1] - d0[1];
    if (Math.abs(dr) + Math.abs(dz) < 1e-9) { dr = 0; dz = 1; }
    const l = Math.hypot(dr, dz);
    nr.push(dz / l);
    nz.push(-dr / l);
  }
  for (let s = 0; s <= seg; s++) {
    const a = a0 + ((a1 - a0) * s) / seg;
    const sa = Math.sin(a), ca = Math.cos(a);
    for (let k = 0; k < n; k++) {
      const [r, z] = prof[k];
      g.vert(r * sa, r * ca, z, nr[k] * sa, nr[k] * ca, nz[k], s / seg, L[k] / total, col);
    }
  }
  for (let s = 0; s < seg; s++) {
    for (let k = 0; k < n - 1; k++) {
      if (L[k + 1] - L[k] < 1e-7) continue;
      const a = s * n + k, b = (s + 1) * n + k;
      g.quad(a, b, b + 1, a + 1);
    }
  }
  return g.orient();
}

/** Closed cylinder / cone frustum along +Z from z0 to z1. */
export function cyl(r0: number, r1: number, z0: number, z1: number, seg: number, col: RGB = WHITE, caps = true): Geo {
  const prof: [number, number][] = [];
  if (caps) prof.push([0, z0], [r0, z0]);
  prof.push([r0, z0], [r1, z1]);
  if (caps) prof.push([r1, z1], [0, z1]);
  return lathe(prof, seg, { col });
}

/** Torus about the Z axis: ring radius R, tube radius r. */
export function torus(R: number, r: number, seg: number, tubeSeg: number, col: RGB = WHITE, a0 = 0, a1 = Math.PI * 2): Geo {
  const prof: [number, number][] = [];
  for (let k = 0; k <= tubeSeg; k++) {
    const t = (k / tubeSeg) * Math.PI * 2;
    prof.push([R + r * Math.cos(t), -r * Math.sin(t)]);
  }
  return lathe(prof, seg, { a0, a1, col });
}

/** Ellipsoid, optionally only a patch of it (theta = polar angle from +Y, phi around from +Z toward +X). */
export function ellipsoid(
  rx: number, ry: number, rz: number, wSeg: number, hSeg: number, col: RGB = WHITE,
  o: { t0?: number; t1?: number; p0?: number; p1?: number } = {},
): Geo {
  const g = new Geo();
  const t0 = o.t0 ?? 0, t1 = o.t1 ?? Math.PI, p0 = o.p0 ?? 0, p1 = o.p1 ?? Math.PI * 2;
  for (let j = 0; j <= hSeg; j++) {
    const th = t0 + ((t1 - t0) * j) / hSeg;
    for (let i = 0; i <= wSeg; i++) {
      const ph = p0 + ((p1 - p0) * i) / wSeg;
      const ux = Math.sin(th) * Math.sin(ph), uy = Math.cos(th), uz = Math.sin(th) * Math.cos(ph);
      const nx = ux / rx, ny = uy / ry, nz = uz / rz;
      const l = Math.hypot(nx, ny, nz) || 1;
      g.vert(ux * rx, uy * ry, uz * rz, nx / l, ny / l, nz / l, i / wSeg, j / hSeg, col);
    }
  }
  const w = wSeg + 1;
  for (let j = 0; j < hSeg; j++) for (let i = 0; i < wSeg; i++) g.quad(j * w + i, (j + 1) * w + i, (j + 1) * w + i + 1, j * w + i + 1);
  return g.orient();
}

/** Axis-aligned box centred on the origin. */
export function box(sx: number, sy: number, sz: number, col: RGB = WHITE): Geo {
  const g = new Geo();
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces: [V3, V3, V3][] = [
    [v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0)],
    [v3(-1, 0, 0), v3(0, 0, 1), v3(0, 1, 0)],
    [v3(0, 1, 0), v3(1, 0, 0), v3(0, 0, -1)],
    [v3(0, -1, 0), v3(1, 0, 0), v3(0, 0, 1)],
    [v3(0, 0, 1), v3(1, 0, 0), v3(0, 1, 0)],
    [v3(0, 0, -1), v3(-1, 0, 0), v3(0, 1, 0)],
  ];
  for (const [n, u, w] of faces) {
    const base = g.count;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = n.x * hx + u.x * a * hx + w.x * b * hx;
      const y = n.y * hy + u.y * a * hy + w.y * b * hy;
      const z = n.z * hz + u.z * a * hz + w.z * b * hz;
      g.vert(x, y, z, n.x, n.y, n.z, (a + 1) / 2, (b + 1) / 2, col);
    }
    g.quad(base, base + 1, base + 2, base + 3);
  }
  return g.orient();
}

/**
 * Flat plate: a polygon in the XY plane extruded ±t/2 along Z. `bevel` rounds
 * nothing — at these sizes a crisp edge reads better than a soft one.
 */
export function plate(shape: [number, number][], t: number, col: RGB = WHITE): Geo {
  const g = new Geo();
  const contour = shape.map(([x, y]) => new THREE.Vector2(x, y));
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of contour) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const U = (x: number): number => (x - minX) / (maxX - minX || 1);
  const V = (y: number): number => (y - minY) / (maxY - minY || 1);
  for (const side of [1, -1]) {
    const base = g.count;
    for (const p of contour) g.vert(p.x, p.y, (side * t) / 2, 0, 0, side, U(p.x), V(p.y), col);
    for (const [a, b, c] of tris) g.tri(base + a, base + b, base + c);
  }
  const n = contour.length;
  for (let k = 0; k < n; k++) {
    const a = contour[k], b = contour[(k + 1) % n];
    const ex = b.x - a.x, ey = b.y - a.y;
    const l = Math.hypot(ex, ey) || 1;
    const nx = ey / l, ny = -ex / l;
    const base = g.count;
    g.vert(a.x, a.y, t / 2, nx, ny, 0, 0, 0, col);
    g.vert(b.x, b.y, t / 2, nx, ny, 0, 1, 0, col);
    g.vert(b.x, b.y, -t / 2, nx, ny, 0, 1, 1, col);
    g.vert(a.x, a.y, -t / 2, nx, ny, 0, 0, 1, col);
    g.quad(base, base + 1, base + 2, base + 3);
  }
  return g.orient();
}

/**
 * Tube swept along a polyline with rotation-minimising frames. `radius` may
 * vary per point. Used for exhaust pipes, rigging wires, tubes and cords.
 */
export function tube(path: V3[], radius: number | number[], sides: number, col: RGB = WHITE, caps = false): Geo {
  const g = new Geo();
  const n = path.length;
  const R = (k: number): number => (Array.isArray(radius) ? radius[k] : radius);
  const T: V3[] = [];
  for (let k = 0; k < n; k++) {
    const a = path[Math.max(0, k - 1)], b = path[Math.min(n - 1, k + 1)];
    T.push(b.clone().sub(a).normalize());
  }
  let N = Math.abs(T[0].y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  N = N.sub(T[0].clone().multiplyScalar(N.dot(T[0]))).normalize();
  const L: number[] = [0];
  for (let k = 1; k < n; k++) L.push(L[k - 1] + path[k].distanceTo(path[k - 1]));
  const total = L[n - 1] || 1;
  for (let k = 0; k < n; k++) {
    if (k > 0) N = N.sub(T[k].clone().multiplyScalar(N.dot(T[k]))).normalize();
    const B = T[k].clone().cross(N).normalize();
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const dx = Math.cos(a) * N.x + Math.sin(a) * B.x;
      const dy = Math.cos(a) * N.y + Math.sin(a) * B.y;
      const dz = Math.cos(a) * N.z + Math.sin(a) * B.z;
      const r = R(k);
      g.vert(path[k].x + dx * r, path[k].y + dy * r, path[k].z + dz * r, dx, dy, dz, s / sides, L[k] / total, col);
    }
  }
  const w = sides + 1;
  for (let k = 0; k < n - 1; k++) for (let s = 0; s < sides; s++) g.quad(k * w + s, (k + 1) * w + s, (k + 1) * w + s + 1, k * w + s + 1);
  if (caps) {
    for (const [k, sgn] of [[0, -1], [n - 1, 1]] as const) {
      const c = g.vert(path[k].x, path[k].y, path[k].z, T[k].x * sgn, T[k].y * sgn, T[k].z * sgn, 0.5, 0.5, col);
      const ring: number[] = [];
      for (let s = 0; s <= sides; s++) {
        const q = (k * w + s) * 3;
        ring.push(g.vert(g.p[q], g.p[q + 1], g.p[q + 2], T[k].x * sgn, T[k].y * sgn, T[k].z * sgn, 0.5, 0.5, col));
      }
      for (let s = 0; s < sides; s++) g.tri(c, ring[s], ring[s + 1]);
    }
  }
  return g.orient();
}

/** Symmetric streamline section (NACA 00xx form), `m` points per side, chord 1 along +x from the LE at 0. */
export function streamSection(thick: number, m: number): [number, number, number, number][] {
  // returns [x, y, nx, ny] around: TE → upper → LE → lower → TE
  const yt = (t: number): number => 5 * thick * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4);
  const pts: [number, number][] = [];
  for (let k = m; k >= 0; k--) { const t = (1 - Math.cos((k / m) * Math.PI)) / 2; pts.push([t, yt(t)]); }
  for (let k = 1; k <= m; k++) { const t = (1 - Math.cos((k / m) * Math.PI)) / 2; pts.push([t, -yt(t)]); }
  const out: [number, number, number, number][] = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    let nx = ty / l, ny = -tx / l;
    // Normals must point away from the chord line.
    if (nx * (pts[k][0] - 0.4) + ny * pts[k][1] < 0) { nx = -nx; ny = -ny; }
    out.push([pts[k][0], pts[k][1], nx, ny]);
  }
  return out;
}

/**
 * Streamlined strut from a to b: the section's chord lies along `aft`
 * (projected square to the strut), a third of it ahead of the line a→b.
 */
export function strut(a: V3, b: V3, chord: number, thick: number, col: RGB = WHITE, o: { aft?: V3; m?: number; chordB?: number } = {}): Geo {
  const g = new Geo();
  const axis = b.clone().sub(a);
  const len = axis.length();
  axis.normalize();
  const aft = (o.aft ?? v3(0, 0, 1)).clone();
  aft.sub(axis.clone().multiplyScalar(aft.dot(axis)));
  if (aft.lengthSq() < 1e-8) aft.set(1, 0, 0);
  aft.normalize();
  const side = axis.clone().cross(aft).normalize();
  const sec = streamSection(thick, o.m ?? 5);
  const cB = o.chordB ?? chord;
  for (const [end, pt, c] of [[0, a, chord], [1, b, cB]] as const) {
    for (let k = 0; k < sec.length; k++) {
      const [x, y, nx, ny] = sec[k];
      const px = (x - 0.33) * c, py = y * c;
      g.vert(
        pt.x + aft.x * px + side.x * py, pt.y + aft.y * px + side.y * py, pt.z + aft.z * px + side.z * py,
        aft.x * nx + side.x * ny, aft.y * nx + side.y * ny, aft.z * nx + side.z * ny,
        k / (sec.length - 1), end ? len : 0, col,
      );
    }
  }
  const w = sec.length;
  for (let k = 0; k < w - 1; k++) g.quad(k, w + k, w + k + 1, k + 1);
  // Uv v in metres along the strut; normalised by the caller's rect mapping.
  for (let k = 1; k < g.t.length; k += 2) g.t[k] /= Math.max(len, 1e-3);
  return g.orient();
}

/** Thin round wire between two points (rigging, control cables). */
export function wire(a: V3, b: V3, r: number, col: RGB, sides = 4): Geo {
  return tube([a, b], r, sides, col);
}

/** Flat disc facing +Z (or -Z when `back`). */
export function disc(r: number, seg: number, col: RGB = WHITE, back = false): Geo {
  const g = new Geo();
  const nz = back ? -1 : 1;
  const c = g.vert(0, 0, 0, 0, 0, nz, 0.5, 0.5, col);
  for (let s = 0; s <= seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    g.vert(Math.cos(a) * r, Math.sin(a) * r, 0, 0, 0, nz, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5, col);
  }
  for (let s = 0; s < seg; s++) g.tri(c, c + 1 + s, c + 2 + s);
  return g.orient();
}
