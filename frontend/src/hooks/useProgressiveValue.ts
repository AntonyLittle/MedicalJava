import { useEffect, useMemo, useState } from 'react';

const REFINE_DELAY_MS = 150;

// Shows computePreview() immediately; once the callbacks stop changing, swaps in computeFull().
// Callers must memoize both callbacks on their inputs.
export function useProgressiveValue<T>(computePreview: () => T, computeFull: () => T, enabled: boolean): T {
  const preview = useMemo(() => computePreview(), [computePreview]);
  const [refined, setRefined] = useState<{ source: () => T; value: T }>();

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      setRefined({ source: computePreview, value: computeFull() });
    }, REFINE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, computePreview, computeFull]);

  return enabled && refined?.source === computePreview ? refined.value : preview;
}
