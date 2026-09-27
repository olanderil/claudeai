import * as THREE from 'three';
import { Geo, rgb, v3, type V3, type UVRect } from './geo';

const WOOD = rgb('#7a4d2e');
import type { SkinAtlas } from './atlas';
import { PR, type PropRegion } from './props';

/**
 * Collects an aircraft's geometry by node (anything that moves separately) and
 * material slot, then turns it into meshes: one per (node, slot).
 *
 * Type builders run three times, once per level of detail. At detail 0 the
 * kit keeps everything apart as asked. At detail 1 and 2 every node collapses
 * into 'static' and hardware is folded into the skin slot, pinned to a white
 * swatch of the livery atlas and coloured by its vertex colours — so a far
 * aircraft is exactly one draw call with the same paint as the near one.
 */

export type Slot = 'skin' | 'props' | 'glass' | 'disc' | 'flash';

export interface NodeFlags {
  /** Only drawn in the cockpit view. */
  cockpit?: boolean;
  /** Hidden in the cockpit view (the pilot's own head and body). */
  pilot?: boolean;
  /** Lives outside the LOD so it shows at any distance (muzzle flashes). */
  always?: boolean;
  noShadow?: boolean;
  /** Swing (rad, about the node axis) that stows a part in flight — the tail skid. */
  stow?: number;
}

export interface NodeDef {
  name: string;
  parent: string | null;
  /** Absolute body-space pivot. */
  pivot: V3;
  /** Hinge / spin axis, body space, unit. */
  axis: V3;
  flags: NodeFlags;
  geos: Map<Slot, Geo>;
}

export type Detail = 0 | 1 | 2;

export class Kit {
  readonly nodes = new Map<string, NodeDef>();
  /** Body-space AABBs per hit group, detail 0 only. */
  readonly hit = new Map<string, THREE.Box3>();

  constructor(readonly atlas: SkinAtlas, readonly detail: Detail) {
    this.nodes.set('static', { name: 'static', parent: null, pivot: v3(), axis: v3(1, 0, 0), flags: {}, geos: new Map() });
  }

  /** Pick a count by detail level. */
  n(d0: number, d1: number, d2 = Math.max(3, Math.round(d1 / 2))): number {
    return this.detail === 0 ? d0 : this.detail === 1 ? d1 : d2;
  }

  node(name: string, pivot: V3, o: { parent?: string; axis?: V3; flags?: NodeFlags } = {}): string {
    if (this.detail > 0) return 'static';
    if (!this.nodes.has(name)) {
      this.nodes.set(name, {
        name, parent: o.parent ?? null, pivot: pivot.clone(), axis: (o.axis ?? v3(1, 0, 0)).clone().normalize(),
        flags: o.flags ?? {}, geos: new Map(),
      });
    }
    return name;
  }

  private put(node: string, slot: Slot, g: Geo, hit?: string): void {
    const nd = this.nodes.get(this.detail > 0 ? 'static' : node);
    if (!nd) throw new Error(`airframes: unknown node ${node}`);
    let acc = nd.geos.get(slot);
    if (!acc) { acc = new Geo(); nd.geos.set(slot, acc); }
    acc.append(g);
    if (hit && this.detail === 0) {
      let b = this.hit.get(hit);
      if (!b) { b = new THREE.Box3(); this.hit.set(hit, b); }
      for (let k = 0; k < g.p.length; k += 3) b.expandByPoint(v3(g.p[k], g.p[k + 1], g.p[k + 2]));
    }
  }

  /** Painted skin; the geo's uvs must already be metres in their regions. */
  skin(g: Geo, node = 'static', hit?: string): void {
    this.put(node, 'skin', g, hit);
  }

  /** Hardware from the props atlas. */
  props(g: Geo, region: PropRegion | UVRect, node = 'static', hit?: string): void {
    if (this.detail > 0) {
      // Parts that take their colour from the atlas (laminated wood) need it in the vertices instead.
      if (region === 'lam' || region === 'wood' || region === 'ply') {
        for (let q = 0; q < g.c.length; q += 3) { g.c[q] *= WOOD[0]; g.c[q + 1] *= WOOD[1]; g.c[q + 2] *= WOOD[2]; }
      }
      g.pin(this.atlas.region('swatch', 'swatch'), 0.025, 0.025);
      this.put('static', 'skin', g, hit);
      return;
    }
    g.mapRect(typeof region === 'string' ? PR[region] : region);
    this.put(node, 'props', g, hit);
  }

  glass(g: Geo, node = 'static'): void {
    if (this.detail > 0) return;
    this.put(node, 'glass', g);
  }

  special(slot: 'disc' | 'flash', g: Geo, node: string): void {
    if (this.detail > 0) return;
    this.put(node, slot, g);
  }

  /** Every accumulated skin geo, for the atlas to measure and remap. */
  skinGeos(): Geo[] {
    const out: Geo[] = [];
    for (const nd of this.nodes.values()) { const g = nd.geos.get('skin'); if (g) out.push(g); }
    return out;
  }

  triangles(filter?: (nd: NodeDef, slot: Slot) => boolean): number {
    let t = 0;
    for (const nd of this.nodes.values()) for (const [slot, g] of nd.geos) if (!filter || filter(nd, slot)) t += g.triangles;
    return t;
  }

  /**
   * Build the object tree. Each node becomes a Group at its pivot (relative to
   * its parent's pivot) holding one Mesh per slot; geometry is shifted so the
   * pivot is its origin. Meshes carry `userData.slot` so an instance can swap
   * in its own materials.
   */
  finalize(): { level: THREE.Group; always: THREE.Group; groups: Map<string, THREE.Group> } {
    const level = new THREE.Group();
    const always = new THREE.Group();
    const groups = new Map<string, THREE.Group>();
    const order = [...this.nodes.values()];
    // Parents before children.
    order.sort((a, b) => depth(this.nodes, a) - depth(this.nodes, b));
    for (const nd of order) {
      const grp = new THREE.Group();
      grp.name = nd.name;
      const parent = nd.parent ? this.nodes.get(nd.parent)! : null;
      grp.position.copy(nd.pivot).sub(parent ? parent.pivot : v3());
      grp.userData.flags = nd.flags;
      grp.userData.axis = nd.axis.clone();
      for (const [slot, g] of nd.geos) {
        if (!g.count) continue;
        const local = g.clone();
        local.transform(new THREE.Matrix4().makeTranslation(-nd.pivot.x, -nd.pivot.y, -nd.pivot.z));
        const mesh = new THREE.Mesh(local.toBufferGeometry());
        mesh.name = `${nd.name}:${slot}`;
        mesh.userData.slot = slot;
        const shadow = !nd.flags.noShadow && (slot === 'skin' || slot === 'props') && !nd.flags.cockpit;
        mesh.castShadow = shadow;
        mesh.receiveShadow = slot === 'skin' || slot === 'props';
        if (slot === 'disc' || slot === 'flash') mesh.renderOrder = 2;
        grp.add(mesh);
      }
      groups.set(nd.name, grp);
      if (parent) groups.get(parent.name)!.add(grp);
      else (nd.flags.always ? always : level).add(grp);
    }
    return { level, always, groups };
  }
}

function depth(nodes: Map<string, NodeDef>, nd: NodeDef): number {
  let d = 0;
  let p = nd.parent;
  while (p) { d++; p = nodes.get(p)?.parent ?? null; }
  return d;
}
