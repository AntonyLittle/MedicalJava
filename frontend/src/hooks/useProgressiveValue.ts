import { useEffect, useMemo, useState } from 'react';

const REFINE_DELAY_MS = 150;
// Work per slice before yielding to the browser, so input and painting stay responsive.
const SLICE_BUDGET_MS = 8;

export type ProgressiveJob<T> = Generator<void, T, void>;

// For work that can't be split: it runs in a single slice.
export function* immediateJob<T>(compute: () => T): ProgressiveJob<T> {
  yield;
  return compute();
}

// Shows computePreview() immediately; once the callbacks stop changing, runs startFull() in time slices
// and swaps in its result. Changing inputs cancel the job. Callers must memoize both callbacks on their inputs.
export function useProgressiveValue<T>(
  computePreview: () => T,
  startFull: () => ProgressiveJob<T>,
  enabled: boolean
): T {
  const preview = useMemo(() => computePreview(), [computePreview]);
  const [refined, setRefined] = useState<{ source: () => T; value: T }>();

  useEffect(() => {
    if (!enabled) return;
    let sliceTimer: ReturnType<typeof setTimeout> | undefined;

    const startTimer = setTimeout(() => {
      const job = startFull();
      const runSlice = () => {
        const deadline = performance.now() + SLICE_BUDGET_MS;
        let result = job.next();
        while (!result.done && performance.now() < deadline) result = job.next();

        if (result.done) setRefined({ source: computePreview, value: result.value });
        else sliceTimer = setTimeout(runSlice, 0);
      };
      runSlice();
    }, REFINE_DELAY_MS);

    return () => {
      clearTimeout(startTimer);
      clearTimeout(sliceTimer);
    };
  }, [enabled, computePreview, startFull]);

  return enabled && refined?.source === computePreview ? refined.value : preview;
}
