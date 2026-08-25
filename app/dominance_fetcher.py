import logging
from datetime import datetime

import httpx
from sqlalchemy.orm import Session

from .models import DominanceHistory

logger = logging.getLogger(__name__)

COINGECKO_GLOBAL_URL = "https://api.coingecko.com/api/v3/global"


def fetch_dominance(db: Session) -> bool:
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(COINGECKO_GLOBAL_URL, headers={"Accept": "application/json"})
            resp.raise_for_status()
            data = resp.json().get("data") or {}
    except Exception as e:
        logger.error("CoinGecko /global fetch error: %s", e)
        raise

    pct = data.get("market_cap_percentage") or {}
    now = datetime.utcnow()
    time_bucket = int(now.timestamp()) // 300 * 300  # floor to 5 min

    row = db.query(DominanceHistory).filter_by(time_bucket=time_bucket).first()
    if row is None:
        row = DominanceHistory(time_bucket=time_bucket)
        db.add(row)

    row.btc_pct = pct.get("btc")
    row.eth_pct = pct.get("eth")
    row.usdt_pct = pct.get("usdt")
    row.usdc_pct = pct.get("usdc")
    row.total_market_cap_usd = (data.get("total_market_cap") or {}).get("usd")
    row.updated_at = now

    db.commit()
    logger.info(
        "Fetched dominance at %s: BTC %.2f%% ETH %.2f%% USDT %.2f%% USDC %.2f%%",
        now, row.btc_pct or 0, row.eth_pct or 0, row.usdt_pct or 0, row.usdc_pct or 0,
    )
    return True
