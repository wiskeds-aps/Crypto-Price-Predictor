import logging
import os
from datetime import datetime, timedelta
from typing import Optional
import httpx
from sqlalchemy import delete
from sqlalchemy.orm import Session
from .models import BinanceFuture, Coin, FutureSnapshot

logger = logging.getLogger(__name__)

EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo"
TICKER_URL        = "https://fapi.binance.com/fapi/v1/ticker/24hr"
PREMIUM_URL       = "https://fapi.binance.com/fapi/v1/premiumIndex"

# how many minutes back to look for each window
WINDOWS = {"5m": 5, "15m": 15, "30m": 30, "1h": 60}
SNAPSHOT_TTL_MINUTES = 65
EXCHANGE_INFO_CACHE_TTL_SECONDS = int(os.environ.get("CRYPTOSKRINER_EXCHANGE_INFO_CACHE_TTL_SECONDS", "1800"))
_perp_symbols_cache: Optional[tuple[datetime, dict[str, dict[str, str]]]] = None


def _nearest_snapshot(snaps: list, minutes_ago: int, now: datetime) -> Optional[dict]:
    """Return the snapshot closest to (now - minutes_ago), within ±90s."""
    target = now - timedelta(minutes=minutes_ago)
    best = None
    best_delta = timedelta(seconds=91)
    for s in snaps:
        delta = abs(s.ts - target)
        if delta < best_delta:
            best_delta = delta
            best = s
    return best


def _load_perp_symbols(client: httpx.Client, now: datetime) -> dict[str, dict[str, str]]:
    global _perp_symbols_cache

    if _perp_symbols_cache:
        cached_at, symbols = _perp_symbols_cache
        age = (now - cached_at).total_seconds()
        if age < EXCHANGE_INFO_CACHE_TTL_SECONDS:
            return symbols

    info_resp = client.get(EXCHANGE_INFO_URL)
    info_resp.raise_for_status()
    symbols = {
        s["symbol"]: {"base": s["baseAsset"], "quote": s["quoteAsset"]}
        for s in info_resp.json()["symbols"]
        if s["contractType"] == "PERPETUAL" and s["status"] == "TRADING"
    }
    _perp_symbols_cache = (now, symbols)
    logger.info("Cached %d futures symbols for %ds", len(symbols), EXCHANGE_INFO_CACHE_TTL_SECONDS)
    return symbols


def fetch_futures(db: Session) -> int:
    now = datetime.utcnow()
    with httpx.Client(timeout=30) as client:
        perp_symbols = _load_perp_symbols(client, now)
        ticker_resp  = client.get(TICKER_URL);        ticker_resp.raise_for_status()
        premium_resp = client.get(PREMIUM_URL);       premium_resp.raise_for_status()

    funding_map = {p["symbol"]: p for p in premium_resp.json() if isinstance(p, dict)}

    # ── Load existing snapshots once (last 35 min) ─────────────────────────────
    cutoff = now - timedelta(minutes=SNAPSHOT_TTL_MINUTES)
    all_snaps = db.query(FutureSnapshot).filter(FutureSnapshot.ts >= cutoff).all()
    snaps_by_symbol: dict[str, list] = {}
    for s in all_snaps:
        snaps_by_symbol.setdefault(s.symbol, []).append(s)

    # ── Update futures + save new snapshot ─────────────────────────────────────
    count = 0
    new_snaps = []
    for t in ticker_resp.json():
        sym = t["symbol"]
        if sym not in perp_symbols:
            continue

        meta = perp_symbols[sym]
        fund = funding_map.get(sym, {})

        row = db.get(BinanceFuture, sym)
        if row is None:
            row = BinanceFuture(symbol=sym)
            db.add(row)

        price      = float(t["lastPrice"])   if t["lastPrice"]   else None
        qvol_24h   = float(t["quoteVolume"]) if t["quoteVolume"] else None

        row.base_asset        = meta["base"]
        row.quote_asset       = meta["quote"]
        row.last_price        = price
        row.price_change      = float(t["priceChange"])        if t["priceChange"]        else None
        row.price_change_pct  = float(t["priceChangePercent"]) if t["priceChangePercent"] else None
        row.high_24h          = float(t["highPrice"])          if t["highPrice"]          else None
        row.low_24h           = float(t["lowPrice"])           if t["lowPrice"]           else None
        row.volume_24h        = float(t["volume"])             if t["volume"]             else None
        row.quote_volume_24h  = qvol_24h
        row.mark_price        = float(fund["markPrice"])       if fund.get("markPrice")   else None
        row.index_price       = float(fund["indexPrice"])      if fund.get("indexPrice")  else None
        row.funding_rate      = float(fund["lastFundingRate"]) if fund.get("lastFundingRate") else None
        row.next_funding_time = fund.get("nextFundingTime")
        row.trades_count      = int(t["count"])                if t.get("count")          else None
        row.updated_at        = now

        # ── Short-term deltas ───────────────────────────────────────────────────
        sym_snaps = snaps_by_symbol.get(sym, [])
        for window_name, mins in WINDOWS.items():
            snap = _nearest_snapshot(sym_snaps, mins, now)
            if snap and price and snap.price:
                pct = (price - snap.price) / snap.price * 100
            else:
                pct = None
            setattr(row, f"change_{window_name}", pct)

        # volume spike: rate of volume in last 15m vs 24h average rate
        snap15 = _nearest_snapshot(sym_snaps, 15, now)
        if snap15 and qvol_24h and snap15.quote_volume_24h and qvol_24h > 0:
            elapsed_mins = max((now - snap15.ts).total_seconds() / 60, 1)
            vol_gained   = max(qvol_24h - snap15.quote_volume_24h, 0)
            rate_now     = vol_gained / elapsed_mins          # $/min in last window
            rate_avg     = qvol_24h / (24 * 60)              # $/min over 24h
            row.vol_spike = round(rate_now / rate_avg, 2) if rate_avg > 0 else None
        else:
            row.vol_spike = None

        if price and qvol_24h:
            new_snaps.append(FutureSnapshot(symbol=sym, price=price, quote_volume_24h=qvol_24h, ts=now))

        count += 1

    stale_symbols = [
        row.symbol
        for row in db.query(BinanceFuture.symbol).all()
        if row.symbol not in perp_symbols
    ]
    if stale_symbols:
        db.execute(delete(BinanceFuture).where(BinanceFuture.symbol.in_(stale_symbols)))
        db.execute(delete(FutureSnapshot).where(FutureSnapshot.symbol.in_(stale_symbols)))

    # ── Populate cg_rank from coins table ──────────────────────────────────────
    rank_map = {
        row.symbol.upper(): row.rank
        for row in db.query(Coin.symbol, Coin.rank).all()
        if row.rank
    }
    for row in db.query(BinanceFuture).all():
        row.cg_rank = rank_map.get(row.base_asset)

    # ── Persist ────────────────────────────────────────────────────────────────
    db.bulk_save_objects(new_snaps)
    db.execute(delete(FutureSnapshot).where(FutureSnapshot.ts < cutoff))
    db.commit()

    logger.info("Fetched %d futures, snapshots: +%d saved, rows kept ≤%dm",
                count, len(new_snaps), SNAPSHOT_TTL_MINUTES)
    if stale_symbols:
        logger.info("Removed %d stale futures: %s", len(stale_symbols), ", ".join(stale_symbols[:20]))
    return count
