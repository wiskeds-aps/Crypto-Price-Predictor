import logging
from datetime import datetime
import httpx
from sqlalchemy.orm import Session
from .models import Coin

logger = logging.getLogger(__name__)

COINGECKO_URL = (
    "https://api.coingecko.com/api/v3/coins/markets"
    "?vs_currency=usd"
    "&order=market_cap_desc"
    "&per_page=250"
    "&page=1"
    "&sparkline=false"
    "&price_change_percentage=1h,24h,7d"
)


def fetch_and_store(db: Session) -> int:
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.get(COINGECKO_URL, headers={"Accept": "application/json"})
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.error("CoinGecko fetch error: %s", e)
        raise

    now = datetime.utcnow()
    for item in data:
        coin = db.get(Coin, item["id"])
        if coin is None:
            coin = Coin(id=item["id"])
            db.add(coin)

        coin.symbol = item.get("symbol", "").upper()
        coin.name = item.get("name", "")
        coin.image = item.get("image")
        coin.rank = item.get("market_cap_rank") or 0
        coin.price_usd = item.get("current_price")
        coin.market_cap = item.get("market_cap")
        coin.volume_24h = item.get("total_volume")
        coin.change_1h = item.get("price_change_percentage_1h_in_currency")
        coin.change_24h = item.get("price_change_percentage_24h_in_currency")
        coin.change_7d = item.get("price_change_percentage_7d_in_currency")
        coin.ath = item.get("ath")
        coin.ath_change_pct = item.get("ath_change_percentage")
        coin.circulating_supply = item.get("circulating_supply")
        coin.total_supply = item.get("total_supply")
        coin.updated_at = now

    db.commit()
    logger.info("Fetched %d coins at %s", len(data), now)
    return len(data)
