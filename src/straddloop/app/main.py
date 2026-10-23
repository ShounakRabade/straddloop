"""Straddloop web app (Phase 1 shell).

Only sections backed by real code show content. Every other section says plainly that it is not
built yet and which phase delivers it; nothing shows mock numbers.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from straddloop import __version__
from straddloop.data import store
from straddloop.data.providers.dhan import CAPABILITIES as DHAN_CAPS
from straddloop.reference.costs import SCHEDULES
from straddloop.settings import get_settings

HERE = Path(__file__).parent

SECTIONS = [
    # slug, title, status, phase, purpose
    ("overview", "Overview", "partial", 1, "System status, latest research runs and portfolio summary."),
    ("strategy-lab", "Strategy Lab", "planned", 7, "Create, configure and version strategies."),
    ("backtests", "Backtests", "planned", 3, "Run and inspect historical simulations."),
    ("compare", "Compare Strategies", "planned", 7, "Compare results across strategies, indices and periods."),
    ("market-data", "Market Data", "partial", 2, "Data coverage, contracts, quality and provider status."),
    ("paper-trading", "Paper Trading", "planned", 9, "Simulated live signals, positions and P&L."),
    ("trade-explorer", "Trade Explorer", "planned", 3, "Inspect individual trades and their reasoning."),
    ("experiments", "Experiments", "planned", 8, "Parameter runs, robustness checks and saved research."),
    ("risk", "Risk", "planned", 8, "Drawdowns, exposure, capital utilisation and safeguards."),
    ("settings", "Settings", "partial", 1, "Data providers, costs, calendars and configuration."),
]
SECTION_BY_SLUG = {s[0]: s for s in SECTIONS}

app = FastAPI(title="Straddloop", version=__version__)
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
templates = Jinja2Templates(directory=HERE / "templates")


def _ctx(request: Request, slug: str, **extra) -> dict:
    return {"request": request, "sections": SECTIONS, "active": slug, "version": __version__,
            "section": SECTION_BY_SLUG[slug], **extra}


def _latest_coverage(reports_dir: Path) -> dict | None:
    files = sorted(reports_dir.glob("coverage-*.json"))
    return json.loads(files[-1].read_text(encoding="utf-8")) if files else None


@app.get("/", response_class=HTMLResponse)
@app.get("/overview", response_class=HTMLResponse)
def overview(request: Request):
    settings = get_settings()
    datasets = {d: len(store.dataset_files(settings.store_dir, d)) for d in sorted(store.DATASETS)}
    return templates.TemplateResponse(
        request, "overview.html",
        _ctx(request, "overview", settings=settings.describe(), datasets=datasets,
             coverage=_latest_coverage(settings.reports_dir)),
    )


@app.get("/market-data", response_class=HTMLResponse)
def market_data(request: Request):
    settings = get_settings()
    return templates.TemplateResponse(
        request, "market_data.html",
        _ctx(request, "market-data", coverage=_latest_coverage(settings.reports_dir),
             providers=[asdict(DHAN_CAPS)]),
    )


@app.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request):
    schedules = [(exch, [asdict(s) for s in items]) for exch, items in SCHEDULES.items()]
    return templates.TemplateResponse(
        request, "settings.html",
        _ctx(request, "settings", settings=get_settings().describe(), schedules=schedules),
    )


@app.get("/{slug}", response_class=HTMLResponse)
def planned(request: Request, slug: str):
    if slug not in SECTION_BY_SLUG:
        raise HTTPException(status_code=404)
    return templates.TemplateResponse(request, "planned.html", _ctx(request, slug))
