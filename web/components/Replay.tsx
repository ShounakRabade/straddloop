'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, hard } from '@/components/ui';
import { exitLabel, inr, shortDate } from '@/lib/format';
import type { Replay as ReplayData, RunResult } from '@/lib/types';

const OPEN = 555, CLOSE = 930;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function DayChart({ d, upto }: { d: ReplayData; upto: number }) {
  const W = 680, H1 = 220, H2 = 110, G = 18, L = 64, R = 12, T = 10, B = 24, H = H1 + G + H2 + B;
  const x = (m: number) => L + ((m - OPEN) / (CLOSE - OPEN)) * (W - L - R);
  const shown = d.candles.filter((c) => c.t < upto);
  const all = d.candles.length ? d.candles : [{ t: OPEN, o: 0, h: 1, l: 0, c: 0 }];
  let lo = Math.min(...all.map((c) => c.l)), hi = Math.max(...all.map((c) => c.h));
  if (d.or_high != null) hi = Math.max(hi, d.or_high);
  if (d.or_low != null) lo = Math.min(lo, d.or_low);
  const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H1 - T);
  const cw = Math.max(2, (x(OPEN + 5) - x(OPEN)) * 0.62);
  const mtm = d.mtm.filter((p) => p.t <= upto);
  const mv = d.mtm.map((p) => p.v);
  let mlo = Math.min(0, ...mv), mhi = Math.max(0, ...mv);
  if (mhi === mlo) mhi = mlo + 1;
  const top2 = H1 + G;
  const y2 = (v: number) => top2 + (1 - (v - mlo) / (mhi - mlo)) * H2;
  const marks = d.legs.flatMap((l, i) => [
    { t: l.entry_t, k: `e${i}`, cls: 'entry', label: `${l.side} ${l.strike} in` },
    ...(l.exit_t != null ? [{ t: l.exit_t, k: `x${i}`, cls: 'exit', label: `${l.side} ${l.strike} out` }] : []),
  ]).filter((m) => m.t <= upto);
  return (
    <svg className="chart replay-chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Index 5-minute candles for ${d.date} up to ${hhmm(upto)}, with the opening range, fills and running net P&L.`}>
      {d.or_high != null && d.or_low != null && (
        <g>
          <rect className="or-band" x={L} width={W - L - R} y={y(d.or_high)} height={Math.max(1, y(d.or_low) - y(d.or_high))} />
          <text x={L - 6} y={y(d.or_high) + 4} textAnchor="end">{d.or_high.toFixed(0)}</text>
          <text x={L - 6} y={y(d.or_low) + 4} textAnchor="end">{d.or_low.toFixed(0)}</text>
        </g>
      )}
      {shown.map((c) => (
        <g key={c.t} className={c.c >= c.o ? 'up' : 'down'}>
          <line className="wick" x1={x(c.t + 2.5)} x2={x(c.t + 2.5)} y1={y(c.h)} y2={y(c.l)} />
          <rect className="body" x={x(c.t + 2.5) - cw / 2} width={cw} y={y(Math.max(c.o, c.c))} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} />
        </g>
      ))}
      {marks.map((m) => <line key={m.k} className={`mark-${m.cls}`} x1={x(m.t)} x2={x(m.t)} y1={T} y2={top2 + H2}><title>{`${hhmm(m.t)} ${m.label}`}</title></line>)}
      <line className="axis" x1={L} x2={W - R} y1={y2(0)} y2={y2(0)} />
      <text x={L - 6} y={y2(0) + 4} textAnchor="end">₹0</text>
      <text x={L - 6} y={top2 + 10} textAnchor="end">{inr(mhi)}</text>
      <text x={L - 6} y={top2 + H2} textAnchor="end">{inr(mlo)}</text>
      {mtm.length > 1 && <path className="line" d={mtm.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y2(p.v).toFixed(1)}`).join('')} />}
      <line className="cursor" x1={x(upto)} x2={x(upto)} y1={T} y2={top2 + H2} />
      {[555, 600, 660, 720, 780, 840, 900].map((t) => <text key={t} x={x(t)} y={H - 6} textAnchor="middle">{hhmm(t)}</text>)}
    </svg>
  );
}

export function ReplayPanel({ r, load }: { r: RunResult; load: (date: string) => Promise<ReplayData | null> }) {
  const dates = useMemo(() => r.curve.map((p) => p.d), [r]);
  const firstTraded = useMemo(() => r.curve.find((p) => p.p !== 0)?.d ?? dates[0], [r, dates]);
  const [date, setDate] = useState<string>(firstTraded);
  const [d, setD] = useState<ReplayData | null>(null);
  const [upto, setUpto] = useState(CLOSE);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { setDate(firstTraded); }, [firstTraded]);
  useEffect(() => {
    let live = true;
    setPlaying(false);
    load(date).then((x) => { if (live) { setD(x); setUpto(CLOSE); } });
    return () => { live = false; };
  }, [date, load, r]);
  useEffect(() => {
    if (!playing) { if (timer.current) clearInterval(timer.current); return; }
    timer.current = setInterval(() => setUpto((u) => {
      if (u >= CLOSE) { setPlaying(false); return CLOSE; }
      return Math.min(CLOSE, u + 5);
    }), 160);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [playing]);

  const idx = dates.indexOf(date);
  const nowMtm = d ? [...d.mtm].reverse().find((p) => p.t <= upto) : undefined;
  const events = d ? d.events.filter((e) => e.t <= upto) : [];

  return (
    <div className="sheet" {...hard}>
      <div className="chart-sheet-head">
        <span className="label">Replay a day</span>
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" onClick={() => setDate(dates[Math.max(0, idx - 1)])} disabled={idx <= 0} aria-label="Previous day">←</Button>
          <label className="sr" htmlFor="replay-date">Day</label>
          <select id="replay-date" className="input input--sm" value={date} onChange={(e) => setDate(e.target.value)}>
            {r.curve.map((p) => <option key={p.d} value={p.d}>{shortDate(p.d)} · {p.p === 0 ? 'no trade' : inr(p.p, { sign: true })}</option>)}
          </select>
          <Button size="sm" onClick={() => setDate(dates[Math.min(dates.length - 1, idx + 1)])} disabled={idx >= dates.length - 1} aria-label="Next day">→</Button>
        </div>
      </div>
      <div className="chart-sheet-body stack" style={{ ['--gap' as string]: '14px' }}>
        {!d && <p className="muted small">Loading the day.</p>}
        {d && d.status !== 'traded' && (
          <p className="small"><strong>No trade on {shortDate(d.date)}.</strong> {d.reason ? `Reason: ${d.reason}.` : ''}</p>
        )}
        {d && (
          <>
            <DayChart d={d} upto={upto} />
            <div className="row replay-controls">
              <Button size="sm" variant="primary" onClick={() => { if (upto >= CLOSE) setUpto(OPEN + 30); setPlaying((p) => !p); }}>{playing ? 'Pause' : upto >= CLOSE ? 'Play from 09:45' : 'Play'}</Button>
              <label className="sr" htmlFor="replay-t">Time</label>
              <input id="replay-t" type="range" min={OPEN} max={CLOSE} step={1} value={upto} onChange={(e) => { setPlaying(false); setUpto(Number(e.target.value)); }} style={{ flex: 1, minWidth: 140 }} />
              <span className="mono small">{hhmm(Math.min(upto, CLOSE - 1))} · {nowMtm ? inr(nowMtm.v, { sign: true }) : '₹0'}</span>
            </div>
            {d.legs.length > 0 && (
              <div className="table-scroll">
                <table className="ptable legs">
                  <thead><tr><th scope="col">Leg</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Why</th><th scope="col">Net</th></tr></thead>
                  <tbody>
                    {d.legs.map((l, i) => (
                      <tr key={i}>
                        <th scope="row">{l.kind === 'initial' || l.kind === 'reentry' ? (l.kind === 'reentry' ? 'Re-entry ' : 'Sell ') : 'Buy '}{l.side} {l.strike}</th>
                        <td>{hhmm(l.entry_t)} @ {l.entry_px.toFixed(2)}</td>
                        <td>{l.exit_t != null && l.exit_px != null ? `${hhmm(l.exit_t)} @ ${l.exit_px.toFixed(2)}` : 'open'}</td>
                        <td>{l.exit_reason ? exitLabel(l.exit_reason) : ''}</td>
                        <td className={l.net >= 0 ? 'gain' : 'loss'}>{inr(l.net, { sign: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {events.length > 0 && (
              <ol className="events small">
                {events.map((e, i) => <li key={i}><span className="mono">{hhmm(e.t)}</span> {e.text}</li>)}
              </ol>
            )}
            {d.status === 'traded' && (
              <p className="small muted">
                Day net {inr(d.net ?? 0, { sign: true })} after {inr(d.costs ?? 0)} costs · exit {exitLabel(d.exit_reason ?? '')} · expiry {d.expiry} (assumed) · qty {d.qty ?? '—'}
                {d.flags.length ? ` · flags: ${d.flags.join(', ')}` : ''}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
