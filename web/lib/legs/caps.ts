import type { DatasetCaps, Series } from './types';

/**
 * What a data source supports, for checking a spec while it is being edited. The run itself checks against the
 * caps of the sessions it loads (legs.capsOf), which agree with these for the stored data:
 *  - real (Dhan): the nearest expiry of the chosen series, ATM ± 10 strikes, no reliable Greeks, no bid/ask, and
 *    consecutive sessions share contracts, so positions can be held overnight;
 *  - synthetic: one weekly expiry, ATM ± 15 strikes, model Greeks and quotes, every day independent.
 */
export function labCaps(real: boolean, series: Series): DatasetCaps {
  return real
    ? { source: 'dhan', underlying: 'NIFTY', series: [series], nth: [1], strike_window: 10, greeks: false, bid_ask: false, continuous: true, expiry_assumed: false }
    : { source: 'synthetic', underlying: 'NIFTY', series: ['WEEK'], nth: [1], strike_window: 15, greeks: true, bid_ask: true, continuous: false, expiry_assumed: false };
}
