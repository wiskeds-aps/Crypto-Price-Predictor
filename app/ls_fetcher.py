"""
Fetches latest L/S ratios for all USDT perpetual futures from Binance.
Runs on a separate 5-minute schedule because it requires 1 request per symbol.
"""
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
from sqlalchemy.orm import Session

from .models import BinanceFuture

logger = logging.getLogger(__name__)

_BASE = "https://fapi.binance.com/futures/data"

_ENDPOINTS = [
    ("ls_account_ratio", f"{_BASE}/globalLongShortAccountRatio", "longShortRatio"),
    ("ls_taker_ratio",   f"{_BASE}/takerlongshortRatio",         "buySellRatio"),
    ("ls_top_account",   f"{_BASE}/topLongShortAccountRatio",    "longShortRatio"),
    ("ls_top_position",  f"{_BASE}/topLongShortPositionRatio",   "longShortRatio"),
]


def _fetch_symbol(symbol: str, client: httpx.Client) -> dict:
    result: dict = {"symbol": symbol}
    for field, url, key in _ENDPOINTS:
        try:
            resp = client.get(url, params={"symbol": symbol, "period": "5m", "limit": 1})
            resp.raise_for_status()
            data = resp.json()
            if data:
                result[field] = float(data[-1][key])
                if field == "ls_account_ratio":
                    result["ls_long_pct"]  = round(float(data[-1]["longAccount"])  * 100, 2)
                    result["ls_short_pct"] = round(float(data[-1]["shortAccount"]) * 100, 2)
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

    updated = 0
    limits = httpx.Limits(max_connections=40, max_keepalive_connections=20)
    with httpx.Client(timeout=10, limits=limits) as client:
        with ThreadPoolExecutor(max_workers=15) as pool:
            futs = {pool.submit(_fetch_symbol, sym, client): sym for sym in symbols}
            for fut in as_completed(futs):
                try:
                    res = fut.result()
                except Exception as e:
                    logger.warning("L/S fetch error %s: %s", futs[fut], e)
                    continue
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
    logger.info("Fetched L/S ratios for %d USDT symbols", updated)
    return updated
