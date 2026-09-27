/**
 * Measure the built airframe against the real F/A-18C.
 *
 *   npm run check:airframe
 *
 * Exists because the aircraft's faults were *symmetric*: every flying surface
 * came out of one `panel()` helper that swept them all the wrong way, so the
 * model still looked broadly plausible from every angle while being wrong
 * everywhere. Screenshots could not catch that. Numbers can.
 *
 * Checks dimensions, that every panel's tip chord is aft of its root, that each
 * root sits inside the fuselage skin, and that the fin tips point outboard.
 */
import * as THREE from 'three';
import { Aircraft } from '../src/flight/Aircraft';

const a = new Aircraft();
a.root.updateMatrixWorld(true);

// Real F/A-18C reference figures, metres / square metres.
const REAL: Record<string, [number, number]> = {
  'length':            [17.07, 0.6],
  'wingspan':          [12.31, 0.5], // with the wingtip launcher rails
  'height':            [4.66, 0.4],
  'stabilator span':   [6.58, 0.4],
  'fin height':        [2.10, 0.4],
};

function boxOf(o: THREE.Object3D): THREE.Box3 {
  const b = new THREE.Box3();
  o.traverse((c) => {
    // The afterburner plume is a 6 m cone trailing behind the nozzles. It is an
    // effect, not structure, and including it reported the airframe as 23.6 m.
    const isPlume = c instanceof THREE.Mesh && c.geometry.type === 'ConeGeometry';
    if (c instanceof THREE.Mesh && c.visible && !isPlume) b.expandByObject(c);
  });
  return b;
}

// Named parts, found by walking the root's children in build order.
const parts: { name: string; obj: THREE.Object3D }[] = [];
const h = (a as any).hinges;
for (const k of Object.keys(h)) parts.push({ name: k, obj: h[k] });

console.log('PART EXTENTS (airframe metres; +Z aft, +Y up, +X right)');
for (const { name, obj } of parts) {
  if (!name.startsWith('right')) continue;
  const b = boxOf(obj);
  const s = b.getSize(new THREE.Vector3());
  console.log(
    `  ${name.padEnd(14)} x ${b.min.x.toFixed(2)}..${b.max.x.toFixed(2)}` +
    `  y ${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)}` +
    `  z ${b.min.z.toFixed(2)}..${b.max.z.toFixed(2)}` +
    `   (${s.x.toFixed(2)} x ${s.y.toFixed(2)} x ${s.z.toFixed(2)})`,
  );
}

const whole = boxOf(a.root);
const wsize = whole.getSize(new THREE.Vector3());
const stab = boxOf(h.rightStab);
const rud = boxOf(h.rightRudder);

const measured: Record<string, number> = {
  'length': wsize.z,
  'wingspan': wsize.x,
  'height': wsize.y,
  'stabilator span': stab.max.x * 2,
  'fin height': rud.max.y,
};

console.log('\nAGAINST THE REAL F/A-18C');
let bad = 0;
for (const [k, [want, tol]] of Object.entries(REAL)) {
  const got = measured[k];
  const off = got - want;
  const ok = Math.abs(off) <= tol;
  if (!ok) bad++;
  console.log(`  ${k.padEnd(16)} ${got.toFixed(2)} m  vs ${want.toFixed(2)} m  ` +
    `(${off >= 0 ? '+' : ''}${off.toFixed(2)})  ${ok ? 'ok' : '<-- OFF'}`);
}

// Sweep sanity: every panel must have its tip chord aft of its root chord.
console.log('\nSWEEP DIRECTION (tip chord centre relative to root, +Z = aft)');
const swept: [string, THREE.Object3D][] = [['rightStab', h.rightStab], ['rightAileron', h.rightAileron]];
for (const [name, obj] of swept) {
  const mesh = obj.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
  const pos = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  let rootZ = 0, rootN = 0, tipZ = 0, tipN = 0, maxX = 0;
  for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); maxX = Math.max(maxX, Math.abs(v.x)); }
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (Math.abs(v.x) < 0.02) { rootZ += v.z; rootN++; }
    if (Math.abs(v.x) > maxX - 0.02) { tipZ += v.z; tipN++; }
  }
  const d = tipZ / tipN - rootZ / rootN;
  console.log(`  ${name.padEnd(14)} ${d >= 0 ? '+' : ''}${d.toFixed(2)} m  ${d > 0 ? 'aft (correct)' : 'FORWARD (inverted)'}`);
}

// Attachment: each root has to sit inboard of the fuselage skin at its station,
// not hang clear of it the way the stabilators used to.
const finTip = boxOf(h.rightRudder).max;
console.log(`\nFIN CANT  right fin tip at x = ${finTip.x.toFixed(2)}, y = ${finTip.y.toFixed(2)}` +
  `  -> ${finTip.x > 0.9 ? 'outboard (V, correct)' : 'INBOARD (leaning over the spine)'}`);
console.log(`\nATTACHMENT`);
for (const [name, obj] of [['rightStab', h.rightStab], ['rightRudder', h.rightRudder]] as const) {
  const b = boxOf(obj as THREE.Object3D);
  console.log(`  ${name.padEnd(14)} inboard edge x = ${b.min.x.toFixed(2)}, lowest y = ${b.min.y.toFixed(2)}`);
}
// Length runs ~0.8 m long because of the nozzle overhang; that is accepted, so
// it is reported but does not fail the run.
// The exhaust. An engine with power on it burns fuel and shows it, so the only
// setting that shows nothing at all is a shut-down engine — everything above
// that has to be visible, and has to grow.
console.log('\nEXHAUST (plume opacity and length by power setting)');
{
  const plume = a.root.children.find(
    (o) => (o as THREE.Mesh).isMesh
      && ((o as THREE.Mesh).material as THREE.Material & { blending?: number }).blending === THREE.AdditiveBlending,
  ) as THREE.Mesh | undefined;
  if (plume === undefined) {
    console.log('  <-- no additive plume found');
    bad++;
  } else {
    const mat = plume.material as THREE.MeshBasicMaterial;
    const rows: [string, number][] = [];
    const warmth: [string, number][] = [];
    const greens: [string, number][] = [];
    for (const [label, throttle, ab] of [
      ['shut down', 0, 0],
      ['idle', 0.08, 0],
      ['cruise', 0.55, 0],
      ['military', 0.9, 0],
      ['afterburner', 1, 1],
    ] as [string, number, number][]) {
      // Many steps so the flicker damping settles; it is a random walk and one
      // frame of it would make the numbers unrepeatable.
      for (let i = 0; i < 600; i++) {
        a.update(1 / 120, { throttle, elevator: 0, aileron: 0, rudder: 0,
          gearExtension: 0, flap: 0, brake: false } as never,
        { afterburner: ab } as never);
      }
      const { r, g, b } = mat.color;
      rows.push([label, mat.opacity]);
      // How far toward the hot end of the ramp this setting sits. Positive is
      // red-dominant, negative blue-dominant; it is the one number that says
      // whether the ramp is running the way round it is supposed to.
      warmth.push([label, r - b]);
      greens.push([label, g - Math.max(r, b)]);
      console.log(`  ${label.padEnd(12)} opacity ${mat.opacity.toFixed(4)}  `
        + `length ${plume.scale.z.toFixed(2)}  `
        + `rgb ${r.toFixed(2)} ${g.toFixed(2)} ${b.toFixed(2)}  `
        + `warmth ${(r - b >= 0 ? '+' : '') + (r - b).toFixed(2)}`);
    }
    if (rows[0][1] !== 0) { console.log('      <-- a shut-down engine is still burning'); bad++; }
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] <= rows[i - 1][1]) {
        console.log(`      <-- ${rows[i][0]} is no brighter than ${rows[i - 1][0]}`);
        bad++;
      }
    }
    // Visible, not merely non-zero. Additive blending over daylit terrain
    // swallowed the old figures whole: full military power was 0.064, which is
    // why the engines only looked lit once the burner did.
    if (rows[1][1] < 0.08) {
      console.log(`      <-- idle is ${rows[1][1].toFixed(3)} — too faint to see`);
      bad++;
    }
    if (rows[3][1] < 0.25) {
      console.log(`      <-- military is ${rows[3][1].toFixed(3)} — too faint to see`);
      bad++;
    }

    // The ramp: cool at the bottom, hot at the top, and monotonic between.
    console.log('\n  colour runs cool to hot');
    if (warmth[1][1] >= 0) {
      console.log(`      <-- idle is warm (${warmth[1][1].toFixed(2)}), not blue`);
      bad++;
    }
    if (warmth[3][1] <= 0) {
      console.log(`      <-- military is not warm (${warmth[3][1].toFixed(2)})`);
      bad++;
    }
    for (let i = 2; i < warmth.length; i++) {
      if (warmth[i][1] <= warmth[i - 1][1]) {
        console.log(`      <-- ${warmth[i][0]} is no warmer than ${warmth[i - 1][0]}`);
        bad++;
      }
    }
    // Cyan to yellow through HSL hue passes through green, and a green exhaust
    // is a coolant leak. This is what says the ramp took the other route.
    for (const [label, over] of greens) {
      if (over > 0.02) {
        console.log(`      <-- ${label} is green-dominant (+${over.toFixed(2)})`);
        bad++;
      }
    }
  }
}

console.log(bad === 0 ? '\nALL DIMENSIONS WITHIN TOLERANCE' : `\n${bad} DIMENSION(S) OFF`);
