import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { clampSunlight } from './SkyClamp';
import { TwilightSky } from './TwilightSky';
import { setHaze, setGroundFog, hazeUniforms } from './Haze';
import {
  Terrain, terrainHeight, setTerrainSeed, getTerrainSeed,
  setWorld as selectWorld, WORLD_PRESETS, type WorldPreset,
} from './Terrain';
import { fieldElevation } from './Worlds';
import { fogCover } from './GroundFog';
import { QUALITY_PRESETS, DEFAULT_QUALITY, type QualityPreset } from '../render/Quality';
import { Ocean } from './Ocean';
import { Shallows } from './Shallows';

/**
 * The sea where a world does not say otherwise: a temperate coast, silt rather
 * than coral sand. Matches the colours the ocean material compiles with.
 */
const DEFAULT_WATER = { deep: 0x0a2536, shallow: 0x2f6f74, sand: 0x7e8f7a, glow: undefined };
import { Clouds, DECK_Y, type DeckStyle } from './Clouds';
import { Storm } from './Storm';
import { buildSettlementMeshes, disposeSettlementMeshes } from './Settlements';
import { buildBoatMeshes, disposeBoatMeshes } from './Boats';
import { buildStructureMeshes, disposeStructureMeshes } from './Structures';
import { buildAerodromeMeshes, disposeAerodromeMeshes } from './Aerodromes';
import { Vegetation } from './Vegetation';
import { clamp, lerp, smoothstep } from '../util/math';
import type { Engine } from '../core/Engine';

/**
 * Sun elevation in degrees for the selectable times of day.
 *
 * `twilight` marks the hours when the sun is below the horizon. Everything else
 * here is derived from elevation alone, which works right up until the sun sets:
 * below the horizon the light is not a dim *warm* sun but a cool wash from a sky
 * that is still lit from underneath, and no function of elevation gives you
 * that. It is the one thing a preset has to say for itself.
 *
 * Ordered as a day: dawn through dusk, then blue hour after the sun has gone,
 * so cycling with T walks the light round in sequence.
 */
export const TIME_PRESETS = [
  { name: 'DAWN', elevation: 3.5, azimuth: 100, twilight: 0 },
  { name: 'MORNING', elevation: 19, azimuth: 145, twilight: 0 },
  { name: 'NOON', elevation: 62, azimuth: 180, twilight: 0 },
  { name: 'GOLDEN', elevation: 8, azimuth: 250, twilight: 0 },
  { name: 'DUSK', elevation: 1.2, azimuth: 268, twilight: 0 },
  // Below the horizon: no direct sun, a deep blue sky, and stars.
  { name: 'BLUE HOUR', elevation: -2.0, azimuth: 285, twilight: 1 },
];

/**
 * The same six hours, placed on a clock, plus the night between them.
 *
 * The presets are the art direction — each one is a look somebody tuned — and
 * this turns them into keyframes so the sun can be anywhere between. Reading
 * two of them and mixing keeps every in-between hour on the line joining two
 * hours that were designed, rather than on a curve invented here.
 *
 * The two extra entries are the part the presets never had: the middle of the
 * night, and the first hint of light before dawn. Without them a drifting sun
 * would run out of keyframes at half past eight in the evening and have
 * nowhere to go until dawn.
 */
const SUN_KEYS = [
  { hour: 0.0, elevation: -34, azimuth: 350, twilight: 1 },
  { hour: 4.2, elevation: -9, azimuth: 65, twilight: 1 },
  { hour: 5.6, elevation: 3.5, azimuth: 100, twilight: 0 },
  { hour: 8.6, elevation: 19, azimuth: 145, twilight: 0 },
  { hour: 12.6, elevation: 62, azimuth: 180, twilight: 0 },
  { hour: 18.1, elevation: 8, azimuth: 250, twilight: 0 },
  { hour: 19.5, elevation: 1.2, azimuth: 268, twilight: 0 },
  { hour: 20.6, elevation: -2.0, azimuth: 285, twilight: 1 },
  { hour: 24.0, elevation: -34, azimuth: 350, twilight: 1 },
];

/** Which hour each named preset sits at, in the same order as `TIME_PRESETS`. */
const PRESET_HOURS = [5.6, 8.6, 12.6, 18.1, 19.5, 20.6];

/** The sun's position at any hour, mixed from the two keyframes either side. */
function sunAt(hour: number): { elevation: number; azimuth: number; twilight: number } {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < SUN_KEYS.length - 2 && SUN_KEYS[i + 1].hour <= h) i++;
  const a = SUN_KEYS[i];
  const b = SUN_KEYS[i + 1];
  const t = clamp((h - a.hour) / Math.max(1e-6, b.hour - a.hour), 0, 1);
  // Eased, so the sun does not visibly change pace as it crosses a keyframe.
  const e = t * t * (3 - 2 * t);
  return {
    elevation: lerp(a.elevation, b.elevation, e),
    azimuth: lerp(a.azimuth, b.azimuth, e),
    twilight: lerp(a.twilight, b.twilight, e),
  };
}

/**
 * How fast the day runs, in sim hours per real second.
 *
 * Off by default. The sim is asked to open at golden hour, and a clock running
 * by default would walk it straight out of the light it was asked to open in —
 * so this is a thing you turn on, not a thing you turn off.
 */
/**
 * How far the sun may move before the reflections are rebaked, as a chord on
 * the unit sphere — about a third of a degree.
 *
 * Small enough that no reflection visibly lags, large enough that a fast day
 * bakes a few times a second rather than sixty.
 */
const BAKE_STEP = 0.006;

export const DRIFT_RATES = [
  { name: 'OFF', perSecond: 0 },
  { name: 'SLOW', perSecond: 24 / (26 * 60) },
  { name: 'FAST', perSecond: 24 / (7 * 60) },
] as const;

/**
 * Weather: cloud coverage plus the atmosphere around it — haze depth, how much
 * the sky scatters, and how much of the sun reaches the ground. `cloud` drives
 * the cumulus deck, so overcast genuinely means flying under cloud rather than
 * only under a darker sky.
 */
export const WEATHER_PRESETS = [
  // `fog` deliberately stays low for the cloudy presets: thick cloud is made of
  // cloud, not of haze. Piling on fog to signal bad weather just greys the whole
  // frame out and hides the landscape.
  //
  // `deck` is the far sheet — the horizontal layer that stands in for cloud
  // too distant to be worth a billboard — and it is a separate number from
  // `cloud` on purpose. The two describe different weather: `cloud` is how
  // much cumulus there is to fly among, `deck` is whether there is a layer
  // covering the country. A sky can have plenty of the first and none of the
  // second, which is most fine afternoons.
  { name: 'CLEAR', cloud: 0.15, cloudScale: 1.0, cloudDark: 1.0,
    deck: 0.15, deckY: DECK_Y, deckAlpha: 1, deckStreak: 0, deckLift: 0,
    groundFog: 0, fogScale: 0.000032, fogPatch: 0.4, fogSoft: 0.2,
    hazeScale: 2300, rain: 0, storm: 0,
    turbidity: 3.0, rayleigh: 1.7, fog: 0.7, sun: 1.0, ambient: 0.95 },
  // A good cumulus day: plenty of cloud, all of it separate, and nothing laid
  // over the horizon. Scaled smaller than overcast deliberately — puffs this
  // size stay individual clouds you fly between instead of merging into one
  // grey lid, which is the whole difference between this and OVERCAST.
  { name: 'CLOUDS', cloud: 0.78, cloudScale: 1.2, cloudDark: 0.92,
    deck: 0, deckY: DECK_Y, deckAlpha: 1, deckStreak: 0, deckLift: 0,
    groundFog: 0, fogScale: 0.000032, fogPatch: 0.4, fogSoft: 0.2,
    hazeScale: 2300, rain: 0, storm: 0,
    turbidity: 4.4, rayleigh: 2.0, fog: 0.85, sun: 0.96, ambient: 1.02 },
  // Eight miles up, and above absolutely everything else in the sim.
  //
  // The ground is clear, the air is clean — a *higher* haze scale height than
  // clear, so the range is enormous — and the only cloud is a combed fibrous
  // layer catching the sun. Thin whatever its coverage, and bright from
  // underneath, which is the opposite of every other deck here: it is lit
  // straight through rather than shadowing the ground.
  { name: 'CIRRUS', cloud: 0.08, cloudScale: 1.0, cloudDark: 1.0,
    deck: 0.46, deckY: 10_200, deckAlpha: 0.5, deckStreak: 0.92, deckLift: 0.85,
    groundFog: 0, fogScale: 0.000032, fogPatch: 0.4, fogSoft: 0.2,
    hazeScale: 3400, rain: 0, storm: 0,
    turbidity: 2.6, rayleigh: 1.7, fog: 0.62, sun: 1.0, ambient: 0.95 },
  { name: 'HAZY', cloud: 0.4, cloudScale: 1.15, cloudDark: 0.94,
    deck: 0.4, deckY: DECK_Y, deckAlpha: 1, deckStreak: 0, deckLift: 0,
    groundFog: 0, fogScale: 0.000032, fogPatch: 0.4, fogSoft: 0.2,
    hazeScale: 2300, rain: 0, storm: 0,
    turbidity: 6.5, rayleigh: 2.3, fog: 1.7, sun: 0.9, ambient: 1.1 },
  // Fog banks, not a whiteout.
  //
  // Shallow — the top is a few hundred metres over the field, so a climb takes
  // you out of it in under a minute — and broken into banks a few kilometres
  // across rather than one layer over the whole country. Flying it is a
  // sequence: clear, into the white, out the other side, with hills standing
  // clear between the banks the whole time. A fog that covered everything
  // would just be the landscape switched off.
  { name: 'FOG', cloud: 0.3, cloudScale: 1.3, cloudDark: 0.86,
    deck: 0.46, deckY: 340, deckAlpha: 0.85, deckStreak: 0.1, deckLift: 0.3,
    groundFog: 1, fogScale: 0.000115, fogPatch: 0.72, fogSoft: 0.09,
    hazeScale: 340, rain: 0, storm: 0,
    turbidity: 6.0, rayleigh: 2.4, fog: 3.0, sun: 0.74, ambient: 1.22 },
  // The cloud sea. A near-solid layer lying *below* the hills, with the murk
  // held down under it by a scale height a quarter of the usual — so the
  // valleys are buried, the ridges stand out of it as islands, and climbing a
  // few hundred metres takes you out of the weather entirely into clean air
  // and a low sun. Almost no cumulus, because an inversion is what happens
  // when nothing is rising.
  { name: 'INVERSION', cloud: 0.14, cloudScale: 1.05, cloudDark: 0.95,
    deck: 0.62, deckY: 620, deckAlpha: 1, deckStreak: 0.18, deckLift: 0.2,
    groundFog: 1, fogScale: 0.000032, fogPatch: 0.20, fogSoft: 0.22,
    hazeScale: 620, rain: 0, storm: 0,
    turbidity: 5.5, rayleigh: 2.2, fog: 2.4, sun: 0.94, ambient: 1.12 },
  { name: 'OVERCAST', cloud: 1.0, cloudScale: 1.75, cloudDark: 0.66,
    deck: 1.0, deckY: DECK_Y, deckAlpha: 1, deckStreak: 0, deckLift: 0,
    groundFog: 0, fogScale: 0.000032, fogPatch: 0.4, fogSoft: 0.2,
    hazeScale: 2300, rain: 0, storm: 0,
    turbidity: 8.0, rayleigh: 2.6, fog: 1.15, sun: 0.5, ambient: 1.35 },
  // Rain without the drama: falling water and a grey sky, but no lightning and
  // a deck that is merely dull rather than black.
  { name: 'RAIN', cloud: 1.0, cloudScale: 1.9, cloudDark: 0.58,
    deck: 1.0, deckY: DECK_Y, deckAlpha: 1, deckStreak: 0, deckLift: 0,
    groundFog: 0, fogScale: 0.000032, fogPatch: 0.4, fogSoft: 0.2,
    hazeScale: 2300, rain: 0.55, storm: 0,
    turbidity: 8.5, rayleigh: 2.7, fog: 1.3, sun: 0.44, ambient: 1.3 },
  { name: 'STORM', cloud: 1.0, cloudScale: 2.2, cloudDark: 0.4,
    deck: 1.0, deckY: DECK_Y, deckAlpha: 1, deckStreak: 0, deckLift: 0,
    groundFog: 0, fogScale: 0.000032, fogPatch: 0.4, fogSoft: 0.2,
    hazeScale: 2300, rain: 1, storm: 1,
    turbidity: 10.0, rayleigh: 3.0, fog: 1.5, sun: 0.28, ambient: 1.2 },
];

/** What ground fog tends toward, before the hour's own colour is mixed in. */
const WHITE_FOG = new THREE.Color(0.90, 0.92, 0.95);

/** Winter turns any falling rain into snow. */
const WINTER = 3;

/** Skylight after sunset: cool, and coming from the sky rather than the sun. */
const TWILIGHT_LIGHT = new THREE.Color(0.42, 0.55, 0.92);
const TWILIGHT_AMBIENT = new THREE.Color(0.30, 0.42, 0.72);
const TWILIGHT_FOG = new THREE.Color(0.055, 0.085, 0.19);
const TWILIGHT_GROUND = new THREE.Color(0.09, 0.12, 0.22);
const SKY_AMBIENT = new THREE.Color(0xbcd6f2);
const GROUND_AMBIENT = new THREE.Color(0x4a4436);

/**
 * Season modifies whatever palette the current world defines, rather than
 * replacing it — otherwise picking a season would flatten every world back to
 * the same green hills. It shifts hue and, most visibly, moves the snow line.
 */
export const SEASON_PRESETS = [
  { name: 'SPRING', snowScale: 0.92, tint: [0.12, 0.34, 0.08], tintAmount: 0.2 },
  { name: 'SUMMER', snowScale: 1.0, tint: [0, 0, 0], tintAmount: 0 },
  { name: 'AUTUMN', snowScale: 0.76, tint: [0.46, 0.26, 0.07], tintAmount: 0.32 },
  { name: 'WINTER', snowScale: 0.26, tint: [0.56, 0.59, 0.63], tintAmount: 0.38 },
] as const;

export { WORLD_PRESETS } from './Terrain';

/**
 * Sky, sun, terrain, sea and the airfield.
 *
 * One sun direction drives everything: the Sky shader, the directional light's
 * colour and intensity, the environment map used for reflections, and the fog
 * colour. Changing the time of day therefore relights the whole scene coherently
 * rather than just tinting it.
 */
export class World {
  readonly sun = new THREE.Vector3();
  readonly sunLight: THREE.DirectionalLight;
  readonly terrain = new Terrain();
  readonly ocean = new Ocean();
  /**
   * The seabed map the ocean colours itself by. Built from `terrainHeight`, so
   * it must be thrown away whenever the height field changes underneath it.
   */
  private readonly shallows = new Shallows((x, z) => terrainHeight(x, z));
  readonly clouds = new Clouds();
  /** Trees, streamed round the aircraft. */
  readonly vegetation = new Vegetation();
  private readonly storm = new Storm();

  private readonly sky: Sky;
  private readonly twilight = new TwilightSky();
  private readonly skyScene = new THREE.Scene();
  private readonly ambient: THREE.HemisphereLight;
  private readonly fog: THREE.FogExp2;
  /**
   * The hour of the day, 0 to 24, as a continuous value.
   *
   * This replaces the index into `TIME_PRESETS` as the thing that is true: the
   * presets are now places on this clock rather than the only places the sun
   * can be. `timeIndexValue` still answers with the nearest of them, so the
   * panel's buttons and the HUD carry on working unchanged.
   */
  private clock = PRESET_HOURS[1];
  /** Sim hours per real second. Zero holds the sun where it is. */
  private driftRate = 0;
  /**
   * Where the sun was when the environment map was last baked.
   *
   * The bake renders the sky into a PMREM and is the expensive part of moving
   * the sun — everything else is a handful of colours. So it is done on how far
   * the sun has actually moved rather than every frame: below this the
   * reflections are indistinguishable, and above it they lag visibly.
   */
  private readonly bakedSun = new THREE.Vector3(2, 0, 0);
  private weatherIndex = 0;
  private readonly _fogTint = new THREE.Color();
  private seasonIndex = 1;
  private worldIndex = 0;
  private aerodromes!: THREE.Group;
  private settlements!: THREE.Group;
  private shipping!: THREE.Group;
  private structures!: THREE.Group;
  private quality: QualityPreset = QUALITY_PRESETS[DEFAULT_QUALITY];
  private readonly _shadowFocus = new THREE.Vector3();

  constructor(private readonly engine: Engine) {
    const scene = engine.scene;

    this.sky = new Sky();
    this.sky.scale.setScalar(450000);
    this.sky.material.fragmentShader = clampSunlight(this.sky.material.fragmentShader);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4.2;
    u.rayleigh.value = 2.0;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.87;
    // Draw the sky before everything else.
    //
    // It is an opaque box centred on the origin, and so is the ocean quad — so
    // three sorts them by the same distance, the tie is broken by material id,
    // and the order can swap from frame to frame. Both end up writing the far
    // plane's depth where they meet (see the ocean's size against the camera's
    // far), and two things at the same depth in an unstable order is a
    // rectangle that flickers. The sky writes no depth, so drawing it first
    // costs nothing and settles the question.
    this.sky.renderOrder = -100;
    scene.add(this.sky);

    this.sunLight = new THREE.DirectionalLight(0xfff2e0, 3.2);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 4000;
    this.sunLight.shadow.camera.left = -140;
    this.sunLight.shadow.camera.right = 140;
    this.sunLight.shadow.camera.top = 140;
    this.sunLight.shadow.camera.bottom = -140;
    this.sunLight.shadow.bias = -0.0006;
    this.sunLight.shadow.normalBias = 0.6;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    this.ambient = new THREE.HemisphereLight(0xbcd6f2, 0x4a4436, 0.5);
    scene.add(this.ambient);

    scene.add(this.twilight.group);

    // Exponential-squared haze: aerial perspective that thickens smoothly with
    // distance, so ridges fade into the sky instead of ending at a hard edge.
    this.fog = new THREE.FogExp2(0xa8c2d8, 0.0000185);
    scene.fog = this.fog;

    scene.add(this.terrain.group);
    scene.add(this.ocean.mesh);
    scene.add(this.clouds.mesh);
    scene.add(this.clouds.deck);
    const preset = WORLD_PRESETS[this.worldIndex];
    this.aerodromes = buildAerodromeMeshes();
    scene.add(this.aerodromes);
    this.settlements = buildSettlementMeshes(preset.style.dry, { flatRoofs: preset.flatRoofs, brick: preset.brick });
    scene.add(this.settlements);
    this.shipping = buildBoatMeshes();
    scene.add(this.shipping);
    this.structures = buildStructureMeshes();
    scene.add(this.structures);
    scene.add(this.vegetation.group);
    this.vegetation.regenerate();

    this.ocean.mesh.visible = preset.hasOcean;
    this.applyStyle();
    this.applyAtmosphere();
  }

  /** Step to the next time-of-day preset. Returns its name for the HUD. */
  cycleTimeOfDay(step = 1): string {
    this.setTimeOfDay((this.timeIndexValue + step + TIME_PRESETS.length) % TIME_PRESETS.length);
    return this.timeOfDay;
  }

  setTimeOfDay(index: number): void {
    this.clock = PRESET_HOURS[clamp(Math.round(index), 0, PRESET_HOURS.length - 1)];
    this.applyAtmosphere();
  }

  /** Put the sun at an arbitrary hour. Wraps, so 25 is one in the morning. */
  setClock(hour: number): void {
    if (!Number.isFinite(hour)) return;
    this.clock = ((hour % 24) + 24) % 24;
    this.applyAtmosphere();
  }

  get clockHours(): number {
    return this.clock;
  }

  /** The clock as `HH:MM`, for the panel to show. */
  get clockLabel(): string {
    const h = Math.floor(this.clock);
    const m = Math.floor((this.clock - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  setDrift(index: number): void {
    this.driftRate = DRIFT_RATES[clamp(Math.round(index), 0, DRIFT_RATES.length - 1)].perSecond;
  }

  get driftIndexValue(): number {
    const i = DRIFT_RATES.findIndex((r) => r.perSecond === this.driftRate);
    return i < 0 ? 0 : i;
  }

  /** Step to the next weather preset. Returns its name for the HUD. */
  cycleWeather(step = 1): string {
    this.setWeather(
      (this.weatherIndex + step + WEATHER_PRESETS.length) % WEATHER_PRESETS.length,
    );
    return this.weather;
  }

  setWeather(index: number): void {
    this.weatherIndex = clamp(Math.round(index), 0, WEATHER_PRESETS.length - 1);
    this.applyAtmosphere();
  }

  setSeason(index: number): void {
    this.seasonIndex = clamp(Math.round(index), 0, SEASON_PRESETS.length - 1);
    this.applyStyle();
  }

  /**
   * Switch landscape. The airfield moves to the new world's elevation, the sea
   * is hidden where a world has none, and every chunk is dropped so the terrain
   * rebuilds against the new height field.
   */
  setWorld(index: number): WorldPreset {
    this.worldIndex = clamp(Math.round(index), 0, WORLD_PRESETS.length - 1);
    const preset = selectWorld(this.worldIndex);
    this.ocean.mesh.visible = preset.hasOcean;
    this.applyStyle();
    this.terrain.regenerate();
    this.shallows.invalidate();
    this.clouds.groundChanged();
    this.refreshSettlements();
    return preset;
  }

  /**
   * Rebuild the village and airstrip meshes against the current plan. Selecting
   * a world or reseeding re-sites every village, so the old meshes describe a
   * landscape that no longer exists.
   */
  private refreshSettlements(): void {
    const preset = WORLD_PRESETS[this.worldIndex];
    const tone = preset.style.dry;

    this.engine.scene.remove(this.settlements);
    disposeSettlementMeshes(this.settlements);
    this.settlements = buildSettlementMeshes(tone, { flatRoofs: preset.flatRoofs, brick: preset.brick });
    this.engine.scene.add(this.settlements);

    // The fleet is replanned by the same call that replans the villages, so it
    // is rebuilt in the same place — a new world means new water.
    this.engine.scene.remove(this.shipping);
    disposeBoatMeshes(this.shipping);
    this.shipping = buildBoatMeshes();
    this.engine.scene.add(this.shipping);

    this.engine.scene.remove(this.structures);
    disposeStructureMeshes(this.structures);
    this.structures = buildStructureMeshes();
    this.engine.scene.add(this.structures);

    this.engine.scene.remove(this.aerodromes);
    disposeAerodromeMeshes(this.aerodromes);
    this.aerodromes = buildAerodromeMeshes();
    this.engine.scene.add(this.aerodromes);

    this.vegetation.regenerate();
  }

  get worldIndexValue(): number {
    return this.worldIndex;
  }

  get worldBlurb(): string {
    return WORLD_PRESETS[this.worldIndex].blurb;
  }

  /** Combine the world's palette with the season's modifier. */
  private applyStyle(): void {
    const world = WORLD_PRESETS[this.worldIndex];
    const season = SEASON_PRESETS[this.seasonIndex];
    const shift = (c: readonly [number, number, number]): [number, number, number] => [
      lerp(c[0], season.tint[0], season.tintAmount),
      lerp(c[1], season.tint[1], season.tintAmount),
      lerp(c[2], season.tint[2], season.tintAmount),
    ];
    // The sea is the ocean's business, not the ground's.
    const water = world.style.water ?? DEFAULT_WATER;
    this.ocean.setWaterStyle(water.deep, water.shallow, water.sand, water.glow);
    const grass = shift(world.style.grass);
    // The canopy seen from above: dark, pulled toward the world's own green,
    // turning with the season the way the 3D trees do.
    const base = world.style.grass;
    let timber: [number, number, number] = [
      lerp(base[0] * 0.52, 0.050, 0.62), lerp(base[1] * 0.52, 0.094, 0.62), lerp(base[2] * 0.52, 0.054, 0.62),
    ];
    const toward = (c: [number, number, number], t: number): [number, number, number] =>
      [lerp(timber[0], c[0], t), lerp(timber[1], c[1], t), lerp(timber[2], c[2], t)];
    if (season.name === 'SPRING') timber = toward([0.07, 0.13, 0.05], 0.4);
    if (season.name === 'AUTUMN') timber = toward([0.15, 0.085, 0.032], 0.62);
    if (season.name === 'WINTER') timber = toward([0.085, 0.075, 0.066], 0.8);
    const beach = world.style.beach ?? (world.hasOcean ? 10 : -1000);
    this.terrain.setStyle({
      grass,
      dry: shift(world.style.dry),
      rock: world.style.rock,  // bare rock doesn't change with the season
      snowLine: world.style.snowLine * season.snowScale,
      treeLine: world.style.treeLine,
      strata: world.style.strata,
    }, { beach, timber, farm: world.farmland ?? 0.8, stony: world.style.stony ?? 0, bluffs: world.style.bluffs ?? 0 });
    this.vegetation.setSeason(this.seasonIndex);
  }

  /**
   * Reshape the landscape. The chunk cache is dropped and rebuilt against the
   * new height field; the caller re-primes around the aircraft afterwards.
   */
  regenerate(seed = Math.floor(Math.random() * 1e6) + 1): number {
    setTerrainSeed(seed);
    this.terrain.regenerate();
    this.shallows.invalidate();
    this.clouds.groundChanged();
    this.refreshSettlements();
    return seed;
  }

  get seed(): number {
    return getTerrainSeed();
  }

  get timeOfDay(): string {
    return TIME_PRESETS[this.timeIndexValue].name;
  }

  get weather(): string {
    return WEATHER_PRESETS[this.weatherIndex].name;
  }

  get season(): string {
    return SEASON_PRESETS[this.seasonIndex].name;
  }

  /**
   * The nearest named hour to wherever the sun actually is.
   *
   * Measured the short way round the clock, so half past midnight is nearest
   * to the blue hour rather than to noon.
   */
  get timeIndexValue(): number {
    let best = 0;
    let gap = Infinity;
    for (let i = 0; i < PRESET_HOURS.length; i++) {
      // Circular distance: zero on the hour, twelve at the opposite hour.
      // Minimised directly — this used to minimise `12 - d`, which is
      // maximising it, so every reading came back as the name of the hour
      // furthest away and half past noon announced itself as the blue hour.
      const d = Math.abs(((this.clock - PRESET_HOURS[i] + 36) % 24) - 12);
      if (d < gap) { gap = d; best = i; }
    }
    return best;
  }
  get weatherIndexValue(): number {
    return this.weatherIndex;
  }
  get seasonIndexValue(): number {
    return this.seasonIndex;
  }

  /**
   * The far sheet's settings for one weather, with its altitude floored.
   *
   * The altitudes in the presets are absolute, which is right for a cloud base
   * and wrong for fog: six hundred metres is a valley in the Isles and solid
   * rock in the Alps, whose valley floors start at 1210 m. Lifting it to sit
   * just over this world's own ground level leaves every other preset exactly
   * where it was and puts the inversion in the valleys wherever it is flown.
   */
  private deckStyle(w: typeof WEATHER_PRESETS[number]): DeckStyle {
    return {
      coverage: w.deck,
      y: Math.max(w.deckY, fieldElevation() + 220),
      alpha: w.deckAlpha,
      streak: w.deckStreak,
      lift: w.deckLift,
    };
  }

  private applyAtmosphere(): void {
    const preset = sunAt(this.clock);
    const w = WEATHER_PRESETS[this.weatherIndex];
    const phi = THREE.MathUtils.degToRad(90 - preset.elevation);
    const theta = THREE.MathUtils.degToRad(preset.azimuth);
    this.sun.setFromSphericalCoords(1, phi, theta);
    this.sky.material.uniforms.sunPosition.value.copy(this.sun);

    const twilight = preset.twilight;
    const u = this.sky.material.uniforms;
    // Below the horizon Preetham is extrapolating, and left alone it returns a
    // muddy brown rather than the deep blue the hour is named for. Rayleigh is
    // the blue-scattering term, so pushing it up and the haze down recovers the
    // colour without needing a second sky model.
    u.turbidity.value = lerp(w.turbidity, 1.3, twilight);
    u.rayleigh.value = lerp(w.rayleigh, 8.0, twilight);
    // Mie is the forward-scattered glow around the sun. With the sun under the
    // horizon it only smears warm haze across a sky that should be going blue.
    u.mieCoefficient.value = lerp(0.005, 0.0016, twilight);

    // Low sun: dimmer, redder, and a warmer haze — the same reddening that makes
    // sunsets red, approximated rather than integrated.
    const high = smoothstep(0, 35, preset.elevation);
    // Past sunset the direct beam is gone and what is left is skylight: cool,
    // soft and from everywhere. Dimming the warm sun alone would just give a
    // dark orange scene, which is not what the blue hour looks like.
    this.sunLight.intensity = (0.5 + high * 1.95) * w.sun * (1 - twilight * 0.66);
    this.sunLight.color.setRGB(1.0, clamp(0.62 + high * 0.35, 0, 1), clamp(0.38 + high * 0.6, 0, 1));
    this.sunLight.color.lerp(TWILIGHT_LIGHT, twilight);

    // Skylight *rises* relative to the sun at blue hour rather than falling —
    // the sky is the light source once the sun is under, and scaling it down
    // with everything else left the landscape a silhouette.
    this.ambient.intensity = (0.16 + high * 0.34) * w.ambient * (1 + twilight * 1.9);
    this.ambient.color.copy(SKY_AMBIENT).lerp(TWILIGHT_AMBIENT, twilight);
    // The bounce off the ground goes cold too — left warm it lit the hills a
    // sickly green under a blue sky.
    this.ambient.groundColor.copy(GROUND_AMBIENT).lerp(TWILIGHT_GROUND, twilight);

    // Overcast and storm desaturate the haze toward grey as well as thickening it.
    const grey = smoothstep(1.0, 5.0, w.fog);
    this.fog.color.setRGB(
      lerp(clamp(0.52 + high * 0.14, 0, 1), 0.44, grey),
      lerp(clamp(0.50 + high * 0.26, 0, 1), 0.45, grey),
      lerp(clamp(0.52 + high * 0.33, 0, 1), 0.47, grey),
    );
    this.fog.color.lerp(TWILIGHT_FOG, twilight);
    this.fog.density = (0.0000185 + (1 - high) * 0.0000075) * w.fog;

    // The haze takes its two ends from the light that is already computed: the
    // warm one from the sun's own colour, the cool one from the sky's blue.
    setHaze(this.sun, this.fog.color, this.sunLight.color, twilight);

    // Stars only survive a clear sky, and only once the sun is under.
    this.twilight.setVisibility(twilight, w.cloud);

    this.clouds.setStyle(w.cloud, w.cloudScale, w.cloudDark, this.deckStyle(w));
    // Haze that knows how high it reaches. An inversion is not "more fog" —
    // it is the same murk pressed into the bottom six hundred metres, and the
    // scale height is the only number that says so.
    hazeUniforms.uHazeScale.value = w.hazeScale;
    // The other half of an inversion: the sheet is its top, this is everything
    // underneath. Tinted from the haze rather than a fixed white, so the fog
    // takes the colour of the hour — pink at dawn, blue before it.
    this._fogTint.copy(this.fog.color).lerp(WHITE_FOG, 0.55);
    setGroundFog(w.groundFog, this.deckStyle(w).y ?? 0, 260, this._fogTint,
      w.fogScale, w.fogPatch, w.fogSoft);
    // Bright enough to read as cloud after tone mapping, and only mildly
    // dimmed by weather — a deck is lit from above whatever the ground sees.
    // Clouds are lit by the sun, and at blue hour there is no sun. At the
    // daylight figure they stayed near-white — the brightest thing in a dark
    // frame, which is exactly backwards: they should be the dark shapes the
    // last of the sky shows through.
    const daylight = (0.4 + high * 1.0) * (1 - twilight * 0.78);
    const cloudTop = new THREE.Color(1, 0.98, 0.95)
      .lerp(this.sunLight.color, 0.35 + twilight * 0.45)
      .multiplyScalar(2.3 * daylight * (0.72 + 0.28 * w.sun) * w.cloudDark);
    const cloudBase = cloudTop.clone().multiplyScalar(0.42).lerp(new THREE.Color(0.42, 0.47, 0.58), 0.4);
    this.clouds.setLighting(this.sun, cloudTop, cloudBase);
    this.clouds.setFog(this.fog.color, this.fog.density);

    // Only when the sun has actually moved. A drifting day calls this several
    // times a second and the bake is the one part of it that costs anything.
    if (this.sun.distanceToSquared(this.bakedSun) > BAKE_STEP * BAKE_STEP) {
      this.bakedSun.copy(this.sun);
      this.bakeEnvironment();
    }
  }

  /**
   * Render the sky alone into a PMREM so aircraft and sea reflect the actual
   * sky they're under. Only re-run when the sun moves — it's not cheap.
   */
  private bakeEnvironment(): void {
    this.skyScene.add(this.sky);
    this.engine.updateEnvironmentFrom(this.skyScene);
    this.engine.scene.add(this.sky);
  }

  /** Build every chunk needed for the opening view before the first frame. */
  prime(focus: THREE.Vector3): void {
    this.terrain.update(focus, Infinity);
    // The depth map is normally filled a strip a frame; on a prime the world is
    // being set up all at once and there is no frame to spread it over, so it
    // is driven to completion here rather than fading in over the first second
    // of a flight.
    for (let i = 0; i < 64 && !this.shallows.complete; i++) this.shallows.update(focus);
    this.ocean.setShallows(this.shallows);
    this.vegetation.prime(focus);
  }

  applyQuality(preset: QualityPreset): void {
    this.quality = preset;
    this.vegetation.setDensity(preset.trees ?? 1);
    this.terrain.setCastShadows(preset.terrainShadows);
    this.clouds.setBudget(preset.cloudPuffs);
    const wq = WEATHER_PRESETS[this.weatherIndex];
    this.clouds.setStyle(wq.cloud, wq.cloudScale, wq.cloudDark, this.deckStyle(wq));

    const shadow = this.sunLight.shadow;
    if (shadow.mapSize.width !== preset.shadowMapSize) {
      shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
      // The existing shadow map is allocated at the old size; dropping it makes
      // three rebuild it at the new one.
      shadow.map?.dispose();
      shadow.map = null;
    }
  }

  update(dt: number, focus: THREE.Vector3): void {
    // The day, if it is running. `applyAtmosphere` is a few dozen colour
    // assignments; the expensive bake inside it throttles itself on how far
    // the sun has moved, so this is affordable every frame.
    if (this.driftRate > 0 && dt > 0) {
      this.clock = (this.clock + this.driftRate * dt) % 24;
      this.applyAtmosphere();
    }
    // Am I in it?
    //
    // Answered on the CPU from the same field the shaders use, at the camera's
    // own position, because this is the one thing no material can decide: the
    // sky is not fogged by anything, so being inside a bank has to be applied
    // to the finished frame.
    const w = WEATHER_PRESETS[this.weatherIndex];
    if (w.groundFog > 0) {
      const eye = this.engine.camera.position;
      const top = this.deckStyle(w).y ?? 0;
      const depth = 1 - smoothstep(top - 260, top + 40, eye.y);
      const lie = fogCover(eye.x, eye.z, w.fogScale, w.fogPatch, w.fogSoft);
      // Never the whole frame. Even in thick fog you can see the nose and a
      // little of what is straight ahead, and a solid wash is indistinguishable
      // from the renderer having failed.
      this.engine.postFX.setFogWash(depth * lie * w.groundFog * 0.88, this._fogTint);
    } else {
      this.engine.postFX.setFogWash(0, this._fogTint);
    }

    this.terrain.update(focus);
    this.vegetation.update(focus, dt);
    this.shallows.update(focus);
    this.ocean.setShallows(this.shallows);
    this.ocean.update(dt);
    // Keep the sea centred under the aircraft so its finite quad never runs out.
    this.ocean.mesh.position.x = focus.x;
    this.ocean.mesh.position.z = focus.z;

    this.clouds.update(this.engine.camera, dt);
    this.twilight.follow(focus);

    const weather = WEATHER_PRESETS[this.weatherIndex];
    this.storm.update(dt, weather.storm);
    // In winter the same falling water arrives as snow. Lightning is left
    // alone — thundersnow is a real thing, and a storm should still feel like
    // one.
    const snowing = this.seasonIndex === WINTER;
    this.engine.postFX.setWeatherFX(
      snowing ? 0 : weather.rain,
      this.storm.flash,
      snowing ? weather.rain : 0,
    );
    this.updateShadowFrustum(focus);
  }

  /**
   * Size and place the sun's shadow frustum.
   *
   * The extent tracks height above ground: down low a tight box gives crisp
   * shadows where you can actually see them, and climbing widens it so ridge
   * shadows stay in view instead of the box outrunning the terrain. The centre
   * is snapped to whole shadow-map texels — without that, sub-texel movement
   * makes every shadow edge crawl as the aircraft flies.
   */
  private updateShadowFrustum(focus: THREE.Vector3): void {
    const agl = Math.max(20, focus.y - terrainHeight(focus.x, focus.z));
    const range = clamp(agl * 2.0, 260, this.quality.shadowRange);

    const cam = this.sunLight.shadow.camera;
    if (cam.right !== range) {
      cam.left = -range;
      cam.right = range;
      cam.top = range;
      cam.bottom = -range;
      cam.far = range * 2 + 5000;
      cam.updateProjectionMatrix();
    }

    const texel = (range * 2) / this.quality.shadowMapSize;
    this._shadowFocus.set(
      Math.round(focus.x / texel) * texel,
      Math.round(focus.y / texel) * texel,
      Math.round(focus.z / texel) * texel,
    );

    this.sunLight.target.position.copy(this._shadowFocus);
    this.sunLight.target.updateMatrixWorld();
    this.sunLight.position.copy(this._shadowFocus).addScaledVector(this.sun, range + 2500);
  }
}
