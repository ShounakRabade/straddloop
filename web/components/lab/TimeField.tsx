'use client';
/**
 * The session time picker. One line per time: a role mark (entry, last new entry, square-off), steppers either side
 * of an HH:MM box you can type into, and a compact grid of times at the chosen interval (1, 5, 15 or 30 minutes)
 * that filters as you type. SessionTimes puts a strategy's times on one 09:15–15:30 line so their order is visible.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CLOSE, OPEN, ROLE_LABEL, digitPrefix, intervalsFor, parseTyped, snapTo, stepTime, timeList, timeProblem, toHM, toMin, type TimeRole, type TimeSpec } from '@/lib/sessionTime';
import { Tip } from './kit';

const INTERVAL_KEY = 'straddloop.timestep';

/** The interval the pickers move by, remembered in this browser. */
export function useTimeInterval(): [number, (n: number) => void] {
  const [n, setN] = useState(5);
  useEffect(() => { try { const v = Number(localStorage.getItem(INTERVAL_KEY)); if ([1, 5, 15, 30].includes(v)) setN(v); } catch { /* storage blocked */ } }, []);
  return [n, (v: number) => { setN(v); try { localStorage.setItem(INTERVAL_KEY, String(v)); } catch { /* ignore */ } }];
}

export const RoleMark = ({ role }: { role: TimeRole }) => <i className="tm-mark" data-role={role} aria-hidden="true" />;

export function TimeField({ id, label, role, value, def, spec, onChange, tip, interval, onInterval, problem }: {
  id: string; label: string; role: TimeRole; value: string; def?: string; spec: TimeSpec; onChange: (v: string) => void;
  tip: string; interval: number; onInterval: (n: number) => void; problem?: { level: 'error' | 'note'; text: string } | null;
}) {
  const cur = toMin(value);
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState<number | null>(null);   // highlighted option while the list is open
  const [note, setNote] = useState<string | null>(null);
  const listId = useId(), box = useRef<HTMLInputElement>(null), wrap = useRef<HTMLDivElement>(null);
  useEffect(() => setText(value), [value]);
  // an opened list near the bottom of the rail scrolls into view rather than opening out of sight
  useEffect(() => { if (open) requestAnimationFrame(() => wrap.current?.querySelector('.tf-pop')?.scrollIntoView({ block: 'nearest' })); }, [open]);
  const step = Math.max(interval, spec.grain);
  const ivs = intervalsFor(spec.grain);
  const all = useMemo(() => timeList(spec, step, cur), [spec, step, cur]);
  // typing filters: '10' shows 10:xx, '10:3' or '103' shows 10:30-10:39, '930' shows 09:30
  const prefix = digitPrefix(text);
  const shown = open && text !== value && prefix ? all.filter((m) => toHM(m).replace(':', '').startsWith(prefix)) : all;
  const changed = def !== undefined && value !== def;
  const own = timeProblem(cur, spec);

  const commit = (m: number | null, why?: string) => {
    if (m == null) { setText(value); setNote('Not a time. Type it as HH:MM, for example 09:30.'); return; }
    const v = timeProblem(m, spec) ? snapTo(m, spec) : m;
    setNote(v !== m ? `${toHM(m)} is not allowed here; set to ${toHM(v)}. ${timeProblem(m, spec)}` : why ?? null);
    onChange(toHM(v)); setText(toHM(v)); setOpen(false); setHi(null);
  };
  const move = (dir: 1 | -1) => { if (cur != null) commit(stepTime(cur, dir, spec, step)); };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(hi ?? (shown.length === 1 && text !== value ? shown[0] : parseTyped(text))); }
    else if (e.key === 'Escape') { if (open) { e.stopPropagation(); setOpen(false); setText(value); setHi(null); } }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      if (!open) { move(d === 1 ? 1 : -1); return; }  // closed: a spin button
      const list = shown, at = hi != null ? list.indexOf(hi) : list.indexOf(cur ?? -1);
      const cols = 4, next = list[Math.min(list.length - 1, Math.max(0, (at < 0 ? 0 : at) + d * cols))];
      if (next != null) setHi(next);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && open && hi != null) {
      e.preventDefault();
      const at = shown.indexOf(hi), next = shown[Math.min(shown.length - 1, Math.max(0, at + (e.key === 'ArrowRight' ? 1 : -1)))];
      if (next != null) setHi(next);
    }
  };
  // close when focus leaves the field
  const blur = () => requestAnimationFrame(() => { if (!wrap.current?.contains(document.activeElement)) { if (text !== value) commit(parseTyped(text)); setOpen(false); setHi(null); } });

  const msg = problem ?? (own ? { level: 'error' as const, text: own } : null);
  return (
    <div className="f tf" data-changed={changed} data-role={role} ref={wrap} onBlur={blur}>
      <div className="f-top">
        <RoleMark role={role} />
        <label className="f-label" htmlFor={id}>{label}</label>
        <Tip label={label} text={tip} />
        {label !== ROLE_LABEL[role] && <span className="tf-role">{ROLE_LABEL[role]}</span>}
      </div>
      <div className="tf-row">
        <button type="button" className="tf-step" aria-label={`${label}: ${step} minutes earlier`} disabled={cur == null || cur <= spec.min} onClick={() => move(-1)}>‹</button>
        <input ref={box} id={id} className="in tf-in" inputMode="numeric" autoComplete="off" spellCheck={false} value={text} maxLength={5}
          role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-invalid={!!msg && msg.level === 'error'}
          aria-activedescendant={open && hi != null ? `${listId}-${hi}` : undefined}
          onChange={(e) => { setText(e.target.value); setOpen(true); setHi(null); }} onFocus={() => setNote(null)} onKeyDown={key} />
        <button type="button" className="tf-step" aria-label={`${label}: ${step} minutes later`} disabled={cur == null || cur >= spec.max} onClick={() => move(1)}>›</button>
        <button type="button" className="tf-open" aria-label={open ? 'Close the list of times' : 'Show a list of times'} aria-expanded={open} aria-controls={listId}
          onClick={() => { setOpen((o) => !o); setHi(null); box.current?.focus(); }}>▾</button>
      </div>
      {open && (
        <div className="tf-pop">
          <div className="tf-bounds">{toHM(spec.min)}–{toHM(spec.max)}{spec.grain > 1 ? ` · on the ${spec.grain}-minute candle grid` : ' · any minute'}</div>
          <div className="tf-iv" role="radiogroup" aria-label="Interval">
            {ivs.map((n) => <button key={n} type="button" role="radio" aria-checked={step === n} onMouseDown={(e) => e.preventDefault()} onClick={() => onInterval(n)}>{n} min</button>)}
          </div>
          <div className="tf-grid" id={listId} role="listbox" aria-label={`${label} times`}>
            {shown.length ? shown.map((m) => (
              <button key={m} id={`${listId}-${m}`} type="button" role="option" aria-selected={m === cur} data-hi={m === hi || undefined}
                onMouseDown={(e) => e.preventDefault()} onClick={() => commit(m)}>{toHM(m)}</button>
            )) : <span className="tf-none">No {step}-minute time matches “{text}”. Press Enter to use it as typed.</span>}
          </div>
        </div>
      )}
      {(changed || msg || note) && (
        <div className="f-meta">
          {changed && <span>Default {def} · <button type="button" className="qlink" onClick={() => onChange(def!)}>reset</button></span>}
          {msg && <span className={msg.level === 'error' ? 'err' : 'warn'} role={msg.level === 'error' ? 'alert' : undefined}>{msg.text}</span>}
          {note && !msg && <span className="warn">{note}</span>}
        </div>
      )}
    </div>
  );
}

/** A strategy's times on one line from 09:15 to 15:30, with fixed rule times (from the engine) drawn dashed. */
export function SessionLine({ marks }: { marks: { role: TimeRole; at: number | null; fixed?: string }[] }) {
  const x = (m: number) => `${(100 * (m - OPEN)) / (CLOSE - OPEN)}%`;
  const live = marks.filter((m) => m.at != null);
  const entry = live.find((m) => m.role === 'entry'), exit = live.find((m) => m.role === 'exit');
  return (
    <div className="tl" aria-hidden="true">
      <div className="tl-bar">
        {entry && exit && entry.at! < exit.at! && <span className="tl-span" style={{ left: x(entry.at!), width: `calc(${x(exit.at!)} - ${x(entry.at!)})` }} />}
        {live.map((m) => <span key={m.role + (m.fixed ?? '')} className="tl-pin" data-role={m.role} data-fixed={m.fixed ? 'true' : undefined} style={{ left: x(m.at!) }} title={`${ROLE_LABEL[m.role]} ${toHM(m.at!)}`} />)}
      </div>
      <div className="tl-ax"><span>09:15</span><span>12:00</span><span>15:30</span></div>
    </div>
  );
}
