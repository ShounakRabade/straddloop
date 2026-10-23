"""Logging setup: one format, IST timestamps, secrets masked."""

from __future__ import annotations

import logging
import re

from straddloop.timeutil import IST

_SECRET = re.compile(r"(access-token|DHAN_ACCESS_TOKEN|token)([\"'=:\s]+)([A-Za-z0-9._\-]{8,})", re.IGNORECASE)


class _MaskSecrets(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _SECRET.sub(r"\1\2***", str(record.msg))
        return True


class _ISTFormatter(logging.Formatter):
    def formatTime(self, record, datefmt=None):
        from datetime import datetime

        return datetime.fromtimestamp(record.created, IST).strftime("%Y-%m-%d %H:%M:%S IST")


def setup_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(_ISTFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    handler.addFilter(_MaskSecrets())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
