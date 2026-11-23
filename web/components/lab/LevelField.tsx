'use client';
/**
 * A stop or target. The value is typed into a box beside its unit (%, pts, ₹, ₹/lot …), or set with the slider,
 * which is logarithmic over wide ranges so a few hundred rupees and a lakh are both reachable. When the level is
 * optional, a switch turns it off (stored as 0, which every engine reads as "no level").
 */
import { useEffect, useId, useState } from 'react';
import { LEVEL_BOUNDS, ON_VALUE, SLIDER_MAX, UNIT, clampLevel, fmtLevel, fromSlider, toSlider, type Bounds, type LevelRole, type LevelUnit } from '@/lib/levels';
import { Tip } from './kit';

export interface LevelProps {
  id: string; label: string; tip: string; role: LevelRole; units: LevelUnit[]; unit: LevelUnit; value: number;
  onChange: (value: number, unit: LevelUnit) => void;
  bounds?: Partial<Record<LevelUnit, Bounds>>; optional?: boolean;
  def?: { value: number; unit: LevelUnit } | null;
  compact?: boolean;
}

export const boundsOf = (role: LevelRole, unit: LevelUnit, over?: Partial<Record<LevelUnit, Bounds>>): Bounds =>
  over?.[unit] ?? LEVEL_BOUNDS[role][unit] ?? { min: 0, max: 100000, step: 1 };

export function LevelField({ id, label, tip, role, units, unit, value, onChange, bounds, optional, def, compact }: LevelProps) {
  const b = boundsOf(role, unit, bounds);
  const on = !optional || value > 0;
  const [text, setText] = useState(String(value));
  const [note, setNote] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  // grouped while not being edited (1,50,000), plain while typing
  const shown = typing ? text : value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const uid = useId();
  useEffect(() => setText(String(value)), [value]);
  const changed = !!def && (def.value !== value || (on && def.unit !== unit));
  const startOf = (u: LevelUnit) => clampLevel(ON_VALUE[role][u] ?? boundsOf(role, u, bounds).min, boundsOf(role, u, bounds));
  const commit = () => {
    const v = Number(text.replace(/[,₹%\s]/g, ''));
    if (!Number.isFinite(v) || text.trim() === '') { setText(String(value)); setNote('Type a number.'); return; }
    const c = clampLevel(v, b);
    setNote(c !== v ? `${fmtLevel(unit, v)} is outside ${fmtLevel(unit, b.min)}–${fmtLevel(unit, b.max)} (steps of ${b.step}); set to ${fmtLevel(unit, c)}.` : null);
    setText(String(c));
    if (c !== value) onChange(c, unit);
  };
  return (
    <div className={`f lf ${compact ? 'lf--compact' : ''}`} data-changed={changed} data-on={on}>
      <div className="f-top">
        <label className="f-label" htmlFor={on ? `${id}-n` : `${id}-on`}>{label}</label>
        <Tip label={label} text={tip} />
        {optional && (
          <label className="lf-sw">
            <input id={`${id}-on`} type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked ? startOf(unit) : 0, unit)} />
            <span>{on ? 'On' : 'Off'}</span>
          </label>
        )}
      </div>
      {on ? (
        <>
          <div className="lf-row">
            <span className="lf-box">
              {(unit === 'rupees' || unit === 'rupees_per_lot') && <span className="lf-pre" aria-hidden="true">₹</span>}
              <input id={`${id}-n`} className="lf-in" inputMode="decimal" value={shown} aria-describedby={`${uid}-u`}
                onFocus={() => { setTyping(true); setText(String(value)); }} onChange={(e) => setText(e.target.value)} onBlur={() => { setTyping(false); if (text.trim() !== String(value)) commit(); /* leaving without an edit keeps any note: no layout jump under the next click */ }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
              <span className="lf-suf" id={`${uid}-u`}>{unit === 'rupees' ? '' : unit === 'rupees_per_lot' ? '/lot' : UNIT[unit].chip}</span>
            </span>
            {units.length > 1 && (
              <span className="lf-units" role="radiogroup" aria-label={`${label}: unit`}>
                {units.map((u) => (
                  <button key={u} type="button" role="radio" aria-checked={u === unit} title={UNIT[u].words}
                    onClick={() => { if (u !== unit) { setNote(`Now in ${UNIT[u].words}; the value starts at ${fmtLevel(u, startOf(u))}.`); onChange(startOf(u), u); } }}>{UNIT[u].chip}</button>
                ))}
              </span>
            )}
          </div>
          <input id={id} type="range" min={0} max={SLIDER_MAX} step={1} value={toSlider(value, b)} aria-label={`${label} slider`}
            aria-valuetext={fmtLevel(unit, value)} onChange={(e) => onChange(fromSlider(Number(e.target.value), b), unit)}
            onKeyDown={(e) => {
              // arrows move by the unit's step (a log slider position can round back to the same value); Page keys by ten steps
              const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 }[e.key];
              if (d) { e.preventDefault(); const v = clampLevel(value + d * b.step, b); if (v !== value) onChange(v, unit); }
            }} />
        </>
      ) : null}
      {(on || changed || note) && <div className="f-meta">
        {changed && <span>Default {def!.value > 0 || !optional ? fmtLevel(def!.unit, def!.value) : 'off'} · <button type="button" className="qlink" onClick={() => onChange(def!.value, def!.unit)}>reset</button></span>}
        {on &&<span>{fmtLevel(unit, b.min)}–{fmtLevel(unit, b.max)} · {UNIT[unit].words}</span>}
        {note && <span className="warn">{note}</span>}
      </div>}
    </div>
  );
}
