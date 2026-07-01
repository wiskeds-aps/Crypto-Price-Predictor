import logging
from html import escape
from urllib.parse import quote

import httpx
from .config import TELEGRAM_TOKEN, TELEGRAM_CHAT_ID

logger = logging.getLogger(__name__)


def coinglass_tv_url(symbol: str | None) -> str | None:
    if not symbol:
        return None
    return f"https://www.coinglass.com/tv/Binance_{quote(symbol.upper(), safe='')}"


def _title_html(title: str, link_symbol: str | None, link_url: str | None) -> str:
    if not link_symbol or not link_url or link_symbol not in title:
        return f"<b>{escape(title)}</b>"

    before, after = title.split(link_symbol, 1)
    safe_url = escape(link_url, quote=True)
    parts = []
    if before:
        parts.append(f"<b>{escape(before)}</b>")
    parts.append(f"<a href=\"{safe_url}\">{escape(link_symbol)}</a>")
    if after:
        parts.append(f"<b>{escape(after)}</b>")
    return "".join(parts)


def send_alert(
    symbol: str,
    price: float,
    reasons: list[str],
    *,
    signal_no: int | None = None,
    link_symbol: str | None = None,
    coin_symbol: str | None = None,
) -> bool:
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        return False
    sign = "🟢" if any("+" in r for r in reasons) else "🔴"
    link_url = coinglass_tv_url(link_symbol or coin_symbol)
    title = symbol if signal_no is None else f"{symbol}  🔢 #{signal_no} за день"
    alert_reasons = list(reasons)
    lines = [
        f"{sign} {_title_html(title, link_symbol, link_url)}  <code>${price:,.4f}</code>"
    ] + [f"  • {escape(r)}" for r in alert_reasons]
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
