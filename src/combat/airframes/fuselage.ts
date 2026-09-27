import * as THREE from 'three';
import { Geo, v3, type RGB, type V3 } from './geo';
import type { SkinRegion } from './atlas';

/**
 * Fuselages are lofted through cross-sections that are each two superellipses:
 * one above the "shoulder" line (the widest point) and one below. Exponent 2
 * is an ellipse — the Albatros's plywood shell — and large exponents give the
 * slab sides of a wire-braced box like the Camel's or the Dr.I's. A Camel's
 * rounded top decking is simply a low exponent above the shoulder and a high
 * one below it, and its gun hump is a bump added to the top curve.
 *
 * Section parameters are interpolated along the length with a monotone cubic,
 * which gives smooth lines without the overshoot a spline would put into a
 * fuselage that tapers to a knife edge at the tail post.
 *
 * UVs: each side gets its own atlas region laid out as a side view of *that*
 * side — nose to the right on the starboard region, to the left on the port
 * one — with v the girth measured down from the top centreline. Arc length
 * rather than height keeps paint undistorted where the section curves over the
 * top decking, and a flat side stays a flat, true-scale side view.
 */

export interface FusKey {
  z: number;
  /** Half width at the shoulder. */
  w: number;
  top: number;
  bot: number;
  /** Shoulder height (widest point); defaults to mid-height. */
  sh?: number;
  /** Superellipse exponents above / below the shoulder. */
  nt?: number;
  nb?: number;
  /** Narrow bump on the top curve (gun hump, headrest). */
  hump?: number;
  hw?: number;
}

export interface Opening {
  /** Plan-view ellipse on the top of the fuselage. */
  z0: number;
  z1: number;
  hw: number;
}

export interface FusSpec {
  keys: FusKey[];
  openings?: Opening[];
  right: SkinRegion;
  left: SkinRegion;
  /** Station spacing (m), and points per half-section. */
  dz: number;
  m: number;
  capFront?: boolean;
}

type Param = 'w' | 'top' | 'bot' | 'sh' | 'nt' | 'nb' | 'hump' | 'hw';
const PARAMS: Param[] = ['w', 'top', 'bot', 'sh', 'nt', 'nb', 'hump', 'hw'];

/** Monotone cubic (Fritsch–Carlson) through (xs, ys). */
function pchip(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const d: number[] = [], m: number[] = [];
  for (let k = 0; k < n - 1; k++) d.push((ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]));
  m.push(d[0] ?? 0);
  for (let k = 1; k < n - 1; k++) m.push(d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2);
  m.push(d[n - 2] ?? 0);
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
    const a = m[k] / d[k], b = m[k + 1] / d[k];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[k] = t * a * d[k]; m[k + 1] = t * b * d[k]; }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]) k++;
    const h = xs[k + 1] - xs[k], t = (x - xs[k]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
  };
}

export class Fuselage {
  readonly z0: number;
  readonly z1: number;
  private readonly f: Record<Param, (z: number) => number>;

  constructor(readonly keys: FusKey[]) {
    const ks = [...keys].sort((a, b) => a.z - b.z);
    this.z0 = ks[0].z;
    this.z1 = ks[ks.length - 1].z;
    const zs = ks.map((k) => k.z);
    const f = {} as Record<Param, (z: number) => number>;
    for (const p of PARAMS) {
      const ys = ks.map((k) => {
        switch (p) {
          case 'sh': return k.sh ?? (k.top + k.bot) / 2;
          case 'nt': return k.nt ?? 2.4;
          case 'nb': return k.nb ?? 5;
          case 'hump': return k.hump ?? 0;
          case 'hw': return k.hw ?? 0.2;
          default: return k[p];
        }
      });
      f[p] = pchip(zs, ys);
    }
    this.f = f;
  }

  param(p: Param, z: number): number {
    return this.f[p](z);
  }

  /** Dense half-section (right side), top centre → bottom centre, as [x, y]. */
  dense(z: number, n = 72): [number, number][] {
    const W = Math.max(0.004, this.f.w(z)), T = this.f.top(z), B = this.f.bot(z);
    const sh = Math.min(T - 0.002, Math.max(B + 0.002, this.f.sh(z)));
    const nt = this.f.nt(z), nb = this.f.nb(z), hump = this.f.hump(z), hw = Math.max(0.01, this.f.hw(z));
    const out: [number, number][] = [];
    for (let k = 0; k <= n; k++) {
      const a = Math.PI / 2 - (k / n) * Math.PI; // +90° (top) → -90° (bottom)
      const c = Math.cos(a), s = Math.sin(a);
      let x: number, y: number;
      if (a >= 0) {
        x = W * Math.pow(c, 2 / nt);
        y = sh + (T - sh) * Math.pow(s, 2 / nt);
        const q = x / hw;
        if (hump > 0 && q < 1) y += hump * (1 - q * q) ** 2;
      } else {
        x = W * Math.pow(c, 2 / nb);
        y = sh - (sh - B) * Math.pow(-s, 2 / nb);
      }
      out.push([x, y]);
    }
    return out;
  }

  /** Resampled half-section with `m` segments, points biased toward corners. Returns [x, y, arc]. */
  section(z: number, m: number): [number, number, number][] {
    const d = this.dense(z, 96);
    // Measure = arc length + turning, so tight corners get their share of points.
    const arc: number[] = [0], meas: number[] = [0];
    let L = 0;
    for (let k = 1; k < d.length; k++) {
      const seg = Math.hypot(d[k][0] - d[k - 1][0], d[k][1] - d[k - 1][1]);
      L += seg;
      arc.push(L);
    }
    const turn: number[] = [0];
    for (let k = 1; k < d.length; k++) {
      let t = 0;
      if (k < d.length - 1) {
        const a1 = Math.atan2(d[k][1] - d[k - 1][1], d[k][0] - d[k - 1][0]);
        const a2 = Math.atan2(d[k + 1][1] - d[k][1], d[k + 1][0] - d[k][0]);
        t = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      }
      turn.push(t);
    }
    for (let k = 1; k < d.length; k++) meas.push(meas[k - 1] + (arc[k] - arc[k - 1]) / (L || 1) + turn[k] * 0.22);
    const M = meas[meas.length - 1];
    const out: [number, number, number][] = [];
    let q = 0;
    for (let i = 0; i <= m; i++) {
      const target = (i / m) * M;
      while (q < meas.length - 2 && meas[q + 1] < target) q++;
      const t = Math.min(1, Math.max(0, (target - meas[q]) / (meas[q + 1] - meas[q] || 1)));
      out.push([
        d[q][0] + (d[q + 1][0] - d[q][0]) * t,
        d[q][1] + (d[q + 1][1] - d[q][1]) * t,
        arc[q] + (arc[q + 1] - arc[q]) * t,
      ]);
    }
    out[0][0] = 0;
    out[m][0] = 0;
    return out;
  }

  /** Girth from the top centreline down to height y on the side at station z (for painters). */
  arcAt(z: number, y: number): number {
    const d = this.dense(z, 160);
    let L = 0;
    for (let k = 1; k < d.length; k++) {
      const seg = Math.hypot(d[k][0] - d[k - 1][0], d[k][1] - d[k - 1][1]);
      if ((d[k - 1][1] - y) * (d[k][1] - y) <= 0 && d[k - 1][1] !== d[k][1]) {
        return L + seg * ((d[k - 1][1] - y) / (d[k - 1][1] - d[k][1]));
      }
      L += seg;
    }
    return y > d[0][1] ? 0 : L;
  }

  halfGirth(z: number): number {
    const d = this.dense(z, 96);
    let L = 0;
    for (let k = 1; k < d.length; k++) L += Math.hypot(d[k][0] - d[k - 1][0], d[k][1] - d[k - 1][1]);
    return L;
  }

  /** Height of the top surface at (x, z). */
  topAt(z: number, x: number): number {
    const d = this.dense(z, 96);
    for (let k = 1; k < d.length; k++) {
      if (d[k][0] >= Math.abs(x) && d[k - 1][0] <= Math.abs(x)) {
        const t = (Math.abs(x) - d[k - 1][0]) / (d[k][0] - d[k - 1][0] || 1);
        return d[k - 1][1] + (d[k][1] - d[k - 1][1]) * t;
      }
    }
    return this.f.sh(z);
  }

  width(z: number): number {
    return this.f.w(z);
  }
}

export interface FusOut {
  outer: Geo;
  /** Inner cockpit tubs (inward-facing), one per opening, uv natural. */
  tubs: Geo[];
  /** Coaming rim path for each opening (body space, closed loop). */
  rims: V3[][];
}

/**
 * Build the skin. Openings are cut by dropping the faces whose centre falls
 * inside the plan ellipse, then pulling the surviving vertices that lie inside
 * out onto the ellipse — a clean edge for the leather coaming to sit on.
 */
export function buildFuselage(fus: Fuselage, sp: FusSpec, tubCol: RGB): FusOut {
  const zs = new Set<number>();
  const n = Math.ceil((fus.z1 - fus.z0) / sp.dz);
  for (let k = 0; k <= n; k++) zs.add(fus.z0 + ((fus.z1 - fus.z0) * k) / n);
  for (const key of sp.keys) zs.add(key.z);
  const openings = sp.openings ?? [];
  for (const o of openings) {
    for (let z = o.z0 - 0.12; z <= o.z1 + 0.12; z += Math.min(sp.dz, 0.05)) zs.add(z);
    zs.add(o.z0); zs.add(o.z1);
  }
  const Z = [...zs].filter((z) => z >= fus.z0 && z <= fus.z1).sort((a, b) => a - b).filter((z, i, a) => i === 0 || z - a[i - 1] > 0.004);
  const K = Z.length;
  const m = sp.m;
  // Full ring per station: right half top→bottom, then left half bottom→top (excluding repeats).
  const ringN = 2 * m;
  const P: V3[][] = [], A: number[][] = [];
  for (const z of Z) {
    const sec = fus.section(z, m);
    const ring: V3[] = [], arcs: number[] = [];
    for (let i = 0; i <= m; i++) { ring.push(v3(sec[i][0], sec[i][1], z)); arcs.push(sec[i][2]); }
    for (let i = m - 1; i >= 1; i--) { ring.push(v3(-sec[i][0], sec[i][1], z)); arcs.push(sec[i][2]); }
    P.push(ring);
    A.push(arcs);
  }
  const inside = (x: number, z: number, o: Opening): number => {
    const zc = (o.z0 + o.z1) / 2, a = (o.z1 - o.z0) / 2;
    return (x / o.hw) ** 2 + ((z - zc) / a) ** 2;
  };
  const shAt = Z.map((z) => fus.param('sh', z));

  // Normals from the unmodified grid.
  const N: V3[][] = [];
  for (let k = 0; k < K; k++) {
    const row: V3[] = [];
    for (let r = 0; r < ringN; r++) {
      const a = P[k][(r + 1) % ringN], b = P[k][(r - 1 + ringN) % ringN];
      const tA = a.clone().sub(b);
      const tB = P[Math.min(K - 1, k + 1)][r].clone().sub(P[Math.max(0, k - 1)][r]);
      const nn = tA.cross(tB);
      if (nn.lengthSq() < 1e-14) nn.set(P[k][r].x, P[k][r].y - shAt[k], 0);
      nn.normalize();
      if (nn.x * P[k][r].x + nn.y * (P[k][r].y - shAt[k]) < 0) nn.negate();
      row.push(nn);
    }
    N.push(row);
  }

  // Faces to drop, and vertices to pull onto the opening edge.
  const drop = (k: number, r: number): boolean => {
    const r1 = (r + 1) % ringN;
    const cx = (P[k][r].x + P[k][r1].x + P[k + 1][r].x + P[k + 1][r1].x) / 4;
    const cy = (P[k][r].y + P[k][r1].y + P[k + 1][r].y + P[k + 1][r1].y) / 4;
    const cz = (Z[k] + Z[k + 1]) / 2;
    if (cy < (shAt[k] + shAt[k + 1]) / 2) return false;
    return openings.some((o) => inside(cx, cz, o) < 1);
  };
  const Q: V3[][] = P.map((row) => row.map((p) => p.clone()));
  for (let k = 0; k < K; k++) {
    for (let r = 0; r < ringN; r++) {
      const p = P[k][r];
      if (p.y < shAt[k]) continue;
      for (const o of openings) {
        const d = inside(p.x, p.z, o);
        if (d < 1) {
          const zc = (o.z0 + o.z1) / 2, a = (o.z1 - o.z0) / 2;
          const s = 1 / Math.sqrt(Math.max(d, 1e-6));
          const nx = p.x * s, nz = zc + (p.z - zc) * s;
          Q[k][r].set(nx, fus.topAt(nz, nx), nz);
        }
      }
    }
  }

  const outer = new Geo();
  const zMax = fus.z1, zMin = fus.z0;
  // Vertex per (k, r, side) — the top and bottom seams split into both regions.
  const idx = new Map<number, number>();
  const vert = (k: number, r: number, side: 0 | 1): number => {
    const key = (k * ringN + r) * 2 + side;
    let i = idx.get(key);
    if (i === undefined) {
      const p = Q[k][r], nrm = N[k][r];
      const arc = A[k][r];
      const u = side === 0 ? zMax - p.z : p.z - zMin;
      i = outer.vert(p.x, p.y, p.z, nrm.x, nrm.y, nrm.z, u, arc);
      idx.set(key, i);
    }
    return i;
  };
  // Emit right side first, then left, so each is one contiguous region range.
  for (const side of [0, 1] as const) {
    const start = outer.count;
    for (let k = 0; k < K - 1; k++) {
      for (let r = 0; r < ringN; r++) {
        const onRight = r < m;
        if ((side === 0) !== onRight) continue;
        if (drop(k, r)) continue;
        const r1 = (r + 1) % ringN;
        outer.quad(vert(k, r, side), vert(k + 1, r, side), vert(k + 1, r1, side), vert(k, r1, side));
      }
    }
    outer.ranges.push({ start, end: outer.count, region: side === 0 ? sp.right : sp.left });
  }
  if (sp.capFront) {
    const start = outer.count;
    const c = outer.vert(0, (fus.param('top', Z[0]) + fus.param('bot', Z[0])) / 2, Z[0], 0, 0, -1, 0, 0);
    const ring: number[] = [];
    for (let r = 0; r <= ringN; r++) { const p = P[0][r % ringN]; ring.push(outer.vert(p.x, p.y, p.z, 0, 0, -1, 0, 0)); }
    for (let r = 0; r < ringN; r++) outer.tri(c, ring[r + 1], ring[r]);
    // Pinned to the right region's forward corner: a dark firewall, hidden in the cowl.
    for (let q = start; q < outer.count; q++) { outer.t[q * 2] = zMax - Z[0]; outer.t[q * 2 + 1] = 0.02; }
    outer.ranges.push({ start, end: outer.count, region: sp.right });
  }
  outer.orient();

  // Cockpit tubs and coaming paths.
  const tubs: Geo[] = [];
  const rims: V3[][] = [];
  for (const o of openings) {
    const tub = new Geo();
    const ks = Z.findIndex((z) => z >= o.z0 - 0.1);
    let ke = K - 1;
    for (let k = K - 1; k >= 0; k--) if (Z[k] <= o.z1 + 0.1) { ke = k; break; }
    const inset = 0.012;
    const tv = (k: number, r: number): number =>
      tub.vert(
        Q[k][r].x - N[k][r].x * inset, Q[k][r].y - N[k][r].y * inset, Q[k][r].z - N[k][r].z * inset,
        -N[k][r].x, -N[k][r].y, -N[k][r].z, r / ringN, (Z[k] - Z[ks]) / (Z[ke] - Z[ks] || 1), tubCol,
      );
    const grid: number[][] = [];
    for (let k = ks; k <= ke; k++) { const row: number[] = []; for (let r = 0; r < ringN; r++) row.push(tv(k, r)); grid.push(row); }
    for (let k = ks; k < ke; k++) {
      for (let r = 0; r < ringN; r++) {
        if (drop(k, r)) continue;
        const r1 = (r + 1) % ringN;
        tub.quad(grid[k - ks][r], grid[k - ks][r1], grid[k + 1 - ks][r1], grid[k + 1 - ks][r]);
      }
    }
    // Bulkheads: instrument board face forward, seat bulkhead aft.
    for (const [k, nz] of [[ks, 1], [ke, -1]] as const) {
      const cy = (fus.param('top', Z[k]) + fus.param('bot', Z[k])) / 2;
      const c = tub.vert(0, cy, Z[k] + nz * 0.005, 0, 0, nz, 0.5, 0.5, tubCol);
      const ring: number[] = [];
      for (let r = 0; r <= ringN; r++) {
        const p = Q[k][r % ringN];
        ring.push(tub.vert(p.x * 0.985, cy + (p.y - cy) * 0.985, Z[k] + nz * 0.005, 0, 0, nz, 0.5, 0.5, tubCol));
      }
      for (let r = 0; r < ringN; r++) tub.tri(c, ring[r], ring[r + 1]);
    }
    tubs.push(tub.orient());
    // Rim path round the ellipse on the top surface.
    const path: V3[] = [];
    const zc = (o.z0 + o.z1) / 2, a = (o.z1 - o.z0) / 2;
    for (let q = 0; q <= 48; q++) {
      const t = (q / 48) * Math.PI * 2;
      const x = Math.sin(t) * o.hw, z = zc - Math.cos(t) * a;
      path.push(new THREE.Vector3(x, fus.topAt(z, x) + 0.004, z));
    }
    rims.push(path);
  }
  return { outer, tubs, rims };
}
