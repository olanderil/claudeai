import * as THREE from 'three';
import { Engine } from './core/Engine';
import { Input } from './core/Input';
import { Loop } from './core/Loop';
import {
  World, TIME_PRESETS, WEATHER_PRESETS, SEASON_PRESETS, WORLD_PRESETS, DRIFT_RATES,
} from './world/World';
import { terrainHeight, groundHeight, spawnPoint, fieldElevation, activeWorld, SEA_LEVEL } from './world/Terrain';
import { FlightModel, HORNET } from './flight/FlightModel';
import { Controls, DEFAULT_SETTINGS, type FlightMode, type StickInput } from './flight/Controls';
import { Aircraft } from './flight/Aircraft';
import { Autopilot, type TourWorld } from './flight/Autopilot';
import { CameraRig, CAMERA_MODES, type FreeView } from './camera/CameraRig';
import { boats } from './world/Boats';
import { structures, structureHeight, structureRadius, turbineSpin } from './world/Structures';
import { balloons, balloonDrift } from './world/Balloons';
import { contrailTime } from './world/Contrails';
import { fogCover, FOG_GLSL } from './world/GroundFog';
import {
  shotCatalogue, DIRECTOR_STYLES, LANDMARK_TRIPOD,
  type ShotInfo, type ShotSlot, type Scale, type LandmarkTarget,
} from './camera/Cinematic';
import { HUD, type HudStatus, type HudMessage } from './ui/HUD';
import { Panel } from './ui/Panel';
import { Tips } from './ui/Tips';
import { Radio, STATIONS } from './audio/Radio';
import { airstrips, nearestAirstrip, settlements } from './world/Settlements';
import { pyramids } from './world/Landmarks';
import { citySites } from './world/City';
import { DEG, MS_TO_KT, RAD, angleDelta, clamp } from './util/math';
import { QUALITY_PRESETS, DEFAULT_QUALITY } from './render/Quality';

/** Physics rate. Fixed and high enough that the aero integration stays stable. */
const PHYSICS_HZ = 120;
/** Reused scratch for the current world's spawn point. */
const START_POSITION = new THREE.Vector3();
/** A stick nobody is holding — used to fly the attract-mode flight hands-off. */
const IDLE_STICK: StickInput = { pitch: 0, roll: 0, yaw: 0, throttleAxis: 0, brake: false };
/** Cruise speed and clearance for the attract flight. */
const INTRO_SPEED = 235;
const INTRO_CLEARANCE = 1800;
/** How far the director will look for something to frame the aircraft against. */
const LANDMARK_RANGE = 14000;
/**
 * How far off a landmark can be and still be offered to the camera, metres.
 *
 * Shorter than the city range, and deliberately. A skyline reads from fourteen
 * kilometres; a lighthouse you are meant to stand a tripod at does not, and
 * offering one from that far out only means the director keeps choosing shots
 * whose subject never arrives.
 */
const STRUCTURE_RANGE = 6000;
/** Frame rate and bitrate for a recording of the flight. */
const RECORD_FPS = 60;
const RECORD_BITRATE = 12_000_000;
/**
 * Recording formats, best first.
 *
 * H.264 in MP4 leads because it is the one that opens *anywhere* — QuickTime,
 * Photos, iMovie, Premiere, Windows, a phone — with no codec pack and no VLC.
 * WebM is a perfectly good file and is the wrong thing to hand someone who
 * wants to watch their flight or cut it into something.
 *
 * H.265 sits second: better compression, but playback is patchier (Windows
 * wants the HEVC extension), so it is a fallback rather than the default. Note
 * the fully-qualified codec string — Chrome rejects a bare `hvc1` and accepts
 * `hvc1.1.6.L93.B0`, which is the sort of thing that looks like "HEVC is not
 * supported" if you test it the obvious way.
 *
 * WebM last, for browsers whose MediaRecorder cannot write MP4 at all.
 */
const RECORD_FORMATS = [
  { mime: 'video/mp4;codecs=avc1.640028', extension: 'mp4', label: 'MP4 · H.264' },
  { mime: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4', label: 'MP4 · H.264' },
  { mime: 'video/mp4;codecs=hvc1.1.6.L93.B0', extension: 'mp4', label: 'MP4 · H.265' },
  { mime: 'video/mp4', extension: 'mp4', label: 'MP4' },
  { mime: 'video/webm;codecs=vp9', extension: 'webm', label: 'WebM · VP9' },
  { mime: 'video/webm', extension: 'webm', label: 'WebM' },
];
/** Least air left under the aircraft after N drops a new world beneath it. */
const NEW_WORLD_CLEARANCE = 400;

function boot(): void {
  const sceneCanvas = document.getElementById('scene') as HTMLCanvasElement;
  const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay') as HTMLDivElement;
  // Tells the stylesheet the script is running, so the help panel can be held
  // back until it is asked for. Without it the panel is the no-script fallback.
  overlay.classList.add('scripted');
  const chooseTour = document.getElementById('choose-tour') as HTMLButtonElement;
  const chooseManual = document.getElementById('choose-manual') as HTMLButtonElement;

  const shotLabel = document.getElementById('shot') as HTMLDivElement;

  /**
   * Capture: a still, or a recording of the flight.
   *
   * Both take the **scene canvas alone**. That is the whole trick and it is
   * free: the HUD is a second canvas and the tips, the panel and the shot label
   * are DOM, so a capture of `#scene` contains the 3D and nothing else. Trying
   * to hide the interface for the duration and put it back afterwards — the
   * obvious approach — would flash the UI on every screenshot and leave the
   * pilot flying blind through a recording.
   */
  /** Set from the dev hook to force an aperture; normally the shot decides. */
  let dofOverride: number | null = null;
  let depthOfField = true;
  let wasAirborne = false;
  const sunDirection = new THREE.Vector3(0.4, 0.5, 0.3);
  const landmarkPoint = new THREE.Vector3();

  /**
   * Remember the free camera's saved views between sessions.
   *
   * `localStorage` and nothing else: the build is one file opened from disk, so
   * there is nowhere else to put this, and a failure to read or write it must
   * never stop the sim starting.
   */
  const VIEWS_KEY = 'horizon-f18.free-views';

  function saveFreeViews(): void {
    try {
      window.localStorage.setItem(VIEWS_KEY, JSON.stringify(rig.savedViews));
    } catch {
      // Private browsing, a full quota, a file:// policy — none of it matters
      // enough to interrupt a flight over.
    }
  }

  const TWEAKS_KEY = 'horizon-f18.shot-tweaks';

  /**
   * Throw away the shot adjustments an earlier session left behind.
   *
   * The library used to be saved and restored wholesale, so a drag made once
   * followed the shot for ever: months later the cinematic camera was still
   * playing somebody's half-finished experiment, and there was no way back to
   * the shots as written short of resetting every one of them by hand. The
   * slots are where a customised shot is supposed to live — they carry their
   * own copy of the adjustment, so nothing is lost by starting clean.
   *
   * The key is removed rather than ignored, so a session that has run this
   * leaves nothing for a future version to trip over.
   */
  function clearStoredShotTweaks(): void {
    try {
      window.localStorage.removeItem(TWEAKS_KEY);
    } catch {
      // Private-mode storage. Nothing was loaded either way.
    }
  }

  // The saved shots and the chosen pace travel together: they are both "how I
  // like the director", and one key keeps them from disagreeing.
  const DIRECTOR_KEY = 'horizon-f18.director';

  function saveDirector(): void {
    try {
      // What survives a session: the saved shots, the order they play in, the
      // orbit camera's own framing, and whether a held shot loops. Not the
      // pace, and not the adjustments made to the library's shots — those start
      // where they were written, every time.
      window.localStorage.setItem(DIRECTOR_KEY, JSON.stringify({
        loop: rig.shotLoops, slots: rig.shotSlots, reel: rig.reelOrder,
        orbit: rig.orbit,
      }));
    } catch {
      // Same reasoning as the saved views: never worth interrupting a flight.
    }
  }

  function loadDirector(): void {
    try {
      const raw = window.localStorage.getItem(DIRECTOR_KEY);
      if (raw === null) return;
      const parsed = JSON.parse(raw) as {
        loop?: unknown; slots?: unknown; reel?: unknown; orbit?: unknown;
      };
      // The pace is deliberately not restored, and no longer written. It is the
      // other half of "my shots are not how they were shipped": Kinetic set once
      // in the director came back in the cinematic view every session
      // afterwards, and every shot in the library played to it. It costs one
      // click to set and a session to notice, so it starts at Standard.
      if (typeof parsed.loop === 'boolean') rig.setShotLooping(parsed.loop);
      if (Array.isArray(parsed.slots)) rig.loadShotSlots(parsed.slots as (ShotSlot | null)[]);
      if (Array.isArray(parsed.reel)) rig.setReelOrder(parsed.reel as number[]);
      // Every field optional and every value clamped inside `setOrbit`: a file
      // written before the orbit was adjustable simply has none of them.
      const orbit = parsed.orbit as Record<string, unknown> | undefined;
      if (orbit !== null && typeof orbit === 'object') {
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        rig.setOrbit({
          distance: num(orbit.distance), height: num(orbit.height),
          rate: num(orbit.rate), direction: num(orbit.direction),
        });
      }
    } catch {
      // Corrupt: the shots as written and nine empty slots are a fine start.
    }
  }

  function loadFreeViews(): void {
    try {
      const raw = window.localStorage.getItem(VIEWS_KEY);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) rig.loadFreeViews(parsed as FreeView[]);
    } catch {
      // Corrupt or unreadable: the four defaults are perfectly good.
    }
  }

  /**
   * The nearest thing worth framing the aircraft against, or null.
   *
   * Cities first — a skyline behind a jet is the shot — then the villages,
   * which at least give the eye something to read scale from.
   */
  function nearestLandmark(from: THREE.Vector3): THREE.Vector3 | null {
    let best: { x: number; z: number } | null = null;
    let bestD = LANDMARK_RANGE;
    for (const c of citySites()) {
      const d = Math.hypot(c.x - from.x, c.z - from.z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best === null) {
      for (const v of settlements()) {
        const d = Math.hypot(v.x - from.x, v.z - from.z);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
    }
    return best === null ? null : landmarkPoint.set(best.x, 0, best.z);
  }

  /**
   * The nearest landmark *structure*, with enough about it to stand a camera on.
   *
   * Kept apart from `nearestLandmark` on purpose. That one answers "what is
   * worth putting behind the aeroplane", and a city skyline is the best answer
   * there is to that. This one answers a different question — "is there
   * something out there a camera operator could have climbed" — and a city is
   * no use for it at all. Merging them would make each shot take whichever
   * happened to be closer, which is how you get a tripod planted in a suburb.
   */
  function nearestStructure(from: THREE.Vector3): LandmarkTarget | null {
    let best: LandmarkTarget | null = null;
    let bestD = STRUCTURE_RANGE;
    for (const st of structures()) {
      const d = Math.hypot(st.x - from.x, st.z - from.z);
      if (d >= bestD) continue;
      bestD = d;
      best = { x: st.x, y: st.y, z: st.z, height: structureHeight(st),
        radius: structureRadius(st), kind: st.kind };
    }
    return best;
  }
  let pendingShot = false;
  let recorder: MediaRecorder | null = null;
  let recordedChunks: Blob[] = [];
  let recordFormat = RECORD_FORMATS[RECORD_FORMATS.length - 1];

  /** Offer a captured file to the browser's downloads. */
  function saveCapture(blob: Blob, extension: string): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `horizon-f18-${activeWorld().name.toLowerCase().replace(/ /g, '-')}-${stamp}`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.${extension}`;
    link.click();
    // Freeing it immediately cancels the download in some browsers; a turn of
    // the event loop is enough.
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // --- Radio -----------------------------------------------------------------
  //
  // The one part of the sim that reaches the network, and only when asked: the
  // panel is built from the station table but nothing is fetched until a
  // station is clicked.
  const RADIO_KEY = 'horizon-f18.radio';
  const savedRadio = ((): { station?: number; volume?: number; playing?: boolean } => {
    try {
      return JSON.parse(window.localStorage.getItem(RADIO_KEY) ?? '{}') as
        { station?: number; volume?: number; playing?: boolean };
    } catch {
      return {};
    }
  })();
  const radio = new Radio(typeof savedRadio.volume === 'number' ? savedRadio.volume : 0.5);
  const radioButton = document.getElementById('radio') as HTMLButtonElement;
  const radioPanel = document.getElementById('radio-panel') as HTMLDivElement;
  const radioStatus = document.getElementById('radio-status') as HTMLElement;
  const radioStations = document.getElementById('radio-stations') as HTMLDivElement;
  const radioVolume = document.getElementById('radio-volume') as HTMLInputElement;
  const radioVolumeValue = document.getElementById('radio-volume-value') as HTMLElement;
  const radioRows: HTMLButtonElement[] = [];

  for (const [index, station] of STATIONS.entries()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'radio-station';
    const name = document.createElement('span');
    name.textContent = station.name;
    const blurb = document.createElement('span');
    blurb.className = 'blurb';
    blurb.textContent = station.blurb;
    row.append(name, blurb);
    row.addEventListener('click', () => {
      row.blur();
      // Clicking what is already playing stops it — the row is the transport.
      if (radio.station === index && radio.playing) radio.toggle();
      else radio.select(index);
      // `toggle` and `select` both settle asynchronously; save on the next turn
      // so `playing` records where it ended up rather than where it started.
      window.setTimeout(saveRadio, 0);
    });
    radioRows.push(row);
    radioStations.append(row);
  }

  function saveRadio(): void {
    try {
      window.localStorage.setItem(RADIO_KEY, JSON.stringify(
        { station: radio.station, volume: radio.volume, playing: radio.playing }));
    } catch {
      // Same as every other setting: not worth interrupting a flight over.
    }
  }

  function syncRadio(): void {
    const state = radio.status;
    radioStatus.textContent = state === 'playing' ? radio.label
      : state === 'tuning' ? 'Tuning…'
        : state === 'error' ? 'No signal' : 'Off';
    radioStatus.classList.toggle('on', state === 'playing' || state === 'tuning');
    radioStatus.classList.toggle('bad', state === 'error');
    radioButton.classList.toggle('on', radio.playing);
    radioRows.forEach((row, i) => {
      row.classList.toggle('current', radio.station === i && radio.playing);
    });
    radioVolume.value = String(radio.volume);
    radioVolumeValue.textContent = `${Math.round(radio.volume * 100)}%`;
  }
  radio.onChange(syncRadio);

  radioButton?.addEventListener('click', () => {
    radioButton.blur();
    radioPanel.hidden = !radioPanel.hidden;
    radioButton.setAttribute('aria-expanded', String(!radioPanel.hidden));
    if (!radioPanel.hidden) syncRadio();
  });
  radioVolume?.addEventListener('input', () => {
    radio.setVolume(Number(radioVolume.value));
    radioVolumeValue.textContent = `${Math.round(radio.volume * 100)}%`;
    saveRadio();
  });
  (document.getElementById('radio-file') as HTMLInputElement)?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file !== undefined) radio.useFile(file);
  });
  window.addEventListener('pointerdown', (e) => {
    if (radioPanel.hidden) return;
    const target = e.target as Node;
    if (radioPanel.contains(target) || radioButton.contains(target)) return;
    radioPanel.hidden = true;
    radioButton.setAttribute('aria-expanded', 'false');
  });
  syncRadio();

  const screenshotButton = document.getElementById('screenshot') as HTMLButtonElement;
  screenshotButton?.addEventListener('click', () => {
    pendingShot = true;
    screenshotButton.blur();
  });

  const recordButton = document.getElementById('record') as HTMLButtonElement;
  recordButton?.addEventListener('click', () => {
    recordButton.blur();
    if (recorder !== null) {
      recorder.stop();
      return;
    }
    // `captureStream` on the scene canvas gives exactly what is drawn there,
    // which is why nothing has to be hidden.
    const stream = sceneCanvas.captureStream?.(RECORD_FPS);
    if (stream === undefined || typeof MediaRecorder === 'undefined') {
      notify('RECORDING UNAVAILABLE', 'this browser has no MediaRecorder', 3.5);
      return;
    }
    const type = RECORD_FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mime));
    recordedChunks = [];
    recorder = new MediaRecorder(stream, type === undefined
      ? undefined
      : { mimeType: type.mime, videoBitsPerSecond: RECORD_BITRATE });
    recordFormat = type ?? { mime: 'video/webm', extension: 'webm', label: 'WebM' };
    recorder.ondataavailable = (e): void => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    recorder.onstop = (): void => {
      saveCapture(new Blob(recordedChunks, { type: recordFormat.mime }), recordFormat.extension);
      recordedChunks = [];
      recorder = null;
      recordButton.classList.remove('recording');
      notify('RECORDING SAVED', recordFormat.label, 2.5);
    };
    recorder.start(1000);
    recordButton.classList.add('recording');
    notify('RECORDING', `${recordFormat.label} — click again to stop`, 2.5);
  });

  // Fullscreen. The class on the body is what flips the icon —
  // `fullscreenchange` rather than the click, so leaving with Escape or F11
  // keeps the icon honest.
  const fullscreenButton = document.getElementById('fullscreen') as HTMLButtonElement;
  fullscreenButton?.addEventListener('click', () => {
    // Both calls return promises that reject if the browser declines — Safari
    // in particular — and an unhandled rejection in a click handler is a
    // console error for something the user simply cannot have.
    const request = document.fullscreenElement === null
      ? document.documentElement.requestFullscreen?.()
      : document.exitFullscreen?.();
    request?.catch(() => undefined);
    fullscreenButton.blur(); // or the next Space would press it again
  });
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('fullscreen', document.fullscreenElement !== null);
  });

  const engine = new Engine(sceneCanvas);
  const world = new World(engine);

  // Ground includes the carrier deck, so landing on the ship needs no special case.
  const model = new FlightModel(HORNET, groundHeight);
  const controls = new Controls(HORNET);
  const aircraft = new Aircraft(HORNET.gearHeight);
  // The rig samples the ground so the cinematic camera cannot end up inside a hill.
  // The camera's floor is the ground *or the water*, whichever is higher.
  //
  // `groundHeight` is the terrain, and over the sea the terrain is metres below
  // the surface — so the clamp that keeps a camera out of a hillside happily
  // put it under water. Measured, a planted shot over deep water sat at −175 m
  // with the lens pointed up: from there the ocean plane covers the entire sky,
  // and its far reaches are exactly the fragments that fight the sky for depth.
  // Nothing wants a camera underwater in any case.
  const cameraFloor = (x: number, z: number): number =>
    Math.max(groundHeight(x, z), SEA_LEVEL);
  const rig = new CameraRig(engine.camera, cameraFloor);
  // --- The director bar ------------------------------------------------------
  //
  // Every control here goes through the same call its keyboard shortcut does,
  // so a click and a key press cannot drift apart. `blur` on each, or the next
  // Space would press whichever button was clicked last instead of opening the
  // Style panel.
  const directorBar = document.getElementById('director-bar') as HTMLDivElement;
  const shotNameButton = document.getElementById('shot-name') as HTMLButtonElement;
  const shotNameText = document.getElementById('shot-name-text') as HTMLSpanElement;
  const shotMenu = document.getElementById('shot-menu') as HTMLDivElement;
  const pinButton = document.getElementById('shot-pin') as HTMLButtonElement;
  const pinLabel = document.getElementById('shot-pin-label') as HTMLSpanElement;
  const helpButton = document.getElementById('shot-help') as HTMLButtonElement;
  const shotKeys = document.getElementById('shot-keys') as HTMLDivElement;
  const shapeButton = document.getElementById('shot-shape-open') as HTMLButtonElement;
  const shotShape = document.getElementById('shot-shape') as HTMLDivElement;
  const styleRow = document.getElementById('shot-styles') as HTMLDivElement;
  const holdSlider = document.getElementById('shot-hold') as HTMLInputElement;
  const travelSlider = document.getElementById('shot-travel') as HTMLInputElement;
  const holdValue = document.getElementById('shot-hold-value') as HTMLElement;
  const travelValue = document.getElementById('shot-travel-value') as HTMLElement;
  const loopButton = document.getElementById('shot-loop') as HTMLButtonElement;
  const reverseButton = document.getElementById('shot-reverse') as HTMLButtonElement;
  const shapeScope = document.getElementById('shot-scope') as HTMLElement;
  const paceStyleRow = document.getElementById('pace-styles') as HTMLDivElement;
  const tourSpeedRow = document.getElementById('tour-speeds') as HTMLDivElement;
  const freeSlotRow = document.getElementById('free-slots') as HTMLDivElement;
  const freeStore = document.getElementById('free-store') as HTMLButtonElement;
  const freeReframe = document.getElementById('free-reframe') as HTMLButtonElement;
  const freeLock = document.getElementById('free-lock') as HTMLButtonElement;
  const freeLockLabel = document.getElementById('free-lock-label') as HTMLElement;
  const orbitDirection = document.getElementById('orbit-direction') as HTMLButtonElement;
  const orbitDirectionLabel = document.getElementById('orbit-direction-label') as HTMLElement;
  const orbitDistance = document.getElementById('orbit-distance') as HTMLInputElement;
  const orbitHeight = document.getElementById('orbit-height') as HTMLInputElement;
  const orbitRate = document.getElementById('orbit-rate') as HTMLInputElement;
  const orbitDistanceValue = document.getElementById('orbit-distance-value') as HTMLElement;
  const orbitHeightValue = document.getElementById('orbit-height-value') as HTMLElement;
  const orbitRateValue = document.getElementById('orbit-rate-value') as HTMLElement;
  const notice = document.getElementById('notice') as HTMLDivElement;
  const noticeText = document.getElementById('notice-text') as HTMLElement;
  const noticeSub = document.getElementById('notice-sub') as HTMLElement;
  const paceHold = document.getElementById('pace-hold') as HTMLInputElement;
  const paceTravel = document.getElementById('pace-travel') as HTMLInputElement;
  const paceHoldValue = document.getElementById('pace-hold-value') as HTMLElement;
  const paceTravelValue = document.getElementById('pace-travel-value') as HTMLElement;
  const slotRow = document.getElementById('shot-slots') as HTMLDivElement;
  const storeButton = document.getElementById('shot-store') as HTMLButtonElement;
  const reelStrip = document.getElementById('reel-strip') as HTMLDivElement;
  const reelPlay = document.getElementById('reel-play') as HTMLButtonElement;
  const reelNote = document.getElementById('reel-note') as HTMLElement;
  const slotsBlock = document.getElementById('shot-slots-block') as HTMLDivElement;
  const slotButtons: HTMLButtonElement[] = [];
  /**
   * When a dragged orbit setting should be written out, or 0 for nothing
   * pending. A drag arrives as one small change per frame; saving each would be
   * hundreds of writes for one gesture.
   */
  let orbitSaveDue = 0;
  const ORBIT_SAVE_DELAY_MS = 600;

  /** The slot Save will write to, or -1 when none has been picked. */
  let picked = -1;
  /**
   * The slot whose contents are actually on screen, or -1.
   *
   * Not "every slot holding a shot of this name", which is what the highlight
   * used to mean: the sliders pin the shot while they are open, so saving three
   * times in a row stores the same setup three times, and all three lit up at
   * once. Three glowing buttons read as three selected slots — and as one save
   * having gone into all of them.
   */
  let activeSlot = -1;
  /** True while a reel chip is being dragged, so the strip is not rebuilt. */
  let draggingChip = false;
  const shotTransport = document.getElementById('shot-transport') as HTMLDivElement;
  const slotChips = new Map<string, HTMLSpanElement>();
  const menuEntries = new Map<string, HTMLButtonElement>();

  for (const [id, direction] of [['shot-prev', -1], ['shot-next', 1]] as const) {
    const button = document.getElementById(id) as HTMLButtonElement;
    button?.addEventListener('click', () => {
      button.blur();
      rig.stepShot(direction);
    });
  }
  pinButton?.addEventListener('click', () => {
    pinButton.blur();
    notify(rig.pinShot() ? 'SHOT PINNED' : 'DIRECTOR RUNNING', undefined, 2);
  });

  /**
   * What to say about a shot in one word.
   *
   * All of it is derived from the shot's own numbers, so the label cannot come
   * to disagree with what the shot does. Where a shot is more than one of
   * these, the rarer, more distinctive fact wins: "backlit" tells you more than
   * "pull out" does.
   */
  const shotMark = (s: ShotInfo): string =>
    s.framing === 'sun' ? 'backlit'
      : s.framing === 'landmark' ? 'landmark'
        : s.locked ? 'planted'
          : s.move === 'in' ? 'push in'
            : s.move === 'out' ? 'pull out'
              : 'hold';

  // Grouped by scale: it is what the director itself sequences by, and it is
  // the one grouping that answers the question someone opening this list is
  // actually asking — how close do you want to be?
  const SCALE_GROUPS: [Scale, string][] = [
    ['wide', 'Wide · the landscape'],
    ['medium', 'Medium · the aircraft'],
    ['close', 'Close · the detail'],
  ];

  // Built from the library rather than written out in the markup, so a shot
  // added to `Cinematic.ts` turns up here without anyone maintaining a list.
  for (const [scale, title] of SCALE_GROUPS) {
    const group = document.createElement('div');
    group.className = 'menu-group';
    const heading = document.createElement('h4');
    heading.textContent = title;
    group.append(heading);
    for (const shot of shotCatalogue().filter((s) => s.scale === scale)) {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'menu-shot';
      const name = document.createElement('span');
      name.textContent = shot.name;
      const mark = document.createElement('span');
      mark.className = 'menu-mark';
      mark.textContent = shotMark(shot);
      // The slot chip is written by `markSlots` and stays empty until the shot
      // is saved to one, so the list doubles as the map of what 1-9 will do.
      const chip = document.createElement('span');
      chip.className = 'menu-slot';
      chip.hidden = true;
      slotChips.set(shot.name, chip);
      entry.append(name, chip, mark);
      entry.addEventListener('click', () => {
        entry.blur();
        // The landmark tripod is the one entry that can decline: it needs
        // something in the world to stand on. Leaving the list open says so
        // more clearly than closing it over a camera that did not move.
        if (!rig.forceShot(shot.name)) return;
        showShotMenu(false);
      });
      menuEntries.set(shot.name, entry);
      group.append(entry);
    }
    shotMenu.append(group);
  }

  // --- The cinematic bar's inline pace ---------------------------------------
  //
  // The same three controls as the director's panel, laid along the bar. They
  // are separate elements rather than the panel's moved about: two small sets
  // kept in step by one sync is less to go wrong than one set relocated
  // whenever the camera changes.
  for (const [index, style] of DIRECTOR_STYLES.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = style.name;
    button.addEventListener('click', () => {
      button.blur();
      rig.setDirectorStyle(index);
      saveDirector();
      syncPace();
    });
    paceStyleRow.append(button);
  }
  paceHold?.addEventListener('input', () => {
    rig.setDirectorPace(Number(paceHold.value), rig.directorPace.travel);
    saveDirector();
    syncPace();
  });
  paceTravel?.addEventListener('input', () => {
    rig.setDirectorPace(rig.directorPace.hold, Number(paceTravel.value));
    saveDirector();
    syncPace();
  });

  /** What the bar last showed, so the DOM is only touched when it changes. */
  let paceShown = '';

  function syncPace(): void {
    const { hold, travel } = rig.directorPace;
    const seconds = rig.shotSeconds;
    const active = rig.directorStyle;
    const key = `${hold}|${travel}|${seconds.toFixed(1)}|${active}`;
    if (key === paceShown) return;
    paceShown = key;
    paceHold.value = String(hold);
    paceTravel.value = String(travel);
    paceHoldValue.textContent = `${hold.toFixed(2)}× · ${seconds.toFixed(1)} s`;
    paceTravelValue.textContent = travel < 0.02 ? 'still' : `${travel.toFixed(2)}×`;
    paceStyleRow.childNodes.forEach((node, i) => {
      (node as HTMLButtonElement).classList.toggle('active', i === active);
    });
  }

  // --- Pace and travel -------------------------------------------------------
  //
  // Two sliders rather than three, and deliberately not "speed": a shot is a
  // move across a duration, so speed is travel ÷ hold, and offering all three
  // would give three controls that silently move each other.
  for (const [index, style] of DIRECTOR_STYLES.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = style.name;
    button.addEventListener('click', () => {
      button.blur();
      rig.setDirectorStyle(index);
      saveDirector();
      syncShape();
    });
    styleRow.append(button);
  }
  // In the director the sliders belong to the shot that is playing, which is
  // held still while you work on it. The cinematic camera has no such thing —
  // it cuts on its own and is meant to — so there the same two sliders drive
  // the pace itself and apply to every shot.
  const perShot = (): boolean => rig.mode === 'director';
  holdSlider?.addEventListener('input', () => {
    const value = Number(holdSlider.value);
    if (perShot()) {
      rig.setShotHold(value);
    } else {
      rig.setDirectorPace(value, rig.directorPace.travel);
      saveDirector();
    }
    syncShape();
  });
  travelSlider?.addEventListener('input', () => {
    const value = Number(travelSlider.value);
    if (perShot()) {
      rig.setShotTravel(value);
    } else {
      rig.setDirectorPace(rig.directorPace.hold, value);
      saveDirector();
    }
    syncShape();
  });
  document.getElementById('shot-reset')?.addEventListener('click', (e) => {
    (e.currentTarget as HTMLButtonElement).blur();
    rig.resetShot();
    syncShape();
  });
  document.getElementById('shot-replay')?.addEventListener('click', (e) => {
    (e.currentTarget as HTMLButtonElement).blur();
    rig.replayShot();
  });
  loopButton?.addEventListener('click', () => {
    loopButton.blur();
    rig.setShotLooping(!rig.shotLoops);
    saveDirector();
    syncShape();
  });
  reverseButton?.addEventListener('click', () => {
    reverseButton.blur();
    rig.setShotReversed(!rig.shotReversed);
    // Take effect on what is on screen rather than at the next cut: the point
    // of the switch is to see the shot the other way round.
    rig.replayShot();
    saveDirector();
    syncShape();
  });

  // --- Saved shots, and the reel made of them --------------------------------
  //
  // Nine slots. Clicking one recalls it; clicking an *empty* one saves into it,
  // because there is nothing else it could sensibly do; and Save arms an
  // overwrite so a filled slot can be replaced without reaching for the
  // keyboard. Shift+number does the same thing directly, as it always has.
  for (let index = 0; index < 9; index++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot-button';
    button.textContent = String(index + 1);
    button.addEventListener('click', () => {
      button.blur();
      // Picking a slot is one thing and writing to it is another: a click
      // chooses the slot Save will write to, and recalls it if there is
      // something in it. The pick survives everything you do afterwards, which
      // is the point — frame the shot, then press Save.
      picked = index;
      const recalled = rig.recallShotSlot(index);
      activeSlot = recalled === null ? -1 : index;
      if (recalled !== null) notify(`SHOT ${index + 1}`, recalled.shot, 1.6);
      saveDirector();
      markSlots();
      syncShape();
    });
    slotButtons.push(button);
    slotRow.append(button);
  }

  storeButton?.addEventListener('click', () => {
    storeButton.blur();
    if (picked < 0) return;
    rig.storeShotSlot(picked);
    activeSlot = picked;
    notify(`SHOT ${picked + 1} SAVED`, rig.shotName ?? undefined, 2);
    saveDirector();
    markSlots();
    syncShape();
  });

  reelPlay?.addEventListener('click', () => {
    reelPlay.blur();
    if (rig.reelPlaying) {
      rig.stopReel();
      notify('REEL STOPPED', 'the director has the camera again', 2);
    } else {
      const count = rig.playReel();
      if (count === 0) notify('REEL EMPTY', 'save a shot to a number first', 2.5);
      else notify('REEL', `${count} setups in order`, 2);
    }
    syncShape();
  });

  /**
   * The running order, as draggable chips.
   *
   * Rebuilt from the order rather than mutated in place: nine chips is nothing
   * to rebuild, and a drag that reorders an array and then re-renders cannot
   * get the two out of step.
   */
  function renderReel(): void {
    // Rebuilding mid-drag would throw away the preview the drag is producing.
    if (draggingChip) return;
    reelStrip.textContent = '';
    const order = rig.reelOrder;
    if (order.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'menu-mark';
      empty.textContent = 'nothing saved yet';
      reelStrip.append(empty);
      return;
    }
    const playingAt = rig.reelPlaying ? rig.reelPosition.split('/')[0] : '';
    order.forEach((slot, position) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reel-chip';
      chip.textContent = String(slot + 1);
      chip.title = `${rig.shotSlots[slot]?.shot ?? ''} — drag to reorder, click to drop`;
      if (String(position + 1) === playingAt) chip.classList.add('playing');
      chip.addEventListener('click', (e) => {
        // A click that followed a drag is the end of the drag, not a click.
        if (chip.dataset.dragged === '1') { delete chip.dataset.dragged; return; }
        (e.currentTarget as HTMLButtonElement).blur();
        rig.setReelOrder(order.filter((_, i) => i !== position));
        saveDirector();
        syncShape();
      });
      chip.addEventListener('pointerdown', (e) => startChipDrag(e, chip, position));
      reelStrip.append(chip);
    });
  }

  /**
   * Drag a chip along the strip.
   *
   * The order is rearranged *as you drag* — the chip is moved in the DOM and
   * the working order with it — so what you see while the pointer is down is
   * the order you will get when you let go. Deciding the drop silently and
   * applying it afterwards made you drag, release, look, and try again.
   */
  function startChipDrag(e: PointerEvent, chip: HTMLButtonElement, from: number): void {
    e.preventDefault();
    const order = [...rig.reelOrder];
    let at = from;
    draggingChip = true;
    chip.classList.add('dragging');

    const move = (ev: PointerEvent): void => {
      const chips = [...reelStrip.children] as HTMLElement[];
      const over = chips.findIndex((c) => {
        const b = c.getBoundingClientRect();
        return ev.clientX >= b.left && ev.clientX <= b.right;
      });
      if (over < 0 || over === at) return;
      // Move the node and the order together, so the preview and the result
      // cannot disagree.
      const [moved] = order.splice(at, 1);
      order.splice(over, 0, moved);
      const before = chips[over > at ? over + 1 : over] ?? null;
      reelStrip.insertBefore(chip, before);
      at = over;
      chip.dataset.dragged = '1';
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      chip.classList.remove('dragging');
      draggingChip = false;
      if (at !== from) {
        rig.setReelOrder(order);
        saveDirector();
      }
      syncShape();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Put the sliders where the thing they are pointed at actually is. */
  function syncShape(): void {
    const shot = perShot();
    const t = shot ? rig.shotTweak : rig.directorPace;
    holdSlider.value = String(t.hold);
    travelSlider.value = String(t.travel);
    holdValue.textContent = `${t.hold.toFixed(2)}× · ${rig.shotSeconds.toFixed(1)} s`;
    travelValue.textContent = t.travel < 0.02 ? 'still' : `${t.travel.toFixed(2)}×`;
    shapeScope.textContent = shot ? 'This shot' : 'All shots';
    // Replay, loop and reset act on one shot, and the cinematic camera does not
    // stay on one long enough for any of them to mean anything. Nor do the
    // slots and the reel: they are the director's, on its number keys.
    shotTransport.hidden = !shot;
    slotsBlock.hidden = !shot;
    if (shot) {
      const playing = rig.reelPlaying;
      reelPlay.textContent = playing ? 'Stop' : 'Play';
      reelPlay.setAttribute('aria-pressed', String(playing));
      const filled = rig.filledSlots;
      slotButtons.forEach((b, i) => {
        b.classList.toggle('filled', filled[i]);
        b.classList.toggle('picked', i === picked);
        // At most one, ever: the slot that was actually recalled or written,
        // and only while what it holds is still what is on screen.
        b.classList.toggle('current', !playing && i === activeSlot && filled[i]
          && rig.shotSlots[i]?.shot === rig.shotName);
      });
      storeButton.disabled = picked < 0;
      storeButton.title = picked < 0
        ? 'Pick a slot below first, then save into it'
        : `Save the running shot into slot ${picked + 1}`;
      renderReel();
      reelNote.textContent = playing
        ? `Playing ${rig.reelPosition} — the director has the camera back when you stop.`
        : picked < 0
          ? 'Pick a number, then Save. Shift+number saves straight away.'
          : `Save writes into ${picked + 1}. Drag the chips to reorder, click one to drop it.`;
    }
    loopButton.setAttribute('aria-pressed', String(rig.shotLoops));
    reverseButton.setAttribute('aria-pressed', String(rig.shotReversed));
    const active = rig.directorStyle;
    styleRow.childNodes.forEach((node, i) => {
      (node as HTMLButtonElement).classList.toggle('active', i === active);
    });
  }

  /** Show which shots are on which number key. */
  function markSlots(): void {
    // Filling a slot or dropping a chip can add a row, and the list above has
    // to move with it.
    if (!shotShape.hidden) requestAnimationFrame(liftShotMenu);
    for (const chip of slotChips.values()) {
      chip.hidden = true;
      chip.textContent = '';
    }
    rig.shotSlots.forEach((slot, i) => {
      if (slot === null) return;
      const chip = slotChips.get(slot.shot);
      // A shot can be in more than one slot; the lowest number is the one to
      // show, because it is the one someone will reach for.
      if (chip === undefined || !chip.hidden) return;
      chip.textContent = String(i + 1);
      chip.hidden = false;
    });
  }

  /**
   * Three popovers hang off this bar, and which of them may share the screen is
   * a question of where they sit.
   *
   * The key list and the shot editor both hang off the bar's right edge, in the
   * same slot, so those two exclude each other. The shot list is centred and
   * stacks *above* the editor — picking a shot and then tuning it is one job,
   * and closing the editor to choose what to edit meant reopening it every
   * time, and losing the pin with it.
   */
  function showShotMenu(open: boolean): void {
    shotMenu.hidden = !open;
    shotNameButton.setAttribute('aria-expanded', String(open));
    if (open) {
      showShotKeys(false);
      // Checked as the list opens rather than every frame: whether there is a
      // landmark within reach changes on the scale of a minute's flying, and
      // the only moment the answer is looked at is now.
      const tripod = menuEntries.get(LANDMARK_TRIPOD);
      if (tripod !== undefined) {
        const ready = rig.landmarkTripodReady();
        tripod.disabled = !ready;
        tripod.title = ready ? '' : 'No landmark within reach';
      }
    }
    liftShotMenu();
  }
  function showShotKeys(open: boolean): void {
    shotKeys.hidden = !open;
    helpButton.setAttribute('aria-expanded', String(open));
    if (open) {
      showShotMenu(false);
      showShotShape(false);
    }
  }

  /**
   * Tell the stylesheet how tall the editor is, so the list can clear it.
   *
   * Measured rather than assumed: the panel is three columns on a desktop and
   * one on a phone, and the reel grows a row as slots are filled, so its height
   * is not a number that can be written down.
   */
  function liftShotMenu(): void {
    const style = document.documentElement.style;
    if (shotShape.hidden) {
      style.removeProperty('--shot-menu-bottom');
      return;
    }
    // Where the editor's top edge actually is, plus a gap. Derived from the
    // rectangle rather than from a height added to a constant: the two panels
    // are anchored to different things, so their offsets do not share an origin.
    const top = shotShape.getBoundingClientRect().top;
    style.setProperty('--shot-menu-bottom', `${Math.round(window.innerHeight - top + 10)}px`);
  }
  function showShotShape(open: boolean): void {
    shotShape.hidden = !open;
    shapeButton.setAttribute('aria-expanded', String(open));
    if (open) {
      // In the director, opening these holds the shot. The sliders belong to
      // whatever is playing, and measured with the sequence running they were
      // unusable: it cuts every few seconds, so an adjustment landed on the
      // shot you *were* watching and the sliders sprang back to the new one.
      // The cinematic camera is not pinned — there the sliders are the pace and
      // apply to everything, so there is nothing to hold still.
      if (rig.mode === 'director') rig.setShotPinned(true);
      syncShape();
      showShotKeys(false);
    }
    // After `hidden` is set and the panel has been laid out, so the height is
    // the one the list has to clear.
    liftShotMenu();
  }
  // The editor refolds from three columns to one as the window narrows, so its
  // height — and the room the list has above it — is a function of the viewport.
  window.addEventListener('resize', liftShotMenu);

  shapeButton?.addEventListener('click', () => {
    shapeButton.blur();
    showShotShape(shotShape.hidden);
  });
  shotNameButton?.addEventListener('click', () => {
    shotNameButton.blur();
    showShotMenu(shotMenu.hidden);
  });
  helpButton?.addEventListener('click', () => {
    helpButton.blur();
    showShotKeys(shotKeys.hidden);
  });
  // Anywhere else dismisses it. `pointerdown` rather than `click`, so it closes
  // on the way down and the same gesture can go straight back to flying. The
  // whole bar is exempt, not just the name: stepping with the arrows while the
  // list is open is worth watching, since the highlight moves with the cut.
  window.addEventListener('pointerdown', (e) => {
    if (shotMenu.hidden && shotKeys.hidden && shotShape.hidden) return;
    const target = e.target as Node;
    if (shotMenu.contains(target) || directorBar.contains(target)) return;
    showShotMenu(false);
    showShotKeys(false);
    showShotShape(false);
  });

  const hud = new HUD(hudCanvas);
  const input = new Input(sceneCanvas);
  const autopilot = new Autopilot();
  /**
   * What to suggest while the scenic flight is flying itself.
   *
   * The tour exists so the pilot can play with the world instead of the stick,
   * which only works if they know they can. One at a time, on a slow rotation:
   * a wall of hints over the view would defeat the object.
   */
  const TOUR_TIPS: [string, string][] = [
    ['C', 'Press C to cycle camera modes'],
    ['T', 'Press T to change the time of day'],
    ['R', 'Press R to change the weather'],
    ['SPACE', 'Press SPACE for the style panel'],
  ];
  /** Keys the pilot has already used — stop suggesting those. */
  const tourUsed = new Set<string>();
  const TOUR_TIP_SECONDS = 11;
  let tourTipIndex = 0;
  let tourTipTimer = 0;
  /** Whether the hint line is shown at all — the Controls tab turns it off. */
  let tipsVisible = true;
  /**
   * How fast the scenic flight runs against the clock.
   *
   * Simulated time only. The aircraft is not flown faster — at three times the
   * speed a jet's turning circle grows ninefold and the tour would stop fitting
   * the landscape — the *clock* runs faster, so more of the flight happens per
   * second. The camera keeps real time either way, which is what stops a
   * three-times tour looking like a fast-forwarded video.
   */
  const TOUR_SPEEDS = [0.5, 1, 1.5, 2, 3];
  let tourSpeedIndex = 1;
  /** Where a scenic flight starts: Standard shots at twice real time. */
  const TOUR_STYLE = 1;
  const TOUR_SPEED_INDEX = TOUR_SPEEDS.indexOf(2);

  /**
   * Seconds until the next tour, or 0 when none is pending.
   *
   * A tour that simply stopped on the runway of the world it had just shown you
   * would be an odd place to leave someone who asked for a scenic flight, so
   * landing rolls into a fresh world and the next departure.
   */
  let nextTourIn = 0;
  const LANDED_PAUSE = 4.5;

  /** Apply the tour rate — only ever while the tour is the one flying. */
  function applyTourSpeed(): void {
    loop.timeScale = autopilot.active ? TOUR_SPEEDS[tourSpeedIndex] : 1;
  }
  const tips = new Tips(() => {
    tipsVisible = false;
    tips.clear();
    notify('TIPS OFF', 'the Controls tab brings them back', 3);
    panel.sync();
  });

  engine.scene.add(aircraft.root);
  spawnHere();
  // Build the opening view's terrain up front — this happens behind the start
  // overlay, so the cost is invisible and the first frame is already complete.
  world.prime(model.position);

  let paused = false;
  /** True while the title screen's attract flight owns the aircraft. */
  let introRunning = true;
  // Declared before the first applyQuality() call below: `function` hoists but
  // `let` does not, so calling it any earlier hits the temporal dead zone.
  let qualityIndex = DEFAULT_QUALITY;

  function applyQuality(): void {
    const preset = QUALITY_PRESETS[qualityIndex];
    engine.applyQuality(preset);
    world.applyQuality(preset);
  }
  applyQuality();
  let message: HudMessage | null = null;
  let crashTimer = 0;
  /** Countdown for self-clearing HUD lines. Zero while a crash owns the line. */
  let messageTimer = 0;

  // Interpolated render pose, so the visual is smooth even though physics is stepped.
  const renderPosition = new THREE.Vector3();
  const renderQuaternion = new THREE.Quaternion();

  const status: HudStatus = {
    cameraMode: 'CHASE',
    assists: true,
    flightMode: 'MANUAL',
    paused: false,
    message: null,
    timeOfDay: world.timeOfDay,
    fps: 0,
    frameMs: 0,
  };

  /**
   * How long the director's gesture hint stays up, per visit to the mode.
   *
   * Wall clock, not accumulated frame time. "Thirty seconds" is a promise to
   * the reader, and counting frames makes it thirty seconds only on a machine
   * hitting frame rate — measured on a slow one, forty-four seconds of reading
   * time had not yet spent the budget.
   */
  const CAMERA_TIP_MS = 30_000;
  /**
   * What each camera mode is, in one line.
   *
   * These used to be the second line of the big centred notice, in white over
   * whatever the landscape happened to be doing — which is the hardest place in
   * the whole interface to read a sentence. They are tips now: same words, but
   * on the dark pill at the bottom of the screen that everything else
   * explanatory already uses.
   *
   * Chase and cockpit are absent on purpose. A view out of the aeroplane needs
   * no explaining, and a pill that says so is just something else on the glass.
   */
  const CAMERA_TIPS: Partial<Record<typeof rig.mode, string>> = {
    cinematic: 'Automatic Cinematic Director — Just set the pace and enjoy.',
    director: 'Pick shots, adjust settings, and build your sequence.',
    orbit: 'Set orbit direction, height, and speed.',
  };
  let cameraTipUntil = 0;
  let lastCameraMode = rig.mode;
  let lastShapeMode = rig.mode;
  let lastReelPosition = '';

  /**
   * Contextual hints. Each is evaluated every frame and shown only while its
   * situation applies, so they retire themselves once acted on rather than
   * needing to be dismissed.
   */
  /**
   * How the tips behave, rather than what they say.
   *
   * A hint that is always on screen stops being a hint and becomes furniture —
   * and the whole point of this sim is the view behind it. So a line comes up,
   * says its piece, and goes away again; nothing is shown continuously, and
   * the ones that teach a key are said **once**. There is no value in the
   * eleventh telling of "press C to cycle cameras": either it landed the first
   * time or the tip was never going to be what fixed it.
   */
  //
  // Both spans are wall clock, not accumulated frame time. "Nine seconds" is a
  // promise to the reader, and counting frames keeps it only on a machine
  // hitting frame rate — measured on a slow one, nine counted seconds took
  // twenty-two real ones and the rest between tips ran to a minute.
  const TIP_SHOW_MS = 9_000;
  const TIP_REST_MS = 26_000;
  /** The line on screen, and when it went up; null while the screen is resting. */
  let tipLine: string | null = null;
  let tipShownAt = 0;
  let tipHiddenAt = 0;
  /** Lines that have had their turn and are not coming back. */
  const tipsSaid = new Set<string>();

  /** A candidate line: `once` means it retires as soon as it has been read. */
  interface Candidate {
    text: string;
    once?: boolean;
  }

  function updateTips(): void {
    const t = model.telemetry;
    const knots = t.ias * MS_TO_KT;

    // One tip, ever.
    //
    // These used to be independent, each appearing when its own situation
    // applied — and three of them applied at once on every takeoff, stacking
    // up over the view the whole thing exists to show. They are a priority
    // list now: the first line whose situation holds is the line you get.
    const lines: (Candidate | null)[] = [];

    // Working the camera outranks everything else, including the scenic
    // flight's own status line: these controls are undiscoverable, and the one
    // moment they matter is while you are in the mode.
    lines.push(rig.mode === 'free'
      ? { text: 'Drag to orbit · wheel to zoom · shift-drag to reframe · '
        + '1-9 saved views, shift+number to save · X plants the camera ahead of you' }
      // The bar below carries the shot, the pin state and — behind its question
      // mark — the key list, so the tip is left with the one thing that has
      // nowhere else to live: the gesture, which no button can show you.
      : performance.now() < cameraTipUntil && CAMERA_TIPS[rig.mode] !== undefined
        ? { text: CAMERA_TIPS[rig.mode] as string }
        : null);

    if (autopilot.active) {
      // What the flight is doing, and — once each — what you could be doing
      // while it does it.
      const rate = TOUR_SPEEDS[tourSpeedIndex];
      const hint = TOUR_TIPS.find(([key, text]) => !tourUsed.has(key) && !tipsSaid.has(text));
      lines.push(hint !== undefined
        ? { text: hint[1], once: true }
        : { text: `SCENIC FLIGHT · ${tourNarration()}` + (rate === 1 ? '' : ` · ${rate}×`) });
    } else {
      // On the runway, until fast enough to rotate. Not a one-shot: it is the
      // answer to "how do I take off", and every flight starts here.
      lines.push(t.onGround && knots < 150 && !model.crashed
        ? { text: 'Throttle with SHIFT and rise up at speed 150+' }
        : null);

      // Climbing away with the gear still down. Gated on climbing so it does
      // not reappear on approach, when the gear is supposed to be down.
      lines.push(!t.onGround && t.altitude > 1000
        && controls.gearExtension > 0.5 && t.verticalSpeed > 0
        ? { text: 'Press L to raise landing gear', once: true }
        : null);

      // Gear down and airborne reads as "looking for somewhere to land", so
      // that is when the nearest village strip is worth pointing at. The range
      // changes as you fly, so this one is written fresh each time.
      const seekingField =
        !t.onGround && !model.crashed && controls.gearDown && controls.gearExtension > 0.5;
      const callout = seekingField ? airstripCallout() : null;
      lines.push(callout === null ? null : { text: callout });
    }

    const wanted = tipsVisible
      ? lines.find((line): line is Candidate => line !== null && !tipsSaid.has(line.text)) ?? null
      : null;

    const now = performance.now();
    if (tipLine !== null) {
      // It goes when it has been read, or the moment it stops being true.
      const read = now - tipShownAt >= TIP_SHOW_MS;
      if (read || wanted === null || wanted.text !== tipLine) {
        if (read) {
          const said = lines.find((l) => l?.text === tipLine);
          if (said?.once === true) tipsSaid.add(said.text);
        }
        tipLine = null;
        tipHiddenAt = now;
      }
    } else if (wanted !== null && now - tipHiddenAt >= TIP_REST_MS) {
      tipLine = wanted.text;
      tipShownAt = now;
    }

    tips.set('tip', tipLine);
  }

  /**
   * What the scenic flight is doing, in words.
   *
   * The line used to read the same from the moment the wheels left the runway
   * to the moment they touched it again — "APPROACH · landing at GULF FIELD"
   * while eleven kilometres from anywhere. The autopilot already knows which
   * phase it is in and which sight it is heading for, and the ground under the
   * aircraft is a function call away, so the line can simply say where you are.
   */
  function tourNarration(): string {
    const field = autopilot.destinationName;
    switch (autopilot.phase) {
      case 'takeoff':
      case 'climb':
        return `Takeoff from ${field}`;
      case 'approach':
      case 'final':
        return `Approach — landing at ${field}`;
      case 'rollout':
      case 'done':
        return `Landed at ${field}`;
      default:
        return `Flying over ${overhead()}`;
    }
  }

  /**
   * What is underneath, for the narration.
   *
   * The waypoint label says what the leg is *for*, which is the right answer
   * most of the time — but not while crossing ten kilometres of water to reach
   * it, so the ground itself gets the first word.
   */
  function overhead(): string {
    const { x, z } = model.position;
    if (terrainHeight(x, z) < 1) return 'the sea';

    const city = citySites()
      .find((c) => Math.hypot(x - c.x, z - c.z) < c.radius * 1.3);
    if (city !== undefined) return 'the city';

    const village = settlements()
      .some((v) => Math.hypot(x - v.x, z - v.z) < 1500);
    if (village) return 'a village';

    switch (autopilot.legLabel) {
      case 'MOUNTAINS': return 'the mountains';
      case 'SHORELINE': return 'the shoreline';
      case 'CITY': return 'the city';
      case 'VILLAGE': return 'a village';
      case 'HIGH COUNTRY': return 'high country';
      default: return 'the landscape';
    }
  }

  /** Range and relative bearing to the nearest village airstrip. */
  function airstripCallout(): string | null {
    const found = nearestAirstrip(model.position.x, model.position.z);
    if (!found) return null;

    const bearing = Math.atan2(
      found.strip.x - model.position.x,
      -(found.strip.z - model.position.z),
    ) * RAD;
    const off = angleDelta(model.telemetry.heading, bearing);
    const km = (found.distance / 1000).toFixed(1);

    if (Math.abs(off) < 8) return `Airstrip ${km} km ahead`;
    const side = off > 0 ? 'right' : 'left';
    return `Airstrip ${km} km — turn ${side} ${Math.round(Math.abs(off))}°`;
  }

  /** Put the aircraft at whatever start point the current world defines. */
  function spawnHere(): void {
    const spawn = spawnPoint();
    START_POSITION.set(spawn.x, 0, spawn.z);
    model.reset(START_POSITION, spawn.heading);
  }

  /**
   * Put the current message in the DOM as well as on the canvas.
   *
   * Only the text is mirrored, never the tone: the DOM line exists for the
   * cinematic view, and a red warning over a shot is exactly the symbology
   * that view is trying to keep out of frame.
   */
  function syncNotice(): void {
    const text = message === null ? '' : message.text;
    if (noticeText.textContent !== text) {
      noticeText.textContent = text;
      noticeSub.textContent = message?.sub ?? '';
      notice.dataset.empty = text === '' ? '1' : '0';
    } else if (noticeSub.textContent !== (message?.sub ?? '')) {
      noticeSub.textContent = message?.sub ?? '';
    }
  }

  /** Show a HUD line that clears itself, for actions with no other feedback. */
  function notify(text: string, sub?: string, seconds = 2.5): void {
    message = { text, sub, tone: 'info' };
    messageTimer = seconds;
  }

  /**
   * Rebuild the landscape under the aircraft.
   *
   * Every route to a new landscape comes through here, so none of them can
   * forget to preserve the flight:
   *
   * - `landscape: 'random'` also draws a new seed. That is N, "take me
   *   somewhere else entirely".
   * - A landscape *index* is the World tab's selector: it changes the scenery
   *   without rerolling it, because picking Fjords means you want to see
   *   fjords, not a different set of fjords each time you press it.
   * - No landscape at all reseeds whatever is already selected — the World
   *   tab's two buttons, which deliberately leave the selector above them
   *   alone rather than fighting it.
   *
   * Airborne, the aircraft keeps its altitude, attitude and speed — only the
   * ground underneath it changes. The one thing that cannot be kept is being
   * in clear air: the new height field is generated with no knowledge of where
   * the aircraft happens to be, so a peak can come up through it. Anything
   * left below `NEW_WORLD_CLEARANCE` is lifted just clear of the new ground,
   * which is a smaller lie than spawning inside a mountain.
   */
  function newWorld(opts: {
    landscape?: number | 'random';
    reseed?: boolean;
    takeoff?: boolean;
  } = {}): void {
    const index = opts.landscape === 'random'
      ? Math.floor(Math.random() * WORLD_PRESETS.length)
      : opts.landscape;
    const preset = index === undefined
      ? WORLD_PRESETS[world.worldIndexValue]
      : world.setWorld(index);
    const seed = opts.reseed ? world.regenerate() : world.seed;
    status.timeOfDay = world.timeOfDay;

    // On the deck there is no flight worth preserving, and the runway is the
    // only place guaranteed flat on a landscape nobody has seen yet.
    if (opts.takeoff || model.telemetry.onGround || model.crashed) {
      resetFlight();
    } else {
      // groundHeight, not terrainHeight: it is the one that knows about roofs
      // and the carrier deck. Sampling the bare terrain would happily set you
      // down 400 m up inside a 500 m tower.
      const ground = groundHeight(model.position.x, model.position.z);
      if (model.position.y < ground + NEW_WORLD_CLEARANCE) {
        model.position.y = ground + NEW_WORLD_CLEARANCE;
        model.prevPosition.copy(model.position);
        rig.snap(); // the aircraft jumped, so the camera must not chase it there
      }
    }
    world.prime(model.position);
    notify(`NEW WORLD  ${preset.name}`, `SEED ${String(seed).padStart(6, '0')}`);
  }

  /**
   * What the scenic autopilot needs to know about the world it is touring.
   *
   * Assembled fresh each time it is engaged, because every part of it — the
   * strips, the cities, the ground itself — changes with the world and the
   * seed. The home field goes first: it is the one runway the terrain
   * generator guarantees is flat, and the tour lands there.
   */
  function tourWorld(): TourWorld {
    const spawn = spawnPoint();
    return {
      ground: groundHeight,
      terrain: terrainHeight,
      strips: [
        {
          x: 0,
          z: 0,
          dirX: Math.sin(spawn.heading * DEG),
          dirZ: -Math.cos(spawn.heading * DEG),
          elevation: fieldElevation(),
          name: `${activeWorld().name} FIELD`,
        },
        ...airstrips().map((a, i) => ({ ...a, name: `AIRSTRIP ${i + 1}` })),
      ],
      cities: citySites(),
      villages: settlements(),
    };
  }

  /**
   * Say what the camera just became — and, for the free camera, how to fly it.
   *
   * The tip line carries the same thing, but it sits behind the takeoff and
   * gear prompts in the priority list, so on the runway it is the one place
   * you would not see it. Arriving in a mode whose controls are undiscoverable
   * is the moment to say them.
   */
  function announceCamera(): void {
    // Title only. What the mode *is* goes to the tip line, which is legible
    // over a moving landscape in a way that white text with a shadow is not.
    if (rig.mode === 'free') notify('FREE CAMERA', undefined, 6);
    else if (rig.mode === 'director') notify('DIRECTOR', undefined, 6);
    else if (rig.mode === 'cinematic') notify('CINEMATIC', undefined, 6);
    else if (rig.mode === 'orbit') notify('ORBIT', undefined, 6);
    else notify(`VIEW  ${status.cameraMode}`);
  }

  /** Start or stop the scenic flight. */
  function toggleTour(): void {
    if (autopilot.active) {
      autopilot.disengage();
      applyTourSpeed();
      tips.clear();
      notify('SCENIC FLIGHT OFF', 'you have control');
      return;
    }
    autopilot.maxBankDeg = controls.settings.maxBankDeg;
    autopilot.engage(tourWorld(), model.position.x, model.position.z, model.telemetry.onGround);
    controls.setMode('manual', model.telemetry);
    // How a scenic flight starts: the pace the rest of the sim opens on, and
    // the ground going by at twice real time. Deliberately not written to disk — this is the flight's own
    // opening setting, not a preference. Move a slider and *that* is saved, and
    // a session that never takes a scenic flight keeps whatever pace it had.
    rig.setDirectorStyle(TOUR_STYLE);
    tourSpeedIndex = TOUR_SPEED_INDEX;
    // The whole point is the view, so it starts in the camera that is directing
    // rather than the one that follows.
    rig.setMode('cinematic');
    status.cameraMode = 'CINEMATIC';
    tourTipIndex = 0;
    tourTipTimer = 0;
    applyTourSpeed();
    notify('SCENIC FLIGHT', tourNarration(), 3.5);
    panel.sync();
  }

  function resetFlight(): void {
    spawnHere();
    controls.reset();
    rig.snap(); // the aircraft jumps, so the camera must not interpolate there
    tips.clear();
    message = null;
    crashTimer = 0;
    messageTimer = 0;
  }

  function fixedUpdate(dt: number): void {
    if (paused) return;
    input.update();

    // Three sources of stick input, in order of who has control: the attract
    // flight, the scenic autopilot, and the pilot.
    let stick: StickInput = input;
    if (introRunning) {
      // Hands-off, and a key pressed while the title is still up must not
      // nudge it off its track.
      stick = IDLE_STICK;
    } else if (autopilot.active) {
      // Touching a *flight* control takes over — but changing the time of day,
      // the weather or the camera does not, because those are exactly what the
      // pilot is invited to do while it flies.
      if (Math.abs(input.pitch) > 0.15 || Math.abs(input.roll) > 0.15
        || Math.abs(input.yaw) > 0.15 || Math.abs(input.throttleAxis) > 0.15) {
        autopilot.disengage();
        applyTourSpeed();
        tips.clear();
        notify('SCENIC FLIGHT OFF', 'you have control');
      } else {
        autopilot.update(dt, model.telemetry, model.position.x, model.position.z);
        controls.gearDown = autopilot.wantsGearDown(model.telemetry);
        stick = autopilot.stick;
      }
    }

    controls.update(dt, stick, model.telemetry);
    model.step(dt, controls);

    if (autopilot.active && autopilot.phase === 'done') {
      autopilot.disengage();
      applyTourSpeed();
      tips.clear();
      notify('TOUR COMPLETE', 'setting off somewhere new', 4);
      // Let the landing be seen before the world changes underneath it.
      nextTourIn = LANDED_PAUSE;
    }
  }

  /**
   * Put the aircraft into a hands-off cruise somewhere over the current world,
   * for the title screen to play behind.
   *
   * The altitude comes from the highest ground along the next 60 km of track
   * rather than from a fixed number: cruise holds whatever altitude it starts
   * at, and a fixed one flies into the Himalaya within a minute.
   */
  function launchIntro(): void {
    const heading = Math.random() * 360;
    const dirX = Math.sin(heading * DEG);
    const dirZ = -Math.cos(heading * DEG);
    const x = (Math.random() - 0.5) * 26000;
    const z = (Math.random() - 0.5) * 26000;

    let peak = -Infinity;
    for (let d = 0; d <= 60000; d += 1200) {
      peak = Math.max(peak, terrainHeight(x + dirX * d, z + dirZ * d));
    }

    START_POSITION.set(x, 0, z);
    model.reset(START_POSITION, heading);
    model.position.y = peak + INTRO_CLEARANCE;
    model.velocity.set(dirX * INTRO_SPEED, 0, dirZ * INTRO_SPEED);
    model.telemetry.onGround = false;
    model.prevPosition.copy(model.position);

    controls.reset();
    controls.gearDown = false;
    controls.gearExtension = 0;
    controls.throttle = 0.72;
    // Telemetry only exists after a step, and cruise captures its hold altitude
    // from it — so step once before asking for the mode.
    model.step(1 / PHYSICS_HZ, controls);
    controls.setMode('cruise', model.telemetry);

    rig.setMode('cinematic');
    rig.snap();
    world.prime(model.position);
  }

  /**
   * The light everything opens in.
   *
   * A low sun across the landscape is the best this renderer looks, and it is
   * the one preset that reads well under the white titles as well — dawn and
   * dusk are prettier still to fly in and hopeless to put text over. Found by
   * name rather than written as an index so re-ordering the presets cannot
   * quietly change what the sim opens on.
   */
  const GOLDEN_HOUR = Math.max(0, TIME_PRESETS.findIndex((p) => p.name === 'GOLDEN'));

  /** Choose a fresh world and seed, then start the attract flight over it. */
  function beginIntro(): void {
    world.setWorld(Math.floor(Math.random() * WORLD_PRESETS.length));
    world.regenerate();
    world.setTimeOfDay(GOLDEN_HOUR);
    status.timeOfDay = world.timeOfDay;
    launchIntro();
    panel.sync();
  }

  function render(alpha: number, dt: number): void {
    // --- Discrete actions: once per frame, never per physics substep. --------
    let settingsChanged = false;
    // Hotkeys belong to the game, not to the screens in front of it — the
    // camera is the director's while the attract flight runs, and Manual now
    // puts the aircraft on its runway *before* the key list is dismissed, so
    // the overlay being up is its own reason to swallow the frame's input.
    if (introRunning || !overlay.classList.contains('hidden')) input.endFrame();
    if (input.wasPressed('KeyC')) {
      status.cameraMode = rig.cycle().toUpperCase();
      announceCamera();
      tourUsed.add('C');
      settingsChanged = true;
    }
    if (input.wasPressed('KeyG')) {
      controls.assists = !controls.assists;
      status.assists = controls.assists;
      settingsChanged = true;
    }
    if (input.wasPressed('KeyL')) controls.gearDown = !controls.gearDown;
    if (input.wasPressed('KeyT')) {
      status.timeOfDay = world.cycleTimeOfDay(1);
      notify(`TIME  ${status.timeOfDay}`);
      tourUsed.add('T');
      settingsChanged = true;
    }
    if (input.wasPressed('KeyR')) {
      notify(`WEATHER  ${world.cycleWeather(1)}`);
      tourUsed.add('R');
      settingsChanged = true;
    }
    if (nextTourIn > 0) {
      nextTourIn -= dt;
      if (nextTourIn <= 0) {
        nextTourIn = 0;
        newWorld({ landscape: 'random', reseed: true, takeoff: true });
        toggleTour();
      }
    }
    // Any of these means the pilot has taken over — drop the pending departure.
    if (input.wasPressed('KeyF') || input.wasPressed('Backspace')) nextTourIn = 0;
    // The free camera reads the mouse directly. It is taken every frame rather
    // than only in free mode so a drag made in another view does not queue up
    // and fire the moment you switch.
    const gesture = input.takeCameraGesture();
    if (rig.mode === 'director') {
      // The director keeps choosing and cutting; these reshape whatever it is
      // playing, and the change sticks to that shot for next time it comes up.
      if (gesture.dx !== 0 || gesture.dy !== 0 || gesture.wheel !== 0) {
        rig.adjustShot(gesture.dx, gesture.dy, gesture.wheel);
      }
      // `,` and `.`: the step-back/step-forward pair from every video editor,
      // unshifted, adjacent, and in the same physical place on US, UK and
      // Nordic layouts. `[` `]` are kept because they were the original
      // binding, but they are not advertised — on a Nordic keyboard those two
      // key positions print `å` and `¨`, so the hint was a lie.
      if (input.wasPressed('Comma') || input.wasPressed('BracketLeft')) rig.stepShot(-1);
      if (input.wasPressed('Period') || input.wasPressed('BracketRight')) rig.stepShot(1);
      if (input.wasPressed('KeyX')) {
        notify(rig.pinShot() ? 'SHOT PINNED' : 'DIRECTOR RUNNING', undefined, 2);
      }
      if (input.wasPressed('KeyZ')) {
        rig.resetShot();
        notify('SHOT RESET', undefined, 1.6);
      }
      // 1-9 are the saved setups, shift saves. (The free camera's saved views
      // stop at 8, which is as many as it has.)
      const savingShot = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
      for (let slot = 0; slot < 9; slot++) {
        if (!input.wasPressed(`Digit${slot + 1}`)) continue;
        picked = slot;
        if (savingShot) {
          rig.storeShotSlot(slot);
          activeSlot = slot;
          notify(`SHOT ${slot + 1} SAVED`, rig.shotName ?? undefined, 2.2);
        } else {
          const recalled = rig.recallShotSlot(slot);
          activeSlot = recalled === null ? -1 : slot;
          if (recalled === null) notify(`SHOT ${slot + 1} EMPTY`, 'shift+number saves one', 2);
          else notify(`SHOT ${slot + 1}`, recalled.shot, 1.6);
        }
        saveDirector();
        markSlots();
        if (!shotShape.hidden) syncShape();
      }
    }
    if (rig.mode === 'orbit' && rig.moveOrbitCamera(gesture.dy, gesture.wheel)) {
      // The bar states these in metres, so it has to follow the hand.
      syncOrbit();
      // A drag is hundreds of these frames; the write is left to settle, the
      // same reasoning as the sliders saving on `change` rather than on `input`.
      orbitSaveDue = performance.now() + ORBIT_SAVE_DELAY_MS;
    }
    if (orbitSaveDue !== 0 && performance.now() >= orbitSaveDue) {
      orbitSaveDue = 0;
      saveDirector();
    }
    if (rig.mode === 'free') {
      rig.moveFreeCamera(gesture.dx, gesture.dy, gesture.wheel, gesture.pan);
      // 1-9 recall a saved view; shift saves the current one over it. The nine
      // start out as a spread worth having, so the "presets" and the "saves"
      // are the same nine slots rather than two competing sets.
      const saving = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
      for (let slot = 0; slot < rig.freeViewCount; slot++) {
        if (!input.wasPressed(`Digit${slot + 1}`)) continue;
        // Both routes leave the same slot picked, so the bar never disagrees
        // with the keyboard about which view Save would write to.
        pickedView = slot;
        if (saving) {
          rig.storeFreeView(slot);
          saveFreeViews();
          notify(`VIEW ${slot + 1} SAVED`, 'press the number to come back to it', 2.2);
        } else {
          rig.recallFreeView(slot);
          notify(`VIEW ${slot + 1}`, undefined, 1.2);
        }
        syncFree();
      }
      if (input.wasPressed('KeyX')) {
        announceFreeLock(rig.toggleFreeLock());
        syncFree();
      }
    }

    if (input.wasPressed('KeyF')) toggleTour();
    if (autopilot.active) {
      tourTipTimer += dt;
      if (tourTipTimer > TOUR_TIP_SECONDS) {
        tourTipTimer = 0;
        tourTipIndex += 1;
      }
    }
    if (input.wasPressed('KeyN')) {
      newWorld({ landscape: 'random', reseed: true });
      settingsChanged = true;
    }
    // Hotkeys can change the same state the panel shows, so keep it in step.
    if (settingsChanged) panel.sync();
    if (input.wasPressed('Space')) {
      tourUsed.add('SPACE');
      panel.toggleStyle();
    }
    if (input.wasPressed('Backspace')) resetFlight();
    if (input.wasPressed('KeyP')) paused = !paused;
    if (input.wasPressed('KeyH')) toggleHelp();
    if (input.wasPressed('KeyM')) {
      if (input.usingMouse) input.releaseMouseControl();
      else input.requestMouseControl();
    }
    // Escape closes the shot picker before it reaches for the help screen —
    // dismissing the thing that is open is what the key is for.
    if (input.wasPressed('Escape')) {
      if (!shotMenu.hidden) showShotMenu(false);
      else if (!shotKeys.hidden) showShotKeys(false);
      else if (!shotShape.hidden) showShotShape(false);
      else showHelp();
    }

    // The attract flight can still fly into a ridge on a bad draw; put it back
    // in the air rather than showing a crash message over the title.
    if (introRunning && model.crashed) launchIntro();

    // --- Crash: show the impact speed, then put the aircraft back. ----------
    if (!introRunning && model.crashed && crashTimer === 0) {
      message = { text: `CRASHED  ${Math.round(model.crashSpeed * MS_TO_KT)} KT`, tone: 'warn' };
      crashTimer = 3;
      messageTimer = 0; // the crash owns the line until the reset clears it
    }
    if (crashTimer > 0) {
      crashTimer -= dt;
      if (crashTimer <= 0) resetFlight();
    }
    if (messageTimer > 0) {
      messageTimer -= dt;
      if (messageTimer <= 0) message = null;
    }

    // --- Pose interpolation between the last two physics states. -------------
    renderPosition.lerpVectors(model.prevPosition, model.position, alpha);
    renderQuaternion.slerpQuaternions(model.prevOrientation, model.orientation, alpha);
    aircraft.setPose(renderPosition, renderQuaternion);

    aircraft.update(dt, controls, model.telemetry);
    world.update(dt, renderPosition);
    // A running day changes the readout and the clock slider under the pilot.
    // Only while it is actually running: `sync` walks every control the open
    // panel built, which is wasted work sixty times a second for a sun that is
    // not moving.
    if (world.driftIndexValue > 0) {
      status.timeOfDay = world.timeOfDay;
      if (panel.isOpen) panel.sync();
    }

    // What the director frames against: the light, the nearest thing worth
    // putting behind the aircraft, and how much room there is underneath.
    // `world.sun` is the direction; `sunLight.position` is a *place* that
    // follows the aircraft so the shadow frustum stays with it. Normalising the
    // latter gives a "sun direction" dominated by where the aircraft happens to
    // be, and the backlit shots pointed at nothing.
    sunDirection.copy(world.sun).normalize();
    rig.setDirectorContext(sunDirection, nearestLandmark(renderPosition),
      nearestStructure(renderPosition), model.telemetry.agl);
    rig.update(dt, aircraft, model.telemetry);

    // Events are what a director cuts *to*. The timer handles cruising; these
    // handle the moments.
    const airborne = !model.telemetry.onGround;
    if (airborne !== wasAirborne) {
      rig.requestShot(airborne ? 'takeoff' : 'landing');
      wasAirborne = airborne;
    }

    // Focus on the aircraft: the director always knows where the subject is, so
    // the lens never has to hunt for it, and a rack focus is this number moving.
    const lens = rig.lens;
    const subject = engine.camera.position.distanceTo(renderPosition);
    engine.setFocus(subject * lens.focusScale, dofOverride ?? lens.aperture);

    engine.render(dt);

    // Straight after the draw, in the same task: without `preserveDrawingBuffer`
    // the buffer is cleared before anything else gets a look at it, and asking
    // a frame later gives a blank image. Costing every frame a preserved buffer
    // to make one screenshot cheap is the wrong way round.
    if (pendingShot) {
      pendingShot = false;
      sceneCanvas.toBlob((blob) => {
        if (blob !== null) saveCapture(blob, 'png');
      }, 'image/png');
      notify('SCREENSHOT SAVED', undefined, 2);
    }

    // The cinematic view is a camera, not a cockpit: symbology over it breaks
    // the shot. Hiding the canvas also stops the last frame's HUD lingering.
    const cinematic = rig.mode === 'cinematic';
    // Symbology over a shot breaks it, and on a scenic flight every camera is
    // a shot: the aeroplane is being flown for you, so there is no instrument
    // on the glass anyone is reading, whichever view it is watched from. This
    // used to name the director specifically, which left the tapes sitting over
    // the chase, cockpit, orbit and free views for the whole of a tour. Hand
    // flying gets its meters back the moment the autopilot is off.
    const bareView = cinematic || (autopilot.active && !introRunning);
    hudCanvas.style.display = bareView ? 'none' : '';
    // The message line is painted on that canvas, so it needs the DOM copy
    // wherever the canvas is gone — not only in the cinematic view.
    document.body.classList.toggle('no-hud', bareView);
    document.body.classList.toggle('cinematic', cinematic);
    // The bar is only useful where there is a shot to step, and the title
    // screen has its own camera.
    if (cinematic && !introRunning) syncPace();
    // The rate belongs to the flight, not to a camera: it shows on the bar in
    // whichever of the two modes the bar is up.
    document.body.classList.toggle('touring', autopilot.active && !introRunning);
    if (autopilot.active) syncTourSpeed();
    // The orbit and free views borrow the same bar; the title screen has its
    // own camera and no business showing either.
    document.body.classList.toggle('orbit', rig.mode === 'orbit' && !introRunning);
    document.body.classList.toggle('free', rig.mode === 'free' && !introRunning);
    const directing = rig.mode === 'director' && !introRunning;
    const shaping = directing || (cinematic && !introRunning);
    document.body.classList.toggle('director', directing);
    // The gesture hint runs from the moment the director is entered, and starts
    // again if you leave and come back — which is when you would want reminding.
    if (rig.mode !== lastCameraMode) {
      lastCameraMode = rig.mode;
      if (CAMERA_TIPS[rig.mode] !== undefined) {
        cameraTipUntil = performance.now() + CAMERA_TIP_MS;
        // Skip the rest period. Tips are on a duty cycle so the interface stays
        // quiet, but arriving in a mode whose whole point needs explaining is
        // the one moment worth interrupting for — and the wait was up to 26 s,
        // by which time you have either worked it out or given up. This applies
        // to every mode that has a line to say now, not only the director.
        //
        // Backdated, not zeroed. `performance.now()` counts from page load, so
        // zero is "long ago" only once the page has been open longer than the
        // rest period — and reaching the director inside the first half minute
        // is the normal case, not the edge one. Zeroing it held the tip back by
        // however much of those 26 seconds the page had not yet lived through.
        tipHiddenAt = performance.now() - TIP_REST_MS;
        tipLine = null;
      }
      if (rig.mode === 'orbit') syncOrbit();
      if (rig.mode === 'free') syncFree();
    }
    if (!directing) {
      if (!shotMenu.hidden) showShotMenu(false);
      if (!shotKeys.hidden) showShotKeys(false);
    }
    if (!shaping && !shotShape.hidden) showShotShape(false);
    // The panel is shared between the two modes and says different things in
    // each, so it has to be redrawn when the camera changes under it.
    if (!shotShape.hidden && rig.mode !== lastShapeMode) {
      lastShapeMode = rig.mode;
      syncShape();
    }
    // The reel can advance to an entry whose *shot* has not changed — the same
    // setup saved twice, framed differently — and then the panel's position
    // readout would sit a cut behind the bar's.
    const reelAt = rig.reelPlaying ? rig.reelPosition : '';
    if (!shotShape.hidden && reelAt !== lastReelPosition) {
      lastReelPosition = reelAt;
      syncShape();
    }
    const shot = rig.shotName;
    if (shot !== null && shotLabel.textContent !== shot) shotLabel.textContent = shot;
    if (shot !== null && shotNameText.textContent !== shot) {
      shotNameText.textContent = shot;
      // The director cuts while the picker is open, so the highlight has to
      // follow it rather than only move when something is chosen.
      for (const [name, entry] of menuEntries) entry.classList.toggle('current', name === shot);
      // Same for the sliders: they belong to the shot that is playing, and it
      // changes on its own clock.
      if (!shotShape.hidden) syncShape();
    }
    // Auto / Pinned / a reel position: three things the sequence can be doing,
    // and the bar has to say which. Leaving it on AUTO while a reel played was
    // the one reading that is simply untrue.
    const pinned = directing && rig.shotPinned;
    const reel = directing && rig.reelPlaying ? `Reel ${rig.reelPosition}` : '';
    const wanted = reel !== '' ? reel : pinned ? 'Pinned' : 'Auto';
    if (pinLabel.textContent !== wanted) {
      pinLabel.textContent = wanted;
      pinButton.setAttribute('aria-pressed', String(pinned || reel !== ''));
    }
    // The shot name is for the camera mode, not for the title card.
    shotLabel.style.display = introRunning ? 'none' : '';

    status.paused = paused;
    status.message = message;
    status.fps = loop.fps;
    status.frameMs = loop.frameMs;
    if (!cinematic) {
      hud.draw(model.telemetry, controls, engine.camera, renderPosition, model.velocity, status);
    }
    syncNotice();
    if (!introRunning) updateTips();

    input.endFrame();
  }

  const sensitivityKey = (axis: 'pitch' | 'roll' | 'rudder'): 'pitchSensitivity' | 'rollSensitivity' | 'rudderSensitivity' =>
    `${axis}Sensitivity` as const;

  const panel = new Panel({
    toggleTour,
    touring: () => autopilot.active,
    getTipsVisible: () => tipsVisible,
    setTipsVisible: (on: boolean) => {
      tipsVisible = on;
      if (!on) tips.clear();
    },
    getDepthOfField: () => depthOfField,
    setDepthOfField: (on: boolean) => {
      depthOfField = on;
      engine.configurePostFX({ depthOfField: on });
    },
    tourSpeedOptions: TOUR_SPEEDS.map((v) => `${v}×`),
    getTourSpeed: () => tourSpeedIndex,
    setTourSpeed: (i: number) => {
      tourSpeedIndex = clamp(Math.round(i), 0, TOUR_SPEEDS.length - 1);
      applyTourSpeed();
    },
    newWorld: () => newWorld({ reseed: true }),
    newWorldTakeoff: () => newWorld({ reseed: true, takeoff: true }),
    currentSeed: () => world.seed,

    timeOptions: TIME_PRESETS.map((p) => p.name),
    weatherOptions: WEATHER_PRESETS.map((p) => p.name),
    seasonOptions: SEASON_PRESETS.map((p) => p.name),
    cameraOptions: CAMERA_MODES.map((m) => m.toUpperCase()),
    qualityOptions: QUALITY_PRESETS.map((q) => q.name),
    worldOptions: WORLD_PRESETS.map((w) => w.name),

    getWorld: () => world.worldIndexValue,
    // Picking a landscape mid-flight used to drop the aircraft back on the
    // runway. It goes through the same path as everything else now, so the
    // flight carries over and only the ground beneath it changes.
    setWorld: (i) => newWorld({ landscape: i }),
    worldBlurb: () => world.worldBlurb,

    getQuality: () => qualityIndex,
    setQuality: (i) => {
      qualityIndex = clamp(Math.round(i), 0, QUALITY_PRESETS.length - 1);
      applyQuality();
    },

    driftOptions: DRIFT_RATES.map((r) => r.name),
    getClock: () => world.clockHours,
    setClock: (h) => {
      world.setClock(h);
      status.timeOfDay = world.timeOfDay;
    },
    clockLabel: () => world.clockLabel,
    getDrift: () => world.driftIndexValue,
    setDrift: (i) => world.setDrift(i),

    getTime: () => world.timeIndexValue,
    setTime: (i) => {
      world.setTimeOfDay(i);
      status.timeOfDay = world.timeOfDay;
    },
    getWeather: () => world.weatherIndexValue,
    setWeather: (i) => world.setWeather(i),
    getSeason: () => world.seasonIndexValue,
    setSeason: (i) => world.setSeason(i),

    getCamera: () => CAMERA_MODES.indexOf(rig.mode),
    setCamera: (i) => {
      rig.setMode(CAMERA_MODES[i]);
      status.cameraMode = rig.mode.toUpperCase();
      announceCamera();
    },
    getFov: () => rig.fieldOfView,
    setFov: (deg) => rig.setFieldOfView(deg),

    getMode: () => controls.mode,
    setMode: (mode: FlightMode) => {
      controls.setMode(mode, model.telemetry);
      status.flightMode = mode.toUpperCase();
      status.assists = controls.assists;
    },
    getCentreHud: () => hud.showCentreSymbology,
    setCentreHud: (on) => {
      hud.showCentreSymbology = on;
    },
    showKeyControls: () => showHelp(),

    getAssists: () => controls.assists,
    setAssists: (on) => {
      controls.assists = on;
      status.assists = on;
    },

    getSensitivity: (axis) => controls.settings[sensitivityKey(axis)],
    setSensitivity: (axis, value) => {
      controls.settings[sensitivityKey(axis)] = value;
    },
    getMaxBank: () => controls.settings.maxBankDeg,
    setMaxBank: (deg) => {
      controls.settings.maxBankDeg = deg;
    },

    resetControls: () => {
      Object.assign(controls.settings, DEFAULT_SETTINGS);
      status.assists = controls.assists;
      status.flightMode = controls.mode.toUpperCase();
      rig.setFieldOfView(58);
    },
  });

  // --------------------------------------------------- idle, in fullscreen
  //
  // Fullscreen is someone saying they want the picture, not the instrument
  // panel, so after a few seconds of stillness everything drawn over the
  // landscape steps back: the tabs, the mode bar, the corner icons and the
  // shot name. Any input at all brings them straight back.
  //
  // Only in fullscreen — in a window the chrome is the way you drive the
  // thing — and never while a tab is open, because reading a panel of
  // settings is not the same as doing nothing.
  {
    const IDLE_AFTER = 5000;
    let lastInput = performance.now();
    const wake = (): void => {
      lastInput = performance.now();
      document.body.classList.remove('idle');
    };
    // Passive: none of these are cancelled, and saying so keeps the listeners
    // off the critical path of a drag over the canvas.
    for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart'] as const) {
      window.addEventListener(type, wake, { passive: true });
    }
    document.addEventListener('fullscreenchange', wake);
    window.setInterval(() => {
      document.body.classList.toggle('idle',
        document.fullscreenElement !== null
        && !panel.isOpen
        && performance.now() - lastInput >= IDLE_AFTER);
    }, 250);
  }

  const loop = new Loop(1 / PHYSICS_HZ, fixedUpdate, render);
  loadFreeViews();
  clearStoredShotTweaks();
  // The scenic flight's rate, on the bar as well as in the World panel. One
  // setter for both, so they cannot disagree about what is selected.
  for (const [index, speed] of TOUR_SPEEDS.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${speed}×`;
    button.addEventListener('click', () => {
      button.blur();
      tourSpeedIndex = index;
      applyTourSpeed();
      panel.sync();
      syncTourSpeed();
    });
    tourSpeedRow.append(button);
  }

  let tourSpeedShown = -1;

  function syncTourSpeed(): void {
    if (tourSpeedShown === tourSpeedIndex) return;
    tourSpeedShown = tourSpeedIndex;
    tourSpeedRow.childNodes.forEach((node, i) => {
      (node as HTMLButtonElement).classList.toggle('active', i === tourSpeedIndex);
    });
  }
  syncTourSpeed();

  /**
   * The orbit bar.
   *
   * Written straight through to the rig on `input` rather than on `change`, so
   * the ring reshapes under the slider as it is dragged — the only way to judge
   * a framing is to see it. The write to disk is on `change`, at the end of the
   * gesture, so a single drag is one save and not two hundred.
   */
  function syncOrbit(): void {
    const { distance, height, rate, direction } = rig.orbit;
    orbitDistance.value = String(distance);
    orbitHeight.value = String(height);
    orbitRate.value = String(rate);
    orbitDistanceValue.textContent = `${Math.round(distance)} m`;
    // Signed, because below the aircraft is a real and useful place to be.
    orbitHeightValue.textContent = `${height > 0 ? '+' : ''}${Math.round(height)} m`;
    // "Held" rather than "0.0 rpm": at zero the camera stops on the bearing it
    // reached, which is a fixed side-on view and worth naming as one.
    orbitRateValue.textContent = rate === 0 ? 'held' : `${rate.toFixed(1)} rpm`;
    const cw = direction > 0;
    orbitDirection.classList.toggle('ccw', !cw);
    orbitDirectionLabel.textContent = cw ? 'CW' : 'CCW';
    orbitDirection.title = cw ? 'Circling clockwise from above' : 'Circling anticlockwise';
  }

  orbitDirection.addEventListener('click', () => {
    orbitDirection.blur();
    rig.setOrbit({ direction: -rig.orbit.direction });
    syncOrbit();
    saveDirector();
  });
  for (const [input, key] of [[orbitDistance, 'distance'], [orbitHeight, 'height'],
    [orbitRate, 'rate']] as const) {
    input.addEventListener('input', () => {
      rig.setOrbit({ [key]: Number(input.value) });
      syncOrbit();
    });
    input.addEventListener('change', saveDirector);
  }

  /**
   * The free camera's bar: nine views, a save, and the two toggles.
   *
   * `pickedView` is the slot Save writes to, exactly as in the director's
   * panel — click a slot, then Save — so the same gesture works in both places.
   * A recall also picks the slot it came from, which is almost always the one
   * you want to write back to after nudging the framing.
   */
  let pickedView = -1;
  const freeSlotButtons: HTMLButtonElement[] = [];
  for (let i = 0; i < rig.freeViewCount; i++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot-button filled';
    button.textContent = String(i + 1);
    button.title = `View ${i + 1}`;
    button.addEventListener('click', () => {
      button.blur();
      pickedView = i;
      rig.recallFreeView(i);
      notify(`VIEW ${i + 1}`, undefined, 1.2);
      syncFree();
    });
    freeSlotButtons.push(button);
    freeSlotRow.append(button);
  }

  function syncFree(): void {
    freeSlotButtons.forEach((b, i) => b.classList.toggle('picked', i === pickedView));
    freeStore.disabled = pickedView < 0;
    freeStore.title = pickedView < 0
      ? 'Pick a view first, then save the current framing into it'
      : `Write the current framing into view ${pickedView + 1}`;
    const world = rig.freeCameraLocked;
    freeLock.classList.toggle('world', world);
    freeLockLabel.textContent = world ? 'World' : 'Aircraft';
    // Named for what the camera is fixed to, and said in full, because the
    // two are only a word apart on the button.
    freeLock.title = world
      ? 'World: the camera stands in your path — you fly at it, whip past, and away, then it '
        + 'takes fresh station ahead of you. Drag to move round the pass and the wheel to set '
        + 'how close it goes by, both without restarting it. Saved with the view.'
      : 'Aircraft: the camera travels with the aircraft and holds it at the same distance. '
        + 'Saved with the view.';
    freeReframe.setAttribute('aria-pressed', String(rig.freeReframing));
  }

  freeStore.addEventListener('click', () => {
    freeStore.blur();
    if (pickedView < 0) return;
    rig.storeFreeView(pickedView);
    saveFreeViews();
    notify(`VIEW ${pickedView + 1} SAVED`, undefined, 2);
    syncFree();
  });
  freeReframe.addEventListener('click', () => {
    freeReframe.blur();
    rig.setFreeReframe(!rig.freeReframing);
    notify(rig.freeReframing ? 'REFRAME' : 'ORBIT',
      rig.freeReframing ? 'drag moves what the camera looks at' : 'drag swings the camera round',
      1.8);
    syncFree();
  });
  freeLock.addEventListener('click', () => {
    freeLock.blur();
    announceFreeLock(rig.toggleFreeLock());
    syncFree();
  });

  /** The one place that says what the lock means, so the two routes agree. */
  function announceFreeLock(world: boolean): void {
    notify(world ? 'CAMERA  IN THE WORLD' : 'CAMERA  ON THE AIRCRAFT',
      world ? 'planted ahead of you — fly at it, past it, and away'
        : 'it travels with you, holding the same distance',
      2.6);
  }

  loadDirector();
  syncOrbit();
  markSlots();
  syncShape();
  beginIntro();

  // Dev-only handle for driving the sim from the console during development.
  // Stripped from the production bundle by the `import.meta.env.DEV` guard.
  if (import.meta.env.DEV) {
    Object.assign(window, {
      sim: {
        model, controls, aircraft, rig, world, engine, input, loop, status,
        resetFlight, terrainHeight, groundHeight, hud, tips, panel,
        settlements, airstrips, nearestAirstrip, pyramids, autopilot, toggleTour, tourWorld,
        setDof: (a: number | null) => { dofOverride = a; },
        setDepthDebug: (on: boolean) => engine.setDepthDebug(on),
        setTourSpeed: (i: number) => { tourSpeedIndex = i; applyTourSpeed(); },
        citySites,
        boats,
        structures,
        balloons,
        setSpin: (t: number) => { turbineSpin.value = t; },
        setDrift: (t: number) => { balloonDrift.value = t; },
        setTrailTime: (t: number) => { contrailTime.value = t; },
        fogCover, FOG_GLSL, THREE,
      },
    });
  }

  // The attract flight plays behind the title screen, so the loop runs from the
  // start rather than waiting for the click.
  loop.start();

  // --- Title sequence ------------------------------------------------------
  //
  // The overlay opens on four fading beats — title, subtitle, tagline, then what
  // the sim actually lets you do — and only then offers the key list. The beats
  // are pure CSS so they run on the compositor and stay smooth while the world
  // is being built behind them; all this does is decide when they are over.
  //
  // Must match `--titles-end` in index.html.
  // A backstop only — the sequence normally ends on the last beat's own
  // `animationend`. A wall-clock timer cannot be the primary signal: the CSS
  // clock starts at the first frame after `intro` is applied, and while the
  // world is still building that frame can land the better part of a second
  // late, so a fixed timeout fires partway through the closing beat.
  const TITLES_TIMEOUT_MS = 18000;
  let titlesDone = false;
  let titleTimer = 0;

  /** End the opening titles and ask which way in. */
  const endTitles = (): void => {
    if (titlesDone) return;
    titlesDone = true;
    window.clearTimeout(titleTimer);
    overlay.classList.remove('intro');
    overlay.classList.add('choose');
    // Deliberately nothing is focused. Focusing the primary button drew a ring
    // round it the moment the screen arrived, which reads as a selection rather
    // than as a default. Keyboard users get the ring when they reach for it —
    // by Tab, or by the Enter below.
  };

  /** Leave the choice behind, whichever way it went. */
  const leaveChoice = (): void => {
    overlay.classList.remove('choose');
    document.body.classList.remove('titles');
  };

  // Begin the titles only once a frame has actually been painted. The beats are
  // CSS animations, so putting `intro` in the markup started them at parse time
  // and played the title card over a black screen while the world was still
  // being built. Two frames: the first schedules the render, the second lands
  // after it has been composited.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (titlesDone) return; // clicked through before the scene came up
    overlay.classList.add('intro');
    document.body.classList.add('titles');
    // The closing beat tells us when it is finished, so the handover to the
    // help panel stays in step with the animation however the frames fall.
    overlay.querySelector('.beat:last-of-type')
      ?.addEventListener('animationend', endTitles, { once: true });
    titleTimer = window.setTimeout(endTitles, TITLES_TIMEOUT_MS);
  }));

  /**
   * Open the key list in full.
   *
   * The panel has two depths. Straight after the titles it shows only the keys
   * needed to fly and look around, because a wall of eighteen bindings is not
   * what someone wants at the moment they are trying to get airborne. Asking
   * for help — H, Escape, or the Help tab — means you want the rest of it, and
   * it stays that way for the session.
   */
  const showHelp = (): void => {
    overlay.classList.add('full');
    overlay.classList.remove('hidden');
  };

  /**
   * H both opens and closes the key list.
   *
   * Closing goes through `start` rather than just hiding the overlay, because
   * on the very first screen the overlay is still the thing gating the flight —
   * H there has to hand over properly, not leave the sim in attract mode with
   * nothing on screen.
   */
  const toggleHelp = (): void => {
    if (overlay.classList.contains('hidden')) showHelp();
    else start();
  };

  /**
   * Bring the radio up with the flight.
   *
   * Both ways in have to call this, and only from inside the click: browsers
   * will not start audio without a user gesture, and the button press is the
   * first one there is. It resumes whatever was last tuned in — Mission Control
   * on a first visit — and stays quiet if the radio was switched off last time.
   */
  const startRadio = (): void => {
    if (radio.status !== 'stopped' || savedRadio.playing === false) return;
    radio.select(typeof savedRadio.station === 'number' ? savedRadio.station : 0);
    saveRadio();
  };

  /**
   * Land the audience where they were just flying: same world, same seed, but
   * now on its runway with the controls their own.
   *
   * Called when Manual is chosen, not when the key list is dismissed. Leaving
   * it until the dismissal meant the keys were read over the attract flight
   * still wheeling about behind them — you were being told how to fly while
   * watching a camera fly for you, and the aircraft only appeared on its runway
   * once you had finished reading. Doing it on the button puts the thing the
   * keys describe behind the keys that describe it.
   */
  const takeControl = (): void => {
    if (!introRunning) return;
    introRunning = false;
    controls.setMode('manual', model.telemetry);
    status.flightMode = 'MANUAL';
    rig.setMode('chase');
    status.cameraMode = 'CHASE';
    resetFlight();
    world.prime(model.position);
    panel.sync();
    tips.clear();
  };

  const start = (): void => {
    // The first click belongs to the titles: skip them and put the choice up
    // rather than dropping someone onto a runway before they have read anything.
    if (!titlesDone) {
      endTitles();
      return;
    }
    // While the choice is up, the click has to land on one of the two buttons.
    // The overlay-wide handler would otherwise take any stray click as "manual,
    // now", which is the one answer nobody gave.
    if (overlay.classList.contains('choose')) return;
    takeControl();
    startRadio();

    // The help screen is a pause from here on, not a gate — its closing line
    // changes from "start" to "continue".
    document.body.classList.add('started');
    overlay.classList.add('hidden');
    loop.start();
    // Space both dismisses this screen and toggles the Style panel in flight.
    // Input has already recorded the press, so without dropping the edge here
    // the same keystroke would open Style on the very next frame.
    input.endFrame();
  };
  // Manual: the key list, exactly as before. It is still a screen you dismiss
  // to fly, so nothing else happens here — `start` does the rest.
  chooseManual.addEventListener('click', (e) => {
    e.stopPropagation();
    leaveChoice();
    // The time key works during the attract flight, so this is not redundant:
    // whatever it was left on, the flight someone asked for opens in the light
    // the sim promises.
    world.setTimeOfDay(GOLDEN_HOUR);
    status.timeOfDay = world.timeOfDay;
    takeControl();
    overlay.classList.add('ready');
  });

  /**
   * Scenic flight: a new world, and the autopilot flying out of its airport.
   *
   * Somewhere new on purpose. The attract flight has been showing one landscape
   * for the length of the titles, and "take me flying" answered with the same
   * scenery would look like nothing had happened.
   */
  chooseTour.addEventListener('click', (e) => {
    e.stopPropagation();
    leaveChoice();
    introRunning = false;
    world.setTimeOfDay(GOLDEN_HOUR);
    // `takeoff` puts it on the runway rather than preserving a flight — there
    // is no flight to preserve, and the tour is written to start from a field.
    newWorld({ landscape: 'random', reseed: true, takeoff: true });
    world.prime(model.position);
    // `toggleTour` is a toggle, and the attract flight does not use the
    // autopilot — but a guard here costs nothing and turning the tour *off* at
    // the moment someone asked for it would be a strange way to begin.
    if (!autopilot.active) toggleTour();
    startRadio();
    document.body.classList.add('started');
    overlay.classList.add('hidden');
    loop.start();
    input.endFrame();
    panel.sync();
  });

  // The design credit is a real link. Without this, clicking it would also
  // count as the click that dismisses the screen behind it.
  overlay.querySelector('.t-credit')?.addEventListener('click', (e) => e.stopPropagation());
  overlay.addEventListener('click', start);
  window.addEventListener('keydown', (e) => {
    // Only while the screen is actually up — otherwise Space in flight would
    // come through here as well as reaching its own binding.
    if (overlay.classList.contains('hidden')) return;
    if (overlay.classList.contains('choose')) {
      // A focused button handles its own Enter and Space; pressing either with
      // nothing focused takes the primary, so the keyboard is never stuck on a
      // screen that deliberately focuses nothing.
      if (document.activeElement === chooseTour || document.activeElement === chooseManual) return;
      if (e.code === 'Enter' || e.code === 'Space') chooseTour.click();
      return;
    }
    if (e.code === 'Enter' || e.code === 'Space') start();
  });
}

/** Surface init failures visibly instead of leaving a blank screen. */
function reportFailure(err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const message = `Failed to start:\n${detail}`;
  console.error(err);

  const box = document.getElementById('error');
  if (box) {
    // The error box lives inside the help panel, which the opening titles keep
    // hidden for their first thirteen seconds. A failure has to cut them short
    // or it reports into an invisible element.
    const overlay = document.getElementById('overlay');
    overlay?.classList.remove('hidden', 'intro');
    overlay?.classList.add('ready');
    document.body?.classList.remove('titles');
    box.style.display = 'block';
    box.textContent = message;
    return;
  }
  // The overlay markup isn't available — make sure the failure is still seen.
  const pre = document.createElement('pre');
  pre.style.cssText =
    'position:fixed;inset:0;z-index:9;margin:0;padding:24px;overflow:auto;' +
    'background:#0a0d12;color:#ffb4b4;white-space:pre-wrap;font:12px ui-monospace,monospace';
  pre.textContent = message;
  document.body?.appendChild(pre);
}

function start(): void {
  try {
    boot();
  } catch (err) {
    reportFailure(err);
  }
}

// The production build is a classic script, which Vite injects into <head> — so
// at execution time the canvases don't exist yet and every getElementById would
// return null. Waiting for the DOM makes the dev and single-file builds behave
// identically instead of failing silently in one of them.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
