#!/usr/bin/env python3
"""Hourly River shadow bot using completed Binance Futures candles."""

from __future__ import annotations

import csv
import json
import math
import os
import pickle
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

ROOT = Path(os.environ.get("RIVER_ROOT", Path("/root/river") if Path("/root/river").exists() else Path(__file__).resolve().parent))
MODEL_PATH = ROOT / "models/BTCUSDT_1h_river_v3.pkl"
STATE_PATH = ROOT / "live/state_1h.json"
CURRENT_PATH = ROOT / "live/forecast_1h.json"
HISTORY_PATH = ROOT / "live/history_1h.csv"
URL = "https://fapi.binance.com/fapi/v1/klines"


def fetch_completed(limit=40):
    response = requests.get(URL, params={"symbol": "BTCUSDT", "interval": "1h", "limit": limit}, timeout=20)
    response.raise_for_status()
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    return [row for row in response.json() if int(row[6]) < now_ms]


def feature(candles, index):
    close = np.asarray([float(row[4]) for row in candles], dtype=np.float64)
    def ret(lag): return float(np.log(close[index] / close[index-lag]))
    one_steps = np.diff(np.log(close[index-24:index+1]))
    row = candles[index]
    open_, high, low = float(row[1]), float(row[2]), float(row[3])
    return {
        "return_1": ret(1), "return_3": ret(3), "return_6": ret(6),
        "return_12": ret(12), "return_24": ret(24),
        "volatility_6": float(np.std(one_steps[-6:])),
        "volatility_12": float(np.std(one_steps[-12:])),
        "volatility_24": float(np.std(one_steps[-24:])),
        "range_pct": (high-low)/close[index],
        "body_pct": (close[index]-open_)/open_,
    }


def iso(ms): return datetime.fromtimestamp(ms/1000, tz=timezone.utc).isoformat()


def main():
    ROOT.joinpath("live").mkdir(exist_ok=True)
    with MODEL_PATH.open("rb") as file: package=pickle.load(file)
    model=package["model"]
    candles=fetch_completed()
    if len(candles)<26: raise RuntimeError("Not enough completed candles")
    latest=len(candles)-1; previous=latest-1
    latest_close_ms=int(candles[latest][6]); previous_close_ms=int(candles[previous][6])
    state=json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {"last_learned_close_ms":0}
    if int(state.get("last_forecast_close_ms", 0)) == latest_close_ms:
        print(f"River shadow: candle {iso(latest_close_ms)} already processed")
        return

    # Learn the previous prediction only once, after its target becomes known.
    if previous_close_ms > int(state["last_learned_close_ms"]):
        previous_x=feature(candles,previous)
        actual_return=math.log(float(candles[latest][4])/float(candles[previous][4]))
        model.learn_one(previous_x,actual_return)
        state["last_learned_close_ms"]=previous_close_ms

    x=feature(candles,latest)
    predicted_return=float(model.predict_one(x) or 0.0)
    predicted_return=max(-.2,min(.2,predicted_return))
    last_close=float(candles[latest][4])
    predicted_price=last_close*math.exp(predicted_return)
    next_close_ms=latest_close_ms+3_600_000
    generated=datetime.now(timezone.utc)
    result={
        "generated_at":generated.isoformat(),"mode":"shadow","symbol":"BTCUSDT",
        "interval":"1h","source":"Binance Futures","model":package["name"],
        "candle_close_time":iso(latest_close_ms),"forecast_time":iso(next_close_ms),
        "last_close":last_close,"river_return":predicted_return,
        "river_point":predicted_price,"change_percent":predicted_return*100,
        "features":x,
    }
    CURRENT_PATH.write_text(json.dumps(result,indent=2),encoding="utf-8")
    new_file=not HISTORY_PATH.exists()
    with HISTORY_PATH.open("a",newline="",encoding="utf-8") as file:
        writer=csv.DictWriter(file,fieldnames=[k for k in result if k!="features"])
        if new_file:writer.writeheader()
        writer.writerow({k:v for k,v in result.items() if k!="features"})
    state["last_forecast_close_ms"]=latest_close_ms
    STATE_PATH.write_text(json.dumps(state,indent=2),encoding="utf-8")
    with MODEL_PATH.open("wb") as file:pickle.dump(package,file,pickle.HIGHEST_PROTOCOL)
    print(f"River shadow: {last_close:,.2f} -> {predicted_price:,.2f} ({predicted_return*100:+.3f}%)")


if __name__=="__main__":main()
