/**
 * Where a sound is, relative to the ears, and what the air does to it on the way.
 *
 * The AudioListener is left at the origin facing -Z; every source is moved
 * into the camera's frame here instead (three.js cameras also look down -Z
 * with +Y up). That sidesteps the listener-orientation API differences between
 * browsers and means one quaternion rotate per source per frame.
 */

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export const SPEED_OF_SOUND = 343;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Finite or fallback — the game's numbers go straight into AudioParams, which throw on NaN. */
export const fin = (x: number, d = 0): number => (Number.isFinite(x) ? x : d);

/**
 * Air absorption as a lowpass corner: ~11 kHz at 100 m, ~6 kHz at 300 m,
 * ~2.6 kHz at 1 km, ~1.1 kHz at 3 km — roughly where ISO 9613 puts the
 * −6 dB point for dry summer air.
 */
export function airCutoff(d: number): number {
  return clamp(20000 * Math.pow(1 + d / 100, -0.85), 300, 20000);
}

/** Inverse-distance law from `ref`, with an exponent below 1 for sounds that must carry. */
export function distGain(d: number, ref: number, exp = 1): number {
  return d <= ref ? 1 : Math.pow(ref / d, exp);
}

export class Listener {
  x = 0;
  y = 0;
  z = 0;
  /** The inverse (conjugate) of the camera orientation. */
  private qx = 0;
  private qy = 0;
  private qz = 0;
  private qw = 1;
  vx = 0;
  vy = 0;
  vz = 0;
  cockpit = true;
  /** Output of `local()`: the last point in listener space. */
  readonly rel: Vec3 = { x: 0, y: 0, z: -1 };

  set(p: Vec3, q: Quat, v: Vec3, cockpit: boolean): void {
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      this.x = p.x;
      this.y = p.y;
      this.z = p.z;
    }
    const n = Math.hypot(q.x, q.y, q.z, q.w);
    if (n > 1e-6 && Number.isFinite(n)) {
      this.qx = -q.x / n;
      this.qy = -q.y / n;
      this.qz = -q.z / n;
      this.qw = q.w / n;
    }
    this.vx = fin(v.x);
    this.vy = fin(v.y);
    this.vz = fin(v.z);
    this.cockpit = !!cockpit;
  }

  /** Move a world point into listener space (written to `rel`); returns its distance. */
  local(x: number, y: number, z: number): number {
    const dx = x - this.x;
    const dy = y - this.y;
    const dz = z - this.z;
    const ix = this.qx, iy = this.qy, iz = this.qz, w = this.qw;
    const tx = 2 * (iy * dz - iz * dy);
    const ty = 2 * (iz * dx - ix * dz);
    const tz = 2 * (ix * dy - iy * dx);
    this.rel.x = dx + w * tx + (iy * tz - iz * ty);
    this.rel.y = dy + w * ty + (iz * tx - ix * tz);
    this.rel.z = dz + w * tz + (ix * ty - iy * tx);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Doppler factor for a source moving at `v`: f'/f = (c − v_l·u)/(c − v_s·u)
   * with u the unit vector from source to listener. Clamped to an octave
   * either way so a teleport never produces a squeal.
   */
  doppler(x: number, y: number, z: number, vx: number, vy: number, vz: number): number {
    const dx = this.x - x;
    const dy = this.y - y;
    const dz = this.z - z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 0.5 || !Number.isFinite(d)) return 1;
    const ux = dx / d, uy = dy / d, uz = dz / d;
    const vs = clamp(fin(vx) * ux + fin(vy) * uy + fin(vz) * uz, -0.8 * SPEED_OF_SOUND, 0.8 * SPEED_OF_SOUND);
    const vl = clamp(this.vx * ux + this.vy * uy + this.vz * uz, -0.8 * SPEED_OF_SOUND, 0.8 * SPEED_OF_SOUND);
    return clamp((SPEED_OF_SOUND - vl) / (SPEED_OF_SOUND - vs), 0.5, 2);
  }
}

/** Ramp an AudioParam toward a value; NaN-safe. */
export function glide(p: AudioParam, v: number, t: number, tc: number): void {
  if (Number.isFinite(v)) p.setTargetAtTime(v, t, tc);
}

export function makePanner(ctx: BaseAudioContext, hrtf: boolean): PannerNode {
  const p = ctx.createPanner();
  try {
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
  } catch {
    p.panningModel = 'equalpower';
  }
  // Direction only: distance loss, air and doppler are all done by hand.
  p.distanceModel = 'inverse';
  p.refDistance = 1;
  p.maxDistance = 1e5;
  p.rolloffFactor = 0;
  p.coneInnerAngle = 360;
  p.coneOuterAngle = 360;
  return p;
}

/** Point a panner at a listener-space position. `tc` > 0 glides (for moving sources). */
export function aim(p: PannerNode, rel: Vec3, t: number, tc: number): void {
  let x = rel.x, y = rel.y, z = rel.z;
  const d = Math.sqrt(x * x + y * y + z * z);
  if (!(d > 0.05)) {
    x = 0;
    y = 0;
    z = -1;
  } else if (d > 50) {
    // Direction is all the panner uses; keep the numbers tame.
    const k = 50 / d;
    x *= k;
    y *= k;
    z *= k;
  }
  if (p.positionX) {
    if (tc > 0) {
      p.positionX.setTargetAtTime(x, t, tc);
      p.positionY.setTargetAtTime(y, t, tc);
      p.positionZ.setTargetAtTime(z, t, tc);
    } else {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    }
  } else {
    p.setPosition(x, y, z);
  }
}

/**
 * The positional tail every non-UI voice runs through:
 *   input (level) → air lowpass → panner → bus
 *                          └→ send → reverb
 */
export class Spatial {
  readonly input: GainNode;
  readonly lp: BiquadFilterNode;
  readonly panner: PannerNode;
  readonly send: GainNode;

  constructor(ctx: BaseAudioContext, bus: AudioNode, verb: AudioNode, hrtf: boolean, gain = 0) {
    this.input = ctx.createGain();
    this.input.gain.value = gain;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 20000;
    this.lp.Q.value = -3; // dB in Web Audio for lowpass: Butterworth-ish, no bump
    this.panner = makePanner(ctx, hrtf);
    this.send = ctx.createGain();
    this.send.gain.value = 0;
    this.input.connect(this.lp);
    this.lp.connect(this.panner);
    this.panner.connect(bus);
    this.lp.connect(this.send);
    this.send.connect(verb);
  }

  /** Continuous voices: glide everything. */
  steer(t: number, rel: Vec3, gain: number, verb: number, cutoff: number, tc = 0.04): void {
    aim(this.panner, rel, t, tc);
    glide(this.input.gain, gain, t, tc);
    glide(this.send.gain, verb, t, 0.1);
    glide(this.lp.frequency, cutoff, t, 0.08);
  }

  /** One-shots: set once at creation. */
  place(rel: Vec3, gain: number, verb: number, cutoff: number): void {
    aim(this.panner, rel, 0, 0);
    this.input.gain.value = gain;
    this.send.gain.value = verb;
    this.lp.frequency.value = cutoff;
  }

  dispose(): void {
    this.input.disconnect();
    this.lp.disconnect();
    this.panner.disconnect();
    this.send.disconnect();
  }
}
