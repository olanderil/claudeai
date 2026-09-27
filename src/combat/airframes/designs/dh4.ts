import * as THREE from 'three';
import { box, cyl, mat, rgb, v3 } from '../geo';
import type { Kit } from '../kit';
import { buildFuselage, Fuselage, type FusKey } from '../fuselage';
import {
  COL, aldis, coaming, controlColumn, exhaustPipe, figure, fitting, gunRing, instrumentBoard, landingGear, muzzleFlash,
  propeller, radiator, rigWire, ringSight, tailSkid, tailSurface, throttleBox, vickers, windscreen, wingPair, woodStrut,
} from '../parts';
import { axleY, groundY, type Design, type DesignMeta } from '../design';
import { C, Painter, fusRect, mud, rfcRoundel, smudge, soot, streaks, text, type FusMeta } from '../livery';
import { roundedEdge } from '../panel';

/**
 * Airco DH.4 — Rolls-Royce Eagle behind a tall flat radiator, four-bladed
 * propeller, two-bay wings of 12.9 m, the pilot under the centre section and
 * the observer far aft (the fuel tank between them was the type's notorious
 * flaw) on a Scarff ring with a Lewis. One Vickers for the pilot, to port.
 */

const GEAR = 1.9;
const U_LE = -0.68, L_LE = U_LE + 0.35;
const CH = 1.68;
const HALF = 6.46;
const U_Y = 1.18, L_Y = -0.52;
const DIH = (2 * Math.PI) / 180;

const KEYS: FusKey[] = [
  { z: -2.72, w: 0.34, top: 0.45, bot: -0.45, sh: 0.0, nt: 5, nb: 5 },
  { z: -2.2, w: 0.4, top: 0.5, bot: -0.57, sh: 0.2, nt: 3, nb: 8 },
  { z: -1.0, w: 0.43, top: 0.5, bot: -0.6, sh: 0.3, nt: 2.4, nb: 9 },
  { z: 0.0, w: 0.43, top: 0.48, bot: -0.6, sh: 0.32, nt: 2.3, nb: 9 },
  { z: 1.5, w: 0.41, top: 0.46, bot: -0.55, sh: 0.3, nt: 2.3, nb: 9 },
  { z: 2.7, w: 0.36, top: 0.42, bot: -0.49, sh: 0.28, nt: 2.3, nb: 9 },
  { z: 4.3, w: 0.2, top: 0.33, bot: -0.32, sh: 0.22, nt: 2.3, nb: 9 },
  { z: 5.95, w: 0.012, top: 0.26, bot: -0.18, sh: 0.15, nt: 2.3, nb: 9 },
];
const FUS = new Fuselage(KEYS);
const PILOT = { z0: 0.1, z1: 0.78, hw: 0.3 };
const OBS = { z0: 1.92, z1: 2.8, hw: 0.36 };
const EYE = v3(0, 0.92, 0.47);
const RIBS = Array.from({ length: 21 }, (_, i) => 0.05 + i * 0.32);

export const dh4: Design = {
  id: 'dh4',
  liveries: ['standard', 'naval'],

  build(k: Kit): DesignMeta {
    const at = k.atlas;
    const fm = (side: 'R' | 'L'): Record<string, unknown> => ({ fus: FUS, side, fabricFrom: -0.9, panelSeams: [-2.72, -2.2, -1.6, -0.9], formers: [-0.3, 0.6, 1.5, 2.4, 3.3, 4.2, 5.1], stringerArcs: [0, 0.08, 0.16, 0.24, 0.32] } satisfies FusMeta as unknown as Record<string, unknown>);
    const f = buildFuselage(FUS, { keys: KEYS, openings: [PILOT, OBS], right: at.region('fus_R', 'fus', fm('R')), left: at.region('fus_L', 'fus', fm('L')), dz: k.n(0.09, 0.4, 1.2), m: k.n(16, 7, 4), capFront: true }, COL.interior);
    k.skin(f.outer, 'static', 'fus');
    if (k.detail === 0) {
      for (const t of f.tubs) k.props(t, 'interior');
      for (const r of f.rims) coaming(k, r);
    }
    // Tall flat radiator across the nose, filler cap, exhaust stacks each side.
    radiator(k, v3(0, 0.0, -2.73), 0.6, 0.84, 0.06);
    if (k.detail === 0) k.props(cyl(0.035, 0.035, 0, 0.07, 10, COL.brass).transform(new THREE.Matrix4().makeRotationX(-Math.PI / 2)).transform(mat([0, 0.44, -2.62])), 'brass');
    const stacks: THREE.Vector3[] = [];
    for (const s of [1, -1]) {
      for (const z of [-2.0, -1.45]) {
        exhaustPipe(k, [v3(s * 0.4, 0.2, z), v3(s * 0.46, 0.3, z + 0.05), v3(s * 0.46, 0.78, z + 0.12)], 0.04);
        stacks.push(v3(s * 0.46, 0.78, z + 0.12));
      }
      if (k.detail === 0) k.props(box(0.004, 0.2, 0.9, rgb('#3f3f36')).transform(mat([s * 0.43, 0.05, -1.7])), 'louvre');
    }

    // ---- two-bay wings
    const upper = wingPair(k, {
      name: 'U', origin: v3(0, U_Y, U_LE), dihedral: DIH, incidence: 0.03, s0: 0, s1: HALF,
      le: roundedEdge(0, HALF, 0.12, -1),
      te: (s) => roundedEdge(CH, HALF, 0.55, 1)(s) - (s < 0.3 ? 0.45 : s < 0.46 ? 0.45 * Math.cos(((s - 0.3) / 0.16) * Math.PI * 0.5) : 0),
      tc: 0.06, camber: 0.045, ribs: RIBS, scallop: 0.013,
      aileron: { s0: 3.9, s1: HALF, x: () => CH - 0.45 }, leSheet: 0.12, hit: 'wingU', tipZone: 0.55,
    });
    const lower = wingPair(k, {
      name: 'L', origin: v3(0, L_Y, L_LE), dihedral: DIH, incidence: 0.03, s0: 0.4, s1: HALF,
      le: roundedEdge(0, HALF, 0.12, -1), te: roundedEdge(CH, HALF, 0.55, 1),
      tc: 0.06, camber: 0.045, ribs: RIBS, scallop: 0.013, capRoot: true,
      aileron: { s0: 3.9, s1: HALF, x: () => CH - 0.45 }, leSheet: 0.12, hit: 'wingL', tipZone: 0.55,
    });
    for (const side of [1, -1] as const) {
      let inner = 0.45;
      for (const SI of [2.7, 5.45]) {
        for (const x of [0.25, 1.2]) {
          const a = upper.at(SI, x, false, side), b = lower.at(SI, x, true, side);
          woodStrut(k, b, a, 0.1, COL.wood, 0.3, undefined);
          fitting(k, a); fitting(k, b);
          rigWire(k, lower.at(inner, x, true, side), upper.at(SI - 0.05, x, false, side), true);
          rigWire(k, upper.at(inner, x, false, side), lower.at(SI - 0.05, x, true, side), false);
        }
        inner = SI;
      }
      for (const x of [0.25, 1.2]) woodStrut(k, v3(side * 0.36, 0.44, U_LE + x - 0.12), upper.at(0.32, x, false, side), 0.07, COL.wood, 0.4, 'fus');
    }

    // ---- tail
    tailSurface(k, {
      name: 'TP', origin: v3(0, 0.27, 0), s0: 0, s1: 1.95, hit: 'tail',
      le: (s) => 4.85 + 0.25 * (s / 1.95) ** 2 + (s > 1.6 ? 0.55 * (1 - Math.sqrt(Math.max(0, 1 - ((s - 1.6) / 0.35) ** 2))) : 0),
      te: (s) => roundedEdge(6.25, 1.95, 0.35, 1)(s) - (s < 0.24 ? (1 - s / 0.24) * 0.45 : 0),
      ribs: [0.25, 0.55, 0.85, 1.15, 1.45, 1.75], hinge: { x: () => 5.75, s0: 0.03, s1: 1.95 },
    });
    tailSurface(k, {
      name: 'fin', origin: v3(0, 0.25, 0), s0: 0, s1: 0.82, vertical: true, hit: 'tail',
      le: (s) => 5.15 + 0.75 * Math.pow(s / 0.82, 0.8), te: () => 5.95, ribs: [0.25, 0.5, 0.75],
    });
    tailSurface(k, {
      name: 'rud', origin: v3(0, -0.28, 0), s0: 0, s1: 1.48, vertical: true, moving: true, hit: 'tail',
      le: () => 5.95, te: (s) => 5.95 + 0.47 * Math.sqrt(Math.max(0, 1 - ((s - 0.6) / (s < 0.6 ? 0.6 : 0.88)) ** 2)),
      ribs: [0.3, 0.6, 0.9, 1.2], hinge: { x: () => 5.95, s0: 0, s1: 1.48 },
    });
    for (const side of [1, -1]) {
      rigWire(k, v3(0, 1.02, 5.9), v3(side * 1.2, 0.29, 5.6));
      rigWire(k, v3(side * 0.05, -0.17, 5.8), v3(side * 1.2, 0.25, 5.6));
    }

    // ---- undercarriage
    const az = -1.15, r = 0.43;
    landingGear(k, {
      track: 1.95, y: axleY(az, GEAR, r), z: az, r, tyre: 0.05,
      front: v3(0.36, -0.56, -1.75), rear: v3(0.38, -0.6, -0.55), apexX: 0.78, hit: 'gear',
    });
    tailSkid(k, v3(0, -0.24, 5.2), v3(0, groundY(5.85, GEAR) + 0.01, 5.85), 0.15);

    propeller(k, { hub: v3(0, 0.2, -2.86), R: 1.52, blades: 4, chord: 0.18, pitch: 3.0, id: 0 });

    // ---- pilot's Vickers to port, sights
    const muzzle = vickers(k, v3(-0.22, 0.56, -0.05), { left: true });
    muzzleFlash(k, muzzle, 'flash0');
    aldis(k, v3(-0.07, 0.75, 0.15), v3(-0.07, 0.74, -0.45));
    ringSight(k, v3(0, EYE.y, -0.12), v3(0, EYE.y - 0.03, -0.9), 0.06);
    windscreen(k, v3(0, 0.62, 0.08), 0.4, 0.2, 0.45);
    k.node('cockpit', EYE, { flags: { cockpit: true } });
    instrumentBoard(k, FUS, 0.06, -0.05, 0.56, [
      { dial: 'rpm', x: 0.02, y: 0.3, r: 0.05 },
      { dial: 'alt', x: -0.16, y: 0.26, r: 0.042 },
      { dial: 'asi', x: 0.2, y: 0.26, r: 0.042 },
      { dial: 'clock', x: -0.28, y: 0.14, r: 0.032 },
      { dial: 'oil', x: 0.3, y: 0.14, r: 0.032 },
      { dial: 'air', x: -0.1, y: 0.12, r: 0.03 },
      { dial: 'level', x: 0.1, y: 0.12, r: 0.03 },
    ]);
    controlColumn(k, v3(0, -0.5, 0.52), v3(0, 0.14, 0.4));
    throttleBox(k, v3(-0.36, 0.2, 0.55));
    const pilot = figure(k, { eye: EYE, node: 'pilot', headNode: 'head', flags: { pilot: true } });

    // ---- observer on the Scarff ring
    const ring = gunRing(k, { centre: v3(0, 0.47, 2.36), R: 0.43, gun: 'lewis', yaw: 'gunYaw', pitch: 'gunPitch', flash: 'gflash', eyeUp: 0.52 });
    return {
      eye: EYE.clone(), muzzles: [muzzle], gunnerMount: ring.pivot,
      exhausts: stacks, engines: [v3(0, 0.1, -1.8)],
      spinners: [{ node: 'prop0', kind: 'prop', dir: 1 }, { node: 'disc0', kind: 'disc', dir: 1 }],
      scarf: { node: 'pilot', anchor: pilot.neck, color: COL.silk },
      deflect: { elevator: 0.4, aileron: 0.3, rudder: 0.4 },
      gunner: { yaw: 'gunYaw', pitch: 'gunPitch', flash: 'gflash' },
      flashes: ['flash0'],
    };
  },

  paint(p: Painter, livery: string): void {
    const naval = livery === 'naval';
    const upper = naval ? '#5f6656' : C.pc10;
    const under = C.cdl;
    for (const n of ['U_top', 'L_top', 'TP_top', 'fin_L', 'fin_R']) { p.fill(n, upper); p.grime(n, 0.22); }
    for (const n of ['U_bot', 'L_bot', 'TP_bot']) { p.fill(n, under); p.grime(n, 0.12); }
    p.fill('wheel', upper);
    p.on('U_top', (ctx) => rfcRoundel(ctx, 5.0, 0.84, 0.72));
    p.on('L_bot', (ctx) => rfcRoundel(ctx, 5.0, 0.84, 0.72, false));
    for (const side of ['rud_L', 'rud_R']) p.on(side, (ctx) => {
      const h = 0.47 / 3;
      ctx.fillStyle = C.rfcBlue; ctx.fillRect(-1, 5.85, 3, h + 0.1);
      ctx.fillStyle = C.white; ctx.fillRect(-1, 5.95 + h, 3, h);
      ctx.fillStyle = C.rfcRed; ctx.fillRect(-1, 5.95 + 2 * h, 3, 1);
      const right: [number, number] = side === 'rud_L' ? [0, 1] : [0, -1];
      text(ctx, naval ? 'N6000' : 'A7853', 0.85, 5.95 + h * 1.5, 0.045, C.black, { right, down: [-1, 0] });
    });
    const fusAt = (side: 'R' | 'L', z: number, y: number): [number, number] => [side === 'R' ? FUS.z1 - z : z - FUS.z0, FUS.arcAt(z, y)];
    for (const side of ['R', 'L'] as const) {
      const name = `fus_${side}`;
      p.on(name, (ctx, r) => {
        ctx.fillStyle = upper;
        ctx.fillRect(r.u0 - 1, r.v0 - 1, r.u1 - r.u0 + 2, r.v1 - r.v0 + 2);
        ctx.fillStyle = under;
        ctx.beginPath();
        const U = (z: number): number => (side === 'R' ? FUS.z1 - z : z - FUS.z0);
        for (let z = FUS.z0; z <= FUS.z1 + 0.01; z += 0.05) {
          const v = FUS.arcAt(z, FUS.param('bot', z) + 0.04);
          if (z === FUS.z0) ctx.moveTo(U(z), v); else ctx.lineTo(U(z), v);
        }
        ctx.lineTo(U(FUS.z1), 3); ctx.lineTo(U(FUS.z0), 3); ctx.closePath(); ctx.fill();
        // Engine cowling panels: grey-painted metal.
        const [a] = fusAt(side, -2.75, 0), [b] = fusAt(side, -0.9, 0);
        ctx.fillStyle = naval ? '#555c4e' : '#4a4a40';
        ctx.fillRect(Math.min(a, b), -1, Math.abs(b - a), 4);
      });
      p.grime(name, 0.24);
      p.surface(name, 0.45, 0, fusRect(FUS, side, -3, -0.9));
      p.on(name, (ctx) => {
        const [x, y] = fusAt(side, 3.5, 0.0);
        rfcRoundel(ctx, x, y, 0.36);
        const [sx, sy] = fusAt(side, 4.6, -0.02);
        text(ctx, naval ? 'N6000' : 'A7853', sx, sy, 0.13, naval ? C.black : C.white, {});
        const [lx, ly] = fusAt(side, 1.3, 0.0);
        text(ctx, naval ? 'N' : 'D', lx, ly, 0.3, C.white, {});
      });
      const [x0, v0] = fusAt(side, -1.4, 0.3);
      soot(p, name, side === 'R' ? x0 - 0.6 : x0 + 0.6, v0, 0.9, 0.18, 0.45);
      const [ox, ov] = fusAt(side, -1.0, -0.45);
      streaks(p, name, side === 'R' ? ox - 1.6 : ox, side === 'R' ? ox : ox + 1.6, ov - 0.1, ov + 0.1, side === 'R' ? -1 : 1, 1.3, { count: 50, alpha: 0.3, seed: 111 });
      for (const zc of [0.45, 2.36]) { const [hx, hy] = fusAt(side, zc, 0.4); smudge(p, name, hx, hy, 0.24, 0.08, 0.25); }
      mud(p, name, 0, 9, ov + 0.15, ov + 0.5, 60, 112);
    }
    mud(p, 'L_bot', 0.4, 2.2, 0, CH, 90, 113);
    p.fill('swatch', '#ffffff');
  },
};
