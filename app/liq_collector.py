"""
Binance !forceOrder@arr WebSocket collector.
Accumulates liquidations in 1-minute buckets and flushes to SQLite every 10 s.
Side legend: SELL = long position liquidated; BUY = short position liquidated.
"""
import asyncio
import json
import logging
from collections import defaultdict

import websockets
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import Liquidation

logger = logging.getLogger(__name__)

_WS_URL      = "wss://fstream.binance.com/ws/!forceOrder@arr"
_BUCKET_SEC  = 60   # 1-minute buckets
_FLUSH_EVERY = 10   # flush to DB every N seconds

# (symbol, bucket_ts) → [long_usd, short_usd]
_buf: dict[tuple[str, int], list[float]] = defaultdict(lambda: [0.0, 0.0])


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


async def _flush() -> None:
    if not _buf:
        return
    snapshot = dict(_buf)
    _buf.clear()
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _write_snapshot, snapshot)


async def run_liq_collector() -> None:
    """Runs forever; reconnects automatically on any error."""
    while True:
        try:
            async with websockets.connect(
                _WS_URL,
                ping_interval=20,
                ping_timeout=30,
                open_timeout=15,
            ) as ws:
                logger.info("Liquidation WS connected")
                last_flush = asyncio.get_event_loop().time()

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
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

                    now = asyncio.get_event_loop().time()
                    if now - last_flush >= _FLUSH_EVERY:
                        await _flush()
                        last_flush = now

        except asyncio.CancelledError:
            await _flush()
            raise
        except Exception as exc:
            logger.warning("Liq WS error: %s — reconnect in 5 s", exc)
            await asyncio.sleep(5)
