import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import httpx


EXCHANGE_LABELS = {
    "binance": "Binance",
    "bybit": "Bybit",
    "okx": "OKX",
    "gate": "Gate",
    "hyperliquid": "Hyperliquid",
}
DEFAULT_EXCHANGES = ("binance", "bybit", "okx", "gate", "hyperliquid")
_SPEC_TTL_SEC = 10 * 60
_spec_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _float(value: Any, default: float | None = None) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return n if math.isfinite(n) else default


def _symbol_parts(symbol: str) -> tuple[str, str] | None:
    sym = str(symbol or "").upper().replace("-", "").replace("_", "")
    for quote in ("USDT", "USDC", "BUSD", "FDUSD", "USD"):
        if sym.endswith(quote) and len(sym) > len(quote):
            return sym[:-len(quote)], quote
    return None


def _cache_get(key: str) -> dict[str, Any] | None:
    cached = _spec_cache.get(key)
    if not cached:
        return None
    ts, data = cached
    if time.time() - ts > _SPEC_TTL_SEC:
        _spec_cache.pop(key, None)
        return None
    return data


def _cache_set(key: str, data: dict[str, Any]) -> dict[str, Any]:
    _spec_cache[key] = (time.time(), data)
    return data


def _level(price: Any, qty: Any, exchange: str, qty_mult: float = 1.0, qty_quote: bool = False) -> dict[str, Any] | None:
    p = _float(price)
    q = _float(qty)
    if p is None or q is None or p <= 0 or q == 0:
        return None
    size = abs(q)
    base_qty = (size * qty_mult / p) if qty_quote else (size * qty_mult)
    if base_qty <= 0:
        return None
    return {
        "price": p,
        "qty": base_qty,
        "notional": round(p * base_qty, 2),
        "sources": [exchange],
        "source": exchange,
        "exchange_count": 1,
    }


def _range(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not rows:
        return None
    prices = [float(r["price"]) for r in rows]
    return {"min": min(prices), "max": max(prices), "levels": len(rows)}


def _source_payload(exchange: str, bids: list[dict[str, Any]], asks: list[dict[str, Any]], error: str | None = None) -> dict[str, Any]:
    best_bid = bids[0]["price"] if bids else None
    best_ask = asks[0]["price"] if asks else None
    mid = (best_bid + best_ask) / 2 if best_bid and best_ask else None
    return {
        "exchange": exchange,
        "label": EXCHANGE_LABELS.get(exchange, exchange),
        "ok": bool(bids and asks and not error),
        "error": error,
        "bids": len(bids),
        "asks": len(asks),
        "best_bid": best_bid,
        "best_ask": best_ask,
        "mid": mid,
        "bid_range": _range(bids),
        "ask_range": _range(asks),
    }


def _fetch_binance(client: httpx.Client, symbol: str, limit: int) -> dict[str, Any]:
    depth_limit = min(max(int(limit), 50), 1000)
    data = client.get(
        "https://fapi.binance.com/fapi/v1/depth",
        params={"symbol": symbol, "limit": depth_limit},
    ).raise_for_status().json()
    bids = [_level(p, q, "binance") for p, q in data.get("bids") or []]
    asks = [_level(p, q, "binance") for p, q in data.get("asks") or []]
    bids = [x for x in bids if x]
    asks = [x for x in asks if x]
    return {"exchange": "binance", "last_update_id": data.get("lastUpdateId"), "bids": bids, "asks": asks}


def _fetch_bybit(client: httpx.Client, symbol: str, limit: int) -> dict[str, Any]:
    depth_limit = min(max(int(limit), 1), 1000)
    data = client.get(
        "https://api.bybit.com/v5/market/orderbook",
        params={"category": "linear", "symbol": symbol, "limit": depth_limit},
    ).raise_for_status().json()
    if data.get("retCode") not in (0, "0"):
        raise ValueError(str(data.get("retMsg") or "Bybit error"))
    result = data.get("result") or {}
    bids = [_level(p, q, "bybit") for p, q in result.get("b") or []]
    asks = [_level(p, q, "bybit") for p, q in result.get("a") or []]
    bids = [x for x in bids if x]
    asks = [x for x in asks if x]
    return {"exchange": "bybit", "last_update_id": result.get("u"), "bids": bids, "asks": asks}


def _okx_spec(client: httpx.Client, inst_id: str, base: str, quote: str) -> dict[str, Any]:
    key = f"okx:{inst_id}"
    cached = _cache_get(key)
    if cached:
        return cached
    data = client.get(
        "https://www.okx.com/api/v5/public/instruments",
        params={"instType": "SWAP", "instId": inst_id},
    ).raise_for_status().json()
    rows = data.get("data") or []
    if not rows:
        raise ValueError("OKX instrument not found")
    item = rows[0]
    ct_val = _float(item.get("ctVal"))
    if not ct_val or ct_val <= 0:
        raise ValueError("OKX contract value missing")
    ct_ccy = str(item.get("ctValCcy") or "").upper()
    return _cache_set(key, {
        "ct_val": ct_val,
        "qty_quote": ct_ccy == quote,
        "state": item.get("state"),
        "base": base,
        "quote": quote,
    })


def _fetch_okx(client: httpx.Client, symbol: str, limit: int) -> dict[str, Any]:
    parts = _symbol_parts(symbol)
    if not parts or parts[1] != "USDT":
        raise ValueError("OKX mapper supports USDT swaps only")
    base, quote = parts
    inst_id = f"{base}-{quote}-SWAP"
    spec = _okx_spec(client, inst_id, base, quote)
    depth_limit = min(max(int(limit), 1), 400)
    data = client.get(
        "https://www.okx.com/api/v5/market/books",
        params={"instId": inst_id, "sz": depth_limit},
    ).raise_for_status().json()
    if data.get("code") != "0":
        raise ValueError(str(data.get("msg") or "OKX error"))
    result = (data.get("data") or [{}])[0]
    bids = [_level(row[0], row[1], "okx", spec["ct_val"], spec["qty_quote"]) for row in result.get("bids") or []]
    asks = [_level(row[0], row[1], "okx", spec["ct_val"], spec["qty_quote"]) for row in result.get("asks") or []]
    bids = [x for x in bids if x]
    asks = [x for x in asks if x]
    return {"exchange": "okx", "last_update_id": result.get("seqId"), "bids": bids, "asks": asks}


def _gate_spec(client: httpx.Client, contract: str) -> dict[str, Any]:
    key = f"gate:{contract}"
    cached = _cache_get(key)
    if cached:
        return cached
    data = client.get(f"https://api.gateio.ws/api/v4/futures/usdt/contracts/{contract}").raise_for_status().json()
    mult = _float(data.get("quanto_multiplier"))
    if not mult or mult <= 0:
        raise ValueError("Gate contract multiplier missing")
    return _cache_set(key, {"mult": mult, "name": data.get("name")})


def _fetch_gate(client: httpx.Client, symbol: str, limit: int) -> dict[str, Any]:
    parts = _symbol_parts(symbol)
    if not parts or parts[1] != "USDT":
        raise ValueError("Gate mapper supports USDT futures only")
    base, quote = parts
    contract = f"{base}_{quote}"
    spec = _gate_spec(client, contract)
    depth_limit = min(max(int(limit), 1), 300)
    data = client.get(
        "https://api.gateio.ws/api/v4/futures/usdt/order_book",
        params={"contract": contract, "limit": depth_limit, "with_id": "true"},
    ).raise_for_status().json()
    bids = [_level(row.get("p"), row.get("s"), "gate", spec["mult"]) for row in data.get("bids") or []]
    asks = [_level(row.get("p"), row.get("s"), "gate", spec["mult"]) for row in data.get("asks") or []]
    bids = [x for x in bids if x]
    asks = [x for x in asks if x]
    return {"exchange": "gate", "last_update_id": data.get("id"), "bids": bids, "asks": asks}


def _fetch_hyperliquid(client: httpx.Client, symbol: str, limit: int) -> dict[str, Any]:
    parts = _symbol_parts(symbol)
    if not parts:
        raise ValueError("Hyperliquid mapper needs a recognizable quote suffix")
    base, _quote = parts
    data = client.post(
        "https://api.hyperliquid.xyz/info",
        json={"type": "l2Book", "coin": base},
    ).raise_for_status().json()
    raw_bids, raw_asks = ((data.get("levels") or []) + [[], []])[:2]
    bids = [_level(row.get("px"), row.get("sz"), "hyperliquid") for row in raw_bids or []]
    asks = [_level(row.get("px"), row.get("sz"), "hyperliquid") for row in raw_asks or []]
    bids = [x for x in bids if x][:limit]
    asks = [x for x in asks if x][:limit]
    return {"exchange": "hyperliquid", "last_update_id": data.get("time"), "bids": bids, "asks": asks}


_FETCHERS = {
    "binance": _fetch_binance,
    "bybit": _fetch_bybit,
    "okx": _fetch_okx,
    "gate": _fetch_gate,
    "hyperliquid": _fetch_hyperliquid,
}


def _fetch_exchange(name: str, symbol: str, limit: int, timeout: float) -> dict[str, Any]:
    with httpx.Client(timeout=timeout, headers={"User-Agent": "cryptoskriner/1.0"}) as client:
        return _FETCHERS[name](client, symbol, limit)


def _merge_side(rows: list[dict[str, Any]], side: str, limit: int) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for row in rows:
        price = _float(row.get("price"))
        qty = _float(row.get("qty"))
        if price is None or qty is None or price <= 0 or qty <= 0:
            continue
        key = str(price)
        bucket = buckets.get(key)
        if not bucket:
            bucket = {
                "price": price,
                "qty": 0.0,
                "notional": 0.0,
                "sources": set(),
                "exchange_count": 0,
            }
            buckets[key] = bucket
        bucket["qty"] += qty
        bucket["notional"] += price * qty
        for src in row.get("sources") or [row.get("source")]:
            if src:
                bucket["sources"].add(src)
        bucket["exchange_count"] = len(bucket["sources"])
    out = []
    for item in buckets.values():
        sources = sorted(item["sources"])
        out.append({
            "price": item["price"],
            "qty": item["qty"],
            "notional": round(item["notional"], 2),
            "sources": sources,
            "source": "+".join(sources),
            "exchange_count": len(sources),
        })
    out.sort(key=lambda x: x["price"], reverse=side == "bid")
    return out[:limit]


def get_multi_orderbook(symbol: str, limit: int = 1000, exchanges: list[str] | None = None, timeout: float = 6.0) -> dict[str, Any]:
    sym = str(symbol or "").upper()
    requested = [e.strip().lower() for e in (exchanges or list(DEFAULT_EXCHANGES)) if e.strip().lower() in _FETCHERS]
    if not requested:
        requested = list(DEFAULT_EXCHANGES)

    results: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=len(requested)) as pool:
        future_map = {pool.submit(_fetch_exchange, name, sym, limit, timeout): name for name in requested}
        for future in as_completed(future_map):
            name = future_map[future]
            try:
                item = future.result()
                results.append(item)
                sources.append(_source_payload(name, item["bids"], item["asks"]))
            except Exception as exc:
                sources.append(_source_payload(name, [], [], str(exc)))

    all_bids = [row for item in results for row in item.get("bids") or []]
    all_asks = [row for item in results for row in item.get("asks") or []]
    bids = _merge_side(all_bids, "bid", max(len(all_bids), int(limit)))
    asks = _merge_side(all_asks, "ask", max(len(all_asks), int(limit)))
    best_bid = bids[0]["price"] if bids else None
    best_ask = asks[0]["price"] if asks else None
    ok_sources = [s for s in sources if s.get("ok")]
    mids = [_float(s.get("mid")) for s in ok_sources]
    mids = [m for m in mids if m and m > 0]
    reference_mid = sum(mids) / len(mids) if mids else (
        (best_bid + best_ask) / 2 if best_bid and best_ask else None
    )

    return {
        "symbol": sym,
        "source_mode": "multi",
        "last_update_id": int(time.time() * 1000),
        "event_time": int(time.time() * 1000),
        "sources": sorted(sources, key=lambda s: s["exchange"]),
        "ok_source_count": len(ok_sources),
        "best_bid": best_bid,
        "best_ask": best_ask,
        "reference_mid": reference_mid,
        "crossed": bool(best_bid and best_ask and best_bid > best_ask),
        "bid_range": _range(bids),
        "ask_range": _range(asks),
        "bids": bids,
        "asks": asks,
    }
