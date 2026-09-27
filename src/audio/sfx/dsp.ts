/**
 * Offline DSP toolkit for the sound bank.
 *
 * Everything here works on plain Float32Arrays with no Web Audio at all, so the
 * bank can be rendered (and tested) anywhere. The live graph only ever plays
 * back what these functions produce, filters it and positions it.
 */

export type Rng = () => number;

/** mulberry32: small, fast, seeded. Seeded so a given build always sounds the same. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [-1, 1). */
export const bi = (r: Rng): number => r() * 2 - 1;
/** Uniform in [lo, hi). */
export const range = (r: Rng, lo: number, hi: number): number => lo + (hi - lo) * r();
/** Approximately normal, mean 0, sd 1 (Irwin–Hall of 4). */
export const gauss = (r: Rng): number => (r() + r() + r() + r() - 2) * 1.732;

export const TAU = Math.PI * 2;

export type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'lowshelf' | 'highshelf';

/** RBJ-cookbook biquad, transposed direct form II. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(type: BiquadType, sr: number, freq: number, q = 0.7071, gainDb = 0) {
    this.set(type, sr, freq, q, gainDb);
  }

  set(type: BiquadType, sr: number, freq: number, q = 0.7071, gainDb = 0): this {
    const f = Math.min(Math.max(freq, 5), sr * 0.49);
    const w = (TAU * f) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * Math.max(q, 1e-3));
    const A = Math.pow(10, gainDb / 40);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (type) {
      case 'lowpass':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'bandpass':
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'peaking':
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
        a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s;
        break;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }

  tick(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** Filter `src` into `dst` (may be the same array). Locals keep V8's inner loop tight. */
  run(src: Float32Array, dst: Float32Array = src): Float32Array {
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    let z1 = this.z1, z2 = this.z2;
    for (let i = 0, n = src.length; i < n; i++) {
      const x = src[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      dst[i] = y;
    }
    this.z1 = z1;
    this.z2 = z2;
    return dst;
  }

  /**
   * Filter a buffer that will be played as a seamless loop: a warm-up over the
   * loop's tail brings the filter to its periodic steady state, then the real
   * pass writes output, so the end of the loop flows into its head with no seam.
   * `warm` samples must span many time constants of the slowest pole; the
   * default (~170 ms at 48 kHz) covers anything with Q/(πf) under ~15 ms.
   */
  runLoop(src: Float32Array, dst: Float32Array = src, warm = 8192): Float32Array {
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    let z1 = this.z1, z2 = this.z2;
    for (let i = Math.max(0, src.length - warm), n = src.length; i < n; i++) {
      const x = src[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
    }
    this.z1 = z1;
    this.z2 = z2;
    return this.run(src, dst);
  }
}

/**
 * A parallel filter bank over a loop, in one pass: `dst += Σ gains[k]·filters[k](src)`.
 * Each filter is warmed over the loop's tail first, as in `runLoop`.
 */
export function bankLoop(src: Float32Array, filters: Biquad[], gains: number[], dst: Float32Array, warm = 8192): void {
  const n = src.length;
  for (const f of filters) for (let i = Math.max(0, n - warm); i < n; i++) f.tick(src[i]);
  const k = filters.length;
  for (let i = 0; i < n; i++) {
    const x = src[i];
    let acc = 0;
    for (let j = 0; j < k; j++) acc += gains[j] * filters[j].tick(x);
    dst[i] += acc;
  }
}

/** Filter chain helper: returns a new array. */
export function filtered(src: Float32Array, ...fs: Biquad[]): Float32Array {
  const out = new Float32Array(src);
  for (const f of fs) f.run(out);
  return out;
}

export function filteredLoop(src: Float32Array, ...fs: Biquad[]): Float32Array {
  const out = new Float32Array(src);
  for (const f of fs) f.runLoop(out);
  return out;
}

export function whiteNoise(n: number, r: Rng): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = bi(r);
  return out;
}

/** Paul Kellet's economy pink filter applied to white noise; loop-safe (two passes). */
export function pinkNoise(n: number, r: Rng): Float32Array {
  const w = whiteNoise(n, r);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const x = w[i];
      b0 = 0.99765 * b0 + x * 0.099046;
      b1 = 0.963 * b1 + x * 0.2965164;
      b2 = 0.57 * b2 + x * 1.0526913;
      out[i] = (b0 + b1 + b2 + x * 0.1848) * 0.2;
    }
  }
  removeDc(out);
  return out;
}

/** Leaky-integrated white noise; loop-safe. */
export function brownNoise(n: number, r: Rng, leak = 0.985): Float32Array {
  const w = whiteNoise(n, r);
  const out = new Float32Array(n);
  let b = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      b = b * leak + w[i] * (1 - leak) * 6;
      out[i] = b;
    }
  }
  removeDc(out);
  return out;
}

export function removeDc(buf: Float32Array): void {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m += buf[i];
  m /= buf.length || 1;
  for (let i = 0; i < buf.length; i++) buf[i] -= m;
}

export function peak(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

export function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function scale(buf: Float32Array, g: number): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

export function normalizePeak(buf: Float32Array, target = 0.9): Float32Array {
  const p = peak(buf);
  return p > 1e-9 ? scale(buf, target / p) : buf;
}

/** tanh via a (7,6) Padé approximant: exact to ~1e-6 inside ±5, clamped beyond. */
export function fastTanh(x: number): number {
  if (x > 4.97) return 1;
  if (x < -4.97) return -1;
  const x2 = x * x;
  return (x * (135135 + x2 * (17325 + x2 * (378 + x2)))) / (135135 + x2 * (62370 + x2 * (3150 + x2 * 28)));
}

/** Symmetric tanh saturation, gain-compensated so small signals keep unity gain. */
export function saturate(buf: Float32Array, drive: number): Float32Array {
  if (drive <= 0) return buf;
  const inv = 1 / drive;
  for (let i = 0; i < buf.length; i++) buf[i] = fastTanh(buf[i] * drive) * inv;
  return buf;
}

/** Add `src` into `dst` at sample offset, wrapping if `wrap`. */
export function mixInto(dst: Float32Array, src: Float32Array, offset: number, gain = 1, wrap = false): void {
  const n = dst.length;
  const i0 = Math.max(0, -offset);
  const direct = Math.min(src.length, n - offset);
  for (let i = i0; i < direct; i++) dst[offset + i] += src[i] * gain;
  if (!wrap) return;
  for (let i = Math.max(direct, i0); i < src.length; i++) dst[(offset + i) % n] += src[i] * gain;
}

export function fadeOut(buf: Float32Array, samples: number): Float32Array {
  const n = Math.min(samples, buf.length);
  for (let i = 0; i < n; i++) buf[buf.length - 1 - i] *= i / n;
  return buf;
}

export function fadeIn(buf: Float32Array, samples: number): Float32Array {
  const n = Math.min(samples, buf.length);
  for (let i = 0; i < n; i++) buf[i] *= i / n;
  return buf;
}

/**
 * A damped mode — the building block of every click, clank, ping and bell in
 * the bank. Adds `amp·e^(-t/tau)·sin(2πft+φ)` from `start` on, with a short
 * raised-cosine attack so nothing starts on a step.
 */
export function addMode(
  dst: Float32Array, sr: number, start: number, freq: number, amp: number, tau: number,
  phase = 0, attack = 0.0004, wrap = false,
): void {
  const n = dst.length;
  const s0 = Math.round(start * sr);
  if (!wrap && s0 >= n) return;
  const len = Math.min(Math.round(tau * 7 * sr), wrap ? n : n - s0);
  const att = Math.max(1, Math.round(attack * sr));
  const w = (TAU * freq) / sr;
  const c = Math.cos(w);
  const s = Math.sin(w);
  let zr = Math.cos(phase);
  let zi = Math.sin(phase);
  const dec = Math.exp(-1 / (tau * sr));
  let env = amp;
  let j = s0 % n;
  for (let i = 0; i < len; i++) {
    const a = i < att ? 0.5 - 0.5 * Math.cos((Math.PI * i) / att) : 1;
    dst[j] += env * a * zi;
    const nr = zr * c - zi * s;
    zi = zr * s + zi * c;
    zr = nr;
    env *= dec;
    if (++j >= n) j = 0;
  }
}

/** Exponentially decaying white-noise burst with a short linear attack. */
export function addNoiseBurst(
  dst: Float32Array, sr: number, start: number, amp: number, tau: number, r: Rng,
  attack = 0.0002, wrap = false,
): void {
  const n = dst.length;
  const s0 = Math.round(start * sr);
  if (!wrap && s0 >= n) return;
  const len = Math.min(Math.round(tau * 7 * sr), wrap ? n : n - s0);
  const att = Math.max(1, Math.round(attack * sr));
  const dec = Math.exp(-1 / (tau * sr));
  let env = amp;
  let j = s0 % n;
  for (let i = 0; i < len; i++) {
    const a = i < att ? i / att : 1;
    dst[j] += env * a * (r() * 2 - 1);
    env *= dec;
    if (++j >= n) j = 0;
  }
}

/**
 * An N-wave: the pressure signature of a shock (muzzle blast, bullet crack,
 * detonation). Sharp positive jump, linear fall through zero to the negative
 * peak, sharp return. Slightly softened at the edges to keep aliasing down.
 */
export function addNWave(dst: Float32Array, sr: number, start: number, amp: number, width: number): void {
  const s0 = Math.round(start * sr);
  const len = Math.max(4, Math.round(width * sr));
  const edge = 2;
  for (let i = 0; i < len && s0 + i < dst.length; i++) {
    let v = 1 - (2 * i) / (len - 1);
    if (i < edge) v *= (i + 1) / (edge + 1);
    if (i > len - 1 - edge) v *= (len - i) / (edge + 1);
    dst[s0 + i] += amp * v;
  }
}

/**
 * Low sine-ish "boom" with an exponential pitch drop, the body of every
 * explosion, thump and gunshot. `f(t) = fEnd + (fStart - fEnd)·e^(-t/pitchTau)`.
 */
export function addBoom(
  dst: Float32Array, sr: number, start: number, amp: number,
  fStart: number, fEnd: number, pitchTau: number, attack: number, decay: number,
): void {
  const s0 = Math.round(start * sr);
  const len = Math.min(dst.length - s0, Math.round((attack + decay * 7) * sr));
  const pDec = Math.exp(-1 / (pitchTau * sr));
  const aDec = Math.exp(-1 / (Math.max(attack, 1e-4) * sr));
  const dDec = Math.exp(-1 / (decay * sr));
  const k = TAU / sr;
  let df = fStart - fEnd;
  let aEnv = 1;
  let dEnv = amp;
  // Phasor rotated by a per-sample angle; small-angle series for sin/cos.
  let zr = 1;
  let zi = 0;
  for (let i = 0; i < len; i++) {
    dst[s0 + i] += (1 - aEnv) * dEnv * zi;
    const w = (fEnd + df) * k;
    const w2 = w * w;
    const cw = 1 - w2 * (0.5 - w2 * (1 / 24 - w2 / 720));
    const sw = w * (1 - w2 * (1 / 6 - w2 / 120));
    const nr = zr * cw - zi * sw;
    zi = zr * sw + zi * cw;
    zr = nr;
    if ((i & 1023) === 1023) {
      const m = 1 / Math.sqrt(zr * zr + zi * zi);
      zr *= m;
      zi *= m;
    }
    df *= pDec;
    aEnv *= aDec;
    dEnv *= dDec;
  }
}

/**
 * Time-varying bandpass over noise: `centre(t)` is sampled every 32 samples.
 * Used for whooshes, bullet zips and the falling-bomb swish.
 */
export function sweptNoise(
  n: number, sr: number, r: Rng, q: number,
  centre: (t: number) => number, env: (t: number) => number,
): Float32Array {
  const out = new Float32Array(n);
  const f = new Biquad('bandpass', sr, centre(0), q);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 31) === 0) f.set('bandpass', sr, centre(t), q);
    out[i] = f.tick(bi(r)) * env(t);
  }
  return out;
}

/** Smooth random control signal in roughly [-1, 1], changing at about `rateHz`. */
export function smoothRandom(n: number, sr: number, rateHz: number, r: Rng): Float32Array {
  const out = new Float32Array(n);
  const step = Math.max(1, Math.round(sr / rateHz));
  let a = bi(r);
  let b = bi(r);
  for (let i = 0; i < n; i++) {
    const k = i % step;
    if (k === 0 && i > 0) {
      a = b;
      b = bi(r);
    }
    const u = k / step;
    const s = u * u * (3 - 2 * u);
    out[i] = a + (b - a) * s;
  }
  return out;
}

export function envAD(t: number, attack: number, decay: number): number {
  if (t < 0) return 0;
  const a = attack > 0 ? Math.min(1, t / attack) : 1;
  return a * Math.exp(-Math.max(0, t - attack) / decay);
}

/** `envAD` sampled into an array (recursive, no per-sample exp). `delay` shifts the start. */
export function envelope(n: number, sr: number, delay: number, attack: number, decay: number): Float32Array {
  const out = new Float32Array(n);
  const d0 = Math.max(0, Math.round(delay * sr));
  const na = Math.max(1, Math.round(attack * sr));
  const dec = Math.exp(-1 / (decay * sr));
  let e = 1;
  for (let i = d0; i < n; i++) {
    const k = i - d0;
    if (k < na) out[i] = k / na;
    else {
      out[i] = e;
      e *= dec;
    }
  }
  return out;
}
