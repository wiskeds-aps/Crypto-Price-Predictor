import logging
from datetime import datetime
from typing import Iterable

from sqlalchemy import delete, func
from sqlalchemy.orm import Session

from .models import LsRatioHistory, TopAccountLsHistory, TopPositionLsHistory

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


def _upsert_history_rows(db: Session, model, rows: list[dict], commit_every_chunk: bool = False) -> int:
    """Insert/update history rows without duplicating symbol/period/time points."""
    if not rows:
        return 0

    now = datetime.utcnow()
    values = [{**row, "updated_at": now} for row in rows]
    table = model.__table__
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
            db.query(model)
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
            db.add(model(**row))
        written += 1
        if commit_every_chunk and written % UPSERT_CHUNK_SIZE == 0:
            db.commit()
    return written


def upsert_ls_history(db: Session, rows: list[dict], commit_every_chunk: bool = False) -> int:
    return _upsert_history_rows(db, LsRatioHistory, rows, commit_every_chunk)


def upsert_top_position_history(db: Session, rows: list[dict], commit_every_chunk: bool = False) -> int:
    return _upsert_history_rows(db, TopPositionLsHistory, rows, commit_every_chunk)


def upsert_top_account_history(db: Session, rows: list[dict], commit_every_chunk: bool = False) -> int:
    return _upsert_history_rows(db, TopAccountLsHistory, rows, commit_every_chunk)


def _latest_times(db: Session, model, period: str, symbols: list[str]) -> dict[str, int]:
    if not symbols:
        return {}
    rows = (
        db.query(model.symbol, func.max(model.time_bucket))
        .filter(model.period == period)
        .filter(model.symbol.in_(symbols))
        .group_by(model.symbol)
        .all()
    )
    return {symbol: int(ts) for symbol, ts in rows if ts is not None}


def latest_ls_times(db: Session, period: str, symbols: list[str]) -> dict[str, int]:
    return _latest_times(db, LsRatioHistory, period, symbols)


def latest_top_position_times(db: Session, period: str, symbols: list[str]) -> dict[str, int]:
    return _latest_times(db, TopPositionLsHistory, period, symbols)


def latest_top_account_times(db: Session, period: str, symbols: list[str]) -> dict[str, int]:
    return _latest_times(db, TopAccountLsHistory, period, symbols)


def _query_history(db: Session, model, symbol: str, period: str, limit: int, start_time: int | None = None):
    q = (
        db.query(model)
        .filter(model.symbol == symbol.upper())
        .filter(model.period == period)
    )
    if start_time is not None:
        return (
            q.filter(model.time_bucket >= start_time)
            .order_by(model.time_bucket.asc())
            .limit(limit)
            .all()
        )

    rows = q.order_by(model.time_bucket.desc()).limit(limit).all()
    rows.reverse()
    return rows


def query_ls_history(
    db: Session,
    symbol: str,
    period: str,
    limit: int,
    start_time: int | None = None,
) -> list[LsRatioHistory]:
    return _query_history(db, LsRatioHistory, symbol, period, limit, start_time)


def query_top_position_history(
    db: Session,
    symbol: str,
    period: str,
    limit: int,
    start_time: int | None = None,
) -> list[TopPositionLsHistory]:
    return _query_history(db, TopPositionLsHistory, symbol, period, limit, start_time)


def query_top_account_history(
    db: Session,
    symbol: str,
    period: str,
    limit: int,
    start_time: int | None = None,
) -> list[TopAccountLsHistory]:
    return _query_history(db, TopAccountLsHistory, symbol, period, limit, start_time)


def ls_rows_to_api(rows: list) -> list[dict]:
    return [
        {
            "time": row.time_bucket,
            "ratio": row.ratio,
            "long_pct": row.long_pct,
            "short_pct": row.short_pct,
        }
        for row in rows
    ]


def _cleanup_history(db: Session, model, retention_days: int) -> int:
    if retention_days <= 0:
        return 0
    cutoff = int(datetime.utcnow().timestamp()) - retention_days * 24 * 60 * 60
    deleted = db.execute(
        delete(model).where(model.time_bucket < cutoff)
    ).rowcount
    return int(deleted or 0)


def cleanup_ls_history(db: Session, retention_days: int) -> int:
    return _cleanup_history(db, LsRatioHistory, retention_days)


def cleanup_top_position_history(db: Session, retention_days: int) -> int:
    return _cleanup_history(db, TopPositionLsHistory, retention_days)


def cleanup_top_account_history(db: Session, retention_days: int) -> int:
    return _cleanup_history(db, TopAccountLsHistory, retention_days)
