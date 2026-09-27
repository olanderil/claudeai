import type { AirframeId } from '../Types';
import type { RGB, V3 } from './geo';
import type { Kit } from './kit';
import type { Painter } from './livery';

/** What a type's builder reports back besides geometry (body space, metres). */
export interface DesignMeta {
  eye: V3;
  muzzles: V3[];
  gunnerMount: V3 | null;
  exhausts: V3[];
  engines: V3[];
  /** Spinning nodes: props and rotary engines turn with the engine; discs are the blurred props. */
  spinners: { node: string; kind: 'prop' | 'rotor' | 'disc'; dir: 1 | -1 }[];
  /** Loose end of the pilot's scarf, anchored at the neck. */
  scarf: { node: string; anchor: V3; color: RGB } | null;
  /** Full-deflection angles, radians. */
  deflect: { elevator: number; aileron: number; rudder: number };
  /** Rear gun ring: yaw node (rest pose faces the tail), pitch node, and its flash. */
  gunner: { yaw: string; pitch: string; flash: string } | null;
  /** Forward-gun flash node names, matching `muzzles`. */
  flashes: string[];
  /** Other gunners' flashes, fired together with the rear gunner (Gotha nose gun). */
  auxFlashes?: string[];
}

export interface Design {
  id: AirframeId;
  /** Livery keys; 'standard' first. */
  liveries: string[];
  build(k: Kit): DesignMeta;
  paint(p: Painter, livery: string): void;
}

/** Parked sit angle and CG height the physics uses (Plane.parkAt / groundContact). */
export const SIT = 0.19;

/**
 * Body-space height of the ground plane under station z when parked: the
 * physics holds the CG `gear` metres up with the nose raised SIT radians.
 * Wheels sit at groundY(z) + r / cos(SIT); the tail skid shoe at groundY(z).
 */
export function groundY(z: number, gear: number): number {
  return (-gear + z * Math.sin(SIT)) / Math.cos(SIT);
}

export function axleY(z: number, gear: number, r: number): number {
  return (-gear + r + z * Math.sin(SIT)) / Math.cos(SIT);
}
