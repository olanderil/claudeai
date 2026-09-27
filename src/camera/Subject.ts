import type * as THREE from 'three';

/**
 * What the cameras need to know about the aircraft they are following.
 *
 * Deliberately not a concrete class: the player's aeroplane, an AI machine the
 * "watch" view is following and a respawned player are all just something with
 * a pose, an eye and a cockpit that can be shown or hidden. Anything with these
 * fields will do, structurally — the old jet `Aircraft` included.
 */
export interface CameraSubject {
  /** Interpolated render pose: position is the CG, quaternion the attitude. */
  root: THREE.Object3D;
  /** Body-space pilot eye, for the cockpit view and the mounted shots. */
  eyePoint: THREE.Vector3;
  setCockpitVisible(on: boolean): void;
  /**
   * Size relative to the reference scale the shots are authored for.
   *
   * The reference is a single-seat scout of 1917 — about 6.5 m long and 8.5 m
   * across the wings — so a Camel, a SPAD, a Triplane or an Albatros is ~1, a
   * DH.4 about 1.4 and a Gotha 2–2.7. Every framing distance scales with it, so
   * the same wingtip shot frames a fighter and a bomber alike.
   */
  cameraScale?: number;
  /** World velocity, m/s, if the subject knows it. Better than differencing. */
  velocity?: THREE.Vector3;
}

/**
 * The part of the flight telemetry the cameras read.
 *
 * A structural subset rather than the flight model's own type, so that any
 * model that reports these — the jet's, the biplane's, a replay's — can drive
 * the camera. Only airspeed and height are required; the rest sharpen things
 * when they are there.
 */
export interface CameraTelemetry {
  /** True airspeed, m/s. */
  tas: number;
  /** Height above the ground below, metres. */
  agl: number;
  stalled?: boolean;
  onGround?: boolean;
  /** Radians, signed. */
  bank?: number;
  /** m/s. */
  verticalSpeed?: number;
  /** g. */
  loadFactor?: number;
}

/**
 * Another aircraft the camera can look at: the enemy being fought, or the one
 * that has just been shot down.
 *
 * Held by reference and read every frame, so passing a live `position` vector
 * lets a kill cam follow a burning machine all the way down.
 */
export interface CombatBody {
  position: THREE.Vector3;
  velocity?: THREE.Vector3;
  /** Attitude, if known. Only used as a fallback for the heading. */
  quaternion?: THREE.Quaternion;
  /** Same meaning as `CameraSubject.cameraScale`. */
  cameraScale?: number;
}

/** What the fight looks like from the player's seat, refreshed every frame. */
export interface CombatContext {
  /** The enemy being fought or locked — framed by the target view. */
  target: { position: THREE.Vector3; velocity: THREE.Vector3; cameraScale?: number } | null;
  /** The most dangerous enemy on the player's tail. */
  threat: { position: THREE.Vector3 } | null;
}
