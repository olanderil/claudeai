/**
 * The sun must not overflow the HDR buffer.
 *
 * The scene renders into a half-float target (ceiling 65504) and Preetham's
 * solar disc is around 1e5, so without a clamp the brightest pixel in the frame
 * is `Inf` — and `Inf` through the bloom's blur is `NaN`, which comes back as
 * black rectangles the size of a bloom mip. The clamp lives in a string
 * replacement against three's own `Sky.js`, so this checks that the replacement
 * still matches: a three upgrade that rewords that line would otherwise remove
 * the fix without a word.
 */
import { Sky } from 'three/examples/jsm/objects/Sky.js';

const HALF_FLOAT_MAX = 65504;
let failures = 0;

const stock = new Sky().material.fragmentShader;
const marker = 'gl_FragColor = vec4( retColor, 1.0 );';
console.log(`three's Sky.js still ends with the expected line: ${stock.includes(marker)}`);
if (!stock.includes(marker)) {
  failures++;
  console.log('      <-- the line the clamp is spliced into has changed');
}

// The solar disc term, as three writes it.
const disc = stock.match(/L0 \+= \( vSunE \* ([0-9.]+) \* Fex \) \* sundisk;/);
console.log(`solar disc term: vSunE * ${disc?.[1] ?? '?'}`);
if (disc === null) {
  failures++;
  console.log('      <-- could not find the solar disc term');
} else {
  // vSunE is sunIntensity(), which peaks at EE = 1000.
  const peak = 1000 * Number(disc[1]) * 0.04;
  console.log(`peak before the exposure curve: ${peak.toExponential(1)}, `
    + `half-float ceiling ${HALF_FLOAT_MAX}`);
  if (peak <= HALF_FLOAT_MAX) {
    failures++;
    console.log('      <-- it no longer overflows; the clamp may be unnecessary');
  }
}

// Read the source rather than the bundle: the point is that *this* line is
// still in the file, and esbuild would happily inline a stale copy. Typed by
// hand because the repo carries no `@types/node` — the other checks reach for
// `process` the same way.
// Run the real thing against the real shader.
const { clampSunlight, SUN_CEILING } = await import('../src/world/SkyClamp');
const patched = clampSunlight(stock);
const clamped = patched !== stock && patched.includes('min( retColor');
console.log(`the clamp applies, ceiling ${SUN_CEILING.toExponential()}: ${clamped}`);
if (!clamped) {
  failures++;
  console.log('      <-- the clamp no longer matches three\'s shader');
}
if (clamped && SUN_CEILING >= HALF_FLOAT_MAX) {
  failures++;
  console.log(`      <-- a ceiling of ${SUN_CEILING} does not fit in a half float`);
}

console.log(failures === 0 ? '\nTHE SUN CANNOT OVERFLOW' : `\n${failures} PROBLEM(S)`);
