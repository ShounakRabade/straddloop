'use client';
import type { Field } from '@/lib/strategies';
import type { Params } from '@/lib/types';

export function ParamFields({ fields, params, onChange, idPrefix }: { fields: Field[]; params: Params; onChange: (key: string, value: string | number | boolean) => void; idPrefix: string }) {
  return (
    <>
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        if (f.kind === 'range') {
          const v = Number(params[f.key]);
          return (
            <div className="field" key={f.key}>
              <label htmlFor={id}><span>{f.label}</span><span className="val">{f.prefix ?? ''}{f.prefix ? v.toLocaleString('en-IN') : v}{f.unit ?? ''}</span></label>
              <input id={id} type="range" min={f.min} max={f.max} step={f.step} value={v} aria-describedby={`${id}-h`} onChange={(e) => onChange(f.key, Number(e.target.value))} />
              <p className="help" id={`${id}-h`}>{f.help}</p>
            </div>
          );
        }
        return (
          <fieldset className="field" key={f.key} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend className="flabel" style={{ padding: 0, fontWeight: 650, fontSize: '0.9375rem', marginBottom: 6 }}>{f.label}</legend>
            <div className="seg">
              {f.options.map((o) => (
                <label key={String(o.value)}>
                  <input type="radio" name={id} checked={params[f.key] === o.value} onChange={() => onChange(f.key, o.value)} />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
            <p className="help">{f.help}</p>
          </fieldset>
        );
      })}
    </>
  );
}
