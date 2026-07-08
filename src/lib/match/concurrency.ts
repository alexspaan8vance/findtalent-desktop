/**
 * Tiny p-limit helper. Caps concurrent execution of async tasks.
 *
 * Use case: fan-out 8vance sub-resource fetches (profile/skills/etc.) for
 * a batch of match talents without hammering the rate-limiter.
 */

export type LimitedTask<T> = () => Promise<T>;

export interface Limiter {
  <T>(fn: LimitedTask<T>): Promise<T>;
}

/**
 * Returns a function that runs at most `concurrency` async tasks at the
 * same time. Subsequent calls queue and resolve in the order they were
 * scheduled. Throws if `concurrency` is not a positive integer.
 */
export function pLimit(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`pLimit: concurrency must be a positive integer (got ${concurrency})`);
  }

  let active = 0;
  const queue: Array<() => void> = [];

  function next(): void {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (!job) return;
    active += 1;
    job();
  }

  return function limited<T>(fn: LimitedTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        Promise.resolve()
          .then(fn)
          .then(
            (value) => {
              active -= 1;
              resolve(value);
              next();
            },
            (err: unknown) => {
              active -= 1;
              reject(err instanceof Error ? err : new Error(String(err)));
              next();
            },
          );
      };
      queue.push(run);
      next();
    });
  };
}
