/**
 * Min / max by loop, for arrays whose length grows with the data (sessions, trades, configurations, bars).
 * `Math.min(...xs)` passes every element as a call argument and throws "Maximum call stack size exceeded" once xs
 * passes roughly 100k items. Same results as Math.min / Math.max, including NaN, empty input and signed zero.
 * The engine files in public/engine keep their own copy (they are plain scripts and cannot import this).
 */
export function maxOf(xs: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = +xs[i];
    if (x !== x) return NaN;
    if (x > m || (x === 0 && m === 0 && 1 / x > 0)) m = x;
  }
  return m;
}

export function minOf(xs: ArrayLike<number>): number {
  let m = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = +xs[i];
    if (x !== x) return NaN;
    if (x < m || (x === 0 && m === 0 && 1 / x < 0)) m = x;
  }
  return m;
}
