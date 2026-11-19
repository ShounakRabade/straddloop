import { inr } from '@/lib/format';

const compact = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 100000) return `${s}₹${(a / 100000).toFixed(a >= 1000000 ? 0 : 1)}L`;
  if (a >= 1000) return `${s}₹${Math.round(a / 1000)}k`;
  return `${s}₹${Math.round(a)}`;
};

export function EquityChart({ points, draw = true, height = 260, label, id = 'eq' }: { points: { d: string; v: number }[]; draw?: boolean; height?: number; label: string; id?: string }) {
  const W = 640, H = height, L = 52, R = 14, T = 14, B = 26;
  if (points.length < 2) return null;
  const vals = points.map((p) => p.v);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = (i: number) => L + (i / (points.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(points.length - 1).toFixed(1)} ${y(0).toFixed(1)}L${x(0).toFixed(1)} ${y(0).toFixed(1)}Z`;
  const last = points[points.length - 1], y0 = y(0);
  const ticks = [Math.max(...vals), Math.min(...vals)].filter((v) => Math.abs(y(v) - y0) > 16);
  return (
    <svg className={`chart ${draw ? 'draw' : ''}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <defs>
        <clipPath id={`${id}-up`}><rect x={L} y={0} width={W - L - R} height={y0} /></clipPath>
        <clipPath id={`${id}-dn`}><rect x={L} y={y0} width={W - L - R} height={H - y0} /></clipPath>
      </defs>
      <path className="area-gain" d={area} clipPath={`url(#${id}-up)`} />
      <path className="area-loss" d={area} clipPath={`url(#${id}-dn)`} />
      {ticks.map((v) => (
        <g key={v}><line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text x={L - 8} y={y(v) + 4} textAnchor="end">{compact(v)}</text></g>
      ))}
      <line className="axis" x1={L} x2={W - R} y1={y0} y2={y0} />
      <text x={L - 8} y={y0 + 4} textAnchor="end">₹0</text>
      <text x={L} y={H - 6}>{points[0].d}</text>
      <text x={W - R} y={H - 6} textAnchor="end">{last.d}</text>
      <path className="line" d={line} pathLength={1} />
      <circle className="dot" cx={x(points.length - 1)} cy={y(last.v)} r={5} />
    </svg>
  );
}

export function Sparkline({ values, width = 150, height = 44, label }: { values: number[]; width?: number; height?: number; label?: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values), span = hi - lo || 1;
  const x = (i: number) => 2 + (i / (values.length - 1)) * (width - 4);
  const y = (v: number) => 3 + (1 - (v - lo) / span) * (height - 6);
  return (
    <svg className="chart spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <line className="grid" x1={2} x2={width - 2} y1={y(0)} y2={y(0)} />
      <path className="line line--ink" style={{ strokeWidth: 2 }} d={values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('')} />
    </svg>
  );
}

type Shape = 'short-straddle' | 'long-option' | 'ratio';
const payoffFns: Record<Shape, { f: (s: number) => number; marks: [number, string][]; caption: string }> = {
  'short-straddle': { f: (s) => 30 - Math.abs(s - 50) * 1.5, marks: [[50, 'ATM strike']], caption: 'Profit is capped at the premium collected. Loss grows the further the index moves either way.' },
  'long-option': { f: (s) => Math.max(0, s - 44) * 1.25 - 14, marks: [[44, 'Strike']], caption: 'Loss is capped at the premium paid. The option has to move further than its cost to pay.' },
  ratio: {
    f: (s) => 6 - 3 * Math.max(0, s - 62) + 5 * Math.max(0, s - 76) - 3 * Math.max(0, 38 - s) + 5 * Math.max(0, 24 - s),
    marks: [[24, 'Buy 5'], [38, 'Sell 3'], [62, 'Sell 3'], [76, 'Buy 5']],
    caption: 'Worst at the long strikes. Beyond them the two extra long lots gain, so the tails turn back up.',
  },
};

export function PayoffChart({ shape, compactView = false, id }: { shape: Shape; compactView?: boolean; id: string }) {
  const { f, marks, caption } = payoffFns[shape];
  const W = 320, H = compactView ? 120 : 190, L = 10, R = 10, T = 12, B = compactView ? 12 : 30;
  const xs = Array.from({ length: 101 }, (_, i) => i), vs = xs.map(f);
  const lo = Math.min(...vs, -4), hi = Math.max(...vs, 4), span = hi - lo;
  const x = (s: number) => L + (s / 100) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / span) * (H - T - B);
  const line = xs.map((s, i) => `${i ? 'L' : 'M'}${x(s).toFixed(1)} ${y(vs[i]).toFixed(1)}`).join('');
  const area = `${line}L${x(100)} ${y(0)}L${x(0)} ${y(0)}Z`, y0 = y(0);
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Payoff at expiry. ${caption}`}>
        <defs>
          <clipPath id={`${id}-up`}><rect x={0} y={0} width={W} height={y0} /></clipPath>
          <clipPath id={`${id}-dn`}><rect x={0} y={y0} width={W} height={H - y0} /></clipPath>
        </defs>
        <path className="area-gain" d={area} clipPath={`url(#${id}-up)`} />
        <path className="area-loss" d={area} clipPath={`url(#${id}-dn)`} />
        {!compactView && marks.map(([s, t]) => (
          <g key={s}><line className="grid" x1={x(s)} x2={x(s)} y1={T} y2={H - B + 4} /><text x={x(s)} y={H - 8} textAnchor="middle">{t}</text></g>
        ))}
        <line className="axis" x1={L} x2={W - R} y1={y0} y2={y0} />
        <path className="line line--ink" d={line} />
      </svg>
      {!compactView && <figcaption className="small muted" style={{ marginTop: 10 }}>{caption}</figcaption>}
    </figure>
  );
}

export function PathChart({ values, id }: { values: number[]; id: string }) {
  const W = 256, H = 70;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const x = (i: number) => 2 + (i / (values.length - 1)) * (W - 4);
  const y = (v: number) => 5 + (1 - (v - lo) / span) * (H - 10);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" data-id={id}>
      <line className="grid" x1={2} x2={W - 2} y1={y(values[0])} y2={y(values[0])} />
      <path className="line line--ink" style={{ strokeWidth: 2 }} d={values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('')} />
    </svg>
  );
}

export const figure = (v: number) => inr(v, { sign: true });
