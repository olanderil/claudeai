/**
 * The pyramids are not on this front. Kept only for the export `main.ts`
 * still reads.
 */

export interface Pyramid {
  x: number;
  z: number;
  /** Ground the base stands on, metres. */
  base: number;
  half: number;
  height: number;
  angle: number;
}

/** @deprecated kept for main.ts until the combat rewrite — always empty. */
export function pyramids(): Pyramid[] {
  return [];
}
