from datetime import datetime

from sqlalchemy.orm import Session

from .models import SignalDailyCount


def reserve_signal_number(db: Session, symbol: str, now: datetime) -> int:
    day = now.date().isoformat()
    sym = symbol.upper()
    row = (
        db.query(SignalDailyCount)
        .filter(SignalDailyCount.symbol == sym, SignalDailyCount.day == day)
        .one_or_none()
    )
    if row is None:
        row = SignalDailyCount(symbol=sym, day=day, count=0, updated_at=now)
        db.add(row)
        db.flush()

    row.count = (row.count or 0) + 1
    row.updated_at = now
    db.flush()
    return row.count
