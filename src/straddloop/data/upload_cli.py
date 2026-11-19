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
    reader = StoreReader(settings.store_dir)
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    days = [d for d in reader.option_dates() if start <= d <= end]
    if not days:
        log.warning("No option candles in %s between %s and %s", settings.store_dir, start, end)
    for d in days:
        yield d, build_day(args.underlying, args.expiry, d, reader.options(d, args.underlying, args.expiry),
                           reader.index(d, args.underlying))


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
    except SupabaseError as exc:
        log.error("%s", exc)
        return 1
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
    from datetime import timedelta

    from straddloop.data.providers.dhan import DhanProvider
    from straddloop.data.pull import pull_options, pull_underlying

    if not settings.has_dhan_credentials:
        log.error("DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN must be set in .env")
        return 1
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    provider = DhanProvider(settings.dhan_client_id, settings.dhan_access_token, settings.raw_dir,
                            settings.dhan_requests_per_second)
    end_excl = end + timedelta(days=1)  # `load` takes an inclusive end, like the website's date picker
    log.info("Step 1 of 2: pulling %s %s from Dhan, %s to %s (days already stored are skipped)",
             args.underlying, args.expiry, start, end)
    pull_underlying(provider, settings.store_dir, args.underlying, start, end_excl, 1)
    s = pull_options(provider, settings.store_dir, args.underlying, start, end_excl, args.window, args.expiry, 1, 1)
    log.info("Pulled: %d new days, %d already stored, %d with no data (holidays)",
             len(s.days_fetched), len(s.days_skipped), len(s.holidays))
    log.info("Step 2 of 2: uploading to Supabase")
    return cmd_supabase_upload(args, settings)


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
