import * as THREE from 'three';
import { SEA_LEVEL } from './Terrain';

/**
 * How deep the water has to be before it is "deep", metres.
 *
 * Past this the seabed contributes nothing to the colour of the surface, which
 * is why the open ocean is the same everywhere. Twenty-eight metres is about
 * where a sand bottom stops showing through in daylight.
 */
export const DEEP_WATER = 28;

/**
 * Metres of sea covered by the depth map, edge to edge.
 *
 * Has to reach as far as you can *see* shallow water, not as far as you might
 * fly over it. At 22 km the atoll went navy whenever it was more than eleven
 * kilometres off — so approaching it from outside the reef, the turquoise
 * appeared out of nowhere partway in. Thirty-two puts the whole lagoon in the
 * map from well outside it.
 */
const MAP_SPAN = 32_000;
/** Texels across. 32 km over 320 is 100 m a texel; the reef crest is six wide. */
const MAP_SIZE = 320;
/**
 * Rows filled per frame.
 *
 * The whole map is 100k terrain lookups, which is 30-plus milliseconds on the
 * more expensive worlds — a visible hitch if it were done in one go. Filling it
 * a strip at a time costs well under a millisecond a frame, and the map being
 * rebuilt is a spare one: nothing on screen changes until it is finished.
 */
const ROWS_PER_FRAME = 10;
/** Rebuild once the aircraft is this far from the middle of the current map. */
const RECENTRE = MAP_SPAN * 0.22;

/**
 * A coarse map of how deep the sea is, for the ocean surface to colour itself by.
 *
 * The sea was one flat colour because the surface has no idea what is under it:
 * it is a single quad four hundred kilometres across, and a fragment shader
 * cannot call the height field. The usual fix — sampling the scene's depth
 * buffer and shading by the thickness of the water column — needs the opaque
 * pass finished and readable before the water draws, which is a restructure of
 * the whole render path for one material.
 *
 * This is the cheaper answer: sample the height field on the CPU into a small
 * texture that follows the aircraft, and hand it to the ocean as a uniform. It
 * costs one channel of 256x256 and a strip of terrain lookups per frame, and it
 * gives every world with a coast a real shoreline instead of a hard edge
 * between "sand" and "navy".
 */
export class Shallows {
  /** Depth below sea level, scaled so 0 is dry land and 1 is `DEEP_WATER` down. */
  readonly texture: THREE.DataTexture;
  /** Where the map's lower-left corner sits, and how big a texel is. */
  readonly origin = new THREE.Vector2();
  readonly span = MAP_SPAN;

  // Typed against a plain ArrayBuffer: `new Uint8Array(n)` widens to
  // ArrayBufferLike, which DataTexture will not take.
  private readonly front: Uint8Array<ArrayBuffer>;
  private readonly back: Uint8Array<ArrayBuffer>;
  /** Corner the strip currently being filled belongs to. */
  private readonly buildOrigin = new THREE.Vector2();
  private buildRow = MAP_SIZE; // nothing in progress
  private ready = false;

  constructor(private readonly groundAt: (x: number, z: number) => number) {
    this.front = new Uint8Array(new ArrayBuffer(MAP_SIZE * MAP_SIZE));
    this.back = new Uint8Array(new ArrayBuffer(MAP_SIZE * MAP_SIZE));
    // Full depth everywhere until the first map lands, so a world opens on
    // honest deep water rather than on a shoreline that is not there.
    this.front.fill(255);
    this.texture = new THREE.DataTexture(this.front, MAP_SIZE, MAP_SIZE, THREE.RedFormat);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    // Clamped, so beyond the map the edge texel repeats. The map is re-centred
    // long before its edge is anywhere near the aircraft, so what repeats out
    // there is open ocean.
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
  }

  /** Whether a finished map is on screen. */
  get complete(): boolean {
    return this.ready && this.buildRow >= MAP_SIZE;
  }

  /** Throw away what is mapped: the height field underneath has changed. */
  invalidate(): void {
    this.ready = false;
    this.buildRow = MAP_SIZE;
    this.front.fill(255);
    this.texture.needsUpdate = true;
  }

  /**
   * Carry on filling, and start again if the aircraft has moved off the map.
   *
   * Called every frame. Does at most `ROWS_PER_FRAME` rows of work, so the cost
   * is flat whatever else is happening.
   */
  update(focus: THREE.Vector3): void {
    const centred = this.buildRow < MAP_SIZE ? this.buildOrigin : this.origin;
    const middleX = centred.x + MAP_SPAN / 2;
    const middleZ = centred.y + MAP_SPAN / 2;
    const adrift = Math.abs(focus.x - middleX) > RECENTRE
      || Math.abs(focus.z - middleZ) > RECENTRE;

    if ((adrift && this.buildRow >= MAP_SIZE) || !this.ready) {
      if (this.buildRow >= MAP_SIZE) {
        this.buildOrigin.set(focus.x - MAP_SPAN / 2, focus.z - MAP_SPAN / 2);
        this.buildRow = 0;
      }
    }
    if (this.buildRow >= MAP_SIZE) return;

    const texel = MAP_SPAN / (MAP_SIZE - 1);
    const end = Math.min(MAP_SIZE, this.buildRow + ROWS_PER_FRAME);
    for (let j = this.buildRow; j < end; j++) {
      const z = this.buildOrigin.y + j * texel;
      const row = j * MAP_SIZE;
      for (let i = 0; i < MAP_SIZE; i++) {
        const x = this.buildOrigin.x + i * texel;
        const depth = SEA_LEVEL - this.groundAt(x, z);
        // 0 where the ground is at or above the water, 255 at DEEP_WATER down.
        this.back[row + i] = depth <= 0 ? 0
          : Math.min(255, Math.round((depth / DEEP_WATER) * 255));
      }
    }
    this.buildRow = end;

    if (this.buildRow >= MAP_SIZE) {
      // Swap in one go, so the surface never shows half of one map and half of
      // another with a seam across the middle of the lagoon.
      this.front.set(this.back);
      this.origin.copy(this.buildOrigin);
      this.texture.needsUpdate = true;
      this.ready = true;
    }
  }

  dispose(): void {
    this.texture.dispose();
  }
}
