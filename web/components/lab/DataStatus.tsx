'use client';
/**
 * The data source in one line at the top of the results: what the run reads, and the one caveat that always applies
 * (real candles have no bid/ask, so fills are optimistic; synthetic results are not evidence). The assumptions
 * behind every figure open below it on request.
 */
import { useId, useState } from 'react';
import { shortDate } from '@/lib/format';
import type { RunResult } from '@/lib/types';

export function DataStatus({ real, local, r, slip, brokerage, seriesName, syn, family, onSwitch }: {
  real: boolean; local: number | null; r: RunResult | null; slip: number; brokerage: number; seriesName: string;
  syn: { days: number; seed: number; iv: number; months?: number; fourleg: boolean }; family: 'engine' | 'builder';
  onSwitch: { label: string; go: () => void } | null;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const d = r?.data;
  const rows: [string, string][] = real ? [
    ['Data', `Dhan 1-minute candles for NIFTY options (the nearest ${seriesName} expiry, ATM ± 10 strikes) and the NIFTY index${local ? `, from ${local} day files on this computer` : ', from the day files in your Supabase project'}.`],
    ['Fills', `Decided on completed bars, filled at the next bar’s open, ${slip}% and one tick against you. Stops trigger on the bar’s high (short) or low (long), fill at the worse of the stop and the open, and pay twice the slippage.`],
    ['Day files', !d?.checksums ? 'Each file is checked against the SHA-256 the inventory lists for it before it is used; a file that does not match is refused.'
      : d.checksums.checked === d.checksums.files ? `All ${d.checksums.files} day files matched the SHA-256 the inventory lists for them.`
        : local ? `Files from this computer have no stored checksum, so ${d.checksums.files - d.checksums.checked} of ${d.checksums.files} were used unchecked.`
          : `${d.checksums.checked} of ${d.checksums.files} day files were checked against their stored SHA-256; the rest have no checksum on record (or this page has no Web Crypto) and were used unchecked.`],
    ['Order book', 'No bid/ask history is stored, so a real order could fill worse, above all on a stop. Treat every result as optimistic.'],
    ['Expiry and lot size', d ? `Expiry dates ${/bhavcopy/i.test(d.expiry_source) ? 'from the NSE bhavcopy' : 'assumed from the weekday rule until checked against the NSE bhavcopy'}; lot size ${d.lot_sizes.join(' / ')}, ${/set/i.test(d.lot_source) ? 'set by you' : 'from the day files'}.` : 'From each day file: the NSE bhavcopy where imported, otherwise the weekday rule (assumed).'],
    ['Charges', `STT, exchange, SEBI, stamp duty and GST at the rates in force on each trade date; brokerage ₹${brokerage} an order. Cash settlement at expiry pays STT on in-the-money long options only.`],
    ['Margin', family === 'builder' ? 'Estimated: the worst loss of the open legs over a ± move of the index, plus exposure margin. Not SPAN, not your broker’s figure.' : 'Estimated as a share of the notional of each short option. Not SPAN, not your broker’s figure.'],
    ['Use', 'A research tool. Nothing here is investment advice; Straddloop places no orders.'],
  ] : syn.fourleg ? [
    ['Data', `Four imaginary stocks with monthly options, ${syn.months ?? 24} months of daily closes, generated from a fixed seed.`],
    ['Fills and margin', 'Priced and margined inside the model; there is no account ledger.'],
    ['Use', 'Shows how the rules behave; it is not evidence about any real stock.'],
  ] : [
    ['Data', `An imaginary NIFTY-like index (1-minute bars, realised volatility 12%) with options priced at a model implied volatility of ${syn.iv}%. Seed ${syn.seed}, ${syn.days} sessions, dated in 2099 so they cannot be mistaken for history.`],
    ['Fills', `At the model’s bid and ask, plus ${slip}% slippage; stops pay twice the slippage.`],
    ['Charges', `The dated statutory rates and ₹${brokerage} an order, as on real data.`],
    ['Use', 'Shows how a rule reacts to a setting. It is not evidence about NIFTY.'],
  ];
  return (
    <div className="ds" data-kind={real ? 'real' : 'synthetic'}>
      <div className="ds-line">
        <span className="stamp2">{real ? 'Real data' : 'Synthetic'}</span>
        <span className="ds-txt">
          {real
            ? <>NIFTY {seriesName} · Dhan 1-min{d ? <> · {shortDate(d.from)} – {shortDate(d.to)} ({d.days})</> : null} · slip {slip}% · <b>no bid/ask: fills optimistic</b></>
            : syn.fourleg ? <>Four imaginary stocks · not evidence about real stocks</> : <>Imaginary NIFTY-like market · dates in 2099 · <b>not evidence about NIFTY</b></>}
        </span>
        <button type="button" className="qlink" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>{open ? 'Hide assumptions' : 'Assumptions'}</button>
        {onSwitch && <button type="button" className="qlink" onClick={onSwitch.go}>{onSwitch.label}</button>}
      </div>
      <dl className="ds-panel" id={id} hidden={!open}>
        {rows.map(([k, v]) => [<dt key={`t${k}`}>{k}</dt>, <dd key={`d${k}`}>{v}</dd>])}
      </dl>
    </div>
  );
}
