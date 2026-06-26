"""
Fetches OI value and 1h/24h change for all USDT perpetuals.
One request per symbol (openInterestHist period=1h limit=25).
Runs on same 10-minute schedule as ls_fetcher.
"""
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
from sqlalchemy.orm import Session

from .models import BinanceFuture

logger = logging.getLogger(__name__)

_URL = "https://fapi.binance.com/futures/data/openInterestHist"


def _fetch_symbol(symbol: str, client: httpx.Client) -> dict:
    try:
        resp = client.get(_URL, params={"symbol": symbol, "period": "1h", "limit": 25})
        resp.raise_for_status()
        data = resp.json()
        if not data:
            return {"symbol": symbol}
        current = float(data[-1]["sumOpenInterestValue"])
        change_1h  = (current / float(data[-2]["sumOpenInterestValue"]) - 1) * 100 if len(data) >= 2 else None
        change_24h = (current / float(data[0]["sumOpenInterestValue"])  - 1) * 100 if len(data) >= 25 else None
        return {"symbol": symbol, "oi_value": current, "oi_change_1h": change_1h, "oi_change_24h": change_24h}
    except Exception as e:
        logger.debug("OI fetch error %s: %s", symbol, e)
        return {"symbol": symbol}


def fetch_oi(db: Session) -> int:
    symbols = [
        r.symbol for r in db.query(BinanceFuture.symbol)
        .filter(BinanceFuture.quote_asset == "USDT").all()
    ]
    updated = 0
    limits = httpx.Limits(max_connections=40, max_keepalive_connections=20)
    with httpx.Client(timeout=10, limits=limits) as client:
        with ThreadPoolExecutor(max_workers=20) as pool:
            futs = {pool.submit(_fetch_symbol, sym, client): sym for sym in symbols}
            for fut in as_completed(futs):
                try:
                    res = fut.result()
                except Exception:
                    continue
                row = db.get(BinanceFuture, res["symbol"])
                if row:
                    row.oi_value      = res.get("oi_value")
                    row.oi_change_1h  = res.get("oi_change_1h")
                    row.oi_change_24h = res.get("oi_change_24h")
                    updated += 1
    db.commit()
    logger.info("Fetched OI for %d USDT symbols", updated)
    return updated
