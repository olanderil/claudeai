/**
 * Bound the sun so it cannot overflow the HDR buffer.
 *
 * Preetham's solar disc is `vSunE * 19000.0`, which lands around 7.6e5 — and
 * the scene is rendered into a *half-float* target, whose ceiling is 65504.
 * Above that the pixel is `Inf`, and `Inf` through the bloom's separable blur
 * becomes `NaN`, which resolves to black. The blur works in mips, so a single
 * overflowing pixel comes back as a black **rectangle**, and it flickers
 * because the disc's smoothstep is 0.00002 wide: whether a given pixel is over
 * the edge changes from frame to frame as the camera moves.
 *
 * `SUN_CEILING` is four orders of magnitude above the bloom threshold, so the
 * sun still blows out completely and still blooms hard; it simply does so with
 * a finite number. ACES maps anything past ~16 to white regardless.
 *
 * This edits three's own shader source, so it is coupled to `Sky.js`. It is a
 * function rather than two lines inside `World` so that `check:sky` can run it
 * against the shipped shader and fail loudly if a three upgrade ever rewords
 * the line it splices into — the alternative is the clamp quietly ceasing to
 * apply and the black rectangles coming back.
 */

/** Brightest value the sky may write, comfortably inside half-float range. */
export const SUN_CEILING = 1.0e4;

/** The line in three's Sky shader that the clamp wraps. */
export const SKY_OUTPUT = 'gl_FragColor = vec4( retColor, 1.0 );';

export function clampSunlight(fragmentShader: string): string {
  return fragmentShader.replace(
    SKY_OUTPUT,
    `gl_FragColor = vec4( min( retColor, vec3( ${SUN_CEILING.toExponential()} ) ), 1.0 );`,
  );
}
