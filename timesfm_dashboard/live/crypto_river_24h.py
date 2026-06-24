#!/usr/bin/env python3
"""Export Crypto Predictor River 24h BTC forecast for the TimesFM dashboard."""

from __future__ import annotations

import csv
import json
import sys
from datetime import timezone
from pathlib import Path

import pandas as pd

CLAUD_ROOT = Path("/root/claud")
LIVE_ROOT = Path("/root/live")
CURRENT_PATH = LIVE_ROOT / "crypto_river_24h.json"
HISTORY_PATH = LIVE_ROOT / "crypto_river_24h_history.csv"
SYMBOL = "BTCUSDT"
HORIZON = "24h"

sys.path.insert(0, str(CLAUD_ROOT))

from data import fetch_klines  # noqa: E402
from river_model import HORIZONS_RIVER, update_river_model  # noqa: E402


def _timestamp_context() -> tuple[str, str]:
    cfg = HORIZONS_RIVER[HORIZON]
    df = fetch_klines(SYMBOL, cfg["interval"], 2)
    candle_time = pd.Timestamp(df.index[-1])
    if candle_time.tzinfo is None:
        candle_time = candle_time.tz_localize("UTC")
    else:
        candle_time = candle_time.tz_convert("UTC")

    step = pd.to_timedelta(cfg["bars"], unit="h")
    if cfg["interval"].endswith("d"):
        step = pd.to_timedelta(cfg["bars"], unit="D")
    forecast_time = candle_time + step
    return candle_time.isoformat(), forecast_time.isoformat()


def _write_history(payload: dict) -> None:
    row = {
        "generated_at": payload["generated_at"],
        "symbol": payload["symbol"],
        "horizon": payload["horizon"],
        "interval": payload["interval"],
        "last_close": payload["last_close"],
        "predicted_price": payload["predicted_price"],
        "predicted_return_pct": payload["predicted_return_pct"],
        "direction": payload["direction"],
        "confidence": payload["confidence"],
        "n_samples": payload["n_samples"],
        "mae": payload["mae"],
        "candle_time": payload["candle_time"],
        "forecast_time": payload["forecast_time"],
    }
    new_file = not HISTORY_PATH.exists()
    with HISTORY_PATH.open("a", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=list(row))
        if new_file:
            writer.writeheader()
        writer.writerow(row)


def main() -> int:
    LIVE_ROOT.mkdir(parents=True, exist_ok=True)
    result = update_river_model(SYMBOL, HORIZON)
    candle_time, forecast_time = _timestamp_context()
    generated_at = pd.Timestamp.now(tz=timezone.utc).isoformat()

    payload = {
        "generated_at": generated_at,
        "mode": "online",
        "symbol": SYMBOL,
        "interval": "1h",
        "horizon": HORIZON,
        "source": "Crypto Predictor / Binance Futures",
        "model": "Crypto Predictor River",
        "candle_time": candle_time,
        "forecast_time": forecast_time,
        "last_close": result["current_price"],
        "predicted_price": result["predicted_price"],
        "predicted_return_pct": result["predicted_return_pct"],
        "direction": result["direction"],
        "confidence": result["confidence"],
        "n_samples": result["n_samples"],
        "mae": result["mae"],
        "forecast": [{
            "timestamp": forecast_time,
            "point": result["predicted_price"],
            "river_point": result["predicted_price"],
            "predicted_return_pct": result["predicted_return_pct"],
            "direction": result["direction"],
            "confidence": result["confidence"],
            "n_samples": result["n_samples"],
            "mae": result["mae"],
        }],
    }
    CURRENT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    _write_history(payload)
    print(
        f"Crypto River {SYMBOL} {HORIZON}: "
        f"{result['current_price']:,.2f} -> {result['predicted_price']:,.2f} "
        f"({result['predicted_return_pct']:+.3f}%)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
