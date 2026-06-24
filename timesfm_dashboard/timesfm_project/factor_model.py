"""Market-factor features for TimesFM XReg and the legacy Ridge forecaster."""

import numpy as np

from market_data import MarketData

FEATURE_NAMES = (
    "return_lag1", "momentum_3_lag1", "momentum_12_lag1",
    "momentum_24_lag1", "volatility_6_lag1", "volatility_24_lag1",
    "range_lag1", "base_volume_lag1", "quote_volume_lag1",
    "trades_lag1", "taker_buy_ratio_lag1",
)


def factor_vector(data: MarketData, index: int) -> np.ndarray:
    """Build features available at candle close without future leakage."""
    close = data.close
    log_return = np.diff(np.log(close), prepend=np.log(close[0]))

    def momentum(period: int) -> float:
        return np.log(close[index] / close[max(0, index - period)])

    def volatility(period: int) -> float:
        start = max(1, index - period + 1)
        window = log_return[start:index + 1]
        return float(np.std(window)) if len(window) else 0.0

    quote = max(data.quote_volume[index], 1e-12)
    return np.asarray([
        log_return[index], momentum(3), momentum(12), momentum(24),
        volatility(6), volatility(24),
        (data.high[index] - data.low[index]) / data.close[index],
        np.log1p(data.volume[index]), np.log1p(data.quote_volume[index]),
        np.log1p(data.trades[index]), data.taker_buy_quote[index] / quote - 0.5,
    ], dtype=np.float64)


def forecast(data: MarketData, horizon: int) -> np.ndarray:
    """Fit one ridge model per horizon and return price forecasts."""
    lookback = 24
    features = np.vstack([factor_vector(data, i) for i in range(len(data.close))])
    current = features[-1]
    predictions = []
    for step in range(1, horizon + 1):
        indexes = range(lookback, len(data.close) - step)
        x = features[list(indexes)]
        y = np.asarray([
            np.log(data.close[i + step] / data.close[i]) for i in indexes
        ])
        mean, scale = x.mean(axis=0), x.std(axis=0)
        scale[scale < 1e-12] = 1.0
        xz, current_z = (x - mean) / scale, (current - mean) / scale
        design = np.column_stack([np.ones(len(xz)), xz])
        penalty = np.eye(design.shape[1]) * 3.0
        penalty[0, 0] = 0.0
        coefficients = np.linalg.solve(design.T @ design + penalty, design.T @ y)
        predicted_return = float(np.r_[1.0, current_z] @ coefficients)
        predictions.append(data.close[-1] * np.exp(np.clip(predicted_return, -0.4, 0.4)))
    return np.asarray(predictions)


def xreg_covariates(data: MarketData, horizon: int) -> dict[str, list[np.ndarray]]:
    """Create leakage-free XReg covariates for context plus forecast horizon.

    Each market feature is lagged by one candle. Unknown future values are held
    at the latest observable value, so inference never uses future OHLCV data.
    """
    features = np.vstack([factor_vector(data, i) for i in range(len(data.close))])
    lagged = np.vstack([features[0], features[:-1]])
    extended = np.vstack([lagged, np.repeat(features[-1][None, :], horizon, axis=0)])
    return {name: [extended[:, index]] for index, name in enumerate(FEATURE_NAMES)}
