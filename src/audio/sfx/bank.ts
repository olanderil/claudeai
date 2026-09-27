/**
 * The sound bank: every sample the game plays, synthesised from nothing.
 *
 * Each entry is a pure function of sample rate (and a fixed seed) that returns
 * one or more variants as Float32Arrays. There is no Web Audio in this file —
 * `Sfx` turns clips into AudioBuffers lazily and caches them per context — so
 * the whole bank can be rendered and inspected offline.
 *
 * The recipes lean on a handful of physical signatures rather than on
 * oscillators: the N-wave of a shock front, noise bursts shaped by resonant
 * bodies (exhaust stubs, wooden spars, doped fabric, steel), and exponentially
 * pitched "booms" for anything with mass behind it. Saturation glues the
 * layers and adds the harmonics that let a 30 Hz boom read on small speakers.
 */

import {
  Biquad, TAU, addBoom, addMode, addNWave, addNoiseBurst, bi, brownNoise, envAD, fadeIn, fadeOut,
  filtered, filteredLoop, gauss, makeRng, mixInto, normalizePeak, peak, pinkNoise, range, rms,
  saturate, scale, smoothRandom, sweptNoise, whiteNoise, envelope, type Rng,
} from './dsp';

export interface Clip {
  sr: number;
  /** One array per channel (mono unless noted). */
  ch: Float32Array[];
}

const mono = (sr: number, data: Float32Array): Clip => ({ sr, ch: [data] });
const zeros = (sec: number, sr: number): Float32Array => new Float32Array(Math.max(1, Math.round(sec * sr)));
/** Half rate for layers that are all low end — half the memory and render time. */
const lowRate = (sr: number): number => (sr >= 44100 ? Math.round(sr / 2) : sr);

/** Lowpass whose cutoff follows `cutoff(t)`, updated every 64 samples. */
function sweptLowpass(src: Float32Array, sr: number, q: number, cutoff: (t: number) => number): Float32Array {
  const out = new Float32Array(src.length);
  const f1 = new Biquad('lowpass', sr, cutoff(0), q);
  const f2 = new Biquad('lowpass', sr, cutoff(0), q);
  for (let i = 0; i < src.length; i++) {
    if ((i & 63) === 0) {
      const c = cutoff(i / sr);
      f1.set('lowpass', sr, c, q);
      f2.set('lowpass', sr, c, q);
    }
    out[i] = f2.tick(f1.tick(src[i]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/**
 * A loop of one engine's exhaust at a reference rpm, built firing by firing.
 *
 * Each firing is a half-sine pressure pulse plus a burst of blast noise,
 * dropped into one of three cylinder groups. Each group rings through its own
 * slightly detuned set of exhaust resonances (the stubs are never quite the
 * same length), the raw pulse train adds the low thump and, band-limited, the
 * rasp. Per-cylinder strength differences give the cycle-rate roughness that
 * makes a rotary go "brrrap" instead of buzzing. The loop is an exact whole
 * number of engine cycles and every filter is run to its periodic steady state,
 * so it loops without a seam.
 */
export interface EngineSpec {
  refRpm: number;
  /** Firings per two revolutions (one four-stroke cycle). */
  firings: number;
  /** Cylinder index for each firing slot in a cycle. */
  order: number[];
  cycles: number;
  cylSpread: number;
  ampJitter: number;
  timeJitter: number;
  weakProb: number;
  pulseMs: number;
  blastTau: number;
  blastMix: number;
  modes: [number, number, number][];
  modeSpread: number;
  body: [number, number];
  rasp: [number, number, number];
  clatter: number;
  clatterFreqs: number[];
  drive: number;
  seed: number;
}

export function renderEngineLoop(spec: EngineSpec, sr: number): Float32Array {
  const r = makeRng(spec.seed);
  const cycleSec = 120 / spec.refRpm;
  const L = Math.round(spec.cycles * cycleSec * sr);
  const N = spec.cycles * spec.firings;
  const interval = L / N;
  const G = 3;
  const groups: Float32Array[] = [];
  for (let g = 0; g < G; g++) groups.push(new Float32Array(L));
  const all = new Float32Array(L);
  const clatter = new Float32Array(L);
  const ncyl = Math.max(...spec.order) + 1;
  const cylAmp: number[] = [];
  for (let c = 0; c < ncyl; c++) cylAmp.push(Math.min(1.5, Math.max(0.45, 1 + spec.cylSpread * gauss(r) * 0.6)));
  const W = Math.max(3, Math.round((spec.pulseMs / 1000) * sr));
  const blastLen = Math.round((spec.blastTau / 1000) * 6 * sr);
  const blastDec = Math.exp(-1 / ((spec.blastTau / 1000) * sr));

  for (let k = 0; k < N; k++) {
    const c = spec.order[k % spec.firings];
    const g = groups[c % G];
    const jit = Math.max(-0.35, Math.min(0.35, spec.timeJitter * gauss(r)));
    const t0 = Math.round((k + jit) * interval + L) % L;
    let amp = cylAmp[c] * Math.max(0.2, 1 + spec.ampJitter * gauss(r));
    if (r() < spec.weakProb) amp *= range(r, 0.12, 0.45);
    for (let i = 0; i < W; i++) {
      const v = amp * Math.sin((Math.PI * i) / W);
      const j = (t0 + i) % L;
      g[j] += v;
      all[j] += v;
    }
    let env = amp * spec.blastMix;
    for (let i = 0; i < blastLen; i++) {
      const v = env * bi(r) * (i < 4 ? i / 4 : 1);
      const j = (t0 + i) % L;
      g[j] += v;
      all[j] += v;
      env *= blastDec;
    }
    if (spec.clatter > 0) {
      const tc = (t0 + Math.round(interval * range(r, 0.3, 0.45))) / sr;
      for (const f of spec.clatterFreqs) {
        addMode(clatter, sr, tc, f * (1 + 0.03 * gauss(r)), spec.clatter * range(r, 0.4, 1), range(r, 0.0012, 0.003), r() * TAU, 0.0002, true);
      }
    }
  }

  const y = new Float32Array(L);
  for (let g = 0; g < G; g++) {
    const det = 1 + spec.modeSpread * (g - 1) + spec.modeSpread * 0.3 * gauss(r);
    for (const [f, q, gain] of spec.modes) {
      const band = filteredLoop(groups[g], new Biquad('bandpass', sr, f * det, q));
      mixInto(y, band, 0, gain);
    }
  }
  const [bf, bg] = spec.body;
  mixInto(y, filteredLoop(all, new Biquad('lowpass', sr, bf, 0.9), new Biquad('lowpass', sr, bf, 0.6)), 0, bg);
  const [rlo, rhi, rg] = spec.rasp;
  mixInto(y, filteredLoop(all, new Biquad('highpass', sr, rlo, 0.7), new Biquad('lowpass', sr, rhi, 0.7)), 0, rg);
  mixInto(y, clatter, 0, 1);

  scale(y, 0.3 / (rms(y) || 1));
  saturate(y, spec.drive);
  const dc = filteredLoop(y, new Biquad('highpass', sr, 28, 0.7));
  normalizePeak(dc, 0.95);
  return dc;
}

const ROTARY_HI: EngineSpec = {
  refRpm: 1200, firings: 9, order: [0, 2, 4, 6, 8, 1, 3, 5, 7], cycles: 24,
  cylSpread: 0.45, ampJitter: 0.14, timeJitter: 0.035, weakProb: 0.025,
  pulseMs: 0.8, blastTau: 2.4, blastMix: 1.0,
  modes: [[360, 2.5, 1.0], [700, 3.5, 0.8], [1300, 4, 0.55], [2350, 4, 0.35]], modeSpread: 0.07,
  body: [170, 1.1], rasp: [1700, 5200, 0.55], clatter: 0.05, clatterFreqs: [3100, 4600, 6300],
  drive: 2.6, seed: 101,
};
const ROTARY_LO: EngineSpec = {
  ...ROTARY_HI, refRpm: 700, cycles: 12, cylSpread: 0.5, ampJitter: 0.3, timeJitter: 0.05, weakProb: 0.1,
  blastMix: 0.75, blastTau: 2.8, body: [140, 1.2], rasp: [1500, 4500, 0.4], drive: 1.8, seed: 102,
};
const INLINE_HI: EngineSpec = {
  refRpm: 1500, firings: 6, order: [0, 4, 2, 5, 1, 3], cycles: 30,
  cylSpread: 0.14, ampJitter: 0.07, timeJitter: 0.015, weakProb: 0.004,
  pulseMs: 1.4, blastTau: 3.6, blastMix: 0.6,
  modes: [[150, 2.2, 1.0], [310, 3, 0.85], [560, 3.5, 0.55], [1080, 4, 0.28]], modeSpread: 0.04,
  body: [120, 1.3], rasp: [1200, 3600, 0.22], clatter: 0.035, clatterFreqs: [2700, 4100, 5500],
  drive: 1.7, seed: 201,
};
const INLINE_LO: EngineSpec = {
  ...INLINE_HI, refRpm: 800, cycles: 14, cylSpread: 0.2, ampJitter: 0.2, timeJitter: 0.03, weakProb: 0.04,
  blastMix: 0.5, drive: 1.3, seed: 202,
};
const HEAVY_HI: EngineSpec = {
  refRpm: 1300, firings: 6, order: [0, 4, 2, 5, 1, 3], cycles: 26,
  cylSpread: 0.12, ampJitter: 0.08, timeJitter: 0.015, weakProb: 0.004,
  pulseMs: 2.0, blastTau: 5, blastMix: 0.5,
  modes: [[92, 2.2, 1.0], [195, 2.8, 0.85], [380, 3.5, 0.45], [760, 4, 0.2]], modeSpread: 0.04,
  body: [90, 1.5], rasp: [900, 2600, 0.12], clatter: 0.02, clatterFreqs: [2300, 3500],
  drive: 1.6, seed: 301,
};
const HEAVY_LO: EngineSpec = {
  ...HEAVY_HI, refRpm: 750, cycles: 13, ampJitter: 0.18, timeJitter: 0.03, weakProb: 0.03, blastMix: 0.4, drive: 1.3, seed: 302,
};

export const ENGINE_SPECS = {
  rotary: { hi: ROTARY_HI, lo: ROTARY_LO },
  inline: { hi: INLINE_HI, lo: INLINE_LO },
  heavy: { hi: HEAVY_HI, lo: HEAVY_LO },
} as const;

/** Exhaust pop / backfire / blip-switch re-ignition. */
function crackle(sr: number, r: Rng): Float32Array {
  const o = zeros(0.07, sr);
  addNWave(o, sr, 0.0003, 0.7, range(r, 0.0004, 0.0008));
  const n = zeros(0.07, sr);
  addNoiseBurst(n, sr, 0.0002, 1, range(r, 0.002, 0.004), r);
  mixInto(o, filtered(n, new Biquad('bandpass', sr, range(r, 500, 1200), 1.1)), 0, 2.2);
  addMode(o, sr, 0.0005, range(r, 220, 420), 0.4, range(r, 0.006, 0.012), 0);
  saturate(o, 1.5);
  fadeOut(o, Math.round(0.01 * sr));
  return normalizePeak(o, 0.9);
}

// ---------------------------------------------------------------------------
// Guns
// ---------------------------------------------------------------------------

export type GunKind = 'vickers' | 'spandau' | 'lewis';

interface GunSpec {
  len: number;
  crackW: number;
  thump: [number, number];
  thumpAmp: number;
  body: number;
  bodyTau: number;
  mech: number[];
  mechT: number[];
  mechAmp: number;
}

const GUN_SPECS: Record<GunKind, GunSpec> = {
  vickers: { len: 0.24, crackW: 0.00034, thump: [150, 72], thumpAmp: 0.8, body: 380, bodyTau: 0.02, mech: [1850, 3100, 4700, 6900], mechT: [0.016, 0.052, 0.088], mechAmp: 0.16 },
  spandau: { len: 0.24, crackW: 0.00036, thump: [135, 66], thumpAmp: 0.85, body: 330, bodyTau: 0.022, mech: [1600, 2750, 4300, 6100], mechT: [0.018, 0.056, 0.094], mechAmp: 0.15 },
  lewis: { len: 0.2, crackW: 0.0003, thump: [175, 95], thumpAmp: 0.6, body: 480, bodyTau: 0.014, mech: [2300, 3600, 5500, 7800], mechT: [0.012, 0.04, 0.066], mechAmp: 0.2 },
};

/**
 * One round. Muzzle crack (N-wave + hiss), the blast's body (band noise + a
 * pitched-down thump), then the gun working: unlock, feed and lock-return
 * clicks ringing the receiver's modes, and a smear of blast reflecting off the
 * cowling and wings.
 */
function gunShot(kind: GunKind, sr: number, r: Rng): Float32Array {
  const s = GUN_SPECS[kind];
  const o = zeros(s.len, sr);
  const t0 = 0.0006;
  addNWave(o, sr, t0, 1.0, s.crackW * range(r, 0.9, 1.1));
  const hiss = zeros(s.len, sr);
  addNoiseBurst(hiss, sr, t0, 1, 0.0012, r);
  mixInto(o, filtered(hiss, new Biquad('highpass', sr, 1500, 0.7)), 0, 0.8);
  const body = zeros(s.len, sr);
  addNoiseBurst(body, sr, t0, 1, s.bodyTau * range(r, 0.85, 1.15), r, 0.0008);
  mixInto(o, filtered(body, new Biquad('bandpass', sr, s.body * range(r, 0.9, 1.1), 0.8)), 0, 1.6);
  addBoom(o, sr, t0, s.thumpAmp * range(r, 0.9, 1.05), s.thump[0], s.thump[1], 0.012, 0.0007, 0.028);
  for (const mt of s.mechT) {
    const t = mt + 0.003 * gauss(r);
    const a = s.mechAmp * range(r, 0.6, 1.1);
    addNoiseBurst(o, sr, t, a * 0.6, 0.0003, r);
    for (const f of s.mech) addMode(o, sr, t, f * (1 + 0.025 * gauss(r)), a * range(r, 0.4, 1), range(r, 0.006, 0.02), r() * TAU);
  }
  const refl = zeros(s.len, sr);
  addNoiseBurst(refl, sr, 0.004, 0.3, 0.035, r, 0.003);
  mixInto(o, filtered(refl, new Biquad('lowpass', sr, 2200, 0.7)), 0, 1);
  saturate(o, 1.5);
  fadeOut(o, Math.round(0.012 * sr));
  return normalizePeak(o, 0.95);
}

// ---------------------------------------------------------------------------
// Impacts
// ---------------------------------------------------------------------------

function fabric(o: Float32Array, sr: number, r: Rng, amp: number): void {
  addNWave(o, sr, 0.0005, amp * 0.55, 0.0003);
  const n = zeros(o.length / sr, sr);
  addNoiseBurst(n, sr, 0.0005, 1, 0.004, r);
  mixInto(o, filtered(n, new Biquad('bandpass', sr, range(r, 1400, 2300), 0.9)), 0, amp * 2);
  addMode(o, sr, 0.0005, range(r, 150, 260), amp * 0.5, 0.02, 0, 0.001);
  const tear = zeros(o.length / sr, sr);
  const te = envelope(tear.length, sr, 0.004, 0.006, 0.03);
  for (let i = 0; i < tear.length; i++) tear[i] = bi(r) * te[i];
  mixInto(o, filtered(tear, new Biquad('highpass', sr, 2600, 0.7)), 0, amp * 0.25);
}

function wood(o: Float32Array, sr: number, r: Rng, amp: number): void {
  addNWave(o, sr, 0.0005, amp * 0.9, 0.0004);
  const base = range(r, 620, 900);
  const ratios = [1, 1.62, 2.33, 3.1];
  const amps = [0.5, 0.35, 0.25, 0.15];
  const taus = [0.012, 0.008, 0.006, 0.004];
  for (let i = 0; i < 4; i++) addMode(o, sr, 0.0006, base * ratios[i] * range(r, 0.97, 1.03), amp * amps[i], taus[i], r() * TAU);
  const k = 2 + Math.floor(r() * 3);
  for (let i = 0; i < k; i++) addNoiseBurst(o, sr, range(r, 0.015, 0.09), amp * range(r, 0.08, 0.22), 0.0008, r);
}

function wire(o: Float32Array, sr: number, r: Rng, amp: number): void {
  const f0 = range(r, 1400, 2300);
  const ratios = [1, 2.02, 2.97, 4.1];
  const a = [0.2, 0.1, 0.06, 0.03];
  const tau = [0.22, 0.15, 0.1, 0.06];
  for (let i = 0; i < 4; i++) addMode(o, sr, 0.001, f0 * ratios[i], amp * a[i], tau[i], r() * TAU);
}

function metal(o: Float32Array, sr: number, r: Rng, amp: number): void {
  addNWave(o, sr, 0.0005, amp, 0.0003);
  const f0 = range(r, 900, 1150);
  const ratios = [1, 1.47, 2.21, 2.93, 3.61];
  for (let i = 0; i < ratios.length; i++) addMode(o, sr, 0.0006, f0 * ratios[i], amp * (0.3 - i * 0.045), range(r, 0.03, 0.08), r() * TAU);
}

function hitVariant(v: number, sr: number, r: Rng): Float32Array {
  const o = zeros(0.35, sr);
  switch (v % 8) {
    case 0: case 1: fabric(o, sr, r, 1); break;
    case 2: case 3: wood(o, sr, r, 1); break;
    case 4: fabric(o, sr, r, 1); wire(o, sr, r, 0.8); break;
    case 5: wood(o, sr, r, 1); wire(o, sr, r, 0.7); break;
    case 6: metal(o, sr, r, 1); break;
    default: fabric(o, sr, r, 0.8); wood(o, sr, r, 0.6); break;
  }
  saturate(o, 1.2);
  fadeOut(o, Math.round(0.03 * sr));
  return normalizePeak(o, 0.9);
}

/** The body of a close hit: felt through the seat more than heard. */
function hitThud(sr: number, r: Rng): Float32Array {
  const o = zeros(0.25, sr);
  addBoom(o, sr, 0.0005, 1, range(r, 100, 130), 55, 0.02, 0.001, 0.035);
  const n = zeros(0.25, sr);
  addNoiseBurst(n, sr, 0.0005, 1, 0.02, r, 0.001);
  mixInto(o, filtered(n, new Biquad('lowpass', sr, 260, 0.8)), 0, 1.4);
  saturate(o, 1.6);
  fadeOut(o, Math.round(0.03 * sr));
  return normalizePeak(o, 0.9);
}

function hitConfirm(sr: number, r: Rng): Float32Array {
  const o = zeros(0.09, sr);
  addMode(o, sr, 0.0003, 1900, 0.5, 0.012);
  addMode(o, sr, 0.0003, 3150, 0.3, 0.007, 1);
  addMode(o, sr, 0.0003, 820, 0.25, 0.015, 2);
  addNoiseBurst(o, sr, 0.0002, 0.25, 0.0005, r);
  fadeOut(o, Math.round(0.01 * sr));
  return normalizePeak(o, 0.9);
}

/** Supersonic crack of a round passing close, then its zip. */
function whiz(sr: number, r: Rng): Float32Array {
  const len = 0.35;
  const o = zeros(len, sr);
  addNWave(o, sr, 0.001, 1, range(r, 0.00018, 0.0003));
  const f0 = range(r, 2200, 3200);
  const zip = sweptNoise(o.length, sr, r, 3.5,
    (t) => 1200 + f0 * Math.exp(-t / range(r, 0.04, 0.07)),
    (t) => envAD(t - 0.0015, 0.004, 0.05));
  mixInto(o, zip, 0, 1.6);
  fadeOut(o, Math.round(0.03 * sr));
  return normalizePeak(o, 0.95);
}

// ---------------------------------------------------------------------------
// Explosions, flak, fire, artillery
// ---------------------------------------------------------------------------

function expCrack(sr: number, r: Rng): Float32Array {
  const o = zeros(0.45, sr);
  addNWave(o, sr, 0.001, 1, range(r, 0.0006, 0.0011));
  const nb = zeros(0.45, sr);
  addNoiseBurst(nb, sr, 0.001, 1, 0.006, r);
  mixInto(o, filtered(nb, new Biquad('highpass', sr, 400, 0.7)), 0, 0.8);
  const nb2 = zeros(0.45, sr);
  addNoiseBurst(nb2, sr, 0.001, 1, 0.035, r, 0.001);
  mixInto(o, filtered(nb2, new Biquad('bandpass', sr, 1100, 0.6)), 0, 1.0);
  const pops = 6 + Math.floor(r() * 5);
  for (let i = 0; i < pops; i++) addNoiseBurst(o, sr, range(r, 0.01, 0.3), range(r, 0.1, 0.28), 0.0006, r);
  saturate(o, 1.3);
  fadeOut(o, Math.round(0.05 * sr));
  return normalizePeak(o, 0.95);
}

function expBoom(sr: number, r: Rng): Float32Array {
  const o = zeros(3, sr);
  addBoom(o, sr, 0, 1, range(r, 70, 90), range(r, 26, 32), 0.22, 0.004, 0.6);
  addBoom(o, sr, range(r, 0.08, 0.14), 0.35, 60, 28, 0.2, 0.01, 0.5);
  const body = brownNoise(o.length, r);
  const be = envelope(body.length, sr, 0, 0.006, 0.45);
  for (let i = 0; i < body.length; i++) body[i] *= be[i];
  const lp = filtered(body, new Biquad('lowpass', sr, 200, 0.7), new Biquad('lowpass', sr, 200, 0.7));
  mixInto(o, lp, 0, 0.7 / (peak(lp) || 1));
  saturate(o, 1.8);
  fadeOut(o, Math.round(0.4 * sr));
  return normalizePeak(o, 0.95);
}

function expTail(sr: number, r: Rng): Float32Array {
  const n = Math.round(5 * sr);
  const src = brownNoise(n, r);
  const pk = pinkNoise(n, r);
  mixInto(src, pk, 0, 0.3 * (rms(src) / (rms(pk) || 1)));
  const out = sweptLowpass(src, sr, 0.7, (t) => 240 + 2200 * Math.exp(-t / 0.5));
  const am = smoothRandom(n, sr, 3, r);
  const te = envelope(n, sr, 0, 0.04, 1.3);
  for (let i = 0; i < n; i++) out[i] *= te[i] * (1 + 0.45 * am[i]);
  normalizePeak(out, 0.8);
  // Burning debris: crackle whose rate falls away over two seconds.
  let t = 0.05;
  while (t < 2.2) {
    const rate = 2 + 23 * Math.exp(-t / 0.5);
    t += -Math.log(1 - r() * 0.999) / rate;
    addNoiseBurst(out, sr, t, range(r, 0.05, 0.15) * envAD(t, 0.04, 1.2), range(r, 0.0004, 0.001), r);
  }
  fadeOut(out, Math.round(0.5 * sr));
  return normalizePeak(out, 0.9);
}

function expDebris(sr: number, r: Rng): Float32Array {
  const o = zeros(3, sr);
  const n = 26 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) {
    const t = 0.12 + 2.3 * Math.pow(r(), 1.7);
    const a = 0.9 * Math.exp(-t / 0.9) * range(r, 0.3, 1);
    const kind = r();
    if (kind < 0.5) {
      const b = range(r, 900, 2800);
      addNoiseBurst(o, sr, t, a * 0.5, 0.0005, r);
      addMode(o, sr, t, b, a * 0.4, range(r, 0.003, 0.008), r() * TAU);
      addMode(o, sr, t, b * 1.7, a * 0.25, range(r, 0.002, 0.005), r() * TAU);
    } else if (kind < 0.75) {
      const b = range(r, 2500, 5500);
      addMode(o, sr, t, b, a * 0.3, range(r, 0.015, 0.04), r() * TAU);
      addMode(o, sr, t, b * 1.53, a * 0.15, range(r, 0.01, 0.03), r() * TAU);
    } else {
      addBoom(o, sr, t, a * 0.8, 95, 60, 0.02, 0.002, 0.03);
      const nb = zeros(0.1, sr);
      addNoiseBurst(nb, sr, 0, 1, 0.012, r, 0.001);
      mixInto(o, filtered(nb, new Biquad('lowpass', sr, 180, 0.7)), Math.round(t * sr), a * 1.2);
    }
  }
  fadeOut(o, Math.round(0.2 * sr));
  return normalizePeak(o, 0.9);
}

/** "Archie": dry crack, a chesty whoomph, and a dull inharmonic ring. */
function flak(sr: number, r: Rng): Float32Array {
  const len = 1.8;
  const o = zeros(len, sr);
  addNWave(o, sr, 0.001, 1, range(r, 0.0004, 0.0006));
  const nb = zeros(len, sr);
  addNoiseBurst(nb, sr, 0.001, 1, 0.003, r);
  mixInto(o, filtered(nb, new Biquad('highpass', sr, 800, 0.7)), 0, 0.8);
  const wh = zeros(len, sr);
  addNoiseBurst(wh, sr, 0.001, 1, 0.07, r, 0.002);
  mixInto(o, filtered(wh, new Biquad('bandpass', sr, range(r, 160, 220), 0.8), new Biquad('lowpass', sr, 420, 0.7)), 0, 2.2);
  addBoom(o, sr, 0.001, 0.8, 70, 44, 0.05, 0.002, 0.09);
  const ring = [230, 347, 512, 689].map((f) => f * range(r, 0.94, 1.06));
  for (let i = 0; i < ring.length; i++) addMode(o, sr, 0.002, ring[i], 0.12 - i * 0.015, range(r, 0.25, 0.45), r() * TAU, 0.005);
  const tail = zeros(len, sr);
  const fe = envelope(tail.length, sr, 0.01, 0.03, 0.3);
  for (let i = 0; i < tail.length; i++) tail[i] = bi(r) * fe[i];
  mixInto(o, filtered(tail, new Biquad('lowpass', sr, 900, 0.7)), 0, 0.15);
  saturate(o, 1.4);
  fadeOut(o, Math.round(0.3 * sr));
  return normalizePeak(o, 0.95);
}

/** Hydrogen going up: a rising whoosh into a ragged, flickering roar. */
function balloonBurn(sr: number, r: Rng): Float32Array {
  const len = 4.5;
  const n = Math.round(len * sr);
  const o = sweptNoise(n, sr, r, 1.2,
    (t) => (t < 0.6 ? 200 + 700 * (t / 0.6) : 300 + 600 * Math.exp(-(t - 0.6) / 0.9)),
    (t) => (t < 0.35 ? Math.pow(t / 0.35, 2) : Math.exp(-(t - 0.35) / 1.4)));
  scale(o, 1 / (peak(o) || 1));
  addBoom(o, sr, 0.15, 0.7, 70, 38, 0.15, 0.03, 0.25);
  const roar = brownNoise(n, r);
  const flick = smoothRandom(n, sr, 11, r);
  const re = envelope(n, sr, 0.2, 0.4, 1.6);
  for (let i = 0; i < n; i++) roar[i] *= re[i] * (1 + 0.5 * flick[i]);
  const rl = filtered(roar, new Biquad('lowpass', sr, 420, 0.7));
  mixInto(o, rl, 0, 0.8 / (peak(rl) || 1));
  let t = 0.4;
  while (t < 3.6) {
    t += -Math.log(1 - r() * 0.999) / (14 * Math.exp(-(t - 0.4) / 1.5) + 2);
    addNoiseBurst(o, sr, t, range(r, 0.05, 0.18) * Math.exp(-(t - 0.4) / 1.8), range(r, 0.0004, 0.0012), r);
  }
  saturate(o, 1.2);
  fadeOut(o, Math.round(0.6 * sr));
  return normalizePeak(o, 0.9);
}

/** A distant gun or shell: soft thump, then the landscape handing it back. */
function artillery(sr: number, r: Rng): Float32Array {
  const len = 4.5;
  const n = Math.round(len * sr);
  const o = new Float32Array(n);
  addBoom(o, sr, 0.005, 1, range(r, 60, 75), range(r, 32, 40), 0.15, 0.008, 0.35);
  const echoes = 3 + Math.floor(r() * 3);
  for (let i = 0; i < echoes; i++) {
    addBoom(o, sr, range(r, 0.2, 1.6), range(r, 0.12, 0.35), 55, 34, 0.2, 0.05, 0.4);
  }
  const b = brownNoise(n, r);
  const am = smoothRandom(n, sr, 2.2, r);
  const ae = envelope(n, sr, 0, 0.08, 1.2);
  for (let i = 0; i < n; i++) b[i] *= ae[i] * (1 + 0.5 * am[i]);
  const bl = filtered(b, new Biquad('lowpass', sr, 260, 0.7), new Biquad('lowpass', sr, 260, 0.7));
  mixInto(o, bl, 0, 0.55 / (peak(bl) || 1));
  saturate(o, 1.7);
  fadeOut(o, Math.round(0.6 * sr));
  return normalizePeak(o, 0.9);
}

// ---------------------------------------------------------------------------
// Cockpit mechanics
// ---------------------------------------------------------------------------

function jam(sr: number, r: Rng): Float32Array {
  const o = zeros(0.4, sr);
  const n = zeros(0.4, sr);
  addNoiseBurst(n, sr, 0.001, 1, 0.015, r, 0.0008);
  mixInto(o, filtered(n, new Biquad('lowpass', sr, 650, 0.8)), 0, 1.4);
  [220, 410, 780, 1320].forEach((f, i) => addMode(o, sr, 0.001, f, 0.35 - i * 0.06, 0.07 - i * 0.012, i));
  for (let i = 0; i < 4; i++) addNoiseBurst(o, sr, range(r, 0.05, 0.12), 0.08, 0.0006, r);
  // A dry trigger click on nothing.
  addMode(o, sr, 0.19, 2600, 0.18, 0.004);
  addMode(o, sr, 0.19, 4100, 0.1, 0.003, 1);
  saturate(o, 1.3);
  fadeOut(o, Math.round(0.03 * sr));
  return normalizePeak(o, 0.9);
}

function clearGun(sr: number, r: Rng): Float32Array {
  const o = zeros(0.65, sr);
  for (let i = 0; i < 4; i++) {
    const t = 0.01 + i * 0.018 + 0.002 * gauss(r);
    addNoiseBurst(o, sr, t, 0.15, 0.0006, r);
    addMode(o, sr, t, range(r, 3000, 3600), 0.12, 0.006, r() * TAU);
  }
  const slam = (t: number, a: number): void => {
    addNWave(o, sr, t, a * 0.6, 0.0003);
    [1100, 2300, 3900, 5200].forEach((f, i) => addMode(o, sr, t, f * range(r, 0.98, 1.02), a * (0.4 - i * 0.07), 0.06 - i * 0.01, r() * TAU));
    const n = zeros(0.1, sr);
    addNoiseBurst(n, sr, 0, 1, 0.01, r, 0.0005);
    mixInto(o, filtered(n, new Biquad('lowpass', sr, 500, 0.7)), Math.round(t * sr), a * 0.8);
  };
  slam(0.24, 1);
  slam(0.33, 0.55);
  saturate(o, 1.2);
  fadeOut(o, Math.round(0.04 * sr));
  return normalizePeak(o, 0.9);
}

function bombRelease(sr: number, r: Rng): Float32Array {
  const len = 1.4;
  const o = zeros(len, sr);
  const n = zeros(len, sr);
  addNoiseBurst(n, sr, 0.002, 1, 0.018, r, 0.001);
  mixInto(o, filtered(n, new Biquad('lowpass', sr, 450, 0.8)), 0, 1.3);
  [180, 340, 610].forEach((f, i) => addMode(o, sr, 0.002, f, 0.3 - i * 0.07, 0.05, i));
  addNWave(o, sr, 0.085, 0.5, 0.0003);
  [1500, 2700, 4200].forEach((f, i) => addMode(o, sr, 0.085, f, 0.3 - i * 0.07, 0.03, i));
  const sw = sweptNoise(o.length, sr, r, 2.5,
    (t) => 300 + 1000 * Math.exp(-Math.max(0, t - 0.12) / 0.35),
    (t) => envAD(t - 0.12, 0.08, 0.3));
  mixInto(o, sw, 0, 0.9);
  saturate(o, 1.2);
  fadeOut(o, Math.round(0.1 * sr));
  return normalizePeak(o, 0.9);
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export type UiKind = 'select' | 'confirm' | 'back' | 'objective' | 'fail' | 'victory';

function woodClick(o: Float32Array, sr: number, t: number, base: number, amp: number, r: Rng): void {
  addNoiseBurst(o, sr, t, amp * 0.3, 0.0003, r);
  addMode(o, sr, t, base, amp, 0.018, 0);
  addMode(o, sr, t, base * 2.25, amp * 0.45, 0.009, 1);
  addMode(o, sr, t, base * 3.5, amp * 0.2, 0.005, 2);
  addMode(o, sr, t, base * 0.26, amp * 0.3, 0.01, 0);
}

/** Bronze bell partials (hum, prime, tierce, quint, nominal, …); lower partials ring longer. */
function bell(o: Float32Array, sr: number, t: number, f0: number, amp: number, decay: number, r: Rng): void {
  const partials: [number, number][] = [[0.5, 0.35], [1, 1], [1.19, 0.45], [1.5, 0.3], [2, 0.55], [2.51, 0.18], [2.99, 0.14], [4.07, 0.07]];
  for (const [ratio, a] of partials) {
    addMode(o, sr, t, f0 * ratio * (1 + 0.002 * gauss(r)), amp * a, decay * Math.pow(1 / ratio, 0.7), r() * TAU, 0.0015);
  }
  const n = zeros(0.05, sr);
  addNoiseBurst(n, sr, 0, amp * 0.25, 0.002, r);
  mixInto(o, filtered(n, new Biquad('lowpass', sr, 3000, 0.7)), Math.round(t * sr), 1);
}

function ui(kind: UiKind, sr: number, r: Rng): Float32Array {
  let o: Float32Array;
  switch (kind) {
    case 'select':
      o = zeros(0.08, sr);
      woodClick(o, sr, 0.001, 1180, 1, r);
      break;
    case 'confirm':
      o = zeros(0.5, sr);
      woodClick(o, sr, 0.001, 1250, 1, r);
      woodClick(o, sr, 0.055, 1580, 0.8, r);
      addMode(o, sr, 0.055, 1320, 0.12, 0.25, 0, 0.002);
      break;
    case 'back':
      o = zeros(0.12, sr);
      woodClick(o, sr, 0.001, 860, 1, r);
      woodClick(o, sr, 0.045, 700, 0.5, r);
      break;
    case 'objective':
      o = zeros(2.6, sr);
      bell(o, sr, 0.002, 784, 1, 1.6, r);
      bell(o, sr, 0.17, 1046.5, 0.7, 1.4, r);
      break;
    case 'fail':
      o = zeros(2.2, sr);
      bell(o, sr, 0.002, 330, 1, 0.9, r);
      bell(o, sr, 0.28, 247, 0.9, 1.1, r);
      o = filtered(o, new Biquad('lowpass', sr, 1600, 0.7));
      break;
    case 'victory':
      o = zeros(3.2, sr);
      bell(o, sr, 0.002, 523.25, 0.8, 1.2, r);
      bell(o, sr, 0.16, 659.25, 0.8, 1.2, r);
      bell(o, sr, 0.32, 784, 0.85, 1.3, r);
      bell(o, sr, 0.56, 1046.5, 1, 1.9, r);
      break;
  }
  fadeIn(o, 2);
  fadeOut(o, Math.round(0.02 * sr));
  return normalizePeak(o, 0.9);
}

// ---------------------------------------------------------------------------
// Beds and the room
// ---------------------------------------------------------------------------

/**
 * Outdoor impulse response: a ground bounce and a few near reflections, then
 * slapback off far treelines and a diffuse tail that darkens as it decays.
 * Stereo, with the two sides decorrelated. Scaled to unit energy per channel.
 */
function impulse(sr: number): Clip {
  const len = 2.8;
  const ch: Float32Array[] = [];
  for (let c = 0; c < 2; c++) {
    const r = makeRng(900 + c);
    const n = Math.round(len * sr);
    const o = new Float32Array(n);
    const taps: [number, number][] = [[0.009, 0.5], [0.017, 0.3], [0.031, 0.22], [0.048, 0.15]];
    for (const [t, a] of taps) addNoiseBurst(o, sr, t * range(r, 0.9, 1.1), a, 0.0015, r);
    const slaps: [number, number][] = [[0.18, 0.22], [0.31, 0.15], [0.52, 0.1], [0.83, 0.06]];
    for (const [t, a] of slaps) addNoiseBurst(o, sr, t * range(r, 0.92, 1.08), a, 0.012, r, 0.004);
    const tail = whiteNoise(n, r);
    const dec = Math.exp(-1 / (0.75 * sr));
    let e = 0.28;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const on = t < 0.02 ? 0 : Math.min(1, (t - 0.02) / 0.08);
      tail[i] *= on * e;
      e *= dec;
    }
    const dark = sweptLowpass(tail, sr, 0.6, (t) => 800 + 6500 * Math.exp(-t / 0.4));
    mixInto(o, dark, 0, 1);
    fadeOut(o, Math.round(0.3 * sr));
    let en = 0;
    for (let i = 0; i < n; i++) en += o[i] * o[i];
    scale(o, 1 / Math.sqrt(en || 1));
    ch.push(o);
  }
  return { sr, ch };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type ClipName =
  | 'eng.rotary.hi' | 'eng.rotary.lo' | 'eng.inline.hi' | 'eng.inline.lo' | 'eng.heavy.hi' | 'eng.heavy.lo'
  | 'crackle' | 'gun.vickers' | 'gun.spandau' | 'gun.lewis'
  | 'hit' | 'hit.thud' | 'hit.confirm' | 'whiz'
  | 'exp.crack' | 'exp.boom' | 'exp.tail' | 'exp.debris'
  | 'flak' | 'balloon' | 'artillery' | 'jam' | 'clear' | 'bomb'
  | 'ui.select' | 'ui.confirm' | 'ui.back' | 'ui.objective' | 'ui.fail' | 'ui.victory'
  | 'noise.white' | 'noise.pink' | 'noise.brown' | 'ir';

/**
 * One bank entry: `n` variants, each rendered on its own so the prewarm can be
 * spread over idle time a variant at a time. `low` entries render at half rate.
 */
export interface BankEntry {
  n: number;
  low?: boolean;
  make: (sr: number, i: number) => Clip;
}

const seeded = (n: number, seed: number, f: (sr: number, r: Rng, i: number) => Float32Array, low = false): BankEntry => ({
  n,
  low,
  make: (sr, i) => mono(sr, f(sr, makeRng(seed * 7919 + i * 104729), i)),
});
const loop = (spec: EngineSpec): BankEntry => ({ n: 1, make: (sr) => mono(sr, renderEngineLoop(spec, sr)) });

export const BANK: Record<ClipName, BankEntry> = {
  'eng.rotary.hi': loop(ROTARY_HI),
  'eng.rotary.lo': loop(ROTARY_LO),
  'eng.inline.hi': loop(INLINE_HI),
  'eng.inline.lo': loop(INLINE_LO),
  'eng.heavy.hi': loop(HEAVY_HI),
  'eng.heavy.lo': loop(HEAVY_LO),
  crackle: seeded(6, 11, (s, r) => crackle(s, r)),
  'gun.vickers': seeded(6, 21, (s, r) => gunShot('vickers', s, r)),
  'gun.spandau': seeded(6, 22, (s, r) => gunShot('spandau', s, r)),
  'gun.lewis': seeded(6, 23, (s, r) => gunShot('lewis', s, r)),
  hit: seeded(8, 31, (s, r, i) => hitVariant(i, s, r)),
  'hit.thud': seeded(2, 32, (s, r) => hitThud(s, r)),
  'hit.confirm': seeded(1, 33, (s, r) => hitConfirm(s, r)),
  whiz: seeded(4, 34, (s, r) => whiz(s, r)),
  'exp.crack': seeded(2, 41, (s, r) => expCrack(s, r)),
  'exp.boom': seeded(2, 42, (s, r) => expBoom(s, r), true),
  'exp.tail': seeded(2, 43, (s, r) => expTail(s, r), true),
  'exp.debris': seeded(2, 44, (s, r) => expDebris(s, r)),
  flak: seeded(3, 51, (s, r) => flak(s, r)),
  balloon: seeded(1, 52, (s, r) => balloonBurn(s, r)),
  artillery: seeded(4, 53, (s, r) => artillery(s, r), true),
  jam: seeded(1, 61, (s, r) => jam(s, r)),
  clear: seeded(1, 62, (s, r) => clearGun(s, r)),
  bomb: seeded(1, 63, (s, r) => bombRelease(s, r)),
  'ui.select': seeded(1, 71, (s, r) => ui('select', s, r)),
  'ui.confirm': seeded(1, 72, (s, r) => ui('confirm', s, r)),
  'ui.back': seeded(1, 73, (s, r) => ui('back', s, r)),
  'ui.objective': seeded(1, 74, (s, r) => ui('objective', s, r)),
  'ui.fail': seeded(1, 75, (s, r) => ui('fail', s, r)),
  'ui.victory': seeded(1, 76, (s, r) => ui('victory', s, r)),
  'noise.white': { n: 1, make: (sr) => mono(sr, whiteNoise(Math.round(2 * sr), makeRng(81))) },
  'noise.pink': { n: 1, make: (sr) => mono(sr, normalizePeak(pinkNoise(Math.round(3 * sr), makeRng(82)), 0.9)) },
  'noise.brown': { n: 1, low: true, make: (sr) => mono(sr, normalizePeak(brownNoise(Math.round(3 * sr), makeRng(83), 0.995), 0.9)) },
  ir: { n: 1, make: (sr) => impulse(sr) },
};

/** The sample rate an entry renders at, for a context running at `sr`. */
export const entryRate = (e: BankEntry, sr: number): number => (e.low ? lowRate(sr) : sr);

/** Rough render cost order: what the game needs first goes first. */
export const PREWARM_ORDER: ClipName[] = [
  'ui.select', 'ui.confirm', 'ui.back', 'noise.white', 'noise.pink', 'noise.brown', 'ir',
  'eng.rotary.hi', 'eng.rotary.lo', 'eng.inline.hi', 'eng.inline.lo', 'crackle',
  'gun.vickers', 'gun.spandau', 'gun.lewis', 'hit', 'hit.thud', 'hit.confirm', 'whiz',
  'exp.crack', 'exp.boom', 'exp.tail', 'exp.debris', 'flak', 'artillery',
  'eng.heavy.hi', 'eng.heavy.lo', 'jam', 'clear', 'bomb', 'balloon',
  'ui.objective', 'ui.fail', 'ui.victory',
];
