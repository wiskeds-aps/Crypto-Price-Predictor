import logging
from datetime import datetime
from typing import Iterable

from sqlalchemy import delete, func
from sqlalchemy.orm import Session

from .models import LsRatioHistory

logger = logging.getLogger(__name__)

VALID_LS_PERIODS = {"5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"}
UPSERT_CHUNK_SIZE = 500


def _to_float(value) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_ls_points(symbol: str, period: str, payload: Iterable[dict]) -> list[dict]:
    """Convert Binance globalLongShortAccountRatio rows into DB-ready dictionaries."""
    sym = symbol.upper()
    if period not in VALID_LS_PERIODS:
        raise ValueError(f"Invalid L/S period: {period}")

    by_key: dict[tuple[str, str, int], dict] = {}
    for item in payload:
        try:
            ts = int(item["timestamp"]) // 1000
        except (KeyError, TypeError, ValueError):
            continue

        long_acc = _to_float(item.get("longAccount"))
        short_acc = _to_float(item.get("shortAccount"))
        if long_acc is None or short_acc is None:
            continue

        ratio = _to_float(item.get("longShortRatio"))
        key = (sym, period, ts)
        by_key[key] = {
            "symbol": sym,
            "period": period,
            "time_bucket": ts,
            "long_pct": round(long_acc * 100, 2),
            "short_pct": round(short_acc * 100, 2),
            "ratio": ratio,
        }
    return list(by_key.values())


def upsert_ls_history(db: Session, rows: list[dict], commit_every_chunk: bool = False) -> int:
    """Insert/update L/S ratio history rows without duplicating symbol/period/time points."""
    if not rows:
        return 0

    now = datetime.utcnow()
    values = [{**row, "updated_at": now} for row in rows]
    table = LsRatioHistory.__table__
    dialect = db.bind.dialect.name if db.bind is not None else ""

    if dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert

        for start in range(0, len(values), UPSERT_CHUNK_SIZE):
            chunk = values[start:start + UPSERT_CHUNK_SIZE]
            stmt = sqlite_insert(table).values(chunk)
            stmt = stmt.on_conflict_do_update(
                index_elements=["symbol", "period", "time_bucket"],
                set_={
                    "long_pct": stmt.excluded.long_pct,
                    "short_pct": stmt.excluded.short_pct,
                    "ratio": stmt.excluded.ratio,
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
                    "long_pct": stmt.excluded.long_pct,
                    "short_pct": stmt.excluded.short_pct,
                    "ratio": stmt.excluded.ratio,
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
            db.query(LsRatioHistory)
            .filter_by(
                symbol=row["symbol"],
                period=row["period"],
                time_bucket=row["time_bucket"],
            )
            .first()
        )
        if existing:
            existing.long_pct = row["long_pct"]
            existing.short_pct = row["short_pct"]
            existing.ratio = row["ratio"]
            existing.updated_at = row["updated_at"]
        else:
            db.add(LsRatioHistory(**row))
        written += 1
        if commit_every_chunk and written % UPSERT_CHUNK_SIZE == 0:
            db.commit()
    return written


def latest_ls_times(db: Session, period: str, symbols: list[str]) -> dict[str, int]:
    if not symbols:
        return {}
    rows = (
        db.query(LsRatioHistory.symbol, func.max(LsRatioHistory.time_bucket))
        .filter(LsRatioHistory.period == period)
        .filter(LsRatioHistory.symbol.in_(symbols))
        .group_by(LsRatioHistory.symbol)
        .all()
    )
    return {symbol: int(ts) for symbol, ts in rows if ts is not None}


def query_ls_history(
    db: Session,
    symbol: str,
    period: str,
    limit: int,
    start_time: int | None = None,
) -> list[LsRatioHistory]:
    q = (
        db.query(LsRatioHistory)
        .filter(LsRatioHistory.symbol == symbol.upper())
        .filter(LsRatioHistory.period == period)
    )
    if start_time is not None:
        return (
            q.filter(LsRatioHistory.time_bucket >= start_time)
            .order_by(LsRatioHistory.time_bucket.asc())
            .limit(limit)
            .all()
        )

    rows = q.order_by(LsRatioHistory.time_bucket.desc()).limit(limit).all()
    rows.reverse()
    return rows


def ls_rows_to_api(rows: list[LsRatioHistory]) -> list[dict]:
    return [
        {
            "time": row.time_bucket,
            "ratio": row.ratio,
            "long_pct": row.long_pct,
            "short_pct": row.short_pct,
        }
        for row in rows
    ]


def cleanup_ls_history(db: Session, retention_days: int) -> int:
    if retention_days <= 0:
        return 0
    cutoff = int(datetime.utcnow().timestamp()) - retention_days * 24 * 60 * 60
    deleted = db.execute(
        delete(LsRatioHistory).where(LsRatioHistory.time_bucket < cutoff)
    ).rowcount
    return int(deleted or 0)
