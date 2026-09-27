/**
 * Aircraft performance tables and the few constants the whole battle shares.
 *
 * The flight model these feed (Plane.ts) is deliberately not the six-degree
 * rigid body the jet used. A 1917 scout fights at 40–60 m/s, a few hundred
 * metres off the ground, with its nose on another aircraft — what matters is
 * that the nose goes where the stick says, that a hard pull bleeds speed, that
 * a stall drops a wing, and that the machines feel different from each other.
 * Each type is a handful of numbers that set exactly those things.
 */

export type Team = 'allied' | 'central';

export const other = (team: Team): Team => (team === 'allied' ? 'central' : 'allied');

/** Airframes with a model in Airframes.ts. */
export type AirframeId = 'camel' | 'spad' | 'dr1' | 'albatros' | 'dh4' | 'gotha';

export interface AircraftType {
  id: AirframeId;
  name: string;
  /** Short name for the HUD. */
  short: string;
  team: Team;
  engine: 'rotary' | 'inline';
  /** Loaded mass, kg. */
  mass: number;
  wingArea: number;
  /** Static (zero-speed) thrust cap, N. */
  staticThrust: number;
  /** Shaft power delivered through the propeller, W. Thrust = power / speed above the cap. */
  power: number;
  cd0: number;
  /** Induced-drag factor. */
  k: number;
  cl0: number;
  clAlpha: number;
  stallAlpha: number;
  stallAlphaNeg: number;
  trimAlpha: number;
  /** Full-deflection roll rate at reference dynamic pressure, rad/s. */
  rollRate: number;
  /** Pitch and yaw stiffness toward the commanded angle of attack / sideslip. */
  kAlpha: number;
  kBeta: number;
  betaMax: number;
  /** Structural g limits the commanded pull is clamped to. */
  nMax: number;
  nMin: number;
  /** Dynamic pressure at which the controls reach full authority, Pa. */
  qRef: number;
  sideArea: number;
  /** Centre of gravity above the wheels, m. */
  gearHeight: number;
  hp: number;
  score: number;
  rpmMax: number;
  /**
   * Rotary engines spin the whole crankcase: a big gyroscope bolted to the
   * nose. Positive values yaw the nose right while pitching up and drag it
   * round in a right-hand turn — the Camel's famous vice.
   */
  torque: number;
  guns: number;
  /** Rounds per second per gun pair. */
  rateOfFire: number;
  ammo: number;
  /** Damage per round. */
  damage: number;
  /** Where the guns converge, m ahead. */
  converge: number;
  /** Rear gunner (two-seaters and bombers). */
  gunner: boolean;
  bombs: number;
}

const base = {
  cl0: 0.26,
  clAlpha: 4.6,
  stallAlphaNeg: 0.2,
  trimAlpha: 0.02,
  nMin: -3,
  gearHeight: 1.5,
  guns: 2,
  rateOfFire: 15,
  ammo: 900,
  damage: 7,
  converge: 200,
  gunner: false,
  bombs: 0,
};

export const TYPES: Record<AirframeId, AircraftType> = {
  camel: {
    ...base, id: 'camel', name: 'Sopwith Camel', short: 'CAMEL', team: 'allied', engine: 'rotary',
    mass: 660, wingArea: 21.5, staticThrust: 3400, power: 96000, cd0: 0.042, k: 0.075,
    stallAlpha: 0.25, rollRate: 2.5, kAlpha: 5.0, kBeta: 3.6, betaMax: 0.22, nMax: 6, qRef: 700,
    sideArea: 5.5, hp: 100, score: 100, rpmMax: 1250, torque: 0.32, bombs: 4,
  },
  spad: {
    ...base, id: 'spad', name: 'SPAD S.XIII', short: 'SPAD', team: 'allied', engine: 'inline',
    mass: 820, wingArea: 21.1, staticThrust: 4200, power: 128000, cd0: 0.038, k: 0.08,
    cl0: 0.22, stallAlpha: 0.23, rollRate: 1.9, kAlpha: 4.4, kBeta: 3.0, betaMax: 0.18, nMax: 6.5,
    qRef: 800, sideArea: 5.8, hp: 115, score: 100, rpmMax: 2100, torque: 0.04, bombs: 2,
  },
  dr1: {
    ...base, id: 'dr1', name: 'Fokker Dr.I', short: 'DR.I', team: 'central', engine: 'rotary',
    mass: 586, wingArea: 18.7, staticThrust: 3100, power: 80000, cd0: 0.047, k: 0.06,
    cl0: 0.32, clAlpha: 4.4, stallAlpha: 0.27, rollRate: 2.3, kAlpha: 5.2, kBeta: 3.8, betaMax: 0.24,
    nMax: 6, qRef: 600, sideArea: 5, hp: 95, score: 150, rpmMax: 1200, torque: 0.24,
  },
  albatros: {
    ...base, id: 'albatros', name: 'Albatros D.V', short: 'ALBATROS', team: 'central', engine: 'inline',
    mass: 915, wingArea: 21.2, staticThrust: 4200, power: 106000, cd0: 0.04, k: 0.07,
    cl0: 0.28, stallAlpha: 0.24, rollRate: 1.7, kAlpha: 4.2, kBeta: 3.0, betaMax: 0.18, nMax: 5.5,
    qRef: 800, sideArea: 6, hp: 110, score: 100, rpmMax: 1400, torque: 0.04, bombs: 2,
  },
  dh4: {
    ...base, id: 'dh4', name: 'Airco DH.4', short: 'DH.4', team: 'allied', engine: 'inline',
    mass: 1575, wingArea: 40.3, staticThrust: 6800, power: 230000, cd0: 0.042, k: 0.07,
    cl0: 0.3, stallAlpha: 0.24, rollRate: 0.9, kAlpha: 3.0, kBeta: 2.2, betaMax: 0.14, nMax: 4,
    qRef: 900, sideArea: 11, gearHeight: 1.9, hp: 240, score: 200, rpmMax: 1600, torque: 0,
    guns: 1, gunner: true, bombs: 6,
  },
  gotha: {
    ...base, id: 'gotha', name: 'Gotha G.V', short: 'GOTHA', team: 'central', engine: 'inline',
    mass: 3975, wingArea: 89.5, staticThrust: 12500, power: 330000, cd0: 0.05, k: 0.065,
    cl0: 0.34, stallAlpha: 0.22, rollRate: 0.55, kAlpha: 2.2, kBeta: 1.6, betaMax: 0.1, nMax: 3,
    qRef: 900, sideArea: 24, gearHeight: 2.6, hp: 480, score: 400, rpmMax: 1400, torque: 0,
    guns: 0, gunner: true, bombs: 12,
  },
};

/** Fighters each side flies. Index 0 is the default. */
export const FIGHTERS: Record<Team, AirframeId[]> = {
  allied: ['camel', 'spad'],
  central: ['dr1', 'albatros'],
};

export const G = 9.81;
export const RHO = 1.2;
export const BULLET_SPEED = 640;
export const BULLET_GRAVITY = 4;
export const BULLET_LIFE = 1.7;

/** Stall speed of a type at 1 g, m/s. */
export function stallSpeed(t: AircraftType): number {
  return Math.sqrt((2 * t.mass * G) / (RHO * t.wingArea * (t.cl0 + t.clAlpha * t.stallAlpha)));
}
