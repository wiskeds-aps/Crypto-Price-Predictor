import asyncio
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import (
    Alert,
    BinanceFuture,
    Coin,
    FutureSnapshot,
    Liquidation,
    OpenInterestHistory,
    TradeLiquiditySnapshot,
)


class DatabaseCase(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()


class ConfigTests(unittest.TestCase):
    def test_load_env_file_supports_export_quotes_comments_and_existing_values(self):
        from app.config import _load_env_file

        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write("# comment\nexport TEST_CFG='hello world'\nOTHER_CFG=42\n")
            path = f.name
        try:
            with patch.dict(os.environ, {"TEST_CFG": "already"}, clear=False):
                _load_env_file(Path(path))
                self.assertEqual(os.environ["TEST_CFG"], "already")
                self.assertEqual(os.environ["OTHER_CFG"], "42")
        finally:
            os.unlink(path)
            os.environ.pop("OTHER_CFG", None)


class FetcherTests(DatabaseCase):
    def test_coingecko_fetch_upserts_coin(self):
        from app import fetcher

        payload = [{
            "id": "bitcoin", "symbol": "btc", "name": "Bitcoin",
            "market_cap_rank": 1, "current_price": 100, "market_cap": 1000,
            "total_volume": 50, "price_change_percentage_24h_in_currency": 2.5,
        }]
        response = MagicMock()
        response.json.return_value = payload
        response.raise_for_status.return_value = None
        client = MagicMock()
        client.__enter__.return_value = client
        client.get.return_value = response
        with patch.object(fetcher.httpx, "Client", return_value=client):
            self.assertEqual(fetcher.fetch_and_store(self.db), 1)
        coin = self.db.get(Coin, "bitcoin")
        self.assertEqual((coin.symbol, coin.rank, coin.price_usd), ("BTC", 1, 100))

    def test_futures_fetch_calculates_delta_spike_rank_and_removes_stale(self):
        from app import futures_fetcher

        self.db.add(Coin(id="bitcoin", symbol="BTC", name="Bitcoin", rank=7))
        self.db.add(BinanceFuture(symbol="OLD", base_asset="OLD", quote_asset="USDT"))
        now = datetime.utcnow()
        self.db.add(FutureSnapshot(symbol="BTCUSDT", price=100, quote_volume_24h=1000, ts=now - timedelta(minutes=15)))
        self.db.commit()
        exchange = {"symbols": [{"symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT", "contractType": "PERPETUAL", "status": "TRADING"}]}
        ticker = [{"symbol": "BTCUSDT", "lastPrice": "110", "quoteVolume": "2000", "priceChange": "10", "priceChangePercent": "10", "highPrice": "111", "lowPrice": "90", "volume": "20", "count": 3}]
        premium = [{"symbol": "BTCUSDT", "markPrice": "110", "indexPrice": "109", "lastFundingRate": "0.001", "nextFundingTime": 123}]

        def get(url):
            resp = MagicMock()
            resp.raise_for_status.return_value = None
            resp.json.return_value = exchange if "exchangeInfo" in url else ticker if "24hr" in url else premium
            return resp

        client = MagicMock()
        client.__enter__.return_value = client
        client.get.side_effect = get
        with patch.object(futures_fetcher, "_perp_symbols_cache", None), patch.object(futures_fetcher.httpx, "Client", return_value=client), patch.object(futures_fetcher, "datetime") as clock:
            clock.utcnow.return_value = now
            self.assertEqual(futures_fetcher.fetch_futures(self.db), 1)
        row = self.db.get(BinanceFuture, "BTCUSDT")
        self.assertAlmostEqual(row.change_15m, 10)
        self.assertEqual(row.cg_rank, 7)
        self.assertIsNone(self.db.get(BinanceFuture, "OLD"))

    def test_ls_fetcher_maps_ratios_and_percentages(self):
        from app import ls_fetcher

        payloads = {
            "globalLongShortAccountRatio": [{"longShortRatio": "2", "longAccount": "0.667", "shortAccount": "0.333"}],
            "takerlongshortRatio": [{"buySellRatio": "1.5"}],
            "topLongShortAccountRatio": [{"longShortRatio": "3", "longAccount": "0.75", "shortAccount": "0.25"}],
            "topLongShortPositionRatio": [{"longShortRatio": "4", "longAccount": "0.8", "shortAccount": "0.2"}],
        }
        client = MagicMock()
        def get(url, **_):
            response = MagicMock(); response.raise_for_status.return_value = None
            response.json.return_value = next(v for k, v in payloads.items() if k in url)
            return response
        client.get.side_effect = get
        result = ls_fetcher._fetch_symbol("BTCUSDT", client)
        self.assertEqual(result["ls_taker_ratio"], 1.5)
        self.assertEqual(result["ls_long_pct"], 66.7)
        self.assertEqual(result["ls_top_short_pct"], 20.0)

    def test_oi_fetcher_calculates_changes_and_cvd(self):
        from app import oi_fetcher

        oi = [{"timestamp": i * 300000, "sumOpenInterest": str(100 + i), "sumOpenInterestValue": str(10000 + i * 100)} for i in range(14)]
        klines = [[0, "0", "0", "0", "0", "0", 0, "100", 0, 0, "60"] for _ in range(5)]
        client = MagicMock()
        def get(url, **_):
            response = MagicMock(); response.raise_for_status.return_value = None
            response.json.return_value = oi if "openInterestHist" in url else klines
            return response
        client.get.side_effect = get
        result = oi_fetcher._fetch_symbol("BTCUSDT", client)
        self.assertEqual(result["oi_value"], 113.0)
        self.assertAlmostEqual(result["oi_change_5m"], 100 / 112 - 1 if False else (113 / 112 - 1) * 100)
        self.assertEqual(result["cvd_1h"], 80.0)
        self.assertEqual(result["taker_buy_pct"], 60.0)


class HistoryTests(DatabaseCase):
    def test_oi_parse_deduplicates_and_upsert_updates(self):
        from app.oi_history import parse_oi_points, upsert_oi_history, query_oi_history

        rows = parse_oi_points("btcusdt", "5m", [
            {"timestamp": 120000, "sumOpenInterest": "10", "sumOpenInterestValue": "100"},
            {"timestamp": 120001, "sumOpenInterest": "11", "sumOpenInterestValue": "110"},
            {"timestamp": "bad", "sumOpenInterest": 1},
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual(upsert_oi_history(self.db, rows), 1)
        rows[0]["sum_open_interest"] = 12
        upsert_oi_history(self.db, rows)
        self.db.commit()
        self.assertEqual(query_oi_history(self.db, "BTCUSDT", "5m", 10)[0].sum_open_interest, 12)

    def test_trade_history_aggregates_persistent_zones_and_filters_threshold(self):
        from app.trade_history import parse_trade_window, query_trade_liquidity_zones

        self.assertEqual(parse_trade_window("2h"), ("2h", 7200))
        self.assertEqual(parse_trade_window("nonsense")[0], "5m")
        zone = {"side": "buy", "price": 100, "qty": 2, "notional": 200, "maxNotional": 200, "count": 2, "lower": 99, "upper": 101, "step": 2}
        for bucket in (100, 160):
            self.db.add(TradeLiquiditySnapshot(symbol="BTCUSDT", time_bucket=bucket, step=2, buy_notional=200, sell_notional=0, trade_count=2, zones_json=json.dumps([zone])))
        self.db.commit()
        result = query_trade_liquidity_zones(self.db, "btcusdt", window="5m", ranges=2, min_notional=100, now_sec=200)
        self.assertEqual(result["sample_count"], 2)
        self.assertEqual(len(result["zones"]), 1)
        self.assertEqual(result["zones"][0]["side"], "buy")


class CollectorTests(DatabaseCase):
    def test_liquidation_bucket_and_flush_accumulate(self):
        from app import liq_collector

        self.assertEqual(liq_collector._bucket(61_001), 60)
        liq_collector.SessionLocal = self.Session
        liq_collector._write_snapshot({("BTCUSDT", 60): [100, 50]})
        liq_collector._write_snapshot({("BTCUSDT", 60): [25, 10]})
        row = self.db.query(Liquidation).one()
        self.assertEqual((row.long_liq_usd, row.short_liq_usd), (125, 60))
        self.assertEqual(len(liq_collector._iter_force_orders(json.dumps({"o": {}}))), 1)

    def test_trade_collector_buckets_notional_and_serializes_zones(self):
        from app import trade_collector

        trade_collector._buf.clear(); trade_collector._dirty.clear()
        trade_collector._bucket_trade("BTCUSDT", 61_000, "buy", 100, 2)
        trade_collector._bucket_trade("BTCUSDT", 61_500, "sell", 101, 1)
        item = next(iter(trade_collector._buf.values()))
        row = trade_collector._row_from_item(item)
        self.assertEqual(row["trade_count"], 2)
        self.assertEqual(row["buy_notional"], 200)
        zones = json.loads(row["zones_json"])
        self.assertEqual({z["side"] for z in zones}, {"buy", "sell"})

    def test_trade_collector_accepts_wrapped_binance_trade_message(self):
        from app import trade_collector

        trade_collector._buf.clear(); trade_collector._dirty.clear()
        trade_collector._handle_trade_raw(json.dumps({"stream": "btcusdt@trade", "data": {"e": "trade", "s": "BTCUSDT", "p": "100", "q": "2", "T": 60_000, "m": True}}))
        item = next(iter(trade_collector._buf.values()))
        self.assertEqual(item["sell_notional"], 200)


class ExchangeAndTelegramTests(unittest.TestCase):
    def test_orderbook_helpers_normalize_and_merge_levels(self):
        from app.multi_orderbook import _level, _merge_side, _symbol_parts

        self.assertEqual(_symbol_parts("btc-usdt"), ("BTC", "USDT"))
        self.assertIsNone(_level("bad", 1, "x"))
        merged = _merge_side([_level(100, 2, "binance"), _level(100, 3, "bybit"), _level(101, 1, "okx")], "bid", 10)
        self.assertEqual(merged[0]["price"], 101)
        self.assertEqual(merged[1]["qty"], 5)
        self.assertEqual(set(merged[1]["sources"]), {"binance", "bybit"})

    def test_telegram_escapes_title_and_builds_url(self):
        from app.telegram import _title_html, coinglass_tv_url

        self.assertIn("Binance_BTCUSDT", coinglass_tv_url("btcusdt"))
        html = _title_html("ПАМП BTCUSDT <x>", "BTCUSDT", "https://example.test/a?x=1")
        self.assertIn('<a href="https://example.test/a?x=1">BTCUSDT</a>', html)
        self.assertNotIn("<x>", html)

    def test_send_alert_posts_html_when_configured(self):
        from app import telegram

        response = MagicMock(); response.raise_for_status.return_value = None
        client = MagicMock(); client.__enter__.return_value = client; client.post.return_value = response
        with patch.object(telegram, "TELEGRAM_TOKEN", "token"), patch.object(telegram, "TELEGRAM_CHAT_ID", "chat"), patch.object(telegram.httpx, "Client", return_value=client):
            self.assertTrue(telegram.send_alert("BTCUSDT", 100, ["рост <2%>"], link_symbol="BTCUSDT"))
        body = client.post.call_args.kwargs["json"]
        self.assertEqual(body["parse_mode"], "HTML")
        self.assertIn("&lt;2%&gt;", body["text"])


class SignalTests(DatabaseCase):
    def test_signal_and_alert_cooldowns_prevent_duplicate_notifications(self):
        from app import signals, alerts

        future = BinanceFuture(symbol="BTCUSDT", base_asset="BTC", quote_asset="USDT", last_price=100, change_5m=1, change_15m=2, vol_spike=3)
        alert = Alert(symbol="BTCUSDT", min_change_15m=1, cooldown_min=30)
        self.db.add_all([future, alert]); self.db.commit()
        with patch.object(signals, "send_alert", return_value=True) as signal_send, patch.object(alerts, "send_alert", return_value=True) as alert_send:
            signals._cooldowns.clear()
            signals.check_signals(self.db)
            signals.check_signals(self.db)
            alerts.check_and_fire(self.db)
            alerts.check_and_fire(self.db)
        self.assertEqual(signal_send.call_count, 1)
        self.assertEqual(alert_send.call_count, 1)


class ApiTests(DatabaseCase):
    def test_coin_and_future_queries_apply_filters_and_sorting(self):
        from app.main import get_coins, get_futures

        now = datetime.utcnow()
        self.db.add_all([
            Coin(id="a", symbol="AAA", name="Alpha", rank=2, market_cap=10, change_24h=1, updated_at=now),
            Coin(id="b", symbol="BBB", name="Beta", rank=1, market_cap=20, change_24h=5, updated_at=now),
        ])
        self.db.add_all([
            BinanceFuture(symbol="AAAUSDT", base_asset="AAA", quote_asset="USDT", quote_volume_24h=10, updated_at=now),
            BinanceFuture(symbol="BBBUSDT", base_asset="BBB", quote_asset="USDT", quote_volume_24h=20, updated_at=now),
        ])
        self.db.commit()
        coins = get_coins(search="beta", sort_by="rank", order="asc", limit=100, offset=0, min_market_cap=None, max_market_cap=None, min_change_24h=None, max_change_24h=None, db=self.db)
        futures = get_futures(search="", sort_by="quote_volume_24h", order="desc", limit=100, offset=0, quote="USDT", min_change=None, max_change=None, min_volume=None, exclude_top=None, min_change_15m=None, max_change_15m=None, min_change_5m=None, max_change_5m=None, min_vol_spike=None, db=self.db)
        self.assertEqual((coins.total, coins.coins[0].id), (1, "b"))
        self.assertEqual([f.symbol for f in futures.futures], ["BBBUSDT", "AAAUSDT"])

    def test_coin_rank_zero_sorts_after_ranked_coins(self):
        from app.main import get_coins

        now = datetime.utcnow()
        self.db.add_all([
            Coin(id="unranked", symbol="ZERO", name="Zero Rank", rank=0, updated_at=now),
            Coin(id="ranked-two", symbol="TWO", name="Rank Two", rank=2, updated_at=now),
            Coin(id="ranked-one", symbol="ONE", name="Rank One", rank=1, updated_at=now),
        ])
        self.db.commit()

        asc = get_coins(search="", sort_by="rank", order="asc", limit=100, offset=0, min_market_cap=None, max_market_cap=None, min_change_24h=None, max_change_24h=None, db=self.db)
        desc = get_coins(search="", sort_by="rank", order="desc", limit=100, offset=0, min_market_cap=None, max_market_cap=None, min_change_24h=None, max_change_24h=None, db=self.db)

        self.assertEqual([c.id for c in asc.coins], ["ranked-one", "ranked-two", "unranked"])
        self.assertEqual([c.id for c in desc.coins], ["ranked-two", "ranked-one", "unranked"])


if __name__ == "__main__":
    unittest.main()
