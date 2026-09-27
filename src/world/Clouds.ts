import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../util/math';
import { fbm } from '../util/noise';

/** Side length of the tile the cloud field repeats over, metres. */
export const FIELD = 26000;
/** Puffs per cloud cluster. */
const PER_CLUSTER = 14;

/**
 * Where the billboards hand over to the far deck, metres from the camera.
 *
 * The puffs live in a 26 km tile wrapped around the camera, so the field is a
 * square patch with an edge on it. Down low that edge is past the horizon and
 * behind the haze and nobody sees it. Climb, and it becomes the most prominent
 * thing in the sky: a straight line where the overcast simply stops, with
 * clear air beyond. Fading them out inside their own tile is what removes it.
 */
export const HANDOVER_IN = 8200;
export const HANDOVER_OUT = 12_400;

/**
 * Default altitude of the far deck, metres.
 *
 * Near the average of the billboard clusters, whose bases run 1500–2800 m and
 * whose tops add a few hundred more. It has to be about right or the join
 * shows as a step in the horizon — but only for the weathers whose deck *is*
 * the billboards' own layer. Fog in the valleys sits far below it and cirrus
 * far above, so the altitude is a number the weather sets.
 */
export const DECK_Y = 2350;
/** How far the deck reaches. Well past where the haze has swallowed it. */
export const DECK_REACH = 160_000;
/**
 * Where the sheet starts once you are clear of the layer, metres.
 *
 * The ring's own inner radius has to be inside this, or closing the handover
 * only moves the hole rather than filling it.
 */
export const CLOSED_IN = 500;
export const CLOSED_OUT = 1600;
/** Inner radius of the ring the deck is drawn on. */
export const DECK_INNER = 260;

/**
 * Cumulus deck built from camera-facing billboards.
 *
 * Not a raymarched volume: at this scale a full volumetric pass would dominate
 * the frame budget, and the thing that actually sells clouds from a cockpit is
 * silhouette and shading, both of which billboards give cheaply. Puffs are
 * grouped into clusters so they read as individual clouds rather than uniform
 * fog, and the whole field wraps toroidally around the camera so it never runs
 * out however far you fly.
 *
 * All puffs live in one InstancedMesh — one draw call for the entire sky.
 */
/**
 * What the far sheet is, for one weather.
 *
 * A single flat layer covers three quite different skies depending only on
 * where it is put and how it is drawn: fog lying in the valleys, the overcast
 * lid at cloud base, and cirrus eight miles up. These are the differences.
 */
export interface DeckStyle {
  /** How much of the sky it covers, 0–1. Defaults to the billboard coverage. */
  coverage?: number;
  /** Altitude, metres above sea level. */
  y?: number;
  /** Extra opacity multiplier — cirrus is thin however much of it there is. */
  alpha?: number;
  /** How far the masses are drawn out into bands along the wind, 0–1. */
  streak?: number;
  /** How bright the underside is. Fog is grey from below; cirrus is not. */
  lift?: number;
}

export class Clouds {
  readonly mesh: THREE.InstancedMesh;
  /**
   * The overcast seen from a distance, as one horizontal sheet.
   *
   * Billboards are the right tool for cloud you are among and the wrong one
   * for cloud forty kilometres away: to cover the sky out to the horizon with
   * puffs you would need tens of thousands of them, and each one is a few
   * pixels of overdraw. So beyond the handover the deck becomes what it looks
   * like from far off anyway — a surface, shaded by whether you are above or
   * below it, with the weather's own coverage cut into it.
   *
   * This is also the whole of why the sky empties out on the way up. The puffs
   * end at thirteen kilometres; from eleven thousand metres that is a small
   * disc almost directly beneath you, and everything else is bare sky.
   */
  readonly deck: THREE.Mesh;
  private readonly deckMaterial: THREE.ShaderMaterial;
  private deckY = DECK_Y;
  /**
   * How much billboard cloud there is, which decides whether the sheet needs
   * to keep out of the way — see the handover in `update`.
   */
  private puffs = 1;

  private readonly material: THREE.ShaderMaterial;
  private readonly maxPuffs: number;
  private activePuffs: number;
  private budget: number;
  private sizeScale = 1;
  /** Home position of each puff inside the repeating tile. */
  private readonly base: Float32Array;
  private readonly radius: Float32Array;
  /**
   * Pristine per-puff attributes. The GPU-side arrays get permuted into draw
   * order every sort, so re-sorting from them would compound the permutation
   * and progressively scramble which puff has which shading.
   */
  private readonly shadeSrc: Float32Array;
  private readonly seedSrc: Float32Array;
  private readonly order: number[] = [];

  private readonly _m = new THREE.Matrix4();
  private readonly _pos = new THREE.Vector3();
  private readonly _lastSort = new THREE.Vector3(Infinity, 0, Infinity);

  constructor(maxPuffs = 1000) {
    this.maxPuffs = maxPuffs;
    this.activePuffs = maxPuffs;
    this.budget = maxPuffs;
    this.base = new Float32Array(maxPuffs * 3);
    this.radius = new Float32Array(maxPuffs);

    const shade = new Float32Array(maxPuffs);
    const seed = new Float32Array(maxPuffs);
    this.shadeSrc = new Float32Array(maxPuffs);
    this.seedSrc = new Float32Array(maxPuffs);

    // Lay the puffs out as clusters, each cluster a squashed ellipsoid of puffs.
    let i = 0;
    let cluster = 0;
    while (i < maxPuffs) {
      // Cluster centre, placed with noise so clouds group into weather systems
      // rather than being uniformly scattered.
      const cx = pseudo(cluster * 3 + 0) * FIELD;
      const cz = pseudo(cluster * 3 + 1) * FIELD;
      const density = fbm(cx * 0.00008, cz * 0.00008, 3) * 0.5 + 0.5;
      const base = 1500 + pseudo(cluster * 3 + 2) * 1300;
      const spread = 500 + density * 900;
      const height = 260 + density * 420;

      const puffs = Math.min(PER_CLUSTER, maxPuffs - i);
      for (let p = 0; p < puffs; p++, i++) {
        const t = p / Math.max(1, puffs - 1);
        const ang = pseudo(i * 7 + 1) * Math.PI * 2;
        const rad = Math.sqrt(pseudo(i * 7 + 2)) * spread;
        // Higher puffs sit nearer the middle, giving a domed cumulus profile.
        const up = Math.pow(pseudo(i * 7 + 3), 1.6);
        this.base[i * 3] = cx + Math.cos(ang) * rad * (1 - up * 0.55);
        this.base[i * 3 + 1] = base + up * height;
        this.base[i * 3 + 2] = cz + Math.sin(ang) * rad * (1 - up * 0.55);
        this.radius[i] = lerp(340, 700, pseudo(i * 7 + 4)) * (0.7 + density * 0.5);
        shade[i] = up;              // 0 at the base, 1 at the top
        seed[i] = pseudo(i * 7 + 5);
        this.shadeSrc[i] = shade[i];
        this.seedSrc[i] = seed[i];
        void t;
      }
      cluster++;
    }

    const geometry = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geometry.index = quad.index;
    geometry.attributes.position = quad.attributes.position;
    geometry.attributes.uv = quad.attributes.uv;
    geometry.setAttribute('aShade', new THREE.InstancedBufferAttribute(shade, 1));
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));

    this.material = createCloudMaterial();
    this.mesh = new THREE.InstancedMesh(geometry, this.material, maxPuffs);
    this.mesh.count = maxPuffs;
    this.mesh.frustumCulled = false; // the field always surrounds the camera
    this.mesh.renderOrder = 10;      // after opaque geometry
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    for (let k = 0; k < maxPuffs; k++) this.order.push(k);

    this.deckMaterial = createDeckMaterial();
    // A ring rather than a disc: the middle is never drawn — the billboards
    // own everything inside the handover — so there is no reason to rasterise
    // it and every reason not to, since that is the part nearest the camera.
    // Inner radius inside the *closed* handover, since that is how near the
    // sheet comes when you are clear of the layer.
    const ring = new THREE.RingGeometry(DECK_INNER, DECK_REACH, 128, 44);
    ring.rotateX(-Math.PI / 2);
    this.deck = new THREE.Mesh(ring, this.deckMaterial);
    this.deck.frustumCulled = false;
    this.deck.renderOrder = 9; // behind the puffs, which blend over it
    this.deck.castShadow = false;
    this.deck.receiveShadow = false;
  }

  /**
   * Coverage, puff size and how dark the cloud is.
   *
   * Heavier weather is expressed as more and bigger cloud rather than more haze:
   * scaling the puffs up is what turns scattered cumulus into a solid overcast
   * deck, and darkening them is what makes a storm read as a storm.
   */
  setStyle(coverage: number, sizeScale = 1, darkness = 1, deck: DeckStyle = {}): void {
    const c = clamp(coverage, 0, 1);
    this.puffs = c;
    this.activePuffs = Math.round(this.maxPuffs * clamp(0.25 + c * 0.75, 0, 1));
    this.mesh.count = Math.min(this.activePuffs, this.budget);
    this.material.uniforms.uOpacity.value = lerp(0.72, 0.99, c);
    this.material.uniforms.uDark.value = darkness;

    // The far sheet has its own coverage, so a sky can be full of cumulus with
    // nothing laid across the horizon behind them. At zero it is switched off
    // outright rather than merely thresholded away: the deck is a ring that
    // fills most of the frame, and paying for that overdraw to discard every
    // fragment is the one case worth a branch on the CPU.
    const d = clamp(deck.coverage ?? c, 0, 1);
    this.deck.visible = d > 0.02;
    this.deckY = deck.y ?? DECK_Y;
    this.deckMaterial.uniforms.uOpacity.value = lerp(0.72, 0.99, d) * (deck.alpha ?? 1);
    this.deckMaterial.uniforms.uDark.value = darkness;
    this.deckMaterial.uniforms.uCoverage.value = d;
    this.deckMaterial.uniforms.uStreak.value = clamp(deck.streak ?? 0, 0, 1);
    this.deckMaterial.uniforms.uLift.value = clamp(deck.lift ?? 0, 0, 1);
    if (this.sizeScale !== sizeScale) {
      this.sizeScale = sizeScale;
      this._lastSort.set(Infinity, 0, Infinity); // force the matrices to be rewritten
    }
  }

  /** Cap the puff count for the quality preset. */
  setBudget(puffs: number): void {
    this.budget = Math.min(puffs, this.maxPuffs);
    this.mesh.count = Math.min(this.activePuffs, this.budget);
  }

  /**
   * Cloud colours are supplied directly rather than derived from the scene's
   * sun light. A cloud deck sits *above* the weather, so it stays bright even
   * when the ground below is overcast and sunless — shading it with the
   * weather-dimmed sun colour turns the sky into dark grey blobs.
   */
  setLighting(sunDirection: THREE.Vector3, top: THREE.Color, base: THREE.Color): void {
    this.material.uniforms.uSunDir.value.copy(sunDirection);
    this.material.uniforms.uTop.value.copy(top);
    this.material.uniforms.uBase.value.copy(base);
    this.deckMaterial.uniforms.uTop.value.copy(top);
    this.deckMaterial.uniforms.uBase.value.copy(base);
  }

  /**
   * The scene's haze, handed to both cloud materials.
   *
   * Was two lines poking at the puff material's uniforms from the world; with
   * a second material to keep in step that is one place too many to remember.
   */
  setFog(colour: THREE.Color, density: number): void {
    this.material.uniforms.fogColor.value.copy(colour);
    this.material.uniforms.fogDensity.value = density;
    this.deckMaterial.uniforms.fogColor.value.copy(colour);
    this.deckMaterial.uniforms.fogDensity.value = density;
  }

  /**
   * Wrap the field around the camera and re-sort back-to-front.
   *
   * Sorting matters: these are alpha-blended without depth writes, so drawing a
   * near puff before a far one leaves a visible hard edge. It is only redone
   * once the camera has moved appreciably — doing it every frame is wasted work
   * at 200 m/s, and not doing it at all is clearly visible.
   */
  update(camera: THREE.Camera, dt: number): void {
    this.material.uniforms.uTime.value += dt;

    const cam = camera.position;
    // Every frame, both of them: the radial fade and the deck's own centre are
    // measured from the camera, and letting them lag until the next re-sort
    // would make the horizon breathe every 250 m of flying.
    this.material.uniforms.uCam.value.copy(cam);
    this.deckMaterial.uniforms.uCam.value.copy(cam);
    this.deck.position.set(cam.x, this.deckY, cam.z);

    // Close the hole once you are clear of the layer.
    //
    // The handover exists so that a horizontal sheet and a field of billboards
    // are never fighting over the same piece of sky at the same altitude. That
    // is a problem only while you are *in* the layer. Fly a kilometre above it
    // and the ring of missing deck around you turns the whole thing into a
    // distant wall: open water directly below, solid overcast from eight
    // kilometres out, and no way to get over it because it recedes as fast as
    // you approach. Above or below, the sheet simply continues underfoot.
    //
    // And it is only ever needed where there are billboards to conflict with.
    // Fog in the valleys and cirrus at ten kilometres both sit a long way from
    // the cumulus layer, so for those the sheet comes right up to the camera
    // however close to it you fly — which is what lets you skim the top of an
    // inversion instead of dragging a hole through it.
    const sep = Math.abs(cam.y - this.deckY);
    const near = 1 - smoothstep(700, 2400, sep);
    const clear = near * smoothstep(0.3, 0.8, this.puffs);

    // And it fades out entirely as you sink into it.
    //
    // A flat sheet is a good model of a cloud layer seen from outside and a
    // terrible one from inside: at your own altitude it is edge-on, one
    // fragment covers a square kilometre of noise, and it draws as long
    // diagonal smears across the whole view. Which is the moment it is least
    // needed — being *in* cloud is what the haze is for, and at these
    // altitudes the haze is at its thickest. So the sheet gets out of the way
    // over the last few hundred metres and hands over to it.
    this.deckMaterial.uniforms.uEnter.value = smoothstep(130, 460, sep)
      // And thins out again as you leave it behind.
      //
      // Skimming the top of a layer it should be as solid as it looks from a
      // cockpit — you are inside the weather. From twenty thousand feet you
      // are looking through the whole depth of the atmosphere at something a
      // few hundred metres thick, and it reads as a wash over the country
      // rather than a lid on it. Held at full strength it looked like snow
      // cover painted onto the map.
      * (1 - 0.55 * smoothstep(1400, 6000, cam.y - this.deckY));
    this.deckMaterial.uniforms.uNear.value = lerp(CLOSED_IN, HANDOVER_IN, clear);
    this.deckMaterial.uniforms.uFar.value = lerp(CLOSED_OUT, HANDOVER_OUT, clear);

    if (this._lastSort.distanceTo(cam) < 250) return;
    this._lastSort.copy(cam);

    const count = this.mesh.count;
    const wrapped = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Nearest repeat of this puff's home position to the camera.
      const x = this.base[i * 3] + FIELD * Math.round((cam.x - this.base[i * 3]) / FIELD);
      const z = this.base[i * 3 + 2] + FIELD * Math.round((cam.z - this.base[i * 3 + 2]) / FIELD);
      wrapped[i * 3] = x;
      wrapped[i * 3 + 1] = this.base[i * 3 + 1];
      wrapped[i * 3 + 2] = z;
    }

    this.order.length = count;
    for (let i = 0; i < count; i++) this.order[i] = i;
    this.order.sort((a, b) => {
      const da =
        (wrapped[a * 3] - cam.x) ** 2 +
        (wrapped[a * 3 + 1] - cam.y) ** 2 +
        (wrapped[a * 3 + 2] - cam.z) ** 2;
      const db =
        (wrapped[b * 3] - cam.x) ** 2 +
        (wrapped[b * 3 + 1] - cam.y) ** 2 +
        (wrapped[b * 3 + 2] - cam.z) ** 2;
      return db - da; // farthest first
    });

    const shade = this.mesh.geometry.getAttribute('aShade') as THREE.InstancedBufferAttribute;
    const seed = this.mesh.geometry.getAttribute('aSeed') as THREE.InstancedBufferAttribute;
    const shadeOut = new Float32Array(count);
    const seedOut = new Float32Array(count);

    for (let slot = 0; slot < count; slot++) {
      const i = this.order[slot];
      this._pos.set(wrapped[i * 3], wrapped[i * 3 + 1], wrapped[i * 3 + 2]);
      const r = this.radius[i] * this.sizeScale;
      this._m.makeScale(r, r, r);
      this._m.setPosition(this._pos);
      this.mesh.setMatrixAt(slot, this._m);
      shadeOut[slot] = this.shadeSrc[i];
      seedOut[slot] = this.seedSrc[i];
    }

    shade.array.set(shadeOut);
    seed.array.set(seedOut);
    shade.needsUpdate = true;
    seed.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.deck.geometry.dispose();
    this.deckMaterial.dispose();
  }
}

/** Deterministic [0,1) from an index — reproducible cloud fields across reloads. */
function pseudo(n: number): number {
  let h = Math.imul(n | 0, 374761393) + 668265263;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The far deck: one horizontal sheet standing in for cloud too distant to be
 * worth a billboard.
 *
 * Everything about it is decided per fragment from the world position, so the
 * geometry can be a coarse ring and the coverage still has detail wherever the
 * eye is close enough to see any.
 */
/*
 * Both cloud shaders are raw ShaderMaterials, so they have to opt into the
 * logarithmic depth buffer by hand.
 *
 * The renderer runs with `logarithmicDepthBuffer: true`, which every built-in
 * material handles through these four chunks. A custom shader that omits them
 * writes ordinary perspective depth into a buffer everything else has filled
 * with log depth, and the comparison is then meaningless — measured, the far
 * deck was being rejected wherever terrain lay behind it and survived only
 * against open sky, which drew it as a thin strip along the horizon and
 * nothing else. The puffs had the same fault the whole time; it shows up as
 * cloud vanishing where it crosses the land.
 */
function createDeckMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    uniforms: {
      uCam: { value: new THREE.Vector3() },
      uTop: { value: new THREE.Color(2.4, 2.35, 2.25) },
      uBase: { value: new THREE.Color(0.85, 0.9, 1.05) },
      uOpacity: { value: 0.8 },
      uDark: { value: 1.0 },
      uCoverage: { value: 0.5 },
      // Where the sheet begins, in metres from the camera. Not constants: see
      // `setHandover`.
      uNear: { value: HANDOVER_IN },
      uFar: { value: HANDOVER_OUT },
      uStreak: { value: 0 },
      uLift: { value: 0 },
      uEnter: { value: 1 },
      fogColor: { value: new THREE.Color(0xa8c2d8) },
      fogDensity: { value: 0.0000185 },
    },
    vertexShader: /* glsl */ `
      // <common> as well as the logdepth pars: logdepthbuf_vertex calls
      // isPerspectiveMatrix, which is declared in there and nowhere else.
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorld;
      varying float vFogDepth;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 vp = viewMatrix * wp;
        vFogDepth = -vp.z;
        gl_Position = projectionMatrix * vp;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uCam;
      uniform vec3 uTop;
      uniform vec3 uBase;
      uniform float uOpacity;
      uniform float uDark;
      uniform float uCoverage;
      uniform float uNear;
      uniform float uFar;
      uniform float uStreak;
      uniform float uLift;
      uniform float uEnter;
      uniform vec3 fogColor;
      uniform float fogDensity;

      varying vec3 vWorld;
      varying float vFogDepth;

      float hash(vec2 p) {
        p = fract(p * vec2(443.897, 441.423));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
        return v;
      }

      void main() {
        #include <logdepthbuf_fragment>
        float ground = length(vWorld.xz - uCam.xz);
        float take = smoothstep(uNear, uFar, ground);
        if (take < 0.004) discard;

        // Two scales, and only the fine one gives up with distance.
        //
        // The fine noise has to fade — at a hundred kilometres one of its
        // cells is a couple of pixels across and sampling it there is static
        // rather than cloud. But fading it into a *constant* was what made the
        // far half of the sky a featureless sheet, and a featureless sheet
        // sitting on the horizon at a fixed distance is a wall. The coarse
        // octave, thirty kilometres to a cell, is still resolvable out at the
        // horizon and is what gives the deck somewhere to end and begin.
        float detail = 1.0 - smoothstep(45000.0, 155000.0, ground);

        // Warped before it is sampled, so the masses curl.
        //
        // Value noise thresholded straight gives round blobs with smooth
        // contours — the same fault the farmland had before its coordinates
        // were bent. Displacing the sample point by a slower noise costs two
        // lookups and turns circles into the lobed, drawn-out shapes weather
        // actually makes.
        //
        // uStreak squeezes one axis before the lookup, which draws the
        // masses out into long parallel bands. It is the whole of what makes
        // cirrus look like cirrus rather than like low cloud seen from far
        // away: fibrous, combed in one direction, and nothing like a cumulus
        // field. The warp is eased off as it rises, because a strong warp on
        // an already-stretched field just tangles the bands.
        float pull = 1.0 + uStreak * 7.0;
        vec2 p = vec2(vWorld.x, vWorld.z * pull) * 0.000032;
        p += (vec2(fbm(p * 1.7 + 11.3), fbm(p * 1.7 - 7.1)) - 0.5)
           * (0.85 * (1.0 - uStreak * 0.72));
        float coarse = fbm(p);
        float f = mix(coarse,
          mix(coarse, fbm(vec2(vWorld.x, vWorld.z * pull) * 0.00029), 0.6), detail);

        // A ragged edge, not a contour line.
        //
        // The boundary of a cloud is torn at every scale, and a smoothstep
        // between two fixed levels gives the one thing it never is: a clean
        // curve. Pushing the threshold itself about with a fine noise breaks
        // the edge up into shreds. It fades with distance along with the rest
        // of the detail, or it turns to static out at the horizon.
        // Eased off for a streaked sky: cirrus has wispy ends, not torn ones.
        float tear = (fbm(vWorld.xz * 0.00115) - 0.5) * 0.15 * detail
                   * (1.0 - uStreak * 0.6);

        // And overcast is not total. Even a solid-looking deck has breaks in
        // it, and painting every square kilometre out to the horizon leaves
        // nowhere for the eye to rest and nothing to fly over. Around three
        // quarters covered at the heaviest setting.
        float lo = 0.70 - uCoverage * 0.34 + tear;
        float cover = smoothstep(lo, lo + 0.085, f);
        if (cover < 0.004) discard;

        // Thin at the edges: cloud does not end at full opacity. Well inside a
        // mass it is solid, and for some way in from the boundary you can see
        // the ground through it.
        float thick = 0.58 + 0.42 * smoothstep(lo, lo + 0.22, f);

        // Above the deck you are looking at sunlit tops; below it, at shaded
        // bases. The band is a few hundred metres wide so flying through the
        // layer is a transition rather than a switch.
        //
        // Neither end is the raw base colour. A puff is never that flat even
        // underneath — its own shading lifts the middle a third of the way to
        // the top colour — so a deck painted in flat uBase reads as a
        // different, darker material sitting next to the billboards.
        //
        // uLift decides how much of the top colour the underside gets. A fog
        // layer seen from beneath is grey; cirrus seen from beneath is the
        // brightest thing in the sky, because it is thin enough to be lit
        // straight through. One number covers both.
        float above = smoothstep(-300.0, 300.0, uCam.y - vWorld.y);
        vec3 col = mix(mix(uBase, uTop, 0.22 + uLift * 0.5) * uDark,
                       mix(uBase, uTop, 0.72), above);
        col *= 0.88 + 0.26 * f;

        float fogFactor = clamp(
          1.0 - exp(-fogDensity * fogDensity * 0.35 * vFogDepth * vFogDepth), 0.0, 1.0);
        col = mix(col, fogColor, fogFactor);

        // Only right at the rim.
        //
        // This used to start at 55% haze, which took the sheet away at around
        // sixty kilometres — from any altitude that is well short of the
        // horizon, so the overcast ended in mid-air and open water showed
        // beyond it. By the geometry's own edge the colour has converged to
        // the haze to within a thousandth, so there is nothing left to hide
        // and this only has to cover the last of it.
        float dissolve = 1.0 - smoothstep(0.985, 1.0, fogFactor);

        gl_FragColor = vec4(col, take * cover * thick * dissolve * uEnter * uOpacity);
      }
    `,
  });
}

function createCloudMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false, // blended volume; terrain must still occlude it
    depthTest: true,
    side: THREE.DoubleSide,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uTop: { value: new THREE.Color(2.4, 2.35, 2.25) },
      uBase: { value: new THREE.Color(0.85, 0.9, 1.05) },
      uOpacity: { value: 0.8 },
      uDark: { value: 1.0 },
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      fogColor: { value: new THREE.Color(0xa8c2d8) },
      fogDensity: { value: 0.0000185 },
    },
    vertexShader: /* glsl */ `
      // <common> as well as the logdepth pars: logdepthbuf_vertex calls
      // isPerspectiveMatrix, which is declared in there and nowhere else.
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform vec3 uCam;
      attribute float aShade;
      attribute float aSeed;
      varying vec2 vUv;
      varying float vShade;
      varying float vSeed;
      varying float vFogDepth;
      varying float vGround;

      void main() {
        vUv = uv;
        vShade = aShade;
        vSeed = aSeed;

        // Billboard: build the quad from the camera's right/up axes so every
        // puff faces the viewer regardless of how the aircraft is oriented.
        vec3 centre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float scale = length(instanceMatrix[0].xyz);
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 world = centre + (right * position.x + up * position.y) * scale;

        // Horizontal distance only. The fade is about the edge of the tile,
        // which is a distance across the ground — measured in three dimensions
        // it would also fade the deck directly below you on the way up, which
        // is the one place it has to stay.
        vGround = length(centre.xz - uCam.xz);

        vec4 viewPos = viewMatrix * vec4(world, 1.0);
        vFogDepth = -viewPos.z;
        gl_Position = projectionMatrix * viewPos;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSunDir;
      uniform vec3 uTop;
      uniform vec3 uBase;
      uniform float uOpacity;
      uniform float uDark;
      uniform float uTime;
      uniform vec3 fogColor;
      uniform float fogDensity;

      const float HANDOVER_IN = ${HANDOVER_IN}.0;
      const float HANDOVER_OUT = ${HANDOVER_OUT}.0;

      varying vec2 vUv;
      varying float vShade;
      varying float vSeed;
      varying float vFogDepth;
      varying float vGround;

      float hash(vec2 p) {
        p = fract(p * vec2(443.897, 441.423));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
      }

      void main() {
        #include <logdepthbuf_fragment>
        vec2 d = vUv - 0.5;
        float r = length(d) * 2.0;

        // Soft round falloff, *modulated* by noise rather than offset by it —
        // offsetting the radius carves hard notches out of the silhouette and
        // makes the deck look speckled instead of billowy.
        float n = noise(vUv * 3.0 + vSeed * 40.0) * 0.6
                + noise(vUv * 7.0 - vSeed * 17.0) * 0.4;
        float alpha = smoothstep(1.0, 0.12, r) * (0.55 + 0.45 * n);
        // Gone before the tile edge, where the far deck has already taken over.
        alpha *= 1.0 - smoothstep(HANDOVER_IN, HANDOVER_OUT, vGround);
        if (alpha < 0.01) discard;

        // Cheap volume shading: bright tops, cooler bases, and a brighter edge
        // where the sun is behind the puff.
        vec3 col = mix(uBase, uTop, smoothstep(-0.15, 0.9, vShade + (1.0 - r) * 0.35));

        float rim = pow(1.0 - r, 2.0) * max(uSunDir.y, 0.0);
        col += uTop * rim * 0.25;
        col *= uDark;

        // Match the scene's exponential-squared haze so distant cloud fades out.
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * 0.35 * vFogDepth * vFogDepth);
        col = mix(col, fogColor, clamp(fogFactor, 0.0, 1.0));

        gl_FragColor = vec4(col, alpha * uOpacity);
      }
    `,
  });
}
