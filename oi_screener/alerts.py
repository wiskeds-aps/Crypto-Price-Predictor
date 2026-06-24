from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pandas as pd
import requests

from paths import alert_state_path


def _load_state(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(path: Path, state: dict) -> None:
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _format_signal(row: pd.Series) -> str:
    icon = "[PUMP]" if row["signal"] == "PUMP" else "[DUMP]" if row["signal"] == "DUMP" else "[SIGNAL]"
    return (
        f"{icon} {row['signal']} {row['symbol']} score {row['score']:.1f}\n"
        f"Price: {row['price_move_pct']:+.3f}% | OI: {row['oi_change_pct']:+.3f}% | "
        f"Volume: {row['volume_ratio']:.2f}x\n"
        f"Taker buy: {row['taker_buy_ratio']:.1%} | Last: {row['last_price']}"
    )


def send_telegram(text: str, token: str, chat_id: str) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    response = requests.post(
        url,
        json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
        timeout=10,
    )
    response.raise_for_status()


def send_signal_alerts(
    df: pd.DataFrame,
    min_score: float,
    cooldown_minutes: int,
    state_path: Path = alert_state_path(),
    token: str | None = None,
    chat_id: str | None = None,
) -> int:
    token = token or os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = chat_id or os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id or df.empty:
        return 0

    state = _load_state(state_path)
    now = time.time()
    cooldown = cooldown_minutes * 60
    sent = 0

    alerts = df[
        df["is_core_signal"]
        & df["signal"].isin(["PUMP", "DUMP"])
        & (df["score"] >= min_score)
    ].sort_values("score", ascending=False)

    for _, row in alerts.iterrows():
        key = f"{row['symbol']}:{row['signal']}"
        last_sent = float(state.get(key, 0))
        if now - last_sent < cooldown:
            continue
        send_telegram(_format_signal(row), token, chat_id)
        state[key] = now
        sent += 1

    if sent:
        _save_state(state_path, state)
    return sent
