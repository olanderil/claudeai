import { clamp, deadzone } from '../util/math';

/**
 * Normalised control input from keyboard, mouse and gamepad.
 *
 * Axis sign convention matches the flight model:
 *   pitch  +1 = nose up      (pull back)
 *   roll   +1 = roll right
 *   yaw    +1 = nose right
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly edges = new Set<string>();

  /** Virtual stick driven by relative mouse motion while pointer is locked. */
  private stickX = 0;
  private stickY = 0;
  private mouseActive = false;

  pitch = 0;
  roll = 0;
  yaw = 0;
  /** Throttle rate request, -1..1; integrated into a throttle setting by Controls. */
  throttleAxis = 0;
  brake = false;

  /**
   * Drag and wheel for the free camera, accumulated between frames.
   *
   * Deliberately separate from the virtual stick above. That one runs on
   * pointer lock and *is* the flying controls; this one is a plain drag on the
   * canvas and must never move the aeroplane — the two would otherwise fight
   * over the same mouse.
   */
  private dragX = 0;
  private dragY = 0;
  private wheelDelta = 0;
  private dragging = false;
  private dragShift = false;

  private gamepadIndex: number | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('gamepadconnected', this.onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.onGamepadDisconnected);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('gamepadconnected', this.onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    // Don't swallow browser shortcuts like Cmd+R / Ctrl+Shift+I.
    if (e.metaKey || (e.ctrlKey && e.shiftKey)) return;
    this.down.add(e.code);
    this.edges.add(e.code);
    if (SWALLOWED.has(e.code)) e.preventDefault();
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.mouseActive) return;
    this.dragging = true;
    this.dragShift = e.shiftKey;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragX += e.movementX;
    this.dragY += e.movementY;
    this.dragShift = e.shiftKey;
  };

  private onPointerUp = (): void => {
    this.dragging = false;
  };

  private onWheel = (e: WheelEvent): void => {
    // The canvas fills the window, so there is nothing to scroll; without this
    // a trackpad pinch zooms the page instead of the camera.
    e.preventDefault();
    this.wheelDelta += e.deltaY;
  };

  /** Drag and wheel since the last call, and whether shift was held. */
  takeCameraGesture(): { dx: number; dy: number; wheel: number; pan: boolean } {
    const gesture = { dx: this.dragX, dy: this.dragY, wheel: this.wheelDelta, pan: this.dragShift };
    this.dragX = 0;
    this.dragY = 0;
    this.wheelDelta = 0;
    return gesture;
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  /** Losing focus must release everything, or controls stick down. */
  private onBlur = (): void => {
    this.dragging = false;
    this.down.clear();
  };

  private onGamepadConnected = (e: GamepadEvent): void => {
    this.gamepadIndex = e.gamepad.index;
  };

  private onGamepadDisconnected = (e: GamepadEvent): void => {
    if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
  };

  private onPointerLockChange = (): void => {
    this.mouseActive = document.pointerLockElement === this.canvas;
    if (!this.mouseActive) {
      this.stickX = 0;
      this.stickY = 0;
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.mouseActive) return;
    const scale = 1 / 380;
    this.stickX = clamp(this.stickX + e.movementX * scale, -1, 1);
    this.stickY = clamp(this.stickY + e.movementY * scale, -1, 1);
  };

  requestMouseControl(): void {
    void this.canvas.requestPointerLock();
  }

  releaseMouseControl(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  get usingMouse(): boolean {
    return this.mouseActive;
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True once for each physical press. Cleared by `endFrame`. */
  wasPressed(code: string): boolean {
    return this.edges.has(code);
  }

  /** Sample all devices into the normalised axes. Call once per frame. */
  update(): void {
    // Two deliberately opposite pitch conventions, because both are intuitive to
    // different people: W/S is a stick (push forward = nose down, pull back = up),
    // while the arrow keys are direct (press up = nose up, press down = nose down).
    let pitch = axis(
      this.isDown('KeyS') || this.isDown('ArrowUp'),
      this.isDown('KeyW') || this.isDown('ArrowDown'),
    );
    let roll = axis(this.isDown('KeyD') || this.isDown('ArrowRight'), this.isDown('KeyA') || this.isDown('ArrowLeft'));
    let yaw = axis(this.isDown('KeyE'), this.isDown('KeyQ'));
    let throttle = axis(this.isDown('ShiftLeft') || this.isDown('ShiftRight'), this.isDown('ControlLeft') || this.isDown('ControlRight'));
    let brake = this.isDown('KeyB');

    if (this.mouseActive) {
      // Mouse stick self-centres slowly so the aircraft doesn't creep away.
      this.stickX *= 0.985;
      this.stickY *= 0.985;
      pitch = clamp(pitch - this.stickY, -1, 1);
      roll = clamp(roll + this.stickX, -1, 1);
    }

    const pad = this.gamepadIndex !== null ? navigator.getGamepads()[this.gamepadIndex] : null;
    if (pad) {
      // Right stick flies, left stick Y is throttle, shoulders are rudder.
      roll = clamp(roll + deadzone(pad.axes[2] ?? 0), -1, 1);
      pitch = clamp(pitch - deadzone(pad.axes[3] ?? 0), -1, 1);
      throttle = clamp(throttle - deadzone(pad.axes[1] ?? 0), -1, 1);
      const rl = pad.buttons[4]?.value ?? 0;
      const rr = pad.buttons[5]?.value ?? 0;
      yaw = clamp(yaw + rr - rl, -1, 1);
      brake = brake || (pad.buttons[0]?.pressed ?? false);
    }

    this.pitch = pitch;
    this.roll = roll;
    this.yaw = yaw;
    this.throttleAxis = throttle;
    this.brake = brake;
  }

  /** Clear one-shot edges. Call at the very end of the frame. */
  endFrame(): void {
    this.edges.clear();
  }
}

function axis(positive: boolean, negative: boolean): number {
  return (positive ? 1 : 0) - (negative ? 1 : 0);
}

/** Keys whose default browser behaviour (scroll, quick-find) would disrupt flying. */
const SWALLOWED = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Tab', 'Slash', 'Quote',
]);
