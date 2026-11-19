"""Ingestion ledger: a small SQLite file that records what was fetched, when, from where, and whether
it passed validation. The Parquet store holds the data; the ledger holds the *state* of the data.

Tables
  day_status   one row per (dataset, key, trade_date): the current state of that day
  ingest_log   append-only history of every attempt (success or failure), with source and version
  bhav_files   one row per bhavcopy file (raw file path, checksum, format, parse state)

Day states (the only values `status` takes):
  downloading  a fetch started and has not finished. Left behind by a crash: treated as missing.
  validated    fetched and passed validation; safe for a backtest
  partial      fetched but with a stated problem (gaps, short session, too few series); usable with a flag
  failed       fetch or validation failed; reason in `detail`. Never used by a backtest.
  holiday      no session: the index feed AND the options feed are both empty (or an exchange file confirms)
A day with no row is "missing". Nothing in this module invents data or fills a gap.

Every write is one SQLite transaction, so a crash leaves the ledger either before or after a day, never
half-way. The data file is renamed into place *before* the ledger row says `validated`.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path

from straddloop.timeutil import IST

SCHEMA_VERSION = 1
STATES = ("downloading", "validated", "partial", "failed", "holiday")

_DDL = """
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS day_status (
  dataset TEXT NOT NULL, key TEXT NOT NULL, trade_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('downloading','validated','partial','failed','holiday')),
  rows INTEGER NOT NULL DEFAULT 0, window INTEGER, source TEXT, detail TEXT,
  data_version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
  PRIMARY KEY (dataset, key, trade_date)
);
CREATE TABLE IF NOT EXISTS ingest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, dataset TEXT NOT NULL, key TEXT NOT NULL,
  trade_date TEXT, source TEXT, status TEXT NOT NULL, rows_in INTEGER, rows_kept INTEGER,
  dropped TEXT, detail TEXT, schema_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bhav_files (
  trade_date TEXT NOT NULL, segment TEXT NOT NULL, fmt TEXT, status TEXT NOT NULL,
  raw_path TEXT, sha256 TEXT, bytes INTEGER, rows INTEGER, detail TEXT, origin TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (trade_date, segment)
);
"""


def _now() -> str:
    return datetime.now(IST).isoformat(timespec="seconds")


class Ledger:
    def __init__(self, store_dir: Path):
        store_dir.mkdir(parents=True, exist_ok=True)
        self.path = store_dir / "ledger.sqlite"
        self.con = sqlite3.connect(self.path, timeout=30)
        self.con.row_factory = sqlite3.Row
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.executescript(_DDL)
        self.con.execute("INSERT OR IGNORE INTO meta VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
        self.con.commit()

    def close(self) -> None:
        self.con.close()

    @contextmanager
    def tx(self):
        try:
            self.con.execute("BEGIN IMMEDIATE")
            yield self.con
            self.con.commit()
        except BaseException:
            self.con.rollback()
            raise

    # ---- day status ------------------------------------------------------------------------

    def set_day(self, dataset: str, key: str, day: date, status: str, *, rows: int = 0, window: int | None = None,
                source: str | None = None, detail: dict | str | None = None, dropped: dict | None = None,
                rows_in: int | None = None, log: bool = True) -> None:
        if status not in STATES:
            raise ValueError(f"unknown day status {status!r}")
        text = detail if isinstance(detail, str) or detail is None else json.dumps(detail, sort_keys=True)
        with self.tx() as c:
            c.execute(
                "INSERT INTO day_status (dataset,key,trade_date,status,rows,window,source,detail,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset,key,trade_date) DO UPDATE SET "
                "status=excluded.status, rows=excluded.rows, window=excluded.window, source=excluded.source, "
                "detail=excluded.detail, updated_at=excluded.updated_at, "
                "data_version=day_status.data_version + (excluded.status IN ('validated','partial'))",
                (dataset, key, day.isoformat(), status, rows, window, source, text, _now()),
            )
            if log and status != "downloading":
                c.execute(
                    "INSERT INTO ingest_log (at,dataset,key,trade_date,source,status,rows_in,rows_kept,dropped,"
                    "detail,schema_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (_now(), dataset, key, day.isoformat(), source, status, rows_in, rows,
                     json.dumps(dropped or {}, sort_keys=True), text, SCHEMA_VERSION),
                )

    def get_day(self, dataset: str, key: str, day: date) -> dict | None:
        r = self.con.execute("SELECT * FROM day_status WHERE dataset=? AND key=? AND trade_date=?",
                             (dataset, key, day.isoformat())).fetchone()
        return dict(r) if r else None

    def days(self, dataset: str, key: str, start: date, end: date) -> dict[date, dict]:
        """Rows for [start, end) keyed by date."""
        rs = self.con.execute(
            "SELECT * FROM day_status WHERE dataset=? AND key=? AND trade_date>=? AND trade_date<? ",
            (dataset, key, start.isoformat(), end.isoformat())).fetchall()
        return {date.fromisoformat(r["trade_date"]): dict(r) for r in rs}

    def log_rows(self, limit: int = 50) -> list[dict]:
        return [dict(r) for r in self.con.execute("SELECT * FROM ingest_log ORDER BY id DESC LIMIT ?", (limit,))]

    def log_event(self, dataset: str, key: str, day: date | None, status: str, source: str | None = None,
                  detail: str | None = None, rows: int = 0) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT INTO ingest_log (at,dataset,key,trade_date,source,status,rows_kept,detail,schema_version) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (_now(), dataset, key, day.isoformat() if day else None, source, status, rows, detail,
                 SCHEMA_VERSION))

    def recover_interrupted(self) -> int:
        """Rows still `downloading` belong to a run that died. They stay missing: delete them."""
        with self.tx() as c:
            return c.execute("DELETE FROM day_status WHERE status='downloading'").rowcount

    # ---- bhavcopy files --------------------------------------------------------------------

    def set_bhav(self, day: date, segment: str, status: str, **kw) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT INTO bhav_files (trade_date,segment,fmt,status,raw_path,sha256,bytes,rows,detail,origin,"
                "updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(trade_date,segment) DO UPDATE SET "
                "fmt=excluded.fmt, status=excluded.status, raw_path=excluded.raw_path, sha256=excluded.sha256, "
                "bytes=excluded.bytes, rows=excluded.rows, detail=excluded.detail, origin=excluded.origin, "
                "updated_at=excluded.updated_at",
                (day.isoformat(), segment, kw.get("fmt"), status, kw.get("raw_path"), kw.get("sha256"),
                 kw.get("bytes"), kw.get("rows"), kw.get("detail"), kw.get("origin"), _now()))
            c.execute(
                "INSERT INTO ingest_log (at,dataset,key,trade_date,source,status,rows_kept,detail,schema_version) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (_now(), "bhavcopy", segment, day.isoformat(), kw.get("origin"), status, kw.get("rows") or 0,
                 kw.get("detail"), SCHEMA_VERSION))

    def get_bhav(self, day: date, segment: str = "FO") -> dict | None:
        r = self.con.execute("SELECT * FROM bhav_files WHERE trade_date=? AND segment=?",
                             (day.isoformat(), segment)).fetchone()
        return dict(r) if r else None

    def bhav_days(self, segment: str, status: str) -> set[date]:
        return {date.fromisoformat(r["trade_date"]) for r in self.con.execute(
            "SELECT trade_date FROM bhav_files WHERE segment=? AND status=?", (segment, status))}
