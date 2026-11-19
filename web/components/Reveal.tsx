'use client';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** Rises into place the first time it scrolls into view. Final state is the default for reduced motion. */
export function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) { setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={`reveal ${className}`} data-in={seen} style={{ '--d': `${delay}ms` } as CSSProperties}>{children}</div>;
}
