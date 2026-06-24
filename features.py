import pandas as pd
import numpy as np
import ta


def add_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df["volume"]

    # Returns
    for lag in [1, 3, 7, 14, 30]:
        df[f"return_{lag}"] = close.pct_change(lag)

    # EMAs
    for period in [7, 14, 25, 50, 99]:
        df[f"ema_{period}"] = ta.trend.ema_indicator(close, window=period)

    # EMA ratios
    df["ema_7_25_ratio"] = df["ema_7"] / df["ema_25"]
    df["ema_25_99_ratio"] = df["ema_25"] / df["ema_99"]

    # RSI
    df["rsi_14"] = ta.momentum.rsi(close, window=14)
    df["rsi_7"] = ta.momentum.rsi(close, window=7)

    # MACD
    macd = ta.trend.MACD(close)
    df["macd"] = macd.macd()
    df["macd_signal"] = macd.macd_signal()
    df["macd_diff"] = macd.macd_diff()

    # Bollinger Bands
    bb = ta.volatility.BollingerBands(close, window=20)
    df["bb_upper"] = bb.bollinger_hband()
    df["bb_lower"] = bb.bollinger_lband()
    df["bb_mid"] = bb.bollinger_mavg()
    df["bb_pct"] = bb.bollinger_pband()
    df["bb_width"] = (df["bb_upper"] - df["bb_lower"]) / df["bb_mid"]

    # ATR
    df["atr_14"] = ta.volatility.average_true_range(high, low, close, window=14)
    df["atr_pct"] = df["atr_14"] / close

    # Volume
    df["volume_sma_20"] = volume.rolling(20).mean()
    df["volume_ratio"] = volume / df["volume_sma_20"]

    # Stochastic
    stoch = ta.momentum.StochasticOscillator(high, low, close)
    df["stoch_k"] = stoch.stoch()
    df["stoch_d"] = stoch.stoch_signal()

    # OHLC features
    df["candle_body"] = (close - df["open"]) / df["open"]
    df["hl_spread"] = (high - low) / df["open"]
    df["close_position"] = (close - low) / (high - low + 1e-9)

    df.replace([np.inf, -np.inf], np.nan, inplace=True)
    df.dropna(inplace=True)
    return df


def prepare_dataset(df: pd.DataFrame, horizon: int) -> tuple:
    df = add_features(df)
    df["target"] = df["close"].shift(-horizon)
    df["target_return"] = (df["target"] / df["close"] - 1)
    df.replace([np.inf, -np.inf], np.nan, inplace=True)
    df.dropna(inplace=True)

    feature_cols = [c for c in df.columns if c not in ["target", "target_return",
                                                         "open", "high", "low", "close", "volume"]]
    X = df[feature_cols]
    y = df["target_return"]
    return X, y, df
