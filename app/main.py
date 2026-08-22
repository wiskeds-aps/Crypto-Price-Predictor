import asyncio
import logging
import os
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime

import httpx
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func
from sqlalchemy.orm import Session

from sqlalchemy import text
from .alerts import check_and_fire
from .signals import check_signals
from .database import SessionLocal, engine, get_db
from .fetcher import fetch_and_store
from .futures_fetcher import fetch_futures
from .liq_collector import run_liq_collector
from .ls_fetcher import fetch_ls_ratios
from .oi_fetcher import fetch_oi
from .models import Alert, Base, BinanceFuture, Coin, Liquidation, TradeLiquiditySnapshot
from .multi_orderbook import DEFAULT_EXCHANGES, get_multi_orderbook
from .oi_history import oi_rows_to_api, parse_oi_points, query_oi_history, upsert_oi_history
from .schemas import CoinOut, FutureOut, FuturesResponse, ScreenerResponse
from .telegram import send_alert
from .trade_collector import run_trade_collector
from .trade_history import query_trade_liquidity_zones

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
_ADMIN_TOKEN = os.environ.get("CRYPTOSKRINER_ADMIN_TOKEN", "")
_API_RATE_LIMIT = int(os.environ.get("CRYPTOSKRINER_API_RATE_LIMIT", "300"))
_API_RATE_WINDOW_SEC = int(os.environ.get("CRYPTOSKRINER_API_RATE_WINDOW_SEC", "60"))
_MARK_PRICE_CACHE_TTL_SEC = float(os.environ.get("CRYPTOSKRINER_MARK_PRICE_CACHE_TTL_SEC", "1.5"))
_LAST_PRICE_CACHE_TTL_SEC = float(os.environ.get("CRYPTOSKRINER_LAST_PRICE_CACHE_TTL_SEC", "1.0"))
_api_hits: dict[str, deque[float]] = defaultdict(deque)
_mark_price_cache: dict[str, tuple[float, dict]] = {}
_last_price_cache: dict[str, tuple[float, dict]] = {}


def require_admin(x_admin_token: str | None = Header(default=None)):
    if not _ADMIN_TOKEN or not x_admin_token or not secrets.compare_digest(x_admin_token, _ADMIN_TOKEN):
        raise HTTPException(status_code=404, detail="Not found")


def _client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"


def _run(fn):
    db = SessionLocal()
    try:
        fn(db)
    except Exception as e:
        logger.error("%s failed: %s", fn.__name__, e)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    # add columns that may be missing in existing DB (SQLite doesn't auto-migrate)
    new_cols = [
        ("binance_futures", "cg_rank",           "INTEGER"),
        ("binance_futures", "change_5m",         "REAL"),
        ("binance_futures", "change_15m",        "REAL"),
        ("binance_futures", "change_30m",        "REAL"),
        ("binance_futures", "change_1h",         "REAL"),
        ("binance_futures", "vol_spike",         "REAL"),
        ("binance_futures", "ls_account_ratio",  "REAL"),
        ("binance_futures", "ls_long_pct",       "REAL"),
        ("binance_futures", "ls_short_pct",      "REAL"),
        ("binance_futures", "ls_taker_ratio",    "REAL"),
        ("binance_futures", "ls_top_account",    "REAL"),
        ("binance_futures", "ls_ta_long_pct",    "REAL"),
        ("binance_futures", "ls_ta_short_pct",   "REAL"),
        ("binance_futures", "ls_top_position",   "REAL"),
        ("binance_futures", "ls_top_long_pct",   "REAL"),
        ("binance_futures", "ls_top_short_pct",  "REAL"),
        ("binance_futures", "oi_value",          "REAL"),
        ("binance_futures", "oi_usd",            "REAL"),
        ("binance_futures", "oi_change_5m",      "REAL"),
        ("binance_futures", "oi_change_30m",     "REAL"),
        ("binance_futures", "oi_change_1h",      "REAL"),
        ("binance_futures", "oi_change_24h",     "REAL"),
        ("binance_futures", "cvd_1h",            "REAL"),
        ("binance_futures", "taker_buy_1h",      "REAL"),
        ("binance_futures", "taker_sell_1h",     "REAL"),
        ("binance_futures", "taker_buy_pct",     "REAL"),
    ]
    with engine.connect() as conn:
        for table, col, typ in new_cols:
            try:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {typ}"))
                conn.commit()
            except Exception:
                pass
    _run(fetch_and_store)
    _run(fetch_futures)

    scheduler = BackgroundScheduler()
    scheduler.add_job(lambda: _run(fetch_and_store), "interval", minutes=5, id="fetch_coins")
    def _fetch_fast():
        _run(fetch_futures)

    scheduler.add_job(_fetch_fast, "interval", seconds=10, id="fetch_futures", max_instances=1, coalesce=True)

    def _check_signals_and_alerts():
        _run(check_signals)
        _run(check_and_fire)

    scheduler.add_job(_check_signals_and_alerts, "interval", seconds=30, id="check_signals_alerts", max_instances=1, coalesce=True)
    def _fetch_slow():
        _run(fetch_ls_ratios)
        _run(fetch_oi)
    scheduler.add_job(_fetch_slow, "interval", minutes=5, id="fetch_ls_oi", max_instances=1, coalesce=True)
    scheduler.start()
    logger.info("Scheduler started")

    liq_task = asyncio.create_task(run_liq_collector())
    logger.info("Liquidation collector started")
    trade_task = asyncio.create_task(run_trade_collector())
    logger.info("Trade history collector started")

    yield
    for task in (liq_task, trade_task):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    scheduler.shutdown()


app = FastAPI(
    title="CryptoScreener",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def api_rate_limit(request: Request, call_next):
    if not request.url.path.startswith("/api/"):
        return await call_next(request)

    now = time.monotonic()
    hits = _api_hits[_client_ip(request)]
    cutoff = now - _API_RATE_WINDOW_SEC
    while hits and hits[0] < cutoff:
        hits.popleft()
    if len(hits) >= _API_RATE_LIMIT:
        return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})
    hits.append(now)
    return await call_next(request)


# ── Spot coins (CoinGecko) ─────────────────────────────────────────────────────

@app.get("/api/coins", response_model=ScreenerResponse)
def get_coins(
    search: str = Query(default=""),
    sort_by: str = Query(default="rank"),
    order: str = Query(default="asc"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    min_market_cap: float | None = Query(default=None),
    max_market_cap: float | None = Query(default=None),
    min_change_24h: float | None = Query(default=None),
    max_change_24h: float | None = Query(default=None),
    db: Session = Depends(get_db),
):
    q = db.query(Coin)
    if search:
        p = f"%{search.lower()}%"
        q = q.filter(func.lower(Coin.name).like(p) | func.lower(Coin.symbol).like(p))
    if min_market_cap is not None:
        q = q.filter(Coin.market_cap >= min_market_cap)
    if max_market_cap is not None:
        q = q.filter(Coin.market_cap <= max_market_cap)
    if min_change_24h is not None:
        q = q.filter(Coin.change_24h >= min_change_24h)
    if max_change_24h is not None:
        q = q.filter(Coin.change_24h <= max_change_24h)

    allowed = {"rank", "price_usd", "market_cap", "volume_24h", "change_1h", "change_24h", "change_7d", "name"}
    sort_key = sort_by if sort_by in allowed else "rank"
    col = getattr(Coin, sort_key)
    if sort_key == "rank":
        rank_order = col.desc() if order == "desc" else col.asc()
        q = q.order_by((Coin.rank <= 0).asc(), rank_order)
    else:
        q = q.order_by(col.desc() if order == "desc" else col.asc())

    total = q.count()
    coins = q.offset(offset).limit(limit).all()
    last_updated = db.query(func.max(Coin.updated_at)).scalar()
    return ScreenerResponse(coins=coins, total=total, last_updated=last_updated)


@app.get("/api/coins/{coin_id}", response_model=CoinOut)
def get_coin(coin_id: str, db: Session = Depends(get_db)):
    coin = db.get(Coin, coin_id)
    if not coin:
        raise HTTPException(status_code=404, detail="Coin not found")
    return coin


@app.post("/api/refresh")
def refresh(_: None = Depends(require_admin), db: Session = Depends(get_db)):
    try:
        count = fetch_and_store(db)
        return {"status": "ok", "fetched": count, "at": datetime.utcnow()}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


# ── Binance Futures ────────────────────────────────────────────────────────────

@app.get("/api/futures", response_model=FuturesResponse)
def get_futures(
    search: str = Query(default=""),
    sort_by: str = Query(default="quote_volume_24h"),
    order: str = Query(default="desc"),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    quote: str = Query(default="", description="Filter by quote asset, e.g. USDT"),
    min_change: float | None = Query(default=None),
    max_change: float | None = Query(default=None),
    min_volume: float | None = Query(default=None),
    exclude_top: int | None = Query(default=None),
    min_change_15m: float | None = Query(default=None),
    max_change_15m: float | None = Query(default=None),
    min_change_5m: float | None = Query(default=None),
    max_change_5m: float | None = Query(default=None),
    min_vol_spike: float | None = Query(default=None),
    db: Session = Depends(get_db),
):
    q = db.query(BinanceFuture)
    if search:
        p = f"%{search.upper()}%"
        q = q.filter(BinanceFuture.symbol.like(p) | BinanceFuture.base_asset.like(p))
    if quote:
        q = q.filter(BinanceFuture.quote_asset == quote.upper())
    if min_change is not None:
        q = q.filter(BinanceFuture.price_change_pct >= min_change)
    if max_change is not None:
        q = q.filter(BinanceFuture.price_change_pct <= max_change)
    if min_volume is not None:
        q = q.filter(BinanceFuture.quote_volume_24h >= min_volume)
    if exclude_top is not None:
        q = q.filter(
            (BinanceFuture.cg_rank == None) | (BinanceFuture.cg_rank > exclude_top)
        )
    if min_change_15m is not None:
        q = q.filter(BinanceFuture.change_15m >= min_change_15m)
    if max_change_15m is not None:
        q = q.filter(BinanceFuture.change_15m <= max_change_15m)
    if min_change_5m is not None:
        q = q.filter(BinanceFuture.change_5m >= min_change_5m)
    if max_change_5m is not None:
        q = q.filter(BinanceFuture.change_5m <= max_change_5m)
    if min_vol_spike is not None:
        q = q.filter(BinanceFuture.vol_spike >= min_vol_spike)

    allowed = {
        "symbol", "base_asset", "last_price", "price_change_pct",
        "quote_volume_24h", "volume_24h", "funding_rate",
        "high_24h", "low_24h", "trades_count",
        "change_5m", "change_15m", "change_30m", "change_1h", "vol_spike",
        "ls_account_ratio", "ls_taker_ratio", "ls_top_account", "ls_top_position",
        "oi_value", "oi_usd", "oi_change_5m", "oi_change_30m", "oi_change_1h", "oi_change_24h",
        "cvd_1h", "taker_buy_1h", "taker_sell_1h", "taker_buy_pct",
    }
    col = getattr(BinanceFuture, sort_by if sort_by in allowed else "quote_volume_24h")
    q = q.order_by(col.desc() if order == "desc" else col.asc())

    total = q.count()
    futures = q.offset(offset).limit(limit).all()
    last_updated = db.query(func.max(BinanceFuture.updated_at)).scalar()
    return FuturesResponse(futures=futures, total=total, last_updated=last_updated)


VALID_INTERVALS = {"1m","3m","5m","15m","30m","1h","2h","4h","6h","12h","1d","1w"}

# Minimum OI/L/S period available on Binance for a given kline interval
_IND_PERIOD = {
    "1m":"5m","3m":"5m","5m":"5m","15m":"15m","30m":"30m",
    "1h":"1h","2h":"2h","4h":"4h","6h":"6h","12h":"12h",
    "1d":"1d","1w":"1d",
}


def _binance_get(url: str, params: dict):
    try:
        with httpx.Client(timeout=10) as client:
            resp = client.get(url, params=params)
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail="Binance error")
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/futures/{symbol}/mark-price")
def get_mark_price(symbol: str):
    sym = symbol.upper()
    now = time.monotonic()
    cached = _mark_price_cache.get(sym)
    if cached and now - cached[0] <= _MARK_PRICE_CACHE_TTL_SEC:
        return cached[1]

    data = _binance_get("https://fapi.binance.com/fapi/v1/premiumIndex", {"symbol": sym})
    payload = {
        "symbol": sym,
        "mark_price": float(data["markPrice"]),
        "index_price": float(data["indexPrice"]) if data.get("indexPrice") else None,
        "time": int(data["time"]) // 1000 if data.get("time") else None,
    }
    _mark_price_cache[sym] = (now, payload)
    return payload


@app.get("/api/futures/{symbol}/last-price")
def get_last_price(symbol: str):
    sym = symbol.upper()
    now = time.monotonic()
    cached = _last_price_cache.get(sym)
    if cached and now - cached[0] <= _LAST_PRICE_CACHE_TTL_SEC:
        return cached[1]

    data = _binance_get("https://fapi.binance.com/fapi/v1/ticker/price", {"symbol": sym})
    payload = {
        "symbol": sym,
        "last_price": float(data["price"]),
        "time": int(data["time"]) // 1000 if data.get("time") else None,
    }
    _last_price_cache[sym] = (now, payload)
    return payload


@app.get("/api/futures/{symbol}/klines")
def get_klines(
    symbol: str,
    interval: str = Query(default="15m"),
    limit: int = Query(default=300, ge=10, le=1000),
):
    if interval not in VALID_INTERVALS:
        raise HTTPException(status_code=400, detail="Invalid interval")
    data = _binance_get(
        "https://fapi.binance.com/fapi/v1/klines",
        {"symbol": symbol.upper(), "interval": interval, "limit": limit},
    )
    return [
        {
            "time":   int(k[0]) // 1000,
            "open":   float(k[1]),
            "high":   float(k[2]),
            "low":    float(k[3]),
            "close":  float(k[4]),
            "volume": float(k[5]),
            "quote_volume": float(k[7]),
            # delta = taker_buy_quote - taker_sell_quote
            "delta":  round(2 * float(k[10]) - float(k[7]), 2),
        }
        for k in data
    ]


@app.get("/api/futures/{symbol}/orderbook")
def get_orderbook(
    symbol: str,
    limit: int = Query(default=500, ge=50, le=1000),
):
    sym = symbol.upper()
    data = _binance_get(
        "https://fapi.binance.com/fapi/v1/depth",
        {"symbol": sym, "limit": limit},
    )

    def _side(rows):
        out = []
        for price, qty in rows:
            p = float(price)
            q = float(qty)
            out.append({
                "price": p,
                "qty": q,
                "notional": round(p * q, 2),
            })
        return out

    return {
        "symbol": sym,
        "last_update_id": data.get("lastUpdateId"),
        "bids": _side(data.get("bids") or []),
        "asks": _side(data.get("asks") or []),
    }


@app.get("/api/futures/{symbol}/multi-orderbook")
def get_multi_exchange_orderbook(
    symbol: str,
    limit: int = Query(default=1000, ge=50, le=1000),
    exchanges: str = Query(default=",".join(DEFAULT_EXCHANGES)),
):
    selected = [item.strip() for item in exchanges.split(",") if item.strip()]
    try:
        return get_multi_orderbook(symbol.upper(), limit=limit, exchanges=selected)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/futures/{symbol}/trade-zones")
def get_trade_liquidity_zones(
    symbol: str,
    window: str = Query(default="5m"),
    ranges: int = Query(default=6, ge=1, le=24),
    step: float = Query(default=0, ge=0),
    min_notional: float = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return query_trade_liquidity_zones(
        db,
        symbol.upper(),
        window=window,
        ranges=ranges,
        step=step,
        min_notional=min_notional,
    )


@app.get("/api/futures/{symbol}/oi")
def get_oi(
    symbol: str,
    interval: str = Query(default="15m"),
    limit: int = Query(default=400, ge=10, le=5000),
    start_time: int | None = Query(default=None),
    db: Session = Depends(get_db),
):
    period = _IND_PERIOD.get(interval, "15m")
    sym = symbol.upper()
    # Binance's own openInterestHist endpoint caps limit at 500; the accumulated
    # local history can hold far more, so only the DB query gets the full limit.
    params: dict = {"symbol": sym, "period": period, "limit": min(limit, 500)}
    if start_time:
        params["startTime"] = start_time * 1000
    rows = query_oi_history(db, sym, period, limit=limit, start_time=start_time)

    try:
        data = _binance_get("https://fapi.binance.com/futures/data/openInterestHist", params)
        upsert_oi_history(db, parse_oi_points(sym, period, data))
        db.commit()
        rows = query_oi_history(db, sym, period, limit=limit, start_time=start_time)
    except HTTPException:
        if not rows:
            raise
        logger.debug("Serving cached OI for %s %s after Binance error", sym, period)
    except Exception as e:
        db.rollback()
        if not rows:
            raise HTTPException(status_code=502, detail=str(e))
        logger.debug("Serving cached OI for %s %s after local OI error: %s", sym, period, e)

    points = oi_rows_to_api(rows)
    try:
        live = _binance_get("https://fapi.binance.com/fapi/v1/openInterest", {"symbol": sym})
        live_time = int(live["time"]) // 1000
        live_oi = float(live["openInterest"])
        if live_time and live_oi and (not points or live_time > points[-1]["time"]):
            points.append({"time": live_time, "value": None, "oi": live_oi, "live": True})
    except Exception as e:
        logger.debug("Live OI snapshot error %s: %s", sym, e)

    points.sort(key=lambda p: p["time"])
    return points


@app.get("/api/futures/{symbol}/ls-ratio")
def get_ls_ratio(
    symbol: str,
    interval: str = Query(default="15m"),
    limit: int = Query(default=400, ge=10, le=500),
    start_time: int | None = Query(default=None),
):
    period = _IND_PERIOD.get(interval, "15m")
    params: dict = {"symbol": symbol.upper(), "period": period, "limit": limit}
    if start_time:
        params["startTime"] = start_time * 1000
    data = _binance_get("https://fapi.binance.com/futures/data/globalLongShortAccountRatio", params)
    return [
        {
            "time":      int(d["timestamp"]) // 1000,
            "ratio":     float(d["longShortRatio"]),
            "long_pct":  round(float(d["longAccount"]) * 100, 2),
            "short_pct": round(float(d["shortAccount"]) * 100, 2),
        }
        for d in data
    ]


@app.get("/api/futures/{symbol}/liquidations")
def get_liquidations(
    symbol: str,
    limit: int = Query(default=1440, ge=10, le=10000),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(Liquidation)
        .filter(Liquidation.symbol == symbol.upper())
        .order_by(Liquidation.time_bucket.desc())
        .limit(limit)
        .all()
    )
    rows.reverse()
    return [
        {"time": r.time_bucket, "long": round(r.long_liq_usd, 2), "short": round(r.short_liq_usd, 2)}
        for r in rows
    ]


@app.delete("/api/liquidations", status_code=204)
def clear_liquidations(
    symbol: str | None = Query(default=None),
    _: None = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Admin: clear liquidation history for a symbol or all symbols."""
    q = db.query(Liquidation)
    if symbol:
        q = q.filter(Liquidation.symbol == symbol.upper())
    q.delete()
    db.commit()


@app.get("/api/alerts")
def list_alerts(db: Session = Depends(get_db)):
    return db.query(Alert).order_by(Alert.created_at.desc()).all()


@app.post("/api/alerts", status_code=201)
def create_alert(
    symbol: str = Query(...),
    min_vol_spike: float | None = Query(default=None),
    min_change_5m: float | None = Query(default=None),
    max_change_5m: float | None = Query(default=None),
    min_change_15m: float | None = Query(default=None),
    max_change_15m: float | None = Query(default=None),
    cooldown_min: int = Query(default=30),
    db: Session = Depends(get_db),
):
    alert = Alert(
        symbol=symbol.upper(),
        min_vol_spike=min_vol_spike,
        min_change_5m=min_change_5m,
        max_change_5m=max_change_5m,
        min_change_15m=min_change_15m,
        max_change_15m=max_change_15m,
        cooldown_min=cooldown_min,
    )
    db.add(alert); db.commit(); db.refresh(alert)
    return alert


@app.delete("/api/alerts/{alert_id}", status_code=204)
def delete_alert(alert_id: int, db: Session = Depends(get_db)):
    a = db.get(Alert, alert_id)
    if not a:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(a); db.commit()


@app.patch("/api/alerts/{alert_id}/toggle")
def toggle_alert(alert_id: int, db: Session = Depends(get_db)):
    a = db.get(Alert, alert_id)
    if not a:
        raise HTTPException(status_code=404, detail="Not found")
    a.active = not a.active; db.commit()
    return {"id": a.id, "active": a.active}


@app.post("/api/futures/refresh")
def refresh_futures(_: None = Depends(require_admin), db: Session = Depends(get_db)):
    try:
        count = fetch_futures(db)
        return {"status": "ok", "fetched": count, "at": datetime.utcnow()}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/stats")
def stats(db: Session = Depends(get_db)):
    return {
        "total_coins": db.query(func.count(Coin.id)).scalar(),
        "total_futures": db.query(func.count(BinanceFuture.symbol)).scalar(),
        "trade_liquidity_snapshots": db.query(func.count(TradeLiquiditySnapshot.id)).scalar(),
        "coins_updated": db.query(func.max(Coin.updated_at)).scalar(),
        "futures_updated": db.query(func.max(BinanceFuture.updated_at)).scalar(),
    }


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(status_code=204)


# ── Static frontend ────────────────────────────────────────────────────────────
app.mount("/", StaticFiles(directory="static", html=True), name="static")
