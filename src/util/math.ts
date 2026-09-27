export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Standard gravity (m/s²). */
export const G0 = 9.80665;
/** Sea-level air density (kg/m³), ISA. */
export const RHO0 = 1.225;

/** Metres/second to knots. */
export const MS_TO_KT = 1.943844;
/** Metres to feet. */
export const M_TO_FT = 3.280839895;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite smoothstep, clamped to [0,1] outside the edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach. `lambda` is the rate constant:
 * higher converges faster. Preferred over `lerp(a, b, 0.1)` in variable-dt code.
 */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Remove a centred dead zone and rescale the remainder back to full range. */
export function deadzone(v: number, threshold = 0.12): number {
  const m = Math.abs(v);
  if (m < threshold) return 0;
  return Math.sign(v) * ((m - threshold) / (1 - threshold));
}

/** Wrap an angle in degrees into [0, 360). */
export function wrap360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Shortest signed difference between two headings in degrees, in [-180, 180]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * ISA-style density falloff. An exponential fit is accurate enough through the
 * troposphere for flight feel and avoids the piecewise ISA layers.
 */
export function airDensity(altitudeMeters: number): number {
  return RHO0 * Math.exp(-Math.max(0, altitudeMeters) / 8500);
}
