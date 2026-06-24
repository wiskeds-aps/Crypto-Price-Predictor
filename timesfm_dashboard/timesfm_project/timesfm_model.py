"""TimesFM model loading and inference adapter."""

import logging

import numpy as np
import torch

DEFAULT_MODEL_ID = "google/timesfm-2.5-200m-pytorch"


def load(model_id: str, context: int, horizon: int):
    # Direct import avoids an optional-backend import issue in timesfm 2.0.1.
    import timesfm
    from timesfm.timesfm_2p5.timesfm_2p5_torch import TimesFM_2p5_200M_torch

    torch.set_float32_matmul_precision("high")
    logging.info("Loading model %s (first run downloads weights)", model_id)
    model = TimesFM_2p5_200M_torch.from_pretrained(model_id)
    model.compile(timesfm.ForecastConfig(
        max_context=context,
        max_horizon=horizon,
        normalize_inputs=True,
        use_continuous_quantile_head=True,
        force_flip_invariance=True,
        infer_is_positive=True,
        fix_quantile_crossing=True,
        return_backcast=True,
    ))
    return model


def forecast(model, closes: np.ndarray, horizon: int) -> tuple[np.ndarray, np.ndarray]:
    points, quantiles = model.forecast(horizon=horizon, inputs=[closes])
    # XReg requires return_backcast=True. In that mode forecast() prepends the
    # reconstructed context; only the final `horizon` values are future data.
    return points[:, -horizon:], quantiles[:, -horizon:, :]


def forecast_with_xreg(model, closes: np.ndarray, covariates: dict[str, list[np.ndarray]]):
    """Forecast with TimesFM, then fit XReg on its in-context residuals."""
    points, quantiles = model.forecast_with_covariates(
        inputs=[closes],
        dynamic_numerical_covariates=covariates,
        xreg_mode="timesfm + xreg",
        normalize_xreg_target_per_input=True,
        ridge=1.0,
        force_on_cpu=True,
    )
    return np.asarray(points), np.asarray(quantiles)
