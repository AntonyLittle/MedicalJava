import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { LabelEdit } from '../segmentation/labelmap';
import { JobCancelledError, runJob } from '../segmentation/jobs';
import type { SegmentationSession } from '../segmentation/session';
import {
  DEFAULT_DISPLAY,
  DEFAULT_TOOLS,
  SegmentationContext,
  type SegmentationBusy,
  type SegmentationContextValue,
  type SegmentationDisplaySettings,
  type SegmentationToolSettings,
} from '../hooks/segmentationContext';

const noSubscription = () => () => {};
const noVersion = () => -1;

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

// Holds the segmentation being edited, the tool settings and long-running edits for every view below it. Ctrl+Z /
// Ctrl+Shift+Z (or Ctrl+Y) undo and redo; leaving the page with unsaved changes asks first.
export function SegmentationProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<SegmentationSession | null>(null);
  const version = useSyncExternalStore(session?.subscribe ?? noSubscription, session?.getVersion ?? noVersion);
  const [tools, setToolsState] = useState<SegmentationToolSettings>(DEFAULT_TOOLS);
  const [display, setDisplayState] = useState<SegmentationDisplaySettings>(DEFAULT_DISPLAY);
  const [busy, setBusy] = useState<SegmentationBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const setTools = useCallback((changes: Partial<SegmentationToolSettings>) => setToolsState((t) => ({ ...t, ...changes })), []);
  const setDisplay = useCallback(
    (changes: Partial<SegmentationDisplaySettings>) => setDisplayState((d) => ({ ...d, ...changes })),
    []
  );

  const setSession = useCallback((next: SegmentationSession | null) => {
    abortRef.current?.abort();
    setSessionState(next);
  }, []);

  const runTask = useCallback(async <T,>(description: string, job: Generator<number, T, void>): Promise<T | undefined> => {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy({ description, progress: 0 });
    let lastShown = 0;
    try {
      return await runJob(
        job,
        (progress) => {
          // Re-rendering on every slice would slow the job down.
          if (progress - lastShown >= 0.02 || progress === 1) {
            lastShown = progress;
            setBusy({ description, progress });
          }
        },
        controller.signal
      );
    } catch (e) {
      if (!(e instanceof JobCancelledError)) setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, []);

  const runEdit = useCallback(
    async <T,>(description: string, job: (edit: LabelEdit) => Generator<number, T, void>): Promise<T | undefined> => {
      if (!session || busyRef.current) return undefined;
      const edit = session.beginEdit(description);
      let completed = false;
      try {
        const result = await runTask(
          description,
          (function* () {
            const value = yield* job(edit);
            completed = true;
            return value;
          })()
        );
        return result;
      } finally {
        // A cancelled or failed edit is rolled back; a finished one becomes undoable.
        if (completed) session.commit(edit);
        else session.discard(edit);
      }
    },
    [session, runTask]
  );

  const confirmDiscard = useCallback(
    () => !session?.dirty || window.confirm('The segmentation has unsaved changes. Discard them?'),
    [session]
  );

  useEffect(() => {
    if (!session) return;
    const handleKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || isTextInput(e.target) || busyRef.current) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        session.undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        session.redo();
      }
    };
    const handleUnload = (e: BeforeUnloadEvent) => {
      if (session.dirty) e.preventDefault();
    };
    window.addEventListener('keydown', handleKey);
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, [session]);

  const value = useMemo<SegmentationContextValue>(
    () => ({
      session,
      version,
      setSession,
      tools,
      setTools,
      display,
      setDisplay,
      busy,
      runEdit,
      runTask,
      confirmDiscard,
      error,
      setError,
    }),
    [session, version, setSession, tools, setTools, display, setDisplay, busy, runEdit, runTask, confirmDiscard, error]
  );

  return <SegmentationContext value={value}>{children}</SegmentationContext>;
}
