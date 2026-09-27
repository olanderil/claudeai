/**
 * The hot-air balloons have been taken down: the sky over the front belongs
 * to the kite balloons, which the combat layer raises at `balloonAnchors()`
 * (see Front.ts).
 */

export interface Balloon {
  x: number;
  z: number;
  /** Height of the envelope's centre, metres. */
  y: number;
  size: number;
  /** Seconds of drift offset, so a group does not bob as one. */
  phase: number;
}

/** @deprecated kept for main.ts until the combat rewrite — always empty. */
export function balloons(): Balloon[] {
  return [];
}

/** @deprecated kept for main.ts until the combat rewrite — a clock nobody reads. */
export const balloonDrift = { value: 0 };
