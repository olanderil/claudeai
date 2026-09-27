import * as THREE from 'three';
import { ParticleSystem, flameTexture, glowTexture, puffTexture, type Lighting } from './Particles';

/**
 * The battle's visual effects, built from three particle systems:
 *
 *   smoke — lit, alpha-blended billows (explosions, trails, flak, dust, spray)
 *   fire  — additive flame tongues and flashes
 *   spark — small additive points (hits, debris embers)
 *
 * plus long-lived emitters for things that keep burning: wrecks on the
 * ground, a falling balloon, smoke columns over the lines.
 */

const lin = (hex: string): number[] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

export const C = {
  flash: [1.0, 0.92, 0.78],
  fireHot: [1.0, 0.72, 0.36],
  fireCool: [0.85, 0.22, 0.04],
  smokeBlack: lin('#1a1816'),
  smokeDark: lin('#2c2925'),
  smokeMid: lin('#5d5852'),
  smokeGrey: lin('#8e8983'),
  smokeLight: lin('#c2bdb5'),
  smokeWhite: lin('#e6e4df'),
  debris: lin('#1d1b18'),
  dust: lin('#8b7a5c'),
  mud: lin('#5a4a36'),
  chalk: lin('#cfc8b6'),
  splash: lin('#e8eef0'),
  spark: [1.0, 0.85, 0.5],
};

interface Emitter {
  pos: THREE.Vector3;
  t: number;
  life: number;
  acc: number;
  kind: 'wreck' | 'column' | 'burning';
  strength: number;
  follow?: THREE.Vector3;
}

const _r = new THREE.Vector3();
const _v = new THREE.Vector3();

function randDir(out: THREE.Vector3): THREE.Vector3 {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(a), u, s * Math.sin(a));
}
const rand = (a: number, b: number): number => a + Math.random() * (b - a);

export interface ShakeSink {
  (amount: number, at: THREE.Vector3): void;
}

export class Effects {
  readonly group = new THREE.Group();
  readonly smoke: ParticleSystem;
  readonly fire: ParticleSystem;
  readonly spark: ParticleSystem;
  private readonly emitters: Emitter[] = [];
  readonly wind = new THREE.Vector3(2.4, 0, 1.0);
  /** Camera position, for level-of-detail decisions. */
  readonly eye = new THREE.Vector3();
  /** Point lights that flash with big explosions (a small pool). */
  private readonly flashes: { light: THREE.PointLight; t: number; life: number; peak: number }[] = [];

  constructor() {
    this.smoke = new ParticleSystem(5000, puffTexture(128, 11, 7, 0.55), false, 6);
    this.fire = new ParticleSystem(2600, flameTexture(128, 5), true, 7, 3.2);
    this.spark = new ParticleSystem(3000, glowTexture(32, 2), true, 7, 6);
    this.group.add(this.smoke.mesh, this.fire.mesh, this.spark.mesh);
    // Two, permanently in the scene: every lit material pays for each point
    // light whether it's on or not, and adding or removing them recompiles
    // every shader.
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xffa860, 0, 180, 2);
      light.castShadow = false;
      this.group.add(light);
      this.flashes.push({ light, t: 1, life: 1, peak: 0 });
    }
  }

  setLighting(l: Lighting): void {
    this.smoke.setLighting(l);
    this.fire.setLighting(l);
    this.spark.setLighting(l);
  }

  clear(): void {
    this.smoke.clear();
    this.fire.clear();
    this.spark.clear();
    this.emitters.length = 0;
  }

  private near(pos: THREE.Vector3, range: number): boolean {
    return this.eye.distanceToSquared(pos) < range * range;
  }

  private flashLight(pos: THREE.Vector3, peak: number, life: number): void {
    let slot = this.flashes[0];
    for (const f of this.flashes) if (f.t / f.life > slot.t / slot.life) slot = f;
    slot.light.position.copy(pos);
    slot.t = 0;
    slot.life = life;
    slot.peak = peak;
  }

  /** Aircraft, balloon basket or ground target going up. `scale` ~1 for a scout. */
  explosion(pos: THREE.Vector3, scale = 1, ground = false): void {
    const { x, y, z } = pos;
    const far = !this.near(pos, 2500);
    this.fire.spawn(x, y, z, 0, 0, 0, 0.3, 6 * scale, 42 * scale, C.flash, C.fireHot, 1, 0, 0, 0);
    this.flashLight(pos, 4000 * scale, 0.6);
    const nFire = far ? 6 : 20;
    for (let i = 0; i < nFire; i++) {
      randDir(_r).multiplyScalar(rand(4, 18) * scale);
      if (ground) _r.y = Math.abs(_r.y) * 1.6;
      this.fire.spawn(x, y, z, _r.x, _r.y + 3, _r.z, rand(0.5, 1.3), rand(4, 8) * scale, rand(12, 24) * scale,
        C.fireHot, C.fireCool, 1, 0, 1.6, 2);
    }
    const nSmoke = far ? 8 : 24;
    for (let i = 0; i < nSmoke; i++) {
      randDir(_r).multiplyScalar(rand(2, 11) * scale);
      if (ground) _r.y = Math.abs(_r.y) * 1.5;
      this.smoke.spawn(x + _r.x * 0.3, y + _r.y * 0.3, z + _r.z * 0.3, _r.x, _r.y + 2, _r.z, rand(3.5, 8),
        rand(5, 9) * scale, rand(22, 38) * scale, C.smokeDark, C.smokeMid, 0.9, 0, 0.9, 2.2, 1);
    }
    if (!far) {
      // Debris: dark chunks on ballistic arcs with ember trails.
      for (let i = 0; i < 16; i++) {
        randDir(_r).multiplyScalar(rand(10, 34));
        this.smoke.spawn(x, y, z, _r.x, _r.y + 12, _r.z, rand(1.5, 3), 0.9, 0.7, C.debris, C.debris, 1, 1, 0.15, -9.8);
        if (i % 2 === 0) this.spark.spawn(x, y, z, _r.x, _r.y + 12, _r.z, rand(1, 2.2), 0.7, 0.3, C.spark, C.fireCool, 1, 0, 0.2, -9.8);
      }
    }
    if (ground) this.dirtFountain(pos, scale);
  }

  /** Earth thrown up by a shell or bomb: a brown column with a dark top. */
  dirtFountain(pos: THREE.Vector3, scale = 1, chalk = false): void {
    const { x, y, z } = pos;
    const col = chalk ? C.chalk : C.mud;
    for (let i = 0; i < 14; i++) {
      _r.set(rand(-1, 1) * 5, rand(18, 38), rand(-1, 1) * 5).multiplyScalar(scale);
      this.smoke.spawn(x, y, z, _r.x, _r.y, _r.z, rand(2, 4), rand(3, 5) * scale, rand(10, 16) * scale,
        col, C.smokeGrey, 0.85, 0, 1.2, -6);
    }
    for (let i = 0; i < 6; i++) {
      randDir(_r).multiplyScalar(6 * scale);
      this.smoke.spawn(x + _r.x, y + 2, z + _r.z, _r.x * 0.5, 2 + Math.abs(_r.y), _r.z * 0.5, rand(6, 10),
        rand(8, 12) * scale, rand(26, 40) * scale, C.smokeMid, C.smokeLight, 0.5, 0, 0.6, 0.6);
    }
  }

  /** Round striking an airframe or target. */
  sparks(pos: THREE.Vector3, vel: THREE.Vector3): void {
    if (!this.near(pos, 1800)) return;
    for (let i = 0; i < 5; i++) {
      randDir(_r).multiplyScalar(rand(6, 22));
      this.spark.spawn(pos.x, pos.y, pos.z, vel.x * 0.9 + _r.x, vel.y * 0.9 + _r.y, vel.z * 0.9 + _r.z,
        rand(0.12, 0.3), 0.35, 0.15, C.spark, C.fireCool, 1, 0, 1, -4);
    }
    // Splinters and a puff of torn doped fabric.
    this.smoke.spawn(pos.x, pos.y, pos.z, vel.x * 0.8, vel.y * 0.8, vel.z * 0.8, 0.8, 0.6, 3.2,
      C.smokeLight, C.smokeGrey, 0.6, 0, 3, 0);
  }

  /**
   * Anti-aircraft burst. Allied Archie burst white, German black — pilots
   * learned to tell whose guns were firing from the colour of the smoke.
   */
  flak(pos: THREE.Vector3, black: boolean): void {
    const { x, y, z } = pos;
    this.fire.spawn(x, y, z, 0, 0, 0, 0.14, 4, 16, C.flash, C.fireHot, 1, 0, 0, 0);
    this.flashLight(pos, 900, 0.25);
    const c0 = black ? C.smokeBlack : C.smokeWhite;
    const c1 = black ? C.smokeDark : C.smokeLight;
    for (let i = 0; i < 9; i++) {
      randDir(_r).multiplyScalar(rand(1.5, 6));
      this.smoke.spawn(x + _r.x, y + _r.y, z + _r.z, _r.x, _r.y, _r.z, rand(6, 11), rand(3, 5), rand(15, 24),
        c0, c1, 0.92, 0, 1.2, 0.15, 0.8);
    }
  }

  /** Bullet into the ground or water. */
  impact(pos: THREE.Vector3, water: boolean): void {
    if (!this.near(pos, 1500)) return;
    if (water) {
      this.smoke.spawn(pos.x, pos.y + 0.3, pos.z, 0, 7, 0, 0.9, 0.6, 2.6, C.splash, C.splash, 0.75, 0, 2, -9);
    } else {
      this.smoke.spawn(pos.x, pos.y + 0.4, pos.z, 0, 2.5, 0, 1.3, 0.7, 3.8, C.dust, C.dust, 0.7, 0, 2, 0);
    }
  }

  /** Muzzle smoke from a gun position. */
  gunSmoke(pos: THREE.Vector3, vel: THREE.Vector3): void {
    if (!this.near(pos, 600)) return;
    this.smoke.spawn(pos.x, pos.y, pos.z, vel.x * 0.6, vel.y * 0.6, vel.z * 0.6, 0.6, 0.3, 1.8,
      C.smokeLight, C.smokeLight, 0.18, 0, 3, 0);
  }

  /** Damaged aircraft trail; called per physics tick by the plane visuals. */
  trail(pos: THREE.Vector3, vel: THREE.Vector3, heavy: boolean, burning: boolean): void {
    const far = !this.near(pos, 3000);
    this.smoke.spawn(pos.x, pos.y, pos.z, vel.x * 0.05 + rand(-1, 1), vel.y * 0.05 + rand(0, 1), vel.z * 0.05 + rand(-1, 1),
      rand(2.5, heavy ? 6 : 3.5) * (far ? 1.5 : 1), 1.2, heavy ? rand(7, 11) : rand(4.5, 7),
      heavy ? C.smokeDark : C.smokeMid, heavy ? C.smokeMid : C.smokeLight, heavy ? 0.55 : 0.4, 0, 1.2, 0.8, burning ? 0.8 : 0);
    if (burning && !far) {
      this.fire.spawn(pos.x, pos.y, pos.z, vel.x * 0.85, vel.y * 0.85, vel.z * 0.85, rand(0.15, 0.35), 1.8, 3.8,
        C.fireHot, C.fireCool, 1, 0, 2, 0);
    }
  }

  /** A column of smoke that keeps going (burning wreck, ruin, dump). */
  addEmitter(pos: THREE.Vector3, kind: Emitter['kind'], life: number, strength = 1, follow?: THREE.Vector3): void {
    this.emitters.push({ pos: pos.clone(), t: 0, life, acc: 0, kind, strength, follow });
  }

  /** Hydrogen going up: the envelope burns top-down in a roaring sheet. */
  balloonFire(pos: THREE.Vector3, size: number): void {
    for (let i = 0; i < 4; i++) {
      _r.set(rand(-1, 1) * size * 0.4, rand(-0.3, 0.5) * size * 0.3, rand(-1, 1) * size * 0.5);
      _v.copy(pos).add(_r);
      this.fire.spawn(_v.x, _v.y, _v.z, 0, 5, 0, rand(0.6, 1.3), 6, 16, C.fireHot, C.fireCool, 1, 0, 1, 3);
      this.smoke.spawn(_v.x, _v.y + 4, _v.z, 0, 4, 0, rand(5, 8), 7, 22, C.smokeBlack, C.smokeDark, 0.7, 0, 0.5, 1, 1);
    }
  }

  update(dt: number): void {
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.t += dt;
      e.acc += dt;
      if (e.t > e.life) {
        this.emitters.splice(i, 1);
        continue;
      }
      if (e.follow) e.pos.copy(e.follow);
      const fade = 1 - e.t / e.life;
      const far = !this.near(e.pos, 4000);
      const period = (e.kind === 'column' ? 0.35 : 0.16) * (far ? 2.5 : 1);
      while (e.acc > period) {
        e.acc -= period;
        const s = e.strength;
        if (e.kind === 'column') {
          this.smoke.spawn(e.pos.x + rand(-6, 6), e.pos.y + 3, e.pos.z + rand(-6, 6), 0, rand(5, 8), 0, rand(16, 26),
            10 * s, rand(50, 80) * s, C.smokeDark, C.smokeGrey, 0.5 * fade, 0, 0.15, 0.35);
        } else {
          this.smoke.spawn(e.pos.x + rand(-2, 2), e.pos.y + 2, e.pos.z + rand(-2, 2), 0, rand(4, 6), 0, rand(7, 11),
            5 * s, rand(24, 36) * s, C.smokeBlack, C.smokeGrey, 0.6 * fade, 0, 0.35, 1.2, 0.6);
          if (e.t < e.life * 0.6 && !far) {
            this.fire.spawn(e.pos.x + rand(-2, 2) * s, e.pos.y + 1, e.pos.z + rand(-2, 2) * s, 0, 3, 0, rand(0.4, 0.9),
              3 * s, 6.5 * s, C.fireHot, C.fireCool, 0.9, 0, 1, 2);
          }
        }
      }
    }
    for (const f of this.flashes) {
      f.t += dt;
      const k = Math.max(0, 1 - f.t / f.life);
      f.light.intensity = f.peak * k * k;
    }
    this.smoke.update(dt, this.wind);
    this.fire.update(dt, this.wind);
    this.spark.update(dt, this.wind);
  }
}
