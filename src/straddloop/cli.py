"""Command line entry point: `straddloop <command>`."""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
from datetime import date
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
    wanted = {"NIFTY", "BANKNIFTY", "SENSEX", "NIFTY 50", "NIFTY BANK"}
    for row in csv.DictReader(io.StringIO(text)):
        values = {v.strip().upper() for v in row.values() if v}
        if "INDEX" in values and values & wanted:
            print(row)
    return 0


def cmd_dhan_sample(args, settings) -> int:
    from straddloop.data import store
    from straddloop.data.coverage import write_report
    from straddloop.data.providers.base import ExpiredOptionRequest
    from straddloop.data.providers.dhan import DhanProvider, moneyness_labels
    from straddloop.data.schema import OptionCandle, UnderlyingCandle
    from straddloop.data.validate import validate_candles

    provider = DhanProvider(
        settings.dhan_client_id, settings.dhan_access_token, settings.raw_dir, settings.dhan_requests_per_second
    )
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    log.info("Pulling %s index candles %s to %s", args.underlying, start, end)
    under = validate_candles(provider.underlying_candles(args.underlying, start, end, args.interval))
    store.write_records(settings.store_dir, "underlying_candles", under.kept, UnderlyingCandle)
    log.info("Underlying: kept %d rows, dropped %s", len(under.kept), dict(under.dropped))

    for option_type in ("CE", "PE"):
        for label in moneyness_labels(args.window):
            req = ExpiredOptionRequest(
                underlying=args.underlying,
                option_type=option_type,
                moneyness=label,
                expiry_flag=args.expiry_flag,
                expiry_code=args.expiry_code,
                start=start,
                end=end,
                interval_min=args.interval,
            )
            res = validate_candles(provider.expired_option_candles(req))
            store.write_records(settings.store_dir, "option_candles", res.kept, OptionCandle)
            log.info("%s %s: kept %d rows, dropped %s", option_type, label, len(res.kept), dict(res.dropped))

    j, m = write_report(settings.store_dir, settings.reports_dir)
    print(f"Coverage report written to {m} and {j}")
    return 0


def cmd_import_bhavcopy(args, settings) -> int:
    from straddloop.data import store
    from straddloop.data.schema import ContractRow
    from straddloop.reference.bhavcopy import parse_nse_udiff

    symbols = set(args.symbols.split(",")) if args.symbols else None
    total = 0
    for path in args.files:
        rows = parse_nse_udiff(Path(path), symbols)
        store.write_records(settings.store_dir, "contracts", rows, ContractRow)
        total += len(rows)
        log.info("%s: %d option contracts", path, len(rows))
    print(f"Imported {total} contract rows")
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

    s = sub.add_parser("dhan-sample", help="pull a Phase 2 sample from Dhan and write a coverage report")
    s.add_argument("--underlying", default="NIFTY", choices=["NIFTY", "BANKNIFTY", "SENSEX"])
    s.add_argument("--start", required=True, help="YYYY-MM-DD, inclusive")
    s.add_argument("--end", required=True, help="YYYY-MM-DD, exclusive")
    s.add_argument("--interval", type=int, default=1)
    s.add_argument("--window", type=int, default=10, help="strikes either side of ATM")
    s.add_argument("--expiry-flag", default="WEEK", choices=["WEEK", "MONTH"])
    s.add_argument("--expiry-code", type=int, default=1)

    b = sub.add_parser("import-bhavcopy", help="import NSE UDiFF F&O bhavcopy files into the contract master")
    b.add_argument("files", nargs="+")
    b.add_argument("--symbols", default="NIFTY,BANKNIFTY,RELIANCE,HDFCBANK,ICICIBANK,SBIN")

    sub.add_parser("coverage", help="rebuild the data coverage report from the store")

    v = sub.add_parser("serve", help="run the Straddloop web app")
    v.add_argument("--host", default="127.0.0.1")
    v.add_argument("--port", type=int, default=8600)

    args = parser.parse_args(argv)
    setup_logging(args.log_level)
    settings = get_settings()
    handlers = {
        "status": cmd_status,
        "dhan-check-ids": cmd_dhan_check_ids,
        "dhan-sample": cmd_dhan_sample,
        "import-bhavcopy": cmd_import_bhavcopy,
        "coverage": cmd_coverage,
        "serve": cmd_serve,
    }
    return handlers[args.command](args, settings)


if __name__ == "__main__":
    raise SystemExit(main())
