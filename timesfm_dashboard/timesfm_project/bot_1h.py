#!/usr/bin/env python3
"""Preset: BTCUSDT, 1-hour candles, 24-hour forecast."""

import sys

import bot


if __name__ == "__main__":
    sys.argv[1:1] = [
        "--interval", "1h",
        "--context", "512",
        "--horizon", "24",
        "--output", "forecast.json",
        "--csv", "forecast.csv",
    ]
    sys.exit(bot.main())
