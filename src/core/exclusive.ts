/**
 * Wraps an async job so that only one runs at a time. The wrapper returns false, and does not
 * start the job, while an earlier one is still running.
 */
export function exclusive<A extends unknown[]>(job: (...args: A) => Promise<void>): (...args: A) => boolean {
  let busy = false;
  return (...args: A): boolean => {
    if (busy) return false;
    busy = true;
    let run: Promise<void>;
    try { run = job(...args); } catch (err) { busy = false; throw err; }
    void run.then(() => { busy = false; }, () => { busy = false; });
    return true;
  };
}
