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
| CVD Session | Same taker delta stream as CVD, but the running sum resets to 0 at 00:00 UTC each day instead of accumulating across the whole loaded history |
| OFV | Combined OI + CVD + volume score candles |
| L/S | Long/short account ratio (% long vs % short) |
| Ликв | Liquidations, long vs short, from the Binance forceOrder stream |
| MACD | MACD(12,26,9) — fast/slow EMA, signal EMA, histogram |
| MACD MTF | MACD(12,26,9) computed from a higher timeframe (e.g. 4h MACD on a 15m chart), held across each lower-TF bar until the higher-TF bar closes |
| A/D | Accumulation/Distribution — cumulative Money Flow Multiplier × volume |
| EFI | Elder's Force Index(13) — (close − close[1]) × volume, EMA-smoothed |
| ATR | Average True Range(14), Wilder-smoothed — same calc SuperTrend and Анализ's entry/stop sizing already use internally, exposed as its own line |
| OFI | Order Flow Imbalance: (taker buy − taker sell) / (taker buy + taker sell) per bar, range -1..+1 |
| Net Delta | Raw per-bar taker buy − taker sell in $, no cumulation — the non-cumulative version of CVD |
| Net Long / Net Short | OI × long_pct or short_pct (account-ratio lens) per bar as OHLC candles, no cumulation — the absolute-$ counterpart to Net L/S's diff-only view |
| ΔNet Long / ΔNet Short | Bar-over-bar change in Net Long / Net Short (close[i] − close[i-1]), $ histogram |
| Net L/S | Long OI − Short OI in $ (total OI × L/S account-ratio spread — the "mass of traders" lens) |
| Net L/S (vol) | Same diff, but weighted by Binance's top-trader **position** ratio (`topLongShortPositionRatio`) instead of account count — the "whales" lens |
| Режим | Per-bar regime classification (squeeze/flush/pressure) from price+OI+L-S+liqs |
| Плотн | Liquidity zones — BSL/SSL, equal highs/lows, session/HTF extremes |
| ST | SuperTrend(10, 3) overlay |
| VP | Volume profile |
| Сессии / IMP / FVG | Session boxes, impulse candles, fair value gaps |
| BOS / Sweep / HTF / P/D | Market structure: break of structure, liquidity sweeps, higher-timeframe levels, premium/discount |
| VWAP | Anchored VWAP |
| BB | Bollinger Bands (20, 2) |
| Score | Confluence score panel — 0–10 density of FVG/liquidity/HTF/VWAP/impulse/sweep/premium-discount/CVD/OI factors near price, all 9 listed with active ones highlighted |
| Book | Live order book panel + executed-trade liquidity bars on the chart |
| Анализ | Full read: regime, levels, suggested entries/stops/targets |
| Обзор | Flow Report — own independent 5h/5m fetch (price by hour, taker delta, OI, Net Long/Short × 3 L/S methods, liquidations, funding, ATR context, OFI spikes, Score factors with price levels) with a plain-language verdict, decoupled from the chart's own timeframe |
| ✎ Рис. | Toggles the drawing tools panel (cursor/ruler/level/trend/rect/fib/note/entry) |

### Score factors

Score is a proximity/confluence count, not a directional signal — it's the sum
of the weights below for every factor currently sitting near price (within
~0.35% or the width of its own zone). Max weight adds up to 10.5, capped at 10.

| Factor | Weight | Checks |
|---|---|---|
| FVG | 2.0 | Unfilled Fair Value Gap near price |
| BSL/SSL | 1.5 | Liquidity zone (stop cluster) near price |
| Impulse candle | 1.25 | A sharp impulse candle in the last 12 bars |
| Sweep | 1.25 | A recent liquidity sweep (stops taken, price returned) in the last 12 bars |
| HTF level | 1.25 | Price near PDH/PDL/PWH/PWL or the day/week open |
| VWAP | 1.0 | Price near VWAP (day/week/anchored from the last impulse) |
| Premium/Discount | 0.75 | Price above vs. below the midpoint of the current range |
| CVD trend | 0.75 | CVD moved meaningfully over the last 8 bars |
| OI trend | 0.75 | Open interest moved meaningfully over the same 8 bars |

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
