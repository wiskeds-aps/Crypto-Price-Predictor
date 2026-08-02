import logging
from datetime import datetime
from typing import Iterable

from sqlalchemy import delete, func
from sqlalchemy.orm import Session

from .models import OpenInterestHistory

logger = logging.getLogger(__name__)

VALID_OI_PERIODS = {"5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"}
UPSERT_CHUNK_SIZE = 500


def _to_float(value) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_oi_points(symbol: str, period: str, payload: Iterable[dict]) -> list[dict]:
    """Convert Binance openInterestHist rows into DB-ready dictionaries."""
    sym = symbol.upper()
    if period not in VALID_OI_PERIODS:
        raise ValueError(f"Invalid OI period: {period}")

    by_key: dict[tuple[str, str, int], dict] = {}
    for item in payload:
        try:
            ts = int(item["timestamp"]) // 1000
        except (KeyError, TypeError, ValueError):
            continue

        oi = _to_float(item.get("sumOpenInterest"))
        if oi is None:
            continue

        value = _to_float(item.get("sumOpenInterestValue"))
        key = (sym, period, ts)
        by_key[key] = {
            "symbol": sym,
            "period": period,
            "time_bucket": ts,
            "sum_open_interest": oi,
            "sum_open_interest_value": value,
        }
    return list(by_key.values())


def upsert_oi_history(db: Session, rows: list[dict], commit_every_chunk: bool = False) -> int:
    """Insert/update OI history rows without duplicating symbol/period/time points."""
    if not rows:
        return 0

    now = datetime.utcnow()
    values = [{**row, "updated_at": now} for row in rows]
    table = OpenInterestHistory.__table__
    dialect = db.bind.dialect.name if db.bind is not None else ""

    if dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert

        for start in range(0, len(values), UPSERT_CHUNK_SIZE):
            chunk = values[start:start + UPSERT_CHUNK_SIZE]
            stmt = sqlite_insert(table).values(chunk)
            stmt = stmt.on_conflict_do_update(
                index_elements=["symbol", "period", "time_bucket"],
                set_={
                    "sum_open_interest": stmt.excluded.sum_open_interest,
                    "sum_open_interest_value": stmt.excluded.sum_open_interest_value,
                    "updated_at": stmt.excluded.updated_at,
                },
            )
            db.execute(stmt)
            if commit_every_chunk:
                db.commit()
        return len(values)

    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        for start in range(0, len(values), UPSERT_CHUNK_SIZE):
            chunk = values[start:start + UPSERT_CHUNK_SIZE]
            stmt = pg_insert(table).values(chunk)
            stmt = stmt.on_conflict_do_update(
                index_elements=["symbol", "period", "time_bucket"],
                set_={
                    "sum_open_interest": stmt.excluded.sum_open_interest,
                    "sum_open_interest_value": stmt.excluded.sum_open_interest_value,
                    "updated_at": stmt.excluded.updated_at,
                },
            )
            db.execute(stmt)
            if commit_every_chunk:
                db.commit()
        return len(values)

    # Conservative fallback for other SQLAlchemy backends.
    written = 0
    for row in values:
        existing = (
            db.query(OpenInterestHistory)
            .filter_by(
                symbol=row["symbol"],
                period=row["period"],
                time_bucket=row["time_bucket"],
            )
            .first()
        )
        if existing:
            existing.sum_open_interest = row["sum_open_interest"]
            existing.sum_open_interest_value = row["sum_open_interest_value"]
            existing.updated_at = row["updated_at"]
        else:
            db.add(OpenInterestHistory(**row))
        written += 1
        if commit_every_chunk and written % UPSERT_CHUNK_SIZE == 0:
            db.commit()
    return written


def latest_oi_times(db: Session, period: str, symbols: list[str]) -> dict[str, int]:
    if not symbols:
        return {}
    rows = (
        db.query(OpenInterestHistory.symbol, func.max(OpenInterestHistory.time_bucket))
        .filter(OpenInterestHistory.period == period)
        .filter(OpenInterestHistory.symbol.in_(symbols))
        .group_by(OpenInterestHistory.symbol)
        .all()
    )
    return {symbol: int(ts) for symbol, ts in rows if ts is not None}


def query_oi_history(
    db: Session,
    symbol: str,
    period: str,
    limit: int,
    start_time: int | None = None,
) -> list[OpenInterestHistory]:
    q = (
        db.query(OpenInterestHistory)
        .filter(OpenInterestHistory.symbol == symbol.upper())
        .filter(OpenInterestHistory.period == period)
    )
    if start_time is not None:
        return (
            q.filter(OpenInterestHistory.time_bucket >= start_time)
            .order_by(OpenInterestHistory.time_bucket.asc())
            .limit(limit)
            .all()
        )

    rows = q.order_by(OpenInterestHistory.time_bucket.desc()).limit(limit).all()
    rows.reverse()
    return rows


def oi_rows_to_api(rows: list[OpenInterestHistory]) -> list[dict]:
    return [
        {
            "time": row.time_bucket,
            "value": row.sum_open_interest_value,
            "oi": row.sum_open_interest,
            "source": "db",
        }
        for row in rows
    ]


def cleanup_oi_history(db: Session, retention_days: int) -> int:
    if retention_days <= 0:
        return 0
    cutoff = int(datetime.utcnow().timestamp()) - retention_days * 24 * 60 * 60
    deleted = db.execute(
        delete(OpenInterestHistory).where(OpenInterestHistory.time_bucket < cutoff)
    ).rowcount
    return int(deleted or 0)
