/**
 * The field that says where fog is lying.
 *
 * Fog has to be answered in two places at once. The shaders need it per
 * fragment, to decide how much of the ground in front of you has drowned; the
 * CPU needs it at a single point, the camera's, to decide whether *you* are
 * inside a bank and the whole frame should go white. Those are different
 * machines, and the one thing that must not differ is the answer — a camera
 * that thinks it is in fog while the ground in front of it is clear looks like
 * a bug in the display rather than like weather.
 *
 * So the function lives here once, written twice, side by side where a change
 * to one is impossible to make without seeing the other.
 *
 * It is a sum of plane waves rather than the hashed value noise used
 * everywhere else in this project, and that is the whole reason it can be
 * written twice at all. A hash ends in `fract` of a large product, so a
 * difference in the last bit of a float — which is exactly what you get
 * between the GPU's 32-bit arithmetic and JavaScript's 64-bit — occasionally
 * lands on the other side of an integer and returns a completely unrelated
 * number. Measured, two faithful transcriptions of the same hash disagreed by
 * up to 0.14. Sines of small arguments do not do that: five of them at
 * incommensurate angles and frequencies look every bit as unrepeating, and
 * the two versions agree to within a thousandth.
 */

/** Direction, frequency, phase and weight of each wave. */
const WAVES: [number, number, number, number, number][] = [
  // The first five carry the shape of the banks. The last four are the tearing
  // — small, fast, and only able to move the boundary, which is exactly where
  // a fog edge is ragged and nowhere else. Sines this fast are still small
  // arguments at these scales, so they cost nothing in agreement with the GPU.
  [0.9689, 0.2474, 1.00, 0.70, 0.42],
  [-0.3162, 0.9487, 1.73, 2.31, 0.29],
  [0.6247, -0.7809, 2.91, 4.11, 0.19],
  [-0.8944, -0.4472, 4.57, 1.24, 0.13],
  [0.1961, 0.9806, 7.13, 5.02, 0.09],
  [0.7071, 0.7071, 11.30, 2.64, 0.062],
  [-0.5547, 0.8321, 17.90, 0.31, 0.045],
  [0.8944, -0.4472, 27.70, 3.88, 0.032],
  [-0.9487, -0.3162, 41.30, 1.57, 0.023],
];

/**
 * The field itself, 0–1. The GLSL below is the same sum.
 */
export function fogFbm(x: number, y: number): number {
  let v = 0;
  for (const [dx, dy, freq, phase, weight] of WAVES) {
    v += weight * Math.sin((x * dx + y * dy) * freq + phase);
  }
  return 0.5 + 0.5 * v;
}

/**
 * How thickly fog lies at a point, 0–1.
 *
 * `scale` is the size of the banks — a small number makes them tens of
 * kilometres across, which is a layer filling a whole country, and a larger
 * one makes them a few kilometres, which is banks you fly in and out of.
 * `bias` slides the threshold: at 0 the fog is everywhere it can be, at 1 it
 * is nowhere. Named `bias` rather than `patch` because the latter is reserved
 * in GLSL and the two transcriptions keep the same signature.
 *
 * `soft` is the width of the band the edge is drawn over. Narrow and the
 * tearing waves cut a shredded boundary; wide and they only ripple a gradient.
 * Fog banks want the first and a layer lying in the valleys wants the second,
 * which is the whole difference between the two weathers built on this.
 */
export function fogCover(
  x: number, z: number, scale: number, bias: number, soft: number,
): number {
  const lo = 0.30 + bias * 0.38;
  return smoothstep(lo, lo + soft, fogFbm(x * scale, z * scale));
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * The same sum, and the same coverage rule, in GLSL.
 *
 * Injected into whichever material asks for haze — the terrain has noise
 * helpers of its own and the ocean has none, so these carry their own names
 * and assume nothing.
 */
export const FOG_GLSL = /* glsl */ `
  float fogFbm(vec2 p) {
    float v = 0.0;
    v += 0.42 * sin(dot(p, vec2(0.9689, 0.2474)) * 1.00 + 0.70);\n    v += 0.29 * sin(dot(p, vec2(-0.3162, 0.9487)) * 1.73 + 2.31);\n    v += 0.19 * sin(dot(p, vec2(0.6247, -0.7809)) * 2.91 + 4.11);\n    v += 0.13 * sin(dot(p, vec2(-0.8944, -0.4472)) * 4.57 + 1.24);\n    v += 0.09 * sin(dot(p, vec2(0.1961, 0.9806)) * 7.13 + 5.02);\n    v += 0.062 * sin(dot(p, vec2(0.7071, 0.7071)) * 11.30 + 2.64);\n    v += 0.045 * sin(dot(p, vec2(-0.5547, 0.8321)) * 17.90 + 0.31);\n    v += 0.032 * sin(dot(p, vec2(0.8944, -0.4472)) * 27.70 + 3.88);\n    v += 0.023 * sin(dot(p, vec2(-0.9487, -0.3162)) * 41.30 + 1.57);\n    return 0.5 + 0.5 * v;
  }
  // The parameter is 'bias', not 'patch'.
  //
  // 'patch' is a reserved word in GLSL — tessellation shaders use it — and a
  // reserved word in a signature does not produce a warning, it fails the
  // link, which surfaces as every material carrying this chunk rendering
  // untextured. That is the terrain, the ocean, and the whole landscape.
  float fogCover(vec2 at, float scale, float bias, float soft) {
    float lo = 0.30 + bias * 0.38;
    return smoothstep(lo, lo + soft, fogFbm(at * scale));
  }
`;
