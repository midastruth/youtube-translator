/** Bound full-array writes while retaining completed cues on disconnect/error. */
export class TranslationCheckpoint {
  private dirty = 0;
  private lastWrite = Date.now();
  private save: () => Promise<void>;
  private batchSize: number;
  private intervalMs: number;
  constructor(save: () => Promise<void>, batchSize = 10, intervalMs = 2000) {
    this.save = save; this.batchSize = batchSize; this.intervalMs = intervalMs;
  }

  async update(count = 1): Promise<void> {
    this.dirty += count;
    if (this.dirty >= this.batchSize || Date.now() - this.lastWrite >= this.intervalMs) await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await this.save();
    this.dirty = 0;
    this.lastWrite = Date.now();
  }
}
