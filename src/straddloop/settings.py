"""Runtime settings, read from environment variables and an optional .env file.

Secrets (Dhan client id and token) are only ever read from the environment. They are never written
to logs, reports or the database; `Settings.describe()` reports whether they are set, not their values.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, '#' comments. Existing environment values win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class Settings:
    home: Path
    dhan_client_id: str
    dhan_access_token: str
    dhan_requests_per_second: float

    @property
    def raw_dir(self) -> Path:
        return self.home / "raw"

    @property
    def store_dir(self) -> Path:
        return self.home / "store"

    @property
    def reports_dir(self) -> Path:
        return self.home / "reports"

    @property
    def has_dhan_credentials(self) -> bool:
        return bool(self.dhan_client_id and self.dhan_access_token)

    def describe(self) -> dict:
        return {
            "home": str(self.home),
            "dhan_credentials": "set" if self.has_dhan_credentials else "missing",
            "dhan_requests_per_second": self.dhan_requests_per_second,
        }


def get_settings(env_file: Path | None = None) -> Settings:
    load_dotenv(env_file or Path.cwd() / ".env")
    return Settings(
        home=Path(os.environ.get("STRADDLOOP_HOME", "./data")).resolve(),
        dhan_client_id=os.environ.get("DHAN_CLIENT_ID", ""),
        dhan_access_token=os.environ.get("DHAN_ACCESS_TOKEN", ""),
        dhan_requests_per_second=float(os.environ.get("DHAN_REQUESTS_PER_SECOND", "4")),
    )
