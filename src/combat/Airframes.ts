import * as THREE from 'three';
import { TYPES, type AirframeId } from './Types';
import { SkinAtlas } from './airframes/atlas';
import { Kit, type Detail, type NodeFlags } from './airframes/kit';
import { Painter, reliefNormalMap } from './airframes/livery';
import {
  discMaterial, flashMaterial, glassMaterial, instanceSkin, propsMaterial, skinMaterial, type DamageUniforms,
} from './airframes/materials';
import { PR } from './airframes/props';
import type { Design, DesignMeta } from './airframes/design';
import { camel } from './airframes/designs/camel';
import { spad } from './airframes/designs/spad';
import { dr1 } from './airframes/designs/dr1';
import { albatros } from './airframes/designs/albatros';
import { dh4 } from './airframes/designs/dh4';
import { gotha } from './airframes/designs/gotha';

/**
 * Procedural aircraft models for the battle: Sopwith Camel, SPAD XIII,
 * Fokker Dr.I, Albatros D.V, Airco DH.4 and Gotha G.V.
 *
 * Nothing is loaded: geometry is lofted, lathed and extruded in code and every
 * texture is painted onto a canvas at runtime (see airframes/). A type is
 * built once — three levels of detail, its atlas layout and relief normal map
 * — and each livery once more for its paint. After that `buildAirframe` only
 * clones the object tree (sharing all geometry and textures) and makes the
 * handful of per-aircraft materials: the skin, so each machine carries its
 * own bullet damage; the propeller blades and disc, which fade independently.
 *
 * Body frame: +X right, +Y up, -Z forward, origin at the centre of gravity.
 */

export interface AnimState {
  /** -1..1, + = nose up (trailing edge up). */
  elevator: number;
  /** -1..1, + = roll right (right aileron up, left down). */
  aileron: number;
  /** -1..1, + = yaw right. */
  rudder: number;
  /** 0..1 engine speed (prop spin + blur). */
  rpm: number;
  /** Forward guns firing this frame (muzzle flash flicker). */
  firing: boolean;
  /**
   * Rear gunner, radians relative to the tail-facing rest pose.
   * gunnerYaw + swings the gun toward the aircraft's right (+X);
   * gunnerPitch + elevates it.
   */
  gunnerYaw: number;
  gunnerPitch: number;
  gunnerFiring: boolean;
  /** 0..1 accumulated damage → bullet holes, torn fabric, soot. */
  damage: number;
  onGround: boolean;
  /** Airspeed, m/s (scarf flutter, wheel spin on the ground). */
  speed: number;
  /** Seconds, monotonic. */
  time: number;
}

export interface AirframeRig {
  /** Caller sets root.position (= centre of gravity) and root.quaternion each frame. */
  root: THREE.Group;
  /** Pilot eye, body space (the cockpit camera sits exactly here). */
  eyePoint: THREE.Vector3;
  /** On = cockpit interior visible and the pilot's own head/body hidden. */
  setCockpitVisible(on: boolean): void;
  animate(s: AnimState, dt: number): void;
  /** Body-space AABBs (centre, half-extent), ~1.2× generous. */
  hitboxes: { c: THREE.Vector3; h: THREE.Vector3 }[];
  /** Body-space forward-gun muzzle tips. */
  muzzles: THREE.Vector3[];
  /** Rear gun ring pivot (DH.4 observer; Gotha rear gunner). */
  gunnerMount: THREE.Vector3 | null;
  exhausts: THREE.Vector3[];
  engines: THREE.Vector3[];
  size: { length: number; span: number; height: number };
  /** Frees per-instance resources only; shared geometry and textures stay cached. */
  dispose(): void;
}

const DESIGNS: Record<AirframeId, Design> = { camel, spad, dr1, albatros, dh4, gotha };

export const LIVERIES: Record<AirframeId, string[]> = {
  camel: camel.liveries,
  spad: spad.liveries,
  dr1: dr1.liveries,
  albatros: albatros.liveries,
  dh4: dh4.liveries,
  gotha: gotha.liveries,
};

/** LOD switch distances (m at a 75° field of view; narrower lenses scale them out). */
export const LOD_DISTANCES = [0, 350, 1500] as const;

// ---------------------------------------------------------------- templates

interface Template {
  design: Design;
  atlas: SkinAtlas;
  meta: DesignMeta;
  level0: THREE.Group;
  always: THREE.Group;
  level1: THREE.Group;
  level2: THREE.Group;
  normal: THREE.Texture;
  hitboxes: { c: THREE.Vector3; h: THREE.Vector3 }[];
  size: { length: number; span: number; height: number };
  stats: { triangles: [number, number, number]; drawCalls: number; cockpitDrawCalls: number; atlasScale: number };
  skins: Map<string, THREE.MeshPhysicalMaterial>;
}

const templates = new Map<AirframeId, Template>();

function template(id: AirframeId): Template {
  let t = templates.get(id);
  if (t) return t;
  const design = DESIGNS[id];
  const atlas = new SkinAtlas(2048);
  const kits = ([0, 1, 2] as Detail[]).map((d) => new Kit(atlas, d));
  const metas = kits.map((k) => design.build(k));
  for (const k of kits) for (const g of k.skinGeos()) atlas.track(g);
  atlas.pack();
  const l0 = kits[0].finalize();
  const l1 = kits[1].finalize();
  const l2 = kits[2].finalize();

  // Size from the exterior (no cockpit furniture, prop disc or flashes). The
  // propeller counts toward length only: parked, its blade would stand above
  // the top wing and be reported as the aircraft's height.
  const box = new THREE.Box3(), withProp = new THREE.Box3();
  l0.level.updateMatrixWorld(true);
  l0.level.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const slot = o.userData.slot as string;
    if (slot === 'disc' || slot === 'flash' || slot === 'glass') return;
    let p: THREE.Object3D | null = o, prop = false;
    while (p) {
      if ((p.userData.flags as NodeFlags | undefined)?.cockpit) return;
      if (/^prop\d/.test(p.name)) prop = true;
      p = p.parent;
    }
    const b = new THREE.Box3().setFromObject(o, true);
    withProp.union(b);
    if (!prop) box.union(b);
  });
  const sz = box.getSize(new THREE.Vector3());
  sz.z = withProp.getSize(new THREE.Vector3()).z;
  const hitboxes = [...kits[0].hit.values()].map((b) => ({
    c: b.getCenter(new THREE.Vector3()),
    h: b.getSize(new THREE.Vector3()).multiplyScalar(0.6),
  }));
  let draws = 0, cockpitDraws = 0;
  for (const nd of kits[0].nodes.values()) {
    for (const [slot, g] of nd.geos) {
      if (!g.count || slot === 'flash') continue;
      if (nd.flags.cockpit) cockpitDraws++; else draws++;
    }
  }
  t = {
    design, atlas, meta: metas[0],
    level0: l0.level, always: l0.always, level1: l1.level, level2: l2.level,
    normal: reliefNormalMap(atlas),
    hitboxes,
    size: { length: sz.z, span: sz.x, height: sz.y },
    stats: {
      triangles: [kits[0].triangles((nd) => !nd.flags.cockpit), kits[1].triangles(), kits[2].triangles()],
      drawCalls: draws, cockpitDrawCalls: cockpitDraws, atlasScale: atlas.scale,
    },
    skins: new Map(),
  };
  templates.set(id, t);
  return t;
}

function skinFor(t: Template, livery: string): THREE.MeshPhysicalMaterial {
  let m = t.skins.get(livery);
  if (m) return m;
  const seed = [...(t.design.id + livery)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const p = new Painter(t.atlas, seed % 100000);
  t.design.paint(p, livery);
  const tex = p.toTextures();
  m = skinMaterial({ map: tex.map, normal: t.normal, orm: tex.orm, metres: t.atlas.size / t.atlas.scale });
  t.skins.set(livery, m);
  return m;
}

/** Build statistics for a type (triangles per LOD, draw calls), building it if needed. */
export function airframeStats(id: AirframeId): Template['stats'] & { size: Template['size'] } {
  const t = template(id);
  return { ...t.stats, size: t.size };
}

/** Build (and cache) a type and livery ahead of time, so the first spawn doesn't hitch. */
export function preloadAirframe(id: AirframeId, livery = 'standard'): void {
  skinFor(template(id), livery);
}

// ---------------------------------------------------------------- LOD

/**
 * THREE.LOD measures plain distance, which picks the 1-draw-call model for an
 * aircraft that fills the frame through the cinematic camera's long lens.
 * Scale the distance by the lens instead, and allow pinning a level (the
 * cockpit view must never drop its own aircraft to the far model).
 */
class LensLOD extends THREE.LOD {
  pinned = -1;
  private level = 0;
  private static readonly REF = Math.tan((75 * Math.PI) / 360);

  override getCurrentLevel(): number {
    return this.level;
  }

  override update(camera: THREE.Camera): void {
    const levels = this.levels;
    if (!levels.length) return;
    let want = 0;
    if (this.pinned >= 0) {
      want = Math.min(this.pinned, levels.length - 1);
    } else {
      _a.setFromMatrixPosition(camera.matrixWorld);
      _b.setFromMatrixPosition(this.matrixWorld);
      let d = _a.distanceTo(_b);
      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const c = camera as THREE.PerspectiveCamera;
        d *= Math.tan((c.fov * Math.PI) / 360) / LensLOD.REF / (c.zoom || 1);
      }
      for (let i = 1; i < levels.length; i++) {
        let ld = levels[i].distance;
        if (levels[i].object.visible) ld -= ld * levels[i].hysteresis;
        if (d >= ld) want = i; else break;
      }
    }
    this.level = want;
    for (let i = 0; i < levels.length; i++) levels[i].object.visible = i === want;
  }
}
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// ---------------------------------------------------------------- scarf

/**
 * The loose end of the pilot's silk scarf: a ribbon rebuilt each frame on the
 * CPU (a few dozen vertices). It hangs at rest and streams aft in the
 * slipstream, with a travelling flutter whose frequency rises with airspeed.
 */
class Scarf {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private static readonly N = 16;
  private readonly phase = Math.random() * 10;

  constructor(color: readonly [number, number, number], material: THREE.Material) {
    const N = Scarf.N;
    const verts = (N + 1) * 4;
    this.pos = new Float32Array(verts * 3);
    this.nor = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const col = new Float32Array(verts * 3);
    const idx: number[] = [];
    const r = PR.silk;
    for (let i = 0; i <= N; i++) {
      for (let s = 0; s < 4; s++) {
        const v = i * 4 + s;
        uv[v * 2] = r.u0 + (s % 2) * (r.u1 - r.u0);
        uv[v * 2 + 1] = r.v0 + (i / N) * (r.v1 - r.v0);
        col[v * 3] = color[0]; col[v * 3 + 1] = color[1]; col[v * 3 + 2] = color[2];
      }
      if (i < N) {
        const a = i * 4, b = (i + 1) * 4;
        // Front face (0,1) and back face (2,3) with opposite winding.
        idx.push(a, b, b + 1, a, b + 1, a + 1);
        idx.push(a + 2, a + 3, b + 3, a + 2, b + 3, b + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.5), 1.2);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = true;
  }

  update(speed: number, time: number): void {
    const N = Scarf.N, L = 0.95;
    const wind = Math.min(1, Math.max(0, speed / 32));
    const w = 10 + Math.min(speed, 70) * 0.35;
    const amp = 0.02 + 0.13 * wind;
    const p = this.pos, n = this.nor;
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const ph = w * time - t * 9 + this.phase;
      // Direction of this segment: hanging (down, slightly aft) blended toward streaming aft.
      const dx = Math.sin(ph) * amp * (0.4 + t) * 2.2;
      const dy = -(1 - wind) * 0.95 + wind * (0.12 + Math.sin(ph * 0.7 + 1.3) * amp * 1.2);
      const dz = 0.2 + wind * 0.9;
      const dl = Math.hypot(dx, dy, dz) || 1;
      if (i > 0) { const seg = L / N; px += (dx / dl) * seg; py += (dy / dl) * seg; pz += (dz / dl) * seg; }
      // Ribbon width twists as it flutters.
      const twist = Math.sin(ph * 0.9) * 0.9 * wind;
      const half = 0.055 * (1 - t * 0.35);
      const wx = Math.cos(twist) * half, wy = Math.sin(twist) * half;
      // Normal ≈ width × direction.
      let nx = wy * (dz / dl), ny = -wx * (dz / dl), nz = wx * (dy / dl) - wy * (dx / dl);
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const v = i * 4;
      const set = (k: number, x: number, y: number, z: number, sx: number): void => {
        p[k * 3] = x; p[k * 3 + 1] = y; p[k * 3 + 2] = z;
        n[k * 3] = nx * sx; n[k * 3 + 1] = ny * sx; n[k * 3 + 2] = nz * sx;
      };
      set(v, px - wx, py - wy, pz, 1);
      set(v + 1, px + wx, py + wy, pz, 1);
      set(v + 2, px - wx, py - wy, pz, -1);
      set(v + 3, px + wx, py + wy, pz, -1);
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

// ---------------------------------------------------------------- the rig

interface Hinge {
  g: THREE.Group;
  axis: THREE.Vector3;
  kind: 'elevator' | 'rudder' | 'aileronR' | 'aileronL';
}

class Rig implements AirframeRig {
  readonly root = new THREE.Group();
  readonly eyePoint: THREE.Vector3;
  readonly hitboxes: { c: THREE.Vector3; h: THREE.Vector3 }[];
  readonly muzzles: THREE.Vector3[];
  readonly gunnerMount: THREE.Vector3 | null;
  readonly exhausts: THREE.Vector3[];
  readonly engines: THREE.Vector3[];
  readonly size: { length: number; span: number; height: number };

  private readonly lod = new LensLOD();
  private readonly skin: THREE.MeshPhysicalMaterial;
  private readonly dmg: DamageUniforms;
  private readonly bladeMat: THREE.MeshStandardMaterial;
  private readonly discMats: THREE.MeshStandardMaterial[] = [];
  private readonly hinges: Hinge[] = [];
  private readonly spinners: { g: THREE.Group; axis: THREE.Vector3; kind: 'prop' | 'rotor' | 'disc'; dir: number; blades: THREE.Mesh[] }[] = [];
  private readonly flashes: THREE.Group[] = [];
  private gunYaw: THREE.Group | null = null;
  private gunPitch: THREE.Group | null = null;
  private gunFlash: THREE.Group | null = null;
  private readonly auxFlashes: THREE.Group[] = [];
  private wheels: THREE.Group | null = null;
  private skid: { g: THREE.Group; stow: number; t: number } | null = null;
  private wheelR = 0.35;
  private wheelAngle = 0;
  private wheelRate = 0;
  // Parked props rest at an angle rather than bolt upright.
  private spin = 0.7;
  private discSpin = 0;
  private head: THREE.Group | null = null;
  private readonly cockpitNodes: THREE.Object3D[] = [];
  private readonly pilotNodes: THREE.Object3D[] = [];
  private scarf: Scarf | null = null;
  private cockpit = false;
  private readonly meta: DesignMeta;
  private readonly rpmMax: number;
  private readonly _q = new THREE.Quaternion();

  constructor(t: Template, livery: string) {
    const base = skinFor(t, livery);
    this.meta = t.meta;
    this.skin = instanceSkin(base);
    this.dmg = this.skin.userData.dmg as DamageUniforms;
    this.bladeMat = propsMaterial().clone();
    // clone() drops the shader hook; keep the program shared with the other hardware.
    this.bladeMat.onBeforeCompile = propsMaterial().onBeforeCompile;
    this.eyePoint = t.meta.eye.clone();
    this.hitboxes = t.hitboxes.map((h) => ({ c: h.c.clone(), h: h.h.clone() }));
    this.muzzles = t.meta.muzzles.map((m) => m.clone());
    this.gunnerMount = t.meta.gunnerMount?.clone() ?? null;
    this.exhausts = t.meta.exhausts.map((e) => e.clone());
    this.engines = t.meta.engines.map((e) => e.clone());
    this.size = { ...t.size };
    this.rpmMax = TYPES[t.design.id].rpmMax;

    const l0 = t.level0.clone(true);
    const always = t.always.clone(true);
    const l1 = t.level1.clone(true);
    const l2 = t.level2.clone(true);
    const groups = new Map<string, THREE.Group>();
    for (const tree of [l0, always]) {
      tree.traverse((o) => {
        if (o instanceof THREE.Group && o.name) groups.set(o.name, o);
      });
    }
    const assign = (tree: THREE.Object3D, near: boolean): void => {
      tree.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        switch (o.userData.slot as string) {
          case 'skin': o.material = near ? this.skin : base; break;
          case 'props': o.material = propsMaterial(); break;
          case 'glass': o.material = glassMaterial(); break;
          case 'flash': o.material = flashMaterial(); break;
          case 'disc': { const m = discMaterial(); m.opacity = 0; this.discMats.push(m); o.material = m; break; }
        }
      });
    };
    assign(l0, true);
    assign(always, true);
    assign(l1, false);
    assign(l2, false);
    for (const tree of [l1, l2]) tree.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });

    for (const [name, g] of groups) {
      const flags = (g.userData.flags ?? {}) as NodeFlags;
      const ax = g.userData.axis as { x: number; y: number; z: number } | undefined;
      const axis = ax ? new THREE.Vector3(ax.x, ax.y, ax.z).normalize() : new THREE.Vector3(1, 0, 0);
      if (flags.cockpit) { this.cockpitNodes.push(g); g.visible = false; }
      if (flags.pilot) this.pilotNodes.push(g);
      if (name === 'elevator') this.hinges.push({ g, axis, kind: 'elevator' });
      else if (name === 'rudder') this.hinges.push({ g, axis, kind: 'rudder' });
      else if (name.startsWith('ail')) this.hinges.push({ g, axis, kind: name.endsWith('R') ? 'aileronR' : 'aileronL' });
      else if (name === 'wheels') {
        this.wheels = g;
        const b = new THREE.Box3().setFromObject(g);
        this.wheelR = Math.max(0.2, (b.max.y - b.min.y) / 2);
      } else if (name === 'head') this.head = g;
      else if (name === 'skid' && flags.stow) this.skid = { g, stow: flags.stow, t: -1 };
    }
    for (const sp of t.meta.spinners) {
      const g = groups.get(sp.node);
      if (!g) continue;
      const ax = g.userData.axis as { x: number; y: number; z: number };
      const blades: THREE.Mesh[] = [];
      if (sp.kind === 'prop') g.traverse((o) => { if (o instanceof THREE.Mesh && o.userData.slot === 'props') { o.material = this.bladeMat; blades.push(o); } });
      this.spinners.push({ g, axis: new THREE.Vector3(ax.x, ax.y, ax.z).normalize(), kind: sp.kind, dir: sp.dir, blades });
    }
    for (const f of t.meta.flashes) { const g = groups.get(f); if (g) { g.visible = false; this.flashes.push(g); } }
    if (t.meta.gunner) {
      this.gunYaw = groups.get(t.meta.gunner.yaw) ?? null;
      this.gunPitch = groups.get(t.meta.gunner.pitch) ?? null;
      this.gunFlash = groups.get(t.meta.gunner.flash) ?? null;
      if (this.gunFlash) this.gunFlash.visible = false;
    }
    for (const f of t.meta.auxFlashes ?? []) { const g = groups.get(f); if (g) { g.visible = false; this.auxFlashes.push(g); } }
    if (t.meta.scarf) {
      const holder = groups.get(t.meta.scarf.node);
      if (holder) {
        this.scarf = new Scarf(t.meta.scarf.color, propsMaterial());
        // The holder group sits at its node pivot; the anchor is body space.
        const pivot = new THREE.Vector3();
        let o: THREE.Object3D | null = holder;
        while (o && o !== l0) { pivot.add(o.position); o = o.parent; }
        this.scarf.mesh.position.copy(t.meta.scarf.anchor).sub(pivot);
        holder.add(this.scarf.mesh);
        this.scarf.update(0, 0);
      }
    }

    this.lod.addLevel(l0, LOD_DISTANCES[0], 0);
    this.lod.addLevel(l1, LOD_DISTANCES[1], 0.08);
    this.lod.addLevel(l2, LOD_DISTANCES[2], 0.08);
    this.root.add(this.lod);
    this.root.add(always);
    this.root.name = `airframe:${t.design.id}:${livery}`;
  }

  setCockpitVisible(on: boolean): void {
    this.cockpit = on;
    for (const n of this.cockpitNodes) n.visible = on;
    for (const n of this.pilotNodes) n.visible = !on;
    this.lod.pinned = on ? 0 : -1;
  }

  animate(s: AnimState, dt: number): void {
    const d = this.meta.deflect;
    const near = this.cockpit || this.lod.getCurrentLevel() === 0;
    this.dmg.uDamage.value = Math.min(1, Math.max(0, s.damage));

    if (near) {
      for (const h of this.hinges) {
        let a = 0;
        // Hinge axes point +X (horizontal) or +Y (vertical): positive rotation drops a trailing edge / swings it right.
        if (h.kind === 'elevator') a = -s.elevator * d.elevator;
        else if (h.kind === 'rudder') a = s.rudder * d.rudder;
        else if (h.kind === 'aileronR') a = -s.aileron * d.aileron;
        else a = s.aileron * d.aileron;
        h.g.quaternion.setFromAxisAngle(h.axis, a);
      }
    }

    // Engine: real shaft speed at low rpm; above ~40 % the blades are a blur
    // and the rotating parts ease toward a readable rate instead of strobing.
    const rpm = Math.min(1, Math.max(0, s.rpm));
    const real = (rpm * this.rpmMax / 60) * Math.PI * 2;
    const blur = smoothstep(0.22, 0.5, rpm);
    const w = real * (1 - blur) + Math.PI * 2 * 2.3 * blur;
    this.spin = (this.spin + w * dt) % (Math.PI * 2000);
    this.discSpin += (4 + rpm * 9) * dt;
    const bladeAlpha = 1 - smoothstep(0.25, 0.55, rpm);
    this.bladeMat.transparent = bladeAlpha < 0.999;
    this.bladeMat.opacity = bladeAlpha;
    this.bladeMat.depthWrite = bladeAlpha > 0.5;
    for (const sp of this.spinners) {
      if (sp.kind === 'disc') {
        // Jitter the disc too so its streaks never sit still.
        sp.g.quaternion.setFromAxisAngle(sp.axis, this.discSpin * sp.dir + Math.sin(s.time * 37) * 0.3);
      } else {
        sp.g.quaternion.setFromAxisAngle(sp.axis, this.spin * sp.dir);
        if (sp.kind === 'prop') for (const b of sp.blades) b.visible = bladeAlpha > 0.02;
      }
    }
    for (const m of this.discMats) {
      // From the pilot's seat a spinning propeller is barely there.
      m.opacity = blur * (this.cockpit ? 0.4 : 1);
      m.visible = blur > 0.01;
    }

    // Wheels roll on the ground and run down in the air.
    if (this.wheels) {
      if (s.onGround) this.wheelRate = s.speed / this.wheelR;
      else this.wheelRate *= Math.exp(-dt * 0.6);
      this.wheelAngle -= this.wheelRate * dt;
      if (near) this.wheels.quaternion.setFromAxisAngle(_X, this.wheelAngle % (Math.PI * 2));
    }

    // Tail skid: down on the ground, swung up out of the way in flight.
    if (this.skid) {
      const sk = this.skid;
      const want = s.onGround ? 0 : 1;
      // Snap on the first frame so a parked aircraft never spawns with its skid up.
      sk.t = sk.t < 0 ? want : sk.t + (want - sk.t) * Math.min(1, dt * 3);
      if (near) sk.g.quaternion.setFromAxisAngle(_X, sk.stow * sk.t);
    }

    // Muzzle flashes: each gun flickers independently while firing.
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      const on = s.firing && Math.random() < 0.72;
      f.visible = on;
      if (on) {
        f.scale.setScalar(0.65 + Math.random() * 0.6);
        f.quaternion.copy(this._q.setFromAxisAngle(_Z, Math.random() * Math.PI * 2));
      }
    }

    if (this.gunYaw) this.gunYaw.quaternion.setFromAxisAngle(_Y, s.gunnerYaw);
    if (this.gunPitch) this.gunPitch.quaternion.setFromAxisAngle(_X, -s.gunnerPitch);
    for (const f of this.gunFlash ? [this.gunFlash, ...this.auxFlashes] : this.auxFlashes) {
      const on = s.gunnerFiring && Math.random() < 0.7;
      f.visible = on;
      if (on) f.scale.setScalar(0.55 + Math.random() * 0.5);
    }

    if (near && !this.cockpit) {
      if (this.scarf) this.scarf.update(s.speed, s.time);
      // Pilots never stop looking round.
      if (this.head) {
        const look = Math.sin(s.time * 0.37) * 0.6 + Math.sin(s.time * 1.13) * 0.25;
        this.head.rotation.y = look;
      }
    }
  }

  dispose(): void {
    this.skin.dispose();
    this.bladeMat.dispose();
    for (const m of this.discMats) m.dispose();
    this.scarf?.dispose();
    this.root.removeFromParent();
  }
}

const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Build an aircraft. The first call for a type builds and caches its geometry
 * (a few hundred ms); the first call for a livery paints it. Later calls are
 * a clone and a handful of materials.
 */
export function buildAirframe(id: AirframeId, livery?: string): AirframeRig {
  const t = template(id);
  const liv = livery && t.design.liveries.includes(livery) ? livery : 'standard';
  return new Rig(t, liv);
}
