import * as THREE from 'three';
import { box, cyl, disc, mat, rgb, torus, v3 } from '../geo';
import type { Kit } from '../kit';
import { buildFuselage, Fuselage, type FusKey } from '../fuselage';
import {
  COL, aldis, coaming, controlColumn, exhaustPipe, figure, fitting, instrumentBoard, landingGear, muzzleFlash,
  propeller, rigWire, ringSight, tailSkid, tailSurface, throttleBox, vickers, windscreen, wingPair, woodStrut,
} from '../parts';
import { axleY, groundY, type Design, type DesignMeta } from '../design';
import {
  C, Painter, blobCamo, frRoundel, fusRect, mud, smudge, soot, streaks, text, usRoundel, type FusMeta,
} from '../livery';
import { roundedEdge } from '../panel';

/**
 * SPAD S.XIII — Hispano-Suiza 8B V8 behind a round frontal radiator with
 * shutters, the geared engine putting the propeller shaft high on the nose.
 * Square-tipped wings with the "false two-bay" look: intermediate struts
 * where the bracing wires cross. Ailerons on the upper wing only.
 */

const GEAR = 1.5;
const U_LE = -0.5;
const L_LE = U_LE + 0.25;
const U_C = 1.25;
const L_C = 1.2;
const U_HALF = 4.125;
const L_HALF = 3.9;
const U_Y = 0.98;
const L_Y = -0.5;

const KEYS: FusKey[] = [
  { z: -1.72, w: 0.4, top: 0.44, bot: -0.36, sh: 0.04, nt: 2, nb: 2 },
  { z: -1.35, w: 0.415, top: 0.45, bot: -0.43, sh: 0.06, nt: 2.1, nb: 2.5 },
  { z: -0.85, w: 0.41, top: 0.42, bot: -0.48, sh: 0.14, nt: 2.2, nb: 5, hump: 0.07, hw: 0.24 },
  { z: -0.3, w: 0.4, top: 0.38, bot: -0.5, sh: 0.24, nt: 2, nb: 7, hump: 0.1, hw: 0.25 },
  { z: 0.3, w: 0.39, top: 0.365, bot: -0.49, sh: 0.25, nt: 2, nb: 8, hump: 0.04, hw: 0.24 },
  { z: 0.45, w: 0.388, top: 0.36, bot: -0.485, sh: 0.25, nt: 2, nb: 8, hump: 0 },
  { z: 1.5, w: 0.33, top: 0.33, bot: -0.41, sh: 0.22, nt: 2, nb: 8 },
  { z: 2.8, w: 0.18, top: 0.26, bot: -0.28, sh: 0.15, nt: 2, nb: 8 },
  { z: 3.92, w: 0.012, top: 0.2, bot: -0.16, sh: 0.08, nt: 2, nb: 8 },
];
const FUS = new Fuselage(KEYS);
const COCKPIT = { z0: 0.48, z1: 1.14, hw: 0.28 };
const EYE = v3(0, 0.74, 0.84);
const RIBS = Array.from({ length: 16 }, (_, i) => 0.05 + i * 0.28);
const HUB = v3(0, 0.14, -1.86);
const RAD = v3(0, 0.04, -1.72);

export const spad: Design = {
  id: 'spad',
  liveries: ['standard', 'usas', 'escadrille'],

  build(k: Kit): DesignMeta {
    const at = k.atlas;
    const fm = (side: 'R' | 'L'): Record<string, unknown> => ({ fus: FUS, side, fabricFrom: 0.45, panelSeams: [-1.72, -1.3, -0.85, -0.35, 0.45], formers: [1.2, 1.9, 2.6, 3.3], stringerArcs: [0, 0.08, 0.16, 0.24, 0.32, 0.4] } satisfies FusMeta as unknown as Record<string, unknown>);
    const f = buildFuselage(FUS, { keys: KEYS, openings: [COCKPIT], right: at.region('fus_R', 'fus', fm('R')), left: at.region('fus_L', 'fus', fm('L')), dz: k.n(0.07, 0.3, 0.9), m: k.n(18, 7, 4), capFront: true }, COL.interior);
    k.skin(f.outer, 'static', 'fus');
    if (k.detail === 0) {
      for (const t of f.tubs) k.props(t, 'interior');
      for (const r of f.rims) coaming(k, r);
    }

    // ---- nose: round radiator, shutters, filler cap, cowl louvres
    k.props(disc(0.34, k.n(32, 12, 6), rgb('#7d766a')).transform(mat([RAD.x, RAD.y, RAD.z - 0.012], [0, Math.PI, 0])), 'radiator', 'static', 'fus');
    if (k.detail === 0) {
      k.props(torus(0.36, 0.028, 40, 8, COL.darkSteel).transform(mat([RAD.x, RAD.y, RAD.z - 0.01])), 'paint');
      // Vertical shutter slats across the centre of the radiator.
      for (let q = -4; q <= 4; q++) {
        const x = q * 0.052;
        const h = Math.sqrt(Math.max(0, 0.33 * 0.33 - x * x)) * 2 * 0.92;
        // Half-open vertical shutters, like a venetian blind turned on its side.
        k.props(box(0.048, h, 0.004, rgb('#2a2a26')).transform(mat([x, RAD.y, RAD.z - 0.035], [0, 0.85, 0])), 'paint');
      }
      k.props(cyl(0.035, 0.035, 0, 0.06, 10, COL.brass).transform(new THREE.Matrix4().makeRotationX(-Math.PI / 2)).transform(mat([0, 0.44, -1.62])), 'brass');
      // Louvres on the side cowl panels.
      for (const s of [1, -1]) {
        const g = box(0.004, 0.16, 0.3, rgb('#4a4a3c'));
        k.props(g.transform(mat([s * 0.415, 0.02, -1.15])), 'louvre');
      }
    }
    // Exhaust stubs out of the lower cowl, long pipes along the fuselage sides.
    for (const s of [1, -1]) {
      exhaustPipe(k, [v3(s * 0.33, -0.2, -1.4), v3(s * 0.43, -0.28, -1.25), v3(s * 0.43, -0.34, -0.6), v3(s * 0.42, -0.36, -0.25)], 0.032);
    }

    // ---- wings: upper with ailerons and a centre cut-out, lower plain
    const upper = wingPair(k, {
      name: 'U', origin: v3(0, U_Y, U_LE), dihedral: 0.02, incidence: 0.03, s0: 0, s1: U_HALF,
      le: roundedEdge(0, U_HALF, 0.08, -1),
      te: (s) => {
        const cut = s < 0.26 ? 0.3 : s < 0.4 ? 0.3 * Math.cos(((s - 0.26) / 0.14) * Math.PI * 0.5) : 0;
        return roundedEdge(U_C, U_HALF, 0.14, 1)(s) - cut;
      },
      tc: 0.058, camber: 0.04, ribs: RIBS, scallop: 0.011,
      aileron: { s0: 2.35, s1: U_HALF, x: () => U_C - 0.36 }, leSheet: 0.1, hit: 'wingU', tipZone: 0.2,
    });
    const lower = wingPair(k, {
      name: 'L', origin: v3(0, L_Y, L_LE), dihedral: 0.045, incidence: 0.03, s0: 0.3, s1: L_HALF,
      le: roundedEdge(0, L_HALF, 0.08, -1), te: roundedEdge(L_C, L_HALF, 0.14, 1),
      tc: 0.058, camber: 0.04, ribs: RIBS, scallop: 0.011, capRoot: true, leSheet: 0.1, hit: 'wingL', tipZone: 0.2,
    });
    const SI = 3.15, SM = 1.75;
    for (const side of [1, -1] as const) {
      for (const x of [0.2, 0.95]) {
        const a = upper.at(SI, x, false, side), b = lower.at(SI, x * (L_C / U_C) + 0.02, true, side);
        woodStrut(k, b, a, 0.09, COL.wood, 0.3, 'wingU');
        fitting(k, a); fitting(k, b);
        // Intermediate struts where the wires cross: the SPAD's "false two-bay".
        woodStrut(k, lower.at(SM, x * (L_C / U_C) + 0.02, true, side), upper.at(SM, x, false, side), 0.05, COL.wood, 0.3);
      }
      const cf = upper.at(0.3, 0.2, false, side), cr = upper.at(0.3, 0.95, false, side);
      woodStrut(k, v3(side * 0.34, 0.32, -0.62), cf, 0.06, COL.wood, 0.4, 'fus');
      woodStrut(k, v3(side * 0.34, 0.33, -0.62), cr, 0.06, COL.wood, 0.4, 'fus');
      woodStrut(k, v3(side * 0.34, 0.34, 0.25), cr, 0.05, COL.wood, 0.4, 'fus');
      for (const x of [0.2, 0.95]) {
        rigWire(k, lower.at(0.45, x, true, side), upper.at(SI - 0.05, x, false, side), true);
        rigWire(k, upper.at(0.35, x, false, side), lower.at(SI - 0.05, x, true, side), false);
      }
    }

    // ---- tail
    tailSurface(k, {
      name: 'TP', origin: v3(0, 0.215, 0), s0: 0, s1: 1.5, hit: 'tail',
      le: (s) => 3.25 + 0.12 * (s / 1.5) + (s > 1.2 ? 0.45 * (1 - Math.sqrt(Math.max(0, 1 - ((s - 1.2) / 0.3) ** 2))) : 0),
      te: (s) => roundedEdge(4.25, 1.5, 0.3, 1)(s) - (s < 0.2 ? (1 - s / 0.2) * 0.4 : 0),
      ribs: [0.2, 0.45, 0.7, 0.95, 1.2], hinge: { x: () => 3.82, s0: 0.03, s1: 1.5 },
    });
    tailSurface(k, {
      name: 'fin', origin: v3(0, 0.2, 0), s0: 0, s1: 0.55, vertical: true, hit: 'tail',
      le: (s) => 3.45 + 0.44 * Math.pow(s / 0.55, 0.8), te: () => 3.9, ribs: [0.2, 0.4],
    });
    tailSurface(k, {
      name: 'rud', origin: v3(0, -0.2, 0), s0: 0, s1: 1.18, vertical: true, moving: true, hit: 'tail',
      le: () => 3.9,
      te: (s) => 3.9 + 0.45 * Math.sqrt(Math.max(0, 1 - ((s - 0.45) / (s < 0.45 ? 0.45 : 0.73)) ** 2)),
      ribs: [0.25, 0.5, 0.75, 1.0], hinge: { x: () => 3.9, s0: 0, s1: 1.18 },
    });
    for (const side of [1, -1]) {
      rigWire(k, v3(0, 0.74, 3.86), v3(side * 0.9, 0.235, 3.7));
      rigWire(k, v3(side * 0.04, -0.17, 3.8), v3(side * 0.9, 0.2, 3.7));
    }

    // ---- undercarriage
    const az = -0.78, r = 0.36;
    landingGear(k, {
      track: 1.5, y: axleY(az, GEAR, r), z: az, r, tyre: 0.042,
      front: v3(0.3, -0.44, -1.05), rear: v3(0.33, -0.5, -0.2), apexX: 0.58, hit: 'fus',
      strutCol: rgb('#2d2c28'), strutRegion: 'paint',
    });
    tailSkid(k, v3(0, -0.24, 3.15), v3(0, groundY(3.9, GEAR) + 0.01, 3.9), 0.13);

    // ---- propeller
    propeller(k, { hub: HUB, R: 1.275, blades: 2, chord: 0.2, pitch: 2.6, id: 0 });

    // ---- guns, sights
    const muzzles: THREE.Vector3[] = [];
    for (const side of [-1, 1] as const) muzzles.push(vickers(k, v3(side * 0.1, 0.52, 0.4), { left: side < 0 }));
    muzzles.forEach((m, i) => muzzleFlash(k, m, `flash${i}`));
    aldis(k, v3(0, 0.64, 0.5), v3(0, 0.63, -0.2));
    ringSight(k, v3(0, EYE.y, 0.18), v3(0, EYE.y, -0.5), 0.06);
    windscreen(k, v3(0, 0.55, 0.47), 0.34, 0.15, 0.5);

    k.node('cockpit', EYE, { flags: { cockpit: true } });
    instrumentBoard(k, FUS, 0.42, -0.05, 0.42, [
      { dial: 'rpm', x: 0, y: 0.24, r: 0.046 },
      { dial: 'alt', x: -0.14, y: 0.2, r: 0.04 },
      { dial: 'clock', x: 0.14, y: 0.2, r: 0.035 },
      { dial: 'oil', x: -0.24, y: 0.09, r: 0.03 },
      { dial: 'air', x: 0.24, y: 0.09, r: 0.03 },
      { dial: 'level', x: 0, y: 0.08, r: 0.028 },
    ]);
    controlColumn(k, v3(0, -0.45, 0.72), v3(0, 0.1, 0.62));
    throttleBox(k, v3(-0.32, 0.12, 0.8));

    const pilot = figure(k, { eye: EYE, node: 'pilot', headNode: 'head', flags: { pilot: true } });
    return {
      eye: EYE.clone(), muzzles, gunnerMount: null,
      exhausts: [v3(0.42, -0.36, -0.25), v3(-0.42, -0.36, -0.25)],
      engines: [v3(0, 0.05, -1.2)],
      spinners: [{ node: 'prop0', kind: 'prop', dir: 1 }, { node: 'disc0', kind: 'disc', dir: 1 }],
      scarf: { node: 'pilot', anchor: pilot.neck, color: COL.silk },
      deflect: { elevator: 0.42, aileron: 0.3, rudder: 0.45 },
      gunner: null, flashes: muzzles.map((_, i) => `flash${i}`),
    };
  },

  paint(p: Painter, livery: string): void {
    const camo = ['#ae976a', '#6c7646', '#3c4a2c', '#5c3e25', '#22201c'];
    const under = '#c9bb96';
    let seed = 40;
    for (const n of ['U_top', 'L_top', 'TP_top', 'fin_L', 'fin_R', 'rud_L', 'rud_R']) blobCamo(p, n, camo, 0.95, seed++, [1, 1, 1.05, 1, 0.84]);
    for (const side of ['R', 'L'] as const) {
      blobCamo(p, `fus_${side}`, camo, 0.9, seed++, [1, 1, 1.05, 1, 0.84]);
      p.on(`fus_${side}`, (ctx) => {
        // Clear-doped belly below the lower longerons.
        ctx.fillStyle = under;
        ctx.beginPath();
        const U = (z: number): number => (side === 'R' ? FUS.z1 - z : z - FUS.z0);
        for (let z = FUS.z0; z <= FUS.z1 + 0.01; z += 0.05) {
          const v = FUS.arcAt(z, FUS.param('bot', z) + 0.035);
          if (z === FUS.z0) ctx.moveTo(U(z), v); else ctx.lineTo(U(z), v);
        }
        ctx.lineTo(U(FUS.z1), 3); ctx.lineTo(U(FUS.z0), 3); ctx.closePath(); ctx.fill();
      });
      p.surface(`fus_${side}`, 0.48, 0, fusRect(FUS, side, FUS.z0, 0.45));
    }
    for (const n of ['U_bot', 'L_bot', 'TP_bot']) p.fill(n, under);
    for (const n of ['U_top', 'L_top', 'fus_R', 'fus_L', 'U_bot', 'L_bot']) p.grime(n, 0.18);
    p.fill('wheel', '#3d4a2c');

    const us = livery === 'usas';
    const mark = us ? usRoundel : frRoundel;
    p.on('U_top', (ctx) => mark(ctx, 3.25, 0.62, 0.52));
    p.on('L_bot', (ctx) => mark(ctx, 3.0, 0.6, 0.5));
    // Rudder tricolour: blue at the post for France, red for the USAS.
    const stripes = us ? [C.usRed, C.white, C.usBlue] : [C.frBlue, C.white, C.frRed];
    for (const side of ['rud_L', 'rud_R']) {
      p.on(side, (ctx) => {
        const h = 0.45 / 3;
        stripes.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect(-1, i === 0 ? 3.8 : 3.9 + i * h, 3, i === 2 ? 1 : h + (i === 0 ? 0.1 : 0)); });
        const right: [number, number] = side === 'rud_L' ? [0, 1] : [0, -1];
        text(ctx, us ? 'S.7714' : 'S.4523', 0.75, 3.9 + h * 1.5, 0.04, C.black, { right, down: [-1, 0] });
      });
    }
    const fusAt = (side: 'R' | 'L', z: number, y: number): [number, number] => [side === 'R' ? FUS.z1 - z : z - FUS.z0, FUS.arcAt(z, y)];
    for (const side of ['R', 'L'] as const) {
      p.on(`fus_${side}`, (ctx) => {
        const [x, y] = fusAt(side, 2.1, -0.02);
        if (us) {
          // 94th Aero: Uncle Sam's hat tossed through a ring.
          ctx.save();
          ctx.translate(x, y);
          ctx.strokeStyle = C.usRed; ctx.lineWidth = 0.05;
          ctx.beginPath(); ctx.ellipse(0, 0, 0.3, 0.26, 0.25, 0, Math.PI * 2); ctx.stroke();
          ctx.rotate(side === 'R' ? -0.35 : 0.35);
          // Brim, crown in stripes, a blue band with stars.
          ctx.fillStyle = C.white;
          ctx.beginPath(); ctx.ellipse(0, 0.12, 0.2, 0.045, 0, 0, Math.PI * 2); ctx.fill();
          for (let q = 0; q < 5; q++) { ctx.fillStyle = q % 2 ? C.white : C.usRed; ctx.fillRect(-0.11 + q * 0.044, -0.2, 0.044, 0.3); }
          ctx.fillStyle = C.usBlue; ctx.fillRect(-0.11, 0.02, 0.22, 0.07);
          ctx.fillStyle = C.white;
          for (let q = 0; q < 3; q++) { ctx.beginPath(); ctx.arc(-0.07 + q * 0.07, 0.055, 0.012, 0, Math.PI * 2); ctx.fill(); }
          ctx.restore();
          const [nx, ny] = fusAt(side, 1.3, 0.0);
          text(ctx, '1', nx, ny, 0.34, C.white, { stroke: C.black });
        } else if (livery === 'escadrille') {
          // Les Cigognes: a white stork in flight, wings raised, legs trailing.
          ctx.save();
          ctx.translate(x, y);
          ctx.scale(side === 'L' ? -1.5 : 1.5, 1.5);
          ctx.fillStyle = C.white;
          ctx.beginPath();
          // Body and neck (beak to the right = forward on the starboard side).
          ctx.ellipse(-0.02, 0, 0.13, 0.035, -0.05, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(0.09, -0.01); ctx.quadraticCurveTo(0.18, -0.03, 0.24, -0.02);
          ctx.lineTo(0.24, 0.0); ctx.quadraticCurveTo(0.17, 0.0, 0.09, 0.02); ctx.fill();
          ctx.beginPath(); ctx.arc(0.245, -0.012, 0.018, 0, Math.PI * 2); ctx.fill();
          // Near wing swept up, far wing down, black primaries.
          for (const [dy, tip] of [[-1, -0.24], [1, 0.2]] as const) {
            ctx.fillStyle = C.white;
            ctx.beginPath();
            ctx.moveTo(-0.06, 0); ctx.quadraticCurveTo(-0.02, tip * 0.6, 0.06, tip); ctx.lineTo(0.12, tip + dy * -0.01);
            ctx.quadraticCurveTo(0.05, tip * 0.4, 0.04, 0); ctx.closePath(); ctx.fill();
            ctx.fillStyle = C.black;
            ctx.beginPath(); ctx.moveTo(0.02, tip * 0.8); ctx.lineTo(0.06, tip); ctx.lineTo(0.12, tip + dy * -0.01); ctx.lineTo(0.07, tip * 0.75); ctx.closePath(); ctx.fill();
          }
          // Beak and legs in red-orange.
          ctx.strokeStyle = '#c4501e'; ctx.lineWidth = 0.008;
          ctx.beginPath(); ctx.moveTo(0.26, -0.012); ctx.lineTo(0.33, -0.006); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(-0.13, 0.005); ctx.lineTo(-0.3, 0.02); ctx.moveTo(-0.13, 0.012); ctx.lineTo(-0.29, 0.035); ctx.stroke();
          ctx.restore();
          const [nx, ny] = fusAt(side, 1.25, 0.0);
          text(ctx, '3', nx, ny, 0.3, C.white, { stroke: C.black });
        } else {
          const [nx, ny] = fusAt(side, 1.8, 0.0);
          text(ctx, '12', nx, ny, 0.3, C.white, { stroke: C.black });
        }
        const [dx, dy] = fusAt(side, 0.7, -0.33);
        text(ctx, 'SPAD XIII', dx, dy, 0.03, 'rgba(20,18,15,0.8)', {});
      });
    }
    // Weathering: exhaust soot and oil along the lower sides behind the stubs.
    for (const side of ['R', 'L'] as const) {
      const [x0, v0] = fusAt(side, -0.25, -0.34);
      soot(p, `fus_${side}`, x0 + (side === 'R' ? -0.5 : 0.5), v0, 0.75, 0.12, 0.6);
      streaks(p, `fus_${side}`, side === 'R' ? x0 - 1.4 : x0, side === 'R' ? x0 : x0 + 1.4, v0 - 0.12, v0 + 0.08, side === 'R' ? -1 : 1, 1.2, { count: 60, alpha: 0.35, seed: 31 });
      const [hx, hy] = fusAt(side, 0.8, 0.28);
      smudge(p, `fus_${side}`, hx, hy, 0.2, 0.08, 0.25);
      mud(p, `fus_${side}`, 0, 7, v0 + 0.1, v0 + 0.45, 80, 13);
    }
    mud(p, 'L_bot', 0.3, 1.5, 0, 1.2, 110, 14);
    p.fill('swatch', '#ffffff');
  },
};
