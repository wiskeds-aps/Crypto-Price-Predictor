import os
import joblib
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error
from data import fetch_klines
from features import prepare_dataset, add_features
from paths import coin_models_dir, legacy_models_dir

MODELS_DIR = legacy_models_dir()
MODEL_MARKET = "binance_usdm_futures"
MODEL_SCHEMA_VERSION = 2

HORIZONS = {
    "1h":  {"interval": "1h",  "bars": 1,   "limit": 1000},
    "24h": {"interval": "1h",  "bars": 24,  "limit": 1000},
    "7d":  {"interval": "1d",  "bars": 7,   "limit": 500},
}

LGB_PARAMS = {
    "objective": "regression",
    "metric": "mae",
    "verbosity": -1,
    "boosting_type": "gbdt",
    "num_leaves": 63,
    "learning_rate": 0.05,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "min_child_samples": 20,
    "n_estimators": 500,
}


def _ensure_dataset(X: pd.DataFrame, symbol: str, horizon: str) -> None:
    if len(X) < 60:
        raise ValueError(
            f"Not enough futures history for {symbol} {horizon}: only {len(X)} usable rows. "
            "Choose a more liquid/older contract."
        )


def _ensure_feature_rows(df_feat: pd.DataFrame, symbol: str, horizon: str) -> None:
    if df_feat.empty:
        raise ValueError(
            f"Not enough futures history for {symbol} {horizon}. "
            "Choose a more liquid/older contract."
        )


def model_path(symbol: str, horizon: str) -> str:
    return os.path.join(coin_models_dir(symbol), f"lightgbm_{horizon}.pkl")


def legacy_model_path(symbol: str, horizon: str) -> str:
    return os.path.join(MODELS_DIR, f"{symbol}_{horizon}.pkl")


def _is_compatible_saved_model(saved: dict) -> bool:
    return (
        isinstance(saved, dict)
        and saved.get("market") == MODEL_MARKET
        and saved.get("schema_version") == MODEL_SCHEMA_VERSION
        and "model" in saved
        and "feature_cols" in saved
    )


def _load_saved_model(symbol: str, horizon: str) -> dict:
    for path in [model_path(symbol, horizon), legacy_model_path(symbol, horizon)]:
        if not os.path.exists(path):
            continue
        saved = joblib.load(path)
        if _is_compatible_saved_model(saved):
            return saved
    raise FileNotFoundError(
        f"No compatible futures LightGBM model for {symbol} {horizon}. Retrain the model."
    )


def train_model(symbol: str, horizon: str) -> dict:
    cfg = HORIZONS[horizon]
    df = fetch_klines(symbol, cfg["interval"], cfg["limit"])
    X, y, _ = prepare_dataset(df, cfg["bars"])
    _ensure_dataset(X, symbol, horizon)

    tscv = TimeSeriesSplit(n_splits=5)
    maes, best_iters = [], []
    for train_idx, val_idx in tscv.split(X):
        X_tr, X_val = X.iloc[train_idx], X.iloc[val_idx]
        y_tr, y_val = y.iloc[train_idx], y.iloc[val_idx]
        m = lgb.LGBMRegressor(**LGB_PARAMS)
        m.fit(X_tr, y_tr, eval_set=[(X_val, y_val)],
              callbacks=[lgb.early_stopping(50, verbose=False)])
        maes.append(mean_absolute_error(y_val, m.predict(X_val)))
        best_iters.append(m.best_iteration_ or LGB_PARAMS["n_estimators"])

    # Final model uses the average optimal tree count from CV — avoids overfitting
    best_n = max(50, int(np.mean(best_iters)))
    model = lgb.LGBMRegressor(**{**LGB_PARAMS, "n_estimators": best_n})
    model.fit(X, y)
    joblib.dump({
        "model": model,
        "feature_cols": list(X.columns),
        "market": MODEL_MARKET,
        "schema_version": MODEL_SCHEMA_VERSION,
    }, model_path(symbol, horizon))

    return {"symbol": symbol, "horizon": horizon, "cv_mae": float(np.mean(maes))}


def predict(symbol: str, horizon: str, df: pd.DataFrame = None) -> dict:
    cfg = HORIZONS[horizon]
    saved = _load_saved_model(symbol, horizon)
    model = saved["model"]
    feature_cols = saved["feature_cols"]

    if df is None:
        df = fetch_klines(symbol, cfg["interval"], 200)
    df_feat = add_features(df)
    _ensure_feature_rows(df_feat, symbol, horizon)
    # current_price from df_feat (after dropna) so it matches the row used for prediction
    current_price = float(df_feat["close"].iloc[-1])

    last_row = df_feat[feature_cols].iloc[[-1]]
    pred_return = float(model.predict(last_row)[0])
    pred_price = current_price * (1 + pred_return)

    direction = "UP" if pred_return > 0 else "DOWN"
    # Scale: 1% move → ~20% confidence, 5% move → 99%
    confidence = min(abs(pred_return) * 2000, 99.0)

    return {
        "symbol": symbol,
        "horizon": horizon,
        "current_price": current_price,
        "predicted_price": pred_price,
        "predicted_return_pct": pred_return * 100,
        "direction": direction,
        "confidence": confidence,
    }


def is_trained(symbol: str, horizon: str) -> bool:
    try:
        _load_saved_model(symbol, horizon)
        return True
    except Exception:
        return False
