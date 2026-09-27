/**
 * Does the day actually run, and does it stay on the tuned hours?
 *
 * The six named times are art direction — each is a look somebody sat and
 * tuned — and the clock turns them into keyframes so the sun can be anywhere
 * between. Two things must hold: landing exactly on a named hour must give
 * back exactly that preset, and the hours in between must not wander somewhere
 * neither of their neighbours would go.
 */
if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { TIME_PRESETS, DRIFT_RATES } = await import('../src/world/World');

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};

// The same track the world uses, read out of the source so this cannot drift
// away from it silently.
// @ts-expect-error - no @types/node in this project
const fs = await import('node:fs');
const source = fs.readFileSync('src/world/World.ts', 'utf8') as string;
const keys = [...source.matchAll(
  /\{ hour: ([\d.]+), elevation: (-?[\d.]+), azimuth: (-?[\d.]+), twilight: ([\d.]+) \}/g,
)].map((m) => ({
  hour: +m[1], elevation: +m[2], azimuth: +m[3], twilight: +m[4],
}));
const presetHours = (source.match(/const PRESET_HOURS = \[([^\]]+)\]/) ?? [])[1]
  .split(',').map((n) => Number(n.trim()));

function sunAt(hour: number): { elevation: number; azimuth: number; twilight: number } {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].hour <= h) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const t = Math.max(0, Math.min(1, (h - a.hour) / Math.max(1e-6, b.hour - a.hour)));
  const e = t * t * (3 - 2 * t);
  const mix = (p: number, q: number): number => p + (q - p) * e;
  return {
    elevation: mix(a.elevation, b.elevation),
    azimuth: mix(a.azimuth, b.azimuth),
    twilight: mix(a.twilight, b.twilight),
  };
}

console.log(`TRACK  ${keys.length} keyframes over 24 h, ${presetHours.length} named hours`);
if (keys.length < 8) fail('the sun track was not found in World.ts');

// --------------------------------------------------- the named hours survive
console.log('\nTHE NAMED HOURS STILL LOOK LIKE THEMSELVES');
for (let i = 0; i < TIME_PRESETS.length; i++) {
  const want = TIME_PRESETS[i];
  const got = sunAt(presetHours[i]);
  const de = Math.abs(got.elevation - want.elevation);
  const da = Math.abs(got.azimuth - want.azimuth);
  const dt = Math.abs(got.twilight - want.twilight);
  console.log(`  ${want.name.padEnd(10)} ${presetHours[i].toFixed(1).padStart(5)} h  `
    + `elevation ${got.elevation.toFixed(1).padStart(6)} (want ${want.elevation})  `
    + `azimuth ${got.azimuth.toFixed(0).padStart(4)} (want ${want.azimuth})`);
  if (de > 0.05 || da > 0.05 || dt > 0.01) {
    fail(`${want.name} no longer lands on its own preset`);
  }
}

// ------------------------------------------------------------ a whole day
//
// Walked minute by minute: the sun must rise, set, and go properly dark, and
// must never jump — a discontinuity is a keyframe in the wrong order.
console.log('\nA WHOLE DAY, MINUTE BY MINUTE');
{
  let lowest = Infinity;
  let highest = -Infinity;
  let worstJump = 0;
  let worstAt = 0;
  let daylight = 0;
  let prev = sunAt(0);
  for (let m = 1; m <= 24 * 60; m++) {
    const h = m / 60;
    const now = sunAt(h);
    lowest = Math.min(lowest, now.elevation);
    highest = Math.max(highest, now.elevation);
    if (now.elevation > 0) daylight++;
    const jump = Math.abs(now.elevation - prev.elevation)
      + Math.abs(now.azimuth - prev.azimuth) * 0.25;
    if (jump > worstJump) { worstJump = jump; worstAt = h; }
    prev = now;
  }
  console.log(`  elevation ${lowest.toFixed(0)} to ${highest.toFixed(0)} degrees`);
  console.log(`  ${(daylight / 60).toFixed(1)} h with the sun above the horizon`);
  console.log(`  largest step between one minute and the next: ${worstJump.toFixed(3)} at ${worstAt.toFixed(1)} h`);
  if (highest < 45) fail('the sun never gets properly high');
  if (lowest > -12) fail('it never gets properly dark');
  if (daylight / 60 < 8 || daylight / 60 > 18) fail(`${(daylight / 60).toFixed(1)} h of daylight is not a day`);
  // A minute of a 24-hour day is a small move. Anything larger is a keyframe
  // out of order, which reads as the sun jumping across the sky.
  if (worstJump > 1.2) fail(`the sun jumps ${worstJump.toFixed(2)} in one minute at ${worstAt.toFixed(1)} h`);
}

// ---------------------------------------------------------------- the rates
// ------------------------------------------------------- what it calls itself
//
// The HUD and the panel both read the nearest named hour, and getting that
// backwards is silent: the light is right and the label is the opposite hour.
console.log('\nTHE CLOCK NAMES THE RIGHT HOUR');
{
  const nearest = (clock: number): number => {
    let best = 0;
    let gap = Infinity;
    for (let i = 0; i < presetHours.length; i++) {
      const d = Math.abs(((clock - presetHours[i] + 36) % 24) - 12);
      if (d < gap) { gap = d; best = i; }
    }
    return best;
  };
  for (let i = 0; i < presetHours.length; i++) {
    const got = nearest(presetHours[i]);
    if (got !== i) {
      fail(`${presetHours[i]} h calls itself ${TIME_PRESETS[got].name}, not ${TIME_PRESETS[i].name}`);
    }
  }
  for (const [clock, want] of [[12.5, 'NOON'], [5.7, 'DAWN'], [18.0, 'GOLDEN'],
    [23.0, 'BLUE HOUR'], [2.0, 'DAWN']] as [number, string][]) {
    const got = TIME_PRESETS[nearest(clock)].name;
    console.log(`  ${String(clock).padStart(5)} h -> ${got}`);
    if (got !== want) fail(`${clock} h calls itself ${got}, expected ${want}`);
  }
}

console.log('\nHOW LONG A DAY TAKES');
for (const r of DRIFT_RATES) {
  const mins = r.perSecond === 0 ? Infinity : 24 / r.perSecond / 60;
  console.log(`  ${r.name.padEnd(5)} ${r.perSecond === 0 ? 'the sun holds still' : mins.toFixed(0) + ' real minutes for a full day'}`);
}
if (DRIFT_RATES[0].perSecond !== 0) fail('the first rate is not "off"');

console.log(`\n${failures === 0 ? 'THE DAY RUNS TRUE' : `${failures} PROBLEM(S)`}`);

export {};
