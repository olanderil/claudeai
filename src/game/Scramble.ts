import * as THREE from 'three';
import { clamp } from '../util/math';
import { fieldPoint, ridgeClearance } from '../world/Front';
import { Mode, headingTo, type Objective, type Report } from './Mode';
import type { Brain, Orders } from '../combat/Brain';
import type { Plane } from '../combat/Plane';
import type { Target } from '../combat/Targets';
import { FIGHTERS, TYPES } from '../combat/Types';

/**
 * Scramble: the alarm goes with the squadron on the ground.
 *
 * Enemy bombers and their escort are on the way to the aerodrome. You start
 * on the grass with the engine ticking over: open the throttle, get off the
 * ground and climb to meet them before they arrive, while the others scramble
 * after you and the field's own guns open up. Keep the hangars standing.
 * Between raids, land to refuel and rearm — a clean three-pointer is worth
 * points. The raids keep coming, each heavier, until the hangars are burning
 * or there are no machines left.
 */

/** Cruise of a loaded bomber on its way in, m/s. */
const BOMBER_SPEED = 42;
/** A scout's steady climb, m/s — what the warning time is sized against. */
const CLIMB = 6;
/** Seconds between one raid being beaten off and the next alarm. */
const RAID_GAP = 55;
/** How far past the field a raid that has turned for home is let go, m. */
const ESCAPED = 6000;

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

export class Scramble extends Mode {
  raid = 0;
  bombersDown = 0;
  fightersDown = 0;
  landings = 0;
  greasers = 0;
  private hangars: Target[] = [];
  private bombers: Plane[] = [];
  private escorts: Plane[] = [];
  private readonly flight: { plane: Plane; wait: number }[] = [];
  /** Bombs each bomber still means to drop on this pass. */
  private readonly stick = new Map<Plane, number>();
  /** Seconds to the next bomb of a stick that has begun falling. */
  private readonly releaseT = new Map<Plane, number>();
  /** Raiders from earlier raids, still on their way home. */
  private leaving: Plane[] = [];
  private bombedThisRaid = false;
  private raidOn = false;
  private nextRaidT = -1;
  private ordersT = 0;
  /** Seconds the player has been airborne since leaving the ground. */
  private airborneT = 0;
  private wasFlying = false;
  private burning = false;
  /** Where the bombers are aiming: the middle of the hangar row. */
  private readonly aim = new THREE.Vector3();
  private readonly raidFrom = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();

  get title(): string {
    return this.raid > 0 ? `RAID ${this.raid}` : 'SCRAMBLE';
  }

  start(): void {
    const dressed = this.dressAerodrome(this.home, 3);
    this.hangars = dressed.hangars;
    const mid = this.hangars.length > 0 ? this.hangars[Math.floor(this.hangars.length / 2)].position : null;
    this.aim.set(mid?.x ?? this.home.x, this.home.elevation, mid?.z ?? this.home.z);
    this.spawnPlayer(true);
    this.scrambleFlight(2);
    this.objectives = [
      { text: 'Get airborne', done: false },
      { text: 'Stop the raid', done: false, marker: null },
      { text: 'Hold the aerodrome', done: false },
      { text: 'Land to refuel between raids', done: false, optional: true },
    ];
    this.launchRaid();
    this.host.notify('Scramble!', 'raid inbound — full throttle (Shift or 0) and get off the ground', 5.5);
  }

  /* ---------------------------------------------------------------- spawning */

  /** On the grass at the downwind end, facing the take-off run, engine idling. */
  protected override spawnPlayer(first: boolean): Plane {
    const b = this.battle;
    if (b.player) b.remove(b.player);
    const h = this.home;
    const at = fieldPoint(h, -h.halfLength + 45, 0);
    const p = b.spawn(this.config.aircraft, this.team, {
      x: at.x, y: 0, z: at.z, heading: -(h.headingDeg * Math.PI) / 180,
      parked: true, isPlayer: true, livery: this.config.livery,
    });
    p.rpm = 0.2;
    this.airborneT = 0;
    this.wasFlying = false;
    this.host.playerSpawned(p);
    if (!first) this.host.notify('A fresh machine on the line', `${this.lives} remaining — get it up`, 3.5);
    return p;
  }

  /** The rest of the flight, on the grass beside you, rolling a few seconds apart. */
  private scrambleFlight(count: number): void {
    const h = this.home;
    const heading = -(h.headingDeg * Math.PI) / 180;
    const slots: [number, number][] = [[-12, 34], [-24, -34], [-36, 68]];
    const types = FIGHTERS[this.team];
    for (let i = 0; i < count; i++) {
      const [along, right] = slots[i % slots.length];
      const at = fieldPoint(h, -h.halfLength + 45 + along, right);
      const w = this.battle.spawn(types[i % types.length], this.team, {
        x: at.x, y: 0, z: at.z, heading, parked: true, livery: 'standard', name: 'Wingman',
      });
      w.rpm = 0.2;
      this.flight.push({ plane: w, wait: 5 + i * 3.5 });
    }
  }

  /**
   * A raid: bombers in a vee with fighters above, coming from the enemy's
   * side at a height that clears the ground between, far enough out that a
   * scout scrambling now can climb to meet them — just.
   */
  private launchRaid(): void {
    this.raid += 1;
    const n = this.raid;
    const b = this.battle;
    const h = this.home;
    // From the enemy's side, by the lowest way in: a fan of bearings round the
    // line to his aerodrome, each judged by the highest ground under it as far
    // out as his field. In the mountains that finds the pass; on the plain it
    // hardly matters.
    const reach = Math.max(6000, Math.hypot(this.far.x - h.x, this.far.z - h.z));
    const base = Math.atan2(this.far.x - h.x, this.far.z - h.z);
    let ux = Math.sin(base);
    let uz = Math.cos(base);
    let low = Infinity;
    for (const off of [0, -0.3, 0.3, -0.6, 0.6]) {
      const a = base + off + rand(-0.08, 0.08);
      const cx = Math.sin(a);
      const cz = Math.cos(a);
      // A little penalty for coming in wide, so the plain gets a straight raid.
      const top = ridgeClearance(h.x + cx * reach, h.z + cz * reach, h.x, h.z) + Math.abs(off) * 150;
      if (top < low) {
        low = top;
        ux = cx;
        uz = cz;
      }
    }
    // The height that clears the way in, and the warning a scout needs to
    // climb to it — which sets how far out the raid should be reported.
    const alt = Math.max(h.elevation + rand(650, 850),
      ridgeClearance(h.x + ux * reach, h.z + uz * reach, h.x, h.z) + 260);
    const warning = n === 1
      ? clamp((alt - h.elevation) / CLIMB + 70, 150, 320)
      : clamp(((alt - h.elevation) / CLIMB) * 0.6 + 60, 110, 240);
    // But never from behind higher ground than that: walk out along the
    // bearing and stop where the way in would have to climb. In the Alps
    // that is the far side of their own valley.
    let dist = Math.min(reach, warning * BOMBER_SPEED);
    for (let d = dist + 500; d <= warning * BOMBER_SPEED; d += 500) {
      if (ridgeClearance(h.x + ux * d, h.z + uz * d, h.x, h.z) + 260 > alt + 120) break;
      dist = d;
    }
    const sx = h.x + ux * dist;
    const sz = h.z + uz * dist;
    this.raidFrom.set(sx, alt, sz);
    const heading = headingTo(sx, sz, this.aim.x, this.aim.z);
    const fx = -Math.sin(heading);
    const fz = -Math.cos(heading);
    const heavy = this.enemy === 'central' ? 'gotha' : 'dh4';
    const count = Math.min(2 + Math.floor(n / 2), 4);
    // Last raid's stragglers are still let go when they are clear.
    for (const q of [...this.bombers, ...this.escorts]) if (q.alive) this.leaving.push(q);
    this.bombers = [];
    this.stick.clear();
    this.releaseT.clear();
    // Each bomber has a hangar of its own to aim at.
    const standing = this.hangars.filter((t) => t.alive);
    for (let i = 0; i < count; i++) {
      const lat = (i - (count - 1) / 2) * 70;
      const back = Math.abs(i - (count - 1) / 2) * 45;
      const x = sx - fz * lat - fx * back;
      const z = sz + fx * lat - fz * back;
      const off = new THREE.Vector3(-fz * lat, i * 10, fx * lat);
      const bomber = b.spawn(heavy, this.enemy, {
        x, y: alt + i * 10, z, heading, speed: BOMBER_SPEED, skill: 0.5, role: 'bomber',
        name: TYPES[heavy].short,
        orders: {
          kind: 'route', loop: false, speed: BOMBER_SPEED, index: 0,
          // Over the hangars, then straight back the way they came: an
          // overshoot would put a valley aerodrome's bombers into its walls.
          points: [this.bomberAim(standing, i, count, alt), this.raidFrom.clone().add(off)],
        },
      });
      this.bombers.push(bomber);
      this.stick.set(bomber, Math.min(bomber.bombs, heavy === 'gotha' ? 6 : 4));
    }
    // The escort, weaving above and behind the bombers.
    const lead = this.bombers[0];
    const escortCount = Math.min(1 + Math.ceil(n / 2), 5);
    const at = new THREE.Vector3(sx - fx * 150, alt + 160, sz - fz * 150);
    this.escorts = this.enemyFlight(escortCount, at, new THREE.Vector3(this.aim.x, alt, this.aim.z),
      Math.min(0.42 + n * 0.06, 0.85), { ace: n >= this.battle.level.aceWave + 1 });
    this.escorts.forEach((e, i) => {
      const brain = e.brain as Brain | null;
      if (!brain) return;
      const s = i % 2 === 0 ? 1 : -1;
      brain.orders = {
        kind: 'escort', leader: lead,
        slot: new THREE.Vector3(s * (70 + 35 * i), 70 + 25 * i, 60 + 40 * i),
        range: 1400,
      };
    });
    // The whole approach has to be inside the arena, or the pilots turn back.
    b.arenaRadius = Math.max(b.arenaRadius,
      Math.hypot(sx - b.arenaCentre.x, sz - b.arenaCentre.z) + 2500);
    this.raidOn = true;
    this.bombedThisRaid = false;
    this.objectives[1].done = false;
    this.objectives[1].marker = lead.position;
    this.host.cue('alarm');
    if (n > 1) {
      const eta = Math.round(warning / 10) * 10;
      this.host.notify(`Raid ${n} reported`, `${count} bombers and escort · about ${eta} seconds out`, 5);
    }
  }

  /** Over one of the hangars still standing, spread across the row. */
  private bomberAim(standing: Target[], i: number, count: number, alt: number): THREE.Vector3 {
    if (standing.length === 0) return this.aim.clone().setY(alt);
    const t = standing[Math.floor(((i + 0.5) / count) * standing.length) % standing.length];
    return new THREE.Vector3(t.position.x, alt, t.position.z);
  }

  /* -------------------------------------------------------------------- tick */

  protected tick(dt: number): void {
    const p = this.player;
    this.stepFlight(dt, p);
    this.trackAirborne(dt, p);
    if (this.raidOn) this.stepRaid(dt);
    else if (this.nextRaidT > 0) {
      this.nextRaidT -= dt;
      if (this.nextRaidT <= 0) this.launchRaid();
      else this.objectives[1].progress = `next raid ${clock(this.nextRaidT)}`;
    }
    this.clearAway();

    const standing = this.hangars.filter((t) => t.alive).length;
    this.objectives[2].progress = `${standing} / ${this.hangars.length} hangars`;
    if (standing === 0 && this.hangars.length > 0 && !this.burning) {
      this.burning = true;
      this.objectives[2].failed = true;
      this.host.notify('The aerodrome is burning', 'every hangar is down', 4.5);
      this.lose();
    }
  }

  /** Wingmen: roll when their turn comes, then cover the field or the player. */
  private stepFlight(dt: number, p: Plane | null): void {
    this.ordersT -= dt;
    const reorder = this.ordersT <= 0;
    if (reorder) this.ordersT = 1.5;
    const h = this.home;
    for (const f of this.flight) {
      const w = f.plane;
      if (!w.alive) continue;
      if (!w.brain) {
        f.wait -= dt;
        if (f.wait > 0) continue;
        // Off the ground and straight out along the field.
        const out = fieldPoint(h, h.halfLength + 1600, 0);
        this.battle.setBrain(w, 0.62, {
          kind: 'route', loop: false, speed: 48, index: 0,
          points: [new THREE.Vector3(out.x, h.elevation + 450, out.z)],
        });
        w.throttle = 1;
        continue;
      }
      if (!reorder || w.state !== 'flying') continue;
      const brain = w.brain as Brain;
      const agl = w.position.y - this.battle.ground(w.position.x, w.position.z);
      if (brain.orders.kind === 'route' && agl < 250) continue;
      // With the player up, fly on his wing; with him on the ground, over the field.
      const playerUp = p !== null && p.alive && p.state === 'flying'
        && p.position.y - this.battle.ground(p.position.x, p.position.z) > 120;
      const want: Orders['kind'] = playerUp ? 'escort' : 'patrol';
      if (brain.orders.kind === want) continue;
      const i = this.flight.indexOf(f);
      brain.orders = playerUp && p
        ? { kind: 'escort', leader: p, slot: new THREE.Vector3(i % 2 ? -40 : 40, 6 + i * 4, 30 + i * 20), range: 1600 }
        : { kind: 'patrol', centre: new THREE.Vector3(h.x, h.elevation + 700, h.z), radius: 900, engage: 3000 };
    }
  }

  /** Airborne time, the first take-off, and the vertical speed for the landing. */
  private trackAirborne(dt: number, p: Plane | null): void {
    if (!p || !p.alive) return;
    const flying = p.state === 'flying';
    if (flying) this.airborneT += dt;
    if (flying && !this.wasFlying && !this.objectives[0].done) {
      this.objectives[0].done = true;
      this.host.cue('objective');
      this.host.notify('Airborne', 'climb — they are above you', 2.5);
    }
    this.wasFlying = flying;
  }

  private stepRaid(dt: number): void {
    const alive = this.bombers.filter((q) => q.alive);
    const lead = alive[0] ?? null;
    const o = this.objectives[1];
    o.marker = lead?.position ?? null;
    if (lead && !this.bombedThisRaid) {
      const d = Math.hypot(lead.position.x - this.aim.x, lead.position.z - this.aim.z);
      const v = Math.max(Math.hypot(lead.velocity.x, lead.velocity.z), 20);
      o.progress = `ETA ${clock(d / v)} · ${this.bombers.length - alive.length} / ${this.bombers.length} down`;
    } else {
      o.progress = `${this.bombers.length - alive.length} / ${this.bombers.length} down`;
    }

    // Bombs: released so they fall on the hangars, not past them — the
    // bomb-aimer leads the target by the drop's own travel.
    for (const q of alive) {
      const left = this.stick.get(q) ?? 0;
      if (left <= 0 || q.bombs <= 0) continue;
      const agl = Math.max(q.position.y - this.battle.ground(q.position.x, q.position.z), 1);
      // Air drag bleeds a falling bomb's speed (2 % a second), so it travels
      // v(1 - e^-kt)/k rather than v·t before it lands.
      const fall = Math.sqrt((2 * agl) / 9.81) * 1.04;
      const carry = (1 - Math.exp(-0.02 * fall)) / 0.02;
      this._p.copy(q.position).addScaledVector(q.velocity, carry);
      const near = (r: number): boolean => this.hangars.some((t) => t.alive
        && Math.hypot(this._p.x - t.position.x, this._p.z - t.position.z) < r);
      // A stick: the first bomb when the sight comes on a hangar, then one
      // every third of a second while it walks across the row.
      let wait = this.releaseT.get(q);
      if (wait === undefined) {
        if (!near(55)) continue;
        wait = 0;
      }
      wait -= dt;
      if (wait <= 0 && near(120)) {
        this.battle.dropBomb(q);
        this.stick.set(q, left - 1);
        wait = 0.33;
        if (!this.bombedThisRaid) {
          this.bombedThisRaid = true;
          this.host.notify('Bombs falling on the field', undefined, 2.4);
        }
      }
      this.releaseT.set(q, wait);
    }

    // Over when the bombers are down, or have turned for home and gone.
    const gone = alive.every((q) => {
      const r = q.brain as Brain | null;
      const route = r?.orders.kind === 'route' ? r.orders : null;
      return route !== null && route.index >= 1
        && Math.hypot(q.position.x - this.home.x, q.position.z - this.home.z) > ESCAPED * 0.6;
    });
    if (alive.length === 0 || gone) this.endRaid(alive.length === 0);
  }

  private endRaid(allDown: boolean): void {
    this.raidOn = false;
    this.nextRaidT = RAID_GAP;
    for (const e of this.escorts) {
      const brain = e.brain as Brain | null;
      if (e.alive && brain) brain.retreat = true;
    }
    const standing = this.hangars.filter((t) => t.alive).length;
    if (allDown) {
      this.objectives[1].done = true;
      const bonus = this.award(150 * this.raid + 40 * standing);
      this.host.cue('objective');
      this.host.notify('Raid beaten off', `+${bonus} · land to refuel before the next one`, 5);
    } else {
      this.host.notify('The raiders have turned for home', 'land to refuel before the next one', 4.5);
    }
    this.objectives[3].done = false;
  }

  /** Raiders and escorts that got away are let go once they are well clear. */
  private clearAway(): void {
    const b = this.battle;
    this.leaving = this.leaving.filter((q) => q.alive && b.planes.includes(q));
    for (const q of [...this.bombers, ...this.escorts, ...this.leaving]) {
      if (!q.alive || b.player === q) continue;
      const brain = q.brain as Brain | null;
      const leaving = brain?.retreat === true || (brain?.orders.kind === 'route' && brain.orders.index >= 1);
      if (leaving && Math.hypot(q.position.x - this.home.x, q.position.z - this.home.z) > ESCAPED) b.remove(q);
    }
  }

  /* ------------------------------------------------------------ events */

  override planeDown(p: Plane, killer: Plane | null): void {
    if (p.team === this.enemy && killer?.isPlayer) {
      if (p.role === 'bomber') this.bombersDown += 1;
      else if (p.role !== 'parked') this.fightersDown += 1;
    }
    super.planeDown(p, killer);
  }

  /**
   * Touchdown. A landing on the home field after a proper sortie is graded by
   * how hard the wheels met the grass: a three-pointer, a fair one, or a
   * thump that the riggers will hear about.
   */
  override landed(p: Plane): void {
    if (!p.isPlayer) return;
    const h = this.home;
    const onField = Math.hypot(p.position.x - h.x, p.position.z - h.z) < h.halfLength + 150;
    const sortie = this.airborneT;
    this.airborneT = 0;
    if (!onField || sortie < 40) {
      this.host.notify('Wheels down', undefined, 1.4);
      return;
    }
    this.landings += 1;
    const sink = -p.velocity.y;
    if (sink < 1.6) {
      this.greasers += 1;
      this.host.notify('A three-pointer', `+${this.award(150)} · taxi to a stop to refit`, 3);
    } else if (sink < 3.2) {
      this.host.notify('Good landing', `+${this.award(60)} · taxi to a stop to refit`, 3);
    } else {
      this.host.notify('Heavy landing', 'the riggers will have words — stop to refit', 3);
    }
    const o: Objective = this.objectives[3];
    if (!o.done) {
      o.done = true;
      this.host.cue('objective');
    }
  }

  report(): Report {
    const standing = this.hangars.filter((t) => t.alive).length;
    const remarks = this.burning
      ? `The aerodrome was bombed out after ${this.raid} ${this.raid === 1 ? 'raid' : 'raids'}. ${this.bombersDown} bombers were brought down.`
      : this.bombersDown === 0
        ? 'Pilot went up against the raiders but could not get at the bombers.'
        : `Pilot met ${this.raid} ${this.raid === 1 ? 'raid' : 'raids'} over the aerodrome and brought down ${this.bombersDown} ${this.bombersDown === 1 ? 'bomber' : 'bombers'}. The field is still ours.`;
    return {
      title: 'Scramble',
      subtitle: 'Defence of the aerodrome',
      outcome: this.burning ? 'defeat' : 'ended',
      rows: [
        ['Raids met', String(this.raid)],
        ['Bombers destroyed', String(this.bombersDown)],
        ['Escorts destroyed', String(this.fightersDown)],
        ['Hangars standing', `${standing} / ${this.hangars.length}`],
        ['Clean landings', `${this.greasers} of ${this.landings}`],
        ['Gunnery', this.accuracy()],
        ['Opponents', this.battle.level.name],
        ['Score', String(this.score)],
      ],
      remarks,
      score: this.score,
    };
  }
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
