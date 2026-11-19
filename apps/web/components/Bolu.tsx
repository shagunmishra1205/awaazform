'use client';

import { useEffect, useRef } from 'react';
import { mountBolu, type BoluHandle, type BoluState } from '@/lib/bolu';
import { useSettings } from '@/lib/settings';

/** Animated Bolu. Decorative: screen readers hear the state from nearby text instead. */
export function Bolu({ size = 96, state = 'idle', level = 0, head = false }: { size?: number; state?: BoluState; level?: number; head?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const bolu = useRef<BoluHandle | null>(null);
  const { reduceMotion } = useSettings();
  useEffect(() => {
    bolu.current = mountBolu(ref.current!, { head, state, reduceMotion });
    return () => bolu.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head]);
  useEffect(() => bolu.current?.setState(state), [state]);
  useEffect(() => bolu.current?.setLevel(level), [level]);
  useEffect(() => bolu.current?.setReduceMotion(reduceMotion), [reduceMotion]);
  return <span ref={ref} aria-hidden className="inline-block" style={{ width: size, height: head ? size * (160 / 192) : size * (260 / 220) }} />;
}
