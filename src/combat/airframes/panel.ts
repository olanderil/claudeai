import * as THREE from 'three';
import { Geo, v3, type V3 } from './geo';
import type { SkinRegion } from './atlas';

/**
 * Lifting and control surfaces: wings, tailplanes, fins, rudders.
 *
 * A panel is described in its own frame — X spanwise (outboard), Y up,
 * Z chordwise (aft) — by its leading and trailing edges as functions of span.
 * That one description covers the square Camel tip with rounded corners, the
 * raked SPAD tip, the elliptical Dr.I tip and the D-shaped rudder: wherever
 * the two edges meet, the chord (and with it the thickness) goes to zero and
 * the surface closes itself.
 *
 * The section is a thin cambered NACA-style profile (RAF 15 was ~6 % thick
 * with a nearly flat underside; Fokker's thick sections ~12 %). Between ribs
 * the doped fabric pulls the trailing-edge wire into shallow scallops; that is
 * modelled in geometry because it shows in silhouette, while the rib tapes and
 * the sag of the fabric between ribs are left to the normal map.
 *
 * Control surfaces are cut out of the same grid behind a straight hinge line,
 * so an aileron is exactly the wing's surface until it moves.
 */

export interface HingeSpec {
  /** Chordwise hinge position at span s (keep it a straight line). */
  x: (s: number) => number;
  /** Spanwise extent of the moving part. */
  s0: number;
  s1: number;
}

export interface PanelSpec {
  s0: number;
  s1: number;
  le: (s: number) => number;
  te: (s: number) => number;
  /** Thickness / chord and max camber / chord. */
  tc: number;
  camber: number;
  /** Rib stations (m); drive the trailing-edge scallops (and the rib tapes via region meta). */
  ribs?: number[];
  scallop?: number;
  hinge?: HingeSpec;
  /** Whole panel moves (a rudder); `hinge.x` then only places the axis. */
  moving?: boolean;
  top: SkinRegion;
  bot: SkinRegion;
  /** Target spanwise station spacing (m) and chord points ahead of / behind the hinge line. */
  ds: number;
  nF: number;
  nA: number;
  capRoot?: boolean;
  /** Span over which the outline curves at the tip / root; stations are refined there. */
  tipZone?: number;
  rootZone?: number;
  minThick?: number;
}

export interface PanelOut {
  main: Geo;
  /** The moving part, in the same frame, with its hinge line A→B (outboard). */
  ctrl: Geo | null;
  hingeA: V3;
  hingeB: V3;
}

function camberLine(t: number, m: number, p = 0.38): number {
  if (m === 0) return 0;
  return t < p ? (m / (p * p)) * (2 * p * t - t * t) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * t - t * t);
}

function halfThick(t: number, tc: number): number {
  const tt = Math.max(0, Math.min(1, t));
  return 5 * tc * (0.2969 * Math.sqrt(tt) - 0.126 * tt - 0.3516 * tt * tt + 0.2843 * tt ** 3 - 0.1036 * tt ** 4);
}

function stations(sp: PanelSpec): number[] {
  const st = new Set<number>();
  const n = Math.max(2, Math.ceil((sp.s1 - sp.s0) / sp.ds));
  for (let k = 0; k <= n; k++) st.add(sp.s0 + ((sp.s1 - sp.s0) * k) / n);
  const ribs = sp.ribs ?? [];
  if (sp.scallop && ribs.length > 1) {
    for (let k = 0; k < ribs.length; k++) {
      st.add(ribs[k]);
      if (k + 1 < ribs.length) st.add((ribs[k] + ribs[k + 1]) / 2);
    }
  }
  const tz = sp.tipZone ?? 0.25;
  for (let k = 1; k <= 6; k++) st.add(sp.s1 - tz * (1 - Math.cos((k / 6) * Math.PI * 0.5)));
  if (sp.rootZone) for (let k = 1; k <= 5; k++) st.add(sp.s0 + sp.rootZone * (1 - Math.cos((k / 5) * Math.PI * 0.5)));
  const must = new Set<number>([sp.s0, sp.s1]);
  if (sp.hinge && !sp.moving) { must.add(sp.hinge.s0); must.add(sp.hinge.s1); }
  for (const m of must) st.add(m);
  const sorted = [...st].filter((s) => s >= sp.s0 - 1e-6 && s <= sp.s1 + 1e-6).sort((a, b) => a - b);
  // Merge stations closer than 1.2 cm, never dropping a required one.
  const out: number[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && s - last < 0.012) {
      if (must.has(s)) out[out.length - 1] = s;
      continue;
    }
    out.push(s);
  }
  return out;
}

export function buildPanel(sp: PanelSpec): PanelOut {
  const S = stations(sp);
  const K = S.length;
  const hinge = sp.hinge;
  const nF = sp.nF;
  const nA = sp.moving ? 0 : sp.nA;
  const J = nF + nA;
  const ribs = sp.ribs ?? [];

  const split = (s: number): number => {
    const le = sp.le(s), te = sp.te(s);
    if (sp.moving) return te;
    if (hinge) return Math.min(te, Math.max(le, hinge.x(s)));
    return le + (te - le) * 0.72;
  };
  const sagAt = (s: number): number => {
    if (!sp.scallop || ribs.length < 2) return 0;
    for (let k = 0; k + 1 < ribs.length; k++) {
      if (s >= ribs[k] && s <= ribs[k + 1]) return Math.sin((Math.PI * (s - ribs[k])) / (ribs[k + 1] - ribs[k])) ** 2;
    }
    return 0;
  };

  // P[surface][k][j]: surface 0 upper, 1 lower; j = 0 at the leading edge.
  const P: V3[][][] = [[], []];
  for (let k = 0; k < K; k++) {
    const s = S[k];
    const le = sp.le(s), te = sp.te(s);
    const c = Math.max(te - le, 0.002);
    const xs = split(s);
    const sag = sagAt(s);
    const tcl = Math.max(sp.tc * c, sp.minThick ?? 0.0008) / c;
    for (let surf = 0; surf < 2; surf++) {
      const row: V3[] = [];
      for (let j = 0; j <= J; j++) {
        let x = j <= nF
          ? le + (xs - le) * (1 - Math.cos(((nF ? j / nF : 0) * Math.PI) / 2))
          : xs + ((te - xs) * (j - nF)) / nA;
        const t0 = (x - le) / c;
        if (sp.scallop && t0 > 0.78) x -= sp.scallop * sag * ((t0 - 0.78) / 0.22) ** 1.6;
        const t = (x - le) / c;
        const yc = camberLine(t, sp.camber) * c;
        const yt = halfThick(t, tcl) * c;
        row.push(v3(s, surf === 0 ? yc + yt : yc - yt, x));
      }
      P[surf].push(row);
    }
  }

  // Normals by finite differences round the closed section and along the span.
  const N: V3[][][] = [[], []];
  const ta = new THREE.Vector3(), tb = new THREE.Vector3();
  for (let surf = 0; surf < 2; surf++) {
    for (let k = 0; k < K; k++) {
      const row: V3[] = [];
      const km = Math.max(0, k - 1), kp = Math.min(K - 1, k + 1);
      for (let j = 0; j <= J; j++) {
        if (j === 0) ta.copy(P[0][k][1]).sub(P[1][k][1]);
        else if (j === J) ta.copy(P[surf][k][J]).sub(P[surf][k][J - 1]);
        else ta.copy(P[surf][k][j + 1]).sub(P[surf][k][j - 1]);
        tb.copy(P[surf][kp][j]).sub(P[surf][km][j]);
        const nn = new THREE.Vector3().crossVectors(ta, tb);
        if (nn.lengthSq() < 1e-16) nn.set(0, surf === 0 ? 1 : -1, 0);
        nn.normalize();
        const ref = j === 0 ? v3(0, 0, -1) : v3(0, surf === 0 ? 1 : -1, 0);
        if (nn.dot(ref) < 0) nn.negate();
        row.push(nn);
      }
      N[surf].push(row);
    }
  }

  const main = new Geo();
  const ctrl = new Geo();
  const maps = [new Map<number, number>(), new Map<number, number>()];
  const at = (g: Geo, surf: number, k: number, j: number): number => {
    const m = maps[g === main ? 0 : 1];
    const key = (surf * K + k) * (J + 1) + j;
    let i = m.get(key);
    if (i === undefined) {
      const p = P[surf][k][j], n = N[surf][k][j];
      i = g.vert(p.x, p.y, p.z, n.x, n.y, n.z, p.x, p.z);
      m.set(key, i);
    }
    return i;
  };
  const cellMoves = (k: number, j: number): boolean => {
    if (sp.moving) return true;
    if (!hinge || j < nF) return false;
    return S[k] >= hinge.s0 - 1e-6 && S[k + 1] <= hinge.s1 + 1e-6;
  };
  const topEnd = [0, 0];
  for (let surf = 0; surf < 2; surf++) {
    for (let k = 0; k < K - 1; k++) {
      for (let j = 0; j < J; j++) {
        const g = cellMoves(k, j) ? ctrl : main;
        g.quad(at(g, surf, k, j), at(g, surf, k + 1, j), at(g, surf, k + 1, j + 1), at(g, surf, k, j + 1));
      }
    }
    if (surf === 0) { topEnd[0] = main.count; topEnd[1] = ctrl.count; }
  }
  for (const [g, e] of [[main, topEnd[0]], [ctrl, topEnd[1]]] as const) {
    if (e > 0) g.ranges.push({ start: 0, end: e, region: sp.top });
    if (g.count > e) g.ranges.push({ start: e, end: g.count, region: sp.bot });
  }

  /** Closing face across the section at station k, chord points j0..j1. */
  const face = (g: Geo, k: number, j0: number, j1: number, nrm: V3): void => {
    const base = g.count;
    const h = j1 - j0 + 1;
    for (let surf = 0; surf < 2; surf++) for (let j = j0; j <= j1; j++) {
      const p = P[surf][k][j];
      g.vert(p.x, p.y, p.z, nrm.x, nrm.y, nrm.z, p.x, p.z);
    }
    g.ranges.push({ start: base, end: g.count, region: sp.top });
    for (let q = 0; q < h - 1; q++) g.quad(base + q, base + q + 1, base + h + q + 1, base + h + q);
  };

  let hingeA = v3(), hingeB = v3();
  if (sp.moving) {
    const hx = hinge?.x ?? sp.le;
    hingeA = v3(S[0], 0, hx(S[0]));
    hingeB = v3(S[K - 1], 0, hx(S[K - 1]));
  } else if (hinge) {
    const ks = S.findIndex((s) => s >= hinge.s0 - 1e-6);
    let ke = ks;
    for (let k = K - 1; k >= 0; k--) if (S[k] <= hinge.s1 + 1e-6) { ke = k; break; }
    // False spar on the wing, blunt leading edge on the control surface.
    for (let k = ks; k < ke; k++) {
      const quad = [P[0][k][nF], P[0][k + 1][nF], P[1][k + 1][nF], P[1][k][nF]];
      for (const [g, sgn] of [[main, 1], [ctrl, -1]] as const) {
        const base = g.count;
        for (const p of quad) g.vert(p.x, p.y, p.z, 0, 0, sgn, p.x, p.z);
        g.ranges.push({ start: base, end: g.count, region: sp.top });
        g.quad(base, base + 1, base + 2, base + 3);
      }
    }
    // Ends of the cut-out.
    if (ks > 0) { face(main, ks, nF, J, v3(1, 0, 0)); }
    face(ctrl, ks, nF, J, v3(-1, 0, 0));
    if (ke < K - 1) { face(main, ke, nF, J, v3(-1, 0, 0)); face(ctrl, ke, nF, J, v3(1, 0, 0)); }
    const mid = (k: number): V3 => v3(S[k], (P[0][k][nF].y + P[1][k][nF].y) / 2, P[0][k][nF].z);
    hingeA = mid(ks);
    hingeB = mid(ke);
  }
  if (sp.capRoot) face(sp.moving ? ctrl : main, 0, 0, J, v3(-1, 0, 0));
  if (sp.te(sp.s1) - sp.le(sp.s1) > 0.03) {
    if (sp.moving) face(ctrl, K - 1, 0, J, v3(1, 0, 0));
    else if (hinge && hinge.s1 >= sp.s1 - 1e-6) { face(main, K - 1, 0, nF, v3(1, 0, 0)); face(ctrl, K - 1, nF, J, v3(1, 0, 0)); }
    else face(main, K - 1, 0, J, v3(1, 0, 0));
  }
  main.orient();
  ctrl.orient();
  return { main, ctrl: ctrl.count ? ctrl : null, hingeA, hingeB };
}

/** Panel-frame point on the upper (or lower) surface at span s, chordwise x — for strut and wire attachments. */
export function surfacePoint(sp: PanelSpec, s: number, x: number, upper: boolean): V3 {
  const le = sp.le(s), te = sp.te(s);
  const c = Math.max(te - le, 0.002);
  const t = Math.min(1, Math.max(0, (x - le) / c));
  const tcl = Math.max(sp.tc * c, sp.minThick ?? 0.0008) / c;
  const y = camberLine(t, sp.camber) * c + (upper ? 1 : -1) * halfThick(t, tcl) * c;
  return v3(s, y, x);
}

/**
 * Body-space placement of a panel: root leading edge at `origin`, incidence
 * (nose-up chord) then dihedral, optionally mirrored to the left side.
 */
export function panelMatrix(origin: V3, dihedral: number, incidence: number, left = false): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z);
  m.multiply(new THREE.Matrix4().makeRotationZ(dihedral));
  m.multiply(new THREE.Matrix4().makeRotationX(incidence));
  if (left) m.premultiply(new THREE.Matrix4().makeScale(-1, 1, 1));
  return m;
}

/**
 * Vertical surface: panel span → body +Y, chord → +Z; the panel's "top"
 * surface faces -X (the left side), its "bottom" faces +X.
 */
export function finMatrix(origin: V3, rake = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z);
  m.multiply(new THREE.Matrix4().makeRotationX(rake));
  m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  return m;
}

/** Edge with a circular corner of radius r where it meets span s1; dir +1 bends a TE forward, -1 bends an LE aft. */
export function roundedEdge(x0: number, s1: number, r: number, dir: 1 | -1, sweep = 0): (s: number) => number {
  return (s: number) => {
    const base = x0 + sweep * s;
    const d = s - (s1 - r);
    if (d <= 0 || r <= 0) return base;
    const k = Math.min(1, d / r);
    return base - dir * r * (1 - Math.sqrt(Math.max(0, 1 - k * k)));
  };
}

/** Semi-elliptical closure: from x0 at s = s1 - r to the chord midpoint `xm` at s1. */
export function ellipticEdge(x0: number, xm: number, s1: number, r: number): (s: number) => number {
  return (s: number) => {
    const d = s - (s1 - r);
    if (d <= 0) return x0;
    const k = Math.min(1, d / r);
    return x0 + (xm - x0) * (1 - Math.sqrt(Math.max(0, 1 - k * k)));
  };
}
