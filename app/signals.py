"""
Auto pump/dump signal detection.
Runs after every futures fetch, sends Telegram alerts with cooldown per symbol.
"""
import logging
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from .models import BinanceFuture
from .telegram import send_alert

logger = logging.getLogger(__name__)

# Thresholds
VOL_SPIKE_MIN   = 2.0   # volume at least 2× normal
VOL_SPIKE_ALERT_MIN = 10.0  # standalone volume alert
CHANGE_15M_PUMP =  1.5  # % gain in 15 min
CHANGE_15M_DUMP = -1.5  # % loss in 15 min
CHANGE_5M_PUMP  =  0.8  # extra 5m filter to catch fast moves
CHANGE_5M_DUMP  = -0.8

COOLDOWN_MIN = 30  # minutes before re-alerting same symbol

# in-memory cooldown: "kind:symbol" → last sent datetime
_cooldowns: dict[str, datetime] = {}


def _cooldown_key(kind: str, symbol: str) -> str:
    return f"{kind}:{symbol}"


def _cooldown_active(kind: str, symbol: str, now: datetime) -> bool:
    last = _cooldowns.get(_cooldown_key(kind, symbol))
    return bool(last and (now - last) < timedelta(minutes=COOLDOWN_MIN))


def _mark_cooldown(kind: str, symbol: str, now: datetime):
    _cooldowns[_cooldown_key(kind, symbol)] = now


def check_signals(db: Session):
    now = datetime.utcnow()
    futures = db.query(BinanceFuture).filter(
        BinanceFuture.vol_spike >= VOL_SPIKE_MIN,
    ).all()

    for f in futures:
        c15 = f.change_15m or 0
        c5  = f.change_5m  or 0
        spike = f.vol_spike or 0

        is_pump = c15 >= CHANGE_15M_PUMP and c5 >= CHANGE_5M_PUMP
        is_dump = c15 <= CHANGE_15M_DUMP and c5 <= CHANGE_5M_DUMP
        sent_move = False

        if (is_pump or is_dump) and not _cooldown_active("move", f.symbol, now):
            kind = "ПАМП 🚀" if is_pump else "ДАМП 💥"
            reasons = [
                f"{'📈' if is_pump else '📉'} 15м: {c15:+.2f}%",
                f"{'📈' if is_pump else '📉'} 5м:  {c5:+.2f}%",
                f"⚡ Спайк объёма: {spike:.1f}×",
            ]
            if f.funding_rate is not None:
                reasons.append(f"💸 Funding: {f.funding_rate*100:+.4f}%")

            msg_symbol = f"{kind}  {f.symbol}"
            try:
                if send_alert(msg_symbol, f.last_price or 0, reasons):
                    _mark_cooldown("move", f.symbol, now)
                    if spike >= VOL_SPIKE_ALERT_MIN:
                        _mark_cooldown("volume", f.symbol, now)
                    sent_move = True
                    logger.info("Signal sent: %s %s 15m=%.2f spike=%.1f",
                                kind, f.symbol, c15, spike)
            except Exception as e:
                logger.error("Signal send error %s: %s", f.symbol, e)

        if spike >= VOL_SPIKE_ALERT_MIN and not sent_move and not _cooldown_active("volume", f.symbol, now):
            reasons = [
                f"⚡ Спайк объёма: {spike:.1f}×",
                f"{'📈' if c15 >= 0 else '📉'} 15м: {c15:+.2f}%",
                f"{'📈' if c5 >= 0 else '📉'} 5м:  {c5:+.2f}%",
            ]
            if f.quote_volume_24h is not None:
                reasons.append(f"💵 Объём 24ч: ${f.quote_volume_24h:,.0f}")
            if f.funding_rate is not None:
                reasons.append(f"💸 Funding: {f.funding_rate*100:+.4f}%")

            try:
                if send_alert(f"ОБЪЁМ ⚡  {f.symbol}", f.last_price or 0, reasons):
                    _mark_cooldown("volume", f.symbol, now)
                    logger.info("Volume signal sent: %s spike=%.1f 15m=%.2f",
                                f.symbol, spike, c15)
            except Exception as e:
                logger.error("Volume signal send error %s: %s", f.symbol, e)
