'use client';

import { useEffect } from 'react';

/** Keep the screen awake only during an active voice turn. The OS remains in control. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let disposed = false;
    let requesting = false;
    let lock: WakeLockSentinel | undefined;
    const acquire = async () => {
      if (disposed || requesting || (lock && !lock.released) || document.visibilityState !== 'visible') return;
      requesting = true;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (disposed) await next.release();
        else lock = next;
      } catch { /* Unsupported, low battery or system policy: voice keeps working. */ }
      finally { requesting = false; }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
