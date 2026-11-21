'use client';
/**
 * Date-range calendar for real data. It never decides dates itself: every day's state, the counts, the bounds
 * and the messages come from the engine's DateRange (lib/dateRange.ts). The month grid asks the same builder
 * for the visible month, so a cell and the summary below can never disagree.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { addDays, boundsOf, buildDateRange, loadCommand, presetRange, weekdayOf, type DateRange, type DayEntry, type InventoryDay, type Preset, type Series, type StatusRow } from '@/lib/dateRange';
import { inr, shortDate } from '@/lib/format';
import { outcomeLabel } from '@/lib/outcomes';
import type { DayOutcome } from '@/lib/types';
import { Icon, Tip } from './kit';

const PRESETS: { id: Preset; label: string; long: string }[] = [
  { id: 'last_7', label: '7D', long: 'Last 7 trading days with data' }, { id: 'last_30', label: '30D', long: 'Last 30 trading days with data' },
  { id: 'last_90', label: '90D', long: 'Last 90 trading days with data' }, { id: '6m', label: '6M', long: 'Last 6 months' }, { id: '1y', label: '1Y', long: 'Last year' },
  { id: '2y', label: '2Y', long: 'Last 2 years' }, { id: '3y', label: '3Y', long: 'Last 3 years' }, { id: 'max', label: 'Max', long: 'All stored history' },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const STATE_WORD: Record<string, string> = {
  validated: 'complete data', partial: 'partial data', failed: 'failed validation', downloading: 'downloading', missing: 'no data stored',
  holiday: 'holiday', weekend: 'weekend', outside: 'outside the stored history',
};
const ym = (d: string) => d.slice(0, 7);
const monthStart = (m: string) => `${m}-01`;
const monthEnd = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const shiftMonth = (m: string, n: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function Calendar({ inventory, statuses, source, series, request, onChange, range, outcomes }: {
  inventory: InventoryDay[]; statuses: StatusRow[]; source: 'dhan' | 'local'; series: Series;
  request: { from: string; to: string }; onChange: (r: { from: string; to: string }) => void; range: DateRange | null; outcomes?: Map<string, DayOutcome>;
}) {
  const bounds = useMemo(() => boundsOf(inventory, statuses), [inventory, statuses]);
  const ceiling = bounds.latest_any;
  const floor = bounds.floor;
  const minMonth = ym(floor), maxMonth = ym(ceiling ?? new Date().toISOString().slice(0, 10));
  const [view, setView] = useState(() => ym(request.to || ceiling || floor));
  const [pending, setPending] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string>(request.to || ceiling || floor);
  const [editing, setEditing] = useState<'from' | 'to' | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const opts = { source, underlying: 'NIFTY', series } as const;

  useEffect(() => { if (request.to) setView(ym(request.to < floor ? floor : request.to > (ceiling ?? request.to) ? ceiling ?? request.to : request.to)); }, [request.to, ceiling, floor]);

  // States for the visible month, from the same builder as the selected range.
  const month = useMemo(() => {
    const from = monthStart(view), to = monthEnd(view);
    const r = buildDateRange({ from, to }, inventory, statuses, opts);
    return new Map(r.days.map((d) => [d.date, d]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, inventory, statuses, source, series]);

  // Coverage of every month from the floor to the latest stored day: share of weekdays that can run.
  const strip = useMemo(() => {
    if (!ceiling) return [] as { year: number; months: ({ m: string; frac: number; runnable: number; weekdays: number } | null)[] }[];
    const all = buildDateRange({ from: floor, to: ceiling }, inventory, statuses, opts);
    const per = new Map<string, { runnable: number; weekdays: number }>();
    for (const d of all.days) {
      const k = ym(d.date), v = per.get(k) ?? { runnable: 0, weekdays: 0 };
      if (d.weekday < 5) v.weekdays++;
      if (d.state === 'validated' || d.state === 'partial') v.runnable++;
      per.set(k, v);
    }
    const years: { year: number; months: ({ m: string; frac: number; runnable: number; weekdays: number } | null)[] }[] = [];
    for (let y = Number(floor.slice(0, 4)); y <= Number(ceiling.slice(0, 4)); y++) {
      years.push({ year: y, months: MONTHS.map((_, i) => {
        const m = `${y}-${String(i + 1).padStart(2, '0')}`;
        const v = per.get(m);
        return v ? { m, ...v, frac: v.weekdays ? v.runnable / v.weekdays : 0 } : null;
      }) });
    }
    return years;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventory, statuses, ceiling, floor, source, series]);

  const sel = pending ? { from: hover && hover < pending ? hover : pending, to: hover && hover > pending ? hover : pending } : request;
  const selectable = (d: string) => d >= floor && !!ceiling && d <= ceiling;

  function pick(d: string) {
    if (!selectable(d)) return;
    if (editing) {
      const next = editing === 'from' ? { from: d, to: request.to && request.to >= d ? request.to : d } : { from: request.from && request.from <= d ? request.from : d, to: d };
      onChange(next); setEditing(null); setPending(null); return;
    }
    if (!pending) { setPending(d); return; }
    onChange(d < pending ? { from: d, to: pending } : { from: pending, to: d });
    setPending(null); setHover(null);
  }

  function move(d: string) {
    const clamped = d < floor ? floor : ceiling && d > ceiling ? ceiling : d;
    setFocus(clamped);
    if (ym(clamped) !== view) setView(ym(clamped));
    const cell = () => grid.current?.querySelector<HTMLButtonElement>(`[data-date="${clamped}"]`);
    const now = cell();
    if (now) now.focus(); else requestAnimationFrame(() => cell()?.focus());
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (steps[e.key] != null) { e.preventDefault(); move(addDays(focus, steps[e.key])); return; }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const m = shiftMonth(ym(focus), e.key === 'PageUp' ? -1 : 1), day = Math.min(Number(focus.slice(8)), Number(monthEnd(m).slice(8)));
      move(`${m}-${String(day).padStart(2, '0')}`); return;
    }
    if (e.key === 'Home') { e.preventDefault(); move(addDays(focus, -weekdayOf(focus))); return; }
    if (e.key === 'End') { e.preventDefault(); move(addDays(focus, 6 - weekdayOf(focus))); return; }
    // Enter/Space act on the day the keyboard is on (state), not on whichever button the browser focused last.
    if (e.key === 'Enter' || e.key === ' ') { if ((e.target as HTMLElement).dataset.date) { e.preventDefault(); pick(focus); } return; }
    if (e.key === 'Escape' && (pending || editing)) { e.preventDefault(); setPending(null); setEditing(null); setHover(null); }
  }

  const cells: (DayEntry | { date: string; state: 'outside'; blank?: boolean } | null)[] = [];
  const first = monthStart(view), last = monthEnd(view);
  for (let i = 0; i < weekdayOf(first); i++) cells.push(null);
  for (let d = first; d <= last; d = addDays(d, 1)) cells.push(month.get(d) ?? { date: d, state: 'outside' });

  const presetNow = PRESETS.find((p) => { const r = presetRange(p.id, inventory, statuses); return r && r.from === request.from && r.to === request.to; })?.id ?? null;
  const cmd = range ? loadCommand(range) : null;
  const years = Array.from({ length: Number(maxMonth.slice(0, 4)) - Number(minMonth.slice(0, 4)) + 1 }, (_, i) => Number(minMonth.slice(0, 4)) + i);
  const c = range?.counts;
  const legendHoliday = range?.days.some((d) => d.holiday?.source === 'nse_list_unverified') || [...month.values()].some((d) => d.holiday?.source === 'nse_list_unverified');

  return (
    <div className="cal">
      <div className="cal-presets" role="group" aria-label="Quick ranges">
        {PRESETS.map((p) => {
          const r = presetRange(p.id, inventory, statuses);
          return (
            <button key={p.id} type="button" className="qbtn" aria-pressed={presetNow === p.id} disabled={!r} title={r ? `${p.long}: ${shortDate(r.from)} to ${shortDate(r.to)}` : p.long}
              onClick={() => { if (r) { onChange(r); setPending(null); setEditing(null); } }}>{p.label}</button>
          );
        })}
        <button type="button" className="qbtn" aria-pressed={!presetNow && !!request.from} onClick={() => { setPending(null); setEditing('from'); move(request.from || ceiling || floor); }} title="Pick both ends on the calendar">Custom</button>
      </div>

      <div className="cal-sel">
        <button type="button" aria-pressed={editing === 'from' || (!!pending && !editing)} onClick={() => { setPending(null); setEditing('from'); move(request.from || ceiling || floor); }}>
          <span className="lbl">From</span><b>{pending && !editing ? shortDate(pending) : request.from ? shortDate(request.from) : 'Pick a day'}</b>
        </button>
        <span className="arrow" aria-hidden="true">→</span>
        <button type="button" aria-pressed={editing === 'to' || (!!pending && !editing)} onClick={() => { setPending(null); setEditing('to'); move(request.to || ceiling || floor); }}>
          <span className="lbl">To</span><b>{pending && !editing ? 'pick the end' : request.to ? shortDate(request.to) : 'Pick a day'}</b>
        </button>
      </div>
      {(pending || editing) && <p className="sec-note" role="status">{editing ? `Pick the ${editing === 'from' ? 'start' : 'end'} day. Esc cancels.` : 'Now pick the other end of the range. Esc cancels.'}</p>}

      <div className="cal-nav">
        <button type="button" className="ib" aria-label="Previous month" disabled={view <= minMonth} onClick={() => setView(shiftMonth(view, -1))}><Icon.left /></button>
        <div className="ttl">
          <label className="sr" htmlFor="cal-m">Month</label>
          <select id="cal-m" value={view.slice(5)} onChange={(e) => { const m = `${view.slice(0, 4)}-${e.target.value}`; setView(m < minMonth ? minMonth : m > maxMonth ? maxMonth : m); }}>
            {MONTHS.map((n, i) => { const v = String(i + 1).padStart(2, '0'), m = `${view.slice(0, 4)}-${v}`; return <option key={v} value={v} disabled={m < minMonth || m > maxMonth}>{n}</option>; })}
          </select>
          <label className="sr" htmlFor="cal-y">Year</label>
          <select id="cal-y" value={view.slice(0, 4)} onChange={(e) => { const m = `${e.target.value}-${view.slice(5)}`; setView(m < minMonth ? minMonth : m > maxMonth ? maxMonth : m); }}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button type="button" className="ib" aria-label="Next month" disabled={view >= maxMonth} onClick={() => setView(shiftMonth(view, 1))}><Icon.right /></button>
      </div>

      <div ref={grid} className="cal-grid" role="grid" aria-label={`${MONTHS[Number(view.slice(5)) - 1]} ${view.slice(0, 4)}`} onKeyDown={onKey} onMouseLeave={() => setHover(null)}>
        <div role="row" style={{ display: 'contents' }}>{DOW.map((d) => <span key={d} role="columnheader" className="cal-dow">{d}</span>)}</div>
        <div role="row" style={{ display: 'contents' }}>
          {cells.map((e, i) => {
            if (!e) return <span key={`b${i}`} className="cal-day" data-blank="true" aria-hidden="true" />;
            const d = e.date, st = e.state;
            const inSel = !!sel.from && !!sel.to && d >= sel.from && d <= sel.to;
            const edge = d === sel.from ? 'start' : d === sel.to ? 'end' : undefined;
            const entry = 'weekday' in e ? e : null;
            const o = outcomes?.get(d);
            const words = [longDate(d), STATE_WORD[st] ?? st, entry?.reason, entry?.holiday ? `${entry.holiday.name}${entry.holiday.source === 'nse_list_unverified' ? ' (NSE list, unverified)' : ''}` : null,
              entry?.is_expiry ? 'expiry day (assumed)' : null, o ? `last run: ${outcomeLabel(o.status)}${o.status === 'traded' ? `, ${inr(o.net, { sign: true })}` : ''}` : null,
              edge ? `range ${edge}` : null].filter(Boolean).join('; ');
            return (
              <button key={d} type="button" role="gridcell" className="cal-day" data-date={d} data-state={st} data-in={inSel && !edge ? 'true' : undefined} data-edge={edge}
                data-pending={pending === d || undefined} data-expiry={entry?.is_expiry || undefined} aria-selected={inSel} aria-label={words} title={words}
                tabIndex={d === focus || (ym(focus) !== view && d === first) ? 0 : -1} disabled={!selectable(d)}
                onClick={() => { setFocus(d); pick(d); }} onMouseEnter={() => pending && setHover(d)} onFocus={() => { setFocus(d); if (pending) setHover(d); }}>
                {Number(d.slice(8))}
              </button>
            );
          })}
        </div>
      </div>

      <ul className="cal-legend" aria-label="Legend">
        <li><i data-k="validated" />Complete</li><li><i data-k="partial" />Partial</li><li><i data-k="missing" />Not stored</li>
        <li><i data-k="failed" />Failed</li><li><i data-k="holiday" />Holiday{legendHoliday ? ' (unverified list)' : ''}</li><li><i data-k="expiry" />Expiry</li>
      </ul>

      {strip.length > 0 && (
        <div className="cal-strip" aria-label={`Stored data by month, from ${floor}`}>
          <span className="lbl">Coverage by month</span>
          {strip.map((y) => (
            <div key={y.year} className="cal-strip-row">
              <span className="yr">{y.year}</span>
              {y.months.map((m, i) => m ? (
                <button key={m.m} type="button" aria-current={m.m === view} className={request.from && request.to && m.m >= ym(request.from) && m.m <= ym(request.to) ? 'in-range' : undefined}
                  title={`${MONTHS[i]} ${y.year}: ${m.runnable} of ${m.weekdays} weekdays stored`} aria-label={`${MONTHS[i]} ${y.year}: ${m.runnable} of ${m.weekdays} weekdays stored`} onClick={() => setView(m.m)}>
                  <i style={{ height: `${Math.round(m.frac * 100)}%` }} />
                </button>
              ) : <button key={i} type="button" disabled aria-hidden="true" tabIndex={-1} />)}
            </div>
          ))}
        </div>
      )}

      {range && c && (
        <div className="cal" aria-live="polite">
          <dl className="cov">
            <dt>Selected period</dt><dd>{range.effective ? `${shortDate(range.effective.from)} – ${shortDate(range.effective.to)}` : '—'}</dd>
            <dt>Trading sessions <Tip label="Trading sessions" text="Weekdays in the selected period, minus known holidays. Each one is either stored (and will run) or not." /></dt>
            <dd>{c.weekdays - c.holiday}</dd>
            <dt className="strong">Available sessions (will run)</dt><dd className="strong">{c.runnable}</dd>
            <dt>Complete</dt><dd>{c.validated}</dd>
            <dt>Partial</dt><dd>{c.partial}</dd>
            <dt>Missing (not stored)</dt><dd>{c.missing}</dd>
            {c.failed > 0 && <><dt>Failed validation</dt><dd>{c.failed}</dd></>}
            {c.downloading > 0 && <><dt>Downloading</dt><dd>{c.downloading}</dd></>}
            <dt>Holidays</dt><dd>{c.holiday}</dd>
            <dt>Latest validated day</dt><dd>{range.bounds.latest_validated ? shortDate(range.bounds.latest_validated) : '—'}</dd>
            {range.bounds.latest_any && range.bounds.latest_any !== range.bounds.latest_validated && <><dt>Latest stored day (any quality)</dt><dd>{shortDate(range.bounds.latest_any)}</dd></>}
          </dl>
          {range.messages.length > 0 && (
            <ul className="cov-msgs">{range.messages.map((m) => <li key={m.text} data-l={m.level}>{m.text}</li>)}</ul>
          )}
          {!statuses.length && source === 'dhan' && <p className="sec-note">Per-day ingestion records (market_day_status) are not in the database, so states come from the day files and holidays from an unverified NSE list.</p>}
          {cmd && (
            <div className="cal" style={{ gap: 6 }}>
              <p className="sec-note">The Lab cannot fetch missing days from Dhan by itself. Run this on your computer, then reload this page:</p>
              <code className="code">{cmd}</code>
              <button type="button" className="qlink" style={{ justifySelf: 'start' }} onClick={() => navigator.clipboard?.writeText(cmd).catch(() => undefined)}>Copy the command</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
