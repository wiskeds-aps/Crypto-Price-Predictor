# Changelog

## 2026-08-23 (17)

### Fixed
- **EFI/ATR/MACD MTF from (16) didn't show a value on hover, only the
  current one** — reported by the user with a screenshot showing every
  other panel's crosshair-tracking value box (OI, CVD, MACD, Net L/S, ...)
  except these three. Cause: `_syncCrosshairAt`/`_syncCrosshairLeave` (the
  function that looks up each panel's value at the hovered time, updates
  its `.ind-label` text, and moves that panel's own crosshair marker) never
  got the three new panels added when they were introduced — every other
  sub-panel indicator has an explicit block there, EFI/ATR/MACD MTF didn't.
  Added matching blocks: EFI and ATR mirror A/D's single-series pattern,
  MACD MTF mirrors MACD's three-series (line/signal/histogram) label
  pattern, labeled with its resolved higher timeframe (e.g.
  `MACD MTF (4h)`). Also added the three to `_syncCrosshairLeave`'s
  clear-and-reset-label pass so they go back to their static titles when
  the cursor leaves the chart, same as the others. Verified live: hovering
  now updates all three labels with the value at that point in time, and
  resets on mouse-out.

## 2026-08-23 (16)

### Added
- **Three new sub-panel indicators, off by default**: EFI, ATR, MACD MTF
  (user request, after asking what these show). New toggle buttons after BB
  in the toolbar.
  - **EFI (Elder's Force Index, 13)**: `(close - close[1]) * volume`,
    smoothed with the same `_ema()` helper MACD/signal already use — reuses
    the existing "warmup nulls at the front, single non-null run after"
    contract that helper relies on. Purely client-side from `_klineData`,
    same pattern as A/D.
  - **ATR (14, Wilder)**: exposed as its own visible line. The calc already
    existed twice internally (inline in `_calcSuperTrend`, and
    `_analysisAtr()`'s single-current-value version for Анализ's entry/stop
    sizing) but was never rendered on its own; extracted the per-bar series
    version as `_calcAtrSeries()`, reusing the existing `_trueRange()`
    helper. Cross-checked against `_analysisAtr()`'s live value on the same
    chart — matched (~217 on BTCUSDT/15m at the time).
  - **MACD MTF**: MACD(12/26/9) computed from a *higher* timeframe than the
    chart's own (`_MACD_MTF_INTERVAL` map, e.g. 15m chart -> 4h MACD) and
    held across every lower-TF bar the higher-TF bar spans — the standard
    step-function MTF-indicator behavior, not an interpolation. Fetches the
    higher-TF klines via the same `/api/futures/{symbol}/klines` endpoint
    (mirrors the OI-at-a-different-interval pattern already used for OI/
    `_OI_INTERVAL`), then re-buckets onto `_klineData`'s own per-bar time
    grid in `_applyMacdMtf` — same "hold the latest completed value while
    scanning both sorted arrays once" technique `_oiToSeriesData` already
    uses for its coarser OI data, adapted to hold instead of aggregate.
    Deliberately *not* wired into the live-tick handler like EFI/ATR/MACD/
    A-D are — its value can only change when the higher-TF bar closes, so
    refetching on every trade tick would just be wasted network traffic for
    a value that's a step function 95%+ of the time.

  All three verified live (Playwright): render with no console errors,
  produce the expected data shape (EFI/ATR: null during warmup then one
  value per bar; MACD MTF: one point per *chart* bar, visibly blocky/
  stepped in a screenshot, confirming the hold-not-interpolate behavior),
  and clean up fully on toggle-off (chart destroyed, panel hidden, state
  reset) — same lifecycle as MACD/A-D/Net L/S they were modeled on.

## 2026-08-23 (15)

### Fixed
- **Switching symbols without closing the chart could stamp a foreign
  symbol's live price onto the new chart's last candle**, corrupting Score/
  Анализ (and everything else derived from `_klineData`) with it. Found
  while sanity-checking Анализ's numbers against real 1h data: opening
  BTCUSDT → ETHUSDT → SOLUSDT in sequence left SOLUSDT's chart showing
  price **$2447 instead of ~$95** — its last candle's high/close had been
  overwritten with ETHUSDT's concurrent price (matched to the cent). The
  server's REST klines for SOL were confirmed correct
  (`GET /api/futures/SOLUSDT/klines` returns ~$95.45 for that same candle)
  — the corruption was 100% client-side. `_calcTradeAnalysis` computes its
  swing high/low, premium/discount range, and every entry/stop/target off
  `_klineData`'s last candle and current price, so this one bad print
  wrecked the whole scenario (real case produced target ladders mixing
  genuine ~$90 SOL levels with a fabricated ~$2447 "price").

  Root cause: `openChart()` reset `_klineData` and started `loadKlines()`'s
  REST fetches for the *new* symbol without first stopping the *old*
  symbol's live WebSocket / REST-poll fallback — that only happened at the
  very end of `loadKlines()`, once new data had already loaded, via
  `_startRtWs()`'s own internal `_stopRtWs()` call. In the window between
  (new REST data landing, old WS still alive), an old-symbol tick passes
  every staleness guard in `_startRtWs`'s `onmessage`/`_startRtPriceFallback`
  handlers — they all check against `_rtSymbol`, which hadn't been
  reassigned yet, so from their point of view nothing looked stale — and
  gets written by `_applyLiveKlineBar` into whatever `_klineData` currently
  holds, which by then is the *new* symbol's freshly-loaded candles.
  `setTf()` (same-symbol timeframe switch) already called `_stopRtWs()`
  first, precisely to avoid this; `openChart()` was the one reload path
  missing it. Added the same call at the top of `openChart()`, closing the
  window entirely. Verified: re-ran the same BTC → ETH → SOL sequence,
  SOLUSDT now shows $95.49 with a normal candle history and realistic
  Анализ targets (93–94.6, all near current price) instead of the garbage
  ladder from before.

## 2026-08-23 (14)

### Fixed
- **"Анализ" entry zones could balloon to 1.5%+ width, unbounded, when the
  nearest opposing level was far from price**: found while checking entry
  points on user request. In `_scenarioFromSide`, the entry zone's *anchored*
  side was properly capped (long's `entryHigh` ≤ `price + buffer*0.55`,
  short's `entryLow` ≥ `price - buffer*0.55`) but the side pulled toward
  the support/resistance anchor had no such ceiling — `entryLow` (long) /
  `entryHigh` (short) could follow an anchor arbitrarily far away with
  nothing bounding it. Reproduced live on BTCUSDT/1d: the short scenario's
  entry zone (anchored to a distant BSL liquidity level) spanned
  76853.42–78121.90, 1.64% of price — not a usable "entry zone." Verified
  with a synthetic worst case too (opposing levels placed 6000pts away):
  zone width went from 7.96% down to the intended 1.2×buffer cap after the
  fix (1.47% at that ATR). Floored/capped the previously-unbounded side at
  `price ∓ buffer*1.2`, so both sides of the zone stay the same order of
  magnitude regardless of anchor distance — matches how the target ladder
  (t1/t2/t3) was already bounded relative to risk. Also removed a dead
  `?.near` branch in the entry-anchor ternary on both sides (`support.price`
  is always `< price` by construction of the `below` filter, so
  `Math.min(price, support.price)` always equalled `support.price` either
  way — the `near` check never actually changed the result; simplified to
  `support ? support.price : price`).

### Added
- **"Анализ" panel: анкор level + risk % + a "как читать" explainer**,
  addressing the same "just numbers with no explanation" gap Score had.
  `_scenarioFromSide` already computed `anchor` (which support/resistance
  level the entry/stop is based on, e.g. "VWAP IMPULSE"/"D Open") but
  `_scenarioHtml` never rendered it — added an "Опора" row to the entry
  grid. Added risk % next to the stop price (`Стоп ... · риск 1.07%`).
  Added a "Как читать" block at the bottom explaining what Bias/confidence,
  Опора, R, триггер, and отмена mean in plain terms, replacing the single
  one-line disclaimer that was there before.

## 2026-08-23 (13)

### Changed
- **Score: hover card → click-to-open panel, same pattern as "Анализ"**
  (user request: make Score work the way Анализ does — press the button,
  panel opens with everything, not a hover-only popup). Replaced the small
  floating `.confluence-card` + its `.confluence-legend` hover popup
  entirely with `#score-panel` (new, `.score-panel` in `style.css`,
  positioned top-left at `left:112px` to clear `.drawing-panel`, both
  default-on): a persistent panel, toggled by the existing "Score" toolbar
  button exactly like `#analysis-panel`/"Анализ" — header with the score and
  a close `×`, a bias-colored progress bar, and **all 9 factors listed**,
  not just the ones currently firing — active ones highlighted green with
  their live detail (`Bull FVG`, `CVD+`, ...), inactive ones dimmed, so it
  reads as "here's everything Score considers and what's happening right
  now" rather than a terse tag list. `_calcConfluenceScore` now returns a
  `factors: [{weight, label, active, detail}]` array (alongside the
  existing `score`/`tags`/`bias`, unchanged for `_deriveAnalysisBias`/
  `_calcTradeAnalysis` compat) instead of just accumulating `tags`. Wired
  through `_renderScorePanel()`, called from `_renderAnalysisPanel()` (so it
  refreshes everywhere Анализ already does — live ticks, symbol/timeframe
  switches, resize) and explicitly on toggle in `toggleInd('score')` so it
  appears/updates immediately on click rather than waiting for the next
  tick. This also sidesteps the whole z-index-trap class of bug from (12)
  outright — the panel is a direct `#chart-container` sibling like
  `#analysis-panel`, not nested inside `.market-structure-overlay`, so
  there's no stacking-context trap to fight. Verified with the same
  Playwright setup: toggle off clears content + hides, toggle back on
  restores it with the right active/inactive counts, the panel's own close
  button correctly calls back into `toggleInd` and un-toggles the toolbar
  button too.

## 2026-08-23 (12)

### Fixed
- **Score hover popup never actually received the pointer**: verified live
  with a headless-browser test (Playwright, since no project skill or
  chromium-cli was available — installed Playwright's client + its own
  Chromium into a throwaway venv for this). `elementFromPoint()` at the
  card's center returned the chart library's own internal CANVAS, not
  `.confluence-card`, regardless of the card's own `pointer-events`/`z-index`
  set in (10)/(11). Root cause: `.market-structure-overlay` is
  `position:absolute` with an explicit `z-index:2`, which makes it establish
  its own stacking context — trapping any child z-index (including the
  card's) so it can only win/lose paint order *within* that context, never
  against outside siblings. The chart library's canvas, nested inside a
  chain of non-positioned wrapper elements, resolves to the same effective
  z-index:2 one level up (in `#chart-container`'s stacking context) as
  `.market-structure-overlay` itself — and on that tie, the later-DOM
  element wins hit-testing, which was the canvas. Raising the *child's*
  z-index could never fix this; raised `.market-structure-overlay`'s own
  z-index from 2 to 4 (past the canvas and `.orderbook-heatmap-overlay`'s 3,
  still below `.analysis-panel`'s 5) instead. Confirmed fixed:
  `elementFromPoint()` now returns the card/its children, and
  `.confluence-legend` computed `display: block` on hover.
- **Legend popup could get silently clipped**: `#chart-container` (the
  popup's nearest ancestor) has `overflow: hidden`, and the popup opens
  upward from a card anchored to the *main pane's* bottom — with several
  indicator sub-panels stacked below eating vertical space, the main pane
  can be short enough that the full-height popup's top portion renders
  above the container's own top edge and gets hard-clipped, with no way to
  scroll to it. Added `max-height: min(60vh, 280px); overflow-y: auto` plus
  tighter row/paragraph spacing so the common case fits without scrolling
  and the worst case scrolls instead of losing content outright.
- **`_calcConfluenceScore` cost ~5.6ms/call, not caused by (10)/(11) but
  found while investigating a "feels slow" report**: benchmarked in the
  same headless-browser session (200 iterations after live WS ticks) —
  1111ms/200 iters = 5.56ms avg before, confirmed unrelated to this
  session's earlier Score changes (VWAP/OI/CVD fixes add O(1)/O(log n) work
  at most, and don't run at all when the chart's default indicators —
  including 'vwap'/'oi'/'cvd' — are on, which they were in this test). Real
  cause is pre-existing: `_calcImbalances` (has an O(n²)
  fill-status scan per candidate gap) and `_calcImpulseEvents` (O(n) with a
  sort-based median per bar) are each recomputed 3-4x per single render
  pass — once for their own chart-drawing loop, again inside
  `_calcConfluenceScore`, again inside `_nearestLevelCandidates`/
  `_latestFlowSignal` for the "Анализ" panel — since none of it was
  memoized. `_redrawLiveOverlays` runs this whole chain on every Binance
  trade tick via `_scheduleMarketStructure()` + `_renderAnalysisPanel()`, so
  the redundancy compounds continuously while a chart is open. Added a
  `_klineFingerprint()`-keyed cache (length + last bar's time/close, so it
  naturally invalidates on every new bar and every live-tick update to the
  last bar) to both functions — repeat calls within the same tick now hit
  the cache instead of recomputing. Re-benchmarked: ~0.5ms/call warm, ~9x
  faster than before, with the fix functions' outputs unchanged.

## 2026-08-23 (11)

### Fixed
- **Score legend tooltip from (10) wasn't actually visible in practice**: it
  used a native `[title]` attribute, which needs the cursor to sit still for
  ~1s (OS/browser dependent) before rendering — tested live and looked like
  it simply didn't work. Replaced `SCORE_LEGEND_TEXT` with
  `SCORE_LEGEND_HTML` rendered into a `.confluence-legend` child div, shown
  via plain CSS `:hover` (`display: none` → `block`) — appears the instant
  the pointer enters the card, no native tooltip delay to wait out.

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
