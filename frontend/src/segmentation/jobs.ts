// Runs a generator job (see segmentation/algorithms) in time slices, so the page stays responsive. The job yields
// its progress (0..1) between chunks of work.

const SLICE_BUDGET_MS = 12;

export class JobCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'JobCancelledError';
  }
}

export function runJob<T>(
  job: Generator<number, T, void>,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const runSlice = () => {
      if (signal?.aborted) {
        reject(new JobCancelledError());
        return;
      }
      try {
        const deadline = performance.now() + SLICE_BUDGET_MS;
        let step = job.next();
        while (!step.done && performance.now() < deadline) step = job.next();
        if (step.done) {
          onProgress?.(1);
          resolve(step.value);
        } else {
          onProgress?.(step.value);
          setTimeout(runSlice, 0);
        }
      } catch (e) {
        reject(e);
      }
    };
    setTimeout(runSlice, 0);
  });
}

// Runs a job to completion synchronously (tests, small jobs).
export function runJobSync<T>(job: Generator<number, T, void>): T {
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}
