import os
import threading
import time
import requests
import pandas as pd
from concurrent.futures import ThreadPoolExecutor
from liquidations import liquidation_bars, liquidation_quote_map
from paths import open_interest_cache_path

BINANCE_BASE = "https://api.binance.com"
FUTURES_BASE = "https://fapi.binance.com"

INTERVALS = {
    "1h": "1h",
    "24h": "1h",   # hourly data, predict 24 bars ahead
    "7d": "1d",    # daily data, predict 7 bars ahead
}

COINS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT"]
OI_CACHE_TTL_SECONDS = int(os.environ.get("OI_CACHE_TTL_SECONDS", "900"))
OI_SYNC_BOOTSTRAP_LIMIT = int(os.environ.get("OI_SYNC_BOOTSTRAP_LIMIT", "0"))
OI_MAX_WORKERS = int(os.environ.get("OI_MAX_WORKERS", "32"))
_oi_refresh_lock = threading.Lock()


def fetch_futures_symbols() -> pd.DataFrame:
    url = f"{FUTURES_BASE}/fapi/v1/exchangeInfo"
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    rows = []
    for item in resp.json()["symbols"]:
        if item.get("status") != "TRADING":
            continue
        rows.append({
            "symbol": item["symbol"],
            "base_asset": item["baseAsset"],
            "quote_asset": item["quoteAsset"],
            "contract_type": item.get("contractType"),
            "onboard_date": item.get("onboardDate"),
        })
    return pd.DataFrame(rows)


def fetch_futures_24h_tickers() -> pd.DataFrame:
    url = f"{FUTURES_BASE}/fapi/v1/ticker/24hr"
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    df = pd.DataFrame(resp.json())
    numeric_cols = [
        "lastPrice", "priceChangePercent", "quoteVolume", "volume",
        "count", "highPrice", "lowPrice",
    ]
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def fetch_funding_rates() -> pd.DataFrame:
    url = f"{FUTURES_BASE}/fapi/v1/premiumIndex"
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    df = pd.DataFrame(resp.json())
    for col in ["markPrice", "indexPrice", "lastFundingRate", "nextFundingTime"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def fetch_open_interest(symbol: str) -> float | None:
    url = f"{FUTURES_BASE}/fapi/v1/openInterest"
    try:
        resp = requests.get(url, params={"symbol": symbol}, timeout=3)
        resp.raise_for_status()
        return float(resp.json()["openInterest"])
    except Exception:
        return None


def _load_oi_cache() -> pd.DataFrame:
    path = open_interest_cache_path()
    if not os.path.exists(path):
        return pd.DataFrame(columns=["symbol", "open_interest_base", "fetched_at"])
    try:
        cache = pd.read_csv(path)
    except Exception:
        return pd.DataFrame(columns=["symbol", "open_interest_base", "fetched_at"])
    for col in ["symbol", "open_interest_base", "fetched_at"]:
        if col not in cache.columns:
            cache[col] = pd.NA
    cache["open_interest_base"] = pd.to_numeric(cache["open_interest_base"], errors="coerce")
    cache["fetched_at"] = pd.to_numeric(cache["fetched_at"], errors="coerce")
    return cache.dropna(subset=["symbol"])[["symbol", "open_interest_base", "fetched_at"]]


def _save_oi_cache(cache: pd.DataFrame) -> None:
    path = open_interest_cache_path()
    tmp_path = f"{path}.tmp"
    cache = cache[["symbol", "open_interest_base", "fetched_at"]].drop_duplicates("symbol", keep="last")
    cache.to_csv(tmp_path, index=False)
    os.replace(tmp_path, path)


def _fetch_oi_rows(symbols: list[str]) -> pd.DataFrame:
    symbols = list(dict.fromkeys([s for s in symbols if s]))
    if not symbols:
        return pd.DataFrame(columns=["symbol", "open_interest_base", "fetched_at"])
    with ThreadPoolExecutor(max_workers=OI_MAX_WORKERS) as executor:
        values = list(executor.map(fetch_open_interest, symbols))
    return pd.DataFrame({
        "symbol": symbols,
        "open_interest_base": values,
        "fetched_at": time.time(),
    })


def _merge_oi_cache(existing: pd.DataFrame, fresh: pd.DataFrame) -> pd.DataFrame:
    if existing.empty:
        merged = fresh
    elif fresh.empty:
        merged = existing
    else:
        merged = pd.concat([existing, fresh], ignore_index=True)
    return merged.drop_duplicates("symbol", keep="last")


def _refresh_oi_cache(symbols: list[str]) -> None:
    existing = _load_oi_cache()
    fresh = _fetch_oi_rows(symbols)
    _save_oi_cache(_merge_oi_cache(existing, fresh))


def _refresh_oi_cache_background(symbols: list[str]) -> None:
    if not _oi_refresh_lock.acquire(blocking=False):
        return

    def worker() -> None:
        try:
            _refresh_oi_cache(symbols)
        finally:
            _oi_refresh_lock.release()

    threading.Thread(target=worker, name="oi-cache-refresh", daemon=True).start()


def _oi_cache_needs_refresh(cache: pd.DataFrame, symbols: list[str]) -> bool:
    if cache.empty:
        return True
    now = time.time()
    cached_symbols = set(cache["symbol"].dropna().tolist())
    if any(symbol not in cached_symbols for symbol in symbols):
        return True
    fetched_at = pd.to_numeric(cache["fetched_at"], errors="coerce")
    return bool(fetched_at.dropna().empty or (now - fetched_at.min()) > OI_CACHE_TTL_SECONDS)


def fetch_market_screener() -> pd.DataFrame:
    symbols = fetch_futures_symbols()
    tickers = fetch_futures_24h_tickers()
    funding = fetch_funding_rates()
    df = symbols.merge(tickers, on="symbol", how="inner")
    df = df.merge(
        funding[["symbol", "markPrice", "indexPrice", "lastFundingRate"]],
        on="symbol",
        how="left",
    )
    df.rename(columns={
        "lastPrice": "last_price",
        "priceChangePercent": "change_pct_24h",
        "quoteVolume": "quote_volume_24h",
        "volume": "base_volume_24h",
        "count": "trades_24h",
        "markPrice": "mark_price",
        "indexPrice": "index_price",
        "lastFundingRate": "funding_rate",
    }, inplace=True)
    low_for_range = df["lowPrice"].replace(0, pd.NA)
    df["volatility_pct_24h"] = ((df["highPrice"] / low_for_range) - 1) * 100
    oi_symbols = df["symbol"].dropna().unique().tolist()
    oi_cache = _load_oi_cache()
    oi_refresh_symbols = None
    if oi_cache.empty:
        if OI_SYNC_BOOTSTRAP_LIMIT > 0:
            bootstrap_symbols = df.sort_values("quote_volume_24h", ascending=False)["symbol"].head(OI_SYNC_BOOTSTRAP_LIMIT).tolist()
            oi_cache = _merge_oi_cache(oi_cache, _fetch_oi_rows(bootstrap_symbols))
            _save_oi_cache(oi_cache)
        oi_refresh_symbols = oi_symbols
    elif _oi_cache_needs_refresh(oi_cache, oi_symbols):
        oi_refresh_symbols = oi_symbols

    oi_map = oi_cache.set_index("symbol")["open_interest_base"].to_dict()
    df["open_interest_base"] = df["symbol"].map(oi_map)
    price_for_oi = df["mark_price"].fillna(df["last_price"])
    df["open_interest_quote"] = df["open_interest_base"] * price_for_oi
    df["funding_rate_pct"] = df["funding_rate"] * 100
    df["liquidations_quote_24h"] = df["symbol"].map(liquidation_quote_map(oi_symbols, hours=24))
    keep = [
        "symbol", "base_asset", "quote_asset", "contract_type", "last_price", "mark_price",
        "change_pct_24h", "quote_volume_24h", "base_volume_24h", "trades_24h",
        "volatility_pct_24h", "open_interest_base", "open_interest_quote",
        "funding_rate_pct", "liquidations_quote_24h", "onboard_date", "highPrice", "lowPrice",
    ]
    result = df[[c for c in keep if c in df.columns]].sort_values("quote_volume_24h", ascending=False)
    if oi_refresh_symbols:
        _refresh_oi_cache_background(oi_refresh_symbols)
    return result


def fetch_klines(symbol: str, interval: str, limit: int = 1000) -> pd.DataFrame:
    url = f"{FUTURES_BASE}/fapi/v1/klines"
    params = {"symbol": symbol, "interval": interval, "limit": limit}
    resp = requests.get(url, params=params, timeout=15)
    resp.raise_for_status()
    raw = resp.json()
    df = pd.DataFrame(raw, columns=[
        "open_time", "open", "high", "low", "close", "volume",
        "close_time", "quote_volume", "trades",
        "taker_buy_volume", "taker_buy_quote_volume", "ignore"
    ])
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df[["open_time", "open", "high", "low", "close", "volume"]].copy()
    df.dropna(subset=["open", "high", "low", "close", "volume"], inplace=True)
    df.set_index("open_time", inplace=True)
    return df


def fetch_futures_klines_raw(symbol: str, interval: str, limit: int = 500) -> pd.DataFrame:
    url = f"{FUTURES_BASE}/fapi/v1/klines"
    params = {"symbol": symbol, "interval": interval, "limit": limit}
    resp = requests.get(url, params=params, timeout=15)
    resp.raise_for_status()
    raw = resp.json()
    df = pd.DataFrame(raw, columns=[
        "open_time", "open", "high", "low", "close", "volume",
        "close_time", "quote_volume", "trades",
        "taker_buy_volume", "taker_buy_quote_volume", "ignore"
    ])
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
    for col in [
        "open", "high", "low", "close", "volume", "quote_volume",
        "taker_buy_volume", "taker_buy_quote_volume",
    ]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df.dropna(subset=["volume", "quote_volume", "taker_buy_volume", "taker_buy_quote_volume"], inplace=True)
    df.set_index("open_time", inplace=True)
    return df


def fetch_open_interest_history(symbol: str, period: str, limit: int = 500) -> pd.DataFrame:
    url = f"{FUTURES_BASE}/futures/data/openInterestHist"
    params = {"symbol": symbol, "period": period, "limit": limit}
    resp = requests.get(url, params=params, timeout=15)
    resp.raise_for_status()
    df = pd.DataFrame(resp.json())
    if df.empty:
        return pd.DataFrame(columns=["open_interest", "open_interest_value"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
    df["open_interest"] = pd.to_numeric(df["sumOpenInterest"], errors="coerce")
    df["open_interest_value"] = pd.to_numeric(df["sumOpenInterestValue"], errors="coerce")
    return df.set_index("timestamp")[["open_interest", "open_interest_value"]]


def fetch_chart_indicators(symbol: str, interval: str, limit: int = 200) -> pd.DataFrame:
    raw = fetch_futures_klines_raw(symbol, interval, limit)
    taker_sell_volume = raw["volume"] - raw["taker_buy_volume"]
    taker_sell_quote_volume = raw["quote_volume"] - raw["taker_buy_quote_volume"]
    raw["cvd"] = (raw["taker_buy_volume"] - taker_sell_volume).cumsum()
    raw["cvd_quote"] = (raw["taker_buy_quote_volume"] - taker_sell_quote_volume).cumsum()

    period = "1d" if interval == "1d" else "1h"
    try:
        oi = fetch_open_interest_history(symbol, period, limit)
    except Exception:
        oi = pd.DataFrame(columns=["open_interest", "open_interest_value"])

    indicators = raw[["cvd", "cvd_quote"]].copy()
    indicators = indicators.join(liquidation_bars(symbol, interval, indicators.index), how="left")
    indicators[[
        "liquidations_quote",
        "long_liquidations_quote",
        "short_liquidations_quote",
    ]] = indicators[[
        "liquidations_quote",
        "long_liquidations_quote",
        "short_liquidations_quote",
    ]].fillna(0.0)
    if not oi.empty:
        indicators = indicators.join(oi, how="left")
        indicators[["open_interest", "open_interest_value"]] = (
            indicators[["open_interest", "open_interest_value"]].ffill().bfill()
        )
    else:
        indicators["open_interest"] = pd.NA
        indicators["open_interest_value"] = pd.NA
    return indicators


def get_current_price(symbol: str) -> float:
    url = f"{FUTURES_BASE}/fapi/v1/ticker/price"
    resp = requests.get(url, params={"symbol": symbol}, timeout=10)
    resp.raise_for_status()
    return float(resp.json()["price"])
