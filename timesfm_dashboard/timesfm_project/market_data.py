"""Binance market-data loading and normalized candle representation."""

from dataclasses import dataclass
import time

import numpy as np
from binance.spot import Spot


@dataclass
class MarketData:
    close: np.ndarray
    high: np.ndarray
    low: np.ndarray
    volume: np.ndarray
    quote_volume: np.ndarray
    trades: np.ndarray
    taker_buy_quote: np.ndarray
    last_close_ms: int


def fetch_market_data(client: Spot, symbol: str, interval: str, limit: int) -> MarketData:
    candles = client.klines(symbol.upper(), interval, limit=limit + 1)
    now_ms = int(time.time() * 1000)
    completed = [c for c in candles if int(c[6]) < now_ms]
    if len(completed) < limit:
        raise RuntimeError(f"Binance returned only {len(completed)} completed candles")
    selected = completed[-limit:]

    def column(index: int) -> np.ndarray:
        return np.asarray([float(c[index]) for c in selected], dtype=np.float64)

    return MarketData(
        close=column(4), high=column(2), low=column(3), volume=column(5),
        quote_volume=column(7), trades=column(8), taker_buy_quote=column(10),
        last_close_ms=int(selected[-1][6]),
    )
