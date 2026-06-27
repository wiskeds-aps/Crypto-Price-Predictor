import logging
from contextlib import asynccontextmanager
from datetime import datetime

import httpx
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func
from sqlalchemy.orm import Session

from sqlalchemy import text
from .alerts import check_and_fire
from .signals import check_signals
from .database import SessionLocal, engine, get_db
from .fetcher import fetch_and_store
from .futures_fetcher import fetch_futures
from .ls_fetcher import fetch_ls_ratios
from .oi_fetcher import fetch_oi
from .models import Alert, Base, BinanceFuture, Coin
from .schemas import CoinOut, FutureOut, FuturesResponse, ScreenerResponse
from .telegram import send_alert

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


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
    def _fetch_and_check():
        _run(fetch_futures)
        _run(check_signals)
        _run(check_and_fire)

    scheduler.add_job(_fetch_and_check, "interval", seconds=30, id="fetch_futures")
    def _fetch_slow():
        _run(fetch_ls_ratios)
        _run(fetch_oi)
    scheduler.add_job(_fetch_slow, "interval", minutes=10, id="fetch_ls_oi")
    scheduler.start()
    logger.info("Scheduler started")

    yield
    scheduler.shutdown()


app = FastAPI(title="CryptoScreener", lifespan=lifespan)


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
    col = getattr(Coin, sort_by if sort_by in allowed else "rank")
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
def refresh(db: Session = Depends(get_db)):
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
        "oi_value", "oi_change_5m", "oi_change_30m", "oi_change_1h", "oi_change_24h",
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
            # delta = taker_buy_quote - taker_sell_quote
            "delta":  round(2 * float(k[10]) - float(k[7]), 2),
        }
        for k in data
    ]


@app.get("/api/futures/{symbol}/oi")
def get_oi(
    symbol: str,
    interval: str = Query(default="15m"),
    limit: int = Query(default=400, ge=10, le=500),
    start_time: int | None = Query(default=None),
):
    period = _IND_PERIOD.get(interval, "15m")
    params: dict = {"symbol": symbol.upper(), "period": period, "limit": limit}
    if start_time:
        params["startTime"] = start_time * 1000
    data = _binance_get("https://fapi.binance.com/futures/data/openInterestHist", params)
    return [
        {
            "time":  int(d["timestamp"]) // 1000,
            "value": float(d["sumOpenInterestValue"]),
            "oi":    float(d["sumOpenInterest"]),
        }
        for d in data
    ]


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
def refresh_futures(db: Session = Depends(get_db)):
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
        "coins_updated": db.query(func.max(Coin.updated_at)).scalar(),
        "futures_updated": db.query(func.max(BinanceFuture.updated_at)).scalar(),
    }


# ── Static frontend ────────────────────────────────────────────────────────────
app.mount("/", StaticFiles(directory="static", html=True), name="static")
