"""Upload day files to Supabase: Storage bucket `market-data` plus one `market_days` row per file.

Needs SUPABASE_URL and SUPABASE_SECRET_KEY in the local .env. The secret key bypasses row-level
security, so it lives only on this computer: never in Vercel, the website or Git. It is never
logged or printed; error messages are scrubbed of it.

Resumable: a day whose content checksum already matches the `market_days` row is skipped.
"""

from __future__ import annotations

import logging
import time
from datetime import date

import httpx

from straddloop.data.dayfiles import DayFile

log = logging.getLogger(__name__)

BUCKET = "market-data"


class SupabaseError(RuntimeError):
    pass


class SupabaseSync:
    def __init__(self, url: str, secret_key: str, client: httpx.Client | None = None):
        if not url or not secret_key:
            raise SupabaseError("SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env (see .env.example)")
        url = url.strip().rstrip("/")
        if not url.startswith("http"):
            url = "https://" + url
        self.url = url
        self._key = secret_key.strip()
        # New-style keys (sb_secret_...) go only in `apikey`; legacy JWT keys also go in Authorization.
        headers = {"apikey": self._key}
        if self._key.startswith("eyJ"):
            headers["Authorization"] = f"Bearer {self._key}"
        self.http = client or httpx.Client(timeout=60)
        self.headers = headers

    def _scrub(self, text: str) -> str:
        return text.replace(self._key, "***")

    def _call(self, method: str, path: str, **kw) -> httpx.Response:
        headers = {**self.headers, **kw.pop("headers", {})}
        for attempt in range(4):
            try:
                resp = self.http.request(method, self.url + path, headers=headers, **kw)
            except httpx.HTTPError as exc:
                if attempt == 3:
                    raise SupabaseError(self._scrub(f"{method} {path}: {exc}")) from None
                time.sleep(2 ** attempt)
                continue
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            if resp.status_code >= 400:
                raise SupabaseError(self._scrub(f"{method} {path}: HTTP {resp.status_code} {resp.text[:300]}"))
            return resp
        raise AssertionError("unreachable")

    def existing(self, underlying: str, expiry_flag: str, start: date, end: date) -> dict[str, str]:
        """trade_date -> sha256 for rows already uploaded in [start, end]."""
        out: dict[str, str] = {}
        offset = 0
        while True:
            resp = self._call(
                "GET", "/rest/v1/market_days",
                params=[("select", "trade_date,sha256"), ("underlying", f"eq.{underlying}"),
                        ("expiry_flag", f"eq.{expiry_flag}"), ("trade_date", f"gte.{start.isoformat()}"),
                        ("trade_date", f"lte.{end.isoformat()}"), ("order", "trade_date"),
                        ("offset", str(offset)), ("limit", "1000")],
            )
            rows = resp.json()
            out.update({r["trade_date"]: r["sha256"] for r in rows})
            if len(rows) < 1000:
                return out
            offset += 1000

    def upload(self, day: DayFile) -> None:
        self._call(
            "POST", f"/storage/v1/object/{BUCKET}/{day.path}", content=day.blob,
            headers={"Content-Type": "application/gzip", "x-upsert": "true", "Cache-Control": "max-age=86400"},
        )
        self._call(
            "POST", "/rest/v1/market_days", json=[day.row()],
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )
