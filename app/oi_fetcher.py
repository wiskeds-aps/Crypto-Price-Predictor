"""
Fetches OI (in coins) + CVD 1h for all USDT perpetuals.
OI: openInterestHist period=1h limit=25 (1 request/symbol)
CVD: klines interval=15m limit=4 (1 request/symbol)
Runs on 10-minute schedule alongside ls_fetcher.
"""
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
from sqlalchemy.orm import Session

from .models import BinanceFuture

logger = logging.getLogger(__name__)

_OI_URL     = "https://fapi.binance.com/futures/data/openInterestHist"
_KLINES_URL = "https://fapi.binance.com/fapi/v1/klines"


def _fetch_symbol(symbol: str, client: httpx.Client) -> dict:
    result: dict = {"symbol": symbol}

    # OI in coins + 1h/24h change
    try:
        r = client.get(_OI_URL, params={"symbol": symbol, "period": "1h", "limit": 25})
        r.raise_for_status()
        data = r.json()
        if data:
            current = float(data[-1]["sumOpenInterest"])
            result["oi_value"] = current
            if len(data) >= 2:
                prev = float(data[-2]["sumOpenInterest"])
                result["oi_change_1h"] = (current / prev - 1) * 100 if prev else None
            if len(data) >= 25:
                prev24 = float(data[0]["sumOpenInterest"])
                result["oi_change_24h"] = (current / prev24 - 1) * 100 if prev24 else None
    except Exception as e:
        logger.debug("OI error %s: %s", symbol, e)

    # CVD 1h — last 4 × 15m candles
    try:
        r = client.get(_KLINES_URL, params={"symbol": symbol, "interval": "15m", "limit": 4})
        r.raise_for_status()
        klines = r.json()
        # delta per candle = 2*takerBuyQuote - totalQuote
        result["cvd_1h"] = sum(2 * float(k[10]) - float(k[7]) for k in klines)
    except Exception as e:
        logger.debug("CVD error %s: %s", symbol, e)

    return result


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
                    row.cvd_1h        = res.get("cvd_1h")
                    updated += 1
    db.commit()
    logger.info("Fetched OI+CVD for %d USDT symbols", updated)
    return updated
