"""Quality report for a Dhan rolling-options pull. Read it before trusting, or extending, a pull.

Every check is computed from what is in the store for the requested range. Each one says PASS, WARN or
FAIL and why. A FAIL means some part of the data cannot be used as it is; WARN means it can be used
with the stated caveat. Nothing here repairs data.
"""

from __future__ import annotations

import json
import statistics
from collections import Counter, defaultdict
from datetime import date, datetime, time
from pathlib import Path

from straddloop.data import store
from straddloop.data.pull import marker_path, read_marker, weekdays
from straddloop.timeutil import IST, MINUTES_PER_SESSION

STRIKE_STEP = {"NIFTY": 50.0, "BANKNIFTY": 100.0, "SENSEX": 100.0}
MIN_BAR_SHARE = 0.95
ENTRY_TIME = time(9, 50)
EXIT_TIME = time(15, 15)
SNAPSHOT_TIME = time(9, 20)

PASS, WARN, FAIL, INFO = "PASS", "WARN", "FAIL", "INFO"


def _offset(label: str) -> int:
    return 0 if label == "ATM" else int(label[3:])


def _load(store_dir: Path, underlying: str, flag: str, code: int, start: date, end: date):
    lo, hi = datetime.combine(start, time(0), IST), datetime.combine(end, time(0), IST)
    opt = store.query(
        store_dir, "option_candles",
        "underlying = ? AND expiry_flag = ? AND expiry_code = ? AND ts >= ? AND ts < ?",
        [underlying, flag, code, lo, hi],
    )
    idx = store.query(store_dir, "underlying_candles", "underlying = ? AND ts >= ? AND ts < ?", [underlying, lo, hi])
    rows = opt.to_pylist() if opt is not None else []
    for r in rows:
        r["ts"] = r["ts"].astimezone(IST)
    index = {}
    for r in (idx.to_pylist() if idx is not None else []):
        index[r["ts"].astimezone(IST)] = r["close"]
    return rows, index


def _pct(n: int, d: int) -> float:
    return round(100.0 * n / d, 2) if d else 0.0


def build_quality(store_dir: Path, underlying: str, flag: str, code: int, window: int, interval: int,
                  start: date, end: date) -> dict:
    rows, index = _load(store_dir, underlying, flag, code, start, end)
    step = STRIKE_STEP.get(underlying)
    checks: list[dict] = []

    def add(name, status, detail, **data):
        checks.append({"check": name, "status": status, "detail": detail, **data})

    expected_bars = MINUTES_PER_SESSION // interval
    labels = ["ATM"] + [f"ATM{o:+d}" for o in range(-window, window + 1) if o]

    # ---- coverage ------------------------------------------------------------------------------
    requested = weekdays(start, end)
    opt_days = sorted({r["ts"].date() for r in rows})
    idx_days = sorted({ts.date() for ts in index})
    not_pulled = [d for d in requested
                  if read_marker(marker_path(store_dir, underlying, flag, code, interval, d)) is None]
    holidays = [d for d in requested if d not in opt_days and d not in idx_days and d not in not_pulled]
    only_idx = [d for d in idx_days if d not in opt_days]
    only_opt = [d for d in opt_days if d not in idx_days]
    status = FAIL if (not_pulled or only_idx or only_opt or not opt_days) else PASS
    add("coverage", status,
        f"{len(requested)} weekdays requested, {len(opt_days)} with option data, {len(idx_days)} with index data; "
        f"not yet pulled: {_dates(not_pulled)}; index but no options: {_dates(only_idx)}; "
        f"options but no index: {_dates(only_opt)}",
        not_pulled=_iso(not_pulled), index_only=_iso(only_idx), options_only=_iso(only_opt))
    add("holidays", INFO, f"weekdays with no data in any series: {_dates(holidays)} "
        "(compare with the exchange holiday list)", days=_iso(holidays))

    # ---- series present and bars per series-day ------------------------------------------------
    bars: dict[tuple, int] = Counter((r["ts"].date(), r["option_type"], r["moneyness"]) for r in rows)
    missing_series, short_atm, short_other = [], [], []
    for d in opt_days:
        for t in ("CE", "PE"):
            for label in labels:
                n = bars.get((d, t, label), 0)
                if n == 0:
                    missing_series.append(f"{d} {t} {label}")
                elif n < MIN_BAR_SHARE * expected_bars:
                    (short_atm if label == "ATM" else short_other).append(f"{d} {t} {label} ({n})")
    atm_missing = [s for s in missing_series if s.endswith(" ATM")]
    add("series present", FAIL if atm_missing else (WARN if missing_series else PASS),
        f"{len(missing_series)} of {len(opt_days) * 2 * len(labels)} series-days missing" +
        (f": {', '.join(missing_series[:12])}{' ...' if len(missing_series) > 12 else ''}" if missing_series else ""))
    add("missing option bars", FAIL if short_atm else (WARN if short_other else PASS),
        f"series-days under {int(MIN_BAR_SHARE * 100)}% of {expected_bars} bars: ATM {len(short_atm)}, "
        f"other strikes {len(short_other)}" + (f"; ATM: {', '.join(short_atm[:8])}" if short_atm else "")
        + (f"; others: {', '.join(short_other[:8])}" if short_other else ""))

    idx_per_day = Counter(ts.date() for ts in index)
    short_idx = [f"{d} ({n})" for d, n in sorted(idx_per_day.items()) if n < MIN_BAR_SHARE * expected_bars]
    add("missing index bars", WARN if short_idx else PASS,
        f"{len(short_idx)} of {len(idx_per_day)} index sessions under {int(MIN_BAR_SHARE * 100)}% of bars"
        + (f": {', '.join(short_idx)}" if short_idx else ""))

    # ---- prices and fields ---------------------------------------------------------------------
    n = len(rows)
    nonpos = sum(1 for r in rows if r["close"] is None or r["close"] <= 0 or r["open"] <= 0)
    zero_vol = sum(1 for r in rows if not r["volume"])
    no_strike = sum(1 for r in rows if r["strike"] is None)
    no_spot = sum(1 for r in rows if r["spot"] is None)
    no_iv = sum(1 for r in rows if r["iv"] is None)
    no_oi = sum(1 for r in rows if r["oi"] is None)
    dropped = Counter()
    for d in requested:
        m = read_marker(marker_path(store_dir, underlying, flag, code, interval, d)) or {}
        dropped.update(m.get("dropped", {}))
    add("bad prices", FAIL if nonpos else (WARN if _pct(zero_vol, n) > 5 else PASS),
        f"{n} option bars; non-positive open/close: {nonpos}; zero-volume bars: {_pct(zero_vol, n)}% "
        f"(may carry stale prices); dropped by validation: {dict(dropped) or 'none'}")
    add("fields present", FAIL if (no_strike or no_spot) else (WARN if (no_iv or no_oi) else PASS),
        f"missing strike {no_strike}, spot {no_spot}, iv {no_iv} ({_pct(no_iv, n)}%), oi {no_oi} ({_pct(no_oi, n)}%)")

    # ---- strikes -------------------------------------------------------------------------------
    by_ts: dict[tuple, dict] = defaultdict(dict)  # (ts, type) -> label -> row
    for r in rows:
        by_ts[(r["ts"], r["option_type"])][r["moneyness"]] = r
    if step:
        off_grid = sum(1 for r in rows if r["strike"] is not None and r["strike"] % step)
        add("strike grid", FAIL if off_grid else PASS,
            f"{off_grid} bars with a strike off the {step:g}-point grid")
    atm_rows = [r for r in rows if r["moneyness"] == "ATM" and r["strike"] is not None and r["spot"]]
    if step and atm_rows:
        far = sum(1 for r in atm_rows if abs(r["strike"] - r["spot"]) > step)
        add("ATM near spot", PASS if _pct(far, len(atm_rows)) <= 1 else FAIL,
            f"ATM strike more than one step ({step:g}) from Dhan's spot on {far} of {len(atm_rows)} bars "
            f"({_pct(far, len(atm_rows))}%)")
    direction = {}
    for t in ("CE", "PE"):
        up = down = mismatch = total = 0
        for (_ts, typ), by_label in by_ts.items():
            if typ != t or "ATM" not in by_label or by_label["ATM"]["strike"] is None:
                continue
            k0 = by_label["ATM"]["strike"]
            for label, r in by_label.items():
                o = _offset(label)
                if o == 0 or r["strike"] is None:
                    continue
                total += 1
                diff = (r["strike"] - k0) / step if step else None
                if diff == o:
                    up += 1
                elif diff == -o:
                    down += 1
                else:
                    mismatch += 1
        direction[t] = (up, down, mismatch, total)
    detail_parts, ok = [], True
    for t, (up, down, mismatch, total) in direction.items():
        if not total:
            continue
        way = "higher" if up >= down else "lower"
        consistent = max(up, down)
        ok &= _pct(consistent, total) >= 99
        detail_parts.append(f"{t}: ATM+n is a {way} strike on {_pct(consistent, total)}% of {total} bars "
                            f"(strike = ATM {'+' if way == 'higher' else '-'} n x step), mismatches {mismatch}")
    if detail_parts:
        add("strike reconstruction", PASS if ok else FAIL, "; ".join(detail_parts),
            direction={t: ("higher" if v[0] >= v[1] else "lower") for t, v in direction.items() if v[3]})

    # ---- spot vs index -------------------------------------------------------------------------
    diffs = [(r["spot"] - index[r["ts"]]) / index[r["ts"]] * 100
             for r in atm_rows if r["ts"] in index and index[r["ts"]]]
    if diffs:
        med = statistics.median(abs(x) for x in diffs)
        p99 = sorted(abs(x) for x in diffs)[int(0.99 * (len(diffs) - 1))]
        add("spot vs index", PASS if med <= 0.05 and p99 <= 0.2 else WARN,
            f"Dhan option `spot` against the index candle close at the same minute, {len(diffs)} bars: "
            f"median |diff| {med:.4f}% of spot, 99th percentile {p99:.4f}%")
    else:
        add("spot vs index", WARN, "no overlapping minutes between option and index candles")

    # ---- put-call parity at ATM ----------------------------------------------------------------
    devs = []
    for (ts, typ), by_label in by_ts.items():
        if typ != "CE" or "ATM" not in by_label:
            continue
        c = by_label["ATM"]
        p = by_ts.get((ts, "PE"), {}).get("ATM")
        if not p or c["strike"] != p["strike"] or not c["volume"] or not p["volume"] or not c["spot"]:
            continue
        devs.append(((c["close"] - p["close"]) - (c["spot"] - c["strike"])) / c["spot"] * 100)
    if devs:
        med = statistics.median(abs(x) for x in devs)
        add("put-call parity (ATM)", PASS if med <= 0.3 else (WARN if med <= 1 else FAIL),
            f"(C - P) - (S - K) on {len(devs)} minutes where both legs traded: median |dev| {med:.3f}% of spot, "
            f"median signed {statistics.median(devs):+.3f}% (a small positive value is the futures basis)")
    else:
        add("put-call parity (ATM)", WARN, "no minutes with both ATM legs traded at the same strike")

    # ---- entry strike stays in the window ------------------------------------------------------
    stays = 0
    eligible = 0
    for d in opt_days:
        entry = by_ts.get((datetime.combine(d, ENTRY_TIME, IST), "CE"), {}).get("ATM")
        if not entry or entry["strike"] is None:
            continue
        eligible += 1
        k = entry["strike"]
        exit_ts = datetime.combine(d, EXIT_TIME, IST)
        has = all(any(r["strike"] == k for r in by_ts.get((exit_ts, t), {}).values()) for t in ("CE", "PE"))
        stays += has
    add("entry strike stays in window", PASS if eligible and stays == eligible else WARN,
        f"the {ENTRY_TIME:%H:%M} ATM strike still has CE and PE bars at {EXIT_TIME:%H:%M} "
        f"on {stays} of {eligible} days (window ATM+-{window})")

    # ---- expiry mapping ------------------------------------------------------------------------
    add("expiry mapping", WARN,
        "NOT CHECKED: Dhan gives a relative expiry code, not a date. Real expiry dates come from the NSE "
        "bhavcopy import (later step). Use the daily table below to see where the series rolls: the ATM "
        "straddle shrinks into an expiry and jumps the session after it.")

    daily = []
    for d in opt_days:
        snap = datetime.combine(d, SNAPSHOT_TIME, IST)
        c = by_ts.get((snap, "CE"), {}).get("ATM")
        p = by_ts.get((snap, "PE"), {}).get("ATM")
        if c and p and c["spot"]:
            daily.append({
                "day": d.isoformat(), "weekday": d.strftime("%a"), "spot": round(c["spot"], 2), "strike": c["strike"],
                "ce": c["close"], "pe": p["close"], "straddle": round(c["close"] + p["close"], 2),
                "straddle_pct": round((c["close"] + p["close"]) / c["spot"] * 100, 3),
                "iv_ce": c["iv"], "iv_pe": p["iv"],
            })

    overall = FAIL if any(c["status"] == FAIL for c in checks) else PASS
    return {
        "generated_at": datetime.now(IST).isoformat(timespec="seconds"),
        "underlying": underlying, "series": f"{flag} code {code}", "window": window, "interval_min": interval,
        "start": start.isoformat(), "end_exclusive": end.isoformat(),
        "overall": overall, "checks": checks, "daily_atm_snapshot": daily,
    }


def write_quality(report: dict, reports_dir: Path) -> tuple[Path, Path]:
    reports_dir.mkdir(parents=True, exist_ok=True)
    stem = (f"quality_{report['underlying']}_{report['series'].replace(' code ', '')}_"
            f"{report['start']}_{report['end_exclusive']}")
    j = reports_dir / f"{stem}.json"
    m = reports_dir / f"{stem}.md"
    j.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    m.write_text(render_markdown(report), encoding="utf-8")
    return j, m


def render_markdown(r: dict) -> str:
    out = [
        f"# Quality report: {r['underlying']} {r['series']}, {r['start']} to {r['end_exclusive']} (exclusive)",
        "",
        f"Generated {r['generated_at']}. Strikes ATM+-{r['window']}, {r['interval_min']}-minute bars.",
        "",
        f"**Overall: {r['overall']}**" + ("" if r["overall"] == PASS else " (see the FAIL rows)"),
        "",
        "| Check | Result | Detail |",
        "| --- | --- | --- |",
    ]
    for c in r["checks"]:
        out.append(f"| {c['check']} | {c['status']} | {c['detail'].replace('|', '/')} |")
    out += ["", f"## ATM at {SNAPSHOT_TIME:%H:%M} each day", ""]
    if r["daily_atm_snapshot"]:
        out += ["| Day | | Spot | Strike | CE | PE | Straddle | % of spot | IV CE | IV PE |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for d in r["daily_atm_snapshot"]:
            out.append(f"| {d['day']} | {d['weekday']} | {d['spot']} | {d['strike']:g} | {d['ce']} | {d['pe']} | "
                       f"{d['straddle']} | {d['straddle_pct']} | {d['iv_ce']} | {d['iv_pe']} |")
    else:
        out.append("No day has both ATM legs at that minute.")
    return "\n".join(out) + "\n"


def _iso(days: list[date]) -> list[str]:
    return [d.isoformat() for d in days]


def _dates(days: list[date]) -> str:
    return ", ".join(_iso(days)) if days else "none"
