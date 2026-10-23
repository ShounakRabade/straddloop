"""Data coverage report: what the stored data can and cannot support.

The report is built only from data actually in the store. With an empty store it says so; it never
fills sections with placeholder numbers.
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from straddloop.data import store
from straddloop.data.schema import OptionCandle, UnderlyingCandle
from straddloop.data.validate import (
    fixed_contract_coverage,
    option_series_quality,
    validate_candles,
)
from straddloop.timeutil import IST, MINUTES_PER_SESSION


def _rows(root: Path, dataset: str, record_type: type) -> list:
    table = store.query(root, dataset)
    if table is None:
        return []
    names = list(record_type.__dataclass_fields__)
    out = []
    for row in table.to_pylist():
        values = {k: row[k] for k in names}
        values["ts"] = values["ts"].astimezone(IST)
        out.append(record_type(**values))
    return out


def build_report(root: Path) -> dict:
    report: dict = {
        "generated_at": datetime.now(IST).isoformat(timespec="seconds"),
        "dataset_hashes": {d: store.dataset_hash(root, d) for d in sorted(store.DATASETS)},
        "underlying": {},
        "options": {},
        "bid_ask_available": False,
        "known_limitations": [
            "No historical bid/ask from any configured source: spreads are modelled, not observed.",
            "Option prices are 1-minute OHLC: the order of events inside a minute is unknown.",
        ],
    }
    underlying = _rows(root, "underlying_candles", UnderlyingCandle)
    by_u: dict[str, list] = defaultdict(list)
    for c in underlying:
        by_u[c.underlying].append(c)
    for name, candles in sorted(by_u.items()):
        v = validate_candles(candles)
        days = sorted(v.sessions)
        report["underlying"][name] = {
            "first_session": days[0].isoformat() if days else None,
            "last_session": days[-1].isoformat() if days else None,
            "sessions": len(days),
            "missing_minutes_pct": v.missing_pct(candles[0].interval_min),
            "dropped_rows": dict(v.dropped),
            "timestamp_label": v.label_convention,
        }

    options = _rows(root, "option_candles", OptionCandle)
    by_series: dict[tuple, list] = defaultdict(list)
    for c in options:
        by_series[(c.underlying, c.expiry_flag, c.expiry_code)].append(c)
    for (name, flag, code), candles in sorted(by_series.items(), key=lambda kv: str(kv[0])):
        v = validate_candles(candles)
        labels = defaultdict(list)
        for c in v.kept:
            labels[(c.option_type, c.moneyness)].append(c)
        quality = {f"{t} {m}": asdict(option_series_quality(cs)) for (t, m), cs in sorted(labels.items())}
        fixed = fixed_contract_coverage(v.kept)
        full = sum(1 for n in fixed.values() if n >= MINUTES_PER_SESSION)
        days = sorted({c.ts.date() for c in v.kept})
        bars = sum(q["bars"] for q in quality.values()) or 1
        report["options"][f"{name} {flag} code {code}"] = {
            "first_session": days[0].isoformat() if days else None,
            "last_session": days[-1].isoformat() if days else None,
            "sessions": len(days),
            "series": len(quality),
            "dropped_rows": dict(v.dropped),
            "timestamp_label": v.label_convention,
            "zero_volume_pct": round(100 * sum(q["zero_volume_bars"] for q in quality.values()) / bars, 2),
            "stale_pct": round(100 * sum(q["stale_bars"] for q in quality.values()) / bars, 2),
            "fixed_contracts_seen": len(fixed),
            "fixed_contracts_full_session_pct": round(100 * full / len(fixed), 2) if fixed else None,
            "expiry_dates_resolved": all(c.expiry is not None for c in v.kept),
            "series_quality": quality,
        }
    if options and not all(c.expiry is not None for c in options):
        report["known_limitations"].append(
            "Option candles carry a relative expiry code only; actual expiry dates and lot sizes must be "
            "joined from the exchange bhavcopy before a backtest."
        )
    return report


def to_markdown(report: dict) -> str:
    lines = [f"# Data coverage report\n\nGenerated {report['generated_at']}.\n"]
    if not report["underlying"] and not report["options"]:
        lines.append("The store is empty. No coverage can be claimed until real data has been pulled.\n")
    if report["underlying"]:
        lines.append("## Underlying candles\n")
        lines.append("| Underlying | First | Last | Sessions | Missing minutes % | Label | Dropped |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- |")
        for name, r in report["underlying"].items():
            lines.append(
                f"| {name} | {r['first_session']} | {r['last_session']} | {r['sessions']} | "
                f"{r['missing_minutes_pct']} | {r['timestamp_label']} | {r['dropped_rows'] or 'none'} |"
            )
    if report["options"]:
        lines.append("\n## Option candles\n")
        lines.append("| Series | First | Last | Sessions | Zero-volume % | Stale % | Full-session contracts % "
                     "| Expiry dates resolved |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
        for name, r in report["options"].items():
            lines.append(
                f"| {name} | {r['first_session']} | {r['last_session']} | {r['sessions']} | "
                f"{r['zero_volume_pct']} | {r['stale_pct']} | {r['fixed_contracts_full_session_pct']} | "
                f"{r['expiry_dates_resolved']} |"
            )
    lines.append(f"\nBid/ask history available: {report['bid_ask_available']}.\n")
    lines.append("## Known limitations\n")
    lines += [f"- {item}" for item in report["known_limitations"]]
    lines.append(f"\nDataset hashes: {report['dataset_hashes']}\n")
    return "\n".join(lines)


def write_report(root: Path, out_dir: Path) -> tuple[Path, Path]:
    report = build_report(root)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(IST).strftime("%Y%m%d-%H%M%S")
    j = out_dir / f"coverage-{stamp}.json"
    m = out_dir / f"coverage-{stamp}.md"
    j.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    m.write_text(to_markdown(report), encoding="utf-8")
    return j, m
