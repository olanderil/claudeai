import * as THREE from 'three';
import { frontZ } from '../world/Front';
import { Mode, headingTo, type ModeConfig, type ModeHost, type Report } from './Mode';
import type { Battle } from '../combat/Battle';
import type { Plane } from '../combat/Plane';
import { makeGroundTarget, makeZeppelin, type Target } from '../combat/Targets';
import type { Team } from '../combat/Types';

/**
 * The campaign: seven sorties across the fronts, each with its own world,
 * hour and weather, told from whichever side the player flies for.
 */

export interface MissionInfo {
  id: string;
  name: string;
  /** World preset name (resolved against the world list; falls back to the first). */
  world: string;
  seed: number;
  time: string;
  weather: string;
  season?: string;
  place: Record<Team, string>;
  date: string;
  briefing: Record<Team, string>;
  make(battle: Battle, host: ModeHost, config: ModeConfig): Mode;
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

abstract class Mission extends Mode {
  override lives = 2;
  constructor(battle: Battle, host: ModeHost, config: ModeConfig, readonly info: MissionInfo) {
    super(battle, host, config);
  }
  get title(): string {
    return this.info.name.toUpperCase();
  }
  protected baseRows(): [string, string][] {
    const s = this.battle.stats;
    return [
      ['Aircraft destroyed', String(s.kills)],
      ['Balloons', String(s.balloons)],
      ['Ground targets', String(s.ground)],
      ['Gunnery', this.accuracy()],
      ['Score', String(this.score)],
    ];
  }
  protected finish(remarkWin: string, remarkLose: string): Report {
    const won = this.status === 'won';
    return {
      title: this.info.name,
      subtitle: `${this.info.place[this.team]} · ${this.info.date}`,
      outcome: won ? 'victory' : 'defeat',
      rows: this.baseRows(),
      remarks: won ? remarkWin : remarkLose,
      score: this.score,
    };
  }
  /** Check an objective off once, with the chime. */
  protected complete(i: number): void {
    const o = this.objectives[i];
    if (!o || o.done) return;
    o.done = true;
    this.host.cue('objective');
    this.host.notify('Objective complete', o.text, 3);
  }
}

/* ------------------------------------------------------------- 1. Dawn Patrol */

class DawnPatrol extends Mission {
  private kills = 0;
  private second = false;
  private secondT = 70;
  start(): void {
    this.spawnPlayer(true);
    this.wingmen(1, 0.6);
    this.dressAerodrome(this.home, 3);
    this.balloons(-1, 2);
    this.enemyFlight(2, this.enemyApproach(2600), this.player!.position, 0.35);
    this.objectives = [{ text: 'Shoot down enemy scouts', progress: '0 / 4', done: false }];
  }
  override planeDown(p: Plane, killer: Plane | null): void {
    if (p.team === this.enemy && killer?.team === this.team) this.kills += 1;
    super.planeDown(p, killer);
  }
  protected tick(dt: number): void {
    this.secondT -= dt;
    const alive = this.battle.planes.filter((q) => q.team === this.enemy && q.alive).length;
    if (!this.second && (alive === 0 || this.secondT <= 0)) {
      this.second = true;
      this.enemyFlight(2, this.enemyApproach(2400), this.player?.position ?? new THREE.Vector3(), 0.45);
      this.host.notify('More scouts', 'coming out of the sun', 3.5);
    }
    this.objectives[0].progress = `${Math.min(this.kills, 4)} / 4`;
    if (this.kills >= 4) {
      this.complete(0);
      this.win();
    }
  }
  report(): Report {
    return this.finish('The patrol cleared the sector at first light. Well done.',
      'The patrol was broken up over the lines.');
  }
}

/* --------------------------------------------------------- 2. Balloon Busting */

class BalloonBusting extends Mission {
  private targets: Target[] = [];
  private scrambled = false;
  start(): void {
    this.spawnPlayer(true);
    this.wingmen(1, 0.55);
    this.dressAerodrome(this.home, 2);
    this.targets = this.balloons(-1, 3);
    this.groundTargets(-1, ['aagun'], 3);
    this.objectives = [{ text: 'Burn the enemy kite balloons', progress: '0 / 3', done: false, marker: null }];
  }
  protected tick(): void {
    const down = this.targets.filter((t) => !t.alive).length;
    this.objectives[0].progress = `${down} / ${this.targets.length}`;
    const next = this.targets.find((t) => t.alive);
    this.objectives[0].marker = next ? next.position : null;
    if (down >= 1 && !this.scrambled) {
      this.scrambled = true;
      const p = this.player;
      this.enemyFlight(2, this.enemyApproach(1800), p?.position ?? new THREE.Vector3(), 0.5);
      this.host.notify('Defenders scrambled', 'two scouts climbing to meet you', 3.5);
    }
    if (down === this.targets.length) {
      this.complete(0);
      this.win();
    }
  }
  report(): Report {
    return this.finish('All three balloons went down in flames. The enemy is blind on this sector.',
      'The balloons survived to direct the guns another day.');
  }
}

/* ------------------------------------------------------------------ 3. Escort */

class Escort extends Mission {
  private bombers: Plane[] = [];
  private targets: Target[] = [];
  private bombed = false;
  private waves = 0;
  private waveT = 25;
  private homeT = -1;
  start(): void {
    const p = this.spawnPlayer(true);
    this.dressAerodrome(this.home, 2);
    this.targets = this.groundTargets(-1, ['dump', 'hq', 'artillery'], 4);
    const aim = this.targets[0]?.position ?? new THREE.Vector3(this.far.x, 0, this.far.z);
    const heavy = this.team === 'allied' ? 'dh4' : 'gotha';
    const n = this.team === 'allied' ? 3 : 2;
    const alt = p.position.y + 150;
    const route = [
      new THREE.Vector3(aim.x, alt, aim.z + 900),
      new THREE.Vector3(aim.x, alt, aim.z - 300),
      new THREE.Vector3(aim.x + 1200, alt, frontZ(aim.x + 1200) + 1800),
      new THREE.Vector3(this.home.x, alt, this.home.z - 600),
    ];
    for (let i = 0; i < n; i++) {
      const b = this.battle.spawn(heavy, this.team, {
        x: p.position.x + (i - (n - 1) / 2) * 70, y: alt + i * 10, z: p.position.z + 120 + i * 40,
        heading: p.heading, speed: 42, skill: 0.5, role: 'bomber', name: heavy === 'dh4' ? 'DH.4' : 'Gotha',
        orders: { kind: 'route', points: route.map((v) => v.clone().add(new THREE.Vector3((i - 1) * 60, 0, i * 40))), loop: false, speed: 40, index: 0 },
      });
      this.bombers.push(b);
    }
    this.wingmen(1, 0.6);
    this.objectives = [
      { text: 'Escort the bombers to the target', done: false },
      { text: 'Bring at least one bomber home', done: false },
    ];
  }
  protected tick(dt: number): void {
    const alive = this.bombers.filter((b) => b.alive);
    if (alive.length === 0) {
      this.objectives[this.bombed ? 1 : 0].failed = true;
      this.lose();
      return;
    }
    const lead = alive[0];
    this.objectives[0].marker = this.bombed ? null : lead.position;
    // Waves of interceptors while the bombers are on the way in and out.
    this.waveT -= dt;
    if (this.waveT <= 0 && this.waves < 3) {
      this.waves += 1;
      this.waveT = 55;
      const at = lead.position.clone().add(new THREE.Vector3(rand(-600, 600), rand(80, 200), -2000));
      this.enemyFlight(2 + this.waves, at, lead.position, 0.35 + this.waves * 0.1, {
        orders: { kind: 'hunt' },
      });
      this.host.notify('Interceptors', 'protect the bombers', 3);
    }
    // Bombs away over the target.
    for (const b of alive) {
      for (const t of this.targets) {
        if (!t.alive || b.bombs <= 0) continue;
        if (Math.hypot(b.position.x - t.position.x, b.position.z - t.position.z) < 160 && Math.random() < dt * 6) {
          this.battle.dropBomb(b);
          if (!this.bombed) {
            this.bombed = true;
            this.complete(0);
            this.host.notify('Bombs away', 'now get them home', 3);
          }
        }
      }
    }
    this.objectives[1].progress = `${alive.length} / ${this.bombers.length}`;
    if (this.bombed && this.homeT < 0) {
      const back = alive.some((b) => b.position.z > frontZ(b.position.x) + 600);
      if (back) this.homeT = 6;
    }
    if (this.homeT > 0) {
      this.homeT -= dt;
      if (this.homeT <= 0) {
        this.complete(1);
        this.win();
      }
    }
  }
  report(): Report {
    return this.finish('The bombers found their target and came home under your guns.',
      'The formation was cut to pieces before it could do its work.');
  }
}

/* --------------------------------------------------------- 4. Trench Strafing */

class TrenchStrafing extends Mission {
  private targets: Target[] = [];
  private need = 5;
  private patrolT = 80;
  private patrol = false;
  start(): void {
    this.spawnPlayer(true);
    this.dressAerodrome(this.home, 2);
    this.targets = this.groundTargets(-1, ['mgnest', 'artillery', 'lorry', 'dump'], 10);
    this.groundTargets(-1, ['aagun'], 3);
    this.need = Math.min(5, this.targets.length);
    this.wingmen(1, 0.55);
    this.objectives = [
      { text: 'Destroy positions along the enemy trenches', progress: `0 / ${this.need}`, done: false, marker: null },
    ];
  }
  protected tick(dt: number): void {
    const down = this.targets.filter((t) => !t.alive).length;
    this.objectives[0].progress = `${Math.min(down, this.need)} / ${this.need}`;
    const p = this.player;
    let near: Target | null = null;
    let nd = Infinity;
    for (const t of this.targets) {
      if (!t.alive || !p) continue;
      const d = t.position.distanceTo(p.position);
      if (d < nd) {
        nd = d;
        near = t;
      }
    }
    this.objectives[0].marker = near?.position ?? null;
    this.patrolT -= dt;
    if (!this.patrol && (this.patrolT <= 0 || down >= 2)) {
      this.patrol = true;
      this.enemyFlight(3, this.enemyApproach(2200), p?.position ?? new THREE.Vector3(), 0.45);
      this.host.notify('Enemy patrol', 'three scouts diving on you', 3.5);
    }
    if (down >= this.need) {
      this.complete(0);
      this.win();
    }
  }
  report(): Report {
    return this.finish('The line went quiet behind you. The infantry send their thanks.',
      'The positions still stand.');
  }
}

/* -------------------------------------------------------------- 5. Intercept */

class Intercept extends Mission {
  private raider: Target | null = null;
  private raiders: Plane[] = [];
  private limitZ = 2600;
  start(): void {
    const p = this.spawnPlayer(true);
    this.dressAerodrome(this.home, 3);
    const x = rand(-1200, 1200);
    const z = frontZ(x) - 3200;
    // Route above the highest ground between here and the home field.
    let peak = 0;
    for (let d = 0; d <= 9000; d += 300) peak = Math.max(peak, this.battle.ground(x, z + d));
    const alt = Math.max(peak + 380, p.position.y + 200);
    if (this.team === 'allied') {
      const zep = this.battle.addTarget(
        (this.raider = makeZeppelin(this.enemy, new THREE.Vector3(x, alt, z), Math.PI)));
      zep.velocity.set(0, 0, 21);
      this.objectives = [{ text: 'Bring down the Zeppelin before it crosses the lines', done: false, marker: zep.position }];
      this.host.notify('Zeppelin reported', 'crossing toward the aerodrome', 4);
    } else {
      const heading = headingTo(x, z, this.home.x, this.home.z);
      for (let i = 0; i < 4; i++) {
        const target = new THREE.Vector3(this.home.x, alt, this.home.z);
        this.raiders.push(this.battle.spawn('dh4', this.enemy, {
          x: x + (i - 1.5) * 70, y: alt + i * 12, z: z + Math.abs(i - 1.5) * 40, heading, speed: 42, skill: 0.55,
          role: 'bomber', name: 'DH.4',
          orders: { kind: 'route', points: [target, new THREE.Vector3(this.home.x, alt, this.home.z + 3000)], loop: false, speed: 42, index: 0 },
        }));
      }
      this.objectives = [{ text: 'Stop the bombers before they reach the aerodrome', progress: '0 / 4', done: false }];
      this.host.notify('Bombers reported', 'heading for our aerodrome', 4);
    }
    this.wingmen(1, 0.55);
    // Searchlights along our side of the line, to pick the raiders out.
    for (let i = 0; i < 5; i++) {
      const sx = x + (i - 2) * 700 + rand(-150, 150);
      const sz = frontZ(sx) + rand(900, 1800);
      this.battle.addTarget(makeGroundTarget('searchlight', this.team, sx, this.battle.ground(sx, sz), sz, 0));
    }
  }
  protected tick(dt: number): void {
    if (this.raider) {
      const z = this.raider;
      if (z.alive) {
        z.position.addScaledVector(z.velocity, dt);
        this.objectives[0].marker = z.position;
        if (z.position.z > this.limitZ) {
          this.objectives[0].failed = true;
          this.lose();
        }
      } else {
        this.complete(0);
        this.win();
      }
      return;
    }
    const alive = this.raiders.filter((b) => b.alive);
    this.objectives[0].progress = `${this.raiders.length - alive.length} / ${this.raiders.length}`;
    this.objectives[0].marker = alive[0]?.position ?? null;
    if (alive.length === 0) {
      this.complete(0);
      this.win();
    } else if (alive.some((b) => Math.hypot(b.position.x - this.home.x, b.position.z - this.home.z) < 300)) {
      this.objectives[0].failed = true;
      this.lose();
    }
  }
  report(): Report {
    return this.team === 'allied'
      ? this.finish('The airship came down burning across the lines, lighting the whole sky.',
        'The Zeppelin reached its target.')
      : this.finish('Not one of the raiders reached the aerodrome.', 'The raid got through.');
  }
}


/* ---------------------------------------------------------- 6. Aerodrome Raid */

class AerodromeRaid extends Mission {
  private hangars: Target[] = [];
  private parked: Plane[] = [];
  private scrambled = false;
  start(): void {
    this.spawnPlayer(true);
    this.dressAerodrome(this.home, 2);
    const dressed = this.dressAerodrome(this.far, 6);
    this.hangars = dressed.hangars;
    this.parked = dressed.planes;
    this.wingmen(2, 0.6);
    this.objectives = [
      { text: 'Destroy the hangars', progress: `0 / ${this.hangars.length}`, done: false, marker: new THREE.Vector3(this.far.x, this.far.elevation, this.far.z) },
      { text: 'Destroy parked machines', progress: `0 / ${this.parked.length}`, done: false, optional: true },
    ];
  }
  protected tick(): void {
    const p = this.player;
    if (!this.scrambled && p && Math.hypot(p.position.x - this.far.x, p.position.z - this.far.z) < 2200) {
      this.scrambled = true;
      // Three of the parked machines start up and take off.
      for (const q of this.parked.slice(0, 3)) {
        if (!q.alive) continue;
        q.role = '';
        q.throttle = 1;
        this.battle.setBrain(q, 0.5, { kind: 'hunt' });
      }
      this.host.notify('They are scrambling', 'catch them on the ground', 3.5);
    }
    const hd = this.hangars.filter((t) => !t.alive).length;
    const pd = this.parked.filter((q) => !q.alive).length;
    this.objectives[0].progress = `${hd} / ${this.hangars.length}`;
    this.objectives[1].progress = `${pd} / ${this.parked.length}`;
    if (pd === this.parked.length) this.complete(1);
    if (hd === this.hangars.length && this.hangars.length > 0) {
      this.complete(0);
      this.win();
    }
  }
  report(): Report {
    return this.finish('The aerodrome is burning. They will not fly from there for a week.',
      'The raid was beaten off.');
  }
}

/* --------------------------------------------------------------- 7. The Ace */

class TheAce extends Mission {
  private ace: Plane | null = null;
  start(): void {
    const p = this.spawnPlayer(true);
    this.wingmen(1, 0.62);
    this.dressAerodrome(this.home, 2);
    const flight = this.enemyFlight(3, this.enemyApproach(2600), p.position, 0.6, { ace: true });
    this.ace = flight[0];
    this.objectives = [{ text: `Bring down the ${this.ace.name.toLowerCase()}`, done: false, marker: this.ace.position }];
  }
  protected tick(): void {
    if (this.ace && !this.ace.alive) {
      this.complete(0);
      this.win();
    }
    this.objectives[0].marker = this.ace?.alive ? this.ace.position : null;
  }
  report(): Report {
    return this.finish('The ace went down behind the lines. The squadron will talk of little else.',
      'The ace flew home to paint another victory on the fuselage.');
  }
}

/* ------------------------------------------------------------------ the list */

export const MISSIONS: MissionInfo[] = [
  {
    id: 'dawn', name: 'Dawn Patrol', world: 'FLANDERS', seed: 1917, time: 'DAWN', weather: 'CLOUDS',
    place: { allied: 'Ypres Salient', central: 'Flanders' }, date: 'June 1917',
    briefing: {
      allied: 'Take the dawn patrol across the salient. Enemy scouts have been working the line at first light. Find them, engage, and clear the sector.',
      central: 'Fly the morning patrol over the salient. English scouts come over at first light. Meet them, and send them down.',
    },
    make: (b, h, c) => new DawnPatrol(b, h, c, MISSIONS[0]),
  },
  {
    id: 'balloons', name: 'Balloon Busting', world: 'SOMME', seed: 2204, time: 'MORNING', weather: 'HAZY',
    place: { allied: 'The Somme', central: 'Picardy' }, date: 'August 1917',
    briefing: {
      allied: 'Three enemy kite balloons are directing their guns onto our lines. Go in low and fast, set them alight, and get out before the Archie finds its range. They will winch them down when you come.',
      central: 'Three English observation balloons hang over their lines, spotting for the guns. Burn them. Expect heavy fire from the ground.',
    },
    make: (b, h, c) => new BalloonBusting(b, h, c, MISSIONS[1]),
  },
  {
    id: 'escort', name: 'Escort', world: 'ISONZO', seed: 3310, time: 'NOON', weather: 'CLOUDS',
    place: { allied: 'The Carso', central: 'The Karst Plateau' }, date: 'October 1917',
    briefing: {
      allied: 'A flight of DH.4s is going over to bomb a supply dump behind the Karst. Stay with them — there and back. The enemy will send everything at the bombers.',
      central: 'Our Gothas are going over to bomb the Italian supply dumps. Escort them to the target and bring them home.',
    },
    make: (b, h, c) => new Escort(b, h, c, MISSIONS[2]),
  },
  {
    id: 'strafe', name: 'Trench Strafing', world: 'VERDUN', seed: 4401, time: 'MORNING', weather: 'OVERCAST',
    place: { allied: 'Verdun', central: 'The Meuse Heights' }, date: 'March 1918',
    briefing: {
      allied: 'The infantry go over at noon. Before they do, strafe and bomb the machine-gun nests and batteries along the enemy line. Use your bombs (B). Keep moving — the ground fire is thick.',
      central: 'Support the attack: strafe the enemy trenches, their machine-gun nests and batteries. Drop your bombs (B) on the guns.',
    },
    make: (b, h, c) => new TrenchStrafing(b, h, c, MISSIONS[3]),
  },
  {
    id: 'intercept', name: 'Night Intercept', world: 'DOLOMITES', seed: 5521, time: 'DUSK', weather: 'CLEAR',
    place: { allied: 'The Dolomites', central: 'The Tyrol' }, date: 'May 1918',
    briefing: {
      allied: 'A Zeppelin has been reported crossing the mountains at dusk. Climb, find it, and bring it down before it reaches our lines. Its gunners are awake.',
      central: 'Enemy bombers are on their way to our aerodrome. Intercept them before they arrive. Their observers carry Lewis guns.',
    },
    make: (b, h, c) => new Intercept(b, h, c, MISSIONS[4]),
  },
  {
    id: 'raid', name: 'Aerodrome Raid', world: 'SINAI', seed: 6613, time: 'MORNING', weather: 'CLEAR',
    place: { allied: 'Sinai', central: 'Beersheba' }, date: 'November 1917',
    briefing: {
      allied: 'Hit the enemy aerodrome at dawn. Burn the hangars and catch their machines on the ground. Some will get off — deal with them.',
      central: 'Raid the English aerodrome. Destroy the hangars and the machines parked on the field before they can take off.',
    },
    make: (b, h, c) => new AerodromeRaid(b, h, c, MISSIONS[5]),
  },
  {
    id: 'ace', name: 'The Ace', world: 'SOMME', seed: 7121, time: 'GOLDEN', weather: 'CLOUDS',
    place: { allied: 'Morlancourt Ridge', central: 'The Somme' }, date: 'April 1918',
    briefing: {
      allied: 'The red triplane has been seen over the Somme with two of his flight. He is the best they have. Bring him down.',
      central: 'An English ace and his flight are hunting over the Somme. Find him before he finds another of ours.',
    },
    make: (b, h, c) => new TheAce(b, h, c, MISSIONS[6]),
  },
];
