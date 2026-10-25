// SPDX-License-Identifier: GPL-3.0-only
export class RetryLoop {
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private running: number | undefined;
  private generation = 0;
  private attempts = 0;
  constructor(
    private attempt: () => Promise<void>,
    private report: (error: unknown) => void = () => {},
    private time = { set: setTimeout, clear: clearTimeout },
  ) {}
  enable() {
    this.active = true;
  }
  connected() {
    this.attempts = 0;
    if (this.timer) this.time.clear(this.timer);
    this.timer = undefined;
  }
  retry() {
    if (!this.active || this.timer || this.running === this.generation) return;
    const generation = this.generation,
      delay = Math.min(15000, 1000 * 2 ** Math.min(4, this.attempts++));
    this.timer = this.time.set(async () => {
      this.timer = undefined;
      if (!this.active || generation !== this.generation) return;
      this.running = generation;
      let failed = false;
      try {
        await this.attempt();
      } catch (error) {
        failed = true;
        this.report(error);
      } finally {
        if (this.running === generation) this.running = undefined;
        if (failed && generation === this.generation) this.retry();
      }
    }, delay);
  }
  stop() {
    this.active = false;
    this.generation++;
    if (this.timer) this.time.clear(this.timer);
    this.timer = undefined;
    this.attempts = 0;
  }
}
