import * as THREE from 'three';
import { G0, RHO0, airDensity, clamp, smoothstep } from '../util/math';

/**
 * Six-degree-of-freedom rigid-body flight model with classical stability derivatives.
 *
 * Frame convention (three.js object space):
 *   +X right, +Y up, -Z forward.
 *
 * Angular velocity is stored in body axes as a Vector3 about (X, Y, Z). Because
 * forward is -Z, the aerospace rates map as:
 *   pitch rate (nose up)   p_pitch =  omega.x
 *   yaw rate   (nose right) r_yaw   = -omega.y
 *   roll rate  (right roll) p_roll  = -omega.z
 *
 * Control inputs are already-smoothed surface deflections in [-1, 1], signed so that
 * positive means: elevator = nose up, aileron = roll right, rudder = nose right.
 */

export interface AircraftConfig {
  mass: number;
  wingArea: number;
  wingSpan: number;
  /** Moments of inertia about body X (pitch), Y (yaw), Z (roll), kg·m². */
  inertia: THREE.Vector3;
  thrustMil: number;
  thrustAB: number;
  /** Distance from centre of gravity down to the wheels, metres. */
  gearHeight: number;

  clAlpha: number;
  alphaStall: number;
  cd0: number;
  oswald: number;
  cyBeta: number;

  clDa: number;
  clP: number;
  clBeta: number;

  cm0: number;
  cmAlpha: number;
  cmDe: number;
  cmQ: number;

  cnBeta: number;
  cnDr: number;
  cnR: number;
}

/** F/A-18-class parameters. Tuned for authentic response that stays forgiving. */
export const HORNET: AircraftConfig = {
  mass: 16000,
  wingArea: 38,
  wingSpan: 12.3,
  inertia: new THREE.Vector3(165000, 190000, 31000),
  // Above the real Hornet's 98/158 kN: the extra is what gives the brisk
  // acceleration this build is tuned for, while the drag curve below still
  // settles the top end at the intended 1915 km/h.
  thrustMil: 143000,
  thrustAB: 230000,
  gearHeight: 2.4,

  clAlpha: 4.6,
  alphaStall: 0.28,
  cd0: 0.021,
  oswald: 0.85,
  cyBeta: -0.9,

  // Roll authority is set so full aileron settles at ~220°/s, matching the type.
  clDa: 0.045,
  clP: -0.42,
  clBeta: -0.07,

  // cmAlpha vs cmDe fixes the AoA the aircraft trims to at full aft stick:
  // 1.05 / 1.6 ≈ 0.66 rad ≈ 38°, so it can be stalled but won't tumble.
  // cmQ is then sized to keep the short-period mode damped rather than ringing.
  cm0: 0.02,
  cmAlpha: -1.6,
  cmDe: 1.05,
  cmQ: -30,

  cnBeta: 0.13,
  cnDr: 0.075,
  cnR: -0.38,
};

export interface ControlInputs {
  elevator: number;
  aileron: number;
  rudder: number;
  /** 0..1; the top of the range engages afterburner. */
  throttle: number;
  brake: boolean;
  /** 1 = gear down (extra drag), 0 = retracted. */
  gearExtension: number;
}

/** Read-only telemetry derived each step, consumed by the HUD and audio. */
export interface Telemetry {
  /** True airspeed, m/s. */
  tas: number;
  /** Indicated airspeed, m/s (density-corrected). */
  ias: number;
  mach: number;
  altitude: number;
  /** Height above the terrain directly below, metres. */
  agl: number;
  verticalSpeed: number;
  alpha: number;
  beta: number;
  loadFactor: number;
  heading: number;
  pitch: number;
  bank: number;
  /** Body rates, rad/s, signed as: roll right, pitch up, yaw right. */
  rollRate: number;
  pitchRate: number;
  yawRate: number;
  onGround: boolean;
  stalled: boolean;
  stallMargin: number;
  afterburner: number;
  thrust: number;
  lift: number;
  drag: number;
}

export type GroundSampler = (x: number, z: number) => number;

export class FlightModel {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  readonly angularVelocity = new THREE.Vector3();

  /** Previous-step transform, used to interpolate the visual pose between renders. */
  readonly prevPosition = new THREE.Vector3();
  readonly prevOrientation = new THREE.Quaternion();

  crashed = false;
  /** Impact speed of the crash, for the report line. */
  crashSpeed = 0;

  readonly telemetry: Telemetry = {
    tas: 0, ias: 0, mach: 0, altitude: 0, agl: 0, verticalSpeed: 0,
    alpha: 0, beta: 0, loadFactor: 1, heading: 0, pitch: 0, bank: 0,
    rollRate: 0, pitchRate: 0, yawRate: 0,
    onGround: true, stalled: false, stallMargin: 1, afterburner: 0,
    thrust: 0, lift: 0, drag: 0,
  };

  /** Slow-varying wind, world frame. */
  private readonly wind = new THREE.Vector3();
  /**
   * Phase of the gust cycle.
   *
   * Random per aircraft so two flights of the same route are not identical —
   * but *settable*, because a test that cannot reproduce its own conditions is
   * measuring the weather as much as the thing under test. The scenic
   * autopilot's landings move by a couple of hundred metres between runs on
   * this term alone, which is enough to make a tuning pass look like an
   * improvement when it changed nothing.
   */
  windPhase = Math.random() * 100;

  // Scratch vectors — this runs 120×/s, so nothing is allocated in the step.
  private readonly _q = new THREE.Quaternion();
  private readonly _airRel = new THREE.Vector3();
  private readonly _vBody = new THREE.Vector3();
  private readonly _vHat = new THREE.Vector3();
  private readonly _side = new THREE.Vector3();
  private readonly _liftDir = new THREE.Vector3();
  private readonly _force = new THREE.Vector3();
  private readonly _torque = new THREE.Vector3();
  private readonly _euler = new THREE.Euler();
  private readonly _up = new THREE.Vector3();
  private readonly _fwd = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();

  constructor(
    readonly config: AircraftConfig = HORNET,
    private readonly groundHeight: GroundSampler = () => 0,
  ) {
    this.reset();
  }

  /**
   * Place the aircraft stationary at the start of the runway, facing
   * `headingDeg` in the same convention the telemetry reports (0 = north).
   *
   * The negation is the whole point: rotating the body about +Y by θ points its
   * −Z nose at compass heading −θ, so passing the heading straight through makes
   * `reset(h)` and `telemetry.heading` disagree in sign. That stayed invisible
   * while every spawn used 0 or 180 — both unchanged by a sign flip — and only
   * surfaces once something spawns on an arbitrary heading, such as an airstrip.
   */
  reset(position = new THREE.Vector3(0, 0, 600), headingDeg = 180): void {
    const ground = this.groundHeight(position.x, position.z);
    this.position.set(position.x, ground + this.config.gearHeight, position.z);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.orientation.setFromEuler(new THREE.Euler(0, -headingDeg * (Math.PI / 180), 0, 'YXZ'));
    this.prevPosition.copy(this.position);
    this.prevOrientation.copy(this.orientation);
    this.crashed = false;
    this.crashSpeed = 0;
    this.telemetry.onGround = true;
  }

  /** Lift coefficient across the full alpha range, including post-stall departure. */
  private liftCoefficient(alpha: number): number {
    const { clAlpha, alphaStall } = this.config;
    const mag = Math.abs(alpha);
    // Below the stall the curve is linear; beyond it we blend to a flat-plate
    // response, which drops CL sharply and makes the stall feel real.
    const blend = smoothstep(alphaStall, alphaStall + 0.16, mag);
    const attached = clAlpha * alpha;
    const separated = 1.15 * Math.sin(2 * alpha);
    return attached * (1 - blend) + separated * blend;
  }

  step(dt: number, controls: ControlInputs): void {
    this.prevPosition.copy(this.position);
    this.prevOrientation.copy(this.orientation);

    if (this.crashed) {
      this.updateTelemetry(controls, 0, 0, 0);
      return;
    }

    const cfg = this.config;
    const groundY = this.groundHeight(this.position.x, this.position.z);
    const altitude = this.position.y;
    const rho = airDensity(altitude);

    // --- Wind: a light, slowly wandering breeze. -----------------------------
    this.windPhase += dt * 0.05;
    const gust = Math.sin(this.windPhase) * Math.sin(this.windPhase * 0.37);
    this.wind.set(1.4 + gust * 1.3, gust * 0.4, 0.8 - gust * 1.0);

    // --- Airspeed in body axes ----------------------------------------------
    this._airRel.copy(this.velocity).sub(this.wind);
    const tas = this._airRel.length();

    this._q.copy(this.orientation).invert();
    this._vBody.copy(this._airRel).applyQuaternion(this._q);

    const u = -this._vBody.z;           // forward component
    const vSide = this._vBody.x;        // rightward component
    const wDown = -this._vBody.y;       // downward component

    // Below taxi speed the airflow is all wind and the derived angles are noise,
    // so they're held at zero — dynamic pressure there is negligible anyway.
    let alpha = 0;
    let beta = 0;
    if (tas > AERO_MIN_SPEED) {
      alpha = Math.atan2(wDown, Math.abs(u) < 1e-3 ? 1e-3 : u);
      beta = Math.asin(clamp(vSide / tas, -1, 1));
    }

    const mach = tas / speedOfSound(altitude);

    // --- Thrust --------------------------------------------------------------
    // Afterburner lives in the top 10% of throttle travel.
    const abLevel = smoothstep(0.9, 1.0, controls.throttle);
    const densityRatio = Math.pow(rho / RHO0, THRUST_LAPSE);
    // Ram recovery: the inlet compresses the incoming air as speed rises, so
    // thrust does not simply fall away with altitude at high Mach. Leaving this
    // out caps the aircraft well below its real top speed, because thrust decays
    // with density while drag keeps climbing with V².
    const ram = Math.min(1 + RAM_RECOVERY * mach * mach, RAM_MAX);
    const dryFraction = Math.min(controls.throttle / 0.9, 1);
    const thrustMag =
      (cfg.thrustMil * dryFraction + (cfg.thrustAB - cfg.thrustMil) * abLevel) *
      densityRatio *
      ram;

    // --- Aerodynamic coefficients -------------------------------------------
    const qBar = 0.5 * rho * tas * tas;
    const aspectRatio = (cfg.wingSpan * cfg.wingSpan) / cfg.wingArea;

    const cl = this.liftCoefficient(alpha);
    // Wave drag: rises through Mach 1, then keeps climbing into the high
    // supersonic range. The second term lumps together the effects that
    // actually cap a fighter's top end — inlet spillage, trim drag and rising
    // skin friction with kinetic heating — rather than modelling each. Shaping
    // it this way puts the penalty where the aircraft tops out instead of
    // where it accelerates, so the transonic push stays brisk.
    const waveDrag =
      WAVE_DRAG_PEAK *
      smoothstep(0.85, 1.05, mach) *
      (1 + WAVE_DRAG_SUPERSONIC * smoothstep(1.5, 2.0, mach));
    const separationDrag = 1.4 * Math.pow(Math.sin(alpha), 2);
    const cd =
      cfg.cd0 +
      (cl * cl) / (Math.PI * aspectRatio * cfg.oswald) +
      separationDrag +
      waveDrag +
      GEAR_CD * controls.gearExtension;
    const cy = cfg.cyBeta * beta;

    const lift = qBar * cfg.wingArea * cl;
    const drag = qBar * cfg.wingArea * cd;
    const side = qBar * cfg.wingArea * cy;

    // --- Force assembly, body frame -----------------------------------------
    this._force.set(0, 0, -thrustMag);

    if (tas > AERO_MIN_SPEED) {
      this._vHat.copy(this._vBody).normalize();
      // Lift is perpendicular to the relative wind, in the aircraft's plane of
      // symmetry. Two cross products get us there and stay stable at high alpha.
      this._side.set(0, 1, 0).cross(this._vHat);
      if (this._side.lengthSq() < 1e-8) {
        this._side.set(1, 0, 0); // velocity parallel to body-up: pick any lateral axis
      }
      this._side.normalize();
      this._liftDir.copy(this._vHat).cross(this._side).normalize();

      this._force.addScaledVector(this._liftDir, lift);
      this._force.addScaledVector(this._vHat, -drag);
      this._force.x += side;
    }

    // Specific force along body-up, in g — what the pilot and the HUD feel.
    const loadFactor = this._force.y / (cfg.mass * G0);

    // --- Moments -------------------------------------------------------------
    const pPitch = this.angularVelocity.x;
    const rYaw = -this.angularVelocity.y;
    const pRoll = -this.angularVelocity.z;

    const chord = cfg.wingArea / cfg.wingSpan;
    const vSafe = Math.max(tas, 25); // keeps damping finite at taxi speeds
    const pHat = (pRoll * cfg.wingSpan) / (2 * vSafe);
    const qHat = (pPitch * chord) / (2 * vSafe);
    const rHat = (rYaw * cfg.wingSpan) / (2 * vSafe);

    // Once the flow separates the surfaces are working in turbulent, detached air
    // and lose most of their bite. Without this the aircraft can hold an
    // unphysical stable deep stall on full elevator instead of pitching out of it.
    const authority =
      1 - 0.8 * smoothstep(cfg.alphaStall, cfg.alphaStall * 2.2, Math.abs(alpha));

    const rollMoment =
      qBar * cfg.wingArea * cfg.wingSpan *
      (cfg.clDa * controls.aileron * authority + cfg.clP * pHat + cfg.clBeta * beta);

    const pitchMoment =
      qBar * cfg.wingArea * chord *
      (cfg.cm0 + cfg.cmAlpha * alpha + cfg.cmDe * controls.elevator * authority + cfg.cmQ * qHat);

    const yawMoment =
      qBar * cfg.wingArea * cfg.wingSpan *
      (cfg.cnBeta * beta + cfg.cnDr * controls.rudder * authority + cfg.cnR * rHat);

    // Map aerospace moments onto the three.js body axes (see header comment).
    this._torque.set(pitchMoment, -yawMoment, -rollMoment);

    // --- Integrate rotation --------------------------------------------------
    this.angularVelocity.x += (this._torque.x / cfg.inertia.x) * dt;
    this.angularVelocity.y += (this._torque.y / cfg.inertia.y) * dt;
    this.angularVelocity.z += (this._torque.z / cfg.inertia.z) * dt;

    const onGroundNow = this.position.y <= groundY + cfg.gearHeight + 0.05;

    if (onGroundNow) this.applyGroundHandling(dt, controls, tas);

    const omega = this.angularVelocity.length();
    if (omega > 1e-6) {
      this._q.setFromAxisAngle(this._up.copy(this.angularVelocity).multiplyScalar(1 / omega), omega * dt);
      this.orientation.multiply(this._q).normalize();
    }

    // --- Integrate translation ----------------------------------------------
    this._force.applyQuaternion(this.orientation); // body -> world
    this._force.y -= cfg.mass * G0;

    this.velocity.addScaledVector(this._force, dt / cfg.mass);
    this.position.addScaledVector(this.velocity, dt);

    // --- Ground contact ------------------------------------------------------
    // Keep the wheels planted while rolling over undulating ground: without a
    // tolerance band, terrain that falls away faster than the aircraft can drop
    // under gravity reads as a spurious liftoff. Releases as soon as there's a
    // real climb rate.
    const floor = this.groundHeight(this.position.x, this.position.z) + cfg.gearHeight;
    const planted = this.telemetry.onGround && this.velocity.y <= 0.2;
    if (this.position.y <= floor || (planted && this.position.y <= floor + GEAR_STICK)) {
      this.resolveGroundContact(floor);
    }

    this.updateTelemetry(controls, alpha, beta, loadFactor, tas, mach, thrustMag, lift, drag);
  }

  /**
   * Wheels-on-ground behaviour: friction, nosewheel steering and the strong
   * roll damping that keeps the aircraft tracking straight down the runway.
   */
  private applyGroundHandling(dt: number, controls: ControlInputs, tas: number): void {
    const speed = this.velocity.length();

    // Rolling resistance, or real braking when commanded.
    const decel = (controls.brake ? 0.42 : 0.02) * G0;
    if (speed > 0.05) {
      const drop = Math.min(decel * dt, speed);
      this.velocity.multiplyScalar((speed - drop) / speed);
    }

    // Tyres resist sideways sliding. Without this nothing opposes lateral motion
    // on the ground, so even a light crosswind slides the aircraft off the side
    // of the runway during the takeoff roll.
    this._right.set(1, 0, 0).applyQuaternion(this.orientation);
    this._right.y = 0;
    if (this._right.lengthSq() > 1e-6) {
      this._right.normalize();
      const sideways = this.velocity.dot(this._right);
      this.velocity.addScaledVector(this._right, -sideways * (1 - Math.exp(-TYRE_GRIP * dt)));
    }

    // The gear also resists yaw, so a crosswind can't weathervane the nose
    // around while the wheels are down.
    this.angularVelocity.y -= this.angularVelocity.y * (1 - Math.exp(-GROUND_YAW_DAMP * dt));

    // Nosewheel steering, authority fading out as the rudder takes over.
    const steerAuthority = clamp(1 - tas / 60, 0, 1);
    this.angularVelocity.y += -controls.rudder * 0.55 * steerAuthority * dt;

    // Gear holds the wings level and stops the aircraft rolling on its wheels.
    this._euler.setFromQuaternion(this.orientation, 'YXZ');
    const levelling = 1 - Math.exp(-6 * dt);
    this.angularVelocity.z += (-this._euler.z * 3.0 - this.angularVelocity.z * 2.0) * levelling;
    this.angularVelocity.x -= this.angularVelocity.x * levelling * 0.35;
  }

  /** Clamp to the surface: either a survivable landing or a crash. */
  private resolveGroundContact(floor: number): void {
    const verticalSpeed = this.velocity.y;
    this._euler.setFromQuaternion(this.orientation, 'YXZ');
    const bank = Math.abs(this._euler.z);
    const pitch = this._euler.x;

    const tooHard = verticalSpeed < -8;
    const wingStrike = bank > 0.35;
    const noseDown = pitch < -0.22 && this.velocity.length() > 25;

    if (tooHard || wingStrike || noseDown) {
      this.crashed = true;
      this.crashSpeed = this.velocity.length();
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      this.position.y = floor;
      return;
    }

    this.position.y = floor;
    if (this.velocity.y < 0) {
      // Gear absorbs the descent rather than bouncing.
      this.velocity.y = 0;
    }
  }

  private updateTelemetry(
    controls: ControlInputs,
    alpha: number,
    beta: number,
    loadFactor: number,
    tas = 0,
    mach = 0,
    thrust = 0,
    lift = 0,
    drag = 0,
  ): void {
    const t = this.telemetry;
    const groundY = this.groundHeight(this.position.x, this.position.z);
    const rho = airDensity(this.position.y);

    this._euler.setFromQuaternion(this.orientation, 'YXZ');

    t.tas = tas;
    t.ias = tas * Math.sqrt(rho / RHO0);
    t.mach = mach;
    t.altitude = this.position.y;
    t.agl = this.position.y - groundY;
    t.verticalSpeed = this.velocity.y;
    t.alpha = alpha;
    t.beta = beta;
    t.loadFactor = loadFactor;
    t.pitch = this._euler.x;
    t.bank = this._euler.z;
    t.rollRate = -this.angularVelocity.z;
    t.pitchRate = this.angularVelocity.x;
    t.yawRate = -this.angularVelocity.y;
    // Heading: 0 = north (-Z), increasing clockwise.
    this._fwd.set(0, 0, -1).applyQuaternion(this.orientation);
    t.heading = (Math.atan2(this._fwd.x, -this._fwd.z) * (180 / Math.PI) + 360) % 360;
    t.onGround = this.position.y <= groundY + this.config.gearHeight + GEAR_STICK;
    t.stallMargin = clamp(1 - Math.abs(alpha) / this.config.alphaStall, 0, 1);
    t.stalled = Math.abs(alpha) > this.config.alphaStall && tas > 5 && !t.onGround;
    t.afterburner = smoothstep(0.9, 1.0, controls.throttle);
    t.thrust = thrust;
    t.lift = lift;
    t.drag = drag;
  }
}

/** Airspeed below which aerodynamic angles are treated as undefined, m/s. */
const AERO_MIN_SPEED = 8;
/** Height band within which the gear stays in contact with the surface, m. */
const GEAR_STICK = 0.8;
/** Rate at which tyres kill sideways velocity on the ground. */
const TYRE_GRIP = 5.0;
/**
 * Rate at which the gear damps yaw on the ground. Set high because a small
 * standing heading error integrates over a 3 km takeoff roll into a large
 * lateral offset, which reads as the aircraft wandering off the runway.
 */
const GROUND_YAW_DAMP = 7.0;
/** Parasitic drag added by extended landing gear. */
const GEAR_CD = 0.022;
/**
 * Inlet ram recovery, as a multiplier on thrust: 1 + RAM_RECOVERY · M².
 * Capped, because a real inlet's pressure recovery levels off rather than
 * growing without bound.
 */
const RAM_RECOVERY = 0.1;
const RAM_MAX = 1.8;
/**
 * Wave drag through the transonic rise, and how much more of it accumulates by
 * the high supersonic end. Together with thrust these set the top speed — the
 * aircraft settles wherever thrust and drag balance, not at a coded limit.
 */
const WAVE_DRAG_PEAK = 0.03;
const WAVE_DRAG_SUPERSONIC = 0.35;
/**
 * Exponent for how thrust falls off with air density. Steeper than the ram term
 * alone would give, so the top speed peaks in the low stratosphere and tails off
 * above it rather than climbing forever with altitude.
 */
const THRUST_LAPSE = 0.85;

/** Speed of sound through the ISA troposphere and lower stratosphere, m/s. */
function speedOfSound(altitude: number): number {
  const temperature = Math.max(216.65, 288.15 - 0.0065 * Math.max(0, altitude));
  return 20.046 * Math.sqrt(temperature);
}
