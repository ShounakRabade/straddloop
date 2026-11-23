'use client';
/* Small building blocks of the Lab workspace: icons, the (i) tooltip, a parameter field and a rail section. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fieldChanged, unitOf, type Field } from '@/lib/strategies';
import { fmtLevel, type LevelUnit } from '@/lib/levels';
import { toMin, type TimeSpec } from '@/lib/sessionTime';
import { LevelField } from './LevelField';
import { TimeField } from './TimeField';
import type { Params } from '@/lib/types';

export const Icon = {
  panel: () => <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="1.5" /><path d="M7.5 3.5v13" /></svg>,
  chev: () => <svg className="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>,
  right: () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>,
  left: () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m10 4-4 4 4 4" /></svg>,
  play: () => <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" /></svg>,
  close: () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>,
  sliders: () => <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 6h9M15 6h2M3 14h3M9 14h8" /><circle cx="13.5" cy="6" r="1.8" /><circle cx="7.5" cy="14" r="1.8" /></svg>,
};

/** True after hydration; used to keep portals and media queries out of the server render. */
export function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

/**
 * An (i) button with a short definition. Opens on hover, focus or tap; Escape closes it. The full text is also
 * the button's accessible description, so screen readers get it without the popover.
 */
export function Tip({ label, text, def }: { label: string; text: string; def?: string | null }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
  const id = useId();
  const mounted = useMounted();
  const place = useCallback(() => {
    const b = btn.current?.getBoundingClientRect(), p = pop.current?.getBoundingClientRect();
    if (!b) return;
    const w = p?.width ?? 280, h = p?.height ?? 80;
    const below = b.top < h + 16;
    const x = Math.max(12, Math.min(window.innerWidth - w - 12, b.left + b.width / 2 - w / 2));
    setPos({ x, y: below ? b.bottom + 8 : b.top - h - 8, below });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const away = (e: PointerEvent) => { if (!btn.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', key); window.addEventListener('pointerdown', away);
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', away); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, place]);
  return (
    <>
      <button ref={btn} type="button" className="tip" aria-label={`About ${label}`} aria-expanded={open} aria-describedby={`${id}-d`}
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}>i</button>
      <span id={`${id}-d`} className="sr">{text}{def ? ` ${def}` : ''}</span>
      {mounted && open && createPortal(
        <div ref={pop} className="tip-pop" role="tooltip" style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: 0 }}>
          <b>{label}</b>{text}{def && <span className="def">{def}</span>}
        </div>, document.body)}
    </>
  );
}

/** A field's value as words: '₹1,000', '36%', 'Off', '09:50', the option's label. */
export const fmtVal = (f: Field, v: unknown, p?: Params) => {
  if (f.kind === 'choice') return f.options.find((o) => o.value === v)?.label ?? String(v);
  if (f.kind === 'time' || f.kind === 'legs') return String(v ?? '');
  const n = Number(v);
  if (f.kind === 'level') return f.optional && n === 0 ? 'Off' : fmtLevel(p ? unitOf(f, p) : f.units[0], n);
  if (f.zeroOff && n === 0) return 'Off';
  return `${f.prefix ?? ''}${f.prefix ? n.toLocaleString('en-IN') : n}${f.unit ?? ''}`;
};

/** Time-field context from the rail: the picker interval and any order problem with this time. */
export interface TimeCtx { interval: number; onInterval: (n: number) => void; problem?: { level: 'error' | 'note'; text: string } | null }

/**
 * One strategy or account parameter: label, (i), the control, and what the default is. Reads and writes the whole
 * parameter set, so a level can change its value and its unit together.
 */
export function ParamField({ f, p, d, set, idPrefix, tip, warn, time }: {
  f: Field; p: Params; d: Params; set: (k: string, v: string | number | boolean) => void; idPrefix: string; tip?: string; warn?: string | null; time?: TimeCtx;
}) {
  const id = `${idPrefix}-${f.key}`;
  const value = p[f.key], def = d[f.key];
  const changed = fieldChanged(f, p, d);
  const help = tip ?? f.help;
  if (f.kind === 'legs') return null; // the legs table draws these
  if (f.kind === 'time') {
    const spec: TimeSpec = { min: toMin(f.min)!, max: toMin(f.max)!, grain: f.grain };
    return <TimeField id={id} label={f.label} role={f.role} value={String(value ?? def ?? '')} def={def as string | undefined} spec={spec} tip={help}
      onChange={(v) => set(f.key, v)} interval={time?.interval ?? 5} onInterval={time?.onInterval ?? (() => {})} problem={time?.problem ?? null} />;
  }
  if (f.kind === 'level') {
    const unit = unitOf(f, p);
    return <LevelField id={id} label={f.label} tip={help} role={f.role} units={f.units} unit={unit} value={Number(value ?? 0)} bounds={f.bounds} optional={f.optional}
      def={def !== undefined ? { value: Number(def), unit: unitOf(f, d) } : null}
      onChange={(v: number, u: LevelUnit) => { set(f.key, v); if (f.unitKey) set(f.unitKey, u); }} />;
  }
  // the default and a reset appear once a value differs from it; an unchanged field needs no extra line
  const meta = (changed || warn) ? (
    <div className="f-meta">
      {changed && <span>Default {fmtVal(f, def)} · <button type="button" className="qlink" onClick={() => set(f.key, def as string | number | boolean)}>reset</button></span>}
      {warn && <span className="warn">{warn}</span>}
    </div>
  ) : null;
  if (f.kind === 'range') {
    const v = Number(value);
    return (
      <div className="f" data-changed={changed}>
        <div className="f-top">
          <label className="f-label" htmlFor={id}>{f.label}</label>
          <Tip label={f.label} text={help} />
          <span className="f-val" aria-hidden="true">{fmtVal(f, v)}</span>
        </div>
        <input id={id} type="range" min={f.min} max={f.max} step={f.step} value={v} aria-valuetext={fmtVal(f, v)} onChange={(e) => set(f.key, Number(e.target.value))} />
        {meta}
      </div>
    );
  }
  // A few short options read best side by side; more, or long ones, go in a compact dropdown instead of a tall list.
  const inline = f.options.length <= 3 && f.options.every((o) => o.label.length <= 14);
  if (!inline) {
    const at = f.options.findIndex((o) => o.value === value);
    return (
      <div className="f" data-changed={changed}>
        <div className="f-top">
          <label className="f-label" htmlFor={id}>{f.label}</label>
          <Tip label={f.label} text={help} />
        </div>
        <select id={id} className="in" value={at < 0 ? '' : String(at)} onChange={(e) => set(f.key, f.options[Number(e.target.value)].value)}>
          {at < 0 && <option value="">{String(value)}</option>}
          {f.options.map((o, i) => <option key={String(o.value)} value={String(i)}>{o.label}</option>)}
        </select>
        {meta}
      </div>
    );
  }
  return (
    <fieldset className="f" data-changed={changed} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="f-top">
        <legend className="f-label" style={{ padding: 0, float: 'left' }}>{f.label}</legend>
        <Tip label={f.label} text={help} />
      </div>
      <div className="seg2">
        {f.options.map((o) => (
          <label key={String(o.value)}>
            <input type="radio" name={id} checked={value === o.value} onChange={() => set(f.key, o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {meta}
    </fieldset>
  );
}

/** A collapsible group of the configuration rail. The header always says what is set inside. */
export function Section({ id, letter, title, summary, open, onToggle, changed, errors, warns, children, dim }: {
  id: string; letter: string; title: string; summary: ReactNode; open: boolean; onToggle: () => void;
  changed?: number; errors?: number; warns?: number; children: ReactNode; dim?: boolean;
}) {
  return (
    <section className="sec" data-open={open} data-guided={dim ? 'dim' : undefined} id={`sec-${id}`} aria-labelledby={`sec-${id}-h`}>
      <button type="button" className="sec-h" id={`sec-${id}-h`} aria-expanded={open} aria-controls={`sec-${id}-b`} onClick={onToggle}>
        <span className="let" aria-hidden="true">{letter}</span>
        <span className="ttl">{title}</span>
        <span className="badges">
          {!!errors && <span className="badge badge--err">{errors} to fix</span>}
          {!errors && !!warns && <span className="badge badge--warn">check</span>}
          {!!changed && <span className="badge badge--chg">{changed} changed</span>}
        </span>
        <Icon.chev />
        <span className="sum">{summary}</span>
      </button>
      <div className="sec-b" id={`sec-${id}-b`} role="region" aria-labelledby={`sec-${id}-h`}>
        <div><div className="sec-in">{children}</div></div>
      </div>
    </section>
  );
}
