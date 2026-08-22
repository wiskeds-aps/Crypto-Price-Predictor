"""
Fetches latest L/S ratios for all USDT perpetual futures from Binance.
Runs on a separate 5-minute schedule because it requires 1 request per symbol.

The global account ratio request also doubles as history accumulation:
period=5m limit=289 (24h of 5-min bars) instead of limit=1, mirroring
oi_fetcher.py's approach so /api/futures/{symbol}/ls-ratio can serve more
than a single live Binance call's worth of history.
"""
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
from sqlalchemy.orm import Session

from .ls_history import latest_ls_times, parse_ls_points, upsert_ls_history, cleanup_ls_history
from .models import BinanceFuture

logger = logging.getLogger(__name__)

_BASE = "https://fapi.binance.com/futures/data"
_LS_HISTORY_RETENTION_DAYS = int(os.environ.get("CRYPTOSKRINER_LS_RETENTION_DAYS", "370"))

_ENDPOINTS = [
    ("ls_taker_ratio",   f"{_BASE}/takerlongshortRatio",         "buySellRatio"),
    ("ls_top_account",   f"{_BASE}/topLongShortAccountRatio",    "longShortRatio"),
    ("ls_top_position",  f"{_BASE}/topLongShortPositionRatio",   "longShortRatio"),
]


def _fetch_symbol(symbol: str, client: httpx.Client, latest_ls_ts: int | None = None) -> dict:
    result: dict = {"symbol": symbol}

    # Global account ratio: period=5m limit=289 covers both the live snapshot
    # columns below and 24h of history in one request.
    try:
        r = client.get(f"{_BASE}/globalLongShortAccountRatio", params={"symbol": symbol, "period": "5m", "limit": 289})
        r.raise_for_status()
        data = r.json()
        if data:
            points = parse_ls_points(symbol, "5m", data)
            if latest_ls_ts is not None:
                points = [p for p in points if p["time_bucket"] > latest_ls_ts]
            result["_ls_history"] = points

            last = data[-1]
            result["ls_account_ratio"] = float(last["longShortRatio"])
            result["ls_long_pct"]      = round(float(last["longAccount"]) * 100, 2)
            result["ls_short_pct"]     = round(float(last["shortAccount"]) * 100, 2)
    except Exception:
        pass

    for field, url, key in _ENDPOINTS:
        try:
            resp = client.get(url, params={"symbol": symbol, "period": "5m", "limit": 1})
            resp.raise_for_status()
            data = resp.json()
            if data:
                result[field] = float(data[-1][key])
                if field == "ls_top_account":
                    result["ls_ta_long_pct"]   = round(float(data[-1]["longAccount"])  * 100, 2)
                    result["ls_ta_short_pct"]  = round(float(data[-1]["shortAccount"]) * 100, 2)
                if field == "ls_top_position":
                    result["ls_top_long_pct"]  = round(float(data[-1]["longAccount"])  * 100, 2)
                    result["ls_top_short_pct"] = round(float(data[-1]["shortAccount"]) * 100, 2)
            else:
                result[field] = None
        except Exception:
            result[field] = None
    return result


def fetch_ls_ratios(db: Session) -> int:
    symbols = [
        r.symbol for r in db.query(BinanceFuture.symbol)
        .filter(BinanceFuture.quote_asset == "USDT").all()
    ]
    latest_by_symbol = latest_ls_times(db, "5m", symbols)

    updated = 0
    history_rows = []
    limits = httpx.Limits(max_connections=40, max_keepalive_connections=20)
    with httpx.Client(timeout=10, limits=limits) as client:
        with ThreadPoolExecutor(max_workers=15) as pool:
            futs = {
                pool.submit(_fetch_symbol, sym, client, latest_by_symbol.get(sym)): sym
                for sym in symbols
            }
            for fut in as_completed(futs):
                try:
                    res = fut.result()
                except Exception as e:
                    logger.warning("L/S fetch error %s: %s", futs[fut], e)
                    continue
                history_rows.extend(res.get("_ls_history") or [])
                row = db.get(BinanceFuture, res["symbol"])
                if row:
                    row.ls_account_ratio = res.get("ls_account_ratio")
                    row.ls_long_pct      = res.get("ls_long_pct")
                    row.ls_short_pct     = res.get("ls_short_pct")
                    row.ls_taker_ratio   = res.get("ls_taker_ratio")
                    row.ls_top_account   = res.get("ls_top_account")
                    row.ls_ta_long_pct   = res.get("ls_ta_long_pct")
                    row.ls_ta_short_pct  = res.get("ls_ta_short_pct")
                    row.ls_top_position  = res.get("ls_top_position")
                    row.ls_top_long_pct  = res.get("ls_top_long_pct")
                    row.ls_top_short_pct = res.get("ls_top_short_pct")
                    updated += 1

    db.commit()
    history_written = upsert_ls_history(db, history_rows, commit_every_chunk=True)
    deleted = cleanup_ls_history(db, _LS_HISTORY_RETENTION_DAYS)
    db.commit()
    logger.info(
        "Fetched L/S ratios for %d USDT symbols, L/S history +%d, deleted %d old rows",
        updated,
        history_written,
        deleted,
    )
    return updated
