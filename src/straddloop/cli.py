"""Command line entry point: `straddloop <command>`."""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
from datetime import date, timedelta
from pathlib import Path

from straddloop.log import setup_logging
from straddloop.settings import get_settings

log = logging.getLogger("straddloop")

SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"


def cmd_status(args, settings) -> int:
    print(json.dumps(settings.describe(), indent=2))
    return 0


def cmd_dhan_check_ids(args, settings) -> int:
    """Print Dhan's scrip-master rows for the three indices so the security ids can be confirmed."""
    import httpx

    text = httpx.get(SCRIP_MASTER_URL, timeout=60).text
    wanted = {"NIFTY", "BANKNIFTY", "SENSEX", "NIFTY 50", "NIFTY BANK", "INDIA VIX"}
    for row in csv.DictReader(io.StringIO(text)):
        values = {v.strip().upper() for v in row.values() if v}
        if "INDEX" in values and values & wanted:
            print(row)
    return 0


def cmd_dhan_sample(args, settings) -> int:
    """Resumable pull (index + options, one day per option call), then the quality and coverage reports."""
    from straddloop.data.coverage import write_report
    from straddloop.data.providers.dhan import DhanProvider
    from straddloop.data.pull import failed_days_report, pull_options, pull_underlying

    provider = DhanProvider(
        settings.dhan_client_id, settings.dhan_access_token, settings.raw_dir, settings.dhan_requests_per_second
    )
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    log.info("Pulling %s index candles %s to %s (end exclusive)", args.underlying, start, end)
    pull_underlying(provider, settings.store_dir, args.underlying, start, end, args.interval)
    calls = 2 * (2 * args.window + 1)
    log.info("Pulling %s %s code %d options, ATM+-%d (%d calls per day)", args.underlying, args.expiry_flag,
             args.expiry_code, args.window, calls)
    s = pull_options(provider, settings.store_dir, args.underlying, start, end, args.window, args.expiry_flag,
                     args.expiry_code, args.interval, refetch=args.refetch)
    log.info("Options: %d days fetched, %d already done, %d with no data; %d rows; dropped %s",
             len(s.days_fetched), len(s.days_skipped), len(s.holidays), s.option_rows, dict(s.dropped))
    if s.days_failed:
        print(failed_days_report(s), end="")
    write_report(settings.store_dir, settings.reports_dir)
    return cmd_dhan_quality(args, settings)


def cmd_dhan_quality(args, settings) -> int:
    from straddloop.data.quality import build_quality, write_quality

    report = build_quality(settings.store_dir, args.underlying, args.expiry_flag, args.expiry_code, args.window,
                           args.interval, date.fromisoformat(args.start), date.fromisoformat(args.end))
    _, m = write_quality(report, settings.reports_dir)
    print(m.read_text(encoding="utf-8"))
    print(f"Written to {m}")
    return 0 if report["overall"] == "PASS" else 1


def _symbols(arg: str | None):
    return set(arg.split(",")) if arg else None


def cmd_import_bhavcopy(args, settings) -> int:
    """Manual path: bhavcopy files downloaded in a browser (zip or csv, UDiFF or legacy layout)."""
    from straddloop.reference.bhav_pipeline import import_files

    paths = []
    for f in args.files:
        p = Path(f)
        paths += sorted(p.glob("*")) if p.is_dir() else [p]
    s = import_files(paths, settings.store_dir, settings.raw_dir, _symbols(args.symbols))
    print(f"Imported {len(s.ok)} file(s), {s.rows} option rows; {len(s.failed)} file(s) failed (see the log).")
    return 1 if s.failed else 0


def cmd_bhav_download(args, settings) -> int:
    from straddloop.reference.bhav_pipeline import NseBlocked, download_range

    try:
        s = download_range(date.fromisoformat(args.start), date.fromisoformat(args.end), settings.store_dir,
                           settings.raw_dir, symbols=_symbols(args.symbols), refetch=args.refetch)
    except NseBlocked as exc:
        log.error("%s", exc)
        return 2
    print(f"{len(s.ok)} downloaded ({s.rows} option rows), {len(s.skipped)} already stored, "
          f"{len(s.unavailable)} unavailable (holiday or not hosted), {len(s.failed)} failed.")
    return 1 if s.failed else 0


def cmd_availability(args, settings) -> int:
    from straddloop.data.availability import availability, index_key, option_key, summarize
    from straddloop.data.ledger import Ledger
    from straddloop.data.migrate import adopt_legacy

    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    ledger = Ledger(settings.store_dir)
    adopt_legacy(settings.store_dir, ledger)
    n = ledger.recover_interrupted()
    okey = option_key(args.underlying, args.expiry_flag, args.expiry_code, args.interval)
    states = availability(ledger, "option_candles", okey, start, end + timedelta(days=1), args.window)
    istates = availability(ledger, "underlying_candles", index_key(args.underlying, args.interval), start,
                           end + timedelta(days=1))
    print(f"{args.underlying} {args.expiry_flag}{args.expiry_code} {args.interval}m, {start} to {end}"
          + (f" ({n} interrupted download(s) reset to missing)" if n else ""))
    print("options:", summarize(states))
    print("index:  ", summarize(istates))
    for st in states:
        if st.state in ("missing", "failed", "partial", "downloading") or not st.confirmed:
            tag = st.state + ("" if st.confirmed else " (unconfirmed)")
            print(f"  {st.day} {tag} {st.reason}")
    ledger.close()
    return 0


def cmd_reconcile(args, settings) -> int:
    from straddloop.data.pull import weekdays
    from straddloop.data.reconcile import reconcile_day
    from straddloop.reference.contract_master import ContractMaster

    master = ContractMaster(settings.store_dir)
    worst = 0
    for d in weekdays(date.fromisoformat(args.start), date.fromisoformat(args.end) + timedelta(days=1)):
        r = reconcile_day(settings.store_dir, args.underlying, d, args.expiry_flag, args.expiry_code, master=master)
        if r.status == "NO_REFERENCE" and "no Dhan option candles" in r.note:
            continue
        print(f"{d} {r.status:12} expiry={r.expiry} compared={r.contracts_compared} dhan_only={r.dhan_only} "
              f"{r.checks} vol_ratio={r.volume_ratio_median} {r.note}")
        for m in r.mismatches[:5]:
            print("    ", m)
        worst = max(worst, {"PASS": 0, "NO_REFERENCE": 0, "WARN": 0, "FAIL": 1}[r.status])
    return worst


def cmd_dhan_preflight(args, settings) -> int:
    from straddloop.data.providers.base import AuthError, ProviderError
    from straddloop.data.providers.dhan import DhanProvider

    if not settings.has_dhan_credentials:
        log.error("DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN are not set")
        return 1
    try:
        info = DhanProvider(settings.dhan_client_id, settings.dhan_access_token, settings.raw_dir,
                            settings.dhan_requests_per_second).profile()
    except AuthError as exc:
        log.error("%s", exc)
        return 1
    except ProviderError as exc:
        log.error("Dhan profile check failed: %s", exc)
        return 1
    print(json.dumps({k: v for k, v in info.items() if k != "dhanClientId"}, indent=2))
    return 0


def cmd_store_check(args, settings) -> int:
    from straddloop.data import store

    bad = 0
    for ds in sorted(store.DATASETS):
        n, ex = store.duplicate_keys(settings.store_dir, ds)
        print(f"{ds}: {n} duplicated natural key(s)")
        for e in ex[:5]:
            print("   ", e)
        bad += n
    return 1 if bad else 0


def cmd_ingest_log(args, settings) -> int:
    from straddloop.data.ledger import Ledger

    ledger = Ledger(settings.store_dir)
    for r in reversed(ledger.log_rows(args.limit)):
        print(f"{r['at']} {r['dataset']:18} {r['key']:18} {r['trade_date'] or '-':10} {r['status']:11} "
              f"rows={r['rows_kept']} {r['source'] or ''} {r['detail'] or ''}")
    ledger.close()
    return 0


def cmd_coverage(args, settings) -> int:
    from straddloop.data.coverage import write_report

    _, m = write_report(settings.store_dir, settings.reports_dir)
    print(m.read_text(encoding="utf-8"))
    return 0


def cmd_serve(args, settings) -> int:
    import uvicorn

    uvicorn.run("straddloop.app.main:app", host=args.host, port=args.port, reload=False)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="straddloop")
    parser.add_argument("--log-level", default="INFO")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="show settings (secrets reported as set or missing only)")
    sub.add_parser("dhan-check-ids", help="confirm index security ids from Dhan's scrip master")

    for name, help_text in (
        ("dhan-sample", "pull index + expired options from Dhan (resumable), then write the quality report"),
        ("dhan-quality", "rebuild the quality report for a range from what is stored"),
    ):
        s = sub.add_parser(name, help=help_text)
        s.add_argument("--underlying", default="NIFTY", choices=["NIFTY", "BANKNIFTY", "SENSEX"])
        s.add_argument("--start", required=True, help="YYYY-MM-DD, inclusive")
        s.add_argument("--end", required=True, help="YYYY-MM-DD, exclusive")
        s.add_argument("--interval", type=int, default=1)
        s.add_argument("--window", type=int, default=10, help="strikes either side of ATM")
        s.add_argument("--expiry-flag", default="WEEK", choices=["WEEK", "MONTH"])
        s.add_argument("--expiry-code", type=int, default=1, help="1 = nearest (Dhan refuses 0)")
        if name == "dhan-sample":
            s.add_argument("--refetch", action="store_true", help="fetch days again even if already done")

    b = sub.add_parser("import-bhavcopy", help="import bhavcopy files (or a folder) downloaded by hand")
    b.add_argument("files", nargs="+")
    b.add_argument("--symbols", default="NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY",
                   help="comma list; use '' for every symbol (large)")
    d = sub.add_parser("bhav-download", help="download NSE F&O bhavcopies for a date range (resumable)")
    d.add_argument("--start", required=True, help="YYYY-MM-DD, inclusive")
    d.add_argument("--end", required=True, help="YYYY-MM-DD, inclusive")
    d.add_argument("--symbols", default="NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY")
    d.add_argument("--refetch", action="store_true")
    for name, help_text in (("availability", "show which days are local, missing, failed or validated"),
                            ("reconcile", "compare stored Dhan candles with the bhavcopy, day by day")):
        a = sub.add_parser(name, help=help_text)
        a.add_argument("--underlying", default="NIFTY", choices=["NIFTY", "BANKNIFTY", "SENSEX"])
        a.add_argument("--start", required=True, help="YYYY-MM-DD, inclusive")
        a.add_argument("--end", required=True, help="YYYY-MM-DD, inclusive")
        a.add_argument("--expiry-flag", default="WEEK", choices=["WEEK", "MONTH"])
        a.add_argument("--expiry-code", type=int, default=1)
        a.add_argument("--interval", type=int, default=1)
        a.add_argument("--window", type=int, default=None)
    sub.add_parser("dhan-preflight", help="check the Dhan token (expiry, data plan) before a long pull")
    sub.add_parser("store-check", help="look for duplicated records across the store")
    lg = sub.add_parser("ingest-log", help="show the latest ingestion log entries")
    lg.add_argument("--limit", type=int, default=40)

    sub.add_parser("coverage", help="rebuild the data coverage report from the store")

    v = sub.add_parser("serve", help="run the Straddloop web app")
    v.add_argument("--host", default="127.0.0.1")
    v.add_argument("--port", type=int, default=8600)

    from straddloop.data.upload_cli import register as register_upload

    upload_handlers = register_upload(sub)

    args = parser.parse_args(argv)
    setup_logging(args.log_level)
    settings = get_settings()
    handlers = {
        "status": cmd_status,
        "dhan-check-ids": cmd_dhan_check_ids,
        "dhan-sample": cmd_dhan_sample,
        "dhan-quality": cmd_dhan_quality,
        "import-bhavcopy": cmd_import_bhavcopy,
        "bhav-download": cmd_bhav_download,
        "availability": cmd_availability,
        "reconcile": cmd_reconcile,
        "dhan-preflight": cmd_dhan_preflight,
        "store-check": cmd_store_check,
        "ingest-log": cmd_ingest_log,
        "coverage": cmd_coverage,
        "serve": cmd_serve,
        **upload_handlers,
    }
    return handlers[args.command](args, settings)


if __name__ == "__main__":
    raise SystemExit(main())
