import * as THREE from 'three';
import type { Telemetry } from '../flight/Telemetry';
import { clamp, lerp } from '../util/math';
import { G, RHO, TYPES, stallSpeed, type AircraftType, type AirframeId, type Team } from './Types';

/**
 * One aircraft in the battle: physics, guns state and damage.
 *
 * The flight model is the game-feel model from the reference dogfight rather
 * than the jet's rigid body: the nose tracks the flight path plus a commanded
 * angle of attack, so neutral stick holds the line, full back stick pulls to
 * the edge of the stall (or the g limit, whichever comes first) and a stall
 * drops a wing. On top of that, rotary engines add their gyroscopic pull.
 *
 * Frame convention matches the rest of the sim: +X right, +Y up, -Z forward.
 *
 * It keeps the jet's `position / orientation / prevPosition / prevOrientation /
 * telemetry` surface so the camera rig, cockpit and HUD read it unchanged, and
 * the render step interpolates between physics ticks the same way.
 */

export type PlaneState = 'ground' | 'flying' | 'falling' | 'dead';

export interface PlaneInput {
  /** +1 pulls the nose up. */
  pitch: number;
  /** +1 rolls right. */
  roll: number;
  /** +1 yaws right. */
  yaw: number;
  fire: boolean;
  /** Drop a bomb this tick (edge, consumed by the battle). */
  bomb: boolean;
}

/** Box in body space, for bullet hits. */
export interface Hitbox {
  c: THREE.Vector3;
  h: THREE.Vector3;
}

export interface GunState {
  heat: number;
  /** Seconds left clearing a stoppage; 0 when the guns work. */
  jam: number;
  cooldown: number;
  side: number;
  ammo: number;
  maxAmmo: number;
  /** Rear gunner. */
  gunnerCooldown: number;
  gunnerAim: THREE.Vector3;
  gunnerOn: boolean;
}

/** What the battle is told about. Kept out of Plane so physics has no scene. */
export interface PlaneEvents {
  hit(plane: Plane, point: THREE.Vector3, attacker: Plane | null): void;
  killed(plane: Plane, killer: Plane | null): void;
  exploded(plane: Plane, midAir: boolean): void;
  landed(plane: Plane): void;
}

export type GroundQuery = (x: number, z: number) => number;
export type WaterQuery = (x: number, z: number) => boolean;

const _vb = new THREE.Vector3();
const _vdir = new THREE.Vector3();
const _F = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _wp = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();

let sequence = 0;

export class Plane {
  readonly id = ++sequence;
  readonly type: AircraftType;
  team: Team;
  isPlayer: boolean;
  name: string;
  maxHp: number;
  hp: number;
  score: number;
  /** Livery key understood by Airframes.ts. */
  livery: string;

  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  readonly omega = new THREE.Vector3();
  readonly prevPosition = new THREE.Vector3();
  readonly prevOrientation = new THREE.Quaternion();
  readonly invQ = new THREE.Quaternion();
  readonly fwd = new THREE.Vector3(0, 0, -1);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly right = new THREE.Vector3(1, 0, 0);

  readonly input: PlaneInput = { pitch: 0, roll: 0, yaw: 0, fire: false, bomb: false };
  throttle = 1;
  /** Engine speed 0..1, lagging the throttle. */
  rpm = 1;
  /** Engine health multiplier on thrust. */
  engine = 1;
  state: PlaneState = 'flying';
  readonly gun: GunState;
  bombs: number;

  alpha = 0;
  beta = 0;
  speed = 0;
  stalled = false;
  gload = 1;
  private wingDrop = 0;
  /** Seconds of invulnerability left after a spawn. */
  invuln = 0;
  /** Keep the commanded angle of attack short of the stall (the recruit's aid). */
  stallGuard = false;
  spin = 0;
  fallT = 0;
  deadT = 0;
  lastHitBy: Plane | null = null;
  lastHitTime = -99;
  /** Fraction of the airframe on fire, for visuals. */
  fire = 0;
  /** Last sub-second a round struck, for hit flashes. */
  hitFlash = 0;
  hitboxes: Hitbox[] = [];
  /** Broad-phase radius for bullets, m. */
  radius = 8;

  readonly telemetry: Telemetry = {
    tas: 0, ias: 0, mach: 0, altitude: 0, agl: 0, verticalSpeed: 0,
    alpha: 0, beta: 0, loadFactor: 1, heading: 0, pitch: 0, bank: 0,
    rollRate: 0, pitchRate: 0, yawRate: 0,
    onGround: false, stalled: false, stallMargin: 1, afterburner: 0,
    thrust: 0, lift: 0, drag: 0,
  };

  /** AI brain, if this machine is not flown by the player. */
  brain: { update(dt: number): void } | null = null;
  /** Free-form tags the missions use (escort, objective…). */
  role = '';

  constructor(
    typeId: AirframeId,
    team: Team,
    opts: { isPlayer?: boolean; name?: string; hp?: number; score?: number; livery?: string } = {},
  ) {
    this.type = TYPES[typeId];
    this.team = team;
    this.isPlayer = opts.isPlayer ?? false;
    this.name = opts.name ?? this.type.name;
    this.maxHp = opts.hp ?? this.type.hp;
    this.hp = this.maxHp;
    this.score = opts.score ?? this.type.score;
    this.livery = opts.livery ?? 'standard';
    const ammo = this.isPlayer ? this.type.ammo : 1e9;
    this.gun = {
      heat: 0, jam: 0, cooldown: 0, side: 0, ammo, maxAmmo: this.type.ammo,
      gunnerCooldown: 0, gunnerAim: new THREE.Vector3(0, 0, 1), gunnerOn: false,
    };
    this.bombs = this.type.bombs;
  }

  get alive(): boolean {
    return this.state === 'flying' || this.state === 'ground';
  }

  get stallSpeed(): number {
    return stallSpeed(this.type);
  }

  /** Place the aircraft in flight, wings level, at `heading` (radians, 0 = -Z). */
  spawnAt(x: number, y: number, z: number, heading: number, speed: number): void {
    this.position.set(x, y, z);
    this.orientation.setFromEuler(_e.set(0, heading, 0, 'YXZ'));
    this.axes();
    this.velocity.copy(this.fwd).multiplyScalar(speed);
    this.omega.set(0, 0, 0);
    this.state = 'flying';
    this.prevPosition.copy(this.position);
    this.prevOrientation.copy(this.orientation);
    this.throttle = this.rpm = speed > 1 ? 0.85 : 0;
  }

  /** Park on the ground, tail down, facing `heading`. */
  parkAt(x: number, groundY: number, z: number, heading: number): void {
    this.position.set(x, groundY + this.type.gearHeight, z);
    this.orientation.setFromEuler(_e.set(0.19, heading, 0, 'YXZ'));
    this.axes();
    this.velocity.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.state = 'ground';
    this.throttle = 0;
    this.rpm = 0.12;
    this.prevPosition.copy(this.position);
    this.prevOrientation.copy(this.orientation);
  }

  axes(): void {
    this.fwd.set(0, 0, -1).applyQuaternion(this.orientation);
    this.up.set(0, 1, 0).applyQuaternion(this.orientation);
    this.right.set(1, 0, 0).applyQuaternion(this.orientation);
    this.invQ.copy(this.orientation).invert();
  }

  /** Heading in radians, 0 = -Z (north), increasing clockwise from above. */
  get heading(): number {
    return Math.atan2(this.fwd.x, -this.fwd.z);
  }

  step(dt: number, ground: GroundQuery, water: WaterQuery, events: PlaneEvents, time: number): void {
    this.prevPosition.copy(this.position);
    this.prevOrientation.copy(this.orientation);
    if (this.state === 'dead') return;
    this.physics(dt);
    if (this.state === 'falling') {
      this.fallT += dt;
      if (this.fallT > 30) this.explode(true, events);
    }
    if (this.invuln > 0) this.invuln -= dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.groundContact(dt, ground, water, events, time);
    this.updateTelemetry(ground);
  }

  private physics(dt: number): void {
    const T = this.type;
    const m = T.mass;
    const inp = this.input;
    const falling = this.state === 'falling';
    this.axes();
    const speed = this.velocity.length();
    this.speed = speed;
    const qd = 0.5 * RHO * speed * speed;
    _vb.copy(this.velocity).applyQuaternion(this.invQ);
    const alpha = speed > 2 ? Math.atan2(-_vb.y, -_vb.z) : 0;
    const beta = speed > 2 ? Math.asin(clamp(_vb.x / speed, -1, 1)) : 0;
    this.alpha = alpha;
    this.beta = beta;

    // Engine: the rotary blips with throttle lag.
    const thr = falling ? 0 : this.throttle;
    this.rpm += clamp(thr - this.rpm, -dt * 0.8, dt * 0.8);
    const thrust = this.rpm * this.engine * Math.min(T.staticThrust, T.power / Math.max(speed, 1));

    const liftScale = falling ? 0.45 : this.hp < this.maxHp * 0.25 ? 0.9 : 1;
    const cl = liftCoef(T, alpha) * liftScale;
    const wasStalled = this.stalled;
    this.stalled = speed > 5 && this.state === 'flying' && (alpha > T.stallAlpha || alpha < -T.stallAlphaNeg);
    if (this.stalled && !wasStalled) {
      // The torque of a rotary makes the left wing the one that goes.
      const bias = T.torque * 1.5;
      this.wingDrop = (Math.random() < 0.5 + bias ? -1 : 1) * (0.4 + Math.random() * 0.6);
    }

    _F.set(0, -m * G, 0).addScaledVector(this.fwd, thrust);
    let lift = 0;
    let drag = 0;
    if (speed > 0.5) {
      _vdir.copy(this.velocity).divideScalar(speed);
      _t1.copy(this.up).addScaledVector(_vdir, -this.up.dot(_vdir));
      const ll = _t1.length();
      lift = qd * T.wingArea * cl;
      if (ll > 1e-3) _F.addScaledVector(_t1, lift / ll);
      _t1.copy(this.right).addScaledVector(_vdir, -this.right.dot(_vdir));
      const sl = _t1.length();
      if (sl > 1e-3) _F.addScaledVector(_t1, (qd * T.sideArea * -2.5 * clamp(beta, -0.7, 0.7)) / sl);
      const cd = T.cd0 + T.k * cl * cl
        + (this.stalled ? 0.35 * Math.abs(Math.sin(alpha)) : 0)
        + 0.6 * Math.abs(Math.sin(beta)) * (T.sideArea / T.wingArea)
        + (1 - this.hp / this.maxHp) * 0.012;
      drag = qd * T.wingArea * cd;
      _F.addScaledVector(_vdir, -drag);
    }
    _acc.copy(_F).divideScalar(m);
    this.gload = (_acc.dot(this.up) + G * this.up.y) / G;
    this.telemetry.thrust = thrust;
    this.telemetry.lift = lift;
    this.telemetry.drag = drag;

    // Rotation: the nose tracks the flight path plus a commanded angle of attack / sideslip.
    const authE = clamp(qd / T.qRef + 0.25 * this.rpm, 0, 1);
    const authA = clamp(qd / T.qRef, 0, 1);
    const follow = clamp(qd / (T.qRef * 0.4), 0, 1);
    let px = 0;
    let py = 0;
    if (speed > 3) {
      _wp.crossVectors(this.velocity, _acc).divideScalar(speed * speed).applyQuaternion(this.invQ);
      px = clamp(_wp.x, -2.5, 2.5);
      py = clamp(_wp.y, -2.5, 2.5);
    }
    // Neutral stick holds the flight path: trim to the angle of attack that
    // cancels gravity's component along the lift axis, capped short of the stall.
    let a0 = T.trimAlpha;
    if (qd > 20 && !falling) {
      const need = (m * G * this.up.y) / (qd * T.wingArea);
      a0 = clamp((need - T.cl0) / T.clAlpha, -0.12, T.stallAlpha * 0.8);
    }
    const alphaDown = 0.18;
    const aTop = T.stallAlpha * (this.stallGuard ? 0.8 : 0.96);
    let aCmd = inp.pitch >= 0 ? lerp(a0, aTop, inp.pitch) : lerp(a0, -alphaDown, -inp.pitch);
    // The guard runs out of patience with the stick as the airspeed runs out:
    // 0 above ~1.45× the stall speed, 1 at it.
    const slow = this.stallGuard && !falling ? clamp((1.45 * this.stallSpeed - speed) / (0.45 * this.stallSpeed), 0, 1) : 0;
    if (slow > 0 && aCmd > a0) aCmd = lerp(aCmd, a0, slow);
    if (qd > 50) {
      const qs = qd * T.wingArea;
      const aMax = ((T.nMax * m * G) / qs - T.cl0) / T.clAlpha;
      const aMin = ((T.nMin * m * G) / qs - T.cl0) / T.clAlpha;
      aCmd = clamp(aCmd, aMin, Math.max(aMax, T.trimAlpha));
    }
    const bCmd = -inp.yaw * T.betaMax;
    let tx = follow * px + T.kAlpha * authE * (aCmd - alpha);
    let ty = follow * py + T.kBeta * authE * (bCmd - beta);
    // Right rolls are quicker than left ones behind a rotary.
    const rollDir = inp.roll > 0 ? 1 + T.torque * 0.5 : 1 - T.torque * 0.4;
    let tz = -inp.roll * T.rollRate * authA * rollDir;
    if (T.torque > 0 && !falling) {
      // Gyroscopic precession of the spinning crankcase: pitching up swings the
      // nose right, yawing right pitches it down. Scaled by engine speed.
      const g = T.torque * this.rpm;
      ty += -g * this.omega.x * 0.9;
      tx += g * this.omega.y * 0.7;
    }
    if (this.stalled && !falling) tz += this.wingDrop * 1.3 * clamp(speed / 20, 0.3, 1);
    // The guard also noses over: when the flight path falls away under a slow
    // machine, and before a climb can hang it on its propeller.
    if (this.stallGuard && !falling) {
      if (alpha > T.stallAlpha * 0.84) tx -= (alpha - T.stallAlpha * 0.84) * 30;
      if (alpha < -T.stallAlphaNeg * 0.8) tx += (-T.stallAlphaNeg * 0.8 - alpha) * 30;
      else if (slow > 0 && this.fwd.y > -0.1 && alpha > -T.stallAlphaNeg * 0.4) tx -= slow * (this.fwd.y + 0.1) * 1.5;
    }
    if (falling) {
      tz = this.spin;
      tx = tx * 0.4 - 0.25;
    }
    tx = clamp(tx, -3, 3);
    ty = clamp(ty, -2, 2);
    const kf = 1 - Math.exp(-dt / 0.09);
    const kr = 1 - Math.exp(-dt / 0.16);
    this.omega.x += (tx - this.omega.x) * kf;
    this.omega.y += (ty - this.omega.y) * kf;
    this.omega.z += (tz - this.omega.z) * kr;

    this.velocity.addScaledVector(_acc, dt);
    this.position.addScaledVector(this.velocity, dt);
    const w = this.omega.length();
    if (w > 1e-6) {
      _dq.setFromAxisAngle(_t1.copy(this.omega).divideScalar(w), w * dt);
      this.orientation.multiply(_dq).normalize();
    }
  }

  private groundContact(dt: number, ground: GroundQuery, water: WaterQuery, events: PlaneEvents, time: number): void {
    if (this.state === 'dead') return;
    const T = this.type;
    const gh = ground(this.position.x, this.position.z);
    if (this.position.y - gh > T.gearHeight) {
      if (this.state === 'ground') this.state = 'flying';
      return;
    }
    if (this.state === 'falling') {
      this.position.y = gh + 0.5;
      this.explode(false, events);
      return;
    }
    this.axes();
    terrainNormal(ground, this.position.x, this.position.z, _n);
    const vn = this.velocity.dot(_n);
    const pitch = Math.asin(clamp(this.fwd.y, -1, 1));
    const hard = vn < -5.5 || this.up.dot(_n) < 0.88 || pitch < -0.14 || this.speed > 55
      || _n.y < 0.93 || water(this.position.x, this.position.z);
    if (hard) {
      this.crash(events, time);
      return;
    }
    if (this.state !== 'ground') events.landed(this);
    this.state = 'ground';
    this.position.y = gh + T.gearHeight;
    if (vn < 0) this.velocity.addScaledVector(_n, -vn);
    // Wheels resist sideways motion.
    _t2.copy(this.right).addScaledVector(_n, -this.right.dot(_n)).normalize();
    this.velocity.addScaledVector(_t2, -this.velocity.dot(_t2) * Math.min(1, dt * 6));
    const sp = this.velocity.length();
    if (sp > 0) {
      const decel = (0.4 + (this.throttle < 0.05 ? 3.2 : 0)) * dt;
      this.velocity.multiplyScalar(Math.max(0, sp - decel) / sp);
    }
    // Tail-dragger attitude: wings level, nose between level and 11° up.
    const heading = Math.atan2(-this.fwd.x, -this.fwd.z);
    _q2.setFromEuler(_e.set(clamp(pitch, -0.02, 0.19), heading, 0, 'YXZ'));
    this.orientation.slerp(_q2, 1 - Math.exp(-dt * 10));
    this.omega.z *= 0.5;
    if (pitch <= -0.02 && this.omega.x < 0) this.omega.x = 0;
    if (sp < 20) this.omega.y = -this.input.yaw * 0.7;
  }

  damage(amount: number, attacker: Plane | null, point: THREE.Vector3, events: PlaneEvents, time: number): void {
    if (!this.alive || this.invuln > 0) return;
    this.hp -= amount;
    this.lastHitBy = attacker;
    this.lastHitTime = time;
    this.hitFlash = 0.12;
    if (this.hp < this.maxHp * 0.4) this.engine = Math.min(this.engine, 0.78);
    if (Math.random() < 0.015) this.engine *= 0.6;
    if (this.hp < this.maxHp * 0.22) this.fire = Math.max(this.fire, 0.35);
    events.hit(this, point, attacker);
    if (this.hp <= 0) this.kill(attacker, events, time);
  }

  kill(killer: Plane | null, events: PlaneEvents, time: number): void {
    if (!this.alive) return;
    this.state = 'falling';
    this.hp = 0;
    this.fire = 1;
    this.spin = (1.2 + Math.random() * 1.8) * (Math.random() < 0.5 ? -1 : 1);
    this.fallT = 0;
    this.input.fire = false;
    const credit = killer ?? (time - this.lastHitTime < 12 ? this.lastHitBy : null);
    events.killed(this, credit);
    if (Math.random() < 0.2) this.explode(true, events);
  }

  crash(events: PlaneEvents, time: number): void {
    if (this.alive) this.kill(null, events, time);
    this.explode(false, events);
  }

  explode(midAir: boolean, events: PlaneEvents): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.deadT = 0;
    events.exploded(this, midAir);
  }

  /** Parametric distance [0,1] along a→b of the first hitbox struck, or -1. */
  hitTest(a: THREE.Vector3, b: THREE.Vector3): number {
    _t1.subVectors(b, a);
    const len2 = _t1.lengthSq();
    const t = len2 > 0 ? clamp(_t2.subVectors(this.position, a).dot(_t1) / len2, 0, 1) : 0;
    if (_t3.copy(a).addScaledVector(_t1, t).distanceToSquared(this.position) > this.radius * this.radius) return -1;
    _t2.subVectors(a, this.position).applyQuaternion(this.invQ);
    _t3.subVectors(b, this.position).applyQuaternion(this.invQ);
    let best = -1;
    for (const hb of this.hitboxes) {
      const r = segAABB(_t2, _t3, hb.c, hb.h);
      if (r >= 0 && (best < 0 || r < best)) best = r;
    }
    return best;
  }

  private updateTelemetry(ground: GroundQuery): void {
    const t = this.telemetry;
    const q = this.orientation;
    _e.setFromQuaternion(q, 'YXZ');
    t.tas = this.speed;
    t.ias = this.speed;
    t.mach = this.speed / 340;
    t.altitude = this.position.y;
    t.agl = this.position.y - ground(this.position.x, this.position.z);
    t.verticalSpeed = this.velocity.y;
    t.alpha = this.alpha;
    t.beta = this.beta;
    t.loadFactor = this.gload;
    t.heading = ((Math.atan2(this.fwd.x, -this.fwd.z) * 180) / Math.PI + 360) % 360;
    t.pitch = _e.x;
    t.bank = _e.z;
    t.rollRate = -this.omega.z;
    t.pitchRate = this.omega.x;
    t.yawRate = -this.omega.y;
    t.onGround = this.state === 'ground';
    t.stalled = this.stalled;
    t.stallMargin = clamp(1 - Math.abs(this.alpha) / this.type.stallAlpha, 0, 1);
    t.afterburner = 0;
  }
}

function liftCoef(T: AircraftType, a: number): number {
  const aS = T.stallAlpha;
  const aN = -T.stallAlphaNeg;
  if (a >= aN && a <= aS) return T.cl0 + T.clAlpha * a;
  const plate = 0.9 * Math.sin(2 * a);
  if (a > aS) {
    const peak = T.cl0 + T.clAlpha * aS;
    return lerp(peak, Math.min(plate, peak * 0.6), clamp((a - aS) / 0.12, 0, 1));
  }
  const peakN = T.cl0 + T.clAlpha * aN;
  return lerp(peakN, Math.max(plate, peakN * 0.6), clamp((aN - a) / 0.12, 0, 1));
}

export function terrainNormal(ground: GroundQuery, x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const e = 3;
  return out.set(ground(x - e, z) - ground(x + e, z), 2 * e, ground(x, z - e) - ground(x, z + e)).normalize();
}

export function segAABB(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, h: THREE.Vector3): number {
  let tmin = 0;
  let tmax = 1;
  const ax = [a.x - c.x, a.y - c.y, a.z - c.z];
  const d = [b.x - a.x, b.y - a.y, b.z - a.z];
  const hh = [h.x, h.y, h.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (Math.abs(ax[i]) > hh[i]) return -1;
      continue;
    }
    let t1 = (-hh[i] - ax[i]) / d[i];
    let t2 = (hh[i] - ax[i]) / d[i];
    if (t1 > t2) {
      const s = t1;
      t1 = t2;
      t2 = s;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

export function segSphere(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, r: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const fz = a.z - c.z;
  const A = dx * dx + dy * dy + dz * dz;
  const B = 2 * (fx * dx + fy * dy + fz * dz);
  const C = fx * fx + fy * fy + fz * fz - r * r;
  if (C <= 0) return 0;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A === 0) return -1;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t >= 0 && t <= 1 ? t : -1;
}
