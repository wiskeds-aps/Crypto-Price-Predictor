from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
import time

from alerts import send_signal_alerts
from paths import signal_log_path
from scanner import ScanConfig, scan_market


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OI pump/dump futures screener")
    parser.add_argument("--interval", default="5m", choices=["5m", "15m", "30m", "1h"])
    parser.add_argument("--lookback-bars", type=int, default=12)
    parser.add_argument("--spike-bars", type=int, default=3)
    parser.add_argument("--top-n", type=int, default=80)
    parser.add_argument("--min-volume-usd", type=float, default=10_000_000)
    parser.add_argument("--min-oi", type=float, default=1.5)
    parser.add_argument("--min-volume-ratio", type=float, default=1.8)
    parser.add_argument("--min-price", type=float, default=0.4)
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--log", type=Path, default=signal_log_path())
    parser.add_argument("--repeat-seconds", type=int, default=0)
    parser.add_argument("--telegram-token", default=None)
    parser.add_argument("--telegram-chat-id", default=None)
    parser.add_argument("--alert-score", type=float, default=60.0)
    parser.add_argument("--cooldown-minutes", type=int, default=30)
    return parser.parse_args()


def run_once(args: argparse.Namespace) -> int:
    config = ScanConfig(
        interval=args.interval,
        lookback_bars=args.lookback_bars,
        spike_bars=args.spike_bars,
        top_n=args.top_n,
        min_quote_volume_24h=args.min_volume_usd,
        min_oi_change_pct=args.min_oi,
        min_volume_ratio=args.min_volume_ratio,
        min_price_move_pct=args.min_price,
    )
    df, errors = scan_market(config)
    if df.empty:
        print("No scanner rows returned.")
        for error in errors[:20]:
            print(error)
        return 1

    now = datetime.now(timezone.utc).isoformat()
    df.insert(0, "scan_time", now)
    core = df[df["is_core_signal"]].head(args.limit)
    output = core if not core.empty else df.head(args.limit)
    cols = [
        "scan_time", "symbol", "signal", "score", "is_core_signal",
        "price_move_pct", "oi_change_pct", "volume_ratio",
        "taker_buy_ratio", "recent_quote_volume", "quote_volume_24h",
        "last_price",
    ]
    print(output[cols].to_string(index=False))
    if not output.empty:
        write_header = not args.log.exists()
        output.to_csv(args.log, mode="a", header=write_header, index=False)
        print(f"\nLogged {len(output)} rows to {args.log}")
    sent = send_signal_alerts(
        df,
        min_score=args.alert_score,
        cooldown_minutes=args.cooldown_minutes,
        token=args.telegram_token,
        chat_id=args.telegram_chat_id,
    )
    if sent:
        print(f"Telegram alerts sent: {sent}")
    if errors:
        print(f"\nErrors: {len(errors)}")
    return 0


def main() -> int:
    args = parse_args()
    while True:
        code = run_once(args)
        if args.repeat_seconds <= 0:
            return code
        print(f"\nSleeping {args.repeat_seconds}s...\n", flush=True)
        time.sleep(args.repeat_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
