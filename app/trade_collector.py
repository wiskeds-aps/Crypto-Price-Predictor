"""
Binance futures trade collector.
Stores compact executed-liquidity zones; raw trades are not persisted.
"""
import asyncio
import json
import logging
import math
import os
import time
from datetime import datetime
from typing import Any

import websockets
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import BinanceFuture, TradeLiquiditySnapshot
from .trade_history import prune_trade_liquidity_history

logger = logging.getLogger(__name__)

_WS_BASE = "wss://fstream.binance.com/public/stream"
_ENABLED = os.environ.get("CRYPTOSKRINER_TRADE_HISTORY_ENABLED", "1").strip().lower() not in {"0", "false", "no"}
_STREAMS_PER_CONN = max(1, int(os.environ.get("CRYPTOSKRINER_TRADE_HISTORY_STREAMS_PER_CONN", "80")))
_BUCKET_SEC = 60
_FLUSH_EVERY = max(1, int(float(os.environ.get("CRYPTOSKRINER_TRADE_HISTORY_FLUSH_SEC", "5"))))
_SYMBOL_REFRESH_SEC = max(60, int(float(os.environ.get("CRYPTOSKRINER_TRADE_HISTORY_SYMBOL_REFRESH_SEC", "1800"))))
_MAX_ZONES_PER_SIDE = max(1, int(os.environ.get("CRYPTOSKRINER_TRADE_HISTORY_ZONES_PER_SIDE", "12")))
_BASE_STEP_PCT = max(0.000001, float(os.environ.get("CRYPTOSKRINER_TRADE_HISTORY_BASE_STEP_PCT", "0.00001")))
_MAX_STEP_PCT = max(_BASE_STEP_PCT, float(os.environ.get("CRYPTOSKRINER_TRADE_HISTORY_MAX_STEP_PCT", "0.001")))
_SYMBOL_LIMIT = max(0, int(os.environ.get("CRYPTOSKRINER_TRADE_HISTORY_SYMBOL_LIMIT", "0")))
_QUOTE_FILTER = {
    q.strip().upper()
    for q in os.environ.get("CRYPTOSKRINER_TRADE_HISTORY_QUOTES", "").split(",")
    if q.strip()
}

_buf: dict[tuple[str, int], dict[str, Any]] = {}
_dirty: set[tuple[str, int]] = set()
_last_cleanup_ts = 0.0


def _chunks(items: list[str], size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _load_symbols() -> list[str]:
    db: Session = SessionLocal()
    try:
        q = db.query(BinanceFuture.symbol)
        if _QUOTE_FILTER:
            q = q.filter(BinanceFuture.quote_asset.in_(_QUOTE_FILTER))
        symbols = [row[0] for row in q.order_by(BinanceFuture.symbol.asc()).all()]
        if _SYMBOL_LIMIT:
            symbols = symbols[:_SYMBOL_LIMIT]
        return symbols
    finally:
        db.close()


async def _load_symbols_async() -> list[str]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _load_symbols)


def _float(value: Any, default: float | None = None) -> float | None:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    return num if math.isfinite(num) else default


def _nice_step(raw: float) -> float:
    n = float(raw or 0)
    if not math.isfinite(n) or n <= 0:
        return 1.0
    power = 10 ** math.floor(math.log10(n))
    base = n / power
    nice = 1 if base <= 1 else 2 if base <= 2 else 5 if base <= 5 else 10
    return nice * power


def _step_for_price(price: float) -> float:
    raw = max(price * _BASE_STEP_PCT, 1e-12)
    cap = max(price * _MAX_STEP_PCT, raw)
    step = _nice_step(raw)
    return min(step, cap)


def _step_precision(step: float) -> int:
    n = abs(float(step or 0))
    if not math.isfinite(n) or n <= 0:
        return 2
    return max(0, min(12, math.ceil(-math.log10(n)) + 4))


def _round_price(value: float, step: float) -> float:
    return round(float(value), _step_precision(step))


def _bucket_trade(symbol: str, ts_ms: int, side: str, price: float, qty: float) -> None:
    if not symbol or side not in {"buy", "sell"} or price <= 0 or qty <= 0:
        return
    bucket_ts = (ts_ms // 1000 // _BUCKET_SEC) * _BUCKET_SEC
    key = (symbol, bucket_ts)
    item = _buf.get(key)
    if not item:
        item = {
            "symbol": symbol,
            "time_bucket": bucket_ts,
            "min_price": price,
            "max_price": price,
            "step": _step_for_price(price),
            "buy_notional": 0.0,
            "sell_notional": 0.0,
            "trade_count": 0,
            "zones": {},
        }
        _buf[key] = item

    step = float(item["step"] or _step_for_price(price))
    lower = _round_price(math.floor(price / step) * step, step)
    upper = _round_price(lower + step, step)
    precision = _step_precision(step)
    zone_key = f"{side}:{lower:.{precision}f}"
    zone = item["zones"].get(zone_key)
    if not zone:
        zone = {
            "side": side,
            "lower": lower,
            "upper": upper,
            "minPrice": price,
            "maxPrice": price,
            "qty": 0.0,
            "notional": 0.0,
            "weightedPrice": 0.0,
            "count": 0,
            "step": step,
        }
        item["zones"][zone_key] = zone

    notional = price * qty
    zone["qty"] += qty
    zone["notional"] += notional
    zone["weightedPrice"] += price * notional
    zone["minPrice"] = min(zone["minPrice"], price)
    zone["maxPrice"] = max(zone["maxPrice"], price)
    zone["count"] += 1
    item["min_price"] = min(float(item["min_price"]), price)
    item["max_price"] = max(float(item["max_price"]), price)
    item["trade_count"] += 1
    if side == "buy":
        item["buy_notional"] += notional
    else:
        item["sell_notional"] += notional
    _dirty.add(key)


def _row_from_item(item: dict[str, Any]) -> dict[str, Any] | None:
    zones = []
    for side in ("buy", "sell"):
        side_zones = [
            zone for zone in item["zones"].values()
            if zone.get("side") == side and float(zone.get("notional") or 0) > 0
        ]
        side_zones.sort(key=lambda zone: float(zone["notional"]), reverse=True)
        for zone in side_zones[:_MAX_ZONES_PER_SIDE]:
            notional = float(zone["notional"])
            zones.append({
                "side": side,
                "lower": zone["lower"],
                "upper": zone["upper"],
                "minPrice": zone["minPrice"],
                "maxPrice": zone["maxPrice"],
                "price": zone["weightedPrice"] / notional if notional > 0 else (zone["lower"] + zone["upper"]) / 2,
                "qty": zone["qty"],
                "notional": notional,
                "maxNotional": notional,
                "count": zone["count"],
                "step": zone["step"],
            })
    if not zones:
        return None
    return {
        "symbol": item["symbol"],
        "time_bucket": item["time_bucket"],
        "min_price": item["min_price"],
        "max_price": item["max_price"],
        "step": item["step"],
        "buy_notional": item["buy_notional"],
        "sell_notional": item["sell_notional"],
        "trade_count": item["trade_count"],
        "zones_json": json.dumps(zones, separators=(",", ":")),
    }


def _write_snapshots(rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    db: Session = SessionLocal()
    try:
        written = 0
        now = datetime.utcnow()
        for item in rows:
            row = (
                db.query(TradeLiquiditySnapshot)
                .filter_by(symbol=item["symbol"], time_bucket=item["time_bucket"])
                .first()
            )
            if row is None:
                row = TradeLiquiditySnapshot(**item, created_at=now)
                db.add(row)
            else:
                row.min_price = item["min_price"]
                row.max_price = item["max_price"]
                row.step = item["step"]
                row.buy_notional = item["buy_notional"]
                row.sell_notional = item["sell_notional"]
                row.trade_count = item["trade_count"]
                row.zones_json = item["zones_json"]
                row.created_at = now
            written += 1
        db.commit()
        return written
    except Exception as exc:
        db.rollback()
        logger.error("Trade history flush error: %s", exc)
        return 0
    finally:
        db.close()


def _cleanup_old_rows() -> int:
    db: Session = SessionLocal()
    try:
        return prune_trade_liquidity_history(db)
    except Exception as exc:
        db.rollback()
        logger.error("Trade history cleanup error: %s", exc)
        return 0
    finally:
        db.close()


async def _cleanup_if_due() -> None:
    global _last_cleanup_ts
    now = time.time()
    if now - _last_cleanup_ts < 60 * 60:
        return
    _last_cleanup_ts = now
    loop = asyncio.get_running_loop()
    deleted = await loop.run_in_executor(None, _cleanup_old_rows)
    if deleted:
        logger.info("Deleted %d old trade liquidity snapshots", deleted)


def _prune_memory() -> None:
    cutoff = (int(time.time()) // _BUCKET_SEC) * _BUCKET_SEC - _BUCKET_SEC
    for key in list(_buf.keys()):
        if key[1] < cutoff and key not in _dirty:
            _buf.pop(key, None)


async def _flush() -> None:
    if not _dirty:
        _prune_memory()
        await _cleanup_if_due()
        return

    keys = list(_dirty)
    _dirty.clear()
    rows = []
    for key in keys:
        item = _buf.get(key)
        if not item:
            continue
        row = _row_from_item(item)
        if row:
            rows.append(row)
    loop = asyncio.get_running_loop()
    written = await loop.run_in_executor(None, _write_snapshots, rows)
    if written:
        logger.debug("Saved %d trade liquidity snapshots", written)
    _prune_memory()
    await _cleanup_if_due()


async def _flush_periodically() -> None:
    try:
        while True:
            await asyncio.sleep(_FLUSH_EVERY)
            await _flush()
    except asyncio.CancelledError:
        await _flush()
        raise


def _stream_name(symbol: str) -> str:
    return f"{symbol.lower()}@trade"


def _handle_trade_raw(raw: str) -> None:
    try:
        msg = json.loads(raw)
    except ValueError:
        return
    data = msg.get("data") if isinstance(msg, dict) else None
    if not isinstance(data, dict):
        data = msg if isinstance(msg, dict) else {}
    if data.get("e") != "trade":
        return

    symbol = str(data.get("s") or "").upper()
    price = _float(data.get("p"))
    qty = _float(data.get("q"))
    ts_ms = int(_float(data.get("T"), time.time() * 1000) or time.time() * 1000)
    if not symbol or price is None or qty is None:
        return

    side = "sell" if data.get("m") else "buy"
    _bucket_trade(symbol, ts_ms, side, price, qty)


async def _run_batch(symbols: list[str], batch_index: int) -> None:
    streams = "/".join(_stream_name(symbol) for symbol in symbols)
    url = f"{_WS_BASE}?streams={streams}"
    while True:
        try:
            async with websockets.connect(
                url,
                ping_interval=20,
                ping_timeout=30,
                open_timeout=20,
                max_size=16 * 1024 * 1024,
            ) as ws:
                logger.info("Trade history WS batch %d connected: %d symbols", batch_index, len(symbols))
                async for raw in ws:
                    _handle_trade_raw(raw)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Trade history WS batch %d error: %s; reconnect in 5 s", batch_index, exc)
            await asyncio.sleep(5)


async def _stop_tasks(tasks: list[asyncio.Task]) -> None:
    for task in tasks:
        task.cancel()
    for task in tasks:
        try:
            await task
        except asyncio.CancelledError:
            pass


async def run_trade_collector() -> None:
    if not _ENABLED:
        logger.info("Trade history collector disabled")
        return

    flush_task = asyncio.create_task(_flush_periodically())
    batch_tasks: list[asyncio.Task] = []
    active_key: tuple[str, ...] = ()
    try:
        while True:
            symbols = await _load_symbols_async()
            key = tuple(symbols)
            if key != active_key:
                await _stop_tasks(batch_tasks)
                batch_tasks = []
                active_key = key
                if symbols:
                    batches = list(_chunks(symbols, _STREAMS_PER_CONN))
                    batch_tasks = [
                        asyncio.create_task(_run_batch(batch, idx + 1))
                        for idx, batch in enumerate(batches)
                    ]
                    logger.info(
                        "Trade history collector tracking %d symbols in %d batches; bucket=60s retention=24h",
                        len(symbols),
                        len(batches),
                    )
                else:
                    logger.warning("Trade history collector has no futures symbols yet")
            await asyncio.sleep(_SYMBOL_REFRESH_SEC)
    except asyncio.CancelledError:
        await _stop_tasks(batch_tasks)
        flush_task.cancel()
        try:
            await flush_task
        except asyncio.CancelledError:
            pass
        await _flush()
        raise
