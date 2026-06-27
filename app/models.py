from datetime import datetime
from sqlalchemy import Boolean, Float, Integer, String, DateTime, BigInteger
from sqlalchemy.orm import Mapped, mapped_column
from .database import Base


class FutureSnapshot(Base):
    """One row per symbol per minute — used to compute short-term deltas."""
    __tablename__ = "future_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String, index=True)
    price: Mapped[float] = mapped_column(Float)
    quote_volume_24h: Mapped[float] = mapped_column(Float)
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)


class BinanceFuture(Base):
    __tablename__ = "binance_futures"

    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    base_asset: Mapped[str] = mapped_column(String, index=True)
    quote_asset: Mapped[str] = mapped_column(String)
    last_price: Mapped[float] = mapped_column(Float, nullable=True)
    price_change: Mapped[float] = mapped_column(Float, nullable=True)
    price_change_pct: Mapped[float] = mapped_column(Float, nullable=True)
    high_24h: Mapped[float] = mapped_column(Float, nullable=True)
    low_24h: Mapped[float] = mapped_column(Float, nullable=True)
    volume_24h: Mapped[float] = mapped_column(Float, nullable=True)
    quote_volume_24h: Mapped[float] = mapped_column(Float, nullable=True)
    mark_price: Mapped[float] = mapped_column(Float, nullable=True)
    index_price: Mapped[float] = mapped_column(Float, nullable=True)
    funding_rate: Mapped[float] = mapped_column(Float, nullable=True)
    next_funding_time: Mapped[int] = mapped_column(BigInteger, nullable=True)
    trades_count: Mapped[int] = mapped_column(Integer, nullable=True)
    cg_rank: Mapped[int] = mapped_column(Integer, nullable=True, index=True)
    # short-term metrics computed from snapshots
    change_5m:  Mapped[float] = mapped_column(Float, nullable=True)
    change_15m: Mapped[float] = mapped_column(Float, nullable=True)
    change_30m: Mapped[float] = mapped_column(Float, nullable=True)
    change_1h:  Mapped[float] = mapped_column(Float, nullable=True)
    vol_spike: Mapped[float] = mapped_column(Float, nullable=True)
    # long/short ratios (updated every 10 min via separate job)
    ls_account_ratio: Mapped[float] = mapped_column(Float, nullable=True)
    ls_long_pct:      Mapped[float] = mapped_column(Float, nullable=True)  # % of accounts long
    ls_short_pct:     Mapped[float] = mapped_column(Float, nullable=True)  # % of accounts short
    ls_taker_ratio:   Mapped[float] = mapped_column(Float, nullable=True)
    ls_top_account:    Mapped[float] = mapped_column(Float, nullable=True)
    ls_ta_long_pct:    Mapped[float] = mapped_column(Float, nullable=True)
    ls_ta_short_pct:   Mapped[float] = mapped_column(Float, nullable=True)
    ls_top_position:   Mapped[float] = mapped_column(Float, nullable=True)
    ls_top_long_pct:   Mapped[float] = mapped_column(Float, nullable=True)
    ls_top_short_pct:  Mapped[float] = mapped_column(Float, nullable=True)
    # open interest (updated every 10 min)
    oi_value:      Mapped[float] = mapped_column(Float, nullable=True)  # in coins
    oi_usd:        Mapped[float] = mapped_column(Float, nullable=True)  # in USD
    oi_change_5m:  Mapped[float] = mapped_column(Float, nullable=True)
    oi_change_30m: Mapped[float] = mapped_column(Float, nullable=True)
    oi_change_1h:  Mapped[float] = mapped_column(Float, nullable=True)
    oi_change_24h: Mapped[float] = mapped_column(Float, nullable=True)
    # CVD 1h — net buy/sell volume delta over last hour (in USDT)
    cvd_1h:        Mapped[float] = mapped_column(Float, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String, index=True)
    min_vol_spike: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_change_5m: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_change_5m: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_change_15m: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_change_15m: Mapped[float | None] = mapped_column(Float, nullable=True)
    cooldown_min: Mapped[int] = mapped_column(Integer, default=30)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_triggered: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Coin(Base):
    __tablename__ = "coins"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    symbol: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str] = mapped_column(String)
    image: Mapped[str] = mapped_column(String, nullable=True)
    rank: Mapped[int] = mapped_column(Integer)
    price_usd: Mapped[float] = mapped_column(Float, nullable=True)
    market_cap: Mapped[float] = mapped_column(Float, nullable=True)
    volume_24h: Mapped[float] = mapped_column(Float, nullable=True)
    change_1h: Mapped[float] = mapped_column(Float, nullable=True)
    change_24h: Mapped[float] = mapped_column(Float, nullable=True)
    change_7d: Mapped[float] = mapped_column(Float, nullable=True)
    ath: Mapped[float] = mapped_column(Float, nullable=True)
    ath_change_pct: Mapped[float] = mapped_column(Float, nullable=True)
    circulating_supply: Mapped[float] = mapped_column(Float, nullable=True)
    total_supply: Mapped[float] = mapped_column(Float, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
