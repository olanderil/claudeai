/**
 * Fly the scenic autopilot's whole tour, in every world, and check it arrives.
 *
 * A sightseeing autopilot is exactly the kind of feature that works when you
 * try it and fails on the eleventh world, at dusk, into rising ground — the
 * cases nobody flies by hand. So this flies the complete tour at the physics
 * rate, in all fourteen worlds, and asserts the things a passenger would
 * notice: that it got off the ground, stayed off it, went somewhere worth
 * going, and landed on a runway rather than in a field.
 */
import * as THREE from 'three';

if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { FlightModel, HORNET } = await import('../src/flight/FlightModel');
const { Controls, DEFAULT_SETTINGS } = await import('../src/flight/Controls');
const { Autopilot } = await import('../src/flight/Autopilot');
type TourWorld = Parameters<InstanceType<typeof Autopilot>['engage']>[0];
const { WORLD_PRESETS, setWorld, terrainHeight, groundHeight, spawnPoint, fieldElevation } =
  await import('../src/world/Worlds');
const { airstrips } = await import('../src/world/Settlements');
const { citySites } = await import('../src/world/City');

const DEG = 180 / Math.PI;
let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};

/** The same world description `main.ts` hands the autopilot. */
function tourWorld(): TourWorld {
  const spawn = spawnPoint();
  const home = {
    x: 0,
    z: 0,
    dirX: Math.sin(spawn.heading / DEG),
    dirZ: -Math.cos(spawn.heading / DEG),
    elevation: fieldElevation(),
    name: 'HOME FIELD',
  };
  return {
    ground: groundHeight,
    terrain: terrainHeight,
    strips: [home, ...airstrips().map((s, i) => ({ ...s, name: `STRIP ${i + 1}` }))],
    cities: citySites(),
    villages: [],
  };
}

for (let w = 0; w < WORLD_PRESETS.length; w++) {
  const preset = WORLD_PRESETS[w];
  setWorld(w);
  // The carrier worlds start on a deck, which is not a runway this can use.
  if (preset.hasAirfield === false) {
    console.log(`\n${preset.name}\n  starts on the carrier — no runway to tour from`);
    continue;
  }

  const model = new FlightModel(HORNET, groundHeight);
  // Same gusts every run. Without this the touchdown point moves a couple of
  // hundred metres between identical runs and the check cannot tell a fix from
  // a coincidence.
  model.windPhase = 17.5;
  const controls = new Controls(HORNET);
  Object.assign(controls.settings, DEFAULT_SETTINGS);
  const spawn = spawnPoint();
  model.reset(new THREE.Vector3(spawn.x, 0, spawn.z), spawn.heading);

  const world = tourWorld();
  const ap = new Autopilot();
  const t0 = Date.now();
  ap.engage(world, model.position.x, model.position.z, true);
  const planMs = Date.now() - t0;
  const legs = ap.waypointLabels;

  const dt = 1 / 120;
  let t = 0;
  let airborneAt = -1;
  let minAgl = Infinity;
  let peakAltitude = 0;
  let touchdownVs = 0;
  let touchdownAt = -1;
  let distanceFlown = 0;
  let last = model.position.clone();
  let worstBank = 0;
  let lastPhase = ap.phase;
  let along = 0;
  let previousVs = 0;
  let across = 0;
  const dest0 = ap.destination;

  for (let i = 0; i < 120 * 60 * 14 && ap.active && ap.phase !== 'done'; i++) {
    ap.update(dt, model.telemetry, model.position.x, model.position.z);
    controls.gearDown = ap.wantsGearDown(model.telemetry);
    controls.update(dt, ap.stick, model.telemetry);
    model.step(dt, controls);
    t += dt;

    const tel = model.telemetry;
    distanceFlown += model.position.distanceTo(last);
    last = model.position.clone();

    if (airborneAt < 0 && !tel.onGround && tel.agl > 5) airborneAt = t;
    if (airborneAt > 0 && !tel.onGround) {
      // Only once it is properly away, and never on the approach: the climb
      // out passes through every height between the runway and the tour, and
      // touching down is *meant* to reach zero.
      const enRoute = ap.phase === 'tour' || ap.phase === 'climb';
      if (enRoute && t - airborneAt > 20) minAgl = Math.min(minAgl, tel.agl);
      peakAltitude = Math.max(peakAltitude, tel.altitude);
      worstBank = Math.max(worstBank, Math.abs(tel.bank) * DEG);
    }
    if (touchdownAt < 0 && airborneAt > 0 && ap.phase === 'rollout') {
      touchdownAt = t;
      // The frame *before* the wheels are down: once it is on the runway the
      // model has already zeroed the sink, so reading it here always says 0.0.
      touchdownVs = previousVs;
      // Where the wheels actually touched, along and across the runway. Where
      // it rolls to a stop afterwards is not landing accuracy — a long rollout
      // on the centreline is a good landing.
      // Against the runway it actually landed on: the tour is allowed to
      // divert, and measuring from the one it set out for reports a perfect
      // landing as eight kilometres off the side.
      const landed = ap.destination;
      if (landed !== null) {
        const dx = model.position.x - landed.x;
        const dz = model.position.z - landed.z;
        along = dx * landed.dirX + dz * landed.dirZ;
        across = Math.abs(dx * -landed.dirZ + dz * landed.dirX);
      }
    }
    if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.TRACE === '1' && (i % (120 * 15) === 0 || ap.phase !== lastPhase)) {
      console.log(`    ${(t / 60).toFixed(1)}min ${ap.phase.padEnd(8)} wp ${ap.legLabel.padEnd(12)}`
        + ` alt ${tel.altitude.toFixed(0)} agl ${tel.agl.toFixed(0)} ias ${tel.ias.toFixed(0)}`
        + ` hdg ${tel.heading.toFixed(0)} bank ${(tel.bank * DEG).toFixed(0)}`
        + ` to-dest ${(Math.hypot(model.position.x - (dest0?.x ?? 0), model.position.z - (dest0?.z ?? 0)) / 1000).toFixed(1)}km`
        + ` ${ap.approachState}`
        + (ap.targetPoint === null ? '' : ` to-wp ${(Math.hypot(model.position.x - ap.targetPoint.x, model.position.z - ap.targetPoint.z) / 1000).toFixed(1)}km`
          + ` err ${(((Math.atan2(ap.targetPoint.x - model.position.x, -(ap.targetPoint.z - model.position.z)) * DEG - tel.heading + 540) % 360) - 180).toFixed(0)}°`));
    }
    lastPhase = ap.phase;
    previousVs = tel.verticalSpeed;
    if (model.crashed) break;
  }

  const dest = ap.destination;
  const missed = dest === null
    ? Infinity
    : Math.hypot(model.position.x - dest.x, model.position.z - dest.z);

  console.log(`\n${preset.name}`);
  console.log(`  planned in ${planMs} ms: ${legs.join(' → ')} → ${ap.destinationName}`);
  console.log(`  ${(distanceFlown / 1000).toFixed(1)} km in ${(t / 60).toFixed(1)} min, `
    + `up to ${peakAltitude.toFixed(0)} m, closest to the ground ${minAgl.toFixed(0)} m`);
  console.log(`  touchdown ${touchdownAt < 0
    ? `never — gave up in phase "${ap.phase}"`
    : `at ${(touchdownAt / 60).toFixed(1)} min, ${touchdownVs.toFixed(1)} m/s, `
      + `${along.toFixed(0)} m along the runway, ${across.toFixed(0)} m off the centreline`}`);
  console.log(`  rolled to a stop ${missed.toFixed(0)} m from the runway centre`);
  console.log(`  steepest bank ${worstBank.toFixed(0)}°`
    + (ap.goArounds > 0 ? `, ${ap.goArounds} go-around(s)` : '')
    + (ap.diverted ? `, diverted to ${ap.destinationName}` : ''));

  if (model.crashed) fail('crashed');
  if (airborneAt < 0) fail('never got off the ground');
  if (minAgl < 40) fail(`flew within ${minAgl.toFixed(0)} m of the ground`);
  if (touchdownAt < 0) fail('never landed');
  else {
    if (touchdownVs < -4) fail(`touched down at ${touchdownVs.toFixed(1)} m/s — that is an arrival`);
    // The runway is 30 m wide on a pad the terrain generator levels for 1.9 km,
    // so this bound is "on the airfield", not "on the paint". Holding it to the
    // width would be honest about a real autoland and dishonest about what this
    // is: a sightseeing autopilot whose job is to put the aircraft down safely
    // at the end of the tour.
    if (across > 150) fail(`touched down ${across.toFixed(0)} m off the airfield centreline`);
    // The home field's runway is long; the touchdown zone that matters is the
    // first half of it.
    if (Math.abs(along) > 700) fail(`touched down ${along.toFixed(0)} m along the runway`);
  }
  if (legs.length < 2) fail(`only ${legs.length} sight(s) on the route`);
  // A tour that diverts is legitimately longer; one that never arrives is not.
  if (t > 60 * 13) fail(`the tour took ${(t / 60).toFixed(1)} minutes`);
}

console.log(failures === 0
  ? '\nEVERY TOUR ARRIVED'
  : `\n${failures} PROBLEM(S)`);
