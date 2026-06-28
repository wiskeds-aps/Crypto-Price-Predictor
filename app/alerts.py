import logging
from datetime import datetime
from sqlalchemy.orm import Session
from .models import Alert, BinanceFuture
from .telegram import send_alert

logger = logging.getLogger(__name__)


def check_and_fire(db: Session):
    now = datetime.utcnow()
    alerts = db.query(Alert).filter(Alert.active == True).all()
    if not alerts:
        return

    symbols = {a.symbol for a in alerts}
    futures = {
        f.symbol: f
        for f in db.query(BinanceFuture).filter(BinanceFuture.symbol.in_(symbols)).all()
    }

    for alert in alerts:
        fut = futures.get(alert.symbol)
        if not fut:
            continue

        # cooldown
        if alert.last_triggered:
            elapsed = (now - alert.last_triggered).total_seconds() / 60
            if elapsed < alert.cooldown_min:
                continue

        reasons: list[str] = []
        ok = True

        def _check(val, mn, mx, label):
            nonlocal ok
            if mn is not None:
                if val is None or val < mn:
                    ok = False; return
                reasons.append(f"{label} {val:+.2f}%")
            if mx is not None:
                if val is None or val > mx:
                    ok = False; return
                if not any(label in r for r in reasons):
                    reasons.append(f"{label} {val:+.2f}%")

        if alert.min_vol_spike is not None:
            v = fut.vol_spike
            if v is None or v < alert.min_vol_spike:
                ok = False
            else:
                reasons.append(f"Спайк объёма {v:.1f}×")

        _check(fut.change_5m,  alert.min_change_5m,  alert.max_change_5m,  "5м")
        _check(fut.change_15m, alert.min_change_15m, alert.max_change_15m, "15м")

        if ok and reasons:
            try:
                if send_alert(alert.symbol, fut.last_price or 0, reasons):
                    alert.last_triggered = now
                    db.commit()
            except Exception as e:
                logger.error("Alert fire error: %s", e)
