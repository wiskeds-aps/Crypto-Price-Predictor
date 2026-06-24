#!/usr/bin/env python3
"""Small read-only web server for TimesFM forecast files."""

from __future__ import annotations

import json
import mimetypes
import csv
import time
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

WEB_ROOT = Path("/root/live")
PROJECT_ROOT = Path("/root/timesfm-project")
RIVER_CURRENT = Path("/root/river/live/forecast_1h.json")
RIVER_HISTORY = Path("/root/river/live/history_1h.csv")
CRYPTO_RIVER_CURRENT = Path("/root/live/crypto_river_24h.json")
CRYPTO_RIVER_HISTORY = Path("/root/live/crypto_river_24h_history.csv")
CURRENT = {"5m": "forecast_5m_24h.json", "1h": "forecast.json"}
INTERVALS = frozenset(CURRENT)
PRICE_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
PRICE_CACHE = {"price": None, "fetched_at": 0.0}
PRICE_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = ""
    sys_version = ""

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}")

    def send_bytes(self, data: bytes, content_type: str, status: int = 200,
                   cache_control: str = "no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, value, status: int = 200):
        self.send_bytes(json.dumps(value, ensure_ascii=False).encode(),
                        "application/json; charset=utf-8", status)

    def interval(self, query):
        value = query.get("interval", ["5m"])[0]
        return value if value in INTERVALS else None

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        request = urlparse(self.path)
        query = parse_qs(request.query)
        if request.path == "/api/time":
            return self.send_json({"utc": datetime.now(timezone.utc).isoformat()})

        if request.path == "/api/price":
            now = time.monotonic()
            if PRICE_CACHE["price"] is None or now - PRICE_CACHE["fetched_at"] >= 3:
                with PRICE_LOCK:
                    if PRICE_CACHE["price"] is None or now - PRICE_CACHE["fetched_at"] >= 3:
                        try:
                            with urlopen(PRICE_URL, timeout=5) as response:
                                source = json.load(response)
                            PRICE_CACHE.update(price=float(source["price"]), fetched_at=now)
                        except Exception as error:
                            if PRICE_CACHE["price"] is None:
                                return self.send_json({"error": f"price unavailable: {error}"}, 502)
            return self.send_json({
                "symbol": "BTCUSDT", "price": PRICE_CACHE["price"],
                "source": "Binance Spot", "updated_at": datetime.now(timezone.utc).isoformat(),
            })

        if request.path == "/api/river/current":
            if not RIVER_CURRENT.exists():
                return self.send_json({"error": "River forecast is not ready"}, 404)
            source = json.loads(RIVER_CURRENT.read_text(encoding="utf-8"))
            payload = {
                "generated_at": source["generated_at"], "symbol": source["symbol"],
                "interval": "1h", "last_close": source["last_close"],
                "model": source["model"], "mode": source["mode"],
                "forecast": [{
                    "timestamp": source["forecast_time"],
                    "point": source["river_point"],
                    "river_point": source["river_point"],
                }],
            }
            return self.send_json(payload)

        if request.path == "/api/river/history":
            if not RIVER_HISTORY.exists():
                return self.send_json({"rows": []})
            with RIVER_HISTORY.open(newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            offset = max(0, len(rows) - 500)
            return self.send_json({"rows": [{
                "id": str(offset + i), "generated_at": row["generated_at"],
                "forecast_time": row["forecast_time"], "model": row["model"],
            } for i, row in enumerate(rows[-500:])][::-1]})

        if request.path == "/api/river/history/file":
            value = query.get("id", [""])[0]
            if not value.isdigit() or not RIVER_HISTORY.exists():
                return self.send_json({"error": "invalid request"}, 400)
            with RIVER_HISTORY.open(newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            index = int(value)
            if index >= len(rows):
                return self.send_json({"error": "not found"}, 404)
            row = rows[index]
            payload = {
                "generated_at": row["generated_at"], "symbol": row["symbol"],
                "interval": row["interval"], "last_close": float(row["last_close"]),
                "model": row["model"], "mode": row["mode"],
                "forecast": [{
                    "timestamp": row["forecast_time"],
                    "point": float(row["river_point"]),
                    "river_point": float(row["river_point"]),
                }],
            }
            return self.send_json(payload)

        if request.path == "/api/crypto-river/current":
            if not CRYPTO_RIVER_CURRENT.exists():
                return self.send_json({"error": "Crypto River forecast is not ready"}, 404)
            return self.send_bytes(
                CRYPTO_RIVER_CURRENT.read_bytes(), "application/json; charset=utf-8"
            )

        if request.path == "/api/crypto-river/history":
            if not CRYPTO_RIVER_HISTORY.exists():
                return self.send_json({"rows": []})
            with CRYPTO_RIVER_HISTORY.open(newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            offset = max(0, len(rows) - 500)
            return self.send_json({"rows": [{
                "id": str(offset + i),
                "generated_at": row["generated_at"],
                "forecast_time": row["forecast_time"],
                "model": "Crypto Predictor River",
            } for i, row in enumerate(rows[-500:])][::-1]})

        if request.path == "/api/crypto-river/history/file":
            value = query.get("id", [""])[0]
            if not value.isdigit() or not CRYPTO_RIVER_HISTORY.exists():
                return self.send_json({"error": "invalid request"}, 400)
            with CRYPTO_RIVER_HISTORY.open(newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            index = int(value)
            if index >= len(rows):
                return self.send_json({"error": "not found"}, 404)
            row = rows[index]
            point = float(row["predicted_price"])
            payload = {
                "generated_at": row["generated_at"],
                "mode": "online",
                "symbol": row["symbol"],
                "interval": row["interval"],
                "horizon": row["horizon"],
                "source": "Crypto Predictor / Binance Futures",
                "model": "Crypto Predictor River",
                "candle_time": row["candle_time"],
                "forecast_time": row["forecast_time"],
                "last_close": float(row["last_close"]),
                "predicted_price": point,
                "predicted_return_pct": float(row["predicted_return_pct"]),
                "direction": row["direction"],
                "confidence": float(row["confidence"]),
                "n_samples": int(float(row["n_samples"])),
                "mae": None if row["mae"] in ("", "None") else float(row["mae"]),
                "forecast": [{
                    "timestamp": row["forecast_time"],
                    "point": point,
                    "river_point": point,
                    "predicted_return_pct": float(row["predicted_return_pct"]),
                    "direction": row["direction"],
                    "confidence": float(row["confidence"]),
                    "n_samples": int(float(row["n_samples"])),
                    "mae": None if row["mae"] in ("", "None") else float(row["mae"]),
                }],
            }
            return self.send_json(payload)

        if request.path == "/api/current":
            interval = self.interval(query)
            if not interval:
                return self.send_json({"error": "invalid interval"}, 400)
            path = PROJECT_ROOT / CURRENT[interval]
            if not path.exists():
                return self.send_json({"error": "forecast is not ready"}, 404)
            return self.send_bytes(path.read_bytes(), "application/json; charset=utf-8")

        if request.path == "/api/history":
            interval = self.interval(query)
            if not interval:
                return self.send_json({"error": "invalid interval"}, 400)
            directory = PROJECT_ROOT / "history" / interval
            files = sorted((p.name for p in directory.glob("*.json")), reverse=True)
            return self.send_json({"interval": interval, "files": files[:500]})

        if request.path == "/api/history/file":
            interval = self.interval(query)
            name = query.get("name", [""])[0]
            if not interval or Path(name).name != name or not name.endswith(".json"):
                return self.send_json({"error": "invalid request"}, 400)
            path = PROJECT_ROOT / "history" / interval / name
            if not path.is_file():
                return self.send_json({"error": "not found"}, 404)
            return self.send_bytes(path.read_bytes(), "application/json; charset=utf-8")

        relative = "index.html" if request.path == "/" else request.path.lstrip("/")
        path = WEB_ROOT / relative
        if path.parent != WEB_ROOT or not path.is_file():
            return self.send_json({"error": "not found"}, 404)
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        cache_control = ("no-cache" if path.name == "index.html" else
                         "public, max-age=3600, stale-while-revalidate=86400")
        self.send_bytes(path.read_bytes(), f"{content_type}; charset=utf-8",
                        cache_control=cache_control)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8080), Handler)
    print("Forecast site listening on 127.0.0.1:8080")
    server.serve_forever()
