# Changelog

## 2026-08-23 (10)

### Fixed
- **Score confluence factors silently dead without their source indicators**:
  the CVD+/-, OI+/- and VWAP factors in `_calcConfluenceScore` read from
  `_cvdLineData`/`_oiData`/`_vwapData`, but those only get populated while
  the 'cvd'/'oi'/'vwap' indicators (or a few unrelated ones like 'flow'/'ofv')
  are toggled on — unlike every other Score factor (FVG, liquidity, HTF,
  impulse, sweep, premium/discount), which already bypass their indicator's
  toggle via `force=true`. A user running Score without also having
  CVD/OI/VWAP panels open got a permanently truncated score (up to ~2.5/10.5
  of the max weight missing) with no indication anything was off. Fixed by
  making `loadKlines`'s OI fetch and `loadCVD()` trigger include `'score'`
  alongside their existing conditions, `_applyOI`'s early-return guard
  likewise, and `_activeVwapValues` gained a `force` param that computes
  VWAP headlessly (no chart series touched) when the indicator itself is
  off. Also fixed the OI recency check comparing raw `_oiData` index offsets
  (`-8`) against CVD's, when OI's own bar interval (`_OI_INTERVAL`) is
  frequently coarser than the chart's (e.g. hourly OI under a 1d/1w chart) —
  "8 bars back" meant a very different, much shorter time span for OI than
  for CVD. Now looks up the OI point as-of the same kline time as the CVD
  comparison via `_findByTime`, matching how OFV/NetLS already align OI to
  klines. Same OI-index bug fixed in `_latestFlowSignal` (feeds the
  "Анализ" panel's bias), which had the identical pattern.

### Added
- **Score legend on hover**: the Score card was a bare number and a row of
  ICT-jargon tags (BSL/SSL, FVG, PDH/PDL...) with no explanation anywhere in
  the UI. Added a native `title` tooltip (`SCORE_LEGEND_TEXT`) listing every
  factor and its weight, what the bias colors mean, and that it's a
  confluence-density meter, not a buy/sell signal. `.confluence-card` sits
  inside `.market-structure-overlay` (`pointer-events: none`), so it needed
  its own `pointer-events: auto` for the tooltip to be hoverable at all —
  added that plus `cursor: help` as the hover affordance.

## 2026-08-23 (9)

### Added
- **Vertical zoom/pan on indicator sub-panels** (OI, CVD, OFV, L/S, Ликв, MACD,
  A/D, Net L/S) — drag the right price axis up/down within any panel to
  rescale its own Y-range independently. `_makeIndChart` previously had
  `handleScale: false`, which killed this along with time-axis interaction;
  time-axis stays locked to the main chart (it's driven by
  `_setIndicatorLogicalRange`, not user input), only price-axis drag is now
  enabled — mouse wheel and pinch stay off so they don't fight the
  time-axis sync. Verified live: dragging the OI panel's axis changed its
  top label from 1.000 to 2.000.

## 2026-08-23 (8)

### Fixed
- **Journald log volume**: `logging.basicConfig(level=logging.INFO)` in
  `app/main.py` was letting httpx's own logger through at INFO too, which
  logs one line per outbound HTTP request. With ~570 tracked futures symbols
  across several fetchers plus the trade/liquidation collectors, that was
  ~1.5M journal lines in 3.3 hours (~125/s) on this deployment — the single
  biggest contributor to journald's system-wide disk usage. Set the `httpx`
  logger to WARNING explicitly; the app's own INFO messages are unaffected.

## 2026-08-23 (7)

### Added
- **"Мин $" options above 1M** (2M, 5M, 10M) for the order book panel's
  minimum-notional filter. This filters already-grouped zones by size (not
  grouping itself — that's "Групп"/"Шаг"); the deep Multi book can produce
  zones well past 1M, and there was no way to filter down to just those.
  Same setting also feeds the Tape heatmap's `min_notional` param, so it
  benefits there too.

## 2026-08-23 (6)

### Added
- **Multi order book sanity filter** (`app/multi_orderbook.py`). Drops a
  source's bid levels priced above the cross-exchange consensus mid, and ask
  levels priced below it, before merging — a source (in practice, thin-book
  Hyperliquid) can no longer plant an outlier "bid" above the whole market's
  mid and top the merged book ahead of everyone else's much deeper liquidity.
  The consensus mid is the average of each *individual* source's own mid
  (computed pre-merge), so no single source can skew its own sanity check.
  Tolerance defaults to 0.03% (`CRYPTOSKRINER_ORDERBOOK_SANITY_PCT` env var)
  — tight enough to catch the observed ~0.05-0.2% Hyperliquid divergence,
  loose enough to only drop a couple dozen rows out of ~1500 in testing.
  Verified live: Binance's real top bid now sorts ahead of Hyperliquid's
  outlier one, while Hyperliquid's normally-priced levels still merge in.

## 2026-08-23 (5)

### Added
- **Per-exchange order book source options** (Bybit, OKX, Gate, Hyperliquid,
  alongside the existing Multi/Binance) in the "Биржи" dropdown. Each single
  source reuses the `/multi-orderbook` endpoint scoped to just that exchange
  (`exchanges=<name>`), so there's no cross-exchange price blending. Added
  because Multi's merged top-of-book can look misleading: Hyperliquid's own
  best bid/ask sometimes sits ahead of Binance/Bybit/OKX by tens of dollars
  (normal cross-venue divergence), and since Hyperliquid only has ~20 levels
  total, that thin top briefly hides the much bigger walls a few dollars
  further in from Binance/Bybit/OKX. Viewing one exchange at a time sidesteps
  that entirely instead of trying to filter it out of the merge.
- Only Binance mode uses the live depth-diff WebSocket; every other single
  exchange polls its own snapshot the same way Multi does (no per-exchange
  diff-stream implementations exist yet).

## 2026-08-23 (4)

### Changed
- **Multi order book poll interval 3000ms → 1200ms** (`ORDERBOOK_MULTI_POLL_MS`).
  Multi mode has no live WebSocket — it's a plain REST poll of
  `/multi-orderbook`, so between polls the panel sat frozen for a full 3s
  while Binance-only mode (real depth-diff WS) updated continuously,
  making Multi look static by comparison. Requests stay sequential (next
  poll only fires after the previous one resolves), so this doesn't create
  overlapping requests, just polls more often.

## 2026-08-23 (3)

### Added
- **Hyperliquid as a 5th multi-orderbook source** (`app/multi_orderbook.py`).
  Public, unauthenticated `POST /info` with `{"type": "l2Book", "coin": base}`
  — no API key needed, same free-tier pattern as the other four exchanges.
  Note it natively caps at 20 levels per side (Hyperliquid's own limit, no
  depth param to raise it) — shallower than Binance/Bybit/OKX/Gate, but still
  useful for cross-venue density comparison. Bumped the aggregation thread
  pool from a hardcoded 4 workers to `len(requested)` so all 5 sources fetch
  in parallel.
- CME was also considered but isn't feasible here: no free public depth API,
  real access requires a paid CME Market Data Platform license, and its
  BTC/ETH products are dated futures rather than perpetuals, so they aren't
  directly comparable to the other four venues anyway.

## 2026-08-23 (2)

### Added
- **Order book depth options above 1000** (2000, 5000) in Binance-only mode.
  The snapshot REST call still clamps to 1000 (the exchange's own per-request
  cap), but the local book in Binance mode keeps growing from the live
  depth-diff stream past the initial snapshot; the display/prune cap
  (`_orderbookSideLevels`) previously threw that extra depth away past 1000.
  In Multi mode the higher values are a no-op — that mode has no
  accumulation, each poll fully replaces the book from a fresh snapshot
  capped by the exchanges themselves (Binance/Bybit 1000, OKX 400, Gate 300).

## 2026-08-23 (1)

### Removed
- **Dead client-side order book accumulation code** (`_sampleOrderbookAccumulation`,
  `_accumulatedOrderbookZones`, `_mergeOrderbookHeatmapSources`, plus their
  supporting state/constants). This was the pre-`/trade-zones` approach to
  building Tape heatmap zones straight from the live order book; nothing
  called it anymore since the backend trade-history endpoint took over.
  Also removed `_sameOrderbookStep`, whose only caller was this dead code.
- Along the way, found that `_stableOrderbookHeatmapGroupStep`'s step-change
  hysteresis was already unreachable — the always-empty accumulator array
  made its guard condition permanently true, so the heatmap step was already
  being recalculated fresh on every render instead of being smoothed.
  Simplified the function to match that actual behavior; no functional change.

## 2026-08-22

### Added
- **MACD(12,26,9) indicator panel** — fast/slow EMA, signal EMA, histogram. Computed
  client-side from klines, no new API endpoint.
- **A/D (Accumulation/Distribution) indicator panel** — cumulative Money Flow
  Multiplier × volume. Same client-side computation approach as MACD.
- Both are off by default and follow the same toggle/crosshair-sync/hover-marker
  plumbing as the existing OI/CVD/L-S/Liq panels.
- **Bollinger Bands (20, 2) overlay** — main-chart overlay (shares the price
  scale with candles), following the VWAP/SuperTrend pattern instead of the
  MACD/A-D sub-panel one. Off by default.
- **Net L/S (Long OI − Short OI, $) indicator panel** — total OI × the L/S
  account ratio spread, as a time series (the futures table's LONG OI/SHORT OI
  columns are the same math but only a current-moment snapshot). Off by
  default.
- **Toggle button for the drawing tools panel** — it was always pinned open
  over the chart; now it can be hidden (on by default, same as before).
- **L/S account ratio now accumulates history** (`ls_ratio_history` table +
  `app/ls_history.py`), mirroring the OI history system. Previously
  `/api/futures/{symbol}/ls-ratio` was a pure live passthrough to Binance
  capped at 500 points — the actual ceiling, not a bug, but the same
  shallow-history problem OI used to have. The L/S panel and Net L/S now
  build up the same kind of growing backlog OI already does.

### Fixed
- **OI chart truncated to ~500 rows regardless of accumulated history.**
  `/api/futures/{symbol}/oi` shared one `limit` param between the local DB
  query and the live Binance top-up call, both capped at 500 (Binance's own
  limit). The DB now gets up to 5000 rows while the Binance call stays
  clamped to 500 — longer chart timeframes now show the actual backlog in
  `open_interest_history` instead of the last ~500 candles' worth.
- **MACD panel rendered shifted off its true time position.** The ~34-bar EMA
  warmup period was dropped from the series data instead of kept as
  whitespace points. Since the MACD panel is its own lightweight-charts
  instance, sharing the main chart's logical range then rendered the whole
  indicator bunched toward the tail of the panel. Every point-per-kline
  panel (OI, CVD, L/S, Liq) already relies on this; MACD now does too.
- **MACD hover didn't show a value under the cursor**, only the fixed
  last-value badge. MACD was missing from the hover-marker system
  (`_HOVER_MARKER_KEYS` / `_renderHoverMarker`) that gives OI/CVD/OFV/L-S/Liq
  their colored dot-on-the-line + value chip that follows the crosshair.
- **Режим (regime) track overflowed and clipped the newest bars.** Up to
  1000 `.flow-seg` elements (one per kline) each had a 1px `min-width` +
  1px `gap`, needing ~2000px in a ~1300px-wide track. The excess overflowed
  past the container and got clipped by the panel's `overflow: hidden`,
  silently dropping the most recent bars while the rest rendered bunched to
  fill the visible width.
- **Режим track stretched over the reserved right-edge blank space when
  zoomed in.** Even after the above fix, the track always flexed its
  segments to fill 100% of its width — but the visible logical range can
  extend past the last real candle into the chart's `rightOffset` padding.
  At the default fitted view that's a negligible ~0.5% of the range; zoomed
  in near the live edge it's a large fraction, so the real segments
  stretched to cover it too and the colored strip ended visibly glued to
  the right edge, well past where the last candle actually sits (measured
  100+ px off in testing). Now the lead/trail gap between the logical range
  and the real data is rendered as blank flex spacers, and click/hover time
  lookup accounts for the same gap.
- **Price scale lost almost all its plain numeric ticks.** Every BSL/SSL/
  session/HTF liquidity zone (Плотн) drew its price line with
  `axisLabelVisible: true`; with several zones active at once the stacked
  axis badges crowded out lightweight-charts' own tick labels almost
  entirely. Zones already have their own on-chart label
  (`.liquidity-zone-label`), so the axis badge was pure duplication — turned
  it off.
- **Bollinger Bands upper/lower bands showed a valueless "BB U"/"BB L" tag**
  on the axis (looked like only the middle band was computing). Caused by
  `lastValueVisible: false` with a `title` still set — the title alone still
  draws a bare tag. Restored `lastValueVisible: true` on all three bands so
  the axis shows real numbers for all of them.

## 2026-08-21 and earlier

See `git log` — this file starts tracking from the OI/MACD/A-D work above.
