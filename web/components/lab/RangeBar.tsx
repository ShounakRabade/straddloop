'use client';
/**
 * Moving through history from the results area (real data). Previous and Next step a whole window, keeping its
 * length; +30 / +60 / +90 move it by that many days; presets and "last N" pick a window ending on the latest stored
 * day. A window that runs past the stored data is cut to it and the bar says so; one with nothing stored is not
 * offered. All dates come from lib/dateRange.ts, the same object the calendar and the run use.
 */
import { useState } from 'react';
import { boundsOf, fitWindow, lastN, nextWindow, presetRange, prevWindow, shiftRange, windowLength, type DateRange, type Fitted, type InventoryDay, type Span, type StatusRow } from '@/lib/dateRange';
import { shortDate } from '@/lib/format';
import { PRESETS } from './Calendar';
import { Tip } from './kit';

export interface RollingPlan { windows: Span[]; leftover: number; capped: boolean }

export function RangeBar({ request, setRequest, range, inventory, statuses, rolling }: {
  request: Span; setRequest: (r: Span) => void; range: DateRange | null; inventory: InventoryDay[]; statuses: StatusRow[];
  rolling: { on: boolean; setOn: (v: boolean) => void; w: number; setW: (n: number) => void; s: number; setS: (n: number) => void; plan: RollingPlan | null };
}) {
  const b = boundsOf(inventory, statuses);
  // the length to keep: the length of the window last chosen, so a window cut at the end of the data does not
  // shrink every move after it
  const [keep, setKeep] = useState<{ len: number; at: Span } | null>(null);
  const len = keep && keep.at.from === request.from && keep.at.to === request.to ? keep.len : windowLength(request);
  const [note, setNote] = useState<string | null>(null);
  const [n, setN] = useState('45');
  const [unit, setUnit] = useState<'days' | 'sessions'>('days');
  const ready = !!request.from && !!request.to && !!b.earliest && !!b.latest_any;

  const words = (f: Fitted) => f.cut === 'end' ? `Stored data ends on ${shortDate(b.latest_any!)}: this window has ${f.kept} of the ${f.asked} days asked for.`
    : f.cut === 'start' ? `Stored data starts on ${shortDate(b.earliest!)}: this window has ${f.kept} of the ${f.asked} days asked for.`
      : f.cut === 'both' ? `Stored data runs ${shortDate(b.earliest!)} – ${shortDate(b.latest_any!)}: this window has ${f.kept} of the ${f.asked} days asked for.` : null;
  const option = (target: Span) => (ready ? fitWindow(target, b) : null);
  const go = (f: Fitted | null) => { if (!f?.range) return; setKeep({ len, at: f.range }); setNote(words(f)); setRequest(f.range); };
  const title = (label: string, f: Fitted | null) => !f ? label : !f.range ? `${label}: nothing is stored ${f.outside === 'before' ? `before ${shortDate(b.earliest!)}` : `after ${shortDate(b.latest_any!)}`}`
    : `${label}: ${shortDate(f.range.from)} – ${shortDate(f.range.to)}${f.cut ? ` (${f.kept} of ${f.asked} days stored)` : ''}`;

  const prev = ready ? option(prevWindow(request, len)) : null, next = ready ? option(nextWindow(request, len)) : null;
  const shifts = [30, 60, 90].map((d) => ({ d, f: ready ? option(shiftRange(request, d, len)) : null }));
  const eff = range?.effective;
  const custom = () => { const v = Math.round(Number(n)); const r = lastN(v, unit, inventory, statuses); if (r) { setNote(null); setRequest(r); } };
  const plan = rolling.plan;

  return (
    <div className="rb" role="group" aria-label="Backtest period">
      <div className="rb-row">
        <button type="button" className="qbtn rb-step" disabled={!prev?.range} title={title('Previous window', prev)} aria-label={title('Previous window', prev)} onClick={() => go(prev)}>‹ Previous</button>
        <span className="rb-now" aria-live="polite">
          {eff ? <><b>{shortDate(eff.from)} – {shortDate(eff.to)}</b><span>{windowLength(eff)} days · {range!.runnable.length} sessions</span></> : <b>Choose dates</b>}
        </span>
        <button type="button" className="qbtn rb-step" disabled={!next?.range} title={title('Next window', next)} aria-label={title('Next window', next)} onClick={() => go(next)}>Next ›</button>
        <span className="rb-sep" aria-hidden="true" />
        <span className="lbl">Move</span>
        {shifts.map(({ d, f }) => (
          <button key={d} type="button" className="qbtn rb-chip" disabled={!f?.range} title={title(`${d} days later`, f)} aria-label={title(`${d} days later`, f)} onClick={() => go(f)}>+{d}d</button>
        ))}
        <Tip label="Moving the window" text={`Previous and Next step a whole window (${len} days here), so the length stays the same; +30 / +60 / +90 move it by that many days. A window is cut to the stored data (${b.earliest ?? '—'} to ${b.latest_any ?? '—'}) and the bar says how much was cut.`} />
      </div>
      <div className="rb-row">
        <span className="lbl">Period</span>
        {PRESETS.map((p) => {
          const r = presetRange(p.id, inventory, statuses);
          const on = !!r && r.from === request.from && r.to === request.to;
          return <button key={p.id} type="button" className="qbtn rb-chip" aria-pressed={on} disabled={!r} title={r ? `${p.long}: ${shortDate(r.from)} to ${shortDate(r.to)}` : p.long} onClick={() => { if (r) { setNote(null); setRequest(r); } }}>{p.label}</button>;
        })}
        <span className="rb-sep" aria-hidden="true" />
        <label className="lbl" htmlFor="rb-n">Last</label>
        <input id="rb-n" className="in rb-n" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, '').slice(0, 4))} onKeyDown={(e) => { if (e.key === 'Enter') custom(); }} />
        <select className="in rb-unit" aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as 'days' | 'sessions')}>
          <option value="days">calendar days</option><option value="sessions">sessions</option>
        </select>
        <button type="button" className="qbtn rb-chip" disabled={!ready || !(Number(n) >= 1)} onClick={custom}>Use</button>
      </div>
      <div className="rb-row rb-roll">
        <label className="rb-check"><input type="checkbox" checked={rolling.on} onChange={(e) => rolling.setOn(e.target.checked)} /><span>Rolling windows</span></label>
        <Tip label="Rolling windows" text="The same rules over successive windows of the selected period: a window of W calendar days, then the next one S days later, and so on. Each window is its own backtest, started flat with the full capital, so you can see whether the result holds across history. They run after the main backtest, on the same data." />
        <label className="lbl" htmlFor="rb-w">Window</label>
        <input id="rb-w" className="in rb-n" inputMode="numeric" value={rolling.w} onChange={(e) => rolling.setW(Math.min(3650, Number(e.target.value.replace(/\D/g, '')) || 0))} />
        <span className="rb-u">days, every</span>
        <input id="rb-s" className="in rb-n" inputMode="numeric" aria-label="Step in days" value={rolling.s} onChange={(e) => rolling.setS(Math.min(3650, Number(e.target.value.replace(/\D/g, '')) || 0))} />
        <span className="rb-u">days</span>
        {plan && rolling.on && (
          <span className="rb-plan">
            {!(rolling.w >= 5 && rolling.s >= 1) ? 'A window needs at least 5 days and a step of at least 1.'
              : plan.windows.length ? <>→ <b>{plan.windows.length}</b> window{plan.windows.length === 1 ? '' : 's'}{plan.leftover > 0 ? ` · the last ${plan.leftover} day${plan.leftover === 1 ? ' is' : 's are'} in no window` : ''}{plan.capped ? ' · capped at 400' : ''}</>
                : `The period is shorter than one ${rolling.w}-day window.`}
          </span>
        )}
      </div>
      {note && <p className="rb-note" role="status">{note}</p>}
    </div>
  );
}
