import { Mode, type Report } from './Mode';
import type { Plane } from '../combat/Plane';
import type { Target } from '../combat/Targets';

/**
 * Offensive patrol, endlessly: formations of enemy scouts come over the lines
 * in waves, each larger and sharper than the last, with an ace leading from
 * the third. Balloons over the enemy lines are there for the taking. Three
 * machines; land at the aerodrome to refit. Started from the field, you and
 * your wingman take off from the home runway, with a minute before the first
 * of them arrive.
 */
/** Seconds on the runway before the first wave, when starting from the field. */
const FIELD_GRACE = 50;

export class QuickBattle extends Mode {
  wave = 0;
  kills = 0;
  private clearT = 0;
  private clearing = false;
  private balloons_: Target[] = [];
  best = 0;

  get title(): string {
    return this.wave === 0 ? 'TAKE-OFF' : `WAVE ${this.wave}`;
  }

  start(): void {
    this.spawnPlayer(true);
    if (this.config.onField) this.scrambleFlight(1, 0.58);
    else this.wingmen(1, 0.58);
    this.balloons_ = this.balloons(-1, 3);
    this.balloons(1, 2, false);
    this.groundTargets(-1, ['aagun'], 3);
    this.dressAerodrome(this.home, 3);
    this.dressAerodrome(this.far, 4);
    this.objectives = [
      { text: 'Destroy enemy scouts', done: false },
      { text: 'Burn the kite balloons', done: false, optional: true },
    ];
    if (this.config.onField) {
      // Time to get off the ground and up before the first of them arrive.
      this.clearing = true;
      this.clearT = FIELD_GRACE;
      this.host.notify('On the line', `enemy scouts expected in about ${FIELD_GRACE} s — open the throttle (Shift or 0)`, 5);
    } else {
      this.nextWave();
    }
  }

  /** In the air over the home field, or waiting on its runway. */
  protected override spawnPlayer(first: boolean): Plane {
    return this.config.onField ? this.spawnOnRunway(first) : super.spawnPlayer(first);
  }

  private nextWave(): void {
    this.wave += 1;
    const n = this.wave;
    const count = Math.min(1 + n, 8);
    const at = this.enemyApproach();
    const skill = Math.min(0.26 + 0.09 * (n - 1), 0.85);
    const p = this.player;
    const flight = this.enemyFlight(count, at, p?.position ?? at, skill, { ace: n >= this.battle.level.aceWave });
    if (n > 1) for (const b of this.balloons_) if (!b.alive) this.respawnBalloon(b);
    const have = this.battle.planes.filter((q) => q.team === this.team && !q.isPlayer && q.alive && q.role !== 'parked').length;
    // Reinforcements join in the air, so only while there is someone up to join.
    if (p?.alive && p.state === 'flying' && have < (n >= 4 ? 2 : 1)) this.wingmen(1, 0.55 + n * 0.04);
    const brg = p ? Math.round(((Math.atan2(at.x - p.position.x, -(at.z - p.position.z)) * 180) / Math.PI + 360) % 360) : 0;
    this.host.notify(`Wave ${n}`, `${flight.length} scouts inbound · bearing ${String(brg).padStart(3, '0')}°`, 4.5);
  }

  private respawnBalloon(t: Target): void {
    t.alive = true;
    t.hp = t.maxHp;
    t.deadT = 0;
    t.position.copy(t.base);
    t.velocity.set(0, 0, 0);
    t.model.root.visible = true;
    t.model.setDestroyed(0);
  }

  override planeDown(p: Plane, killer: Plane | null): void {
    if (p.team === this.enemy && killer?.isPlayer && p.role !== 'parked') this.kills += 1;
    super.planeDown(p, killer);
  }

  protected tick(dt: number): void {
    this.stepFlight(dt);
    const enemies = this.battle.planes.some((q) => q.team === this.enemy && q.alive && q.role !== 'parked');
    if (!enemies && !this.clearing) {
      this.clearing = true;
      this.clearT = 6;
      const bonus = this.award(100 * this.wave);
      this.host.cue('objective');
      this.host.notify('Sector clear', `+${bonus} · more scouts inbound`, 4);
      const p = this.player;
      if (p?.alive) {
        p.hp = Math.min(p.maxHp, p.hp + 20);
        p.gun.ammo = Math.min(p.gun.maxAmmo, p.gun.ammo + 250);
      }
    }
    if (this.clearing) {
      this.clearT -= dt;
      if (this.clearT <= 0) {
        this.clearing = false;
        this.nextWave();
      }
    }
    const up = this.balloons_.filter((b) => b.alive).length;
    this.objectives[0].progress = `${this.kills}`;
    this.objectives[1].progress = `${this.balloons_.length - up} / ${this.balloons_.length}`;
    this.objectives[1].done = up === 0;
  }

  report(): Report {
    const s = this.battle.stats;
    const remark = this.kills === 0
      ? 'Pilot engaged the enemy but was unable to obtain a decisive result.'
      : this.kills < 5
        ? `Pilot engaged enemy scouts over the lines and sent ${this.kills} down.`
        : `Pilot fought ${this.wave} formations in succession and destroyed ${this.kills} enemy machines. Recommended for mention.`;
    return {
      title: 'Offensive Patrol',
      subtitle: 'Combats in the air',
      outcome: 'ended',
      rows: [
        ['Waves met', String(this.wave)],
        ['Scouts destroyed', String(this.kills)],
        ['Kite balloons', String(s.balloons)],
        ['Ground targets', String(s.ground)],
        ['Gunnery', this.accuracy()],
        ['Opponents', this.battle.level.name],
        ['Score', String(this.score)],
      ],
      remarks: remark,
      score: this.score,
    };
  }
}
