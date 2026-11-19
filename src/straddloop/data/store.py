"""Parquet store, queried through DuckDB.

Layout: <store>/<dataset>/source=<s>/underlying=<u>/[series=<WEEK1>/]date=<YYYY-MM-DD>/
        part.parquet
Option candles carry a `series` level (expiry flag + code) so weekly and monthly pulls of the same day
never overwrite each other. Each write replaces one partition, so re-pulling a day is idempotent; a
caller must therefore write everything for a partition in one call (all strikes, both option types).
`dataset_hash` fingerprints a dataset so every backtest can record exactly which data it used.
"""

from __future__ import annotations

import hashlib
import os
from collections import defaultdict
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from straddloop.data.schema import to_table

DATASETS = {"underlying_candles", "option_candles", "contracts"}


def _partition(root: Path, dataset: str, source: str, underlying: str, day, series: str | None = None) -> Path:
    base = root / dataset / f"source={source}" / f"underlying={underlying}"
    if series:
        base = base / f"series={series}"
    return base / f"date={day.isoformat()}"


def _series(record) -> str | None:
    flag = getattr(record, "expiry_flag", None)
    code = getattr(record, "expiry_code", None)
    return f"{flag}{code}" if flag is not None and code is not None else None


def write_records(root: Path, dataset: str, records: list, record_type: type) -> list[Path]:
    if dataset not in DATASETS:
        raise ValueError(f"unknown dataset {dataset}")
    groups: dict[tuple, list] = defaultdict(list)
    for r in records:
        day = r.trade_date if hasattr(r, "trade_date") else r.ts.date()
        underlying = getattr(r, "underlying", None) or r.symbol
        groups[(r.source, underlying, _series(r) or "", day)].append(r)
    written = []
    for (source, underlying, series, day), rows in sorted(groups.items()):
        part = _partition(root, dataset, source, underlying, day, series or None)
        part.mkdir(parents=True, exist_ok=True)
        path = part / "part.parquet"
        # Write beside the target and rename: a crash mid-write leaves the old file intact, never a torn one.
        tmp = part / f".part.parquet.{os.getpid()}.tmp"
        try:
            pq.write_table(to_table(rows, record_type), tmp)
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
        written.append(path)
    return written


def dataset_files(root: Path, dataset: str) -> list[Path]:
    return sorted((root / dataset).glob("**/*.parquet"))


def dataset_hash(root: Path, dataset: str) -> str:
    h = hashlib.sha256()
    for path in dataset_files(root, dataset):
        h.update(str(path.relative_to(root)).encode())
        h.update(hashlib.sha256(path.read_bytes()).digest())
    return h.hexdigest()[:16]


def query(root: Path, dataset: str, sql_where: str = "TRUE", params: list | None = None):
    """Return an Arrow table of a dataset filtered by a SQL WHERE clause."""
    files = dataset_files(root, dataset)
    if not files:
        return None
    con = duckdb.connect()
    con.execute("SET TimeZone = 'Asia/Kolkata'")  # timestamps come back in IST, as stored
    paths = [str(p) for p in files]
    rel = con.execute(
        # Partition values are also stored as columns, so the folder names are not re-read as columns.
        f"SELECT * FROM read_parquet(?, hive_partitioning = false) WHERE {sql_where}",
        [paths, *(params or [])],
    )
    fetch = getattr(rel, "to_arrow_table", None) or rel.fetch_arrow_table  # name differs by DuckDB version
    return fetch()


NATURAL_KEYS = {
    "underlying_candles": ("underlying", "interval_min", "ts"),
    "option_candles": ("underlying", "expiry_flag", "expiry_code", "interval_min", "option_type", "moneyness", "ts"),
    "contracts": ("trade_date", "exchange", "symbol", "instrument", "expiry", "strike", "option_type"),
}


def duplicate_keys(root: Path, dataset: str, limit: int = 20) -> tuple[int, list[tuple]]:
    """Count natural keys that appear more than once across ALL files of a dataset (e.g. one day written
    under two partition layouts). Returns (number of duplicated keys, first `limit` examples)."""
    files = dataset_files(root, dataset)
    if not files:
        return 0, []
    cols = ", ".join(NATURAL_KEYS[dataset])
    shown = ", ".join(f"CAST({c} AS VARCHAR)" for c in NATURAL_KEYS[dataset])  # text: no tz library needed
    con = duckdb.connect()
    paths = [str(p) for p in files]
    q = (f"SELECT {cols}, count(*) n FROM read_parquet(?, hive_partitioning = false) "
         f"GROUP BY {cols} HAVING count(*) > 1")
    total = con.execute(f"SELECT count(*) FROM ({q})", [paths]).fetchone()[0]
    examples = con.execute(f"SELECT {shown}, n FROM ({q}) LIMIT {int(limit)}", [paths]).fetchall()
    return total, examples
