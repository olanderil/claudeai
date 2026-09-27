import * as THREE from 'three';
import { box, cyl, mat, rgb, tube, v3, type V3 } from '../geo';
import type { Kit } from '../kit';
import { buildFuselage, Fuselage, type FusKey } from '../fuselage';
import {
  COL, coaming, controlColumn, exhaustPipe, figure, fitting, instrumentBoard, landingGear, muzzleFlash,
  propeller, radiator, rigWire, ringSight, spandau, tailSkid, tailSurface, throttleBox, windscreen, wingPair, woodStrut,
} from '../parts';
import { axleY, groundY, type Design, type DesignMeta } from '../design';
import {
  C, Painter, crossPattee, lozenge, mud, smudge, soot, streaks, text, type FusMeta,
} from '../livery';
import { rng } from '../atlas';
import { roundedEdge } from '../panel';

/**
 * Albatros D.V — the "shark": an oval plywood semi-monocoque with a big
 * spinner, the Mercedes D.IIIa's six cylinder heads standing proud of the
 * nose, a radiator let into the top wing (offset to starboard) and the
 * exhaust manifold climbing the right side. Sesquiplane: the narrow lower
 * wing is braced by V-struts. Printed lozenge fabric on the wings.
 */

const GEAR = 1.5;
const U_LE = -0.58, L_LE = U_LE + 0.4;
const U_C = 1.7, L_C = 1.0;
const U_HALF = 4.52, L_HALF = 4.35;
const U_Y = 1.04, L_Y = -0.48;

const KEYS: FusKey[] = [
  { z: -2.32, w: 0.28, top: 0.3, bot: -0.28, sh: 0.0, nt: 2, nb: 2 },
  { z: -1.9, w: 0.36, top: 0.38, bot: -0.4, sh: 0.0, nt: 2.1, nb: 2.1 },
  { z: -1.1, w: 0.415, top: 0.44, bot: -0.5, sh: -0.02, nt: 2.1, nb: 2.3 },
  { z: -0.2, w: 0.42, top: 0.45, bot: -0.53, sh: -0.03, nt: 2.1, nb: 2.4 },
  { z: 0.6, w: 0.4, top: 0.44, bot: -0.51, sh: -0.03, nt: 2.1, nb: 2.4 },
  { z: 1.6, w: 0.33, top: 0.38, bot: -0.43, sh: -0.03, nt: 2.05, nb: 2.3 },
  { z: 2.9, w: 0.19, top: 0.3, bot: -0.31, sh: -0.02, nt: 2, nb: 2.2 },
  { z: 3.8, w: 0.06, top: 0.23, bot: -0.2, sh: 0.0, nt: 2, nb: 2.2 },
  { z: 4.25, w: 0.012, top: 0.2, bot: -0.16, sh: 0.02, nt: 2, nb: 2.2 },
];
const FUS = new Fuselage(KEYS);
const COCKPIT = { z0: 0.1, z1: 0.8, hw: 0.29 };
const EYE = v3(0, 0.82, 0.52);
const RIBS = Array.from({ length: 16 }, (_, i) => 0.05 + i * 0.3);

/** Mercedes D.IIIa: six separate steel cylinders in line, overhead cam, heads above the decking. */
function inlineSix(k: Kit, z0: number, z1: number, yBase: number, yTop: number, exhaustSide: 1 | -1): V3[] {
  const ports: V3[] = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const z = z0 + ((z1 - z0) * (i + 0.5)) / n;
    const g = cyl(0.068, 0.068, 0, yTop - yBase - 0.05, k.n(14, 7, 5), rgb('#5c5a54')).transform(new THREE.Matrix4().makeRotationX(-Math.PI / 2)).transform(mat([0, yBase, z]));
    k.props(g, 'steel', 'static', 'fus');
    if (k.detail === 0) {
      // Welded water jacket bands and the valve cage on top.
      for (const f of [0.35, 0.65]) k.props(cyl(0.074, 0.074, -0.008, 0.008, 14, COL.darkSteel).transform(new THREE.Matrix4().makeRotationX(-Math.PI / 2)).transform(mat([0, yBase + (yTop - yBase) * f, z])), 'steel');
      k.props(box(0.1, 0.05, 0.12, COL.darkSteel).transform(mat([0, yTop - 0.03, z])), 'cast');
      k.props(cyl(0.008, 0.008, 0, 0.035, 6, rgb('#b8b2a4')).transform(new THREE.Matrix4().makeRotationZ(exhaustSide * -Math.PI / 2)).transform(mat([exhaustSide * -0.07, yTop - 0.08, z + 0.03])), 'gloss');
    }
    ports.push(v3(exhaustSide * 0.07, yTop - 0.1, z));
  }
  // Camshaft housing along the top, vertical drive at the rear.
  k.props(box(0.07, 0.06, z1 - z0 + 0.06, COL.castIron).transform(mat([0, yTop + 0.02, (z0 + z1) / 2])), 'cast', 'static', 'fus');
  if (k.detail === 0) k.props(cyl(0.025, 0.025, 0, yTop - yBase, 8, COL.castIron).transform(new THREE.Matrix4().makeRotationX(-Math.PI / 2)).transform(mat([0, yBase, z1 + 0.06])), 'cast');
  // Induction manifold on the left.
  if (k.detail === 0) k.props(tube([v3(-exhaustSide * 0.08, yTop - 0.12, z0 + 0.1), v3(-exhaustSide * 0.1, yTop - 0.14, (z0 + z1) / 2), v3(-exhaustSide * 0.08, yTop - 0.12, z1 - 0.1)], 0.028, 8, COL.alu), 'alu');
  return ports;
}

export const albatros: Design = {
  id: 'albatros',
  liveries: ['standard', 'jasta', 'red'],

  build(k: Kit): DesignMeta {
    const at = k.atlas;
    const fm = (side: 'R' | 'L'): Record<string, unknown> => ({ fus: FUS, side, fabricFrom: 99, ply: true, panelSeams: [], formers: [-1.6, -1.0, -0.4, 0.2, 0.9, 1.6, 2.3, 3.0, 3.7] } satisfies FusMeta as unknown as Record<string, unknown>);
    const f = buildFuselage(FUS, { keys: KEYS, openings: [COCKPIT], right: at.region('fus_R', 'fus', fm('R')), left: at.region('fus_L', 'fus', fm('L')), dz: k.n(0.07, 0.3, 0.9), m: k.n(20, 8, 4) }, COL.interior);
    k.skin(f.outer, 'static', 'fus');
    if (k.detail === 0) {
      for (const t of f.tubs) k.props(t, 'interior');
      for (const r of f.rims) coaming(k, r);
    }

    // ---- engine standing proud of the nose, exhaust manifold up the right side
    const ports = inlineSix(k, -2.0, -1.05, 0.28, 0.62, 1);
    const manifold = [v3(0.12, 0.52, -2.0), v3(0.2, 0.5, -1.5), v3(0.22, 0.52, -1.0), v3(0.25, 0.62, -0.75), v3(0.28, 0.9, -0.6)];
    exhaustPipe(k, manifold, 0.045, rgb('#4d3b2e'));
    if (k.detail === 0) for (const pt of ports) exhaustPipe(k, [pt, v3(0.17, pt.y - 0.02, pt.z)], 0.022, rgb('#4d3b2e'));

    // ---- wings
    const rakedTE = (te0: number, s1: number, rake: number) => (s: number): number => {
      const sr = s1 - rake;
      return s <= sr ? te0 : te0 - (s - sr) * (te0 - 0.35) / rake;
    };
    const upper = wingPair(k, {
      name: 'U', origin: v3(0, U_Y, U_LE), dihedral: 0, incidence: 0.03, s0: 0, s1: U_HALF,
      le: roundedEdge(0, U_HALF, 0.18, -1), te: (s) => Math.min(rakedTE(U_C, U_HALF, 0.55)(s), roundedEdge(U_C, U_HALF, 0.5, 1)(s)),
      tc: 0.06, camber: 0.045, ribs: RIBS, scallop: 0.012,
      aileron: { s0: 2.8, s1: U_HALF, x: () => U_C - 0.42 }, leSheet: 0.12, hit: 'wingU', tipZone: 0.6,
    });
    const lower = wingPair(k, {
      name: 'L', origin: v3(0, L_Y, L_LE), dihedral: 0.03, incidence: 0.02, s0: 0.3, s1: L_HALF,
      le: roundedEdge(0, L_HALF, 0.3, -1, 0.02), te: (s) => roundedEdge(L_C, L_HALF, 0.35, 1)(s) - 0.12 * Math.max(0, (s - 1) / (L_HALF - 1)),
      tc: 0.065, camber: 0.04, ribs: RIBS, scallop: 0.009, capRoot: true, leSheet: 0.12, hit: 'wingL', tipZone: 0.45,
    });
    // Wing radiator in the upper centre section, offset to starboard.
    radiator(k, v3(0.42, U_Y + 0.075, U_LE + 0.5), 0.5, 0.42, 0.05, v3(0, 1, 0));
    if (k.detail === 0) {
      for (const x of [0.3, 0.52]) k.props(tube([v3(x, U_Y - 0.02, U_LE + 0.4), v3(x * 0.4, 0.62, -1.2)], 0.02, 6, COL.darkSteel), 'steel');
    }
    // V interplane struts: both spars of the top wing to the single spar of the bottom.
    const SI = 2.9;
    for (const side of [1, -1] as const) {
      const foot = lower.at(SI, 0.35, true, side);
      for (const x of [0.25, 1.15]) {
        const a = upper.at(SI, x, false, side);
        woodStrut(k, foot, a, 0.085, COL.wood, 0.3, undefined);
        fitting(k, a);
      }
      fitting(k, foot);
      // Cabane N-struts.
      const cf = upper.at(0.34, 0.25, false, side), cr = upper.at(0.34, 1.15, false, side);
      woodStrut(k, v3(side * 0.32, 0.36, -0.7), cf, 0.055, rgb('#2d2c28'), 0.4, 'fus', 'paint');
      woodStrut(k, v3(side * 0.32, 0.36, -0.7), cr, 0.055, rgb('#2d2c28'), 0.4, 'fus', 'paint');
      rigWire(k, lower.at(0.45, 0.35, true, side), upper.at(SI - 0.05, 0.25, false, side), true);
      rigWire(k, lower.at(0.45, 0.35, true, side), upper.at(SI - 0.05, 1.15, false, side), true);
      rigWire(k, upper.at(0.35, 0.3, false, side), foot, false);
    }

    // ---- tail: rounded "fishtail" tailplane, fin, rudder, ventral fin
    tailSurface(k, {
      name: 'TP', origin: v3(0, 0.12, 0), s0: 0, s1: 1.45, hit: 'tail',
      le: (s) => 3.24 + 0.5 * (1 - Math.sqrt(Math.max(0, 1 - (s / 1.45) ** 2.2))),
      te: (s) => 4.49 - 0.35 * (s / 1.45) ** 2 - (s < 0.22 ? (1 - s / 0.22) * 0.5 : 0) - (s > 1.2 ? 0.5 * (1 - Math.sqrt(Math.max(0, 1 - ((s - 1.2) / 0.25) ** 2))) : 0),
      ribs: [0.2, 0.45, 0.7, 0.95, 1.2], hinge: { x: () => 4.01, s0: 0.03, s1: 1.45 },
    });
    tailSurface(k, {
      name: 'fin', origin: v3(0, 0.2, 0), s0: 0, s1: 0.62, vertical: true, hit: 'tail',
      le: (s) => 3.45 + 0.72 * Math.pow(s / 0.62, 0.7), te: () => 4.25, ribs: [0.2, 0.4],
    });
    tailSurface(k, {
      name: 'vfin', origin: v3(0, -0.46, 0), s0: 0, s1: 0.3, vertical: true, hit: 'tail',
      le: (s) => 4.25 - 0.55 * (s / 0.3) ** 0.6 * (1 - s / 0.3) - 0.02, te: () => 4.25, ribs: [],
    });
    tailSurface(k, {
      name: 'rud', origin: v3(0, -0.3, 0), s0: 0, s1: 1.18, vertical: true, moving: true, hit: 'tail',
      le: () => 4.25, te: (s) => 4.25 + 0.47 * Math.sqrt(Math.max(0, 1 - ((s - 0.5) / (s < 0.5 ? 0.5 : 0.68)) ** 2)),
      ribs: [0.3, 0.6, 0.9], hinge: { x: () => 4.25, s0: 0, s1: 1.18 },
    });

    // ---- undercarriage
    const az = -0.95, r = 0.38;
    landingGear(k, {
      track: 1.7, y: axleY(az, GEAR, r), z: az, r, tyre: 0.045,
      front: v3(0.28, -0.48, -1.35), rear: v3(0.3, -0.52, -0.45), apexX: 0.66, hit: 'gear',
      strutCol: rgb('#2d2c28'), strutRegion: 'paint',
    });
    tailSkid(k, v3(0, -0.3, 3.5), v3(0, groundY(4.1, GEAR) + 0.01, 4.1), 0.12);

    // ---- propeller with the big spinner
    propeller(k, { hub: v3(0, 0.0, -2.4), R: 1.4, blades: 2, chord: 0.21, pitch: 2.7, id: 0, spinner: { r: 0.285, len: 0.44, back: 0.08, livery: true } });

    // ---- guns, sights
    const muzzles: THREE.Vector3[] = [];
    for (const side of [-1, 1] as const) muzzles.push(spandau(k, v3(side * 0.11, 0.56, 0.05), { left: side < 0 }));
    muzzles.forEach((m, i) => muzzleFlash(k, m, `flash${i}`));
    ringSight(k, v3(0, EYE.y, -0.2), v3(0, EYE.y - 0.02, -0.9), 0.055);
    windscreen(k, v3(0, 0.5, 0.12), 0.32, 0.14, 0.55);

    k.node('cockpit', EYE, { flags: { cockpit: true } });
    instrumentBoard(k, FUS, 0.06, -0.08, 0.46, [
      { dial: 'rpm', x: 0, y: 0.26, r: 0.048 },
      { dial: 'alt', x: -0.15, y: 0.22, r: 0.04 },
      { dial: 'clock', x: 0.15, y: 0.22, r: 0.035 },
      { dial: 'oil', x: -0.25, y: 0.1, r: 0.03 },
      { dial: 'air', x: 0.25, y: 0.1, r: 0.03 },
      { dial: 'level', x: 0, y: 0.12, r: 0.03 },
    ]);
    controlColumn(k, v3(0, -0.5, 0.42), v3(0, 0.12, 0.32));
    throttleBox(k, v3(-0.34, 0.15, 0.5));

    const pilot = figure(k, { eye: EYE, node: 'pilot', headNode: 'head', flags: { pilot: true }, coat: rgb('#2f2a22') });
    return {
      eye: EYE.clone(), muzzles, gunnerMount: null,
      exhausts: [manifold[manifold.length - 1].clone()],
      engines: [v3(0, 0.2, -1.5)],
      spinners: [{ node: 'prop0', kind: 'prop', dir: 1 }, { node: 'disc0', kind: 'disc', dir: 1 }],
      scarf: { node: 'pilot', anchor: pilot.neck, color: COL.silk },
      deflect: { elevator: 0.42, aileron: 0.3, rudder: 0.45 },
      gunner: null, flashes: muzzles.map((_, i) => `flash${i}`),
    };
  },

  paint(p: Painter, livery: string): void {
    // Five-colour printed lozenge: dark, muted tones above, pale ones below.
    const upperLoz = ['#3a3f4a', '#4f4652', '#3d4637', '#6b6146', '#2d2e31'];
    const lowerLoz = ['#b59c95', '#8e9ea6', '#b1a483', '#929f89', '#a39aa6'];
    lozenge(p, 'U_top', upperLoz, 101, { cell: 0.17 });
    lozenge(p, 'L_top', upperLoz, 102, { cell: 0.17 });
    lozenge(p, 'U_bot', lowerLoz, 103, { cell: 0.17 });
    lozenge(p, 'L_bot', lowerLoz, 104, { cell: 0.17 });
    lozenge(p, 'TP_top', upperLoz, 105, { cell: 0.17 });
    lozenge(p, 'TP_bot', lowerLoz, 106, { cell: 0.17 });
    // Rib tapes were cut from the same fabric in a paler print; a light line reads right.
    for (const n of ['U_top', 'L_top', 'U_bot', 'L_bot']) {
      p.on(n, (ctx, r) => {
        ctx.fillStyle = n.endsWith('top') ? 'rgba(170,160,135,0.14)' : 'rgba(240,230,220,0.14)';
        for (const s of RIBS) ctx.fillRect(s - 0.017, r.v0 - 1, 0.034, 5);
      });
      p.grime(n, 0.14);
    }
    // Varnished plywood fuselage: grain along the length, darker panel joints.
    const ply = (name: string, base: string, seed: number): void => {
      const r = p.region(name);
      if (!r) return;
      const R = rng(seed);
      p.on(r, (ctx) => {
        ctx.fillStyle = base;
        ctx.fillRect(r.u0 - 1, r.v0 - 1, r.u1 - r.u0 + 2, r.v1 - r.v0 + 2);
        for (let q = 0; q < 1800; q++) {
          const y = r.v0 + R() * (r.v1 - r.v0), x = r.u0 + R() * (r.u1 - r.u0);
          const l = 0.3 + R() * 1.4;
          ctx.fillStyle = R() < 0.5 ? `rgba(90,50,20,${0.05 + R() * 0.12})` : `rgba(230,170,100,${0.05 + R() * 0.1})`;
          ctx.fillRect(x, y, l, 0.002 + R() * 0.006);
        }
      });
    };
    const fusAt = (side: 'R' | 'L', z: number, y: number): [number, number] => [side === 'R' ? FUS.z1 - z : z - FUS.z0, FUS.arcAt(z, y)];
    for (const side of ['R', 'L'] as const) {
      const name = `fus_${side}`;
      if (livery === 'red') p.fill(name, C.red); else ply(name, '#a26a35', 70 + (side === 'R' ? 1 : 2));
      p.on(name, (ctx) => {
        // Panel joints where the ply sheets meet over the formers.
        ctx.fillStyle = 'rgba(60,35,15,0.4)';
        for (const z of [-1.6, -1.0, -0.4, 0.2, 0.9, 1.6, 2.3, 3.0, 3.7]) { const [u] = fusAt(side, z, 0); ctx.fillRect(u - 0.003, -1, 0.006, 4); }
        // Engine bay: grey-painted metal side panels round the cylinders, ply below.
        const [a] = fusAt(side, -2.35, 0), [b] = fusAt(side, -1.0, 0);
        ctx.fillStyle = livery === 'red' ? '#8a1c1a' : '#5f605a';
        const [, vTop] = fusAt(side, -1.5, 0.3), [, vBot] = fusAt(side, -1.5, -0.12);
        ctx.fillRect(Math.min(a, b), vTop, Math.abs(b - a), vBot - vTop);
        ctx.fillStyle = 'rgba(20,20,18,0.5)';
        for (const z of [-2.0, -1.55]) { const [u] = fusAt(side, z, 0); ctx.fillRect(u - 0.003, vTop, 0.006, vBot - vTop); }
        for (let z = -2.3; z < -1.0; z += 0.07) { const [u] = fusAt(side, z, 0); ctx.beginPath(); ctx.arc(u, vTop + 0.015, 0.004, 0, Math.PI * 2); ctx.arc(u, vBot - 0.015, 0.004, 0, Math.PI * 2); ctx.fill(); }
      });
      p.surface(name, livery === 'red' ? 0.45 : 0.32, 0);
    }
    for (const n of ['fin_L', 'fin_R', 'vfin_L', 'vfin_R']) { if (livery === 'red') p.fill(n, C.red); else ply(n, '#a26a35', 80); }
    for (const n of ['rud_L', 'rud_R']) p.fill(n, livery === 'red' ? C.red : '#e4dfcf');
    p.fill('wheel', '#6d6a5e');
    if (livery === 'jasta') {
      // Black tail aft of the band, a yellow band and a personal comet.
      for (const side of ['R', 'L'] as const) p.on(`fus_${side}`, (ctx) => {
        const [u0] = fusAt(side, 1.7, 0), [u1] = fusAt(side, 4.4, 0);
        ctx.fillStyle = C.black; ctx.fillRect(Math.min(u0, u1), -1, Math.abs(u1 - u0), 4);
        const [b0] = fusAt(side, 1.45, 0);
        ctx.fillStyle = C.yellow; ctx.fillRect(b0 - 0.13, -1, 0.26, 4);
        const [cx, cy] = fusAt(side, 0.95, 0.02);
        ctx.save(); ctx.translate(cx, cy); if (side === 'L') ctx.scale(-1, 1);
        ctx.fillStyle = C.white;
        ctx.beginPath(); ctx.moveTo(0.15, 0); ctx.lineTo(-0.45, -0.1); ctx.lineTo(-0.3, 0); ctx.lineTo(-0.45, 0.1); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.arc(0.13, 0, 0.08, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      });
      for (const n of ['fin_L', 'fin_R', 'vfin_L', 'vfin_R', 'rud_L', 'rud_R', 'TP_top', 'TP_bot']) p.fill(n, C.black);
    }
    // Crosses: top wing, bottom wing underside, fuselage, rudder.
    p.on('U_top', (ctx) => crossPattee(ctx, 3.55, 0.85, 1.0, { field: 'square' }));
    p.on('L_bot', (ctx) => crossPattee(ctx, 3.3, 0.5, 0.78, { field: 'square' }));
    for (const side of ['R', 'L'] as const) p.on(`fus_${side}`, (ctx) => {
      const [x, y] = fusAt(side, 2.35, 0.0);
      crossPattee(ctx, x, y, 0.5, { field: 'square' });
      const [sx, sy] = fusAt(side, 0.3, -0.36);
      text(ctx, 'D.2065/17', sx, sy, 0.05, C.black, {});
    });
    for (const n of ['rud_L', 'rud_R']) p.on(n, (ctx) => crossPattee(ctx, 0.62, 4.47, 0.4, { field: livery === 'jasta' ? 'border' : 'none' }));
    // Weathering: exhaust soot up the right side from the manifold, oil under the nose.
    soot(p, 'fus_R', FUS.z1 - (-0.7), FUS.arcAt(-0.7, 0.35), 0.8, 0.2, 0.45);
    for (const side of ['R', 'L'] as const) {
      const [x0, v0] = fusAt(side, -1.2, -0.35);
      streaks(p, `fus_${side}`, side === 'R' ? x0 - 1.8 : x0, side === 'R' ? x0 : x0 + 1.8, v0, v0 + 0.3, side === 'R' ? -1 : 1, 1.5, { count: 60, alpha: 0.35, seed: 91 });
      const [hx, hy] = fusAt(side, 0.5, 0.38);
      smudge(p, `fus_${side}`, hx, hy, 0.2, 0.08, 0.25);
      mud(p, `fus_${side}`, 0, 7.5, v0 + 0.2, v0 + 0.6, 70, 92);
    }
    mud(p, 'L_bot', 0.3, 1.6, 0, 1.0, 100, 93);
    p.fill('spinner', livery === 'red' ? '#8a1c1a' : livery === 'jasta' ? C.yellow : '#54564e');
    p.fill('swatch', '#ffffff');
  },
};
