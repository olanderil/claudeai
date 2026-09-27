/**
 * Check that the carrier deck is a single surface.
 *
 * Runs as `npm run check:deck`. The deck is seen almost edge-on from the chase
 * camera before takeoff — 6 m up, looking down 330 m of it — and at that angle
 * two plates a few millimetres apart fight for the depth buffer along the whole
 * length. It used to be six stacked plates with 5 mm between two of them.
 *
 * The markings are painted into the deck's texture now, so the invariant is
 * stronger and simpler than a minimum gap: *no two horizontal plates may
 * overlap at all*. One surface cannot fight itself, and no future edit can
 * reintroduce the defect by shaving a separation.
 */
import * as THREE from 'three';

/**
 * Node has no DOM, and the deck paints its markings into a canvas. What is on
 * that canvas is irrelevant here — this check is about geometry — so a stub is
 * enough, and it has to be installed before the module that calls it loads.
 */
if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { buildCarrier, DECK_HEIGHT } = await import('../src/world/Carrier');

/** Least gap between two overlapping upward faces that survives a grazing view. */
const MIN_SEPARATION = 0.08;

/** A deck plate's real footprint: a rectangle that may be turned about Y. */
interface Plate {
  name: string;
  top: number;
  bottom: number;
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  yaw: number;
}

/**
 * Do two turned rectangles overlap?
 *
 * Axis-aligned bounds are not good enough here: the angled landing area is
 * canted 9°, which inflates its bounding box from 26 m wide to 59 m and
 * reports the axial centreline dashes as sitting on it when they do not.
 * Separating-axis over the four edge normals gives the real answer.
 */
function overlaps(a: Plate, b: Plate): boolean {
  // A Y-rotation of ψ sends the local +X axis to (cos ψ, −sin ψ) in the (x, z)
  // plane and +Z to (sin ψ, cos ψ). Getting that sign wrong silently reports
  // rectangles as overlapping when they do not, which is exactly the sort of
  // false alarm this tool exists to avoid.
  const dirs = (p: Plate): [number, number][] => [
    [Math.cos(p.yaw), -Math.sin(p.yaw)],
    [Math.sin(p.yaw), Math.cos(p.yaw)],
  ];
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  for (const [ax, az] of [...dirs(a), ...dirs(b)]) {
    const reach = (p: Plate): number => {
      const [ux, uz] = dirs(p)[0];
      const [vx, vz] = dirs(p)[1];
      return p.hx * Math.abs(ax * ux + az * uz) + p.hz * Math.abs(ax * vx + az * vz);
    };
    if (Math.abs(dx * ax + dz * az) > reach(a) + reach(b)) return false;
  }
  return true;
}

const group = buildCarrier();
group.updateMatrixWorld(true);

const plates: Plate[] = [];
const seen = new Map<string, number>();
group.traverse((o) => {
  if (!(o instanceof THREE.Mesh)) return;
  const p = (o.geometry as THREE.BoxGeometry).parameters;
  if (!p || o.geometry.type !== 'BoxGeometry') return;
  // Anything presenting an upward face at deck level, however thick. Filtering
  // on thickness — the obvious-looking test — skipped the deck slab and the
  // hull, which are the two biggest surfaces up there, and let the check pass
  // while saying nothing.
  const box = new THREE.Box3().setFromObject(o);
  if (Math.abs(box.max.y - DECK_HEIGHT) > 1.5) return;
  if (p.width < 5 || p.depth < 5) {
    // Narrow paint, kept: it is exactly what used to be stacked here.
    if (p.width > 1.5 && p.depth > 1.5) return;
  }
  const kind = `${p.width.toFixed(1)}x${p.depth.toFixed(0)}`;
  const n = (seen.get(kind) ?? 0) + 1;
  seen.set(kind, n);
  plates.push({
    name: `${kind} #${n}`,
    top: box.max.y,
    bottom: box.min.y,
    cx: o.position.x,
    cz: o.position.z,
    hx: p.width / 2,
    hz: p.depth / 2,
    yaw: o.rotation.y,
  });
});

plates.sort((a, b) => a.top - b.top);
console.log('DECK PLATES (metres above the waterline)');
for (const p of plates) {
  console.log(`  ${p.name.padEnd(14)} ${p.bottom.toFixed(3)} .. ${p.top.toFixed(3)}`);
}

console.log('\nOVERLAPPING PAIRS');
let bad = 0;
let pairs = 0;
for (let i = 0; i < plates.length; i++) {
  for (let j = i + 1; j < plates.length; j++) {
    const a = plates[i];
    const b = plates[j];
    if (!overlaps(a, b)) continue;
    pairs++;
    const gap = Math.abs(a.top - b.top);
    const ok = gap >= MIN_SEPARATION;
    if (!ok) bad++;
    console.log(`  ${a.name.padEnd(14)} vs ${b.name.padEnd(14)} top faces `
      + `${(gap * 1000).toFixed(0)} mm apart  ${ok ? 'ok' : '<-- COPLANAR, WILL FIGHT'}`);
  }
}
console.log(`\n  ${plates.length} horizontal plate(s), ${pairs} overlapping pair(s)`);
console.log(bad === 0
  ? 'NO TWO DECK SURFACES FIGHT'
  : `${bad} PAIR(S) TOO CLOSE — separate them or merge them into one surface`);
