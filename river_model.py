import json
import os
import joblib
import numpy as np
import pandas as pd
from river import ensemble, preprocessing, metrics

from data import fetch_klines
from features import add_features
from paths import coin_models_dir, legacy_models_dir

MODELS_DIR = legacy_models_dir()
MODEL_MARKET = "binance_usdm_futures"
STATE_SCHEMA_VERSION = 2
# "_target" included so it's always excluded from features even if cols computed after insertion
EXCLUDE_COLS = {"open", "high", "low", "close", "volume", "_target"}

HORIZONS_RIVER = {
    "1h":  {"interval": "1h", "bars": 1,  "limit": 1000},
    "24h": {"interval": "1h", "bars": 24, "limit": 1000},
    "7d":  {"interval": "1d", "bars": 7,  "limit": 500},
}


def _path(symbol: str, horizon: str) -> str:
    return os.path.join(coin_models_dir(symbol), f"river_{horizon}.pkl")


def _meta_path(symbol: str, horizon: str) -> str:
    return os.path.join(coin_models_dir(symbol), f"river_{horizon}_meta.json")


def _legacy_path(symbol: str, horizon: str) -> str:
    return os.path.join(MODELS_DIR, f"river_{symbol}_{horizon}.pkl")


def _legacy_meta_path(symbol: str, horizon: str) -> str:
    return os.path.join(MODELS_DIR, f"river_{symbol}_{horizon}_meta.json")


def _new_state() -> dict:
    model = preprocessing.StandardScaler() | ensemble.SRPRegressor(n_models=10, seed=42)
    return {
        "model": model,
        "last_ts": None,
        "mae": metrics.MAE(),
        "n_samples": 0,
        "market": MODEL_MARKET,
        "schema_version": STATE_SCHEMA_VERSION,
    }


def _load(symbol: str, horizon: str) -> dict:
    p = _path(symbol, horizon)
    if not os.path.exists(p):
        p = _legacy_path(symbol, horizon)
    if not os.path.exists(p):
        return _new_state()
    try:
        state = joblib.load(p)
        if (
            isinstance(state, dict)
            and state.get("market") == MODEL_MARKET
            and state.get("schema_version") == STATE_SCHEMA_VERSION
        ):
            return state
        return _new_state()
    except Exception:
        # Corrupted pickle or version mismatch — start fresh
        return _new_state()


def _save_meta(symbol: str, horizon: str, n_samples: int, mae) -> None:
    with open(_meta_path(symbol, horizon), "w") as f:
        json.dump({
            "n_samples": n_samples,
            "mae": mae,
            "market": MODEL_MARKET,
            "schema_version": STATE_SCHEMA_VERSION,
        }, f)


def _feature_cols(df_feat: pd.DataFrame) -> list:
    return [c for c in df_feat.columns if c not in EXCLUDE_COLS]


def _ensure_feature_rows(df_feat: pd.DataFrame, symbol: str, horizon: str) -> None:
    if df_feat.empty:
        raise ValueError(
            f"Not enough futures history for {symbol} {horizon}. "
            "Choose a more liquid/older contract or lower the screener filters."
        )


def get_river_stats(symbol: str, horizon: str) -> dict:
    """Read lightweight metadata without deserializing the full model."""
    p = _meta_path(symbol, horizon)
    if not os.path.exists(p):
        p = _legacy_meta_path(symbol, horizon)
    if not os.path.exists(p):
        return {"n_samples": 0, "mae": None}
    try:
        with open(p) as f:
            data = json.load(f)
        if (
            data.get("market") == MODEL_MARKET
            and data.get("schema_version") == STATE_SCHEMA_VERSION
        ):
            return data
        return {"n_samples": 0, "mae": None}
    except Exception:
        return {"n_samples": 0, "mae": None}


def is_river_ready(symbol: str, horizon: str) -> bool:
    return get_river_stats(symbol, horizon)["n_samples"] > 0


def backtest_river(symbol: str, horizon: str, warmup_fraction: float = 0.6) -> dict:
    cfg = HORIZONS_RIVER[horizon]
    state = _new_state()
    model = state["model"]

    df = fetch_klines(symbol, cfg["interval"], cfg["limit"])
    df_feat = add_features(df)
    df_feat["_target"] = df_feat["close"].shift(-cfg["bars"]) / df_feat["close"] - 1
    learn_df = df_feat.dropna(subset=["_target"])
    cols = _feature_cols(learn_df)
    warmup = max(50, int(len(learn_df) * warmup_fraction))

    preds, actual = [], []
    for i, (_, row) in enumerate(learn_df.iterrows()):
        x = row[cols].to_dict()
        y = float(row["_target"])
        y_pred = model.predict_one(x)
        if y_pred is not None and i >= warmup:
            preds.append(float(y_pred))
            actual.append(y)
        model.learn_one(x, y)

    if not actual:
        return {
            "symbol": symbol,
            "horizon": horizon,
            "n_test": 0,
            "error": "Not enough data for backtest",
        }

    pred = np.array(preds)
    y = np.array(actual)
    abs_err = np.abs(pred - y)
    zero_abs_err = np.abs(y)
    direction_accuracy = float((np.sign(pred) == np.sign(y)).mean() * 100)
    mae = float(abs_err.mean())
    zero_mae = float(zero_abs_err.mean())
    rmse = float(np.sqrt(np.mean((pred - y) ** 2)))
    corr = float(np.corrcoef(pred, y)[0, 1]) if pred.std() > 0 and y.std() > 0 else None
    strategy_return = float((np.sign(pred) * y).mean())
    buy_hold_return = float(y.mean())

    return {
        "symbol": symbol,
        "horizon": horizon,
        "n_test": len(y),
        "mae_pct": mae * 100,
        "rmse_pct": rmse * 100,
        "zero_mae_pct": zero_mae * 100,
        "mae_vs_zero_pct": (1 - mae / zero_mae) * 100 if zero_mae else None,
        "direction_accuracy_pct": direction_accuracy,
        "correlation": corr,
        "strategy_avg_return_pct": strategy_return * 100,
        "buy_hold_avg_return_pct": buy_hold_return * 100,
    }


def predict_river(symbol: str, horizon: str, df: pd.DataFrame = None) -> dict:
    cfg = HORIZONS_RIVER[horizon]
    state = _load(symbol, horizon)

    if df is None:
        df = fetch_klines(symbol, cfg["interval"], 200)
    df_feat = add_features(df)
    _ensure_feature_rows(df_feat, symbol, horizon)
    cols = _feature_cols(df_feat)

    # current_price from df_feat (after dropna) — same row used for prediction
    current_price = float(df_feat["close"].iloc[-1])
    raw = state["model"].predict_one(df_feat[cols].iloc[-1].to_dict())
    pred_return = float(0.0 if raw is None else raw)
    pred_price = current_price * (1 + pred_return)

    stats = get_river_stats(symbol, horizon)
    return {
        "symbol": symbol,
        "horizon": horizon,
        "current_price": current_price,
        "predicted_price": float(pred_price),
        "predicted_return_pct": float(pred_return * 100),
        "direction": "UP" if pred_return > 0 else "DOWN",
        "confidence": float(min(abs(pred_return) * 2000, 99.0)),
        "n_samples": stats["n_samples"],
        "mae": stats["mae"],
    }


def update_river_model(symbol: str, horizon: str) -> dict:
    cfg = HORIZONS_RIVER[horizon]
    state = _load(symbol, horizon)
    model = state["model"]

    df = fetch_klines(symbol, cfg["interval"], cfg["limit"])
    df_feat = add_features(df)
    _ensure_feature_rows(df_feat, symbol, horizon)

    # _target is in EXCLUDE_COLS so adding it here is safe regardless of cols order
    df_feat["_target"] = df_feat["close"].shift(-cfg["bars"]) / df_feat["close"] - 1
    cols = _feature_cols(df_feat)
    learn_df = df_feat.dropna(subset=["_target"])
    if learn_df.empty:
        raise ValueError(
            f"Not enough completed futures candles for {symbol} {horizon} training. "
            "Choose a more liquid/older contract."
        )

    last_ts = state["last_ts"]
    new_rows = learn_df[learn_df.index > last_ts] if last_ts is not None else learn_df

    for ts, row in new_rows.iterrows():
        x = row[cols].to_dict()
        y = float(row["_target"])
        y_pred = model.predict_one(x)
        if y_pred is not None and state["n_samples"] > 0:
            state["mae"].update(y, y_pred)
        model.learn_one(x, y)
        state["n_samples"] += 1
        state["last_ts"] = ts

    # current_price from df_feat (after dropna)
    current_price = float(df_feat["close"].iloc[-1])
    raw = model.predict_one(df_feat[cols].iloc[-1].to_dict())
    pred_return = float(0.0 if raw is None else raw)
    pred_price = current_price * (1 + pred_return)

    joblib.dump(state, _path(symbol, horizon))

    mae = state["mae"].get() if state["n_samples"] > 10 else None
    _save_meta(symbol, horizon, state["n_samples"], mae)

    return {
        "symbol": symbol,
        "horizon": horizon,
        "current_price": current_price,
        "predicted_price": float(pred_price),
        "predicted_return_pct": float(pred_return * 100),
        "direction": "UP" if pred_return > 0 else "DOWN",
        "confidence": float(min(abs(pred_return) * 2000, 99.0)),
        "n_samples": state["n_samples"],
        "mae": mae,
    }
