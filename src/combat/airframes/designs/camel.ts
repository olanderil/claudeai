import * as THREE from 'three';
import { v3, rgb } from '../geo';
import type { Kit } from '../kit';
import { buildFuselage, Fuselage, type FusKey } from '../fuselage';
import {
  COL, aldis, coaming, controlColumn, figure, fitting, horseshoeCowl, instrumentBoard, landingGear, muzzleFlash,
  propeller, rigWire, ringSight, rotaryEngine, tailSkid, tailSurface, throttleBox, vickers, windscreen, wingPair, woodStrut,
} from '../parts';
import { axleY, groundY, type Design, type DesignMeta } from '../design';
import {
  C, Painter, chips, crossPattee, fusRect, mud, rfcRoundel, smudge, soot, streaks, text, type FusMeta,
} from '../livery';
import { roundedEdge } from '../panel';

/**
 * Sopwith Camel F.1 — Clerget 9B rotary, twin Vickers under the hump.
 *
 * Datums: CG at 30 % of the mean chord of the staggered cell (upper LE at
 * z = -0.64, 0.46 m stagger, 1.37 m chord). The cowl sits right in front of
 * the upper wing — the famous short nose that put engine, guns, fuel and
 * pilot in the first seven feet — and the rest of the 5.72 m is tail.
 */

const GEAR = 1.5;
const CHORD = 1.37;
const HALF = 4.265;
const U_LE = -0.64;
const L_LE = U_LE + 0.46;
const U_Y = 1.06;
const L_Y = -0.52;
const DIH = (5 * Math.PI) / 180;
const THRUST_Y = 0.02;

// Flat-sided box up to the top longerons (the shoulder, y ≈ 0.26), a low
// stringered decking over it, the gun hump in front of the cockpit, and a
// round section at the firewall to fair into the cowl.
const KEYS: FusKey[] = [
  { z: -0.78, w: 0.4, top: 0.41, bot: -0.39, sh: 0.01, nt: 2.0, nb: 2.0 },
  { z: -0.5, w: 0.405, top: 0.37, bot: -0.47, sh: 0.14, nt: 2.1, nb: 4, hump: 0.16, hw: 0.26 },
  { z: -0.25, w: 0.405, top: 0.36, bot: -0.5, sh: 0.24, nt: 2, nb: 7, hump: 0.24, hw: 0.28 },
  { z: 0.0, w: 0.4, top: 0.35, bot: -0.5, sh: 0.26, nt: 2, nb: 8, hump: 0.27, hw: 0.28 },
  { z: 0.2, w: 0.395, top: 0.345, bot: -0.49, sh: 0.26, nt: 2, nb: 8, hump: 0.13, hw: 0.27 },
  { z: 0.3, w: 0.393, top: 0.342, bot: -0.485, sh: 0.26, nt: 2, nb: 8, hump: 0, hw: 0.26 },
  { z: 0.7, w: 0.383, top: 0.34, bot: -0.47, sh: 0.255, nt: 2, nb: 8 },
  { z: 1.2, w: 0.36, top: 0.335, bot: -0.43, sh: 0.25, nt: 2, nb: 8 },
  { z: 2.2, w: 0.26, top: 0.29, bot: -0.33, sh: 0.2, nt: 2, nb: 8 },
  { z: 3.2, w: 0.12, top: 0.23, bot: -0.23, sh: 0.14, nt: 2, nb: 8 },
  { z: 3.77, w: 0.012, top: 0.2, bot: -0.18, sh: 0.1, nt: 2, nb: 8 },
];
const FUS = new Fuselage(KEYS);
const COCKPIT = { z0: 0.3, z1: 0.98, hw: 0.28 };
const EYE = v3(0, 0.74, 0.68);
const RIBS = Array.from({ length: 15 }, (_, i) => 0.05 + i * 0.3);

/** Raked tip: the TE runs straight to `s1 - rake`, then the tip edge slants forward to meet the LE. */
function rakedTE(te0: number, le0: number, s1: number, rake: number, r: number): (s: number) => number {
  return (s: number) => {
    const sr = s1 - rake;
    if (s <= sr - r) return te0;
    // Blend a circular corner of radius r between the straight TE and the rake line.
    const slope = (te0 - le0 - 0.08) / rake;
    const line = te0 - Math.max(0, s - sr) * slope;
    const d = s - (sr - r);
    const corner = te0 - (r - Math.sqrt(Math.max(0, r * r - d * d))) * 0.6;
    return Math.min(corner, line);
  };
}

export const camel: Design = {
  id: 'camel',
  liveries: ['standard', 'flight', 'ace'],

  build(k: Kit): DesignMeta {
    const at = k.atlas;
    // ---- fuselage
    const fusR = at.region('fus_R', 'fus', { fus: FUS, side: 'R', fabricFrom: 0.95, panelSeams: [-0.76, -0.45, -0.1, 0.25, 0.95], formers: [1.5, 2.1, 2.7, 3.3], stringerArcs: [0, 0.08, 0.16, 0.24, 0.32, 0.4] } satisfies FusMeta as unknown as Record<string, unknown>);
    const fusL = at.region('fus_L', 'fus', { fus: FUS, side: 'L', fabricFrom: 0.95, panelSeams: [-0.76, -0.45, -0.1, 0.25, 0.95], formers: [1.5, 2.1, 2.7, 3.3], stringerArcs: [0, 0.08, 0.16, 0.24, 0.32, 0.4] } satisfies FusMeta as unknown as Record<string, unknown>);
    const f = buildFuselage(FUS, { keys: KEYS, openings: [COCKPIT], right: fusR, left: fusL, dz: k.n(0.07, 0.3, 0.9), m: k.n(18, 7, 4), capFront: true }, COL.interior);
    k.skin(f.outer, 'static', 'fus');
    if (k.detail === 0) {
      for (const t of f.tubs) k.props(t, 'interior');
      for (const r of f.rims) coaming(k, r);
    }

    // ---- wings
    const upper = wingPair(k, {
      name: 'U', origin: v3(0, U_Y, U_LE), dihedral: 0, incidence: 0.035, s0: 0, s1: HALF,
      le: roundedEdge(0, HALF, 0.1, -1),
      te: (s) => {
        // Centre-section cut-out for the pilot's view up and back.
        const cut = s < 0.3 ? 0.36 : s < 0.46 ? 0.36 * Math.cos(((s - 0.3) / 0.16) * Math.PI * 0.5) : 0;
        return rakedTE(CHORD, 0, HALF, 0.42, 0.25)(s) - cut;
      },
      tc: 0.062, camber: 0.045, ribs: RIBS, scallop: 0.012,
      aileron: { s0: 2.4, s1: HALF, x: () => CHORD - 0.4 }, leSheet: 0.12, hit: 'wingU', tipZone: 0.45,
    });
    const lower = wingPair(k, {
      name: 'L', origin: v3(0, L_Y, L_LE), dihedral: DIH, incidence: 0.035, s0: 0.3, s1: HALF,
      le: roundedEdge(0, HALF, 0.1, -1), te: rakedTE(CHORD, 0, HALF, 0.42, 0.25),
      tc: 0.062, camber: 0.045, ribs: RIBS, scallop: 0.012, capRoot: true,
      aileron: { s0: 2.4, s1: HALF, x: () => CHORD - 0.4 }, leSheet: 0.12, hit: 'wingL', tipZone: 0.45,
    });

    // ---- interplane and cabane struts, rigging
    const SI = 3.55;
    for (const side of [1, -1] as const) {
      for (const x of [0.22, 0.98]) {
        const a = upper.at(SI, x, false, side), b = lower.at(SI, x, true, side);
        woodStrut(k, b, a, 0.085, COL.wood, 0.32, undefined);
        fitting(k, a); fitting(k, b);
      }
      // Cabane: front and rear pairs from the top longerons to the centre section.
      const cf = upper.at(0.3, 0.2, false, side), cr = upper.at(0.3, 0.95, false, side);
      woodStrut(k, v3(side * 0.3, 0.31, -0.5), cf, 0.06, COL.wood, 0.4, 'fus');
      woodStrut(k, v3(side * 0.3, 0.33, 0.12), cr, 0.06, COL.wood, 0.4, 'fus');
      // Flying wires (doubled) from the lower root to the upper strut head; landing wires the other way.
      for (const x of [0.22, 0.98]) {
        rigWire(k, lower.at(0.45, x, true, side), upper.at(SI - 0.05, x, false, side), true);
        rigWire(k, upper.at(0.35, x, false, side), lower.at(SI - 0.05, x, true, side), false);
      }
      rigWire(k, v3(side * 0.3, 0.31, -0.5), cr, false);
    }

    // ---- tail
    tailSurface(k, {
      name: 'TP', origin: v3(0, 0.215, 0), s0: 0, s1: 1.3, hit: 'tail',
      le: (s) => 3.05 + 0.28 * (s / 1.3) ** 2 + (s > 1.05 ? 0.5 * (1 - Math.sqrt(Math.max(0, 1 - ((s - 1.05) / 0.25) ** 2))) : 0),
      te: (s) => {
        const notch = s < 0.22 ? (1 - s / 0.22) * 0.38 : 0;
        return roundedEdge(4.12, 1.3, 0.3, 1)(s) - notch;
      },
      ribs: [0.15, 0.4, 0.65, 0.9, 1.15], hinge: { x: () => 3.7, s0: 0.03, s1: 1.3 },
    });
    tailSurface(k, {
      name: 'fin', origin: v3(0, 0.2, 0), s0: 0, s1: 0.56, vertical: true, hit: 'tail',
      le: (s) => 3.3 + 0.42 * Math.pow(s / 0.56, 0.75), te: () => 3.75, ribs: [0.2, 0.4],
    });
    tailSurface(k, {
      name: 'rud', origin: v3(0, -0.28, 0), s0: 0, s1: 1.08, vertical: true, moving: true, hit: 'tail',
      le: () => 3.75, te: (s) => 3.75 + 0.46 * Math.sqrt(Math.max(0, 1 - ((s - 0.56) / 0.56) ** 2)),
      ribs: [0.2, 0.45, 0.7, 0.95], hinge: { x: () => 3.75, s0: 0, s1: 1.08 },
    });
    // Tail bracing wires.
    for (const side of [1, -1]) {
      rigWire(k, v3(0, 0.74, 3.62), v3(side * 0.8, 0.235, 3.5));
      rigWire(k, v3(side * 0.04, -0.19, 3.6), v3(side * 0.8, 0.2, 3.5));
    }

    // ---- undercarriage and skid
    const az = -0.62, r = 0.35;
    landingGear(k, {
      track: 1.52, y: axleY(az, GEAR, r), z: az, r, tyre: 0.04,
      front: v3(0.3, -0.42, -0.72), rear: v3(0.33, -0.5, -0.08), apexX: 0.6, hit: 'gear',
    });
    // The physics parks every scout with its CG 1.5 m up at 11°, which leaves
    // the tail higher than a real Camel's: a long sprung skid raked aft.
    const shoeZ = 3.78;
    tailSkid(k, v3(0, -0.25, 3.0), v3(0, groundY(shoeZ, GEAR) + 0.01, shoeZ), 0.13);

    // ---- engine, cowl, propeller
    rotaryEngine(k, v3(0, THRUST_Y, -1.05), { node: 'rotor0', axis: v3(0, 0, -1), rHead: 0.4 });
    const zf = -1.3, zr = -0.76;
    horseshoeCowl(k, THRUST_Y, [
      [0.372, zf + 0.13], [0.366, zf + 0.06], [0.37, zf + 0.018], [0.39, zf], [0.42, zf - 0.005], [0.45, zf + 0.004],
      [0.474, zf + 0.03], [0.488, zf + 0.09], [0.494, zf + 0.22], [0.49, zf + 0.42], [0.486, zr],
    ], 1.2, 0.49, 0.16);
    propeller(k, { hub: v3(0, THRUST_Y, -1.4), R: 1.295, blades: 2, chord: 0.2, pitch: 2.4, id: 0 });

    // ---- guns, sights, windscreen
    const muzzles: THREE.Vector3[] = [];
    for (const side of [-1, 1] as const) muzzles.push(vickers(k, v3(side * 0.105, 0.5, 0.2), { left: side < 0 }));
    muzzles.forEach((m, i) => muzzleFlash(k, m, `flash${i}`));
    // Aldis low on the centreline; ring-and-bead on the eye line so the
    // cockpit camera looks straight through it along the guns.
    aldis(k, v3(0, 0.63, 0.3), v3(0, 0.625, -0.32));
    ringSight(k, v3(0, EYE.y, 0.0), v3(0, EYE.y, -0.62), 0.06);
    windscreen(k, v3(0, 0.55, 0.27), 0.32, 0.15, 0.5);

    // ---- cockpit interior (cockpit view only)
    k.node('cockpit', EYE, { flags: { cockpit: true } });
    instrumentBoard(k, FUS, 0.26, -0.05, 0.43, [
      { dial: 'rpm', x: 0, y: 0.23, r: 0.046 },
      { dial: 'alt', x: -0.14, y: 0.2, r: 0.04 },
      { dial: 'asi', x: 0.14, y: 0.2, r: 0.04 },
      { dial: 'air', x: -0.25, y: 0.1, r: 0.03 },
      { dial: 'oil', x: 0.24, y: 0.1, r: 0.03 },
      { dial: 'clock', x: 0.08, y: 0.07, r: 0.026 },
      { dial: 'level', x: -0.08, y: 0.07, r: 0.028 },
    ]);
    controlColumn(k, v3(0, -0.45, 0.55), v3(0, 0.1, 0.46));
    throttleBox(k, v3(-0.33, 0.12, 0.6));

    // ---- pilot
    const pilot = figure(k, { eye: EYE, node: 'pilot', headNode: 'head', flags: { pilot: true } });

    return {
      eye: EYE.clone(),
      muzzles,
      gunnerMount: null,
      exhausts: [v3(0, -0.42, -0.95)],
      engines: [v3(0, THRUST_Y, -1.05)],
      spinners: [
        { node: 'prop0', kind: 'prop', dir: 1 },
        { node: 'rotor0', kind: 'rotor', dir: 1 },
        { node: 'disc0', kind: 'disc', dir: 1 },
      ],
      scarf: { node: 'pilot', anchor: pilot.neck, color: COL.silk },
      deflect: { elevator: 0.42, aileron: 0.35, rudder: 0.45 },
      gunner: null,
      flashes: muzzles.map((_, i) => `flash${i}`),
    };
  },

  paint(p: Painter, livery: string): void {
    const pc10 = C.pc10, cdl = C.cdl;
    // Wings.
    p.fill('U_top', pc10); p.fill('L_top', pc10);
    p.fill('U_bot', cdl); p.fill('L_bot', cdl);
    for (const n of ['U_top', 'L_top', 'TP_top', 'fin_L', 'fin_R']) p.grime(n, 0.22);
    for (const n of ['U_bot', 'L_bot', 'TP_bot']) p.grime(n, 0.12);
    p.on('U_top', (ctx) => rfcRoundel(ctx, 3.05, 0.68, 0.58));
    p.on('L_bot', (ctx) => rfcRoundel(ctx, 3.05, 0.68, 0.58, false));
    // Tail.
    p.fill('TP_top', pc10); p.fill('TP_bot', cdl);
    p.fill('fin_L', pc10); p.fill('fin_R', pc10);
    for (const side of ['rud_L', 'rud_R']) {
      p.on(side, (ctx) => {
        const h = 0.46 / 3;
        ctx.fillStyle = C.rfcBlue; ctx.fillRect(-1, 3.7, 3, h + 0.05);
        ctx.fillStyle = C.white; ctx.fillRect(-1, 3.75 + h, 3, h);
        ctx.fillStyle = C.rfcRed; ctx.fillRect(-1, 3.75 + 2 * h, 3, 1);
        // Serial across the white stripe. Tail regions are laid out u = height,
        // v = aft, so upright text runs along ±v and "down" is -u; the
        // starboard face is seen from the other side, hence the flipped basis.
        const right: [number, number] = side === 'rud_L' ? [0, 1] : [0, -1];
        text(ctx, 'B6313', 0.62, 3.75 + h * 1.5, 0.045, C.black, { right, down: [-1, 0] });
      });
    }
    // Fuselage: PC10 over the top and sides, clear-doped belly.
    for (const side of ['R', 'L'] as const) {
      const name = `fus_${side}`;
      p.on(name, (ctx, r) => {
        ctx.fillStyle = pc10;
        ctx.fillRect(r.u0 - 1, r.v0 - 1, r.u1 - r.u0 + 2, r.v1 - r.v0 + 2);
        // Belly demarcation follows the lower longeron.
        ctx.fillStyle = cdl;
        ctx.beginPath();
        const U = (z: number): number => (side === 'R' ? FUS.z1 - z : z - FUS.z0);
        for (let z = FUS.z0; z <= FUS.z1 + 0.01; z += 0.05) {
          const v = FUS.arcAt(z, FUS.param('bot', z) + 0.035);
          if (z === FUS.z0) ctx.moveTo(U(z), v); else ctx.lineTo(U(z), v);
        }
        ctx.lineTo(U(FUS.z1), 3); ctx.lineTo(U(FUS.z0), 3); ctx.closePath(); ctx.fill();
      });
      p.grime(name, 0.25);
    }
    const fusAt = (side: 'R' | 'L', z: number, y: number): [number, number] => [side === 'R' ? FUS.z1 - z : z - FUS.z0, FUS.arcAt(z, y)];
    // Cowl: painted PC10 unless the livery says otherwise; chipped round the lip.
    p.fill('cowl', livery === 'standard' ? C.pc10dark : C.pc10dark);
    p.fill('wheel', livery === 'standard' ? pc10 : pc10);
    p.surface('cowl', 0.42, 0);
    for (const side of ['R', 'L'] as const) p.surface(`fus_${side}`, 0.5, 0, fusRect(FUS, side, FUS.z0, 0.3));

    // Common markings on the fuselage.
    const letter = livery === 'ace' ? 'B' : livery === 'flight' ? 'C' : 'A';
    for (const side of ['R', 'L'] as const) {
      p.on(`fus_${side}`, (ctx) => {
        const [x, y] = fusAt(side, 1.95, 0.0);
        rfcRoundel(ctx, x, y, 0.3);
        // Serial: white, on the rear fuselage below the tailplane.
        const [sx, sy] = fusAt(side, 3.05, -0.05);
        text(ctx, 'B6313', sx, sy, 0.1, C.white, {});
        // Flight letter ahead of the roundel.
        const [lx, ly] = fusAt(side, 1.3, 0.0);
        text(ctx, letter, lx, ly, 0.32, C.white, { font: 'bold 100px "DejaVu Sans", Arial, sans-serif' });
        // Squadron marking: a white bar aft of the roundel.
        const [bx] = fusAt(side, 2.55, 0);
        const [, top] = fusAt(side, 2.55, 0.22);
        const [, bot] = fusAt(side, 2.55, -0.24);
        ctx.fillStyle = C.white;
        ctx.fillRect(bx - 0.04, top, 0.08, bot - top);
        // Stencilled maker's data by the cockpit.
        const [dx, dy] = fusAt(side, 0.5, -0.3);
        text(ctx, 'SOPWITH F.1', dx, dy, 0.03, 'rgba(235,230,215,0.8)', {});
      });
    }
    if (livery === 'flight') {
      // Red and white cowl segments, wheel covers to match.
      p.on('cowl', (ctx, r) => {
        const n = 12;
        for (let q = 0; q < n; q++) {
          ctx.fillStyle = q % 2 ? C.white : C.red;
          ctx.fillRect(r.u0 + ((r.u1 - r.u0) * q) / n, r.v0 - 1, (r.u1 - r.u0) / n + 0.002, 3);
        }
      });
      p.on('wheel', (ctx) => {
        for (let q = 0; q < 4; q++) {
          ctx.fillStyle = q % 2 ? C.white : C.red;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 0.4, (q * Math.PI) / 2, ((q + 1) * Math.PI) / 2); ctx.closePath(); ctx.fill();
        }
      });
      // Red forward fuselage panel band.
      for (const side of ['R', 'L'] as const) p.on(`fus_${side}`, (ctx) => {
        const [x0] = fusAt(side, -0.76, 0), [x1] = fusAt(side, -0.5, 0);
        ctx.fillStyle = C.red; ctx.fillRect(Math.min(x0, x1), -1, Math.abs(x1 - x0), 3);
      });
    } else if (livery === 'ace') {
      p.on('cowl', (ctx, r) => {
        ctx.fillStyle = C.white; ctx.fillRect(r.u0 - 1, r.v0 - 1, r.u1 - r.u0 + 2, 3);
        // Red spiral bands.
        ctx.fillStyle = C.red;
        for (let q = -6; q < 12; q++) {
          ctx.beginPath();
          const x = r.u0 + q * 0.28;
          ctx.moveTo(x, r.v0 - 0.1); ctx.lineTo(x + 0.14, r.v0 - 0.1); ctx.lineTo(x + 0.14 + 0.5, r.v1 + 0.1); ctx.lineTo(x + 0.5, r.v1 + 0.1);
          ctx.fill();
        }
      });
      p.on('wheel', (ctx) => {
        ctx.fillStyle = C.red; ctx.beginPath(); ctx.arc(0, 0, 0.4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = C.white; ctx.beginPath(); ctx.arc(0, 0, 0.18, 0, Math.PI * 2); ctx.fill();
      });
      for (const side of ['R', 'L'] as const) p.on(`fus_${side}`, (ctx) => {
        // White fuselage bands with red edges fore and aft of the roundel, a card-suit heart forward.
        for (const z of [1.55, 2.35]) {
          const [x] = fusAt(side, z, 0);
          ctx.fillStyle = C.red; ctx.fillRect(x - 0.1, -1, 0.2, 3);
          ctx.fillStyle = C.white; ctx.fillRect(x - 0.075, -1, 0.15, 3);
        }
        const [hx, hy] = fusAt(side, -0.25, 0.05);
        ctx.fillStyle = C.white; ctx.beginPath(); ctx.arc(hx, hy, 0.13, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = C.red;
        ctx.beginPath();
        ctx.moveTo(hx, hy + 0.08);
        ctx.bezierCurveTo(hx - 0.14, hy - 0.02, hx - 0.06, hy - 0.11, hx, hy - 0.04);
        ctx.bezierCurveTo(hx + 0.06, hy - 0.11, hx + 0.14, hy - 0.02, hx, hy + 0.08);
        ctx.fill();
      });
      p.on('fin_L', (ctx) => { ctx.fillStyle = C.white; ctx.fillRect(-1, 3.0, 3, 1); });
      p.on('fin_R', (ctx) => { ctx.fillStyle = C.white; ctx.fillRect(-1, 3.0, 3, 1); });
    }

    // ---- weathering
    // Castor oil thrown back from the rotary, along the lower sides and belly.
    for (const side of ['R', 'L'] as const) {
      const [x0] = fusAt(side, -0.76, 0), [x1] = fusAt(side, 0.4, 0);
      const [, vTop] = fusAt(side, -0.3, -0.1), [, vBot] = fusAt(side, -0.3, -0.6);
      const dir = side === 'R' ? -1 : 1;
      streaks(p, `fus_${side}`, Math.min(x0, x1) + (side === 'R' ? 0.8 : 0), Math.min(x0, x1) + (side === 'R' ? 1.15 : 0.35), vTop, vBot + 0.2, dir, 1.6, { count: 70, alpha: 0.4, seed: side === 'R' ? 3 : 4 });
      soot(p, `fus_${side}`, side === 'R' ? x0 - 0.35 : x0 + 0.35, vBot, 0.6, 0.18, 0.55);
      const [hx, hy] = fusAt(side, 0.55, 0.25);
      smudge(p, `fus_${side}`, hx, hy, 0.2, 0.08, 0.25);
      mud(p, `fus_${side}`, 0, 6, vBot - 0.05, vBot + 0.3, 90, 11);
    }
    chips(p, 'cowl', -2, 4, 0.12, 0.22, 150, 21);
    chips(p, 'cowl', -2, 4, 0.22, 0.7, 18, 22);
    mud(p, 'L_bot', 0.3, 1.6, 0, 1.37, 120, 12);
    streaks(p, 'L_bot', 0.3, 0.9, 0.0, 1.2, 1, 0.8, { count: 20, alpha: 0.3, seed: 8 });
    smudge(p, 'L_top', 0.55, 0.5, 0.25, 0.35, 0.3);
    p.fill('swatch', '#ffffff');
    void crossPattee; void rgb;
  },
};
