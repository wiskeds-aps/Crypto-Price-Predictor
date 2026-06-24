from __future__ import annotations

import os
from pathlib import Path


def screener_root() -> Path:
    env = os.environ.get("OI_SCREENER_HOME")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent


def screener_data_dir() -> Path:
    path = screener_root() / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def signal_log_path() -> Path:
    return screener_data_dir() / "signals_log.csv"


def alert_state_path() -> Path:
    return screener_data_dir() / ".alert_state.json"
