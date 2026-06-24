#!/usr/bin/env python3
"""Preset: BTCUSDT, 5-minute candles, 24-hour forecast."""

import sys

import bot


if __name__ == "__main__":
    # 24 hours / 5 minutes = 288 forecast points.
    sys.argv[1:1] = [
        "--interval", "5m",
        "--context", "999",
        "--horizon", "288",
        "--output", "forecast_5m_24h.json",
        "--csv", "forecast_5m_24h.csv",
    ]
    sys.exit(bot.main())
