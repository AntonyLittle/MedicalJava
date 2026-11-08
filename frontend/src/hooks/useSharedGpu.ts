import { useSyncExternalStore } from 'react';
import { sharedGpu, type SharedGpu } from '../render3d/sharedGpu';

const noSubscription = () => () => {};
const noVersion = () => 0;

// The page's shared WebGL2 context (null without WebGL2) and its version, which changes when a lost context is
// restored and every GL object has to be recreated.
export function useSharedGpu(): { gpu: SharedGpu | null; version: number } {
  const gpu = sharedGpu();
  const version = useSyncExternalStore(gpu?.subscribe ?? noSubscription, gpu?.getVersion ?? noVersion);
  return { gpu, version };
}
