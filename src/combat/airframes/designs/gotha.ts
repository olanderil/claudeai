import * as THREE from 'three';
import { box, cyl, mat, rgb, torus, v3 } from '../geo';
import type { Kit } from '../kit';
import { buildFuselage, Fuselage, type FusKey } from '../fuselage';
import {
  COL, coaming, controlColumn, exhaustPipe, figure, fitting, gunRing, instrumentBoard, landingGear,
  propeller, radiator, rigWire, tailSkid, tailSurface, throttleBox, windscreen, wingPair, woodStrut,
} from '../parts';
import { axleY, groundY, type Design, type DesignMeta } from '../design';
import { C, Painter, blobCamo, crossPattee, lozenge, mud, smudge, soot, streaks, text, type FusMeta } from '../livery';
import { roundedEdge } from '../panel';

/**
 * Gotha G.V — the London raider. Two Mercedes D.IVa in nacelles slung
 * between the wings drive pusher propellers behind the trailing edge; a
 * deep box fuselage carries a nose gunner, the pilot and a rear gunner, each
 * with a Parabellum on a ring. Three-bay wings of 23.7 m, main wheels under
 * the nacelles and a pair of small nose wheels against nosing over.
 */

const GEAR = 2.6;
const U_LE = -0.75, L_LE = -0.55;
const U_C = 2.2, L_C = 2.0;
const U_HALF = 11.85, L_HALF = 10.85;
const U_Y = 1.62, L_Y = -0.66;
const NAC_X = 2.4, NAC_Y = 0.46;

const KEYS: FusKey[] = [
  { z: -4.72, w: 0.18, top: 0.2, bot: -0.3, sh: -0.04, nt: 2, nb: 2 },
  { z: -4.55, w: 0.38, top: 0.4, bot: -0.5, sh: 0.0, nt: 2.4, nb: 2.8 },
  { z: -4.1, w: 0.49, top: 0.52, bot: -0.64, sh: 0.06, nt: 2.8, nb: 4.5 },
  { z: -3.4, w: 0.54, top: 0.57, bot: -0.7, sh: 0.16, nt: 3, nb: 6 },
  { z: -2.0, w: 0.56, top: 0.6, bot: -0.72, sh: 0.32, nt: 2.6, nb: 8 },
  { z: 0.0, w: 0.56, top: 0.58, bot: -0.72, sh: 0.34, nt: 2.4, nb: 8 },
  { z: 2.5, w: 0.5, top: 0.54, bot: -0.62, sh: 0.3, nt: 2.4, nb: 8 },
  { z: 4.6, w: 0.3, top: 0.44, bot: -0.42, sh: 0.25, nt: 2.4, nb: 8 },
  { z: 7.4, w: 0.02, top: 0.34, bot: -0.2, sh: 0.2, nt: 2.4, nb: 8 },
];
const FUS = new Fuselage(KEYS);
const NOSE = { z0: -4.3, z1: -3.55, hw: 0.36 };
const PILOT = { z0: -2.9, z1: -2.05, hw: 0.4 };
const REAR = { z0: 2.3, z1: 3.2, hw: 0.4 };
// The G.V's pilot sat to port, with the gangway to the nose on his right.
const EYE = v3(-0.22, 1.12, -2.3);

const NAC_KEYS: FusKey[] = [
  { z: -2.3, w: 0.34, top: 0.44, bot: -0.4, sh: 0.0, nt: 4, nb: 4 },
  { z: -1.7, w: 0.42, top: 0.5, bot: -0.48, sh: 0.0, nt: 2.6, nb: 3 },
  { z: 0.0, w: 0.42, top: 0.48, bot: -0.48, sh: 0.0, nt: 2.4, nb: 3 },
  { z: 1.0, w: 0.3, top: 0.34, bot: -0.34, sh: 0.0, nt: 2.2, nb: 2.4 },
  { z: 1.6, w: 0.08, top: 0.1, bot: -0.1, sh: 0.0, nt: 2, nb: 2 },
];
const NAC = new Fuselage(NAC_KEYS);
const RIBS = Array.from({ length: 36 }, (_, i) => 0.05 + i * 0.34);

export const gotha: Design = {
  id: 'gotha',
  liveries: ['standard', 'day'],

  build(k: Kit): DesignMeta {
    const at = k.atlas;
    const fm = (side: 'R' | 'L', fus: Fuselage): Record<string, unknown> => ({ fus, side, fabricFrom: fus === FUS ? -3.6 : 99, panelSeams: [-2.3, -1.2, 0.4], formers: [-2.8, -1.5, 0, 1.5, 3.0, 4.5, 6.0], stringerArcs: [0, 0.1, 0.2, 0.3, 0.4] } satisfies FusMeta as unknown as Record<string, unknown>);
    const f = buildFuselage(FUS, { keys: KEYS, openings: [NOSE, PILOT, REAR], right: at.region('fus_R', 'fus', fm('R', FUS)), left: at.region('fus_L', 'fus', fm('L', FUS)), dz: k.n(0.12, 0.5, 1.5), m: k.n(16, 7, 4), capFront: true }, COL.interior);
    k.skin(f.outer, 'static', 'fus');
    if (k.detail === 0) {
      for (const t of f.tubs) k.props(t, 'interior');
      for (const r of f.rims) coaming(k, r);
    }

    // ---- nacelles with engines, radiators and pusher props
    const nac = buildFuselage(NAC, { keys: NAC_KEYS, right: at.region('nac_R', 'fus', fm('R', NAC)), left: at.region('nac_L', 'fus', fm('L', NAC)), dz: k.n(0.12, 0.5, 1.2), m: k.n(14, 6, 4) }, COL.interior);
    const engines: THREE.Vector3[] = [];
    const exhausts: THREE.Vector3[] = [];
    [1, -1].forEach((side, i) => {
      const o = v3(side * NAC_X, NAC_Y, 0);
      k.skin(nac.outer.clone().transform(mat(o)), 'static', `nac${i}`);
      radiator(k, v3(o.x, o.y + 0.02, -2.31), 0.58, 0.72, 0.05);
      // Cylinder heads along the top of the nacelle, exhaust stacks to the outboard side.
      for (let q = 0; q < 6; q++) {
        const z = -1.55 + q * 0.2;
        k.props(cyl(0.07, 0.07, 0, 0.2, k.n(12, 6, 4), COL.oily).transform(new THREE.Matrix4().makeRotationX(-Math.PI / 2)).transform(mat([o.x, o.y + 0.36, z])), 'steel', 'static', `nac${i}`);
        if (k.detail === 0) k.props(box(0.1, 0.04, 0.12, COL.darkSteel).transform(mat([o.x, o.y + 0.57, z])), 'cast');
      }
      exhaustPipe(k, [v3(o.x + side * 0.1, o.y + 0.5, -1.6), v3(o.x + side * 0.22, o.y + 0.56, -0.8), v3(o.x + side * 0.25, o.y + 0.9, -0.3)], 0.05);
      exhausts.push(v3(o.x + side * 0.25, o.y + 0.9, -0.3));
      engines.push(v3(o.x, o.y + 0.1, -0.9));
      propeller(k, { hub: v3(o.x, o.y, 1.78), R: 1.55, blades: 2, chord: 0.24, pitch: 3.2, id: i, dir: side > 0 ? 1 : -1 });
    });

    // ---- three-bay wings, the top one slightly swept
    const sweep = 0.06;
    const upper = wingPair(k, {
      name: 'U', origin: v3(0, U_Y, U_LE), dihedral: 0.015, incidence: 0.035, s0: 0, s1: U_HALF,
      le: roundedEdge(0, U_HALF, 0.2, -1, sweep), te: (s) => roundedEdge(U_C, U_HALF, 0.8, 1, sweep)(s),
      tc: 0.07, camber: 0.05, ribs: RIBS, scallop: 0.016,
      aileron: { s0: 8.3, s1: U_HALF, x: (s) => U_C - 0.55 + sweep * s }, leSheet: 0.14, hit: 'wingU', tipZone: 0.8,
    });
    const lower = wingPair(k, {
      name: 'L', origin: v3(0, L_Y, L_LE), dihedral: 0.015, incidence: 0.035, s0: 0.5, s1: L_HALF,
      le: roundedEdge(0, L_HALF, 0.2, -1), te: roundedEdge(L_C, L_HALF, 0.7, 1),
      tc: 0.07, camber: 0.05, ribs: RIBS, scallop: 0.016, capRoot: true, leSheet: 0.14, hit: 'wingL', tipZone: 0.7,
    });
    for (const side of [1, -1] as const) {
      let inner = 0.6;
      for (const SI of [NAC_X, 5.9, 9.3]) {
        for (const x of [0.3, 1.45]) {
          const a = upper.at(SI, x + sweep * SI, false, side), b = lower.at(SI, x, true, side);
          if (SI === NAC_X) {
            // Engine bearers: struts meet the nacelle top and bottom instead of spanning the gap.
            woodStrut(k, b, v3(side * NAC_X, NAC_Y - 0.4, b.z), 0.1, COL.wood, 0.3);
            woodStrut(k, v3(side * NAC_X, NAC_Y + 0.44, a.z), a, 0.1, COL.wood, 0.3);
          } else woodStrut(k, b, a, 0.11, COL.wood, 0.3, undefined);
          fitting(k, a); fitting(k, b);
          rigWire(k, lower.at(inner, x, true, side), upper.at(SI - 0.05, x + sweep * SI, false, side), true);
          rigWire(k, upper.at(inner, x + sweep * inner, false, side), lower.at(SI - 0.05, x, true, side), false);
        }
        inner = SI;
      }
      for (const x of [0.3, 1.45]) woodStrut(k, v3(side * 0.5, 0.55, U_LE + x - 0.1), upper.at(0.55, x, false, side), 0.08, COL.wood, 0.4, 'fus');
    }

    // ---- tail
    tailSurface(k, {
      name: 'TP', origin: v3(0, 0.36, 0), s0: 0, s1: 2.6, hit: 'tail',
      le: (s) => 6.1 + 0.2 * (s / 2.6) ** 2 + (s > 2.2 ? 0.6 * (1 - Math.sqrt(Math.max(0, 1 - ((s - 2.2) / 0.4) ** 2))) : 0),
      te: (s) => roundedEdge(7.72, 2.6, 0.4, 1)(s) - (s < 0.3 ? (1 - s / 0.3) * 0.5 : 0),
      ribs: [0.3, 0.7, 1.1, 1.5, 1.9, 2.3], hinge: { x: () => 7.15, s0: 0.03, s1: 2.6 },
    });
    tailSurface(k, {
      name: 'fin', origin: v3(0, 0.34, 0), s0: 0, s1: 1.2, vertical: true, hit: 'tail',
      le: (s) => 6.3 + 1.05 * Math.pow(s / 1.2, 0.8), te: () => 7.4, ribs: [0.3, 0.6, 0.9],
    });
    tailSurface(k, {
      name: 'rud', origin: v3(0, -0.3, 0), s0: 0, s1: 2.0, vertical: true, moving: true, hit: 'tail',
      le: (s) => 7.4 - (s > 1.6 ? 0.25 * Math.sin(((s - 1.6) / 0.4) * Math.PI * 0.5) : 0),
      te: (s) => 7.4 + 0.5 * Math.sqrt(Math.max(0, 1 - ((s - 0.9) / (s < 0.9 ? 0.9 : 1.1)) ** 2)),
      ribs: [0.4, 0.8, 1.2, 1.6], hinge: { x: () => 7.4, s0: 0, s1: 2.0 },
    });
    for (const side of [1, -1]) {
      rigWire(k, v3(0, 1.5, 7.3), v3(side * 1.6, 0.38, 7.0));
      rigWire(k, v3(side * 0.06, -0.2, 7.2), v3(side * 1.6, 0.34, 7.0));
    }

    // ---- main gear under each nacelle (twin wheels), nose-over wheels, skid
    const az = -1.3, r = 0.55;
    const ay = axleY(az, GEAR, r);
    k.node('wheels', v3(0, ay, az), { axis: v3(1, 0, 0) });
    for (const side of [1, -1]) {
      const cx = side * NAC_X;
      for (const dx of [-0.3, 0.3]) {
        // Tyre round a covered wheel; the tyre's outside radius is r, so it sits on the ground.
        const tyre = torus(r - 0.06, 0.06, k.n(32, 12, 8), k.n(10, 5, 3), COL.rubber).transform(new THREE.Matrix4().makeRotationY(Math.PI / 2)).transform(mat([cx + dx, ay, az]));
        k.props(tyre, 'rubber', 'wheels', 'gear');
        k.props(cyl(r - 0.1, r - 0.1, -0.06, 0.06, k.n(24, 10, 6), rgb('#3a3c38')).transform(new THREE.Matrix4().makeRotationY(Math.PI / 2)).transform(mat([cx + dx, ay, az])), 'paint', 'wheels');
      }
      k.props(cyl(0.03, 0.03, -0.45, 0.45, 8, COL.darkSteel).transform(new THREE.Matrix4().makeRotationY(Math.PI / 2)).transform(mat([cx, ay, az])), 'steel');
      for (const [dz, dx] of [[-0.5, 0.25], [0.45, 0.25], [-0.5, -0.25], [0.45, -0.25]]) {
        woodStrut(k, lower.at(NAC_X + dx, 0.5 + dz * 0.8, false, side as 1 | -1), v3(cx + dx * 0.6 * side, ay + 0.05, az), 0.09, rgb('#3b3a33'), 0.35, 'gear', 'paint');
      }
    }
    landingGear(k, {
      track: 0.9, y: -1.25, z: -4.0, r: 0.28, tyre: 0.04,
      front: v3(0.3, -0.5, -4.35), rear: v3(0.35, -0.62, -3.5), apexX: 0.35, hit: 'gear',
      strutCol: rgb('#3b3a33'), strutRegion: 'paint', node: 'noseWheels',
    });
    tailSkid(k, v3(0, -0.3, 6.3), v3(0, groundY(7.1, GEAR) + 0.01, 7.1), 0.2);

    // ---- crew: nose gunner, pilot, rear gunner
    // The nose gunner is posed facing forward; only the rear ring is animated.
    gunRing(k, { centre: v3(0, 0.5, -3.92), R: 0.4, gun: 'parabellum', yaw: 'noseYaw', pitch: 'nosePitch', flash: 'nflash', forward: true, eyeUp: 0.55, coat: rgb('#4a4a40') });
    windscreen(k, v3(0, 0.66, -3.0), 0.5, 0.18, 0.4);
    k.node('cockpit', EYE, { flags: { cockpit: true } });
    instrumentBoard(k, FUS, -2.95, -0.05, 0.6, [
      { dial: 'rpm', x: -0.12, y: 0.32, r: 0.048 },
      { dial: 'rpm', x: 0.12, y: 0.32, r: 0.048 },
      { dial: 'alt', x: -0.3, y: 0.24, r: 0.042 },
      { dial: 'asi', x: 0.3, y: 0.24, r: 0.042 },
      { dial: 'clock', x: 0, y: 0.18, r: 0.032 },
      { dial: 'level', x: 0, y: 0.08, r: 0.03 },
    ]);
    controlColumn(k, v3(0, -0.55, -2.15), v3(0, 0.2, -2.3));
    throttleBox(k, v3(-0.42, 0.24, -2.25));
    const pilot = figure(k, { eye: EYE, node: 'pilot', headNode: 'head', flags: { pilot: true }, coat: rgb('#3a3326') });
    const rear = gunRing(k, { centre: v3(0, 0.55, 2.75), R: 0.44, gun: 'parabellum', yaw: 'gunYaw', pitch: 'gunPitch', flash: 'gflash', eyeUp: 0.55, coat: rgb('#4a4a40') });

    return {
      eye: EYE.clone(), muzzles: [], gunnerMount: rear.pivot, exhausts, engines,
      spinners: [
        { node: 'prop0', kind: 'prop', dir: 1 }, { node: 'disc0', kind: 'disc', dir: 1 },
        { node: 'prop1', kind: 'prop', dir: -1 }, { node: 'disc1', kind: 'disc', dir: -1 },
      ],
      scarf: { node: 'pilot', anchor: pilot.neck, color: COL.silk },
      deflect: { elevator: 0.35, aileron: 0.28, rudder: 0.35 },
      gunner: { yaw: 'gunYaw', pitch: 'gunPitch', flash: 'gflash' },
      flashes: [], auxFlashes: ['nflash'],
    };
  },

  paint(p: Painter, livery: string): void {
    const night = ['#1e222b', '#272c3a', '#232628', '#30343f', '#1a1b20'];
    const nightLow = ['#262a34', '#2f3442', '#2a2d2f', '#383c48', '#212228'];
    const day = livery === 'day';
    const surfaces = ['U_top', 'L_top', 'TP_top', 'fin_L', 'fin_R', 'rud_L', 'rud_R', 'fus_R', 'fus_L', 'nac_R', 'nac_L'];
    const unders = ['U_bot', 'L_bot', 'TP_bot'];
    let seed = 150;
    if (day) {
      for (const n of surfaces) blobCamo(p, n, ['#5a4852', '#46503a', '#5a4852'], 0.9, seed++);
      for (const n of unders) p.fill(n, C.paleBlue);
    } else {
      for (const n of surfaces) lozenge(p, n, night, seed++, { cell: 0.26 });
      for (const n of unders) lozenge(p, n, nightLow, seed++, { cell: 0.26 });
    }
    for (const n of [...surfaces, ...unders]) p.grime(n, 0.14);
    p.fill('wheel', '#2a2d30');
    const field = 'border';
    p.on('U_top', (ctx) => crossPattee(ctx, 9.8, 1.2, 1.6, { field }));
    p.on('L_bot', (ctx) => crossPattee(ctx, 9.0, 1.0, 1.5, { field }));
    const fusAt = (side: 'R' | 'L', z: number, y: number): [number, number] => [side === 'R' ? FUS.z1 - z : z - FUS.z0, FUS.arcAt(z, y)];
    for (const side of ['R', 'L'] as const) p.on(`fus_${side}`, (ctx) => {
      const [x, y] = fusAt(side, 4.9, 0.0);
      crossPattee(ctx, x, y, 0.62, { field });
      const [sx, sy] = fusAt(side, -1.4, -0.35);
      text(ctx, 'G.V 979/16', sx, sy, 0.1, C.white, {});
    });
    for (const n of ['rud_L', 'rud_R']) p.on(n, (ctx) => crossPattee(ctx, 1.0, 7.62, 0.6, { field }));
    for (const side of ['R', 'L'] as const) {
      const [hx, hy] = fusAt(side, -2.4, 0.45);
      smudge(p, `fus_${side}`, hx, hy, 0.3, 0.1, 0.25);
      mud(p, `fus_${side}`, 0, 12, 1.0, 1.6, 40, 151);
      soot(p, `nac_${side}`, side === 'R' ? 1.5 : 2.3, 0.35, 1.2, 0.2, 0.5);
      streaks(p, `nac_${side}`, side === 'R' ? 0.5 : 1.3, side === 'R' ? 2.3 : 3.1, 0.5, 0.8, side === 'R' ? -1 : 1, 1.4, { count: 40, alpha: 0.3, seed: 152 });
    }
    mud(p, 'L_bot', 1.4, 3.4, 0, 2.0, 60, 153);
    p.fill('swatch', '#ffffff');
  },
};
