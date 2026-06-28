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
CHANGE_15M_PUMP =  1.5  # % gain in 15 min
CHANGE_15M_DUMP = -1.5  # % loss in 15 min
CHANGE_5M_PUMP  =  0.8  # extra 5m filter to catch fast moves
CHANGE_5M_DUMP  = -0.8

COOLDOWN_MIN = 30  # minutes before re-alerting same symbol

# in-memory cooldown: symbol → last sent datetime
_cooldowns: dict[str, datetime] = {}


def check_signals(db: Session):
    now = datetime.utcnow()
    futures = db.query(BinanceFuture).filter(
        BinanceFuture.vol_spike >= VOL_SPIKE_MIN,
        BinanceFuture.change_15m != None,
    ).all()

    for f in futures:
        # cooldown check
        last = _cooldowns.get(f.symbol)
        if last and (now - last) < timedelta(minutes=COOLDOWN_MIN):
            continue

        c15 = f.change_15m or 0
        c5  = f.change_5m  or 0
        spike = f.vol_spike or 0

        is_pump = c15 >= CHANGE_15M_PUMP and c5 >= CHANGE_5M_PUMP
        is_dump = c15 <= CHANGE_15M_DUMP and c5 <= CHANGE_5M_DUMP

        if not (is_pump or is_dump):
            continue

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
                _cooldowns[f.symbol] = now
                logger.info("Signal sent: %s %s 15m=%.2f spike=%.1f",
                            kind, f.symbol, c15, spike)
        except Exception as e:
            logger.error("Signal send error %s: %s", f.symbol, e)
