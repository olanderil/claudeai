import * as THREE from 'three';
import { clamp } from '../util/math';
import type { ControlInputs, Telemetry } from './FlightModel';

/**
 * The cockpit interior, seen from the pilot's eye point.
 *
 * Built as its own group parented to the airframe, and shown only in the cockpit
 * view. The fuselage cannot supply any of this: it is a closed surface with
 * front faces outward, so from the inside every one of its polygons is culled
 * and you see straight through it — including straight down through the belly.
 * Whatever the pilot sees has to be modelled facing inward.
 *
 * Deliberately minimal. What makes a cockpit read as a cockpit is the *framing*
 * — a canopy bow cutting the sky, rails down each side, a coaming across the
 * bottom of the view and the nose sloping away beyond it. Instrument panels,
 * bezels and switch rows add clutter to a view whose whole job is to look out
 * of, and every readout they could carry is already on the HUD.
 *
 * Everything here is a swept curve. Flat slabs and rectangular frames are what
 * made the first version look like scaffolding rather than an aircraft.
 */

/** Canopy sill height relative to the pilot's eye, metres. */
const SILL = -0.42;

export class Cockpit {
  readonly root = new THREE.Group();
  private readonly stick: THREE.Group;

  constructor(eye: THREE.Vector3) {
    // Laid out relative to the eye, so moving the eye point moves the whole
    // cockpit with it rather than silently misaligning the two.
    this.root.position.copy(eye);

    const frame = new THREE.MeshStandardMaterial({
      color: 0x202327, roughness: 0.58, metalness: 0.4,
    });
    const shell = new THREE.MeshStandardMaterial({
      color: 0x101215, roughness: 0.9, metalness: 0.05, side: THREE.BackSide,
    });
    const hood = new THREE.MeshStandardMaterial({
      color: 0x14171a, roughness: 0.92, metalness: 0.06,
    });

    this.buildCanopyFrame(frame);
    this.buildCoaming(hood);
    this.buildTub(shell);
    this.stick = this.buildStick(frame);

    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = false;
        o.receiveShadow = true;
      }
    });
  }

  /**
   * Canopy bow, rails and rear arch — the aperture.
   *
   * Tied to the canopy's own ellipsoid: the sill sits 0.42 m below the eye and
   * the glass narrows toward the nose, so a frame drawn at a constant radius
   * stands proud of it.
   */
  private buildCanopyFrame(mat: THREE.MeshStandardMaterial): void {
    // The bow is glass, not structure.
    //
    // As a dark frame it read as a black rainbow through the middle of the view
    // — the single heaviest thing on screen in a view whose job is to look out
    // of. A tinted, rounded rail catches a highlight and marks where the
    // windscreen ends without blocking anything, and a shallower arc keeps its
    // apex clear of the sightline.
    const glass = new THREE.MeshStandardMaterial({
      color: 0x8fb6cc,
      transparent: true,
      opacity: 0.17,
      roughness: 0.06,
      metalness: 0.15,
      envMapIntensity: 1.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.03, 12, 40, Math.PI), glass);
    bow.position.set(0, SILL, -1.05);
    bow.scale.y = 1.0;
    this.root.add(bow);

    const arch = new THREE.Mesh(new THREE.TorusGeometry(0.507, 0.026, 8, 26, Math.PI), mat);
    arch.position.set(0, SILL, 1.0);
    arch.scale.y = 1.2;
    this.root.add(arch);

    for (const side of [1, -1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.05, 2.1), mat);
      rail.position.set(side * 0.53, SILL + 0.015, -0.02);
      this.root.add(rail);
    }
  }

  /**
   * The coaming: one swept roll from rail to rail.
   *
   * A torus laid flat, so it curves round the front of the cockpit the way a
   * real glareshield does. Its top edge is set low enough that the nose of the
   * aircraft shows above it — with the coaming any higher the forward view is a
   * horizon and nothing else, and the pilot could be sitting anywhere.
   */
  private buildCoaming(mat: THREE.MeshStandardMaterial): void {
    const geo = new THREE.TorusGeometry(0.47, 0.105, 12, 32, Math.PI);
    // Upper half-ring in XY becomes a flat arc sweeping forward.
    geo.rotateX(-Math.PI / 2);
    const coaming = new THREE.Mesh(geo, mat);
    // Its top edge is set to the *near* end of the nose's own silhouette, about
    // 24° below the sightline. Higher and it covers the nose; much lower and the
    // eye starts to see under the nose, where the fuselage's own faces are
    // culled and the terrain shows straight through the aircraft.
    coaming.position.set(0, -0.515, -0.42);
    this.root.add(coaming);
  }

  /**
   * The tub the pilot sits in.
   *
   * Purely to close the view downward. Without it the eye looks straight through
   * the culled belly of the fuselage and out at the terrain below, which is the
   * one thing that would give the whole illusion away.
   */
  private buildTub(mat: THREE.MeshStandardMaterial): void {
    const geo = new THREE.CylinderGeometry(0.58, 0.42, 1.2, 26, 1, true);
    geo.scale(1, 1, 1.5); // longer fore-and-aft than across
    const tub = new THREE.Mesh(geo, mat);
    // Rim just under the coaming, so the two close against each other.
    tub.position.set(0, -1.00, -0.12);
    this.root.add(tub);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(0.44, 20), mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -1.59, -0.12);
    this.root.add(floor);
  }

  /** A slim centre stick, which moves with the control inputs. */
  private buildStick(mat: THREE.MeshStandardMaterial): THREE.Group {
    const pivot = new THREE.Group();
    pivot.position.set(0, -0.92, -0.26);

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.018, 0.24, 10), mat);
    shaft.position.y = 0.12;
    pivot.add(shaft);

    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.026, 0.085, 4, 10), mat);
    grip.position.y = 0.27;
    pivot.add(grip);

    this.root.add(pivot);
    return pivot;
  }

  /** Deflect the stick with the current control state. */
  update(_dt: number, controls: ControlInputs, _t: Telemetry): void {
    this.stick.rotation.x = clamp(-controls.elevator, -1, 1) * 0.30;
    this.stick.rotation.z = clamp(-controls.aileron, -1, 1) * 0.28;
  }
}
