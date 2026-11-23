'use client';
/**
 * The strategy builder's legs as a table: side, type, strike rule, size, stop and target per leg. Edit opens the
 * leg below its row. The first edit copies the structure's legs into the parameters (params.legs, a JSON list);
 * Reset gives the structure's own legs back. A leg's stop and target follow the default for its side (set under
 * Risk rules) unless the leg sets its own or none. Problems come from the engine's own checks (legs.validate).
 */
import { useEffect, useId, useState } from 'react';
import { effectiveLevel, legDrafts, levelText, strikeText, type LegDraft } from '@/lib/strategyRegistry';
import { LEG_UNITS, ON_VALUE, type LevelRole, type LevelUnit } from '@/lib/levels';
import type { Gate, LegLevel, LegSpec, TemplateId } from '@/lib/legs/types';
import type { Params } from '@/lib/types';
import { LevelField } from './LevelField';

const MAX_LEGS = 6;
type Rule = LegSpec['strike'];

/** A number box that commits on blur or Enter, inside [min, max] on the step. */
function NumIn({ id, value, min, max, step, onChange, label }: { id: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string }) {
  const [t, setT] = useState(String(value));
  useEffect(() => setT(String(value)), [value]);
  const commit = () => {
    const v = Number(t);
    if (!Number.isFinite(v) || t.trim() === '') { setT(String(value)); return; }
    const c = Math.min(max, Math.max(min, Math.round(v / step) * step));
    const r = +c.toFixed(4);
    setT(String(r)); if (r !== value) onChange(r);
  };
  return <input id={id} className="in lt-num" inputMode="decimal" aria-label={label} value={t} onChange={(e) => setT(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />;
}

const roleOf = (d: LegDraft, which: 'stop' | 'target'): LevelRole => `${d.action === 'SELL' ? 'short' : 'long'}_${which}` as LevelRole;

function LevelChoice({ id, d, which, p, onChange }: { id: string; d: LegDraft; which: 'stop' | 'target'; p: Params; onChange: (v: LegLevel | null | undefined) => void }) {
  const own = d[which];
  const mode = own === undefined ? 'default' : own === null ? 'none' : 'own';
  const side = d.action === 'SELL' ? 'short' : 'long', word = which === 'stop' ? 'stop' : 'target';
  const fallback = effectiveLevel({ ...d, [which]: undefined }, which, p);
  const role = roleOf(d, which);
  return (
    <div className="lt-lvl">
      <label className="f-label" htmlFor={`${id}-m`}>{which === 'stop' ? 'Stop' : 'Target'}</label>
      <select id={`${id}-m`} className="in" value={mode} onChange={(e) => {
        const m = e.target.value;
        if (m === 'default') onChange(undefined);
        else if (m === 'none') onChange(null);
        else onChange(fallback ?? { kind: 'pct', value: ON_VALUE[role].pct ?? 50 });
      }}>
        <option value="default">Same as other {side} legs ({fallback ? levelText(fallback) : 'none'})</option>
        <option value="none">No {word} on this leg</option>
        <option value="own">Its own {word}</option>
      </select>
      {own && (
        <LevelField id={`${id}-v`} compact label={`${d.id} ${word}`} tip={`This leg's ${word}, measured on its own premium.`} role={role} units={LEG_UNITS}
          unit={own.kind as LevelUnit} value={own.value} onChange={(v, u) => onChange(v > 0 ? { kind: u as LegLevel['kind'], value: v } : null)} />
      )}
    </div>
  );
}

function LegEditor({ d, i, all, p, real, onChange, onRemove }: {
  d: LegDraft; i: number; all: LegDraft[]; p: Params; real: boolean; onChange: (next: LegDraft) => void; onRemove: (() => void) | null;
}) {
  const id = useId();
  const r = d.strike;
  const earlier = all.slice(0, i);
  const setRule = (by: Rule['by']) => {
    const next: Rule = by === 'atm' ? { by, steps: 0 } : by === 'leg' ? { by, leg: earlier[earlier.length - 1]?.id ?? 'L1', steps: 0 }
      : by === 'premium' ? { by, price: 50, side: 'nearest' } : by === 'pct' ? { by, pct: 1 } : { by, delta: 0.25 };
    onChange({ ...d, strike: next });
  };
  const dependents = all.filter((x) => x.strike.by === 'leg' && x.strike.leg === d.id).map((x) => x.id);
  return (
    <div className="lt-edit">
      <div className="lt-grid">
        <fieldset className="lt-f">
          <legend className="f-label">Side</legend>
          <div className="seg2">
            {(['BUY', 'SELL'] as const).map((a) => <label key={a}><input type="radio" name={`${id}-a`} checked={d.action === a} onChange={() => onChange({ ...d, action: a })} /><span>{a === 'BUY' ? 'Buy' : 'Sell'}</span></label>)}
          </div>
        </fieldset>
        <fieldset className="lt-f">
          <legend className="f-label">Type</legend>
          <div className="seg2">
            {(['CE', 'PE'] as const).map((x) => <label key={x}><input type="radio" name={`${id}-r`} checked={d.right === x} onChange={() => onChange({ ...d, right: x })} /><span>{x === 'CE' ? 'Call CE' : 'Put PE'}</span></label>)}
          </div>
        </fieldset>
      </div>
      <div className="lt-f">
        <label className="f-label" htmlFor={`${id}-s`}>Strike</label>
        <div className="lt-strike">
          <select id={`${id}-s`} className="in" value={r.by} onChange={(e) => setRule(e.target.value as Rule['by'])}>
            <option value="atm">From ATM</option>
            <option value="leg" disabled={!earlier.length}>From another leg{earlier.length ? '' : ' (no earlier leg)'}</option>
            <option value="premium">By premium</option>
            <option value="pct">% from spot</option>
            <option value="delta" disabled={real}>By delta{real ? ' (no Greeks in Dhan data)' : ''}</option>
          </select>
          {r.by === 'atm' && <><NumIn id={`${id}-n`} label="Strikes from ATM" value={r.steps} min={-10} max={10} step={1} onChange={(v) => onChange({ ...d, strike: { ...r, steps: v } })} /><span className="lt-hint">strikes, + = OTM</span></>}
          {r.by === 'leg' && <>
            <select className="in lt-num" aria-label="Relative to leg" value={r.leg} onChange={(e) => onChange({ ...d, strike: { ...r, leg: e.target.value } })}>{earlier.map((x) => <option key={x.id} value={x.id}>{x.id}</option>)}</select>
            <NumIn id={`${id}-n`} label="Strikes above that leg" value={r.steps} min={-20} max={20} step={1} onChange={(v) => onChange({ ...d, strike: { ...r, steps: v } })} /><span className="lt-hint">strikes, + = higher</span></>}
          {r.by === 'premium' && <>
            <NumIn id={`${id}-n`} label="Premium in points" value={r.price} min={0.05} max={5000} step={0.05} onChange={(v) => onChange({ ...d, strike: { ...r, price: v } })} />
            <select className="in" aria-label="Which side of that premium" value={r.side ?? 'nearest'} onChange={(e) => onChange({ ...d, strike: { ...r, side: e.target.value as 'nearest' | 'at_most' | 'at_least' } })}>
              <option value="nearest">nearest</option><option value="at_most">at most</option><option value="at_least">at least</option>
            </select></>}
          {r.by === 'pct' && <><NumIn id={`${id}-n`} label="% of spot from ATM" value={r.pct} min={-20} max={20} step={0.1} onChange={(v) => onChange({ ...d, strike: { ...r, pct: v } })} /><span className="lt-hint">% of spot, + = OTM</span></>}
          {r.by === 'delta' && <><NumIn id={`${id}-n`} label="Delta" value={r.delta} min={0.05} max={0.95} step={0.01} onChange={(v) => onChange({ ...d, strike: { ...r, delta: v } })} /><span className="lt-hint">|delta|</span></>}
        </div>
        {r.by === 'premium' && <p className="lt-note">Chosen on the close of the bar before entry, among the stored strikes; the fill is the next open.</p>}
      </div>
      <div className="lt-grid">
        <div className="lt-f">
          <label className="f-label" htmlFor={`${id}-q`}>Lots ×</label>
          <NumIn id={`${id}-q`} label="Lots multiple" value={d.ratio} min={1} max={10} step={1} onChange={(v) => onChange({ ...d, ratio: v })} />
        </div>
        <fieldset className="lt-f">
          <legend className="f-label">Expiry</legend>
          <div className="seg2">
            <label><input type="radio" name={`${id}-x`} checked={(d.nth ?? 1) === 1} onChange={() => onChange({ ...d, nth: undefined })} /><span>Nearest</span></label>
            <label title="Only the nearest expiry of each series is stored"><input type="radio" name={`${id}-x`} checked={d.nth === 2} disabled onChange={() => {}} /><span>Next</span></label>
          </div>
        </fieldset>
      </div>
      <LevelChoice id={`${id}-sl`} d={d} which="stop" p={p} onChange={(v) => { const n = { ...d }; if (v === undefined) delete n.stop; else n.stop = v; onChange(n); }} />
      <LevelChoice id={`${id}-tp`} d={d} which="target" p={p} onChange={(v) => { const n = { ...d }; if (v === undefined) delete n.target; else n.target = v; onChange(n); }} />
      <div className="lt-foot">
        <span className="lt-note">Next expiry: not stored, so calendars and diagonals cannot run.</span>
        {onRemove && (dependents.length
          ? <span className="lt-note">{dependents.join(', ')} {dependents.length > 1 ? 'are' : 'is'} placed from this leg; change {dependents.length > 1 ? 'them' : 'it'} first to remove it.</span>
          : <button type="button" className="qbtn" onClick={onRemove}>Remove {d.id}</button>)}
      </div>
    </div>
  );
}

export function LegTable({ slug, p, set, real, seriesName, gates }: {
  slug: TemplateId; p: Params; set: (k: string, v: string | number | boolean) => void; real: boolean; seriesName: string; gates: Gate[];
}) {
  const drafts = legDrafts(slug, p);
  const edited = typeof p.legs === 'string' && !!p.legs;
  const [open, setOpen] = useState<string | null>(null);
  const write = (next: LegDraft[]) => set('legs', JSON.stringify(next));
  const update = (i: number, d: LegDraft) => write(drafts.map((x, j) => (j === i ? d : x)));
  const add = () => {
    let k = drafts.length + 1;
    while (drafts.some((x) => x.id === `L${k}`)) k++;
    const id = `L${k}`;
    write([...drafts, { id, action: 'BUY', right: 'CE', ratio: 1, strike: { by: 'atm', steps: 0 } }]);
    setOpen(id);
  };
  const byLeg = (id: string) => gates.filter((g) => g.leg === id);
  return (
    <div className="lt">
      <div className="lt-head">
        <span className="sub-h">Legs{edited ? ' · edited' : ''}</span>
        <span className="lt-actions">
          {drafts.length < MAX_LEGS && <button type="button" className="qbtn" onClick={add}>+ Leg</button>}
          {edited && <button type="button" className="qbtn" onClick={() => { set('legs', ''); setOpen(null); }}>Reset</button>}
        </span>
      </div>
      <table className="legs lt-t">
        <thead><tr><th>Leg</th><th>Side</th><th>Strike</th><th>Lots</th><th>Stop</th><th>Target</th><th><span className="sr">Edit</span></th></tr></thead>
        <tbody>
          {drafts.map((d, i) => {
            const stop = effectiveLevel(d, 'stop', p), target = effectiveLevel(d, 'target', p), bad = byLeg(d.id);
            return [
              <tr key={d.id} data-bad={bad.length ? 'true' : undefined} data-open={open === d.id || undefined}>
                <td>{d.id}</td>
                <td><span className="lt-side" data-a={d.action}>{d.action === 'BUY' ? 'Buy' : 'Sell'}</span> {d.right}</td>
                <td>{strikeText(d.strike)}{d.nth === 2 ? ' · next' : ''}</td>
                <td>{d.ratio}×</td>
                <td title={d.stop === undefined ? 'Same as the other legs on this side' : undefined}>{levelText(stop)}{d.stop === undefined && stop ? '*' : ''}</td>
                <td title={d.target === undefined ? 'Same as the other legs on this side' : undefined}>{levelText(target)}{d.target === undefined && target ? '*' : ''}</td>
                <td><button type="button" className="lt-ed-btn" aria-expanded={open === d.id} aria-label={`Edit ${d.id}`} onClick={() => setOpen((o) => (o === d.id ? null : d.id))}>{open === d.id ? 'Done' : 'Edit'}</button></td>
              </tr>,
              open === d.id && (
                <tr key={`${d.id}-ed`} className="lt-ed"><td colSpan={7}>
                  <LegEditor d={d} i={i} all={drafts} p={p} real={real} onChange={(n) => update(i, n)}
                    onRemove={drafts.length > 1 ? () => { write(drafts.filter((_, j) => j !== i)); setOpen(null); } : null} />
                </td></tr>
              ),
            ];
          })}
        </tbody>
      </table>
      {gates.length > 0 && <ul className="lt-gates" role="alert">{gates.map((g, k) => <li key={k}>{g.message}</li>)}</ul>}
      <p className="sec-note">Each leg trades lots × its multiple at the nearest {seriesName} expiry. * = the default for its side, set under Risk rules.{edited ? ' Strike offset and width no longer apply: the legs are edited by hand.' : ''}</p>
    </div>
  );
}
