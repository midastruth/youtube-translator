const cell = new Int32Array(new SharedArrayBuffer(4));

/** Block the current thread for `ms` milliseconds. */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(cell, 0, 0, ms);
}
