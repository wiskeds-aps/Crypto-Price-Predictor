"""
Fetches OI (in coins) + CVD 1h for all USDT perpetuals.
OI: openInterestHist period=5m limit=289 (1 request/symbol)
CVD/taker: klines interval=15m limit=5, drops open candle → 4 closed = 1h (1 request/symbol)
Runs on 5-minute schedule alongside ls_fetcher.
"""
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
from sqlalchemy.orm import Session

from .models import BinanceFuture
from .oi_history import cleanup_oi_history, latest_oi_times, parse_oi_points, upsert_oi_history

logger = logging.getLogger(__name__)

_OI_URL     = "https://fapi.binance.com/futures/data/openInterestHist"
_KLINES_URL = "https://fapi.binance.com/fapi/v1/klines"
_OI_HISTORY_RETENTION_DAYS = int(os.environ.get("CRYPTOSKRINER_OI_RETENTION_DAYS", "370"))


def _fetch_symbol(symbol: str, client: httpx.Client, latest_oi_ts: int | None = None) -> dict:
    result: dict = {"symbol": symbol}

    # OI in coins: one request covers 5m/30m/1h/24h changes
    # period=5m limit=289 → 289 points = 24h of 5-min bars
    # indices: [-2]=5m ago, [-7]=30m ago, [-13]=1h ago, [0]=24h ago
    try:
        r = client.get(_OI_URL, params={"symbol": symbol, "period": "5m", "limit": 289})
        r.raise_for_status()
        data = r.json()
        if data:
            points = parse_oi_points(symbol, "5m", data)
            if latest_oi_ts is not None:
                points = [p for p in points if p["time_bucket"] > latest_oi_ts]
            result["_oi_history"] = points

            current = float(data[-1]["sumOpenInterest"])
            result["oi_value"] = current
            result["oi_usd"]   = float(data[-1]["sumOpenInterestValue"])

            def _chg(idx):
                if len(data) >= abs(idx):
                    prev = float(data[idx]["sumOpenInterest"])
                    return (current / prev - 1) * 100 if prev else None
                return None

            result["oi_change_5m"]  = _chg(-2)
            result["oi_change_30m"] = _chg(-7)
            result["oi_change_1h"]  = _chg(-13)
            result["oi_change_24h"] = _chg(0) if len(data) >= 289 else None
    except Exception as e:
        logger.debug("OI error %s: %s", symbol, e)

    # CVD + taker buy volumes — last 4 closed 15m candles = 1h
    # limit=5: Binance always appends the open candle last; drop it with [:-1]
    try:
        r = client.get(_KLINES_URL, params={"symbol": symbol, "interval": "15m", "limit": 5})
        r.raise_for_status()
        klines = r.json()[:-1]  # drop the currently-open candle
        if not klines:
            return result
        # k[7] = total quote volume, k[10] = taker buy quote volume
        taker_buy = 0.0
        total_vol = 0.0
        for k in klines:
            taker_buy += float(k[10])
            total_vol += float(k[7])
        if total_vol:
            taker_sell = total_vol - taker_buy
            result["cvd_1h"]         = round(taker_buy - taker_sell, 2)
            result["taker_buy_1h"]   = taker_buy
            result["taker_sell_1h"]  = taker_sell
            result["taker_buy_pct"]  = round(taker_buy / total_vol * 100, 2)
        else:
            result["cvd_1h"]         = None
            result["taker_buy_1h"]   = None
            result["taker_sell_1h"]  = None
            result["taker_buy_pct"]  = None
    except Exception as e:
        logger.debug("CVD error %s: %s", symbol, e)

    return result


def fetch_oi(db: Session) -> int:
    symbols = [
        r.symbol for r in db.query(BinanceFuture.symbol)
        .filter(BinanceFuture.quote_asset == "USDT").all()
    ]
    latest_by_symbol = latest_oi_times(db, "5m", symbols)
    updated = 0
    history_rows = []
    limits = httpx.Limits(max_connections=40, max_keepalive_connections=20)
    with httpx.Client(timeout=10, limits=limits) as client:
        with ThreadPoolExecutor(max_workers=20) as pool:
            futs = {
                pool.submit(_fetch_symbol, sym, client, latest_by_symbol.get(sym)): sym
                for sym in symbols
            }
            for fut in as_completed(futs):
                try:
                    res = fut.result()
                except Exception:
                    continue
                history_rows.extend(res.get("_oi_history") or [])
                row = db.get(BinanceFuture, res["symbol"])
                if row:
                    updated_any = False
                    for field in (
                        "oi_value",
                        "oi_usd",
                        "oi_change_5m",
                        "oi_change_30m",
                        "oi_change_1h",
                        "oi_change_24h",
                        "cvd_1h",
                        "taker_buy_1h",
                        "taker_sell_1h",
                        "taker_buy_pct",
                    ):
                        if field in res:
                            setattr(row, field, res[field])
                            updated_any = True
                    if not updated_any:
                        continue
                    updated += 1
    db.commit()
    history_written = upsert_oi_history(db, history_rows, commit_every_chunk=True)
    deleted = cleanup_oi_history(db, _OI_HISTORY_RETENTION_DAYS)
    db.commit()
    logger.info(
        "Fetched OI/CVD/taker for %d USDT symbols, OI history +%d, deleted %d old rows",
        updated,
        history_written,
        deleted,
    )
    return updated
