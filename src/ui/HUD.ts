import * as THREE from 'three';
import { M_TO_FT, MS_TO_KT, clamp, wrap360 } from '../util/math';
import type { Telemetry } from '../flight/FlightModel';
import type { Controls } from '../flight/Controls';

const GREEN = '#7dffb2';
const DIM = 'rgba(125, 255, 178, 0.45)';
const WARN = '#ff5f5f';
const CAUTION = '#ffcc55';
const WHITE = '#ffffff';
const WHITE_DIM = 'rgba(255, 255, 255, 0.66)';

/**
 * A transient headline over the HUD.
 *
 * Two tiers, because the useful part and the reference number want different
 * weight: "NEW WORLD  HIMALAYA" is what you read, and the seed is what you
 * write down if you want to come back to it.
 */
export interface HudMessage {
  text: string;
  /** Optional second line, smaller and dimmer, under the headline. */
  sub?: string;
  /** `warn` is the crash red; `info` (the default) is white. */
  tone?: 'warn' | 'info';
}

export interface HudStatus {
  cameraMode: string;
  assists: boolean;
  flightMode: string;
  paused: boolean;
  message: HudMessage | null;
  timeOfDay: string;
  fps: number;
  frameMs: number;
}

/**
 * Canvas-2D head-up display drawn over the 3D scene.
 *
 * The attitude elements (horizon, pitch ladder, flight-path marker) are derived
 * from the *camera*, not the aircraft, and the FPM is a real projection of the
 * velocity vector. That means the symbology stays truthful in every view rather
 * than only lining up in the cockpit.
 */
export class HUD {
  private readonly ctx: CanvasRenderingContext2D;
  /**
   * Pitch ladder, waterline and flight-path marker. Off by default: they sit in
   * the middle of the screen and clutter the view for most flying, so they are
   * opt-in from the Controls tab.
   */
  showCentreSymbology = false;
  private width = 0;
  private height = 0;
  private dpr = 1;

  private readonly _fwd = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _proj = new THREE.Vector3();
  private readonly _invQuat = new THREE.Quaternion();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('HUD requires a 2D canvas context');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
  }

  private resize = (): void => {
    this.dpr = Math.min(window.devicePixelRatio, 2);
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
  };

  draw(
    t: Telemetry,
    controls: Controls,
    camera: THREE.PerspectiveCamera,
    aircraftPosition: THREE.Vector3,
    velocity: THREE.Vector3,
    status: HudStatus,
  ): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1.4;
    ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';

    const cx = w / 2;
    const cy = h / 2;
    const focalPx = (h / 2) / Math.tan((camera.fov * Math.PI) / 360);

    // Camera-derived attitude, so symbology is valid in chase and orbit too.
    this._fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const camPitch = Math.asin(clamp(this._fwd.y, -1, 1));
    this._invQuat.copy(camera.quaternion).invert();
    this._up.set(0, 1, 0).applyQuaternion(this._invQuat);
    const camRoll = Math.atan2(this._up.x, this._up.y);

    if (this.showCentreSymbology) {
      this.drawPitchLadder(cx, cy, camPitch, camRoll, focalPx);
      this.drawFlightPathMarker(camera, aircraftPosition, velocity);
    }

    this.drawSpeedTape(96, cy, h * 0.46, t.ias * MS_TO_KT, t.mach);
    this.drawAltitudeTape(w - 96, cy, h * 0.46, t.altitude * M_TO_FT, t.verticalSpeed * M_TO_FT * 60);
    this.drawHeadingTape(cx, 42, Math.min(460, w * 0.44), t.heading);

    this.drawLeftBlock(t, controls);
    this.drawRightBlock(t, controls, status);
    this.drawWarnings(cx, cy, t, status);
  }

  // ---------------------------------------------------------------- attitude

  private drawPitchLadder(
    cx: number, cy: number, pitch: number, roll: number, focalPx: number,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    // Clip to a combiner-glass area so rolled ladder rungs and their labels
    // can't spill over the heading tape above or the speed/altitude tapes beside.
    const halfW = Math.min(300, this.width * 0.26);
    ctx.beginPath();
    ctx.rect(cx - halfW, 82, halfW * 2, this.height - 200);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-roll);
    ctx.strokeStyle = GREEN;
    ctx.fillStyle = GREEN;

    const DEG = Math.PI / 180;
    const offsetFor = (elevationDeg: number): number | null => {
      const delta = pitch - elevationDeg * DEG;
      if (Math.abs(delta) > 1.25) return null; // beyond ~72°, tan blows up
      return focalPx * Math.tan(delta);
    };

    // Horizon
    const hy = offsetFor(0);
    if (hy !== null) {
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(-460, hy);
      ctx.lineTo(-60, hy);
      ctx.moveTo(60, hy);
      ctx.lineTo(460, hy);
      ctx.stroke();
    }

    // Rungs every 5°, dashed below the horizon.
    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    for (let deg = -90; deg <= 90; deg += 5) {
      if (deg === 0) continue;
      const y = offsetFor(deg);
      if (y === null || Math.abs(y) > this.height * 0.5) continue;

      const major = deg % 10 === 0;
      const half = major ? 110 : 62;
      ctx.globalAlpha = major ? 0.85 : 0.55;
      ctx.setLineDash(deg < 0 ? [7, 6] : []);

      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.lineTo(-half + 22, y);
      ctx.moveTo(half - 22, y);
      ctx.lineTo(half, y);
      // Little vertical ticks pointing toward the horizon.
      const tick = deg > 0 ? 8 : -8;
      ctx.moveTo(-half, y);
      ctx.lineTo(-half, y + tick);
      ctx.moveTo(half, y);
      ctx.lineTo(half, y + tick);
      ctx.stroke();

      if (major) {
        const label = String(Math.abs(deg));
        ctx.textAlign = 'right';
        ctx.fillText(label, -half - 8, y);
        ctx.textAlign = 'left';
        ctx.fillText(label, half + 8, y);
      }
    }

    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.restore();

    // Fixed waterline pipper at screen centre.
    ctx.strokeStyle = GREEN;
    ctx.beginPath();
    ctx.moveTo(cx - 42, cy);
    ctx.lineTo(cx - 14, cy);
    ctx.moveTo(cx - 14, cy);
    ctx.lineTo(cx - 6, cy + 8);
    ctx.moveTo(cx + 6, cy + 8);
    ctx.lineTo(cx + 14, cy);
    ctx.moveTo(cx + 14, cy);
    ctx.lineTo(cx + 42, cy);
    ctx.stroke();
  }

  /** The velocity vector, projected — shows where the aircraft is actually going. */
  private drawFlightPathMarker(
    camera: THREE.PerspectiveCamera,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
  ): void {
    if (velocity.lengthSq() < 4) return;

    this._proj.copy(velocity).normalize().multiplyScalar(2000).add(position);
    // Reject points behind the camera; project() mirrors them otherwise.
    this._proj.project(camera);
    if (this._proj.z > 1) return;

    const x = (this._proj.x * 0.5 + 0.5) * this.width;
    const y = (-this._proj.y * 0.5 + 0.5) * this.height;
    if (x < 0 || x > this.width || y < 0 || y > this.height) return;

    const ctx = this.ctx;
    ctx.strokeStyle = GREEN;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.moveTo(x - 7, y);
    ctx.lineTo(x - 18, y);
    ctx.moveTo(x + 7, y);
    ctx.lineTo(x + 18, y);
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x, y - 15);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------- tapes

  private drawSpeedTape(x: number, cy: number, height: number, knots: number, mach: number): void {
    const ctx = this.ctx;
    const pxPerUnit = height / 200; // 200 kt visible across the tape

    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 54, cy - height / 2, 108, height);
    ctx.clip();

    ctx.strokeStyle = DIM;
    ctx.fillStyle = DIM;
    ctx.textAlign = 'right';

    const first = Math.floor((knots - 100) / 10) * 10;
    for (let v = first; v <= knots + 100; v += 10) {
      if (v < 0) continue;
      const y = cy + (knots - v) * pxPerUnit;
      const major = v % 50 === 0;
      ctx.beginPath();
      ctx.moveTo(x + 26, y);
      ctx.lineTo(x + 40, y);
      ctx.stroke();
      if (major) ctx.fillText(String(v), x + 20, y);
    }
    ctx.restore();

    this.drawReadoutBox(x, cy, Math.round(knots), 'right');

    ctx.fillStyle = DIM;
    ctx.textAlign = 'center';
    ctx.fillText('IAS  KT', x, cy - height / 2 - 16);
    if (mach > 0.2) {
      ctx.fillStyle = GREEN;
      ctx.fillText(`M ${mach.toFixed(2)}`, x, cy + height / 2 + 18);
    }
  }

  private drawAltitudeTape(
    x: number, cy: number, height: number, feet: number, fpm: number,
  ): void {
    const ctx = this.ctx;
    const pxPerUnit = height / 2000; // 2000 ft visible

    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 54, cy - height / 2, 108, height);
    ctx.clip();

    ctx.strokeStyle = DIM;
    ctx.fillStyle = DIM;
    ctx.textAlign = 'left';

    const first = Math.floor((feet - 1000) / 100) * 100;
    for (let v = first; v <= feet + 1000; v += 100) {
      const y = cy + (feet - v) * pxPerUnit;
      const major = v % 500 === 0;
      ctx.beginPath();
      ctx.moveTo(x - 40, y);
      ctx.lineTo(x - 26, y);
      ctx.stroke();
      if (major) ctx.fillText(String(v), x - 20, y);
    }
    ctx.restore();

    this.drawReadoutBox(x, cy, Math.round(feet), 'left');

    ctx.fillStyle = DIM;
    ctx.textAlign = 'center';
    ctx.fillText('ALT  FT', x, cy - height / 2 - 16);

    const climb = Math.round(fpm / 100) * 100;
    ctx.fillStyle = Math.abs(climb) > 50 ? GREEN : DIM;
    ctx.fillText(`${climb >= 0 ? '+' : ''}${climb} FPM`, x, cy + height / 2 + 18);
  }

  private drawHeadingTape(cx: number, y: number, width: number, heading: number): void {
    const ctx = this.ctx;
    const pxPerDeg = width / 60; // 60° across

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - width / 2, y - 20, width, 44);
    ctx.clip();

    ctx.strokeStyle = DIM;
    ctx.fillStyle = DIM;
    ctx.textAlign = 'center';

    const start = Math.floor((heading - 32) / 5) * 5;
    for (let d = start; d <= heading + 32; d += 5) {
      const px = cx + (d - heading) * pxPerDeg;
      const major = ((d % 10) + 10) % 10 === 0;
      ctx.beginPath();
      ctx.moveTo(px, y + 6);
      ctx.lineTo(px, major ? y + 16 : y + 12);
      ctx.stroke();
      if (major) {
        const label = CARDINALS[wrap360(d)] ?? String(wrap360(d) / 10).padStart(2, '0');
        ctx.fillText(label, px, y - 2);
      }
    }
    ctx.restore();

    // Centre caret + boxed heading.
    ctx.fillStyle = GREEN;
    ctx.strokeStyle = GREEN;
    ctx.beginPath();
    ctx.moveTo(cx, y + 20);
    ctx.lineTo(cx - 6, y + 28);
    ctx.lineTo(cx + 6, y + 28);
    ctx.closePath();
    ctx.fill();

    const text = String(Math.round(wrap360(heading))).padStart(3, '0');
    ctx.textAlign = 'center';
    ctx.strokeRect(cx - 26, y + 30, 52, 20);
    ctx.fillText(text, cx, y + 40);
  }

  /** Boxed current-value readout with a pointer toward the tape. */
  private drawReadoutBox(x: number, y: number, value: number, pointer: 'left' | 'right'): void {
    const ctx = this.ctx;
    const bw = 62;
    const bh = 24;
    const dir = pointer === 'right' ? 1 : -1;

    ctx.fillStyle = 'rgba(0, 12, 8, 0.55)';
    ctx.strokeStyle = GREEN;
    ctx.beginPath();
    ctx.moveTo(x + dir * 26, y);
    ctx.lineTo(x + dir * 34, y - 8);
    ctx.lineTo(x + dir * 34, y - bh / 2);
    ctx.lineTo(x + dir * (34 + bw), y - bh / 2);
    ctx.lineTo(x + dir * (34 + bw), y + bh / 2);
    ctx.lineTo(x + dir * 34, y + bh / 2);
    ctx.lineTo(x + dir * 34, y + 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = GREEN;
    ctx.font = 'bold 16px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(value), x + dir * (34 + bw / 2), y);
    ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
  }

  // ------------------------------------------------------------------ blocks

  private drawLeftBlock(t: Telemetry, controls: Controls): void {
    const ctx = this.ctx;
    const x = 34;
    let y = this.height - 150;

    ctx.textAlign = 'left';

    // Throttle bar, with the afterburner segment picked out in amber.
    const barW = 132;
    const barH = 10;
    ctx.strokeStyle = DIM;
    ctx.strokeRect(x, y, barW, barH);
    ctx.fillStyle = t.afterburner > 0 ? CAUTION : GREEN;
    ctx.fillRect(x + 1, y + 1, (barW - 2) * controls.throttle, barH - 2);
    // Afterburner detent at 90%.
    ctx.strokeStyle = CAUTION;
    ctx.beginPath();
    ctx.moveTo(x + barW * 0.9, y - 3);
    ctx.lineTo(x + barW * 0.9, y + barH + 3);
    ctx.stroke();

    ctx.fillStyle = GREEN;
    ctx.fillText(`THR ${Math.round(controls.throttle * 100)}%`, x + barW + 12, y + barH / 2);
    if (t.afterburner > 0.01) {
      ctx.fillStyle = CAUTION;
      ctx.fillText('AB', x + barW + 84, y + barH / 2);
    }

    y += 30;
    const rows: [string, string, string][] = [
      ['G', t.loadFactor.toFixed(1), t.loadFactor > 7.5 || t.loadFactor < -2 ? WARN : GREEN],
      ['AOA', `${(t.alpha * (180 / Math.PI)).toFixed(1)}°`, t.stalled ? WARN : GREEN],
      ['AGL', `${Math.round(t.agl * M_TO_FT)} ft`, t.agl < 150 && !t.onGround ? CAUTION : GREEN],
    ];
    for (const [label, value, color] of rows) {
      ctx.fillStyle = DIM;
      ctx.fillText(label, x, y);
      ctx.fillStyle = color;
      ctx.fillText(value, x + 46, y);
      y += 20;
    }

    if (controls.brake && t.onGround) {
      ctx.fillStyle = CAUTION;
      ctx.fillText('BRAKES', x, y);
    }
  }

  private drawRightBlock(t: Telemetry, controls: Controls, status: HudStatus): void {
    const ctx = this.ctx;
    const x = this.width - 34;
    let y = this.height - 150;

    const gear = controls.gearExtension;
    const gearLabel = gear > 0.99 ? 'DOWN' : gear < 0.01 ? 'UP' : 'MOVING';
    const gearColor = gear > 0.99 || gear < 0.01 ? GREEN : CAUTION;

    ctx.textAlign = 'right';
    const rows: [string, string, string][] = [
      ['VIEW', status.cameraMode, GREEN],
      ['MODE', status.flightMode, status.flightMode === 'CRUISE' ? CAUTION : GREEN],
      ['ASSIST', status.assists ? 'ON' : 'OFF', status.assists ? GREEN : CAUTION],
      ['GEAR', gearLabel, gearColor],
      ['WOW', t.onGround ? 'GROUND' : 'AIRBORNE', GREEN],
      ['TIME', status.timeOfDay, GREEN],
      ['FPS', `${Math.round(status.fps)}  ${status.frameMs.toFixed(1)}ms`, GREEN],
    ];
    for (const [label, value, color] of rows) {
      ctx.fillStyle = DIM;
      ctx.fillText(label, x - 96, y);
      ctx.fillStyle = color;
      ctx.fillText(value, x, y);
      y += 20;
    }
  }

  private drawWarnings(cx: number, cy: number, t: Telemetry, status: HudStatus): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    const blink = Math.floor(performance.now() / 320) % 2 === 0;

    if (status.message) {
      const { text, sub, tone } = status.message;
      ctx.font = 'bold 30px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = tone === 'warn' ? WARN : WHITE;
      ctx.fillText(text, cx, cy - 130);
      if (sub) {
        ctx.font = '15px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillStyle = tone === 'warn' ? WARN : WHITE_DIM;
        ctx.fillText(sub, cx, cy - 104);
      }
      ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
      return;
    }

    if (status.paused) {
      ctx.font = 'bold 26px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = GREEN;
      ctx.fillText('PAUSED', cx, cy - 130);
      ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
      return;
    }

    ctx.font = 'bold 20px ui-monospace, Menlo, Consolas, monospace';
    if (t.stalled && blink) {
      ctx.fillStyle = WARN;
      ctx.fillText('STALL', cx, cy - 130);
    }
    // Ground-proximity warning: low, descending, and not on approach speed.
    if (!t.onGround && t.agl < 250 && t.verticalSpeed < -12 && blink) {
      ctx.fillStyle = WARN;
      ctx.fillText('PULL UP', cx, cy + 150);
    }
    ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
  }
}

const CARDINALS: Record<number, string> = {
  0: 'N', 90: 'E', 180: 'S', 270: 'W',
};
