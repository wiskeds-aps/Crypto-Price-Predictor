import asyncio
import json
import os
import threading
import time
from datetime import datetime, timezone

import pandas as pd
import websockets

from paths import (
    COINS_DIR,
    coin_liquidations_path,
    liquidation_collector_lock_path,
    liquidation_collector_status_path,
)

try:
    import fcntl
except ImportError:
    fcntl = None

try:
    import msvcrt
except ImportError:
    msvcrt = None


WS_URLS = [
    "wss://fstream.binancefuture.com/ws/!forceOrder@arr",
    "wss://fstream.binancefuture.com/stream?streams=!forceOrder@arr",
    "wss://fstream.binance.com/ws/!forceOrder@arr",
    "wss://fstream.binance.com/stream?streams=!forceOrder@arr",
]

LIQUIDATION_COLUMNS = [
    "event_id",
    "event_time",
    "trade_time",
    "symbol",
    "order_side",
    "liquidated_side",
    "order_type",
    "time_in_force",
    "original_qty",
    "price",
    "avg_price",
    "last_filled_qty",
    "filled_qty",
    "quote_qty",
    "status",
]

_write_lock = threading.Lock()
_status_lock = threading.Lock()
_thread = None
_collector_lock_file = None
_status = {
    "running": False,
    "connected": False,
    "url": None,
    "started_at": None,
    "heartbeat": None,
    "last_event_time": None,
    "last_error": None,
    "events_written": 0,
}


def _set_status(**kwargs) -> None:
    with _status_lock:
        kwargs.setdefault("heartbeat", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"))
        _status.update(kwargs)
        status = dict(_status)
    _write_status_file(status)


def _set_local_status(**kwargs) -> None:
    with _status_lock:
        kwargs.setdefault("heartbeat", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"))
        _status.update(kwargs)


def _write_status_file(status: dict) -> None:
    path = liquidation_collector_status_path()
    try:
        with open(path, "w") as f:
            json.dump(status, f)
    except Exception:
        pass


def _read_status_file() -> dict | None:
    path = liquidation_collector_status_path()
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            status = json.load(f)
        return status if isinstance(status, dict) else None
    except Exception:
        return None


def _status_is_fresh(status: dict, max_age_seconds: int = 90) -> bool:
    heartbeat = status.get("heartbeat")
    if not heartbeat:
        return False
    try:
        ts = datetime.strptime(heartbeat, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except Exception:
        return False
    return (datetime.now(timezone.utc) - ts).total_seconds() <= max_age_seconds


def get_liquidation_status() -> dict:
    external_status = _read_status_file()
    with _status_lock:
        local_status = dict(_status)
    if external_status and external_status.get("running") and _status_is_fresh(external_status):
        return external_status
    return local_status


def _acquire_collector_lock() -> bool:
    global _collector_lock_file
    if _collector_lock_file is not None:
        return True

    path = liquidation_collector_lock_path()
    _collector_lock_file = open(path, "a+")
    try:
        if fcntl is not None:
            fcntl.flock(_collector_lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        elif msvcrt is not None:
            _collector_lock_file.seek(0)
            _collector_lock_file.write("0")
            _collector_lock_file.flush()
            _collector_lock_file.seek(0)
            msvcrt.locking(_collector_lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        _collector_lock_file.seek(0)
        _collector_lock_file.truncate()
        _collector_lock_file.write(str(os.getpid()))
        _collector_lock_file.flush()
        return True
    except OSError:
        try:
            _collector_lock_file.close()
        except Exception:
            pass
        _collector_lock_file = None
        return False


def _to_float(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _event_time(ms: int | None) -> str:
    if not ms:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def parse_liquidation_payload(payload: dict) -> list[dict]:
    data = payload.get("data", payload)
    if isinstance(data, list):
        events = data
    else:
        events = [data]

    rows = []
    for event in events:
        order = event.get("o") if isinstance(event, dict) else None
        if not isinstance(order, dict):
            continue

        symbol = order.get("s")
        order_side = order.get("S")
        if not symbol or not order_side:
            continue

        avg_price = _to_float(order.get("ap")) or _to_float(order.get("p"))
        filled_qty = _to_float(order.get("z")) or _to_float(order.get("l")) or _to_float(order.get("q"))
        quote_qty = avg_price * filled_qty
        trade_time_ms = order.get("T") or event.get("E")
        event_time_ms = event.get("E") or trade_time_ms

        if order_side == "SELL":
            liquidated_side = "LONG"
        elif order_side == "BUY":
            liquidated_side = "SHORT"
        else:
            liquidated_side = "UNKNOWN"

        event_id = ":".join([
            str(symbol),
            str(trade_time_ms),
            str(order_side),
            f"{filled_qty:.12g}",
            f"{avg_price:.12g}",
        ])

        rows.append({
            "event_id": event_id,
            "event_time": _event_time(event_time_ms),
            "trade_time": _event_time(trade_time_ms),
            "symbol": symbol,
            "order_side": order_side,
            "liquidated_side": liquidated_side,
            "order_type": order.get("o"),
            "time_in_force": order.get("f"),
            "original_qty": _to_float(order.get("q")),
            "price": _to_float(order.get("p")),
            "avg_price": avg_price,
            "last_filled_qty": _to_float(order.get("l")),
            "filled_qty": filled_qty,
            "quote_qty": quote_qty,
            "status": order.get("X"),
        })
    return rows


def _append_rows(rows: list[dict]) -> None:
    if not rows:
        return

    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row["symbol"], []).append(row)

    with _write_lock:
        for symbol, symbol_rows in grouped.items():
            path = coin_liquidations_path(symbol)
            df = pd.DataFrame(symbol_rows, columns=LIQUIDATION_COLUMNS)
            header = not os.path.exists(path)
            df.to_csv(path, mode="a", header=header, index=False)

    latest = max(row["trade_time"] for row in rows)
    with _status_lock:
        _status["events_written"] += len(rows)
        _status["last_event_time"] = latest
        _status["last_error"] = None
        _status["heartbeat"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        status = dict(_status)
    _write_status_file(status)


async def _listen_once(url: str) -> None:
    _set_status(connected=False, url=url)
    async with websockets.connect(url, ping_interval=20, ping_timeout=20, close_timeout=5) as ws:
        _set_status(connected=True, url=url, last_error=None)

        async def heartbeat() -> None:
            while True:
                _set_status(connected=True, url=url)
                await asyncio.sleep(30)

        heartbeat_task = asyncio.create_task(heartbeat())
        try:
            async for message in ws:
                payload = json.loads(message)
                rows = parse_liquidation_payload(payload)
                _append_rows(rows)
        finally:
            heartbeat_task.cancel()


async def _collector_loop() -> None:
    backoff = 2
    _set_status(
        running=True,
        connected=False,
        started_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
    )
    while True:
        for url in WS_URLS:
            try:
                await _listen_once(url)
                backoff = 2
            except Exception as exc:
                _set_status(connected=False, last_error=f"{type(exc).__name__}: {exc}")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)


def _thread_main() -> None:
    try:
        if not _acquire_collector_lock():
            _set_local_status(
                running=False,
                connected=False,
                last_error="collector already running in another process",
            )
            return
        asyncio.run(_collector_loop())
    except Exception as exc:
        _set_status(running=False, connected=False, last_error=f"{type(exc).__name__}: {exc}")


def start_liquidation_collector() -> dict:
    global _thread
    external_status = _read_status_file()
    if external_status and external_status.get("running") and _status_is_fresh(external_status):
        return external_status

    if _thread is not None and _thread.is_alive():
        return get_liquidation_status()

    if not _acquire_collector_lock():
        if external_status:
            return external_status
        _set_local_status(
            running=False,
            connected=False,
            last_error="collector already running in another process",
        )
        return get_liquidation_status()

    _thread = threading.Thread(target=_thread_main, name="liquidation-collector", daemon=True)
    _thread.start()
    time.sleep(0.1)
    return get_liquidation_status()


def run_liquidation_collector_forever() -> None:
    if not _acquire_collector_lock():
        print("Liquidation collector is already running in another process.")
        return
    asyncio.run(_collector_loop())


def read_liquidations(symbol: str, since: pd.Timestamp | None = None) -> pd.DataFrame:
    path = os.path.join(COINS_DIR, symbol, "liquidations.csv")
    if not os.path.exists(path):
        return pd.DataFrame(columns=LIQUIDATION_COLUMNS)

    try:
        df = pd.read_csv(path)
    except Exception:
        return pd.DataFrame(columns=LIQUIDATION_COLUMNS)

    if df.empty:
        return pd.DataFrame(columns=LIQUIDATION_COLUMNS)

    for col in LIQUIDATION_COLUMNS:
        if col not in df.columns:
            df[col] = pd.NA

    df = df[LIQUIDATION_COLUMNS].drop_duplicates(subset=["event_id"], keep="last")
    df["trade_time"] = pd.to_datetime(df["trade_time"], utc=True, errors="coerce").dt.tz_localize(None)
    df["quote_qty"] = pd.to_numeric(df["quote_qty"], errors="coerce").fillna(0.0)
    if since is not None:
        since = pd.Timestamp(since)
        if since.tzinfo is not None:
            since = since.tz_convert(None)
        df = df[df["trade_time"] >= since]
    return df.dropna(subset=["trade_time"])


def liquidation_summary(symbol: str, hours: int = 24) -> dict:
    since = pd.Timestamp.now(tz="UTC").tz_convert(None) - pd.Timedelta(hours=hours)
    df = read_liquidations(symbol, since=since)
    if df.empty:
        return {
            "symbol": symbol,
            "count": 0,
            "quote_qty": 0.0,
            "long_quote_qty": 0.0,
            "short_quote_qty": 0.0,
            "latest_trade_time": None,
        }

    long_quote = df.loc[df["liquidated_side"] == "LONG", "quote_qty"].sum()
    short_quote = df.loc[df["liquidated_side"] == "SHORT", "quote_qty"].sum()
    return {
        "symbol": symbol,
        "count": int(len(df)),
        "quote_qty": float(df["quote_qty"].sum()),
        "long_quote_qty": float(long_quote),
        "short_quote_qty": float(short_quote),
        "latest_trade_time": df["trade_time"].max(),
    }


def liquidation_quote_map(symbols: list[str], hours: int = 24) -> dict[str, float]:
    symbols = list(dict.fromkeys([symbol for symbol in symbols if symbol]))
    result = {symbol: 0.0 for symbol in symbols}
    if not symbols:
        return result

    since = pd.Timestamp.now(tz="UTC").tz_convert(None) - pd.Timedelta(hours=hours)
    for symbol in symbols:
        path = os.path.join(COINS_DIR, symbol, "liquidations.csv")
        if not os.path.exists(path):
            continue
        try:
            df = pd.read_csv(path, usecols=["event_id", "trade_time", "quote_qty"])
        except Exception:
            continue
        if df.empty:
            continue
        df = df.drop_duplicates(subset=["event_id"], keep="last")
        trade_time = pd.to_datetime(df["trade_time"], utc=True, errors="coerce").dt.tz_localize(None)
        quote_qty = pd.to_numeric(df["quote_qty"], errors="coerce").fillna(0.0)
        result[symbol] = float(quote_qty[trade_time >= since].sum())
    return result


def liquidation_bars(symbol: str, interval: str, index: pd.Index) -> pd.DataFrame:
    if len(index) == 0:
        return pd.DataFrame(columns=[
            "liquidations_quote",
            "long_liquidations_quote",
            "short_liquidations_quote",
        ])

    start = pd.Timestamp(index.min())
    df = read_liquidations(symbol, since=start)
    result = pd.DataFrame(index=index)
    result["liquidations_quote"] = 0.0
    result["long_liquidations_quote"] = 0.0
    result["short_liquidations_quote"] = 0.0
    if df.empty:
        return result

    freq = "1D" if interval == "1d" else interval
    work = df.set_index("trade_time").sort_index()
    total = work["quote_qty"].resample(freq).sum()
    long_liq = work[work["liquidated_side"] == "LONG"]["quote_qty"].resample(freq).sum()
    short_liq = work[work["liquidated_side"] == "SHORT"]["quote_qty"].resample(freq).sum()

    result["liquidations_quote"] = total.reindex(result.index, fill_value=0.0)
    result["long_liquidations_quote"] = long_liq.reindex(result.index, fill_value=0.0)
    result["short_liquidations_quote"] = short_liq.reindex(result.index, fill_value=0.0)
    return result.fillna(0.0)
