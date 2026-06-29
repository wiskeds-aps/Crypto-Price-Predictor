"""
Binance !forceOrder@arr WebSocket collector.
Accumulates liquidations in 1-minute buckets and flushes to SQLite every 10 s.
Side legend: SELL = long position liquidated; BUY = short position liquidated.
"""
import asyncio
import json
import logging
import time
from collections import defaultdict

import websockets
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import Liquidation

logger = logging.getLogger(__name__)

_WS_URL      = "wss://fstream.binance.com/market/ws/!forceOrder@arr"
_BUCKET_SEC  = 60   # 1-minute buckets
_FLUSH_EVERY = 10   # flush to DB every N seconds
_RETENTION_DAYS = 30
_CLEANUP_EVERY = 60 * 60

# (symbol, bucket_ts) → [long_usd, short_usd]
_buf: dict[tuple[str, int], list[float]] = defaultdict(lambda: [0.0, 0.0])
_last_cleanup_ts = 0.0


def _bucket(ts_ms: int) -> int:
    return (ts_ms // 1000 // _BUCKET_SEC) * _BUCKET_SEC


def _write_snapshot(snapshot: dict) -> None:
    db: Session = SessionLocal()
    try:
        for (symbol, bucket), (long_usd, short_usd) in snapshot.items():
            row = db.query(Liquidation).filter_by(symbol=symbol, time_bucket=bucket).first()
            if row:
                row.long_liq_usd  += long_usd
                row.short_liq_usd += short_usd
            else:
                db.add(Liquidation(
                    symbol=symbol, time_bucket=bucket,
                    long_liq_usd=long_usd, short_liq_usd=short_usd,
                ))
        db.commit()
    except Exception as exc:
        logger.error("Liq flush error: %s", exc)
        db.rollback()
    finally:
        db.close()


def _cleanup_old_rows() -> None:
    db: Session = SessionLocal()
    try:
        cutoff = int(time.time()) - _RETENTION_DAYS * 24 * 60 * 60
        deleted = (
            db.query(Liquidation)
            .filter(Liquidation.time_bucket < cutoff)
            .delete(synchronize_session=False)
        )
        db.commit()
        if deleted:
            logger.info("Deleted %d liquidation rows older than %d days", deleted, _RETENTION_DAYS)
    except Exception as exc:
        logger.error("Liq cleanup error: %s", exc)
        db.rollback()
    finally:
        db.close()


async def _cleanup_if_due() -> None:
    global _last_cleanup_ts
    now = time.time()
    if now - _last_cleanup_ts < _CLEANUP_EVERY:
        return
    _last_cleanup_ts = now
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _cleanup_old_rows)


async def _flush() -> None:
    if not _buf:
        await _cleanup_if_due()
        return
    snapshot = dict(_buf)
    _buf.clear()
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _write_snapshot, snapshot)
    await _cleanup_if_due()


async def _flush_periodically() -> None:
    try:
        while True:
            await asyncio.sleep(_FLUSH_EVERY)
            await _flush()
    except asyncio.CancelledError:
        await _flush()
        raise


async def _stop_flush_task(task) -> None:
    if not task:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


def _iter_force_orders(raw: str):
    msg = json.loads(raw)
    if isinstance(msg, list):
        return msg
    return [msg]


async def run_liq_collector() -> None:
    """Runs forever; reconnects automatically on any error."""
    while True:
        flush_task = None
        try:
            async with websockets.connect(
                _WS_URL,
                ping_interval=20,
                ping_timeout=30,
                open_timeout=15,
            ) as ws:
                logger.info("Liquidation WS connected")
                flush_task = asyncio.create_task(_flush_periodically())

                try:
                    async for raw in ws:
                        try:
                            for msg in _iter_force_orders(raw):
                                if not isinstance(msg, dict):
                                    continue
                                o      = msg.get("o", {})
                                symbol = o.get("s", "")
                                side   = o.get("S", "")    # SELL or BUY
                                ts_ms  = int(o.get("T", 0))
                                value  = float(o.get("ap", 0)) * float(o.get("z", 0))

                                if symbol and value > 0:
                                    key = (symbol, _bucket(ts_ms))
                                    if side == "SELL":
                                        _buf[key][0] += value
                                    elif side == "BUY":
                                        _buf[key][1] += value
                        except Exception:
                            pass
                finally:
                    await _stop_flush_task(flush_task)
                    await _flush()

        except asyncio.CancelledError:
            await _flush()
            raise
        except Exception as exc:
            await _flush()
            logger.warning("Liq WS error: %s — reconnect in 5 s", exc)
            await asyncio.sleep(5)
