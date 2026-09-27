import * as THREE from 'three';
import { buildAirframe, type AirframeRig, type AnimState } from './Airframes';
import type { Effects } from './Effects';
import type { Plane } from './Plane';

/**
 * The drawn half of an aircraft: its model, posed from the interpolated
 * physics state each frame, with the control surfaces, propeller, guns and
 * damage following the plane's inputs — plus the smoke and fire it trails.
 *
 * Also the camera's subject: `root`, `eyePoint`, `setCockpitVisible` and
 * `cameraScale` are what the rig reads.
 */
export class PlaneVisual {
  readonly rig: AirframeRig;
  readonly root: THREE.Group;
  readonly eyePoint: THREE.Vector3;
  readonly cameraScale: number;
  readonly velocity = new THREE.Vector3();
  private readonly anim: AnimState = {
    elevator: 0, aileron: 0, rudder: 0, rpm: 0, firing: false,
    gunnerYaw: 0, gunnerPitch: 0, gunnerFiring: false,
    damage: 0, onGround: false, speed: 0, time: 0,
  };
  private smokeAcc = 0;
  private readonly _p = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Vector3();
  /** Firing, as seen by the renderer (set by the battle when a round leaves). */
  firingT = 0;
  gunnerFiringT = 0;

  constructor(readonly plane: Plane, parent: THREE.Object3D) {
    this.rig = buildAirframe(plane.type.id, plane.livery);
    this.root = this.rig.root;
    this.eyePoint = this.rig.eyePoint;
    // Camera shots are authored around a scout of about 8 m span.
    this.cameraScale = Math.max(0.8, this.rig.size.span / 8.5);
    plane.hitboxes = this.rig.hitboxes;
    let r = 0;
    for (const hb of this.rig.hitboxes) r = Math.max(r, hb.c.length() + hb.h.length());
    plane.radius = Math.max(4, r);
    parent.add(this.root);
  }

  setCockpitVisible(on: boolean): void {
    this.rig.setCockpitVisible(on);
  }

  /** Pose between the last two physics ticks and animate. */
  update(alpha: number, dt: number, time: number, fx: Effects): void {
    const p = this.plane;
    if (p.state === 'dead') {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    this._p.lerpVectors(p.prevPosition, p.position, alpha);
    this._q.slerpQuaternions(p.prevOrientation, p.orientation, alpha);
    this.root.position.copy(this._p);
    this.root.quaternion.copy(this._q);
    this.velocity.copy(p.velocity);
    const a = this.anim;
    const inp = p.input;
    const falling = p.state === 'falling';
    a.elevator = falling ? 0.3 : inp.pitch;
    a.aileron = falling ? 0 : inp.roll;
    a.rudder = falling ? 0 : inp.yaw;
    a.rpm = falling ? p.rpm * 0.5 : p.rpm;
    this.firingT = Math.max(0, this.firingT - dt);
    this.gunnerFiringT = Math.max(0, this.gunnerFiringT - dt);
    a.firing = this.firingT > 0;
    a.gunnerFiring = this.gunnerFiringT > 0;
    // Gunner aim in the body frame, as yaw from the tail and pitch up.
    const g = p.gun.gunnerAim;
    a.gunnerYaw = Math.atan2(g.x, g.z);
    a.gunnerPitch = Math.atan2(g.y, Math.hypot(g.x, g.z));
    a.damage = 1 - Math.max(0, p.hp) / p.maxHp;
    a.onGround = p.state === 'ground';
    a.speed = p.speed;
    a.time = time;
    this.rig.animate(a, dt);

    // Smoke and fire from a hurt machine.
    const hf = p.hp / p.maxHp;
    if (falling || hf < 0.55) {
      const heavy = falling || hf < 0.3;
      this.smokeAcc += dt * (falling ? 30 : hf < 0.3 ? 16 : 7);
      const src = this.rig.engines[0] ?? this.rig.exhausts[0];
      while (this.smokeAcc >= 1) {
        this.smokeAcc -= 1;
        if (src) this._e.copy(src).applyQuaternion(this._q).add(this._p);
        else this._e.copy(this._p);
        fx.trail(this._e, p.velocity, heavy, p.fire > 0.3 && (falling || hf < 0.22));
      }
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.rig.dispose();
  }
}
