/**
 * Deterministic value noise + fBm.
 *
 * Hash-based rather than table-based so terrain is reproducible across reloads
 * without shipping a permutation table, and so the same function can later be
 * mirrored in GLSL for the Phase 2 terrain shader.
 */

/**
 * Integer scramble, returning [-1, 1).
 *
 * Uses Math.imul rather than `*`: these constants multiplied as ordinary JS
 * numbers overflow 2^53 and silently lose the low bits — which are precisely
 * the bits the result is drawn from, leaving the "noise" badly distributed.
 */
function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 2D value noise in [-1, 1]. */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const u = smootherstep(xf);
  const v = smootherstep(yf);

  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);

  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Fractal Brownian motion: layered noise, in roughly [-1, 1]. */
export function fbm(x: number, y: number, octaves = 5, lacunarity = 2.0, gain = 0.5): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;

  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * frequency, y * frequency) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged variant — sharp crests instead of rounded hills. Used for mountain
 * spines so the skyline has recognisable ridges rather than uniform lumps.
 */
export function ridged(x: number, y: number, octaves = 5): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;

  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * frequency, y * frequency));
    sum += n * n * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}
