import * as THREE from 'three';
import { BULLET_GRAVITY, BULLET_LIFE, BULLET_SPEED, type Team } from './Types';
import type { Plane } from './Plane';

/**
 * Rifle-calibre rounds from every gun in the battle, and the tracers that
 * show them.
 *
 * Rounds are a fixed pool advanced each physics tick and swept segment by
 * segment against aircraft and targets, so a 640 m/s round can't tunnel
 * through a 6 m aeroplane between ticks. Only every other round draws a
 * tracer — belts were loaded with one tracer in two or three — but every
 * round hits.
 */

export interface Round {
  active: boolean;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  owner: Plane | null;
  team: Team;
  damage: number;
  tracer: boolean;
  /** Whether this round already cracked past the listener. */
  whizzed: boolean;
}

export interface Shootable {
  readonly alive: boolean;
  readonly team: Team;
  hitTest(a: THREE.Vector3, b: THREE.Vector3): number;
}

export interface BallisticsHooks {
  /** A round struck something: apply damage and effects. */
  strike(target: Shootable, round: Round, point: THREE.Vector3): void;
  /** A round went into the ground or the water. */
  impact(point: THREE.Vector3, water: boolean): void;
  /** A round passed close by the listener. */
  whiz(point: THREE.Vector3): void;
}

const MAX_ROUNDS = 1400;
const TRACER_LENGTH = 9;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const _hp = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Vector3();

export class Ballistics {
  readonly rounds: Round[];
  readonly tracers: THREE.InstancedMesh;
  private cursor = 0;
  private readonly allied = new THREE.Color(1.0, 0.78, 0.42).multiplyScalar(5.5);
  private readonly central = new THREE.Color(1.0, 0.55, 0.28).multiplyScalar(5.5);

  constructor() {
    this.rounds = Array.from({ length: MAX_ROUNDS }, () => ({
      active: false, pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(),
      life: 0, owner: null, team: 'allied' as Team, damage: 0, tracer: false, whizzed: false,
    }));
    // A thin tapered streak: bright head, fading tail.
    const geo = new THREE.CylinderGeometry(0.07, 0.025, 1, 5, 1, true);
    geo.rotateX(Math.PI / 2);
    this.tracers = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }), MAX_ROUNDS);
    this.tracers.frustumCulled = false;
    this.tracers.count = 0;
    this.tracers.renderOrder = 5;
    for (let i = 0; i < MAX_ROUNDS; i++) this.tracers.setColorAt(i, this.allied);
  }

  fire(origin: THREE.Vector3, dir: THREE.Vector3, carrier: THREE.Vector3, owner: Plane | null, team: Team, damage: number, tracer: boolean): void {
    const r = this.rounds[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_ROUNDS;
    r.active = true;
    r.pos.copy(origin);
    r.prev.copy(origin);
    r.vel.copy(carrier).addScaledVector(dir, BULLET_SPEED);
    r.life = BULLET_LIFE;
    r.owner = owner;
    r.team = team;
    r.damage = damage;
    r.tracer = tracer;
    r.whizzed = false;
  }

  clear(): void {
    for (const r of this.rounds) r.active = false;
    this.tracers.count = 0;
  }

  step(
    dt: number,
    targets: readonly Shootable[],
    ground: (x: number, z: number) => number,
    water: (x: number, z: number) => boolean,
    listener: THREE.Vector3 | null,
    hooks: BallisticsHooks,
  ): void {
    for (const r of this.rounds) {
      if (!r.active) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.active = false;
        continue;
      }
      r.prev.copy(r.pos);
      r.vel.y -= BULLET_GRAVITY * dt;
      r.pos.addScaledVector(r.vel, dt);
      let hit: Shootable | null = null;
      let ht = 2;
      for (const t of targets) {
        if (!t.alive || t.team === r.team || t === (r.owner as unknown as Shootable)) continue;
        const k = t.hitTest(r.prev, r.pos);
        if (k >= 0 && k < ht) {
          ht = k;
          hit = t;
        }
      }
      if (hit) {
        _hp.lerpVectors(r.prev, r.pos, ht);
        hooks.strike(hit, r, _hp);
        r.active = false;
        continue;
      }
      // Enemy rounds that pass within a few metres of the listener crack by.
      if (listener && !r.whizzed && r.owner && !r.owner.isPlayer) {
        const d2 = r.pos.distanceToSquared(listener);
        if (d2 < 14 * 14) {
          r.whizzed = true;
          hooks.whiz(r.pos);
        }
      }
      const gh = ground(r.pos.x, r.pos.z);
      if (r.pos.y < gh) {
        r.active = false;
        _hp.set(r.pos.x, gh, r.pos.z);
        hooks.impact(_hp, water(r.pos.x, r.pos.z));
      }
    }
  }

  /**
   * Lay the tracer instances out for this frame.
   *
   * A tracer is a few centimetres across, which is sub-pixel beyond fifty
   * metres — yet what the eye sees is the burning compound's glow, a streak
   * that stays visible to the end of its burn. So each streak is kept at
   * least a pixel and a half wide wherever it is.
   */
  render(eye: THREE.Vector3, glow?: (pos: THREE.Vector3, size: number) => void): void {
    let n = 0;
    for (const r of this.rounds) {
      if (!r.active || !r.tracer) continue;
      // Young rounds draw short so the streak starts at the muzzle, not ahead of it.
      const age = BULLET_LIFE - r.life;
      const len = Math.min(TRACER_LENGTH, age * BULLET_SPEED * 0.9 + 0.5);
      _dir.copy(r.vel).normalize();
      _c.copy(r.pos).addScaledVector(_dir, -len / 2);
      _q.setFromUnitVectors(Z_AXIS, _dir);
      // Burn-out: the tracer compound gives up well before the round falls.
      const fade = Math.min(1, r.life / 0.5);
      const dist = eye.distanceTo(_c);
      const w = fade * Math.max(1, (dist * 0.0024) / 0.07);
      // Seen from astern — which is how you usually see your own — a streak is
      // end-on and all but vanishes; the burning head is what reads.
      glow?.(r.pos, fade * Math.max(0.6, dist * 0.0068));
      _s.set(w, w, len);
      _m.compose(_c, _q, _s);
      this.tracers.setMatrixAt(n, _m);
      this.tracers.setColorAt(n, r.team === 'allied' ? this.allied : this.central);
      n++;
    }
    this.tracers.count = n;
    this.tracers.instanceMatrix.needsUpdate = true;
    if (this.tracers.instanceColor) this.tracers.instanceColor.needsUpdate = true;
  }
}
