import * as THREE from 'three';
import { M, mul, Parts, type PartOpts } from './util';
import { TILE } from './atlas';

/**
 * Crew figures: low-poly soldiers built from a dozen boxes.
 *
 * At the distances this game is played (150 m and up) a man is eight pixels
 * tall; what reads is the silhouette — a helmet brim, a pale face, legs apart
 * at a gun — and the colour of the uniform. The helmet is the side cue: the
 * flat Brodie dish for the Allies, the flared Stahlhelm for the Germans.
 */

export type Side = 'allied' | 'central';
export type Pose = 'stand' | 'kneel' | 'load' | 'point' | 'sit' | 'upper' | 'binoc' | 'crouch';

const UNIFORM: Record<Side, number> = { allied: 0x7a6a45, central: 0x69705f };
const HELMET: Record<Side, number> = { allied: 0x5a5a3c, central: 0x5a6152 };
const SKIN = 0xc39274;
const BOOT = 0x2e241b;
const BELT = 0x5a4430;

/**
 * Add a soldier standing at the local origin facing -Z, transformed by `m`.
 * `cap` puts a leather flying helmet on instead of a steel one (airmen, observers).
 */
export function soldier(p: Parts, m: THREE.Matrix4, side: Side, pose: Pose, cap = false): void {
  const cloth: PartOpts = { color: UNIFORM[side], tile: TILE.CANVAS, scale: 0.6, rough: 0.95, jitter: 0.08, ember: 0.2 };
  const dark: PartOpts = { color: BOOT, tile: TILE.PAINT, rough: 0.7 };
  const skin: PartOpts = { color: SKIN, tile: TILE.PAINT, rough: 0.7, jitter: 0.1 };
  const belt: PartOpts = { color: BELT, tile: TILE.PAINT, rough: 0.6 };
  const T = (mm: THREE.Matrix4): THREE.Matrix4 => mul(m, mm);

  let hip = 0.9;
  let lean = 0;
  if (pose === 'kneel' || pose === 'crouch') {
    hip = 0.55;
    lean = pose === 'crouch' ? 0.35 : 0.1;
    // One knee down, the other leg bent forward.
    p.box(0.15, 0.5, 0.17, T(M(-0.11, 0.32, 0.05, -0.2)), cloth);
    p.box(0.14, 0.14, 0.45, T(M(-0.11, 0.08, 0.3)), dark);
    p.box(0.15, 0.17, 0.45, T(M(0.11, 0.5, -0.2)), cloth);
    p.box(0.14, 0.48, 0.16, T(M(0.11, 0.25, -0.4)), dark);
  } else if (pose === 'sit') {
    hip = 0.55;
    p.box(0.15, 0.17, 0.48, T(M(-0.11, 0.52, -0.22)), cloth);
    p.box(0.15, 0.17, 0.48, T(M(0.11, 0.52, -0.22)), cloth);
    p.box(0.14, 0.5, 0.16, T(M(-0.11, 0.25, -0.44)), dark);
    p.box(0.14, 0.5, 0.16, T(M(0.11, 0.25, -0.44)), dark);
  } else if (pose !== 'upper') {
    const spread = pose === 'load' ? 0.14 : 0.09;
    p.box(0.15, 0.5, 0.17, T(M(-spread, 0.62, 0, 0, 0, 0.04)), cloth);
    p.box(0.15, 0.5, 0.17, T(M(spread, 0.62, pose === 'load' ? -0.12 : 0, pose === 'load' ? 0.25 : 0, 0, -0.04)), cloth);
    // Puttees and boots.
    p.box(0.13, 0.42, 0.15, T(M(-spread, 0.21, 0)), dark);
    p.box(0.13, 0.42, 0.15, T(M(spread, 0.21, pose === 'load' ? -0.2 : 0)), dark);
  }

  // Torso (tunic skirts flare a little), belt, head.
  const torso = T(M(0, hip, 0, lean));
  const up = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 => mul(torso, M(x, y, z, rx, ry, rz));
  p.box(0.44, 0.34, 0.27, up(0, 0.14, 0), cloth);
  p.box(0.42, 0.34, 0.25, up(0, 0.44, 0), cloth);
  p.box(0.45, 0.06, 0.28, up(0, 0.24, 0), belt);
  p.box(0.34, 0.1, 0.22, up(0, 0.63, 0), cloth);
  p.box(0.16, 0.18, 0.2, up(0, 0.77, -0.01), skin);

  // Arms.
  const arm = (sx: number, rx: number, rz: number, fore = rx): void => {
    const sh = mul(torso, M(sx * 0.27, 0.58, 0));
    p.box(0.12, 0.32, 0.13, mul(sh, M(0, 0, 0, rx, 0, rz), M(0, -0.15, 0)), cloth);
    p.box(0.11, 0.3, 0.12, mul(sh, M(0, 0, 0, rx, 0, rz), M(0, -0.3, 0), M(0, 0, 0, fore - rx), M(0, -0.15, 0)), cloth);
    p.box(0.09, 0.09, 0.09, mul(sh, M(0, 0, 0, rx, 0, rz), M(0, -0.3, 0), M(0, 0, 0, fore - rx), M(0, -0.32, 0)), skin);
  };
  switch (pose) {
    case 'load':
      arm(-1, 1.3, 0.1, 1.5); arm(1, 1.3, -0.1, 1.5);
      // Shell held in both hands.
      p.cyl(0.05, 0.05, 0.55, 6, up(0, 0.3, -0.52, 0, 0, Math.PI / 2), { color: 0xb08a3c, tile: TILE.PAINT, rough: 0.35, metal: 0.8 });
      break;
    case 'point':
      arm(-1, 0.05, 0.1); arm(1, 2.6, -0.2, 2.8);
      break;
    case 'binoc':
      arm(-1, 2.2, 0.35, 2.9); arm(1, 2.2, -0.35, 2.9);
      p.box(0.16, 0.08, 0.12, up(0, 0.8, -0.14), { color: 0x1a1a1a, tile: TILE.PAINT, rough: 0.5 });
      break;
    case 'sit':
      arm(-1, 1.0, 0.15, 1.4); arm(1, 1.0, -0.15, 1.4);
      break;
    case 'kneel':
    case 'crouch':
      arm(-1, 0.7, 0.1, 1.2); arm(1, 0.5, -0.1, 1.0);
      break;
    default:
      arm(-1, 0.05, 0.08); arm(1, 0.05, -0.08);
  }

  // Head gear.
  if (cap) {
    p.sphere(0.13, up(0, 0.86, 0.01), { color: 0x3c2a1c, tile: TILE.PAINT, rough: 0.6 }, 8, 5);
    p.box(0.2, 0.04, 0.05, up(0, 0.87, -0.11), { color: 0x9a8a6a, tile: TILE.PAINT, rough: 0.3, metal: 0.3 });
  } else if (side === 'allied') {
    // Brodie: a shallow dome on a wide flat brim.
    p.cyl(0.21, 0.21, 0.025, 10, up(0, 0.88, 0), { color: HELMET.allied, tile: TILE.PAINT, rough: 0.8 });
    p.add(new THREE.SphereGeometry(0.14, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2), up(0, 0.88, 0, 0, 0, 0), { color: HELMET.allied, tile: TILE.PAINT, rough: 0.8 });
  } else {
    // Stahlhelm: deep dome with a flared neck guard.
    p.add(new THREE.SphereGeometry(0.15, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), mul(torso, M(0, 0.84, 0.01, 0, 0, 0, 1, 1.05, 1.1)), { color: HELMET.central, tile: TILE.PAINT, rough: 0.8 });
    p.cyl(0.155, 0.19, 0.1, 10, up(0, 0.8, 0.03, -0.15), { color: HELMET.central, tile: TILE.PAINT, rough: 0.8 }, true);
  }
}
