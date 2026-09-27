import * as THREE from 'three';
import { v3, rgb } from '../geo';
import type { Kit } from '../kit';
import { buildFuselage, Fuselage, type FusKey } from '../fuselage';
import {
  COL, coaming, controlColumn, figure, fitting, horseshoeCowl, instrumentBoard, landingGear, muzzleFlash,
  propeller, ringSight, rotaryEngine, spandau, tailSkid, tailSurface, throttleBox, windscreen, wingPair, woodStrut,
} from '../parts';
import { axleY, groundY, type Design, type DesignMeta } from '../design';
import {
  C, Painter, chips, crossPattee, fusRect, mud, smudge, soot, streaks, streaky, text, type FusMeta,
} from '../livery';
import { ellipticEdge, roundedEdge } from '../panel';

/**
 * Fokker Dr.I — three thick cantilever wings (Fokker's deep sections needed
 * no bracing wires), a single I-strut each side, the little aerofoil over the
 * axle, a comma rudder with no fin, and a slab-sided welded-tube fuselage
 * behind an Oberursel rotary. Ailerons on the top wing only.
 */

const GEAR = 1.5;
const U_LE = -0.5, M_LE = -0.3, L_LE = -0.1;
const CH = 1.0;
const U_HALF = 3.595, M_HALF = 3.115, L_HALF = 2.865;
const U_Y = 1.33, M_Y = 0.36, L_Y = -0.47;
const THRUST_Y = 0.02;

const KEYS: FusKey[] = [
  { z: -1.04, w: 0.38, top: 0.42, bot: -0.38, sh: 0.02, nt: 2, nb: 2 },
  { z: -0.75, w: 0.34, top: 0.42, bot: -0.46, sh: 0.12, nt: 2.4, nb: 5 },
  { z: -0.4, w: 0.31, top: 0.41, bot: -0.5, sh: 0.28, nt: 2.2, nb: 10 },
  { z: 0.3, w: 0.31, top: 0.405, bot: -0.49, sh: 0.3, nt: 2.2, nb: 10 },
  { z: 0.9, w: 0.29, top: 0.39, bot: -0.46, sh: 0.3, nt: 2.2, nb: 10 },
  { z: 2.0, w: 0.19, top: 0.34, bot: -0.36, sh: 0.26, nt: 2.4, nb: 10 },
  { z: 3.1, w: 0.075, top: 0.28, bot: -0.25, sh: 0.2, nt: 2.4, nb: 10 },
  { z: 3.72, w: 0.01, top: 0.24, bot: -0.18, sh: 0.15, nt: 2.4, nb: 10 },
];
const FUS = new Fuselage(KEYS);
const COCKPIT = { z0: 0.44, z1: 1.04, hw: 0.25 };
const EYE = v3(0, 0.9, 0.74);

export const dr1: Design = {
  id: 'dr1',
  liveries: ['standard', 'red', 'jasta'],

  build(k: Kit): DesignMeta {
    const at = k.atlas;
    const fm = (side: 'R' | 'L'): Record<string, unknown> => ({ fus: FUS, side, fabricFrom: 0.2, panelSeams: [-1.04, -0.7, -0.3, 0.2], formers: [0.9, 1.5, 2.1, 2.7, 3.3], stringerArcs: [0, 0.08, 0.16, 0.24] } satisfies FusMeta as unknown as Record<string, unknown>);
    const f = buildFuselage(FUS, { keys: KEYS, openings: [COCKPIT], right: at.region('fus_R', 'fus', fm('R')), left: at.region('fus_L', 'fus', fm('L')), dz: k.n(0.07, 0.3, 0.9), m: k.n(18, 7, 4), capFront: true }, COL.interior);
    k.skin(f.outer, 'static', 'fus');
    if (k.detail === 0) {
      for (const t of f.tubs) k.props(t, 'interior');
      for (const r of f.rims) coaming(k, r);
    }

    // ---- three wings: round tips, thick Fokker section
    const tipLE = (s1: number): ((s: number) => number) => ellipticEdge(0, 0.5, s1, 0.42);
    const tipTE = (s1: number): ((s: number) => number) => ellipticEdge(CH, 0.5, s1, 0.42);
    const ribs = (h: number): number[] => Array.from({ length: Math.ceil(h / 0.3) + 1 }, (_, i) => 0.05 + i * 0.3);
    const upper = wingPair(k, {
      name: 'U', origin: v3(0, U_Y, U_LE), dihedral: 0, incidence: 0.02, s0: 0, s1: U_HALF,
      le: tipLE(U_HALF), te: tipTE(U_HALF), tc: 0.13, camber: 0.04, ribs: ribs(U_HALF), scallop: 0.009,
      aileron: { s0: 2.1, s1: U_HALF, x: () => 0.74 }, leSheet: 0.22, hit: 'wingU', tipZone: 0.45,
    });
    const middle = wingPair(k, {
      name: 'M', origin: v3(0, M_Y, M_LE), dihedral: 0, incidence: 0.02, s0: 0, s1: M_HALF,
      le: tipLE(M_HALF),
      te: (s) => tipTE(M_HALF)(s) - (s < 0.28 ? 0.26 : s < 0.4 ? 0.26 * Math.cos(((s - 0.28) / 0.12) * Math.PI * 0.5) : 0),
      tc: 0.13, camber: 0.04, ribs: ribs(M_HALF), scallop: 0.009, leSheet: 0.22, hit: 'wingM', tipZone: 0.45,
    });
    const lower = wingPair(k, {
      name: 'L', origin: v3(0, L_Y, L_LE), dihedral: 0, incidence: 0.02, s0: 0.28, s1: L_HALF,
      le: tipLE(L_HALF), te: tipTE(L_HALF), tc: 0.13, camber: 0.04, ribs: ribs(L_HALF), scallop: 0.009,
      capRoot: true, leSheet: 0.22, hit: 'wingL', tipZone: 0.45,
    });
    // I-struts: broad thin planks lower → middle → upper. No wires at all.
    const SI = 2.3;
    for (const side of [1, -1] as const) {
      const l = lower.at(SI, 0.4, true, side), m0 = middle.at(SI, 0.4, false, side), m1 = middle.at(SI, 0.4, true, side), u = upper.at(SI, 0.4, false, side);
      // Painted with the airframe, not varnished: the livery owns their colour.
      woodStrut(k, l, m0, 0.2, COL.wood, 0.16, 'wingM', 'livery');
      woodStrut(k, m1, u, 0.2, COL.wood, 0.16, 'wingU', 'livery');
      fitting(k, u); fitting(k, l);
      // Cabane: an inverted V each side from the longerons to the top wing.
      const top = upper.at(0.32, 0.4, false, side);
      woodStrut(k, v3(side * 0.3, 0.38, -0.6), top, 0.05, rgb('#2d2c28'), 0.45, 'fus', 'paint');
      woodStrut(k, v3(side * 0.3, 0.38, 0.25), top, 0.05, rgb('#2d2c28'), 0.45, 'fus', 'paint');
    }

    // ---- tail: triangular tailplane, comma rudder (all-moving, no fin)
    tailSurface(k, {
      name: 'TP', origin: v3(0, 0.25, 0), s0: 0, s1: 1.1, hit: 'tail',
      le: (s) => 3.1 + 0.62 * (s / 1.1), te: (s) => roundedEdge(3.98, 1.1, 0.12, 1)(s) - (s < 0.16 ? (1 - s / 0.16) * 0.28 : 0),
      ribs: [0.2, 0.45, 0.7, 0.95], hinge: { x: () => 3.66, s0: 0.03, s1: 1.1 },
    });
    tailSurface(k, {
      name: 'rud', origin: v3(0, -0.17, 0), s0: 0, s1: 1.12, vertical: true, moving: true, hit: 'tail',
      le: (s) => 3.72 - 0.16 * Math.max(0, Math.sin(Math.min(1, Math.max(0, (s - 0.45) / 0.67)) * Math.PI)) - (s > 0.95 ? 0 : 0),
      te: (s) => 3.72 + 0.36 * Math.sqrt(Math.max(0, 1 - ((s - 0.5) / (s < 0.5 ? 0.5 : 0.62)) ** 2)),
      ribs: [0.3, 0.6, 0.9], hinge: { x: () => 3.72, s0: 0, s1: 1.12 },
    });

    // ---- undercarriage with the axle aerofoil
    const az = -0.72, r = 0.37;
    landingGear(k, {
      track: 1.62, y: axleY(az, GEAR, r), z: az, r, tyre: 0.045,
      front: v3(0.26, -0.44, -0.98), rear: v3(0.28, -0.5, -0.35), apexX: 0.6, hit: 'fus',
      strutCol: rgb('#2f2e2a'), strutRegion: 'paint',
      axleWing: { chord: 0.46, region: at.region('axle', 'wing') },
    });
    tailSkid(k, v3(0, -0.22, 3.0), v3(0, groundY(3.62, GEAR) + 0.01, 3.62), 0.1);

    // ---- engine, cowl, propeller
    rotaryEngine(k, v3(0, THRUST_Y, -1.25), { node: 'rotor0', axis: v3(0, 0, -1), rHead: 0.39 });
    const zf = -1.47, zr = -1.03;
    horseshoeCowl(k, THRUST_Y, [
      [0.37, zf + 0.12], [0.36, zf + 0.05], [0.365, zf + 0.015], [0.385, zf], [0.415, zf - 0.004], [0.445, zf + 0.004],
      [0.468, zf + 0.03], [0.478, zf + 0.09], [0.48, zf + 0.2], [0.476, zf + 0.34], [0.47, zr],
    ], 0.55, 0.48, 0.16);
    propeller(k, { hub: v3(0, THRUST_Y, -1.58), R: 1.31, blades: 2, chord: 0.19, pitch: 2.3, id: 0 });

    // ---- guns on the decking
    const muzzles: THREE.Vector3[] = [];
    for (const side of [-1, 1] as const) muzzles.push(spandau(k, v3(side * 0.1, 0.55, 0.42), { left: side < 0 }));
    muzzles.forEach((m, i) => muzzleFlash(k, m, `flash${i}`));
    ringSight(k, v3(0, EYE.y, 0.15), v3(0, EYE.y - 0.02, -0.55), 0.055);
    windscreen(k, v3(0, 0.46, 0.46), 0.3, 0.12, 0.6);

    k.node('cockpit', EYE, { flags: { cockpit: true } });
    instrumentBoard(k, FUS, 0.5, -0.05, 0.45, [
      { dial: 'rpm', x: 0, y: 0.26, r: 0.045 },
      { dial: 'alt', x: -0.15, y: 0.2, r: 0.038 },
      { dial: 'air', x: 0.15, y: 0.2, r: 0.03 },
      { dial: 'level', x: 0, y: 0.1, r: 0.026 },
    ]);
    controlColumn(k, v3(0, -0.45, 0.66), v3(0, 0.12, 0.56));
    throttleBox(k, v3(-0.26, 0.15, 0.72));

    const pilot = figure(k, { eye: EYE, node: 'pilot', headNode: 'head', flags: { pilot: true }, scarf: rgb('#e6dfcd') });
    return {
      eye: EYE.clone(), muzzles, gunnerMount: null,
      exhausts: [v3(0, -0.42, -1.2)],
      engines: [v3(0, THRUST_Y, -1.25)],
      spinners: [
        { node: 'prop0', kind: 'prop', dir: 1 },
        { node: 'rotor0', kind: 'rotor', dir: 1 },
        { node: 'disc0', kind: 'disc', dir: 1 },
      ],
      scarf: { node: 'pilot', anchor: pilot.neck, color: COL.silk },
      deflect: { elevator: 0.45, aileron: 0.35, rudder: 0.5 },
      gunner: null, flashes: muzzles.map((_, i) => `flash${i}`),
    };
  },

  paint(p: Painter, livery: string): void {
    const olive = '#4a4b2b', clear = '#8f875c', pale = '#9dbdcc';
    const red = livery === 'red';
    const top = ['U_top', 'M_top', 'L_top', 'TP_top', 'axle'];
    const bot = ['U_bot', 'M_bot', 'L_bot', 'TP_bot'];
    let seed = 60;
    if (red) {
      // Fokker's red was a deep, slightly brownish crimson, hand-applied and never even.
      for (const n of [...top, ...bot, 'fus_R', 'fus_L', 'rud_L', 'rud_R', 'cowl', 'wheel']) p.fill(n, '#8e1b18');
      for (const n of [...top, ...bot, 'fus_R', 'fus_L', 'rud_L', 'rud_R']) p.grime(n, 0.32, 0.4);
    } else {
      // Streaks run diagonally across the wings, lengthwise-ish down the fuselage.
      for (const n of top) streaky(p, n, clear, olive, seed++, 0.6);
      for (const side of ['R', 'L'] as const) streaky(p, `fus_${side}`, clear, olive, seed++, side === 'R' ? -0.25 : 0.25);
      for (const n of bot) p.fill(n, pale);
      p.fill('rud_L', C.white); p.fill('rud_R', C.white);
      p.fill('cowl', olive);
      p.fill('wheel', olive);
      // Pale blue belly under the fuselage.
      for (const side of ['R', 'L'] as const) p.on(`fus_${side}`, (ctx) => {
        ctx.fillStyle = pale;
        ctx.beginPath();
        const U = (z: number): number => (side === 'R' ? FUS.z1 - z : z - FUS.z0);
        for (let z = FUS.z0; z <= FUS.z1 + 0.01; z += 0.05) {
          const v = FUS.arcAt(z, FUS.param('bot', z) + 0.02);
          if (z === FUS.z0) ctx.moveTo(U(z), v); else ctx.lineTo(U(z), v);
        }
        ctx.lineTo(U(FUS.z1), 3); ctx.lineTo(U(FUS.z0), 3); ctx.closePath(); ctx.fill();
      });
    }
    if (livery === 'jasta') {
      p.fill('cowl', C.yellow);
      p.fill('TP_top', C.yellow); p.fill('TP_bot', C.yellow);
      p.fill('rud_L', C.yellow); p.fill('rud_R', C.yellow);
      for (const side of ['R', 'L'] as const) p.on(`fus_${side}`, (ctx) => {
        // Black and white bands round the rear fuselage.
        for (let q = 0; q < 8; q++) {
          const z = 1.9 + q * 0.22;
          const u = side === 'R' ? FUS.z1 - z - 0.22 : z - FUS.z0;
          ctx.fillStyle = q % 2 ? C.white : C.black;
          ctx.fillRect(u, -1, 0.22, 3);
        }
      });
    }
    const fusAt = (side: 'R' | 'L', z: number, y: number): [number, number] => [side === 'R' ? FUS.z1 - z : z - FUS.z0, FUS.arcAt(z, y)];
    const field = red ? 'border' : 'square';
    p.on('U_top', (ctx) => crossPattee(ctx, 2.85, 0.5, 0.8, { field }));
    p.on('L_bot', (ctx) => crossPattee(ctx, 2.2, 0.5, 0.75, { field }));
    for (const side of ['R', 'L'] as const) {
      p.on(`fus_${side}`, (ctx) => {
        const [x, y] = fusAt(side, 2.2, 0.0);
        crossPattee(ctx, x, y, 0.52, { field });
        const [sx, sy] = fusAt(side, 0.55, -0.32);
        text(ctx, red ? 'Fok. Dr. I 425/17' : 'Fok. Dr. I 152/17', sx, sy, 0.045, red ? C.white : C.black, {});
      });
    }
    for (const n of ['rud_L', 'rud_R']) p.on(n, (ctx) => crossPattee(ctx, 0.5, 3.8, 0.4, { field: red ? 'border' : 'none' }));
    p.surface('cowl', 0.42, 0);
    for (const side of ['R', 'L'] as const) p.surface(`fus_${side}`, 0.5, 0, fusRect(FUS, side, FUS.z0, 0.2));
    // Castor oil everywhere behind a rotary.
    for (const side of ['R', 'L'] as const) {
      const [x0] = fusAt(side, -1.03, 0);
      const [, v0] = fusAt(side, -0.8, -0.2), [, v1] = fusAt(side, -0.8, -0.5);
      streaks(p, `fus_${side}`, side === 'R' ? x0 - 0.8 : x0, side === 'R' ? x0 : x0 + 0.8, v0, v1 + 0.15, side === 'R' ? -1 : 1, 1.8, { count: 80, alpha: 0.42, seed: 61 });
      soot(p, `fus_${side}`, side === 'R' ? x0 - 0.4 : x0 + 0.4, v1, 0.6, 0.15, 0.5);
      const [hx, hy] = fusAt(side, 0.8, 0.33);
      smudge(p, `fus_${side}`, hx, hy, 0.18, 0.07, 0.22);
      mud(p, `fus_${side}`, 0, 6, v1 - 0.02, v1 + 0.3, 80, 62);
    }
    chips(p, 'cowl', -2, 4, 0.12, 0.22, 150, 63);
    mud(p, 'L_bot', 0.28, 1.2, 0, 1.0, 110, 64);
    mud(p, 'axle', -1, 1, -1, 1, 160, 65);
    p.fill('struts', red ? '#8e1b18' : olive);
    p.fill('swatch', '#ffffff');
  },
};
