import { noise2 } from '../util/noise';
import { smoothstep } from '../util/math';

/**
 * Where the woods are.
 *
 * This used to be decided in the terrain's fragment shader from a GPU noise,
 * which was free and right for painting — and impossible to agree with once
 * there were real trees to stand on it. Now it is one CPU function: the
 * terrain samples it per vertex into an attribute, and the tree scatter asks
 * the same question at every trunk it considers, so the dark canopy on the
 * ground and the trees above it are the same wood.
 *
 * Pure numbers, no three.js, so the planners can call it too.
 */

export interface ForestStyle {
  /** How wooded the world is, 0..1. */
  wooded: number;
  /** Altitude where woods give out, metres. */
  treeLine: number;
  /** Snow line, metres (already seasonal). */
  snowLine: number;
}

let style: ForestStyle = { wooded: 1, treeLine: 900, snowLine: 1600 };

export function setForestStyle(next: ForestStyle): void {
  style = { ...next };
}

export function forestStyle(): Readonly<ForestStyle> {
  return style;
}

/**
 * The stand pattern alone, 0..1: where woods would be if nothing were cleared.
 * Two scales — big blocks of forest and the copses between them.
 */
export function forestPattern(x: number, z: number): number {
  const big = noise2(x * 0.00052 + 19.3, z * 0.00052 - 7.1);
  const mid = noise2(x * 0.0016 - 3.7, z * 0.0016 + 11.9);
  const edge = noise2(x * 0.0061 + 5.5, z * 0.0061 - 2.3);
  return big * 0.62 + mid * 0.30 + edge * 0.08;
}

/**
 * Forest cover at a point, 0..1.
 *
 * `slope` is 1 − normal.y. `cleared` is how much the ground is spoken for by
 * something else — fields, rivers, roads, aerodromes — 0..1.
 */
export function forestCover(x: number, z: number, h: number, slope: number, cleared: number): number {
  if (style.wooded <= 0.001) return 0;
  // Threshold on the pattern: a smaller share of the map in thinly wooded worlds.
  const threshold = 0.36 - style.wooded * 0.30;
  let f = smoothstep(threshold, threshold + 0.16, forestPattern(x, z));
  if (f <= 0) return 0;
  f *= smoothstep(3, 14, h);
  f *= 1 - smoothstep(style.treeLine - 150, style.treeLine + 60, h);
  f *= 1 - smoothstep(0.30, 0.55, slope);
  f *= 1 - smoothstep(style.snowLine - 100, style.snowLine + 150, h);
  f *= 1 - Math.min(1, cleared);
  return f * Math.min(1, style.wooded * 1.4);
}

/**
 * How shattered woods are at a given distance behind the lines, 0..1.
 * Mirrored in the terrain shader (`bfShatter`).
 */
export function shatterAt(u: number): number {
  return 1 - smoothstep(280, 1050, u);
}
