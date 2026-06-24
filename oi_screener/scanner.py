from __future__ import annotations

import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

import numpy as np
import pandas as pd

from binance_futures import BinanceFuturesClient

OI_PERIODS = {"5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"}


@dataclass(frozen=True)
class ScanConfig:
    interval: str = "5m"
    lookback_bars: int = 12
    spike_bars: int = 3
    max_symbols: int = 0
    min_quote_volume_24h: float = 10_000_000
    min_oi_change_pct: float = 1.5
    min_volume_ratio: float = 1.8
    min_price_move_pct: float = 0.4
    workers: int = 12


def _safe_pct(new: float, old: float) -> float:
    if old == 0 or not np.isfinite(old) or not np.isfinite(new):
        return 0.0
    return (new / old - 1.0) * 100.0


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _score_signal(price_move_pct: float, oi_change_pct: float, volume_ratio: float,
                  taker_buy_ratio: float, direction: str) -> float:
    price_score = _clamp(abs(price_move_pct) / 2.0 * 35.0)
    oi_score = _clamp(max(oi_change_pct, 0.0) / 6.0 * 35.0)
    volume_score = _clamp(math.log(max(volume_ratio, 1.0), 3.0) * 20.0)
    imbalance = taker_buy_ratio - 0.5
    aligned = imbalance if direction == "PUMP" else -imbalance
    flow_score = _clamp(max(aligned, 0.0) / 0.25 * 10.0)
    return round(price_score + oi_score + volume_score + flow_score, 2)


def _classify(price_move_pct: float, oi_change_pct: float) -> str:
    if oi_change_pct >= 0 and price_move_pct > 0:
        return "PUMP"
    if oi_change_pct >= 0 and price_move_pct < 0:
        return "DUMP"
    if oi_change_pct < 0 and price_move_pct > 0:
        return "SHORT_SQUEEZE"
    if oi_change_pct < 0 and price_move_pct < 0:
        return "LONG_SQUEEZE"
    return "FLAT"


def _scan_symbol(client: BinanceFuturesClient, symbol: str, interval: str,
                 lookback_bars: int, spike_bars: int) -> dict:
    limit = max(lookback_bars + spike_bars + 5, 30)
    candles = client.klines(symbol, interval, limit)
    if len(candles) < lookback_bars + 2:
        raise ValueError("not enough candle history")

    start = candles.iloc[-lookback_bars - 1]
    last = candles.iloc[-1]
    price_move_pct = _safe_pct(float(last["close"]), float(start["close"]))
    high_low_range_pct = _safe_pct(float(candles["high"].tail(lookback_bars).max()),
                                   float(candles["low"].tail(lookback_bars).min()))

    recent_volume = float(candles["quote_volume"].tail(spike_bars).mean())
    baseline = candles["quote_volume"].iloc[-lookback_bars - spike_bars:-spike_bars]
    baseline_volume = float(baseline.mean()) if len(baseline) else 0.0
    volume_ratio = recent_volume / baseline_volume if baseline_volume > 0 else 0.0

    recent_taker = float(candles["taker_buy_quote_volume"].tail(spike_bars).sum())
    recent_quote = float(candles["quote_volume"].tail(spike_bars).sum())
    taker_buy_ratio = recent_taker / recent_quote if recent_quote > 0 else 0.5

    oi_period = interval if interval in OI_PERIODS else "5m"
    oi = client.open_interest_history(symbol, oi_period, min(lookback_bars + 2, 500))
    if len(oi) >= 2:
        oi_col = "open_interest_quote" if "open_interest_quote" in oi.columns else "open_interest_base"
        oi = oi.dropna(subset=[oi_col])
        oi_start = float(oi[oi_col].iloc[0]) if len(oi) else 0.0
        oi_last = float(oi[oi_col].iloc[-1]) if len(oi) else 0.0
        oi_change_pct = _safe_pct(oi_last, oi_start)
    else:
        oi_start = 0.0
        oi_last = 0.0
        oi_change_pct = 0.0

    signal = _classify(price_move_pct, oi_change_pct)
    score = _score_signal(price_move_pct, oi_change_pct, volume_ratio, taker_buy_ratio, signal)

    return {
        "symbol": symbol,
        "signal": signal,
        "score": score,
        "price_move_pct": round(price_move_pct, 3),
        "oi_change_pct": round(oi_change_pct, 3),
        "volume_ratio": round(volume_ratio, 3),
        "recent_quote_volume": round(recent_quote, 2),
        "taker_buy_ratio": round(taker_buy_ratio, 3),
        "range_pct": round(high_low_range_pct, 3),
        "last_price": float(last["close"]),
        "oi_quote_now": round(oi_last, 2),
        "oi_quote_start": round(oi_start, 2),
        "last_candle_close": last["close_time"],
    }


def load_candidates(client: BinanceFuturesClient, config: ScanConfig) -> pd.DataFrame:
    symbols = client.exchange_info()
    tickers = client.ticker_24h()
    df = symbols.merge(tickers, on="symbol", how="inner")
    df = df.rename(columns={
        "lastPrice": "last_price_24h",
        "priceChangePercent": "change_pct_24h",
        "quoteVolume": "quote_volume_24h",
        "count": "trades_24h",
    })
    df = df[df["quote_volume_24h"].fillna(0) >= config.min_quote_volume_24h]
    df = df.sort_values("quote_volume_24h", ascending=False).copy()
    df["volume_rank"] = range(1, len(df) + 1)
    if config.max_symbols and config.max_symbols > 0:
        return df.head(config.max_symbols).copy()
    return df


def scan_market(config: ScanConfig | None = None,
                client: BinanceFuturesClient | None = None) -> tuple[pd.DataFrame, list[str]]:
    config = config or ScanConfig()
    client = client or BinanceFuturesClient()
    candidates = load_candidates(client, config)
    symbols = candidates["symbol"].tolist()
    rows: list[dict] = []
    errors: list[str] = []

    with ThreadPoolExecutor(max_workers=config.workers) as pool:
        futures = {
            pool.submit(
                _scan_symbol,
                client,
                symbol,
                config.interval,
                config.lookback_bars,
                config.spike_bars,
            ): symbol for symbol in symbols
        }
        for future in as_completed(futures):
            symbol = futures[future]
            try:
                rows.append(future.result())
            except Exception as error:
                errors.append(f"{symbol}: {error}")

    result = pd.DataFrame(rows)
    if result.empty:
        return result, errors

    result = result.merge(
        candidates[["symbol", "base_asset", "quote_volume_24h", "change_pct_24h", "trades_24h", "volume_rank"]],
        on="symbol",
        how="left",
    )
    result["is_core_signal"] = (
        result["signal"].isin(["PUMP", "DUMP"])
        & (result["oi_change_pct"] >= config.min_oi_change_pct)
        & (result["volume_ratio"] >= config.min_volume_ratio)
        & (result["price_move_pct"].abs() >= config.min_price_move_pct)
    )
    result = result.sort_values(
        ["is_core_signal", "score", "oi_change_pct", "volume_ratio"],
        ascending=[False, False, False, False],
    )
    return result.reset_index(drop=True), errors


def symbol_history(symbol: str, interval: str = "5m", limit: int = 120,
                   client: BinanceFuturesClient | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    client = client or BinanceFuturesClient()
    candles = client.klines(symbol, interval, limit)
    oi_period = interval if interval in OI_PERIODS else "5m"
    oi = client.open_interest_history(symbol, oi_period, min(limit, 500))
    return candles, oi
