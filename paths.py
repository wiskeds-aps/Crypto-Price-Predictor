import os
import sys


def _default_base_dir() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = os.path.abspath(os.environ.get("CRYPTO_PREDICTOR_HOME", _default_base_dir()))
COINS_DIR = os.path.join(BASE_DIR, "coins")
LEGACY_MODELS_DIR = os.path.join(BASE_DIR, "models")
MARKET_CACHE_DIR = os.path.join(BASE_DIR, "market_cache")
LIQUIDATION_COLLECTOR_LOCK = os.path.join(BASE_DIR, "liquidation_collector.lock")
LIQUIDATION_COLLECTOR_STATUS = os.path.join(BASE_DIR, "liquidation_collector_status.json")


def coin_dir(symbol: str) -> str:
    path = os.path.join(COINS_DIR, symbol)
    os.makedirs(path, exist_ok=True)
    return path


def coin_models_dir(symbol: str) -> str:
    path = os.path.join(coin_dir(symbol), "models")
    os.makedirs(path, exist_ok=True)
    return path


def coin_log_path(symbol: str) -> str:
    return os.path.join(coin_dir(symbol), "predictions_log.csv")


def coin_liquidations_path(symbol: str) -> str:
    return os.path.join(coin_dir(symbol), "liquidations.csv")


def legacy_models_dir() -> str:
    os.makedirs(LEGACY_MODELS_DIR, exist_ok=True)
    return LEGACY_MODELS_DIR


def market_cache_dir() -> str:
    os.makedirs(MARKET_CACHE_DIR, exist_ok=True)
    return MARKET_CACHE_DIR


def open_interest_cache_path() -> str:
    return os.path.join(market_cache_dir(), "open_interest.csv")


def liquidation_collector_lock_path() -> str:
    return LIQUIDATION_COLLECTOR_LOCK


def liquidation_collector_status_path() -> str:
    return LIQUIDATION_COLLECTOR_STATUS
