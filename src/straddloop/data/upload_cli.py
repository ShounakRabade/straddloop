"""CLI commands that publish the local store as day files.

    straddloop supabase-upload --underlying NIFTY --expiry WEEK --start 2025-10-06 --end 2025-10-17
    straddloop export-days     --underlying NIFTY --expiry WEEK --start 2025-10-06 --end 2025-10-17

`export-days` writes the same files to data/dayfiles/ so the website can load them from this
computer when Supabase is not set up or not reachable.
"""

from __future__ import annotations

import logging
import os
from datetime import date

from straddloop.data.dayfiles import StoreReader, build_day

log = logging.getLogger("straddloop")


def _days(args, settings):
    """Day files for stored days. Days the ledger records as failed, holiday or in-flight are never
    published; partial days are (their quality is stated in the file and the index row)."""
    from datetime import timedelta

    from straddloop.data.availability import option_key
    from straddloop.data.ledger import Ledger
    from straddloop.data.migrate import adopt_legacy
    from straddloop.reference.contract_master import ContractMaster

    reader = StoreReader(settings.store_dir)
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    ledger = Ledger(settings.store_dir)
    adopt_legacy(settings.store_dir, ledger)
    rows = ledger.days("option_candles", option_key(args.underlying, args.expiry, 1, 1), start,
                       end + timedelta(days=1))
    ledger.close()
    days = [d for d in reader.option_dates() if start <= d <= end
            and rows.get(d, {"status": "partial"})["status"] in ("validated", "partial")]
    if not days:
        log.warning("No usable option candles in %s between %s and %s", settings.store_dir, start, end)
    master = ContractMaster(settings.store_dir)
    for d in days:
        yield d, build_day(args.underlying, args.expiry, d, reader.options(d, args.underlying, args.expiry),
                           reader.index(d, args.underlying), master)


def ledger_status_rows(settings, underlying: str, expiry: str, start: date, end: date) -> list[dict]:
    """Ledger states for the range as market_day_status rows. Only days the ledger knows are sent; a day
    that was never attempted has no row, which the website shows as 'not stored'."""
    import json
    from datetime import timedelta

    from straddloop.data.availability import option_key
    from straddloop.data.ledger import Ledger
    from straddloop.data.migrate import adopt_legacy

    ledger = Ledger(settings.store_dir)
    try:
        adopt_legacy(settings.store_dir, ledger)
        found = ledger.days("option_candles", option_key(underlying, expiry, 1, 1), start, end + timedelta(days=1))
    finally:
        ledger.close()
    out = []
    for d, r in sorted(found.items()):
        try:
            reasons = json.loads(r["detail"] or "{}").get("reasons", [])
        except (ValueError, AttributeError):
            reasons = []
        out.append({"underlying": underlying, "expiry_flag": expiry, "trade_date": d.isoformat(),
                    "status": r["status"], "reason": "; ".join(reasons)[:500] or None, "rows_kept": r["rows"],
                    "source": r["source"], "data_version": r["data_version"]})
    return out


def _push_statuses(sync, args, settings) -> int:
    rows = ledger_status_rows(settings, args.underlying, args.expiry, date.fromisoformat(args.start),
                              date.fromisoformat(args.end))
    if rows:
        try:
            sync.push_statuses(rows)
        except Exception as exc:  # the table may not exist yet: day files are already up, say so, don't fail
            log.warning("Day files uploaded, but statuses were not published (run web/supabase/market_data.sql "
                        "again to create market_day_status): %s", exc)
            return 0
    return len(rows)


def cmd_supabase_upload(args, settings) -> int:
    from straddloop.data.supabase_sync import SupabaseError, SupabaseSync

    try:
        sync = SupabaseSync(os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SECRET_KEY", ""))
        done = {} if args.force else sync.existing(
            args.underlying, args.expiry, date.fromisoformat(args.start), date.fromisoformat(args.end))
        uploaded = skipped = empty = 0
        total_bytes = 0
        for d, day in _days(args, settings):
            if day is None:
                empty += 1
                log.info("%s: no %s %s series in the store, skipped", d, args.underlying, args.expiry)
                continue
            if done.get(d.isoformat()) == day.sha256:
                skipped += 1
                continue
            sync.upload(day)
            uploaded += 1
            total_bytes += len(day.blob)
            log.info("%s: uploaded %d series, %d option bars, %d index bars, %s, %.0f KB",
                     d, day.series, day.option_bars, day.index_bars, day.quality, len(day.blob) / 1024)
        pushed = _push_statuses(sync, args, settings)
    except SupabaseError as exc:
        log.error("%s", exc)
        return 1
    print(f"Published {pushed} day status row(s). ", end="")
    print(f"Uploaded {uploaded} day(s) ({total_bytes / 1e6:.1f} MB), {skipped} already up to date, "
          f"{empty} with no data.")
    return 0


def cmd_export_days(args, settings) -> int:
    out = settings.home / "dayfiles"
    n = 0
    for _d, day in _days(args, settings):
        if day is None:
            continue
        path = out / day.path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(day.blob)
        n += 1
    print(f"Wrote {n} day file(s) under {out}. In the website Lab pick Real NIFTY (Dhan), "
          "then 'Load day files from this computer'.")
    return 0


def cmd_load(args, settings) -> int:
    """One command: pull the days from Dhan (resumable), then upload them for the website."""
    from straddloop.data.providers.base import AuthError
    from straddloop.data.providers.dhan import DhanProvider
    from straddloop.data.pull import RunAborted, ensure_range, failed_days_report

    if not settings.has_dhan_credentials:
        log.error("DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN must be set in .env")
        return 1
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    provider = DhanProvider(settings.dhan_client_id, settings.dhan_access_token, settings.raw_dir,
                            settings.dhan_requests_per_second)
    log.info("Step 1 of 2: filling %s %s, %s to %s, from Dhan (only days not already stored)",
             args.underlying, args.expiry, start, end)
    try:
        s = ensure_range(provider, settings.store_dir, args.underlying, start, end, args.window, args.expiry, 1, 1)
    except (AuthError, RunAborted) as exc:
        log.error("%s", exc)
        return 1
    log.info("Pulled: %d new days (%d partial), %d already stored, %d no-session days, %d failed",
             len(s.days_fetched), len(s.days_partial), len(s.days_skipped), len(s.holidays), len(s.days_failed))
    if s.days_failed:
        print(failed_days_report(s), end="")
    log.info("Step 2 of 2: uploading to Supabase")
    rc = cmd_supabase_upload(args, settings)
    return rc or (1 if s.days_failed else 0)


def register(sub) -> dict:
    for name, helptext in (("supabase-upload", "upload day files to Supabase for the website"),
                           ("export-days", "write day files locally for the website's offline mode")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("--underlying", default="NIFTY", choices=["NIFTY", "BANKNIFTY", "SENSEX"])
        p.add_argument("--expiry", default="WEEK", choices=["WEEK", "MONTH"])
        p.add_argument("--start", required=True, help="YYYY-MM-DD, inclusive")
        p.add_argument("--end", required=True, help="YYYY-MM-DD, inclusive")
        if name == "supabase-upload":
            p.add_argument("--force", action="store_true", help="re-upload days that are already up to date")
    p = sub.add_parser("load", help="pull days from Dhan and upload them for the website, in one command")
    p.add_argument("--underlying", default="NIFTY", choices=["NIFTY", "BANKNIFTY", "SENSEX"])
    p.add_argument("--expiry", default="WEEK", choices=["WEEK", "MONTH"])
    p.add_argument("--start", required=True, help="YYYY-MM-DD, inclusive")
    p.add_argument("--end", required=True, help="YYYY-MM-DD, inclusive")
    p.add_argument("--window", type=int, default=10, help="strikes either side of ATM")
    p.add_argument("--force", action="store_true", help="re-upload days that are already up to date")
    return {"supabase-upload": cmd_supabase_upload, "export-days": cmd_export_days, "load": cmd_load}
