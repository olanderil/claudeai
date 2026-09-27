/**
 * Which worlds have forests, and does the season change the answer?
 *
 * Woodland is decided from the colour of a world's own ground rather than from
 * a flag on fifteen presets: genuinely green country has trees, red rock and
 * sand and ice do not. That is a nice trick and it has one failure mode, which
 * this exists to catch — the seasonal tint moves the ground colour, and moves
 * it far enough to flip the answer. Read live, an autumn Isles comes out at a
 * green margin of 0.017 and loses every tree it has.
 *
 * So the rule is: decide from the *base* palette, and prove here that the
 * seasons cannot get a vote.
 */
if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { WORLD_PRESETS } = await import('../src/world/Worlds');
const { SEASON_PRESETS } = await import('../src/world/World');

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};

/** The same rule the world uses. Kept in step by the assertion at the end. */
function woodedness(grass: readonly [number, number, number]): number {
  const green = grass[1] - Math.max(grass[0], grass[2]);
  const t = Math.max(0, Math.min(1, (green - 0.02) / 0.08));
  return t * t * (3 - 2 * t);
}

/** Worlds that should be wooded, and worlds that plainly should not. */
const EXPECT_TREES = ['ISLES', 'FJORDS', 'ICELAND', 'KARST', 'ALPINE', 'LAGOON',
  'PACIFIC', 'ISLAND CITY', 'HARBOUR', 'DOMES'];
const EXPECT_BARE = ['CANYON', 'HIMALAYA', 'DUNES', 'ANTARCTIC', 'GULF'];

console.log('WOODLAND, by world');
for (const p of WORLD_PRESETS) {
  const w = woodedness(p.style.grass);
  const wants = EXPECT_TREES.includes(p.name);
  const bare = EXPECT_BARE.includes(p.name);
  console.log(`  ${p.name.padEnd(13)} ${w.toFixed(2)}  ${w > 0.5 ? 'forest' : '—'}`);
  if (wants && w < 0.5) fail(`${p.name} should be wooded and reads ${w.toFixed(2)}`);
  if (bare && w > 0.05) fail(`${p.name} should be bare and reads ${w.toFixed(2)}`);
  if (!wants && !bare) fail(`${p.name} is in neither list — decide what it is`);
}

// --------------------------------------------------------------- the seasons
//
// The whole reason this file exists. If the answer were taken from the tinted
// palette, autumn would clear-fell ten worlds and winter would replant them.
console.log('\nTHE SEASONS MUST NOT GET A VOTE');
{
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  let worst = '';
  let flips = 0;
  for (const p of WORLD_PRESETS) {
    const base = woodedness(p.style.grass);
    for (const s of SEASON_PRESETS) {
      const tinted: [number, number, number] = [
        lerp(p.style.grass[0], s.tint[0], s.tintAmount),
        lerp(p.style.grass[1], s.tint[1], s.tintAmount),
        lerp(p.style.grass[2], s.tint[2], s.tintAmount),
      ];
      const live = woodedness(tinted);
      if ((base > 0.5) !== (live > 0.5)) {
        flips++;
        worst = `${p.name} in ${s.name}: ${base.toFixed(2)} -> ${live.toFixed(2)}`;
      }
    }
  }
  console.log(`  ${flips} world-seasons would change their mind if this were read live`);
  if (flips > 0) console.log(`  e.g. ${worst}`);
  // Not a failure — it is the *reason*. What would be a failure is the world
  // reading the tinted palette, and that is asserted below.
  // These checks are built without Node's type definitions — nothing else here
  // has needed them — and pulling them in for a single file read is a worse
  // trade than saying so on one line.
  // @ts-expect-error - no @types/node in this project
  const fs = await import('node:fs');
  const source = fs.readFileSync('src/world/World.ts', 'utf8') as string;
  if (!/woodedness\(world\.style\.grass\)/.test(source)) {
    fail('the world no longer decides woodland from the untinted palette');
  }
  if (/woodedness\(shift\(/.test(source)) {
    fail('woodland is being decided from the seasonal palette');
  }
}

console.log(`\n${failures === 0 ? 'THE FORESTS ARE WHERE THEY BELONG' : `${failures} PROBLEM(S)`}`);

export {};
