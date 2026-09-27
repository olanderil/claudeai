/**
 * A coarse, lazily filled lattice over the terrain for the many cheap ground
 * queries a battle makes: rounds hitting the ground, AI look-ahead, flak
 * fuses, spray and dust. The real height function runs a stack of noise
 * octaves and hash lookups per call, which is fine for one aircraft at 120 Hz
 * and not fine for a thousand rounds.
 *
 * Interpolated bilinearly between 24 m lattice points; aircraft touching down
 * still use the exact height.
 */
export class HeightCache {
  private readonly cells = new Map<number, number>();
  private readonly waterCells = new Map<number, boolean>();

  constructor(
    private readonly exact: (x: number, z: number) => number,
    private readonly wet: (x: number, z: number) => boolean,
    private readonly step = 24,
  ) {}

  clear(): void {
    this.cells.clear();
    this.waterCells.clear();
  }

  private node(ix: number, iz: number): number {
    const key = (ix + 32768) * 65536 + (iz + 32768);
    let h = this.cells.get(key);
    if (h === undefined) {
      h = this.exact(ix * this.step, iz * this.step);
      this.cells.set(key, h);
    }
    return h;
  }

  height = (x: number, z: number): number => {
    const gx = x / this.step;
    const gz = z / this.step;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const a = this.node(ix, iz);
    const b = this.node(ix + 1, iz);
    const c = this.node(ix, iz + 1);
    const d = this.node(ix + 1, iz + 1);
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
  };

  water = (x: number, z: number): boolean => {
    const ix = Math.round(x / this.step);
    const iz = Math.round(z / this.step);
    const key = (ix + 32768) * 65536 + (iz + 32768);
    let w = this.waterCells.get(key);
    if (w === undefined) {
      w = this.wet(ix * this.step, iz * this.step);
      this.waterCells.set(key, w);
    }
    return w;
  };
}
