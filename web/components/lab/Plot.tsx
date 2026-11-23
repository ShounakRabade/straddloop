'use client';
/**
 * Lab charts: line/area, bars and histograms drawn at the real pixel width (so text stays readable), with a
 * crosshair readout that works by pointer and by arrow keys. They plot what they are given; no smoothing.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { shortDate } from '@/lib/format';
import { maxOf, minOf } from '@/lib/stats';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** About `n` round ticks covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!isFinite(lo) || !isFinite(hi)) return [];
  if (hi === lo) return [lo];
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f >= 5 ? 10 : f >= 2 ? 5 : f >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export const compactInr = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)}cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${s}₹${Math.round(a)}`;
};

type Pt = { d: string; v: number | null };
/** A shaded stretch of the x axis (point indices, end exclusive), e.g. the training, validation and test windows. */
export type Band = { from: number; to: number; label: string; tone: 'a' | 'b' | 'c' };
/** Further lines drawn over the first, for comparing up to four series on the same dates. */
export type Extra = { points: Pt[]; label: string };

function useCursor(n: number) {
  const [i, setI] = useState<number | null>(null);
  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); setI((x) => Math.min(n - 1, (x ?? -1) + 1)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setI((x) => Math.max(0, (x ?? n) - 1)); }
    if (e.key === 'Home') { e.preventDefault(); setI(0); }
    if (e.key === 'End') { e.preventDefault(); setI(n - 1); }
    if (e.key === 'Escape') setI(null);
  };
  return { i, setI, onKey };
}

/** A time series. `area`: 'signed' shades above zero green and below red; 'neutral' shades under the line.
 *  `bands` shade stretches of the x axis; `extra` adds lines (each its own style, named in the readout). */
export function LinePlot({ points, second, area = 'signed', fmt, axisFmt = compactInr, label, height = 280, secondLabel, zero = true, bands, extra, firstLabel }: {
  points: Pt[]; second?: Pt[]; area?: 'signed' | 'neutral' | 'none'; fmt: (v: number) => string; axisFmt?: (v: number) => string;
  label: string; height?: number; secondLabel?: string; zero?: boolean; bands?: Band[]; extra?: Extra[]; firstLabel?: string;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const { i, setI, onKey } = useCursor(points.length);
  const H = height, L = 58, R = 12, T = 12, B = 26;
  const geo = useMemo(() => {
    const vals = [...points, ...(second ?? []), ...(extra ?? []).flatMap((e) => e.points)].map((p) => p.v).filter((v): v is number => v != null && isFinite(v));
    if (!vals.length) return null;
    let lo = minOf(vals), hi = maxOf(vals);
    if (zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
    const x = (k: number) => L + (points.length < 2 ? (W - L - R) / 2 : (k / (points.length - 1)) * (W - L - R));
    const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const path = (ps: Pt[]) => { let s = '', pen = false; ps.forEach((p, k) => { if (p.v == null) { pen = false; return; } s += `${pen ? 'L' : 'M'}${x(k).toFixed(1)} ${y(p.v).toFixed(1)}`; pen = true; }); return s; };
    const line = path(points);
    const firstK = points.findIndex((p) => p.v != null), lastK = points.length - 1 - [...points].reverse().findIndex((p) => p.v != null);
    const base = zero ? y(0) : H - B;
    const shade = firstK >= 0 ? `${line}L${x(lastK).toFixed(1)} ${base.toFixed(1)}L${x(firstK).toFixed(1)} ${base.toFixed(1)}Z` : '';
    const step = points.length > 1 ? (W - L - R) / (points.length - 1) : 0;
    const bx = (k: number) => Math.max(L, Math.min(W - R, x(k) - step / 2));
    return { lo, hi, x, y, line, shade, line2: second ? path(second) : '', lines: (extra ?? []).map((e) => path(e.points)), bands: (bands ?? []).filter((b) => b.to > b.from).map((b) => ({ ...b, x0: bx(b.from), x1: bx(b.to) })), ticks: niceTicks(lo, hi, H > 220 ? 4 : 3) };
  }, [points, second, extra, bands, W, H, zero]);
  if (!geo) return <div className="plot-empty">No values to plot.</div>;
  const cur = i != null ? points[i] : null, cur2 = i != null && second ? second[i] : null;
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const k = Math.round(((e.clientX - r.left - L) / Math.max(1, r.width - L - R)) * (points.length - 1));
    setI(Math.max(0, Math.min(points.length - 1, k)));
  };
  const clipId = `c${label.length}${points.length}`;
  const xl = points.length > 1 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [0];
  return (
    <div className="plot" ref={ref}>
      <div className="plot-read" aria-live="polite">
        {cur ? <><span>{shortDate(cur.d)}</span>{firstLabel && <span className="pl-k" data-k="0">{firstLabel}</span>}<b>{cur.v == null ? 'n/a' : fmt(cur.v)}</b>{cur2 && secondLabel && <span>{secondLabel} {cur2.v == null ? 'n/a' : fmt(cur2.v)}</span>}
          {(extra ?? []).map((e, k) => { const v = e.points[i!]?.v; return <span key={k} className="pl-k" data-k={k + 1}>{e.label} <b>{v == null ? 'n/a' : fmt(v)}</b></span>; })}</>
          : <span>Hover or focus the chart and use ← → to read each point</span>}
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} tabIndex={0} onKeyDown={onKey}
        onPointerMove={move} onPointerLeave={() => setI(null)} onPointerDown={move} style={{ touchAction: 'pan-y' }}>
        <defs>
          <clipPath id={`${clipId}u`}><rect x={L} y={0} width={W - L - R} height={zero ? geo.y(0) : H} /></clipPath>
          <clipPath id={`${clipId}d`}><rect x={L} y={zero ? geo.y(0) : H} width={W - L - R} height={H} /></clipPath>
        </defs>
        {geo.bands.map((b) => <g key={b.label}><rect className="band" data-tone={b.tone} x={b.x0} width={Math.max(0, b.x1 - b.x0)} y={T} height={H - T - B} /><text className="band-t" x={b.x0 + 4} y={T + 11}>{b.label}</text></g>)}
        {geo.ticks.map((v) => (
          <g key={v}><line className="gd" x1={L} x2={W - R} y1={geo.y(v)} y2={geo.y(v)} /><text x={L - 8} y={geo.y(v) + 4} textAnchor="end">{axisFmt(v)}</text></g>
        ))}
        {area === 'signed' && <><path className="ar-g" d={geo.shade} clipPath={`url(#${clipId}u)`} /><path className="ar-l" d={geo.shade} clipPath={`url(#${clipId}d)`} /></>}
        {area === 'neutral' && <path className="ar-n" d={geo.shade} />}
        {zero && <line className="ax" x1={L} x2={W - R} y1={geo.y(0)} y2={geo.y(0)} />}
        {geo.line2 && <path className="ln2" d={geo.line2} />}
        <path className="ln" d={geo.line} />
        {geo.lines.map((d, k) => <path key={k} className="lnx" data-k={k + 1} d={d} />)}
        {xl.map((k, n) => <text key={k} x={geo.x(k)} y={H - 6} textAnchor={n === 0 ? 'start' : n === xl.length - 1 ? 'end' : 'middle'}>{shortDate(points[k].d)}</text>)}
        {cur && cur.v != null && (
          <g><line className="cur" x1={geo.x(i!)} x2={geo.x(i!)} y1={T} y2={H - B} /><circle className="dot2" cx={geo.x(i!)} cy={geo.y(cur.v)} r={4} /></g>
        )}
      </svg>
    </div>
  );
}

/** Bars by key (days, months). Signed bars are green above zero and red below, and always carry a sign in the readout. */
export function BarPlot({ bars, fmt, label, height = 260, signed = true, keyFmt = (k: string) => k }: {
  bars: { k: string; v: number }[]; fmt: (v: number) => string; label: string; height?: number; signed?: boolean; keyFmt?: (k: string) => string;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const { i, setI, onKey } = useCursor(bars.length);
  if (!bars.length) return <div className="plot-empty">No values to plot.</div>;
  const H = height, L = 58, R = 12, T = 12, B = 26;
  let lo = Math.min(0, ...bars.map((b) => b.v)), hi = Math.max(0, ...bars.map((b) => b.v));
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.06; lo = lo < 0 ? lo - pad : lo; hi += pad;
  const bw = (W - L - R) / bars.length, x = (k: number) => L + k * bw;
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = niceTicks(lo, hi, 4);
  const cur = i != null ? bars[i] : null;
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    setI(Math.max(0, Math.min(bars.length - 1, Math.floor(((e.clientX - r.left - L) / Math.max(1, r.width - L - R)) * bars.length))));
  };
  const step = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor((W - L - R) / 72))));
  return (
    <div className="plot" ref={ref}>
      <div className="plot-read" aria-live="polite">
        {cur ? <><span>{keyFmt(cur.k)}</span><b>{fmt(cur.v)}</b></> : <span>Hover or focus the chart and use ← → to read each bar</span>}
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} tabIndex={0} onKeyDown={onKey} onPointerMove={move} onPointerLeave={() => setI(null)} onPointerDown={move} style={{ touchAction: 'pan-y' }}>
        {ticks.map((v) => <g key={v}><line className="gd" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text x={L - 8} y={y(v) + 4} textAnchor="end">{compactInr(v)}</text></g>)}
        {bars.map((b, k) => {
          const y0 = y(0), yv = y(b.v), h = Math.max(b.v === 0 ? 1 : 1.5, Math.abs(yv - y0));
          const cls = !signed ? 'bar-n' : b.v > 0 ? 'bar-g' : b.v < 0 ? 'bar-l' : 'bar-z';
          return <rect key={b.k} className={cls} x={x(k) + Math.min(2, bw * 0.15)} width={Math.max(1, bw - Math.min(4, bw * 0.3))} y={b.v >= 0 ? y0 - h : y0} height={h} opacity={i != null && i !== k ? 0.55 : 1} />;
        })}
        <line className="ax" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
        {bars.map((b, k) => (k % step === 0 ? <text key={`t${b.k}`} x={x(k) + bw / 2} y={H - 6} textAnchor="middle">{keyFmt(b.k)}</text> : null))}
      </svg>
    </div>
  );
}

/** A histogram of values in about `bins` equal-width buckets. Bucket edges are shown in the readout. */
export function Histogram({ values, bins = 16, fmt, label, unit, height = 240, signed = true }: {
  values: number[]; bins?: number; fmt: (v: number) => string; label: string; unit: string; height?: number; signed?: boolean;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const data = useMemo(() => {
    if (!values.length) return null;
    let lo = minOf(values), hi = maxOf(values);
    if (hi === lo) { lo -= 1; hi += 1; }
    const k = Math.max(4, Math.min(bins, Math.ceil(Math.sqrt(values.length) * 2)));
    const w = (hi - lo) / k;
    const counts = Array.from({ length: k }, (_, j) => ({ a: lo + j * w, b: lo + (j + 1) * w, n: 0 }));
    for (const v of values) counts[Math.min(k - 1, Math.floor((v - lo) / w))].n++;
    return counts;
  }, [values, bins]);
  const { i, setI, onKey } = useCursor(data?.length ?? 0);
  if (!data) return <div className="plot-empty">No values to plot.</div>;
  const H = height, L = 40, R = 12, T = 12, B = 26;
  const max = Math.max(...data.map((d) => d.n)), bw = (W - L - R) / data.length;
  const y = (n: number) => T + (1 - n / max) * (H - T - B);
  const cur = i != null ? data[i] : null;
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    setI(Math.max(0, Math.min(data.length - 1, Math.floor(((e.clientX - r.left - L) / Math.max(1, r.width - L - R)) * data.length))));
  };
  return (
    <div className="plot" ref={ref}>
      <div className="plot-read" aria-live="polite">
        {cur ? <><span>{fmt(cur.a)} to {fmt(cur.b)}</span><b>{cur.n} {unit}</b></> : <span>{values.length} {unit}. Hover or use ← → to read each bucket</span>}
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} tabIndex={0} onKeyDown={onKey} onPointerMove={move} onPointerLeave={() => setI(null)} onPointerDown={move} style={{ touchAction: 'pan-y' }}>
        {niceTicks(0, max, 3).map((v) => <g key={v}><line className="gd" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text x={L - 8} y={y(v) + 4} textAnchor="end">{v}</text></g>)}
        {data.map((d, k) => {
          const cls = !signed ? 'bar-n' : d.b <= 0 ? 'bar-l' : d.a >= 0 ? 'bar-g' : 'bar-z';
          return <rect key={k} className={cls} x={L + k * bw + 1} width={Math.max(1, bw - 2)} y={y(d.n)} height={Math.max(0, H - B - y(d.n))} opacity={i != null && i !== k ? 0.55 : 1} />;
        })}
        <line className="ax" x1={L} x2={W - R} y1={H - B} y2={H - B} />
        <text x={L} y={H - 6}>{fmt(data[0].a)}</text>
        <text x={W - R} y={H - 6} textAnchor="end">{fmt(data[data.length - 1].b)}</text>
      </svg>
    </div>
  );
}
