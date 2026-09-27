import * as THREE from 'three';
import { buildKind, buildWreck, type DynSpec, type GroundKind, type KindBuild } from './ground/kinds';
import { aoBlobMaterial, scorchMaterial, uberMaterial, wreckMaterial } from './ground/atlas';
import type { HitSphere } from './ground/util';
import { buildKiteBalloonRig } from './ground/balloon';
import { buildZeppelinRig } from './ground/zeppelin';

/**
 * Non-aircraft combat models: kite balloons, the Zeppelin, and everything on
 * the ground that can be shot at.
 *
 * All geometry is procedural and every texture is painted on a canvas at
 * first use, so there is nothing to load. Ground models are built once per
 * (kind, side) into merged geometries on one shared atlas material (see
 * ground/atlas.ts) and every `buildGround` after the first only creates a few
 * Mesh objects around the cached buffers — cheap enough for eighty of them.
 *
 * Frame: +X right, +Y up, −Z forward. Ground models sit with their origin at
 * ground level in the middle of the footprint.
 */

export type { HitSphere } from './ground/util';
export type { GroundKind } from './ground/kinds';

export interface ModelRig {
  root: THREE.Group;
  hitSpheres: HitSphere[];
  height: number;
  radius: number;
  /** 0 = intact; > 0 = seconds since destruction (idempotent per value). */
  setDestroyed(t: number): void;
  /** `aim` = world-space direction a gun should point at. */
  animate(dt: number, time: number, aim?: THREE.Vector3): void;
  /** Body-space muzzle (AA guns, MG nests, artillery, searchlight lens centre); kept current by animate(). */
  muzzle?: THREE.Vector3;
  /** Body-space unit direction the muzzle points; kept current by animate(). */
  muzzleDir?: THREE.Vector3;
  /** Balloon winch: body-space point where the cable leaves the fairlead. */
  anchor?: THREE.Vector3;
  /** Searchlight: 0..1 lens glow (switch on at night; the beam itself is the caller's). */
  setLit?(k: number): void;
  dispose(): void;
}

/** Beyond this distance ground models swap to their merged far mesh. */
export const GROUND_LOD_DISTANCE = 480;

interface Template {
  near: { s: THREE.BufferGeometry; c: THREE.BufferGeometry | null; dyn: { spec: DynSpec; geo: THREE.BufferGeometry }[] };
  far: { s: THREE.BufferGeometry; c: THREE.BufferGeometry | null };
  wreck: { s: THREE.BufferGeometry; c: THREE.BufferGeometry | null; scorch: number } | null;
  info: KindBuild;
}

const cache = new Map<string, Template>();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

function localMatrix(d: DynSpec, angle: number): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeTranslation(d.pivot.x, d.pivot.y, d.pivot.z);
  if (d.axis === 'yaw') m.multiply(_m.makeRotationY(angle));
  else m.multiply(_m.makeRotationX(angle));
  return m;
}

function restMatrix(d: DynSpec, all: DynSpec[]): THREE.Matrix4 {
  const own = localMatrix(d, d.rest);
  if (!d.parent) return own;
  const p = all.find((x) => x.name === d.parent)!;
  return restMatrix(p, all).multiply(own);
}

function template(kind: GroundKind, side: 'allied' | 'central'): Template {
  const key = `${kind}:${side}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const near = buildKind(kind, side, 0);
  const far = buildKind(kind, side, 1);
  const ao = { groundAO: 1.2, aoMin: 0.55 };
  for (const d of far.dyn) far.s.addRaw(d.parts.merge(), restMatrix(d, far.dyn));
  const t: Template = {
    near: {
      s: near.s.merge(ao),
      c: near.c.count ? near.c.merge(ao) : null,
      dyn: near.dyn.map((d) => ({ spec: d, geo: d.parts.merge() })),
    },
    far: { s: far.s.merge(ao), c: far.c.count ? far.c.merge(ao) : null },
    wreck: null,
    info: near,
  };
  cache.set(key, t);
  return t;
}

function wreckOf(kind: GroundKind, side: 'allied' | 'central', t: Template): NonNullable<Template['wreck']> {
  if (!t.wreck) {
    const w = buildWreck(kind, side);
    t.wreck = { s: w.s.merge({ groundAO: 0.8, aoMin: 0.6 }), c: w.c.count ? w.c.merge() : null, scorch: w.scorch };
  }
  return t.wreck;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, shadow = true): THREE.Mesh {
  const x = new THREE.Mesh(g, m);
  x.castShadow = shadow;
  x.receiveShadow = true;
  return x;
}

let blobGeo: THREE.PlaneGeometry | null = null;

/** Build a ground target. Geometry is cached per (kind, side); this is a cheap instance. */
export function buildGround(kind: GroundKind, side: 'allied' | 'central'): ModelRig {
  const t = template(kind, side);
  const info = t.info;
  const opaque = uberMaterial('opaque');
  const cutout = uberMaterial('cutout');

  const root = new THREE.Group();
  root.name = `ground-${kind}-${side}`;
  const lod = new THREE.LOD();
  root.add(lod);

  const near = new THREE.Group();
  near.add(mesh(t.near.s, opaque));
  if (t.near.c) near.add(mesh(t.near.c, cutout, false));
  const nodes = new Map<string, THREE.Object3D>();
  for (const { spec, geo } of t.near.dyn) {
    const node = new THREE.Object3D();
    node.position.copy(spec.pivot);
    if (spec.axis === 'yaw') node.rotation.y = spec.rest; else node.rotation.x = spec.rest;
    node.add(mesh(geo, opaque));
    nodes.set(spec.name, node);
  }
  for (const { spec } of t.near.dyn) {
    const node = nodes.get(spec.name)!;
    (spec.parent ? nodes.get(spec.parent)! : near).add(node);
  }
  const farG = new THREE.Group();
  farG.add(mesh(t.far.s, opaque));
  if (t.far.c) farG.add(mesh(t.far.c, cutout, false));
  lod.addLevel(near, 0);
  lod.addLevel(farG, GROUND_LOD_DISTANCE, 0.08);

  blobGeo ??= new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const blob = new THREE.Mesh(blobGeo, aoBlobMaterial());
  blob.scale.set(info.blob[0] * 1.3, 1, info.blob[1] * 1.3);
  blob.position.y = 0.05;
  blob.renderOrder = -1;
  root.add(blob);

  // Searchlight lens: its own material so each light can be switched on.
  let lensMat: THREE.MeshStandardMaterial | null = null;
  if (info.lens) {
    lensMat = new THREE.MeshStandardMaterial({
      color: 0x8c979c, roughness: 0.12, metalness: 0.7, emissive: 0xfff0d2, emissiveIntensity: 0,
    });
    const disc = new THREE.CircleGeometry(info.lens.r, 20);
    const a = new THREE.Mesh(disc, lensMat);
    a.position.copy(info.lens.p);
    a.rotation.y = Math.PI;
    nodes.get(info.lens.part)?.add(a);
    const spec = t.near.dyn.find((d) => d.spec.name === info.lens!.part)!.spec;
    const b = new THREE.Mesh(disc, lensMat);
    b.applyMatrix4(restMatrix(spec, t.near.dyn.map((d) => d.spec)).multiply(new THREE.Matrix4().compose(info.lens.p, _q.setFromAxisAngle(_v.set(0, 1, 0), Math.PI), new THREE.Vector3(1, 1, 1))));
    farG.add(b);
  }

  // Aiming state.
  const turret = nodes.get('turret') ?? null;
  const gun = nodes.get('gun') ?? null;
  const drumNode = nodes.get('drum') ?? null;
  const aimCfg = info.aim;
  let yaw = 0;
  let pitch = gun ? gun.rotation.x : 0;
  const restPitch = pitch;
  const muzzle = info.muzzle ? info.muzzle.p.clone() : undefined;
  const muzzleDir = info.muzzle ? new THREE.Vector3(0, 0, -1) : undefined;
  const muzzleNode = info.muzzle?.part ? nodes.get(info.muzzle.part)! : null;
  const updateMuzzle = (): void => {
    if (!muzzle || !muzzleNode || !info.muzzle) return;
    // Compose pivot transforms in body space (independent of the root's world matrix).
    _m.identity();
    const chain: THREE.Object3D[] = [];
    for (let n: THREE.Object3D | null = muzzleNode; n && n !== near; n = n.parent) chain.unshift(n);
    const acc = new THREE.Matrix4();
    for (const n of chain) { n.updateMatrix(); acc.multiply(n.matrix); }
    muzzle.copy(info.muzzle.p).applyMatrix4(acc);
    muzzleDir!.set(0, 0, -1).transformDirection(acc);
  };
  updateMuzzle();

  // Wreck (built lazily the first time this kind is destroyed).
  let wreckGroup: THREE.Group | null = null;
  let wreckMat: THREE.MeshStandardMaterial | null = null;
  let scorch: THREE.Mesh | null = null;
  let destroyed = false;

  const rig: ModelRig = {
    root,
    hitSpheres: info.hit.map((h) => ({ o: h.o.clone(), r: h.r })),
    height: info.height,
    radius: info.radius,
    muzzle,
    muzzleDir,
    anchor: info.anchor?.clone(),
    setDestroyed(tt: number): void {
      if (tt <= 0) {
        if (destroyed) {
          destroyed = false;
          lod.visible = true;
          blob.visible = true;
          if (wreckGroup) wreckGroup.visible = false;
          if (scorch) scorch.visible = false;
        }
        return;
      }
      if (!wreckGroup) {
        const w = wreckOf(kind, side, t);
        wreckMat = wreckMaterial();
        wreckGroup = new THREE.Group();
        wreckGroup.add(mesh(w.s, wreckMat));
        if (w.c) wreckGroup.add(mesh(w.c, cutout, false));
        root.add(wreckGroup);
        scorch = new THREE.Mesh(blobGeo!, scorchMaterial());
        scorch.scale.set(w.scorch, 1, w.scorch);
        scorch.position.y = 0.06;
        scorch.rotation.y = Math.random() * Math.PI * 2;
        scorch.renderOrder = -1;
        root.add(scorch);
      }
      destroyed = true;
      lod.visible = false;
      blob.visible = false;
      wreckGroup.visible = true;
      scorch!.visible = true;
      wreckMat!.userData.uEmberT.value = tt;
      // Slump: the wreck settles in the first moments (under the explosion).
      const k = Math.min(1, tt / 0.45);
      wreckGroup.scale.y = 1 + 0.4 * (1 - k) * (1 - k);
      if (lensMat) lensMat.emissiveIntensity = 0;
    },
    animate(dt: number, time: number, aim?: THREE.Vector3): void {
      if (destroyed) return;
      if (drumNode) drumNode.rotation.x += dt * 0.35;
      if (!aimCfg || !turret || !gun) return;
      let ty = yaw, tp = pitch;
      if (aim && aim.lengthSq() > 1e-8) {
        root.getWorldQuaternion(_q).invert();
        _v.copy(aim).applyQuaternion(_q);
        ty = Math.atan2(-_v.x, -_v.z);
        tp = Math.atan2(_v.y, Math.hypot(_v.x, _v.z));
      } else if (kind === 'searchlight') {
        ty = Math.sin(time * 0.17) * 1.3;
        tp = 0.75 + Math.sin(time * 0.11) * 0.35;
      } else if (kind === 'mgnest') {
        ty = Math.sin(time * 0.23) * 0.35;
        tp = restPitch;
      } else {
        tp = restPitch;
      }
      if (aimCfg.yawLimit < Math.PI) ty = THREE.MathUtils.clamp(ty, -aimCfg.yawLimit, aimCfg.yawLimit);
      tp = THREE.MathUtils.clamp(tp, aimCfg.pitchMin, aimCfg.pitchMax);
      let dy = ty - yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const my = aimCfg.yawRate * dt, mp = aimCfg.pitchRate * dt;
      yaw += THREE.MathUtils.clamp(dy, -my, my);
      pitch += THREE.MathUtils.clamp(tp - pitch, -mp, mp);
      turret.rotation.y = yaw;
      gun.rotation.x = pitch;
      updateMuzzle();
    },
    dispose(): void {
      wreckMat?.dispose();
      lensMat?.dispose();
      root.removeFromParent();
    },
  };
  if (lensMat) {
    const lm = lensMat;
    rig.setLit = (k: number): void => { lm.emissiveIntensity = destroyed ? 0 : Math.max(0, k) * 7; };
  }
  return rig;
}

/** Kite balloon: Allied Caquot type M, German Parseval-Siegsfeld Drachen. Origin at the envelope centre. */
export function buildKiteBalloon(side: 'allied' | 'central'): ModelRig & { basket: THREE.Vector3; cableTop: THREE.Vector3 } {
  return buildKiteBalloonRig(side);
}

/** L 59-style R-class Zeppelin, 196 m. Origin at the hull centre, bow toward −Z. */
export function buildZeppelin(): ModelRig & { gondolas: THREE.Vector3[]; gunPositions: THREE.Vector3[]; length: number } {
  return buildZeppelinRig();
}

/** Free every cached ground geometry (call when leaving the combat mode). */
export function disposeGroundModelCache(): void {
  for (const t of cache.values()) {
    t.near.s.dispose(); t.near.c?.dispose();
    for (const d of t.near.dyn) d.geo.dispose();
    t.far.s.dispose(); t.far.c?.dispose();
    t.wreck?.s.dispose(); t.wreck?.c?.dispose();
  }
  cache.clear();
}

/** Pre-build (and cache) every ground model so the first spawn does not hitch. */
export function warmGroundModels(): void {
  const kinds: GroundKind[] = ['hangar', 'aagun', 'artillery', 'mgnest', 'lorry', 'dump', 'hq', 'hut', 'tent', 'winch', 'searchlight'];
  for (const k of kinds) for (const s of ['allied', 'central'] as const) template(k, s);
}
