import json
import math
import os
import time
from typing import Any

from sqlalchemy.orm import Session

from .models import TradeLiquiditySnapshot


TRADE_HISTORY_RETENTION_HOURS = float(os.environ.get("CRYPTOSKRINER_TRADE_HISTORY_HOURS", "24"))
TRADE_HISTORY_RETENTION_SEC = max(60, int(TRADE_HISTORY_RETENTION_HOURS * 60 * 60))
TRADE_HISTORY_WINDOWS = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "30m": 30 * 60,
    "1h": 60 * 60,
    "4h": 4 * 60 * 60,
    "24h": 24 * 60 * 60,
}


def parse_trade_window(value: str | int | None) -> tuple[str, int]:
    raw = str(value or "5m").strip().lower()
    if raw in TRADE_HISTORY_WINDOWS:
        seconds = TRADE_HISTORY_WINDOWS[raw]
        return raw, min(seconds, TRADE_HISTORY_RETENTION_SEC)

    mult = 1
    number = raw
    if raw.endswith("m"):
        mult = 60
        number = raw[:-1]
    elif raw.endswith("h"):
        mult = 60 * 60
        number = raw[:-1]

    try:
        seconds = int(float(number) * mult)
    except ValueError:
        seconds = TRADE_HISTORY_WINDOWS["5m"]

    seconds = max(60, min(seconds, TRADE_HISTORY_RETENTION_SEC))
    if seconds % 3600 == 0:
        return f"{seconds // 3600}h", seconds
    if seconds % 60 == 0:
        return f"{seconds // 60}m", seconds
    return f"{seconds}s", seconds


def prune_trade_liquidity_history(db: Session, now_sec: int | None = None) -> int:
    now = int(now_sec or time.time())
    cutoff = now - TRADE_HISTORY_RETENTION_SEC
    deleted = (
        db.query(TradeLiquiditySnapshot)
        .filter(TradeLiquiditySnapshot.time_bucket < cutoff)
        .delete(synchronize_session=False)
    )
    db.commit()
    return int(deleted or 0)


def _float(value: Any, default: float | None = None) -> float | None:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    return num if math.isfinite(num) else default


def _step_precision(step: float) -> int:
    n = abs(float(step or 0))
    if not math.isfinite(n) or n <= 0:
        return 2
    return max(0, min(12, math.ceil(-math.log10(n)) + 4))


def _round_price(value: float, step: float) -> float:
    return round(float(value), _step_precision(step))


def _load_zones(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _zone_bounds(zone: dict[str, Any], price: float, manual_step: float, fallback_step: float) -> tuple[float, float, float]:
    if manual_step > 0:
        lower = math.floor(price / manual_step) * manual_step
        upper = lower + manual_step
        return _round_price(lower, manual_step), _round_price(upper, manual_step), manual_step

    lower = _float(zone.get("lower", zone.get("minPrice")))
    upper = _float(zone.get("upper", zone.get("maxPrice")))
    step = _float(zone.get("step"), fallback_step) or fallback_step
    if lower is None or upper is None or upper <= lower:
        if not step or step <= 0:
            step = max(abs(price) * 0.00001, 1e-12)
        lower = math.floor(price / step) * step
        upper = lower + step

    step = step if step and step > 0 else max(abs(upper - lower), 1e-12)
    return _round_price(lower, step), _round_price(upper, step), step


def _pick_top_zones(zones: list[dict[str, Any]], ranges: int, min_notional: float) -> list[dict[str, Any]]:
    ranges = max(1, min(int(ranges or 6), 24))
    zones_per_side = max(1, math.ceil(ranges / 2))
    picked: list[dict[str, Any]] = []

    for side in ("buy", "sell"):
        side_rows = [z for z in zones if z.get("side") == side]
        side_rows.sort(key=lambda z: float(z.get("score") or z.get("notional") or 0), reverse=True)
        eligible = [
            z for z in side_rows
            if min_notional <= 0 or float(z.get("maxNotional") or z.get("notional") or 0) >= min_notional
        ]
        if len(eligible) < zones_per_side:
            eligible.extend(z for z in side_rows if z not in eligible)
        picked.extend(eligible[:zones_per_side])

    picked.sort(key=lambda z: float(z.get("score") or z.get("notional") or 0), reverse=True)
    return picked[:ranges]


def query_trade_liquidity_zones(
    db: Session,
    symbol: str,
    window: str | int | None = "5m",
    ranges: int = 6,
    step: float = 0,
    min_notional: float = 0,
    now_sec: int | None = None,
) -> dict[str, Any]:
    sym = symbol.upper()
    window_label, window_sec = parse_trade_window(window)
    now = int(now_sec or time.time())
    cutoff = now - window_sec
    manual_step = _float(step, 0.0) or 0.0
    min_notional = max(_float(min_notional, 0.0) or 0.0, 0.0)

    rows = (
        db.query(TradeLiquiditySnapshot)
        .filter(TradeLiquiditySnapshot.symbol == sym)
        .filter(TradeLiquiditySnapshot.time_bucket >= cutoff)
        .order_by(TradeLiquiditySnapshot.time_bucket.asc())
        .all()
    )
    total_samples = len(rows)
    if not rows:
        return {
            "symbol": sym,
            "window": window_label,
            "window_seconds": window_sec,
            "retention_hours": TRADE_HISTORY_RETENTION_HOURS,
            "sample_count": 0,
            "from_time": cutoff,
            "to_time": now,
            "step": manual_step,
            "buy_notional": 0,
            "sell_notional": 0,
            "zones": [],
        }

    buckets: dict[str, dict[str, Any]] = {}
    buy_notional = 0.0
    sell_notional = 0.0
    trade_count = 0
    for snapshot in rows:
        buy_notional += float(snapshot.buy_notional or 0)
        sell_notional += float(snapshot.sell_notional or 0)
        trade_count += int(snapshot.trade_count or 0)
        fallback_step = _float(snapshot.step, 0.0) or 0.0
        for zone in _load_zones(snapshot.zones_json):
            side = "sell" if zone.get("side") == "sell" else "buy"
            price = _float(zone.get("price"))
            qty = _float(zone.get("qty"))
            notional = _float(zone.get("notional"))
            if price is None or qty is None or notional is None or qty <= 0 or notional <= 0:
                continue

            lower, upper, bucket_step = _zone_bounds(zone, price, manual_step, fallback_step)
            precision = _step_precision(bucket_step)
            key = f"{side}:{lower:.{precision}f}:{upper:.{precision}f}"
            bucket = buckets.get(key)
            if not bucket:
                bucket = {
                    "side": side,
                    "lower": lower,
                    "upper": upper,
                    "minPrice": min(lower, upper),
                    "maxPrice": max(lower, upper),
                    "hitCount": 0,
                    "sampleBuckets": set(),
                    "score": 0.0,
                    "qtySum": 0.0,
                    "notionalSum": 0.0,
                    "weightedPrice": 0.0,
                    "maxNotional": 0.0,
                    "tradeCount": 0,
                    "lastSeen": 0,
                    "lastNotional": 0.0,
                }
                buckets[key] = bucket

            count = int(zone.get("count") or 1)
            bucket["hitCount"] += 1
            bucket["sampleBuckets"].add(snapshot.time_bucket)
            bucket["score"] += notional
            bucket["qtySum"] += qty
            bucket["notionalSum"] += notional
            bucket["weightedPrice"] += price * notional
            bucket["maxNotional"] = max(bucket["maxNotional"], _float(zone.get("maxNotional"), notional) or notional)
            bucket["tradeCount"] += count
            if snapshot.time_bucket >= bucket["lastSeen"]:
                bucket["lastSeen"] = snapshot.time_bucket
                bucket["lastNotional"] = notional

    min_hits = 2 if total_samples >= 2 else 1
    zones = []
    for bucket in buckets.values():
        sample_hits = len(bucket["sampleBuckets"])
        if sample_hits < min_hits:
            continue
        hit_count = max(int(bucket["hitCount"]), 1)
        notional_sum = float(bucket["notionalSum"])
        zones.append({
            "side": bucket["side"],
            "lower": bucket["lower"],
            "upper": bucket["upper"],
            "minPrice": bucket["minPrice"],
            "maxPrice": bucket["maxPrice"],
            "price": bucket["weightedPrice"] / notional_sum if notional_sum > 0 else (bucket["minPrice"] + bucket["maxPrice"]) / 2,
            "qty": bucket["qtySum"] / hit_count,
            "notional": notional_sum / hit_count,
            "maxNotional": bucket["maxNotional"],
            "lastNotional": bucket["lastNotional"],
            "score": bucket["score"],
            "persistence": min(1.0, sample_hits / max(total_samples, 1)),
            "count": hit_count,
            "tradeCount": bucket["tradeCount"],
            "sampleCount": total_samples,
            "source": "trades",
        })

    latest = rows[-1]
    return {
        "symbol": sym,
        "window": window_label,
        "window_seconds": window_sec,
        "retention_hours": TRADE_HISTORY_RETENTION_HOURS,
        "sample_count": total_samples,
        "from_time": rows[0].time_bucket,
        "to_time": latest.time_bucket,
        "min_price": min((r.min_price for r in rows if r.min_price is not None), default=None),
        "max_price": max((r.max_price for r in rows if r.max_price is not None), default=None),
        "step": manual_step or latest.step or 0,
        "buy_notional": buy_notional,
        "sell_notional": sell_notional,
        "delta": buy_notional - sell_notional,
        "trade_count": trade_count,
        "zones": _pick_top_zones(zones, ranges, min_notional),
    }
