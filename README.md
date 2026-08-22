# CryptoScreener

FastAPI screener for spot coins and Binance futures with a static web UI.

## Run

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open:

```text
http://127.0.0.1:8000
```

## Windows Portable

GitHub Actions builds a portable Windows zip on pushes to the `crypto-screener` branch.

Manual local build on Windows:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\windows\Build-CryptoScreener-Portable.ps1
```

The output is:

```text
dist\CryptoScreenerPortable
```

Run:

```text
dist\CryptoScreenerPortable\Start CryptoScreener.bat
```

## Chart Indicators

Sub-panels below the price chart, toggled from the indicator bar. Most are
computed client-side from the already-loaded klines; OI and L/S pull their
own history from the backend.

| Button | Shows |
|---|---|
| OI / OI Δ% | Open interest — % change histogram or raw candles |
| CVD / CVD линия | Cumulative taker buy/sell volume delta |
| OFV | Combined OI + CVD + volume score candles |
| L/S | Long/short account ratio (% long vs % short) |
| Ликв | Liquidations, long vs short, from the Binance forceOrder stream |
| MACD | MACD(12,26,9) — fast/slow EMA, signal EMA, histogram |
| A/D | Accumulation/Distribution — cumulative Money Flow Multiplier × volume |
| Net L/S / Net L/S накоп. | Long OI − Short OI in $ (level histogram) or cumulative sum of its bar-to-bar change (line) |
| Режим | Per-bar regime classification (squeeze/flush/pressure) from price+OI+L-S+liqs |
| Плотн | Liquidity zones — BSL/SSL, equal highs/lows, session/HTF extremes |
| ST | SuperTrend(10, 3) overlay |
| VP | Volume profile |
| Сессии / IMP / FVG | Session boxes, impulse candles, fair value gaps |
| BOS / Sweep / HTF / P/D | Market structure: break of structure, liquidity sweeps, higher-timeframe levels, premium/discount |
| VWAP | Anchored VWAP |
| BB | Bollinger Bands (20, 2) |
| Score | Confluence score of the above |
| Book | Live order book panel + executed-trade liquidity bars on the chart |
| Анализ | Full read: regime, levels, suggested entries/stops/targets |
| ✎ Рис. | Toggles the drawing tools panel (cursor/ruler/level/trend/fib/note/entry) |

## Telegram Alerts

Copy `.env.example` to `.env` or export the variables before starting the app:

```bash
export TELEGRAM_TOKEN="..."
export TELEGRAM_CHAT_ID="..."
```

If the variables are empty, Telegram alerts are disabled.

## Data

The SQLite database is created locally at:

```text
data/crypto.db
```

The `data/` directory is intentionally ignored by git.
