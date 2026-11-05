import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchImportStatus } from '../api/client';
import type { ImportStatus } from '../api/types';

const POLL_INTERVAL_MS = 2000;

// Tracks the server's data-directory import. Polls while an import is running (e.g. the background import at
// server startup) and calls onImportFinished once it completes so callers can reload patients and volumes.
export function useImportStatus(onImportFinished: () => void) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [version, setVersion] = useState(0);
  const onFinishedRef = useRef(onImportFinished);
  const wasRunningRef = useRef(false);

  useEffect(() => {
    onFinishedRef.current = onImportFinished;
  }, [onImportFinished]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const next = await fetchImportStatus();
        if (cancelled) return;
        setStatus(next);
        if (wasRunningRef.current && !next.running) onFinishedRef.current();
        wasRunningRef.current = next.running;
        if (next.running) timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        // Status is informational; connection errors already surface through the patient/volume requests.
      }
    };
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  return { status, refresh };
}
