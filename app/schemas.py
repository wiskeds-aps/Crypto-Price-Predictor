from datetime import datetime
from pydantic import BaseModel


class CoinOut(BaseModel):
    id: str
    symbol: str
    name: str
    image: str | None
    rank: int
    price_usd: float | None
    market_cap: float | None
    volume_24h: float | None
    change_1h: float | None
    change_24h: float | None
    change_7d: float | None
    ath: float | None
    ath_change_pct: float | None
    circulating_supply: float | None
    total_supply: float | None
    updated_at: datetime

    model_config = {"from_attributes": True}


class ScreenerResponse(BaseModel):
    coins: list[CoinOut]
    total: int
    last_updated: datetime | None


class FutureOut(BaseModel):
    symbol: str
    base_asset: str
    quote_asset: str
    last_price: float | None
    price_change: float | None
    price_change_pct: float | None
    high_24h: float | None
    low_24h: float | None
    volume_24h: float | None
    quote_volume_24h: float | None
    mark_price: float | None
    index_price: float | None
    funding_rate: float | None
    next_funding_time: int | None
    trades_count: int | None
    cg_rank: int | None
    change_5m:  float | None
    change_15m: float | None
    change_30m: float | None
    change_1h:  float | None
    vol_spike: float | None
    ls_account_ratio: float | None
    ls_long_pct:      float | None
    ls_short_pct:     float | None
    ls_taker_ratio:   float | None
    ls_top_account:   float | None
    ls_top_position:  float | None
    ls_top_long_pct:  float | None
    ls_top_short_pct: float | None
    oi_value:      float | None
    oi_usd:        float | None
    oi_change_5m:  float | None
    oi_change_30m: float | None
    oi_change_1h:  float | None
    oi_change_24h: float | None
    cvd_1h:        float | None
    updated_at: datetime

    model_config = {"from_attributes": True}


class FuturesResponse(BaseModel):
    futures: list[FutureOut]
    total: int
    last_updated: datetime | None
