/** The tick rate the game runs logic at. */
export const DEFAULT_TPS = 60;
/** The most ticks one advance() runs, so that a long frame does not freeze the page. */
export const MAX_CATCH_UP_TICKS = 10;

/**
 * Turns elapsed time into logic ticks. It has no timer: the caller passes the frame time to
 * advance(). Pause stops advance(); step() runs one tick when paused or not.
 */
export class Clock {
  private tpsValue: number;
  private carry = 0;
  private pausedValue = false;

  constructor(private readonly onTick: () => void, opts: { tps?: number } = {}) {
    this.tpsValue = Clock.checkTps(opts.tps ?? DEFAULT_TPS);
  }

  private static checkTps(tps: number): number {
    if (!(tps > 0) || !Number.isFinite(tps)) throw new Error(`bad tick rate: ${tps}`);
    return tps;
  }

  /** Ticks per second. */
  get tps(): number {
    return this.tpsValue;
  }

  /** Sets ticks per second, for example 20 or 30 for a slower run. */
  setTps(tps: number): void {
    this.tpsValue = Clock.checkTps(tps);
  }

  get paused(): boolean {
    return this.pausedValue;
  }

  pause(): void {
    this.pausedValue = true;
    this.carry = 0;
  }

  resume(): void {
    this.pausedValue = false;
  }

  /** Runs one tick now. */
  step(): void {
    this.onTick();
  }

  /** Adds elapsed time and runs the ticks that are due. Returns the number of ticks it ran. */
  advance(ms: number): number {
    if (this.pausedValue || !(ms > 0)) return 0;
    const period = 1000 / this.tpsValue;
    this.carry += ms;
    let due = Math.floor(this.carry / period);
    this.carry -= due * period;
    if (due > MAX_CATCH_UP_TICKS) {
      due = MAX_CATCH_UP_TICKS;
      this.carry = 0;
    }
    for (let i = 0; i < due; i++) this.onTick();
    return due;
  }
}
