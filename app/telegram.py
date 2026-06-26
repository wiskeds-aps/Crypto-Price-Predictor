import logging
import httpx
from .config import TELEGRAM_TOKEN, TELEGRAM_CHAT_ID

logger = logging.getLogger(__name__)


def send_alert(symbol: str, price: float, reasons: list[str]) -> bool:
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        return False
    sign = "🟢" if any("+" in r for r in reasons) else "🔴"
    lines = [f"{sign} <b>{symbol}</b>  <code>${price:,.4f}</code>"] + [f"  • {r}" for r in reasons]
    try:
        with httpx.Client(timeout=8) as client:
            r = client.post(
                f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
                json={"chat_id": TELEGRAM_CHAT_ID, "text": "\n".join(lines), "parse_mode": "HTML"},
            )
            r.raise_for_status()
        return True
    except Exception as e:
        logger.warning("Telegram send failed: %s", e)
        return False
