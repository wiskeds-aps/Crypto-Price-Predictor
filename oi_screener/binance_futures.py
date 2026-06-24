from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from typing import Any

import pandas as pd
import requests

FUTURES_BASE = "https://fapi.binance.com"

# Global rate limiter. Keep it configurable so the screener can trade speed
# for caution without code changes.
_rl_lock = threading.Lock()
_rl_last = [0.0]
_rl_min_interval = float(os.environ.get("BINANCE_MIN_REQUEST_INTERVAL", "0"))


def _rate_limited_get(url: str, params: Any, timeout: int) -> requests.Response:
    if _rl_min_interval > 0:
        with _rl_lock:
            wait = _rl_min_interval - (time.time() - _rl_last[0])
            if wait > 0:
                time.sleep(wait)
            _rl_last[0] = time.time()
    return requests.get(url, params=params, timeout=timeout)


@dataclass(frozen=True)
class BinanceFuturesClient:
    timeout: int = 15
    retries: int = 2
    pause: float = 0.5

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = f"{FUTURES_BASE}{path}"
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                response = _rate_limited_get(url, params, self.timeout)
                if response.status_code == 418:
                    data = response.json()
                    raise RuntimeError(
                        f"IP заблокирован Binance. {data.get('msg', '')}"
                    )
                if response.status_code == 429:
                    retry_after = int(response.headers.get("Retry-After", 60))
                    time.sleep(retry_after)
                    raise RuntimeError(
                        f"Rate limit (429). Подождите {retry_after}с."
                    )
                response.raise_for_status()
                return response.json()
            except RuntimeError:
                raise
            except Exception as error:
                last_error = error
                if attempt < self.retries:
                    time.sleep(self.pause * (attempt + 1))
        raise RuntimeError(f"Ошибка запроса Binance: {path}: {last_error}")

    def exchange_info(self) -> pd.DataFrame:
        payload = self._get("/fapi/v1/exchangeInfo")
        rows = []
        for item in payload.get("symbols", []):
            if item.get("status") != "TRADING":
                continue
            if item.get("quoteAsset") != "USDT":
                continue
            if item.get("contractType") != "PERPETUAL":
                continue
            rows.append({
                "symbol": item["symbol"],
                "base_asset": item.get("baseAsset"),
                "quote_asset": item.get("quoteAsset"),
                "onboard_date": item.get("onboardDate"),
            })
        return pd.DataFrame(rows)

    def ticker_24h(self) -> pd.DataFrame:
        df = pd.DataFrame(self._get("/fapi/v1/ticker/24hr"))
        numeric_cols = [
            "lastPrice", "priceChangePercent", "quoteVolume", "volume",
            "count", "highPrice", "lowPrice",
        ]
        for col in numeric_cols:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")
        return df

    def klines(self, symbol: str, interval: str, limit: int) -> pd.DataFrame:
        raw = self._get(
            "/fapi/v1/klines",
            {"symbol": symbol.upper(), "interval": interval, "limit": limit},
        )
        df = pd.DataFrame(raw, columns=[
            "open_time", "open", "high", "low", "close", "volume",
            "close_time", "quote_volume", "trades", "taker_buy_volume",
            "taker_buy_quote_volume", "ignore",
        ])
        if df.empty:
            return df
        df["open_time"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
        df["close_time"] = pd.to_datetime(df["close_time"], unit="ms", utc=True)
        for col in ["open", "high", "low", "close", "volume", "quote_volume",
                    "trades", "taker_buy_volume", "taker_buy_quote_volume"]:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        return df.dropna(subset=["open", "high", "low", "close", "quote_volume"])

    def open_interest_history(self, symbol: str, period: str, limit: int) -> pd.DataFrame:
        raw = self._get(
            "/futures/data/openInterestHist",
            {"symbol": symbol.upper(), "period": period, "limit": limit},
        )
        df = pd.DataFrame(raw)
        if df.empty:
            return df
        df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
        df.rename(columns={
            "sumOpenInterest": "open_interest_base",
            "sumOpenInterestValue": "open_interest_quote",
        }, inplace=True)
        for col in ["open_interest_base", "open_interest_quote"]:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")
        return df
