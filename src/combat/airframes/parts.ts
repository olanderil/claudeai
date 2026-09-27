import * as THREE from 'three';
import {
  Geo, alongZ, box, cyl, disc, ellipsoid, lathe, mat, plate, rgb, strut, torus, tube, v3, wire,
  type RGB, type V3,
} from './geo';
import type { Kit } from './kit';
import type { SkinRegion } from './atlas';
import { buildPanel, finMatrix, panelMatrix, surfacePoint, type PanelSpec } from './panel';
import type { WingMeta } from './livery';
import { DIAL, dialRect, PR } from './props';
import type { Fuselage } from './fuselage';

/**
 * Components every type is assembled from: wing pairs, tail surfaces, struts
 * and rigging, undercarriage, engines, propellers, guns, crew and cockpit
 * furniture. Each writes into a Kit, in body space (+X right, +Y up, -Z
 * forward), and scales its tessellation with the kit's level of detail.
 */

export const COL = {
  steel: rgb('#8d8f90'),
  darkSteel: rgb('#3c3d3e'),
  gun: rgb('#1c1c1c'),
  black: rgb('#1a1918'),
  brass: rgb('#c09a52'),
  copper: rgb('#b36e45'),
  alu: rgb('#a7a8a6'),
  rubber: rgb('#1d1c1b'),
  leather: rgb('#3e2a1b'),
  leatherBlack: rgb('#231a13'),
  wood: rgb('#8a6a48'),
  woodDark: rgb('#6e4526'),
  interior: rgb('#8a6a45'),
  oily: rgb('#4a4640'),
  castIron: rgb('#303030'),
  white: rgb('#ffffff'),
  skin: rgb('#c89a7c'),
  helmet: rgb('#4a3322'),
  coat: rgb('#3a291c'),
  fur: rgb('#78624a'),
  silk: rgb('#ece6d6'),
  lens: rgb('#141c22'),
  khaki: rgb('#5b5337'),
  feldgrau: rgb('#5d5f52'),
} as const;

// ---------------------------------------------------------------- wings

export interface WingSpec {
  /** Region / node prefix: 'U', 'M', 'L', 'TP'… */
  name: string;
  origin: V3;
  dihedral: number;
  incidence: number;
  s0: number;
  s1: number;
  le: (s: number) => number;
  te: (s: number) => number;
  tc: number;
  camber: number;
  ribs: number[];
  scallop?: number;
  aileron?: { s0: number; s1: number; x: (s: number) => number };
  /** Chordwise extent of the leading-edge sheet (m from LE). */
  leSheet?: number;
  capRoot?: boolean;
  tipZone?: number;
  hit: string;
  /** Mirror to the left (default true). */
  pair?: boolean;
}

export interface WingOut {
  spec: PanelSpec;
  /** Body-space point on the surface at span s (always positive), chordwise x, on side ±1. */
  at(s: number, x: number, upper: boolean, side?: 1 | -1): V3;
}

export function wingPair(k: Kit, w: WingSpec): WingOut {
  const meta: WingMeta = {
    ribs: w.ribs, le: w.le, te: w.te, leSheet: (s) => w.le(s) + (w.leSheet ?? 0.1), hinge: w.aileron,
  };
  const top = k.atlas.region(`${w.name}_top`, 'wing', meta as unknown as Record<string, unknown>);
  const bot = k.atlas.region(`${w.name}_bot`, 'wing', meta as unknown as Record<string, unknown>);
  const spec: PanelSpec = {
    s0: w.s0, s1: w.s1, le: w.le, te: w.te, tc: w.tc, camber: w.camber,
    ribs: w.ribs, scallop: k.detail === 0 ? w.scallop : 0,
    hinge: k.detail === 0 && w.aileron ? w.aileron : undefined,
    top, bot,
    ds: k.detail === 0 ? 0.16 : k.detail === 1 ? 0.7 : (w.s1 - w.s0) / 1.5,
    nF: k.n(11, 4, 2), nA: k.n(5, 2, 1),
    capRoot: w.capRoot, tipZone: k.detail === 2 ? 1e-4 : w.tipZone ?? 0.3,
  };
  const out = buildPanel(spec);
  const sides: (1 | -1)[] = w.pair === false ? [1] : [1, -1];
  for (const side of sides) {
    const m = panelMatrix(w.origin, w.dihedral, w.incidence, side < 0);
    k.skin(out.main.clone().transform(m), 'static', w.hit);
    if (out.ctrl) {
      const a = out.hingeA.clone().applyMatrix4(m), b = out.hingeB.clone().applyMatrix4(m);
      const axis = b.clone().sub(a);
      if (axis.x < 0) axis.negate();
      const node = k.node(`ail${w.name}${side > 0 ? 'R' : 'L'}`, a, { axis });
      k.skin(out.ctrl.clone().transform(m), node, w.hit);
    }
  }
  return {
    spec,
    at: (s, x, upper, side = 1) => surfacePoint(spec, s, x, upper).applyMatrix4(panelMatrix(w.origin, w.dihedral, w.incidence, side < 0)),
  };
}

export interface TailSpec {
  name: string;
  origin: V3;
  s0: number;
  s1: number;
  le: (s: number) => number;
  te: (s: number) => number;
  tc?: number;
  ribs: number[];
  hinge?: { x: (s: number) => number; s0: number; s1: number };
  /** Vertical surfaces: rudder / fin. */
  vertical?: boolean;
  moving?: boolean;
  node?: string;
  hit: string;
  rake?: number;
}

/** Tailplane + elevator, fin, rudder — all thin symmetric sections. */
export function tailSurface(k: Kit, t: TailSpec): WingOut {
  const meta: WingMeta = { ribs: t.ribs, le: t.le, te: t.te, leSheet: (s) => t.le(s) + 0.03, hinge: t.hinge, tapeW: 0.025 };
  const vertical = !!t.vertical;
  const top = k.atlas.region(vertical ? `${t.name}_L` : `${t.name}_top`, 'tail', meta as unknown as Record<string, unknown>);
  const bot = k.atlas.region(vertical ? `${t.name}_R` : `${t.name}_bot`, 'tail', meta as unknown as Record<string, unknown>);
  const spec: PanelSpec = {
    s0: t.s0, s1: t.s1, le: t.le, te: t.te, tc: t.tc ?? 0.05, camber: 0,
    ribs: t.ribs, top, bot,
    hinge: k.detail === 0 ? t.hinge : undefined,
    moving: k.detail === 0 ? t.moving : false,
    ds: k.detail === 0 ? 0.08 : k.detail === 1 ? 0.35 : (t.s1 - t.s0) / 1.5,
    nF: k.n(9, 3, 2), nA: k.n(4, 2, 1),
    tipZone: k.detail === 2 ? 1e-4 : 0.15, rootZone: t.moving && k.detail < 2 ? 0.12 : undefined, minThick: 0.003,
  };
  const out = buildPanel(spec);
  const mats = vertical ? [finMatrix(t.origin, t.rake ?? 0)] : [panelMatrix(t.origin, 0, 0), panelMatrix(t.origin, 0, 0, true)];
  mats.forEach((m) => {
    k.skin(out.main.clone().transform(m), 'static', t.hit);
    if (out.ctrl) {
      const a = out.hingeA.clone().applyMatrix4(m), b = out.hingeB.clone().applyMatrix4(m);
      const axis = b.clone().sub(a);
      if (vertical ? axis.y < 0 : axis.x < 0) axis.negate();
      // Both elevator halves share one node (and one hinge axis, the body X).
      const pivot = vertical ? a : v3(0, a.y, a.z);
      const node = k.node(t.node ?? (vertical ? 'rudder' : 'elevator'), pivot, { axis: vertical ? axis : v3(1, 0, 0) });
      k.skin(out.ctrl.clone().transform(m), node, t.hit);
    }
  });
  return { spec, at: (s, x, upper, side = 1) => surfacePoint(spec, s, x, upper).applyMatrix4(mats[vertical ? 0 : side > 0 ? 0 : 1]) };
}

// ---------------------------------------------------------------- struts & rigging

/**
 * Streamlined strut. `region` 'livery' paints it from the skin atlas (the
 * 'struts' swatch region, which every livery using it must fill) so struts can
 * follow the paint scheme — a red Dr.I has red struts.
 */
export function woodStrut(k: Kit, a: V3, b: V3, chord: number, col: RGB = COL.wood, thick = 0.3, hit?: string, region: 'wood' | 'paint' | 'steel' | 'livery' = 'wood'): void {
  const g = strut(a, b, chord, thick, region === 'livery' ? WHITE_ : col, { m: k.n(6, 3, 2) });
  if (region === 'livery') k.skin(g.pin(k.atlas.region('struts', 'swatch'), 0.02, 0.02), 'static', hit);
  else k.props(g, region, 'static', hit);
}

/** Streamlined steel "Rafwire", doubled for flying wires. */
export function rigWire(k: Kit, a: V3, b: V3, doubled = false, r = 0.0032): void {
  if (k.detail > 1) return;
  if (k.detail === 1 && !doubled) return;
  const sides = k.n(4, 3);
  if (!doubled) { k.props(wire(a, b, r, COL.steel, sides), 'steel'); return; }
  const d = b.clone().sub(a).normalize();
  const off = new THREE.Vector3(0, 0, 1).sub(d.clone().multiplyScalar(d.z)).normalize().multiplyScalar(0.022);
  k.props(wire(a.clone().add(off), b.clone().add(off), r, COL.steel, sides), 'steel');
  if (k.detail === 0) k.props(wire(a.clone().sub(off), b.clone().sub(off), r, COL.steel, sides), 'steel');
}

/** Small metal fitting where struts meet wings. */
export function fitting(k: Kit, p: V3, s = 0.035): void {
  if (k.detail > 0) return;
  k.props(box(s, s * 0.5, s * 1.4).transform(mat(p)), 'steel');
}

// ---------------------------------------------------------------- undercarriage

export interface GearSpec {
  /** Wheel hub centre x (±), axle y, z. */
  track: number;
  y: number;
  z: number;
  r: number;
  tyre: number;
  /** Strut root points on the fuselage (right side; mirrored). */
  front: V3;
  rear: V3;
  /** Apex of the V where it meets the axle (right side). */
  apexX: number;
  strutCol?: RGB;
  strutRegion?: 'wood' | 'steel' | 'paint';
  /** Aerofoil fairing on the axle (Dr.I "fourth wing"). */
  axleWing?: { chord: number; region: SkinRegion };
  hit: string;
  /** Node for the rolling wheels (default 'wheels', which the rig spins). */
  node?: string;
}

export function landingGear(k: Kit, g: GearSpec): V3 {
  const node = k.node(g.node ?? 'wheels', v3(0, g.y, g.z), { axis: v3(1, 0, 0) });
  const cover = k.atlas.region('wheel', 'disc', { r: g.r - g.tyre * 1.6 });
  for (const side of [1, -1]) {
    const cx = side * g.track / 2;
    // Tyre: a torus about the axle (X).
    const toX = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    const tyre = torus(g.r - g.tyre, g.tyre, k.n(32, 12, 8), k.n(10, 5, 3), COL.rubber).transform(toX).transform(mat([cx, g.y, g.z]));
    k.props(tyre, 'rubber', node, g.hit);
    // Fabric covers, slightly domed, both faces; uv = planar metres for the painted disc.
    const rc = g.r - g.tyre * 1.5;
    for (const face of [1, -1]) {
      // Dome bulging toward local ±Z. The lathe's normal is on the right of
      // the direction of travel, so the profile runs rim→centre for +Z and
      // centre→rim for -Z to keep the normal on the bulging side.
      const prof: [number, number][] = [];
      const n = k.n(6, 2, 1);
      for (let q = 0; q <= n; q++) {
        const t = face > 0 ? 1 - q / n : q / n;
        prof.push([rc * t, face * 0.055 * (1 - t * t)]);
      }
      const gcov = lathe(prof, k.n(28, 10, 6));
      // Planar uvs in metres: the painted design is centred on the hub.
      for (let q = 0; q < gcov.count; q++) { gcov.t[q * 2] = gcov.p[q * 3]; gcov.t[q * 2 + 1] = -gcov.p[q * 3 + 1]; }
      gcov.inRegion(cover);
      // Lathe axis Z → body X.
      gcov.transform(new THREE.Matrix4().makeRotationY(Math.PI / 2));
      gcov.transform(mat([cx + face * 0.012, g.y, g.z]));
      k.skin(gcov, node, g.hit);
    }
    if (k.detail === 0) {
      k.props(cyl(0.05, 0.05, -0.08, 0.08, 12, COL.steel).transform(new THREE.Matrix4().makeRotationY(Math.PI / 2)).transform(mat([cx, g.y, g.z])), 'steel', node);
    }
    // V struts.
    const apex = v3(side * g.apexX, g.y + 0.02, g.z);
    const f = g.front.clone(); f.x *= side;
    const r = g.rear.clone(); r.x *= side;
    woodStrut(k, f, apex, 0.075, g.strutCol ?? COL.wood, 0.34, g.hit, g.strutRegion ?? 'wood');
    woodStrut(k, r, apex, 0.075, g.strutCol ?? COL.wood, 0.34, g.hit, g.strutRegion ?? 'wood');
    if (k.detail === 0) {
      // Bungee cord wraps where the axle is sprung against the V.
      k.props(torus(0.045, 0.018, 10, 6, rgb('#d8cfb4')).transform(new THREE.Matrix4().makeRotationY(Math.PI / 2)).transform(mat([side * (g.apexX - 0.02), g.y + 0.02, g.z])), 'cloth');
    }
  }
  // Axle.
  k.props(cyl(0.022, 0.022, -g.track / 2 - 0.06, g.track / 2 + 0.06, k.n(8, 4), COL.darkSteel).transform(new THREE.Matrix4().makeRotationY(Math.PI / 2)).transform(mat([0, g.y, g.z])), 'steel', 'static', g.hit);
  // Cross-bracing wires between the front legs.
  const fa = g.front.clone(), fb = g.front.clone(); fb.x = -fb.x;
  rigWire(k, fa, v3(-g.apexX, g.y + 0.04, g.z));
  rigWire(k, fb, v3(g.apexX, g.y + 0.04, g.z));
  if (g.axleWing) {
    const aw = g.axleWing;
    const m = { ribs: [], le: () => -aw.chord * 0.35, te: () => aw.chord * 0.65, leSheet: () => 0 } as unknown as Record<string, unknown>;
    const reg = k.atlas.region(aw.region.name, 'wing', m);
    const spec: PanelSpec = {
      s0: 0, s1: g.track / 2 - 0.08, le: () => -aw.chord * 0.35, te: () => aw.chord * 0.65, tc: 0.14, camber: 0.03,
      top: reg, bot: reg, ds: k.detail === 0 ? 0.2 : 1, nF: k.n(9, 3, 2), nA: k.n(3, 1, 1), tipZone: 0.02,
    };
    const out = buildPanel(spec);
    for (const side of [1, -1]) k.skin(out.main.clone().transform(panelMatrix(v3(0, g.y, g.z), 0, 0.03, side < 0)), 'static', g.hit);
  }
  return v3(g.track / 2, g.y, g.z);
}

/** Sprung ash tail skid on a small steel pyramid. */
export function tailSkid(k: Kit, pivot: V3, shoe: V3, fusWidth: number): void {
  woodStrut(k, pivot, shoe, 0.05, COL.woodDark, 0.5, 'tail');
  k.props(box(0.03, 0.015, 0.12).transform(alongZ(shoe, shoe.clone().add(v3(0, -0.01, 0.1)))), 'steel');
  if (k.detail === 0) {
    for (const s of [1, -1]) k.props(tube([v3(s * fusWidth, pivot.y + 0.02, pivot.z - 0.18), pivot], 0.01, 5, COL.darkSteel), 'steel');
  }
}

// ---------------------------------------------------------------- engines

/**
 * Rotary engine (Clerget 9B / Oberursel UR.II): nine finned cylinders round a
 * crankcase, the whole lot spinning with the propeller. Built in the rotor
 * node so it turns; the cowl stays put around it.
 */
export function rotaryEngine(k: Kit, c: V3, o: { cyl?: number; rHead?: number; node: string; axis: V3 }): void {
  const node = k.node(o.node, c, { axis: o.axis });
  const n = o.cyl ?? 9;
  const rHead = o.rHead ?? 0.4;
  // Crankcase and front plate.
  const cz = c.z;
  k.props(lathe([[0, cz - 0.1], [0.06, cz - 0.1], [0.07, cz - 0.07], [0.15, cz - 0.05], [0.165, cz], [0.16, cz + 0.08], [0.11, cz + 0.13], [0.04, cz + 0.16], [0, cz + 0.16]], k.n(18, 9, 6), { col: COL.oily }).transform(mat([c.x, c.y, 0])), 'cast', node, 'fus');
  if (k.detail > 0) {
    // Far: a dark disc of cylinders is all that shows inside the cowl.
    k.props(cyl(rHead * 0.95, rHead * 0.95, cz - 0.07, cz + 0.07, k.n(18, 12, 8), COL.oily), 'cast', node);
    return;
  }
  const finProf: [number, number][] = [[0, 0.13], [0.062, 0.13], [0.062, 0.16]];
  const fins = 9;
  const top = rHead - 0.07;
  for (let f = 0; f < fins; f++) {
    const z0 = 0.165 + (f * (top - 0.175)) / fins;
    const dz = (top - 0.175) / fins;
    finProf.push([0.06, z0], [0.077, z0 + dz * 0.2], [0.077, z0 + dz * 0.5], [0.06, z0 + dz * 0.7]);
  }
  finProf.push([0.066, top], [0.07, top + 0.02], [0.062, rHead - 0.015], [0.03, rHead], [0, rHead]);
  const barrel = lathe(finProf, 10, { col: COL.oily });
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.17;
    const d = v3(Math.sin(a), Math.cos(a), 0);
    const side = v3(Math.cos(a), -Math.sin(a), 0);
    const m = alongZ(c, c.clone().add(d), v3(0, 0, -1));
    k.props(barrel.clone().transform(m), 'fins', node);
    // Pushrods in front of the cylinder, rocker gear on the head.
    for (const s of [-1, 1]) {
      const p0 = c.clone().addScaledVector(d, 0.16).addScaledVector(side, s * 0.025).add(v3(0, 0, -0.08));
      const p1 = c.clone().addScaledVector(d, rHead - 0.03).addScaledVector(side, s * 0.03).add(v3(0, 0, -0.06));
      k.props(tube([p0, p1], 0.006, 4, COL.steel), 'steel', node);
    }
    const head = c.clone().addScaledVector(d, rHead - 0.01).add(v3(0, 0, -0.035));
    k.props(box(0.09, 0.02, 0.018, COL.steel).transform(new THREE.Matrix4().makeBasis(side, d, v3(0, 0, 1)).setPosition(head)), 'steel', node);
    // Induction pipe from the back of the crankcase to the head.
    const q0 = c.clone().addScaledVector(d, 0.1).add(v3(0, 0, 0.13));
    const q1 = c.clone().addScaledVector(d, 0.22).add(v3(0, 0, 0.12));
    const q2 = c.clone().addScaledVector(d, rHead - 0.06).add(v3(0, 0, 0.05));
    k.props(tube([q0, q1, q2], 0.016, 6, COL.copper), 'steel', node);
    // Spark plug and lead.
    const sp = c.clone().addScaledVector(d, rHead - 0.05).addScaledVector(side, 0.07);
    k.props(cyl(0.009, 0.009, 0, 0.035, 5, COL.white).transform(alongZ(sp, sp.clone().add(side))), 'gloss', node);
  }
}

/** Horseshoe cowl open at the bottom (rotaries). Profile runs inside-rear → lip → outside-rear. */
export function horseshoeCowl(k: Kit, axisY: number, prof: [number, number][], gap: number, rRef: number, lipV: number): void {
  const region = k.atlas.region('cowl', 'cowl', { lip: lipV, rRef, gap });
  const a0 = -Math.PI + gap / 2, a1 = Math.PI - gap / 2;
  const g = lathe(prof, k.n(56, 20, 10), { a0, a1 });
  let L = 0;
  for (let q = 1; q < prof.length; q++) L += Math.hypot(prof[q][0] - prof[q - 1][0], prof[q][1] - prof[q - 1][1]);
  for (let q = 0; q < g.count; q++) {
    g.t[q * 2] = g.t[q * 2] * (a1 - a0) * rRef;
    g.t[q * 2 + 1] = g.t[q * 2 + 1] * L;
  }
  g.inRegion(region).transform(mat([0, axisY, 0]));
  k.skin(g, 'static', 'fus');
}

// ---------------------------------------------------------------- propeller

export interface PropSpec {
  hub: V3;
  R: number;
  blades: number;
  chord: number;
  pitch: number;
  /** Node suffix, 0 for the only / left prop. */
  id: number;
  /** Tractor (default) pulls, pusher sits behind the engine; rotation direction ±1. */
  dir?: 1 | -1;
  bossR?: number;
  /** Spinner: base radius r at hub.z + back (default just behind the boss), pointed tip len ahead of the base. */
  spinner?: { r: number; len: number; back?: number; col?: RGB; livery?: boolean };
  tipBrass?: boolean;
}

/**
 * Laminated wooden propeller. The lamination lines on a real blade are where
 * each board meets the curved blade surface — contour lines of the axial
 * coordinate — so the stripe texture is indexed by exactly that. Blades
 * carry the camber on the forward face, twist with a constant geometric
 * pitch, and have brass sheathing on the tips.
 */
export function propeller(k: Kit, p: PropSpec): void {
  const node = k.node(`prop${p.id}`, p.hub, { axis: v3(0, 0, -1) });
  const dir = p.dir ?? 1;
  const bossR = p.bossR ?? 0.1;
  const zmin = -0.13, zmax = 0.09;
  const bladeAt = (x: number, t: number, back: boolean): V3 => {
    const rh = bossR * 0.8;
    const r = rh + x * (p.R - rh);
    const xn = r / p.R;
    let c = p.chord * (0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, Math.max(0, (xn - 0.1) / 0.75)) * 0.72));
    if (xn > 0.86) c *= Math.sqrt(Math.max(0.0004, 1 - ((xn - 0.86) / 0.14) ** 2));
    const tc = 0.085 + 0.55 * (1 - smooth01((xn - 0.08) / 0.4));
    const beta = Math.atan(p.pitch / (2 * Math.PI * Math.max(r, 0.05)));
    const h = back ? tc * c * 2.6 * Math.sqrt(t) * (1 - t) : 0;
    const a = (0.5 - t) * c;
    const w = -h;
    const ar = a * Math.cos(beta) + w * Math.sin(beta);
    const wr = -a * Math.sin(beta) + w * Math.cos(beta);
    return v3(ar * dir, r, wr);
  };
  const nx = k.n(22, 7, 4), nt = k.n(12, 4, 2);
  if (k.detail === 0) {
    const blade = new Geo();
    const brass = new Geo();
    const eps = 1e-3;
    const rawN = (x: number, t: number, back: boolean): V3 => {
      const dx = bladeAt(Math.min(1, x + eps), t, back).sub(bladeAt(Math.max(0, x - eps), t, back));
      const dt = bladeAt(x, Math.min(1, t + eps), back).sub(bladeAt(x, Math.max(0, t - eps), back));
      return dx.cross(dt).normalize();
    };
    // One sign per surface, taken mid-blade: the cambered back faces forward (-z), the flat face aft.
    const sBack = rawN(0.5, 0.35, true).z < 0 ? 1 : -1;
    const sFace = rawN(0.5, 0.35, false).z > 0 ? 1 : -1;
    const vtx = (g: Geo, x: number, t: number, back: boolean): number => {
      const P = bladeAt(x, t, back);
      const n = rawN(x, t, back).multiplyScalar(back ? sBack : sFace);
      return g.vert(P.x, P.y, P.z, n.x, n.y, n.z, (P.z - zmin) / (zmax - zmin), x, WHITE_);
    };
    for (let i = 0; i < nx; i++) for (let j = 0; j < nt; j++) {
      const x0 = i / nx, x1 = (i + 1) / nx;
      const t0 = (1 - Math.cos((j / nt) * Math.PI)) / 2, t1 = (1 - Math.cos(((j + 1) / nt) * Math.PI)) / 2;
      const xm = (x0 + x1) / 2, tm = (t0 + t1) / 2;
      // Brass on the tip and a strip along the outer leading edge.
      const isBrass = p.tipBrass !== false && k.detail === 0 && (xm > 0.87 || (xm > 0.5 && tm < 0.1));
      const g = isBrass ? brass : blade;
      for (const back of [true, false]) {
        const a = vtx(g, x0, t0, back), b = vtx(g, x1, t0, back), c = vtx(g, x1, t1, back), d = vtx(g, x0, t1, back);
        g.quad(a, b, c, d);
      }
    }
    blade.orient();
    brass.orient();
    for (let b = 0; b < p.blades; b++) {
      const m = new THREE.Matrix4().makeRotationZ((b / p.blades) * Math.PI * 2).setPosition(p.hub);
      k.props(blade.clone().transform(m), 'lam', node);
      if (brass.count) k.props(brass.clone().color(COL.brass).transform(m), 'brass', node);
    }
  }
  // Boss: laminated too; stripes by axial position.
  const boss = cyl(bossR, bossR, zmin + 0.02, zmax - 0.02, k.n(16, 8, 6));
  for (let q = 0; q < boss.count; q++) { boss.t[q * 2] = (boss.p[q * 3 + 2] - zmin) / (zmax - zmin); boss.t[q * 2 + 1] = 0.5; }
  k.props(boss.transform(mat(p.hub)), 'lam', node);
  if (k.detail === 0) {
    for (const z of [zmin + 0.01, zmax - 0.01]) {
      k.props(cyl(bossR * 1.15, bossR * 1.15, z - 0.008, z + 0.008, 16, COL.steel).transform(mat(p.hub)), 'steel', node);
    }
    for (let b = 0; b < 6; b++) {
      const a = (b / 6) * Math.PI * 2;
      k.props(cyl(0.011, 0.011, zmin - 0.012, zmax + 0.012, 6, COL.steel).transform(mat([p.hub.x + Math.cos(a) * bossR * 0.75, p.hub.y + Math.sin(a) * bossR * 0.75, p.hub.z])), 'steel', node);
    }
  }
  if (p.spinner) {
    const sr = p.spinner.r, sl = p.spinner.len;
    const base = p.spinner.back ?? zmin + 0.03;
    const prof: [number, number][] = [];
    const n = k.n(12, 5, 3);
    for (let q = 0; q <= n; q++) {
      // Ogive: pointed tip, full radius at the base.
      const t = q / n;
      prof.push([sr * Math.pow(Math.sin((t * Math.PI) / 2), 0.75), base - sl * (1 - t)]);
    }
    prof.push([sr * 0.97, base + 0.01]);
    const sp = lathe(prof, k.n(24, 12, 8), { col: p.spinner.livery ? WHITE_ : p.spinner.col ?? COL.white }).transform(mat(p.hub));
    // Spinners were a favourite place for unit colours: let the livery paint it.
    if (p.spinner.livery) k.skin(sp.pin(k.atlas.region('spinner', 'swatch'), 0.02, 0.02), node);
    else k.props(sp, 'paint', node);
  }
  // Blurred disc (own node so it can turn independently of the blades).
  const dnode = k.node(`disc${p.id}`, p.hub, { axis: v3(0, 0, -1), flags: { noShadow: true } });
  k.special('disc', disc(p.R, 48).transform(mat([p.hub.x, p.hub.y, p.hub.z - 0.03])), dnode);
}

const WHITE_: RGB = [1, 1, 1];
const smooth01 = (t: number): number => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

// ---------------------------------------------------------------- guns

/** Vickers .303 (Allied) with its louvred jacket; rear of the receiver at `rear`, pointing -Z. Returns the muzzle. */
export function vickers(k: Kit, rear: V3, o: { node?: string; left?: boolean } = {}): V3 {
  const node = o.node ?? 'static';
  const g = (geo: Geo, reg: Parameters<Kit['props']>[1]): void => k.props(geo.transform(mat(rear)), reg, node, 'fus');
  g(box(0.1, 0.135, 0.4, COL.gun).transform(mat([0, 0, -0.2])), 'gun');
  if (k.detail === 0) {
    const out = o.left ? -1 : 1;
    g(box(0.086, 0.012, 0.36, COL.gun).transform(mat([0, 0.073, -0.2])), 'gun'); // top cover
    g(box(0.112, 0.15, 0.02, COL.gun).transform(mat([0, 0, -0.01])), 'gun'); // rear plate
    // Crank handle on the outboard side: the lever the pilot clears stoppages with.
    g(tube([v3(out * 0.056, 0.0, -0.06), v3(out * 0.075, 0.0, -0.06), v3(out * 0.075, -0.07, 0.0)], 0.009, 5, COL.steel), 'steel');
    g(ellipsoid(0.014, 0.014, 0.022, 6, 4, COL.black).transform(mat([out * 0.075, -0.075, 0.01])), 'gloss');
    g(box(0.05, 0.045, 0.07, COL.gun).transform(mat([-out * 0.07, -0.015, -0.3])), 'gun'); // feed block
    // Belt chute curling down into the fuselage.
    g(tube([v3(-out * 0.09, -0.03, -0.3), v3(-out * 0.1, -0.1, -0.29), v3(-out * 0.08, -0.2, -0.26)], 0.02, 4, rgb('#4a3f2c')), 'cloth');
    g(cyl(0.022, 0.022, -0.05, 0.02, 8, COL.brass).transform(new THREE.Matrix4().makeRotationY(Math.PI / 2)).transform(mat([out * 0.05, -0.04, -0.33])), 'brass'); // CC gear trigger motor
    g(cyl(0.016, 0.016, 0, 0.05, 8, COL.gun), 'gun');
  }
  g(cyl(0.043, 0.043, -0.95, -0.4, k.n(14, 6, 4), COL.gun, false).transform(mat([0, 0, 0])), k.detail === 0 ? 'perf' : 'gun');
  g(cyl(0.043, 0.03, -0.99, -0.95, k.n(14, 6, 4), COL.gun), 'gun');
  g(cyl(0.022, 0.028, -1.07, -0.99, k.n(10, 5, 4), COL.gun), 'gun');
  return rear.clone().add(v3(0, 0, -1.08));
}

/** LMG 08/15 "Spandau": round-holed jacket, flash-hider cone. */
export function spandau(k: Kit, rear: V3, o: { node?: string; left?: boolean } = {}): V3 {
  const node = o.node ?? 'static';
  const g = (geo: Geo, reg: Parameters<Kit['props']>[1]): void => k.props(geo.transform(mat(rear)), reg, node, 'fus');
  g(box(0.1, 0.14, 0.44, COL.gun).transform(mat([0, 0, -0.22])), 'gun');
  if (k.detail === 0) {
    g(box(0.02, 0.05, 0.09, COL.steel).transform(mat([(o.left ? -1 : 1) * 0.06, 0.03, -0.08])), 'steel');
    g(box(0.06, 0.05, 0.08, COL.gun).transform(mat([(o.left ? 1 : -1) * 0.075, -0.01, -0.3])), 'gun');
    g(cyl(0.02, 0.02, 0, 0.06, 8, COL.gun), 'gun');
  }
  g(cyl(0.047, 0.047, -0.96, -0.44, k.n(14, 6, 4), COL.gun, false), k.detail === 0 ? 'perf' : 'gun');
  g(cyl(0.047, 0.026, -1.0, -0.96, k.n(14, 6, 4), COL.gun), 'gun');
  g(cyl(0.034, 0.024, -1.08, -1.0, k.n(10, 5, 4), COL.gun), 'gun');
  return rear.clone().add(v3(0, 0, -1.09));
}

/** Lewis gun (observer): finned radiator shroud, pan magazine, spade grip. Built pointing -Z from its pivot, then placed. Returns the muzzle. */
export function lewis(k: Kit, node: string, place: THREE.Matrix4): V3 {
  const g = (geo: Geo, reg: Parameters<Kit['props']>[1]): void => k.props(geo.transform(place), reg, node, 'fus');
  g(box(0.07, 0.1, 0.34, COL.gun).transform(mat([0, 0, 0.04])), 'gun');
  g(cyl(0.056, 0.056, -0.78, -0.14, k.n(18, 8, 4), rgb('#5a5c58')), k.detail === 0 ? 'fins' : 'gun');
  g(cyl(0.056, 0.016, -0.86, -0.78, k.n(14, 8, 4), rgb('#5a5c58')), 'gun');
  g(cyl(0.012, 0.012, -0.95, -0.86, 6, COL.gun), 'gun');
  // Pan magazine on top.
  g(cyl(0.135, 0.135, -0.025, 0.025, k.n(24, 10, 6), COL.gun).transform(new THREE.Matrix4().makeRotationX(Math.PI / 2)).transform(mat([0, 0.075, -0.02])), 'gun');
  if (k.detail === 0) {
    g(cyl(0.03, 0.03, -0.03, 0.03, 10, COL.steel).transform(new THREE.Matrix4().makeRotationX(Math.PI / 2)).transform(mat([0, 0.105, -0.02])), 'steel');
    // Spade grip.
    g(tube([v3(-0.05, -0.08, 0.2), v3(-0.05, 0.02, 0.24), v3(0.05, 0.02, 0.24), v3(0.05, -0.08, 0.2)], 0.012, 6, COL.leather), 'leather');
    g(box(0.02, 0.1, 0.02, COL.steel).transform(mat([0, 0.06, -0.2])), 'steel'); // foresight post
  }
  return v3(0, 0, -0.96).applyMatrix4(place);
}

/** Parabellum MG14 (German observer): slim perforated jacket, drum on the side, stock. */
export function parabellum(k: Kit, node: string, place: THREE.Matrix4): V3 {
  const g = (geo: Geo, reg: Parameters<Kit['props']>[1]): void => k.props(geo.transform(place), reg, node, 'fus');
  g(box(0.07, 0.11, 0.36, COL.gun).transform(mat([0, 0, 0.02])), 'gun');
  g(cyl(0.032, 0.032, -0.82, -0.16, k.n(12, 6, 4), COL.gun, false), k.detail === 0 ? 'perf' : 'gun');
  g(cyl(0.022, 0.016, -0.9, -0.82, 8, COL.gun), 'gun');
  g(cyl(0.11, 0.11, -0.035, 0.035, k.n(20, 8, 6), COL.gun).transform(new THREE.Matrix4().makeRotationY(Math.PI / 2)).transform(mat([-0.09, 0, -0.02])), 'gun');
  g(box(0.045, 0.1, 0.3, COL.woodDark).transform(mat([0, -0.03, 0.34])), 'wood');
  return v3(0, 0, -0.91).applyMatrix4(place);
}

/** Additive star: three crossed quads along the barrel plus a disc facing it. */
export function muzzleFlash(k: Kit, at: V3, name: string, parent?: string, dir: V3 = v3(0, 0, -1)): void {
  const node = k.node(name, at, { parent, flags: { always: !parent, noShadow: true } });
  const g = new Geo();
  const L = 0.75, W = 0.3;
  for (let q = 0; q < 3; q++) {
    const a = (q / 3) * Math.PI;
    const ux = Math.cos(a) * W, uy = Math.sin(a) * W;
    const b = g.count;
    g.vert(-ux, -uy, 0.02, 0, 0, 1, 0, 0.5);
    g.vert(ux, uy, 0.02, 0, 0, 1, 1, 0.5);
    g.vert(ux, uy, -L, 0, 0, 1, 1, 1);
    g.vert(-ux, -uy, -L, 0, 0, 1, 0, 1);
    // Upper half of the star texture, stretched along the barrel.
    g.quad(b, b + 1, b + 2, b + 3);
  }
  const d = disc(W * 1.2, 12).transform(mat([0, 0, -0.06]));
  g.append(d);
  const m = alongZ(v3(), dir.clone().negate());
  g.transform(m).transform(mat(at));
  k.special('flash', g, node);
}

// ---------------------------------------------------------------- crew

export interface FigureSpec {
  /** Eye point, body space. */
  eye: V3;
  node: string;
  parent?: string;
  /** Rotation about Y applied to the figure (π faces aft). */
  yaw?: number;
  coat?: RGB;
  helmet?: RGB;
  scarf?: RGB;
  flags?: { pilot?: boolean };
  /** Separate node for the head (turned by the rig as the pilot looks round). */
  headNode?: string;
}

/**
 * Head and shoulders of an airman: leather helmet with the face left open,
 * goggles on, fur-collared coat, silk scarf wound at the neck (the loose end
 * is a separate animated ribbon). Only the upper third ever shows above the
 * coaming, so the body is kept to a few ellipsoids.
 */
export function figure(k: Kit, f: FigureSpec): { neck: V3 } {
  const node = k.node(f.node, f.eye, { parent: f.parent, flags: f.flags });
  const R = new THREE.Matrix4().makeRotationY(f.yaw ?? 0);
  const T = mat(f.eye).multiply(R);
  const neckPivot = v3(0, -0.12, 0.08).applyMatrix4(T);
  const headNode = f.headNode ? k.node(f.headNode, neckPivot, { parent: f.node, axis: v3(0, 1, 0), flags: f.flags }) : node;
  const put = (g: Geo, reg: Parameters<Kit['props']>[1]): void => k.props(g.transform(T), reg, node, 'fus');
  const putH = (g: Geo, reg: Parameters<Kit['props']>[1]): void => k.props(g.transform(T), reg, headNode, 'fus');
  const coat = f.coat ?? COL.coat, helmet = f.helmet ?? COL.helmet;
  const hs = k.n(18, 8, 5), vs = k.n(12, 6, 4);
  // Head: the eyes sit on the front of it.
  putH(ellipsoid(0.076, 0.098, 0.093, hs, vs, COL.skin).transform(mat([0, 0.012, 0.068])), 'face');
  putH(ellipsoid(0.018, 0.024, 0.02, 6, 4, COL.skin).transform(mat([0, -0.025, -0.022])), 'face'); // nose
  // Helmet: crown, then back and sides with the face cut out.
  putH(ellipsoid(0.084, 0.106, 0.101, hs, k.n(6, 3, 2), helmet, { t0: 0, t1: 1.1 }).transform(mat([0, 0.014, 0.068])), 'leather');
  putH(ellipsoid(0.084, 0.106, 0.101, hs, k.n(8, 4, 2), helmet, { t0: 1.1, t1: 2.25, p0: -Math.PI + 0.8, p1: Math.PI - 0.8 }).transform(mat([0, 0.014, 0.068])), 'leather');
  // Neck, collar, scarf wrap, coat.
  // Neck wound in the scarf: from behind a bare neck looks wrong.
  put(cyl(0.056, 0.06, -0.1, 0.06, hs, f.scarf ?? COL.silk, false).transform(new THREE.Matrix4().makeRotationX(Math.PI / 2)).transform(mat([0, -0.11, 0.085])), 'silk');
  put(torus(0.07, 0.03, hs, 8, f.scarf ?? COL.silk).transform(new THREE.Matrix4().makeRotationX(Math.PI / 2)).transform(mat([0, -0.15, 0.08])), 'silk');
  put(torus(0.1, 0.045, hs, 8, COL.fur).transform(new THREE.Matrix4().makeRotationX(Math.PI / 2)).transform(mat([0, -0.2, 0.09])), 'fur');
  put(ellipsoid(0.215, 0.3, 0.14, hs, vs, coat).transform(mat([0, -0.46, 0.11])), 'leather');
  put(ellipsoid(0.24, 0.1, 0.13, hs, vs, coat).transform(mat([0, -0.28, 0.1])), 'leather');
  for (const s of [-1, 1]) {
    put(ellipsoid(0.065, 0.16, 0.07, 10, 6, coat).transform(mat([s * 0.2, -0.43, 0.04], [0.5, 0, s * 0.1])), 'leather');
  }
  if (k.detail === 0) {
    // Goggles: brass-rimmed cups, dark lenses, a strap round the helmet.
    for (const s of [-1, 1]) {
      putH(cyl(0.027, 0.025, -0.022, 0.0, 12, COL.brass, false).transform(mat([s * 0.034, 0.004, -0.004])), 'brass');
      putH(disc(0.024, 12, COL.lens, true).transform(mat([s * 0.034, 0.004, -0.024])), 'lens');
    }
    putH(box(0.02, 0.008, 0.01, COL.brass).transform(mat([0, 0.004, -0.02])), 'brass');
    putH(torus(0.087, 0.009, 20, 5, COL.leatherBlack).transform(new THREE.Matrix4().makeRotationX(Math.PI / 2)).transform(mat([0, 0.004, 0.07])), 'leather');
    // Chin strap: the lower half of a ring round the jaw.
    putH(torus(0.078, 0.006, 14, 4, helmet, Math.PI * 0.6, Math.PI * 1.4).transform(mat([0, 0.0, 0.035])), 'leather');
  }
  return { neck: v3(0, -0.15, 0.13).applyMatrix4(R).add(f.eye) };
}

// ---------------------------------------------------------------- cockpit

export function coaming(k: Kit, path: V3[], r = 0.024): void {
  k.props(tube(path, r, k.n(8, 4, 3), COL.leatherBlack), 'leather', 'static', 'fus');
}

export function windscreen(k: Kit, c: V3, w: number, h: number, tilt: number): void {
  if (k.detail > 0) return;
  const m = mat(c, [-tilt, 0, 0]);
  const shape: [number, number][] = [[-w / 2, 0], [w / 2, 0], [w / 2 * 0.85, h], [-w / 2 * 0.85, h]];
  k.glass(plate(shape, 0.004).transform(m));
  const frame = [v3(-w / 2, 0, 0), v3(-w / 2 * 0.85, h, 0), v3(w / 2 * 0.85, h, 0), v3(w / 2, 0, 0)].map((p) => p.applyMatrix4(m));
  k.props(tube(frame, 0.004, 5, COL.black), 'paint');
}

/** Aldis telescopic sight between `a` (rear) and `b` (front). */
export function aldis(k: Kit, a: V3, b: V3): void {
  if (k.detail > 0) return;
  const m = alongZ(b, a);
  const len = a.distanceTo(b);
  k.props(cyl(0.024, 0.024, 0, len, 14, COL.black).transform(m), 'paint');
  k.props(cyl(0.03, 0.03, len - 0.05, len + 0.01, 14, COL.rubber).transform(m), 'rubber');
  k.props(cyl(0.029, 0.029, -0.01, 0.03, 14, COL.black).transform(m), 'paint');
  k.glass(disc(0.022, 12).transform(m));
  for (const t of [0.25, 0.75]) {
    const p = a.clone().lerp(b, t);
    k.props(box(0.02, 0.05, 0.02, COL.black).transform(mat([p.x, p.y - 0.035, p.z])), 'paint');
  }
}

/** Ring-and-bead sight: ring at `ring`, bead post `bead`. */
export function ringSight(k: Kit, ring: V3, bead: V3, r = 0.055): void {
  if (k.detail > 0) return;
  k.props(torus(r, 0.0035, 20, 4, COL.black).transform(mat(ring)), 'paint');
  k.props(tube([v3(-r, 0, 0), v3(r, 0, 0)], 0.002, 3, COL.black).transform(mat(ring)), 'paint');
  k.props(tube([v3(0, -r, 0), v3(0, r, 0)], 0.002, 3, COL.black).transform(mat(ring)), 'paint');
  k.props(cyl(0.004, 0.004, 0, 0.09, 4, COL.black).transform(new THREE.Matrix4().makeRotationX(Math.PI / 2)).transform(mat([ring.x, ring.y - r - 0.09, ring.z])), 'paint');
  k.props(ellipsoid(0.008, 0.008, 0.008, 6, 4, COL.brass).transform(mat(bead)), 'brass');
  k.props(cyl(0.003, 0.003, 0, 0.06, 4, COL.black).transform(new THREE.Matrix4().makeRotationX(Math.PI / 2)).transform(mat([bead.x, bead.y - 0.066, bead.z])), 'paint');
}

export interface BoardDial {
  dial: keyof typeof DIAL;
  x: number;
  y: number;
  r: number;
}

/**
 * Instrument board: varnished plywood cut to the fuselage section at z, with
 * bezelled, glazed dials. Only exists in the cockpit node.
 */
export function instrumentBoard(k: Kit, fus: Fuselage, z: number, yBottom: number, yTop: number, dials: BoardDial[], node = 'cockpit'): void {
  if (k.detail > 0) return;
  // Cut to the inside of the fuselage section, clipped below the gun breeches.
  const d = fus.dense(z, 48).filter(([, y]) => y > yBottom);
  const shape: [number, number][] = d.map(([x, y]) => [x * 0.96, Math.min(yTop, y - 0.012)]);
  const left = [...shape].reverse().map(([x, y]) => [-x, y] as [number, number]);
  const outline = [...shape, [shape[shape.length - 1][0], yBottom] as [number, number], [-shape[shape.length - 1][0], yBottom] as [number, number], ...left.slice(0, -1)];
  const g = plate(outline.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-4), 0.012, COL.wood);
  // Planar uvs across the board for the plywood grain.
  for (let q = 0; q < g.count; q++) { g.t[q * 2] = 0.5 + g.p[q * 3] * 0.45; g.t[q * 2 + 1] = 0.5 + g.p[q * 3 + 1] * 0.45; }
  k.props(g.transform(mat([0, 0, z])), 'ply', node);
  for (const dl of dials) {
    // The pilot is aft (+Z): dials stand proud of the board's rear face.
    const zf = z + 0.008;
    const face = disc(dl.r, 24).transform(mat([dl.x, dl.y, zf]));
    // disc() faces +Z already (toward the pilot); uv 0..1 across.
    k.props(face, dialRect(DIAL[dl.dial]), node);
    k.props(torus(dl.r, dl.r * 0.12, 24, 6, COL.brass).transform(mat([dl.x, dl.y, zf])), 'brass', node);
    k.glass(disc(dl.r * 0.98, 20).transform(mat([dl.x, dl.y, zf + dl.r * 0.1])), node);
  }
  // Magneto switches and a fuel tap: little brass things the eye expects.
  for (let q = 0; q < 2; q++) {
    k.props(box(0.03, 0.04, 0.02, COL.black).transform(mat([-0.2 + q * 0.05, yBottom + 0.05, z + 0.016])), 'paint', node);
    k.props(cyl(0.004, 0.004, 0, 0.03, 5, COL.brass).transform(mat([-0.2 + q * 0.05, yBottom + 0.06, z + 0.026])), 'brass', node);
  }
}

/** Control column with a spade grip and gun triggers. */
export function controlColumn(k: Kit, base: V3, grip: V3, node = 'cockpit'): void {
  if (k.detail > 0) return;
  k.props(tube([base, grip], 0.016, 8, COL.steel), 'steel', node);
  const m = alongZ(grip, grip.clone().add(v3(0, 1, 0)), v3(0, 0, -1));
  // Spade grip: a loop of leather-bound tube across the top.
  const loop = [v3(-0.07, 0, 0), v3(-0.075, 0, 0.06), v3(-0.04, 0, 0.1), v3(0.04, 0, 0.1), v3(0.075, 0, 0.06), v3(0.07, 0, 0)];
  k.props(tube(loop.map((p) => p.applyMatrix4(m)), 0.014, 6, COL.leatherBlack), 'leather', node);
  k.props(tube([v3(-0.07, 0, 0), v3(0.07, 0, 0)].map((p) => p.applyMatrix4(m)), 0.012, 6, COL.steel), 'steel', node);
  k.props(box(0.03, 0.012, 0.03, COL.brass).transform(mat(grip.clone().add(v3(0, 0.08, -0.02)))), 'brass', node);
}

/** Throttle and mixture levers on the port side. */
export function throttleBox(k: Kit, p: V3, node = 'cockpit'): void {
  if (k.detail > 0) return;
  k.props(box(0.05, 0.05, 0.18, COL.black).transform(mat(p)), 'paint', node);
  for (const dz of [-0.03, 0.03]) k.props(tube([p.clone().add(v3(0, 0.02, dz)), p.clone().add(v3(0.02, 0.13, dz - 0.05))], 0.006, 5, COL.steel), 'steel', node);
  for (const dz of [-0.03, 0.03]) k.props(ellipsoid(0.014, 0.014, 0.014, 6, 4, COL.black).transform(mat(p.clone().add(v3(0.02, 0.135, dz - 0.05)))), 'gloss', node);
}

export function exhaustPipe(k: Kit, path: V3[], r: number, col: RGB = rgb('#4a3a30')): void {
  k.props(tube(path, r, k.n(10, 5, 4), col, true), 'cast', 'static', 'fus');
}

/** Flat honeycomb radiator block, face toward -Z (or the given direction). */
export function radiator(k: Kit, c: V3, w: number, h: number, d: number, face: V3 = v3(0, 0, -1), frame: RGB = COL.black): void {
  const m = alongZ(c, c.clone().add(face.clone().negate()));
  k.props(box(w, h, d, frame).transform(new THREE.Matrix4().makeTranslation(0, 0, d / 2)).transform(m), 'paint', 'static', 'fus');
  const core = plate([[-w / 2 + 0.02, -h / 2 + 0.02], [w / 2 - 0.02, -h / 2 + 0.02], [w / 2 - 0.02, h / 2 - 0.02], [-w / 2 + 0.02, h / 2 - 0.02]], 0.004, COL.white);
  for (let q = 0; q < core.count; q++) { core.t[q * 2] = (core.p[q * 3] + w / 2) / w; core.t[q * 2 + 1] = (core.p[q * 3 + 1] + h / 2) / h; }
  k.props(core.color(rgb('#8c7550')).transform(new THREE.Matrix4().makeTranslation(0, 0, -0.003)).transform(m), 'radiator', 'static', 'fus');
}

export { PR };

export interface RingSpec {
  /** Ring centre (on the coaming), body space. */
  centre: V3;
  R: number;
  gun: 'lewis' | 'parabellum';
  /** Node names; the rest pose faces the tail unless `forward`. */
  yaw: string;
  pitch: string;
  flash: string;
  forward?: boolean;
  /** Observer's eye height above the ring. */
  eyeUp?: number;
  coat?: RGB;
}

/**
 * Scarff-style gun ring: the ring is fixed to the coaming, the carriage, arch,
 * gun and gunner all turn with it (yaw node), and the gun elevates on its own
 * pivot (pitch node). The gunner is a figure facing along the gun.
 * Returns the gun pivot (where rounds leave from) and the muzzle.
 */
export function gunRing(k: Kit, o: RingSpec): { pivot: V3; muzzle: V3 } {
  const c = o.centre;
  k.props(torus(o.R, 0.024, k.n(40, 16, 8), k.n(8, 4, 3), COL.woodDark).transform(new THREE.Matrix4().makeRotationX(Math.PI / 2)).transform(mat(c)), 'wood', 'static', 'fus');
  const fwd = o.forward ? -1 : 1; // +1: rest pose points aft (+Z)
  const yaw = k.node(o.yaw, c, { axis: v3(0, 1, 0) });
  const pivot = c.clone().add(v3(0, 0.36, fwd * o.R * 0.55));
  const pitch = k.node(o.pitch, pivot, { parent: yaw, axis: v3(1, 0, 0) });
  // Carriage on the ring and the arch up to the gun pivot.
  const foot = c.clone().add(v3(0, 0.02, fwd * o.R));
  k.props(box(0.14, 0.05, 0.08, COL.darkSteel).transform(mat(foot)), 'steel', yaw);
  if (k.detail === 0) {
    const arch = [foot.clone().add(v3(-0.06, 0.02, 0)), pivot.clone().add(v3(-0.05, -0.02, 0))];
    const arch2 = [foot.clone().add(v3(0.06, 0.02, 0)), pivot.clone().add(v3(0.05, -0.02, 0))];
    k.props(tube(arch, 0.012, 5, COL.darkSteel), 'steel', yaw);
    k.props(tube(arch2, 0.012, 5, COL.darkSteel), 'steel', yaw);
  }
  // The gun, built pointing -Z and turned to the rest direction.
  const place = mat(pivot).multiply(o.forward ? new THREE.Matrix4() : new THREE.Matrix4().makeRotationY(Math.PI));
  const muzzle = o.gun === 'lewis' ? lewis(k, pitch, place) : parabellum(k, pitch, place);
  muzzleFlash(k, muzzle, o.flash, pitch, v3(0, 0, fwd));
  figure(k, {
    eye: c.clone().add(v3(0, o.eyeUp ?? 0.5, -fwd * 0.12)), node: `${o.yaw}Crew`, parent: yaw,
    yaw: o.forward ? 0 : Math.PI, coat: o.coat,
  });
  return { pivot, muzzle };
}
