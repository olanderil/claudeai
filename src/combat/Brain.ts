import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../util/math';
import { BULLET_GRAVITY, BULLET_SPEED } from './Types';
import type { Plane } from './Plane';

/**
 * AI pilot. Ported from the reference dogfight and extended with orders, so
 * the same brain flies a scout on offensive patrol, a wingman holding station
 * on the player, and a bomber droning along its route.
 *
 * It flies by moving a destination point around and steering at it: fine
 * tracking near the nose, and at larger angles the classic "roll the target
 * overhead, then pull". Everything it does is expressed as stick inputs into
 * the same flight model the player uses.
 */

export type Orders =
  | { kind: 'hunt' }
  | { kind: 'escort'; leader: Plane; slot: THREE.Vector3; range: number }
  | { kind: 'patrol'; centre: THREE.Vector3; radius: number; engage: number }
  | { kind: 'route'; points: THREE.Vector3[]; loop: boolean; speed: number; index: number }
  | { kind: 'defend'; ward: Plane; range: number }
  /** Attack runs on something that isn't an aircraft: a balloon, a gun pit, the airship. */
  | { kind: 'attack'; target: AttackTarget; ground: boolean };

export interface AttackTarget {
  readonly position: THREE.Vector3;
  readonly velocity?: THREE.Vector3;
  readonly alive: boolean;
}

export interface BrainWorld {
  readonly planes: readonly Plane[];
  readonly time: number;
  /** Cheap ground sample for look-ahead. */
  ground(x: number, z: number): number;
  /** Aircraft that must never be targeted (e.g. none), or extra ones to prefer. */
  readonly arenaCentre: THREE.Vector3;
  readonly arenaRadius: number;
}

const _d = new THREE.Vector3();
const _db = new THREE.Vector3();
const _lead = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();

const STALL_MARGIN = 1.25;
/** Seconds ahead along the flight path that the terrain is checked. */
const LOOK_AHEAD = [1.5, 3, 5, 8, 12];

export class Brain {
  target: Plane | null = null;
  orders: Orders = { kind: 'hunt' };
  /** Set when the plane should break off and head home (damaged, out of ammo). */
  retreat = false;
  private retarget = 0;
  private mode: 'hunt' | 'evade' | 'extend' = 'hunt';
  private modeT = 0;
  private side = 1;
  private evadeUp = 0;
  private threatT = Math.random() * 0.4;
  private avoidT = 0;
  /** Which way to turn away from rising ground: -1 left, 1 right, 0 straight over. */
  private avoidSide = 0;
  private burst = 0;
  private pause = 0;
  private burstLen = 0.6;
  private readonly seed = Math.random() * 1000;
  private readonly dest = new THREE.Vector3();
  private dodgeCheck = 0;
  private dodgeT = 0;
  private readonly dodgeDir = new THREE.Vector3();
  readonly skill: number;

  constructor(readonly p: Plane, skill: number, private readonly world: BrainWorld) {
    this.skill = clamp(skill, 0.05, 1);
  }

  update(dt: number): void {
    const p = this.p;
    const sk = this.skill;
    const dest = this.dest;
    const w = this.world;
    p.axes();
    const orders = this.orders;
    const fights = orders.kind !== 'route';

    this.retarget -= dt;
    if (fights && (this.retarget <= 0 || (this.target && !this.target.alive))) {
      this.target = this.pickTarget();
      this.retarget = 1.2 + Math.random() * 1.5;
    }
    if (!fights) this.target = null;

    let fire = false;
    let throttle = 1;
    this.threatT -= dt;
    if (fights && this.threatT <= 0) {
      // Good pilots look behind them more often, see further and react more surely.
      this.threatT = lerp(0.8, 0.2, sk);
      const threat = this.mode !== 'evade' ? this.findThreat() : null;
      if (threat && Math.random() < 0.12 + sk * 0.8) {
        this.mode = 'evade';
        this.modeT = 1.4 + Math.random() * 1.4;
        // The novice skids away at random; the old hand breaks into the attacker
        // to spoil his deflection shot, and keeps it level.
        _t1.subVectors(threat.position, p.position);
        const into = _t1.dot(p.right) >= 0 ? 1 : -1;
        this.side = Math.random() < sk ? into : Math.random() < 0.5 ? -1 : 1;
        this.evadeUp = lerp(-0.4 + Math.random() * 0.9, -0.15 + Math.random() * 0.3, sk);
      }
    }

    const t = this.target;
    if (this.mode === 'evade') {
      this.modeT -= dt;
      if (this.modeT <= 0) this.mode = 'hunt';
      dest.copy(p.position).addScaledVector(p.right, this.side * 300)
        .addScaledVector(p.up, this.evadeUp * 200).addScaledVector(p.fwd, 80);
    } else if (this.mode === 'extend') {
      // Overshot at close range: run out, then come back round.
      this.modeT -= dt;
      if (this.modeT <= 0) this.mode = 'hunt';
      _t1.set(p.fwd.x, 0, p.fwd.z).normalize();
      dest.copy(p.position).addScaledVector(_t1, 300);
      dest.y += 40;
    } else if (orders.kind === 'attack' && !t && !this.retreat && orders.target.alive) {
      const r = this.attackRun(orders.target, orders.ground, dt, dest);
      fire = r.fire;
      throttle = r.throttle;
    } else if (t && !this.retreat) {
      const d = p.position.distanceTo(t.position);
      const tof = d / BULLET_SPEED;
      const err = (1 - sk) * 0.045 * d + 0.8;
      const ns = w.time * (0.7 + sk);
      _lead.copy(t.position).addScaledVector(_rel.subVectors(t.velocity, p.velocity), tof * lerp(0.6, 1, sk));
      _lead.y += 0.5 * BULLET_GRAVITY * tof * tof;
      _lead.x += Math.sin(ns + this.seed) * err;
      _lead.y += Math.sin(ns * 1.3 + this.seed * 2) * err;
      _lead.z += Math.cos(ns * 0.9 + this.seed * 3) * err;
      if (d < 650) dest.copy(_lead);
      else dest.copy(t.position).addScaledVector(t.velocity, clamp(d / 120, 0, 5));
      _t1.subVectors(_lead, p.position).normalize();
      const cosA = _t1.dot(p.fwd);
      if (p.type.guns > 0 && d < 400 + sk * 150 && cosA > Math.cos(0.03 + (1 - sk) * 0.035)) {
        if (this.pause <= 0) {
          fire = true;
          this.burst += dt;
          if (this.burst > this.burstLen) {
            this.burst = 0;
            this.burstLen = 0.4 + Math.random() * 0.7;
            this.pause = (0.3 + Math.random() * 0.8) * (1.5 - sk);
          }
        }
      }
      if (p.gun.heat > 0.8) fire = false;
      _t2.subVectors(t.position, p.position).normalize();
      const closing = -_t2.dot(_rel.subVectors(t.velocity, p.velocity));
      if (d < 200 && closing > 6 && cosA > 0.7) throttle = 0.3;
      // Head-on pass at close range or just overshot: extend and come back.
      if (d < 60 && cosA < 0 && Math.random() < dt * (1 + sk)) {
        this.mode = 'extend';
        this.modeT = 2 + Math.random() * 2;
      }
    } else {
      throttle = this.followOrders(dest);
    }
    if (this.retreat && !(this.mode === 'evade')) {
      // Head for the far edge of the arena on our side, low and fast.
      const home = p.team === 'allied' ? 1 : -1;
      dest.set(p.position.x, Math.max(p.position.y - 50, w.ground(p.position.x, p.position.z) + 200),
        p.position.z + home * 3000);
      fire = false;
    }
    this.pause -= dt;

    this.avoidCollisions(dt, dest);
    if (this.dodgeT > 0) throttle = 1;

    // Keep inside the arena.
    const ax = p.position.x - w.arenaCentre.x;
    const az = p.position.z - w.arenaCentre.z;
    if (!this.retreat && Math.hypot(ax, az) > w.arenaRadius) {
      dest.set(w.arenaCentre.x, Math.max(p.position.y, w.ground(w.arenaCentre.x, w.arenaCentre.z) + 700), w.arenaCentre.z);
      fire = false;
    }

    // Terrain avoidance, looking ahead along the velocity vector. The far
    // samples only count climbing, not diving: they're there to see a
    // mountainside coming, not to spoil a strafing run.
    const here = w.ground(p.position.x, p.position.z);
    const agl = p.position.y - here;
    let minClear = agl;
    // The steepest climb the terrain ahead asks for, m/s.
    let need = 0;
    // Strafing means going down to the deck; everything else keeps its height.
    const floor = orders.kind === 'route' ? 160 : orders.kind === 'attack' && orders.ground ? 38 : 90;
    for (const s of LOOK_AHEAD) {
      const x = p.position.x + p.velocity.x * s;
      const z = p.position.z + p.velocity.z * s;
      const vy = s > 5 ? Math.max(p.velocity.y, 0) : p.velocity.y;
      const g = w.ground(x, z);
      minClear = Math.min(minClear, p.position.y + vy * s - g);
      // Only ground that actually rises counts: low over a plain, just climb.
      if (g > here + 40) need = Math.max(need, (g + floor - p.position.y) / s);
    }
    if (agl < floor + 20 || minClear < floor - 20) {
      if (this.avoidT <= 0) this.avoidSide = 0;
      this.avoidT = 1.6;
      // More climb than a scout has: turn for the lower ground either side.
      if (need > 7 && agl > 40 && this.avoidSide === 0) this.avoidSide = this.clearerSide();
    }
    if (this.avoidT > 0) {
      this.avoidT -= dt;
      _t1.set(p.fwd.x, 0, p.fwd.z).normalize();
      _t2.set(p.right.x, 0, p.right.z).normalize();
      dest.copy(p.position).addScaledVector(_t1, 200).addScaledVector(_t2, this.avoidSide * 260);
      dest.y += 170;
      fire = false;
      throttle = 1;
    } else if (p.speed < STALL_MARGIN * p.stallSpeed) {
      _t1.set(p.fwd.x, 0, p.fwd.z).normalize();
      dest.copy(p.position).addScaledVector(_t1, 200);
      dest.y -= 30;
    }
    this.steer(dest, dt);
    p.throttle += clamp(throttle - p.throttle, -dt * 0.8, dt * 0.8);
    p.input.fire = fire && p.alive;
  }

  /**
   * Which way the ground falls away: probe the terrain either side of the
   * flight path, half left and hard left, half right and hard right.
   * Returns -1 for left, 1 for right.
   */
  private clearerSide(): number {
    const p = this.p;
    const w = this.world;
    const sp = Math.max(p.speed, 30);
    const h = Math.atan2(p.velocity.x, p.velocity.z);
    let best = -Infinity;
    let side = 1;
    for (const sgn of [-1, 1]) {
      let worst = Infinity;
      for (const a of [0.7, 1.5]) {
        // Rotating the velocity by +a turns it to the left (heading 0 = -Z).
        const ang = h + sgn * -a;
        for (const t of [3, 6]) {
          const g = w.ground(p.position.x + Math.sin(ang) * sp * t, p.position.z + Math.cos(ang) * sp * t);
          worst = Math.min(worst, p.position.y - g);
        }
      }
      if (worst > best) {
        best = worst;
        side = sgn;
      }
    }
    return side;
  }

  /** Non-combat behaviour. Returns the throttle wanted. */
  private followOrders(dest: THREE.Vector3): number {
    const p = this.p;
    const o = this.orders;
    const w = this.world;
    switch (o.kind) {
      case 'escort':
      case 'defend': {
        const lead = o.kind === 'escort' ? o.leader : o.ward;
        if (!lead.alive) {
          this.orders = { kind: 'hunt' };
          return 1;
        }
        lead.axes();
        if (o.kind === 'escort') {
          dest.copy(lead.position)
            .addScaledVector(lead.right, o.slot.x).addScaledVector(lead.up, o.slot.y).addScaledVector(lead.fwd, -o.slot.z);
        } else {
          // Weave above and behind the ward.
          const a = w.time * 0.25 + this.seed;
          dest.copy(lead.position).addScaledVector(lead.fwd, -60 + Math.sin(a) * 40)
            .addScaledVector(lead.right, Math.cos(a) * 120);
          dest.y += 80;
        }
        const along = _t1.subVectors(dest, p.position).dot(lead.fwd);
        dest.addScaledVector(lead.velocity, 1.5);
        return clamp(0.72 + along * 0.015, 0.25, 1);
      }
      case 'patrol': {
        const a = w.time * 0.05 + this.seed;
        dest.set(o.centre.x + Math.cos(a) * o.radius, o.centre.y, o.centre.z + Math.sin(a) * o.radius);
        return 0.8;
      }
      case 'route': {
        const pt = o.points[o.index];
        if (!pt) return 0.8;
        dest.copy(pt);
        const dx = pt.x - p.position.x;
        const dz = pt.z - p.position.z;
        if (dx * dx + dz * dz < 350 * 350) {
          o.index += 1;
          if (o.index >= o.points.length) o.index = o.loop ? 0 : o.points.length - 1;
        }
        // Hold the planned speed.
        return clamp(0.75 + (o.speed - p.speed) * 0.05, 0.4, 1);
      }
      default: {
        const cz = w.arenaCentre.z + (p.team === 'central' ? -1400 : 1400);
        const a = w.time * 0.05 + this.seed;
        dest.set(w.arenaCentre.x + Math.cos(a) * 1600, w.ground(w.arenaCentre.x, cz) + 800, cz + Math.sin(a) * 1200);
        return 1;
      }
    }
  }

  private pickTarget(): Plane | null {
    const p = this.p;
    const o = this.orders;
    let range = 5000;
    let anchor: THREE.Vector3 | null = null;
    if (o.kind === 'escort') {
      range = o.range;
      anchor = o.leader.position;
    } else if (o.kind === 'defend') {
      range = o.range;
      anchor = o.ward.position;
    } else if (o.kind === 'patrol') {
      range = o.engage;
      anchor = o.centre;
    } else if (o.kind === 'attack') {
      // Only turn on fighters that come close; the job is the target.
      range = 450;
      anchor = p.position;
    }
    let best: Plane | null = null;
    let bs = Infinity;
    for (const q of this.world.planes) {
      if (!q.alive || q.team === p.team || q.role === 'ignore') continue;
      const d = q.position.distanceTo(p.position);
      if (d > 5000) continue;
      if (anchor && q.position.distanceTo(anchor) > range) continue;
      _t1.subVectors(q.position, p.position).divideScalar(d || 1);
      let sc = d * (1.6 - 0.6 * _t1.dot(p.fwd));
      if (q.isPlayer) sc *= 0.7;
      // Bombers go after bombers' escorts less; fighters love a fat target.
      if (q.type.gunner && p.type.guns > 0) sc *= 0.8;
      let n = 0;
      for (const r of this.world.planes) {
        const b = r.brain as Brain | null;
        if (r !== p && b && b.target === q && r.alive) n++;
      }
      sc *= 1 + n * 0.4;
      if (sc < bs) {
        bs = sc;
        best = q;
      }
    }
    return best;
  }

  private findThreat(): Plane | null {
    const p = this.p;
    for (const o of this.world.planes) {
      if (!o.alive || o.team === p.team || o.type.guns === 0) continue;
      _t1.subVectors(p.position, o.position);
      const d = _t1.length();
      if (d > 280 + this.skill * 320 || d < 1) continue;
      _t1.divideScalar(d);
      if (o.fwd.dot(_t1) > 0.94 && p.fwd.dot(_t1) > -0.2) return o;
    }
    return null;
  }

  /**
   * One attack run: come in from height, dive on the aim point, fire from
   * inside ~450 m, pull out low and extend, then come round again.
   */
  private attackRun(t: AttackTarget, ground: boolean, dt: number, dest: THREE.Vector3): { fire: boolean; throttle: number } {
    const p = this.p;
    const d = p.position.distanceTo(t.position);
    const flat = Math.hypot(t.position.x - p.position.x, t.position.z - p.position.z);
    if (flat > 1500) {
      // Approach at height, 250 m above a ground target or level with an airborne one.
      dest.copy(t.position);
      if (ground) dest.y = Math.max(p.position.y, t.position.y + 280);
      return { fire: false, throttle: 1 };
    }
    const tof = d / BULLET_SPEED;
    dest.copy(t.position);
    if (t.velocity) dest.addScaledVector(_rel.subVectors(t.velocity, p.velocity), tof);
    else dest.addScaledVector(p.velocity, -tof);
    dest.y += 0.5 * BULLET_GRAVITY * tof * tof + (ground ? 1.5 : 0);
    _t1.subVectors(dest, p.position).normalize();
    const cosA = _t1.dot(p.fwd);
    const fire = d < 480 && cosA > Math.cos(0.035 + (1 - this.skill) * 0.03) && p.gun.heat < 0.8;
    const agl = p.position.y - this.world.ground(p.position.x, p.position.z);
    if (d < 70 || (ground && agl < 45 && d < 260)) {
      this.mode = 'extend';
      this.modeT = 4 + Math.random() * 2;
    }
    void dt;
    return { fire, throttle: ground ? 0.8 : 1 };
  }

  /** Closest point of approach with every other machine; break away if it's close. */
  private avoidCollisions(dt: number, dest: THREE.Vector3): void {
    const p = this.p;
    this.dodgeCheck -= dt;
    if (this.dodgeCheck <= 0) {
      this.dodgeCheck = 0.1;
      let best = Infinity;
      for (const o of this.world.planes) {
        if (o === p || !o.alive) continue;
        _t1.subVectors(o.position, p.position);
        const reach = 350 + o.radius * 10;
        if (_t1.lengthSq() > reach * reach) continue;
        _t2.subVectors(o.velocity, p.velocity);
        const vv = _t2.lengthSq();
        if (vv < 1) continue;
        const tc = -_t1.dot(_t2) / vv;
        if (tc < 0 || tc > 3) continue;
        const miss = _t3.copy(_t1).addScaledVector(_t2, tc);
        if (miss.length() < 25 + o.radius * 1.5 && tc < best) {
          best = tc;
          // Push away from where the other machine will be; dead ahead means break right.
          miss.addScaledVector(p.fwd, -miss.dot(p.fwd));
          if (miss.lengthSq() < 4) miss.copy(p.right).negate();
          this.dodgeDir.copy(miss).normalize().negate();
          this.dodgeT = 0.9;
        }
      }
    }
    if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      dest.copy(p.position).addScaledVector(p.fwd, 90).addScaledVector(this.dodgeDir, 160);
    }
  }

  private steer(dest: THREE.Vector3, dt: number): void {
    const p = this.p;
    _d.subVectors(dest, p.position);
    const dist = _d.length();
    if (dist < 1) return;
    _d.divideScalar(dist);
    _db.copy(_d).applyQuaternion(p.invQ);
    const off = Math.acos(clamp(-_db.z, -1, 1));
    const rollErr = Math.atan2(_db.x, _db.y);
    const elev = Math.atan2(_db.y, -_db.z);
    const azim = Math.atan2(_db.x, -_db.z);
    const bank = Math.atan2(-p.right.y, p.up.y);
    // Fine tracking near the nose.
    const maxBank = p.type.gunner ? 0.55 : 0.9;
    const desiredBank = clamp(azim * 5, -maxBank, maxBank);
    const rollFine = clamp((desiredBank - bank) * 2.2, -1, 1);
    const pitchFine = clamp(elev * 6, -1, 1);
    const yawFine = clamp(azim * 6, -1, 1);
    // Gross manoeuvring: roll the target overhead, then pull. Heavies don't.
    const rollMan = p.type.gunner ? rollFine : clamp(rollErr * 2.2, -1, 1);
    const pitchMan = p.type.gunner ? pitchFine * 0.6 : clamp(off * 2.5, 0, 1) * Math.max(0, Math.cos(rollErr));
    const wgt = smoothstep(0.08, 0.45, off);
    const k = dt * (3 + this.skill * 5);
    const inp = p.input;
    inp.roll += clamp(lerp(rollFine, rollMan, wgt) - inp.roll, -k, k);
    inp.pitch += clamp(lerp(pitchFine, pitchMan, wgt) - inp.pitch, -k, k);
    inp.yaw += clamp(lerp(yawFine, clamp(azim, -1, 1) * 0.3, wgt) - inp.yaw, -k, k);
  }
}
