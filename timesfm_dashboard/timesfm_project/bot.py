#!/usr/bin/env python3
"""BTC price forecasting CLI using Binance market data and TimesFM."""

from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from binance.spot import Spot

import factor_model
import timesfm_model
from market_data import MarketData, fetch_market_data

MODEL_ID = timesfm_model.DEFAULT_MODEL_ID
INTERVAL_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600,
    "8h": 28800, "12h": 43200, "1d": 86400,
}
INTERVAL_LABELS = {
    "1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min",
    "30m": "30min", "1h": "1hour", "2h": "2hours", "4h": "4hours",
    "6h": "6hours", "8h": "8hours", "12h": "12hours", "1d": "1day",
}


@dataclass
class ForecastRow:
    timestamp: str
    point: float
    q10: float
    q50: float
    q90: float
    timesfm_point: float
    xreg_point: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Forecast BTC price with TimesFM")
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--interval", choices=INTERVAL_SECONDS, default="1h")
    parser.add_argument("--context", type=int, default=512, help="completed candles")
    parser.add_argument("--horizon", type=int, default=24, help="future candles")
    parser.add_argument("--repeat", type=int, default=0, metavar="SECONDS")
    parser.add_argument("--output", type=Path, default=Path("forecast.json"))
    parser.add_argument("--csv", type=Path, default=Path("forecast.csv"))
    parser.add_argument("--history-dir", type=Path, default=Path("history"))
    parser.add_argument("--model", default=MODEL_ID)
    return parser.parse_args()


def validate(args: argparse.Namespace) -> None:
    if not 32 <= args.context <= 999:
        raise ValueError("--context must be between 32 and 999")
    if not 1 <= args.horizon <= 512:
        raise ValueError("--horizon must be between 1 and 512")
    if args.context < args.horizon + 32:
        raise ValueError("--context must be at least --horizon + 32 for factor training")
    if args.repeat and args.repeat < 60:
        raise ValueError("--repeat must be 0 or at least 60 seconds")


def make_rows(model, data: MarketData, interval: str, horizon: int):
    timesfm_points, _ = timesfm_model.forecast(model, data.close, horizon)
    covariates = factor_model.xreg_covariates(data, horizon)
    points, quantiles = timesfm_model.forecast_with_xreg(model, data.close, covariates)
    step_ms = INTERVAL_SECONDS[interval] * 1000
    rows = []
    for index in range(horizon):
        # Quantile tensor: mean, q10, q20, ..., q90.
        q = quantiles[0, index]
        timestamp = datetime.fromtimestamp(
            (data.last_close_ms + (index + 1) * step_ms) / 1000, tz=timezone.utc
        ).isoformat()
        timesfm_point = float(timesfm_points[0, index])
        xreg_point = float(points[0, index])
        rows.append(ForecastRow(timestamp, xreg_point, float(q[1]),
                                float(q[5]), float(q[9]),
                                timesfm_point, xreg_point))
    return rows


def save_results(args: argparse.Namespace, data: MarketData, rows: list[ForecastRow]):
    last = float(data.close[-1])
    generated_at = datetime.now(timezone.utc)
    payload = {
        "generated_at": generated_at.isoformat(),
        "symbol": args.symbol.upper(),
        "interval": args.interval,
        "context_candles": len(data.close),
        "forecast_method": "timesfm + xreg",
        "xreg_ridge": 1.0,
        "xreg_covariates": ["lagged_returns", "lagged_momentum", "lagged_volatility", "lagged_candle_range",
                    "base_volume", "quote_volume", "trade_count", "taker_buy_ratio"],
        "last_close": last,
        "final_forecast": rows[-1].point,
        "final_change_percent": (rows[-1].point / last - 1) * 100,
        "forecast": [asdict(row) for row in rows],
        "disclaimer": "Experimental model output; not financial advice.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    csv_rows = [asdict(row) for row in rows]
    def write_csv(path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=ForecastRow.__annotations__)
            writer.writeheader()
            writer.writerows(csv_rows)
    write_csv(args.csv)

    interval_history_dir = args.history_dir / args.interval
    interval_history_dir.mkdir(parents=True, exist_ok=True)
    stamp = generated_at.strftime("%Y-%m-%d_%H-%M-%S_UTC")
    interval_label = INTERVAL_LABELS[args.interval]
    prefix = f"forecast_{args.symbol.upper()}_{interval_label}_{stamp}"
    history_json = interval_history_dir / f"{prefix}.json"
    history_csv = interval_history_dir / f"{prefix}.csv"
    history_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    write_csv(history_csv)
    payload["history_csv"] = str(history_csv)
    payload["history_json"] = str(history_json)
    return payload


def run_once(args: argparse.Namespace, client: Spot, model) -> None:
    data = fetch_market_data(
        client, args.symbol, args.interval, args.context
    )
    rows = make_rows(model, data, args.interval, args.horizon)
    result = save_results(args, data, rows)
    print(f"{result['symbol']} last close: ${result['last_close']:,.2f}")
    print(f"Forecast after {args.horizon} candles: ${result['final_forecast']:,.2f} "
          f"({result['final_change_percent']:+.2f}%)")
    print(f"Range q10-q90: ${rows[-1].q10:,.2f} — ${rows[-1].q90:,.2f}")
    print(f"Components: TimesFM ${rows[-1].timesfm_point:,.2f}; "
          f"TimesFM + XReg ${rows[-1].xreg_point:,.2f}")
    print(f"Saved: {args.output} and {args.csv}")
    print(f"History: {result['history_csv']}")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args()
    try:
        validate(args)
        client = Spot(timeout=15)
        model = timesfm_model.load(args.model, args.context, args.horizon)
        while True:
            try:
                run_once(args, client, model)
            except Exception:
                logging.exception("Forecast cycle failed")
                if not args.repeat:
                    raise
            if not args.repeat:
                break
            time.sleep(args.repeat)
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        logging.error("Fatal error: %s", error)
        return 1


if __name__ == "__main__":
    sys.exit(main())
