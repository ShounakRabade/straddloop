'use client';
import { useEffect, useRef, useState } from 'react';

/** Counts from the previous value to the new one, once per change. */
export function CountUp({ value, format }: { value: number; format: (v: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current, delta = value - start;
    if (!delta || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(value); from.current = value; return; }
    let raf = 0; const t0 = performance.now(), dur = 520;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      setShown(start + delta * e);
      if (k < 1) raf = requestAnimationFrame(tick); else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value]);
  return <>{format(shown)}</>;
}
