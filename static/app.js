// ── Persisted UI state ─────────────────────────────────────────────────────────
const SCREENER_SETTINGS_STORAGE_KEY = 'cryptoskriner.screenerSettings.v1';
const CHART_TF_STORAGE_KEY = 'cryptoskriner.chartTf.v1';
const CHART_INDS_STORAGE_KEY = 'cryptoskriner.chartIndicators.v1';

// ── State ──────────────────────────────────────────────────────────────────────
let currentTab  = 'spot';
let activeQuick = 'all';
let lsMethod    = 'top_pos'; // 'global' | 'top_pos' | 'top_acc'

function setLsMethod(method) {
  lsMethod = method;
  document.querySelectorAll('.ls-method-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.method === method)
  );
  _saveScreenerSettings();
  loadFutures();
}

// ── Alerts ─────────────────────────────────────────────────────────────────────
let alertSymbol = null;
let alertsCache = {};   // symbol → [alert, ...]

async function openAlertModal(symbol, e) {
  e.stopPropagation();
  alertSymbol = symbol;
  document.getElementById('alert-symbol-title').textContent = symbol;
  ['al-vol','al-min5','al-max5','al-min15','al-max15'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('al-cooldown').value = '30';
  document.getElementById('alert-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  await loadAlertList();
}

function closeAlertModal() {
  document.getElementById('alert-modal').classList.remove('open');
  document.body.style.overflow = '';
}

function handleAlertModalClick(e) {
  if (e.target === document.getElementById('alert-modal')) closeAlertModal();
}

async function loadAlertList() {
  const res  = await fetch('/api/alerts');
  const all  = await res.json();
  // cache by symbol
  alertsCache = {};
  all.forEach(a => {
    (alertsCache[a.symbol] = alertsCache[a.symbol] || []).push(a);
  });
  // update bell button highlights
  document.querySelectorAll('.alert-btn').forEach(btn => {
    const sym = btn.dataset.sym;
    btn.classList.toggle('has-alert', !!(alertsCache[sym] && alertsCache[sym].some(a => a.active)));
  });
  renderAlertList(alertsCache[alertSymbol] || []);
}

function renderAlertList(alerts) {
  const el = document.getElementById('alert-list');
  if (!alerts.length) { el.innerHTML = '<div class="muted" style="font-size:12px">Нет алертов для этой монеты</div>'; return; }
  el.innerHTML = alerts.map(a => {
    const parts = [];
    if (a.min_vol_spike != null) parts.push(`спайк ≥ ${a.min_vol_spike}×`);
    if (a.min_change_5m  != null) parts.push(`5м > ${a.min_change_5m}%`);
    if (a.max_change_5m  != null) parts.push(`5м < ${a.max_change_5m}%`);
    if (a.min_change_15m != null) parts.push(`15м > ${a.min_change_15m}%`);
    if (a.max_change_15m != null) parts.push(`15м < ${a.max_change_15m}%`);
    const last = a.last_triggered ? 'сраб. ' + new Date(a.last_triggered + 'Z').toLocaleTimeString('ru-RU') : 'не срабатывал';
    return `<div class="alert-item${a.active ? '' : ' inactive'}">
      <div class="alert-item-desc"><b>${a.symbol}</b> · ${parts.join(', ') || '—'} · cooldown ${a.cooldown_min}м</div>
      <span class="alert-item-last">${last}</span>
      <button class="alert-toggle-btn" onclick="toggleAlert(${a.id})">${a.active ? 'Пауза' : 'Вкл'}</button>
      <button class="alert-del-btn"    onclick="deleteAlert(${a.id})">✕</button>
    </div>`;
  }).join('');
}

async function createAlert() {
  const p = new URLSearchParams({ symbol: alertSymbol });
  const vol  = document.getElementById('al-vol').value;
  const min5 = document.getElementById('al-min5').value;
  const max5 = document.getElementById('al-max5').value;
  const min15= document.getElementById('al-min15').value;
  const max15= document.getElementById('al-max15').value;
  const cool = document.getElementById('al-cooldown').value;
  if (vol)   p.set('min_vol_spike',   vol);
  if (min5)  p.set('min_change_5m',   min5);
  if (max5)  p.set('max_change_5m',   max5);
  if (min15) p.set('min_change_15m',  min15);
  if (max15) p.set('max_change_15m',  max15);
  if (cool)  p.set('cooldown_min',    cool);
  if (![vol,min5,max5,min15,max15].some(Boolean)) {
    alert('Укажи хотя бы одно условие'); return;
  }
  await fetch('/api/alerts?' + p, { method: 'POST' });
  await loadAlertList();
}

async function deleteAlert(id) {
  await fetch('/api/alerts/' + id, { method: 'DELETE' });
  await loadAlertList();
}

async function toggleAlert(id) {
  await fetch('/api/alerts/' + id + '/toggle', { method: 'PATCH' });
  await loadAlertList();
}

// ── Favourites (localStorage) ──────────────────────────────────────────────────
const favorites = new Set(JSON.parse(localStorage.getItem('fav_futures') || '[]'));

function toggleFavorite(symbol, e) {
  e.stopPropagation();
  if (favorites.has(symbol)) favorites.delete(symbol);
  else favorites.add(symbol);
  localStorage.setItem('fav_futures', JSON.stringify([...favorites]));
  document.querySelectorAll(`.fav-btn[data-sym="${symbol}"]`).forEach(btn => {
    btn.classList.toggle('active', favorites.has(symbol));
  });
  if (activeQuick === 'fav') loadFutures();
}

// ── Chart state ────────────────────────────────────────────────────────────────
let chart        = null;
let candleSeries = null;
let volSeries    = null;
let chartSymbol  = null;
let chartTf      = _loadChartTf();
let chartFuture  = null;
let _klineData   = [];

// ── Real-time WebSocket ────────────────────────────────────────────────────────
let _rtWs        = null;
let _rtSymbol    = null;
let _rtTf        = null;
let _rtLastTickAt = 0;
let _rtPricePollTimer = null;
let _rtChartPriceTimer = null;
let _rtChartPricePending = null;
let _rtChartPriceLastPatchAt = 0;
let _spotPriceWss = [];
let _spotPriceWsKey = '';
let _spotPriceReconnectTimer = null;
let _spotPriceSymbols = new Set();
let _spotPricePending = new Map();
let _spotPriceCells = new Map();
let _spotPriceFlushRaf = null;
let _futuresPriceWss = [];
let _futuresPriceWsKey = '';
let _futuresPriceReconnectTimer = null;
let _futuresPriceSymbols = new Set();
let _futuresPricePending = new Map();
let _futuresPriceCells = new Map();
let _futuresPriceFlushRaf = null;
const SPOT_PRICE_STREAM_URL = 'wss://stream.binance.com:9443/stream?streams=!miniTicker@arr';
const SPOT_PRICE_WS_RECONNECT_MS = 3000;
const FUTURES_PRICE_STREAM_URL = 'wss://fstream.binance.com/market/stream?streams=!miniTicker@arr';
const FUTURES_PRICE_WS_RECONNECT_MS = 3000;
const TABLE_PRICE_FLASH_MS = 320;
const CHART_PRICE_PATCH_MS = 250;
const CHART_RIGHT_OFFSET = 5;
const CHART_KLINE_LIMIT = 1000;
const CHART_INDICATOR_LIMIT = 500;
// OI history is served from our own accumulated DB, not a live Binance call,
// so it isn't bound to Binance's 500-row cap the way L/S ratio and liqs are.
const CHART_OI_LIMIT = 5000;
const CHART_TEXT_COLOR = '#aeb8c4';
const CHART_BORDER_COLOR = '#4a5568';
const CHART_SCALE_STORAGE_KEY = 'cryptoskriner.chartScaleMode.v1';
const RT_WS_STALE_MS = 5000;
const RT_PRICE_POLL_MS = 2000;
const LIQ_LONG_COLOR = '#f59e0b';
const LIQ_SHORT_COLOR = '#38bdf8';
const LIQUIDITY_BUY_COLOR = '#d29922';
const LIQUIDITY_SELL_COLOR = '#38bdf8';
const LIQUIDITY_ZONES_PER_SIDE = 3;
const LIQUIDITY_SENIOR_TF_SECONDS = 3600;
const LIQUIDITY_SENIOR_MIN_AGE_SECONDS = 3600;
const ORDERBOOK_HEATMAP_DEFAULT_RANGES = 6;
const ORDERBOOK_HEATMAP_RANGE_OPTIONS = [2, 4, 6, 8, 10, 12];
const ORDERBOOK_HEATMAP_WINDOW_OPTIONS = ['5m', '15m', '1h', '4h', '24h'];
const ORDERBOOK_HEATMAP_RANGE_PCT_OPTIONS = [0.015, 0.035, 0.07, 0.15, 0.30, 1.0];
const ORDERBOOK_HEATMAP_DEFAULT_RANGE_PCT = 0.035;
const ORDERBOOK_PANEL_ROW_OPTIONS = [15, 25, 50, 100, 200];
const ORDERBOOK_PANEL_DEFAULT_ROWS = 50;
const ORDERBOOK_PANEL_RANGE_PCT_OPTIONS = [0.005, 0.015, 0.035, 0.07, 0.15, 0.30, 1.0];
const ORDERBOOK_PANEL_DEFAULT_RANGE_PCT = 0.15;
const ORDERBOOK_SOURCE_OPTIONS = ['multi', 'binance'];
const ORDERBOOK_DEFAULT_SOURCE = 'multi';
const ORDERBOOK_HEATMAP_MIN_NOTIONAL = 15000;
const ORDERBOOK_HEATMAP_ENABLED = true;
const ORDERBOOK_HEATMAP_LABEL_GAP_PX = 16;
const ORDERBOOK_HEATMAP_STEP_MULT = 4;
const ORDERBOOK_HEATMAP_NEAR_PRICE_PCT = 0.012;
const ORDERBOOK_HEATMAP_MAX_STEP_PCT = 0.00025;
const ORDERBOOK_ACCUM_WINDOW_MS = 5 * 60 * 1000;
const ORDERBOOK_ACCUM_SAMPLE_MS = 1500;
const ORDERBOOK_HEATMAP_RENDER_MS = ORDERBOOK_ACCUM_SAMPLE_MS;
const ORDERBOOK_ACCUM_MIN_HITS = 2;
const ORDERBOOK_HISTORY_ENABLED = true;
const ORDERBOOK_HISTORY_REFRESH_MS = 15000;
const ORDERBOOK_SETTINGS_STORAGE_KEY = 'cryptoskriner.orderbookSettings.v3';
const ORDERBOOK_DEFAULT_SETTINGS = {
  sourceMode: ORDERBOOK_DEFAULT_SOURCE,
  rows: ORDERBOOK_PANEL_DEFAULT_ROWS,
  depthLimit: 1000,
  updateSpeed: '500ms',
  groupMode: 'auto',
  groupStep: 0,
  minNotional: 0,
  panelRangePct: ORDERBOOK_PANEL_DEFAULT_RANGE_PCT,
  heatmapRanges: ORDERBOOK_HEATMAP_DEFAULT_RANGES,
  heatmapWindow: '5m',
  heatmapStep: 0,
  heatmapRangePct: ORDERBOOK_HEATMAP_DEFAULT_RANGE_PCT,
};
const ORDERBOOK_WS_RECONNECT_MS = 2500;
const ORDERBOOK_MULTI_POLL_MS = 3000;
const ORDERBOOK_WS_BUFFER_LIMIT = 1200;
const ORDERBOOK_GROUP_MIN_TICKS = 8;
const ORDERBOOK_RENDER_MIN_MS = 250;
const ORDERBOOK_WATCHDOG_MS = 3000;
const ORDERBOOK_STALE_MS = 12000;
const ORDERBOOK_SYNC_TIMEOUT_MS = 8000;
const SUPER_TREND_PERIOD = 10;
const SUPER_TREND_MULT = 3;
const SUPER_TREND_UP_COLOR = '#3fb950';
const SUPER_TREND_DOWN_COLOR = '#f85149';
const SESSION_DEFS = [
  { key: 'asia',    label: 'Азия',    startHour: 0,  endHour: 8 },
  { key: 'london',  label: 'Лондон',  startHour: 7,  endHour: 16 },
  { key: 'newyork', label: 'Нью-Йорк', startHour: 13, endHour: 22 },
];
let liquidityZoneLines = [];
let liquidityZones = [];
let _liqZoneOverlayRaf = null;
let superTrendUpSeries = null;
let superTrendDownSeries = null;
let _superTrendData = [];
let _marketStructureRaf = null;
let _orderbookData = null;
let _orderbookRaf = null;
let _orderbookHeatmapTimer = null;
let _orderbookHeatmapLastRenderAt = 0;
let _orderbookOverlayHtml = '';
let _orderbookHeatmapStableStep = 0;
let _orderbookHeatmapStableSymbol = null;
let _orderbookSeq = 0;
let _orderbookPanelRaf = null;
let _orderbookPanelTimer = null;
let _orderbookWs = null;
let _orderbookWsSymbol = null;
let _orderbookReconnectTimer = null;
let _orderbookPollTimer = null;
let _orderbookWatchdogTimer = null;
let _orderbookBook = { bids: new Map(), asks: new Map() };
let _orderbookBookSources = [];
let _orderbookBookMeta = {};
let _orderbookPendingEvents = [];
let _orderbookSnapshotId = null;
let _orderbookLastUpdateId = null;
let _orderbookLastEventAt = 0;
let _orderbookLastRenderAt = 0;
let _orderbookSnapshotLoadedAt = 0;
let _orderbookDataDirty = false;
let _orderbookDirtySymbol = null;
let _orderbookDirtyEventTime = null;
let _orderbookSynced = false;
let _orderbookSettings = _loadOrderbookSettings();
let _orderbookAccumSamples = [];
let _orderbookAccumLastSampleAt = 0;
let _orderbookAccumStep = 0;
let _orderbookAccumSymbol = null;
let _orderbookHistoryZones = [];
let _orderbookHistoryMeta = null;
let _orderbookHistoryKey = '';
let _orderbookHistoryLoading = false;
let _orderbookHistoryLoaded = false;
let _orderbookHistoryLoadedAt = 0;
let _orderbookHistorySeq = 0;
let _orderbookAutoscaleRange = null;
let vwapDaySeries = null;
let vwapWeekSeries = null;
let vwapImpulseSeries = null;
let _vwapData = { day: [], week: [], impulse: [] };

// Volume Profile
const VP_BUCKETS   = 150;
const VP_MAX_WIDTH = 0.18;   // max bar width as fraction of chart width
const VP_VA_PCT    = 0.70;   // Value Area = 70% of total volume
const VP_AXIS_W    = 68;     // px reserved for price scale on the right
let _vpCanvas = null;
let _vpRaf    = null;

// Indicator charts
let oiChart = null, oiSeries = null, oiHistSeries = null, oiCandleSeries = null;
let cvdChart = null, cvdSeries = null, cvdLineSeries = null, cvdCandleSeries = null;
let ofvChart = null, ofvSeries = null, ofvZeroLine = null;
let lsChart  = null, lsLongSeries = null, lsShortSeries = null;
let liqChart = null, liqLongSeries = null, liqShortSeries = null;
let macdChart = null, macdLineSeries = null, macdSignalSeries = null, macdHistSeries = null;

// Sequence counter: incremented on every loadKlines() call.
// Async handlers capture their seq at start and bail if it changed.
let _loadSeq = 0;

// Prevents re-entrant crosshair sync when setCrosshairPosition fires move events
let _crosshairBusy = false;
let _hoverMarkerLocked = false;
let _hoverMarkerTime = null;
let _hoverMarkerPrice = null;
const DRAW_STORAGE_PREFIX = 'cryptoskriner.drawings.v1';
const DRAW_AXIS_W = VP_AXIS_W;
let _drawTool = 'cursor';
let _drawings = [];
let _drawSelectedId = null;
let _drawDraft = null;
let _drawDrag = null;
let _drawLastClick = null;
let _drawOverlayRaf = null;
let chartScaleMode = _readChartScaleMode();

// Indicator data caches for crosshair value lookup
let _oiData  = [];
let _oiHistData = [];
let _oiCandleData = [];
let _oiHistScale = 0.05;
let _lastOiReloadAt = 0;
let _lsData  = [];
let _cvdData = [];
let _cvdLineData = [];
let _cvdCandleData = [];
let _ofvData = [];
let _ofvCandleData = [];
let _liqData = [];  // [{time, long_usd, short_usd}] — 1m buckets
let _macdData = [];
let _macdPrec = 4;
let _flowData = [];
let _flowVisibleData = [];
let _flowLeadGap = 0;
let _flowTrailGap = 0;
let _oiStartTime = null;
let _lsStartTime = null;

function _safeJsonRead(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function _safeJsonWrite(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

function _loadChartTf() {
  try {
    const saved = localStorage.getItem(CHART_TF_STORAGE_KEY);
    return ['1m','3m','5m','15m','30m','1h','2h','4h','12h','1d','1w'].includes(saved) ? saved : '15m';
  } catch (_) {
    return '15m';
  }
}

function _saveChartTf() {
  try { localStorage.setItem(CHART_TF_STORAGE_KEY, chartTf); } catch (_) {}
}

function _syncChartTfButtons() {
  document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === chartTf));
}

// Binary search: find last entry with entry.time <= time
function _findByTime(arr, time) {
  let lo = 0, hi = arr.length - 1, res = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= time) { res = arr[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res;
}

function _readChartScaleMode() {
  try {
    return localStorage.getItem(CHART_SCALE_STORAGE_KEY) === 'log' ? 'log' : 'linear';
  } catch (_) {
    return 'linear';
  }
}

function _chartScaleModeValue() {
  const modes = window.LightweightCharts?.PriceScaleMode || {};
  return chartScaleMode === 'log'
    ? (modes.Logarithmic ?? 1)
    : (modes.Normal ?? 0);
}

function _updateChartScaleButtons() {
  document.querySelectorAll('.scale-btn[data-scale]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scale === chartScaleMode);
  });
}

function _applyChartScaleMode() {
  _updateChartScaleButtons();
  if (!chart) return;
  try {
    chart.priceScale('right').applyOptions({ mode: _chartScaleModeValue() });
    _renderLiquidityZones();
    _scheduleMarketStructure();
    _scheduleOrderbookHeatmap();
    _renderVolumeProfile();
    _scheduleDrawings();
  } catch (e) {
    console.warn('Price scale mode error:', e);
  }
}

function setChartScaleMode(mode) {
  const next = mode === 'log' ? 'log' : 'linear';
  if (chartScaleMode === next) {
    _updateChartScaleButtons();
    return;
  }
  chartScaleMode = next;
  try { localStorage.setItem(CHART_SCALE_STORAGE_KEY, chartScaleMode); } catch (_) {}
  _applyChartScaleMode();
}

const _HOVER_MARKER_KEYS = ['price', 'oi', 'cvd', 'ofv', 'ls', 'liq', 'macd'];

function _hoverMarkerEl() {
  return document.getElementById('chart-hover-marker');
}

function _hideHoverMarkerItem(root, name) {
  const chip = root?.querySelector(`[data-marker-chip="${name}"]`);
  const dot  = root?.querySelector(`[data-marker-dot="${name}"]`);
  if (chip) chip.style.display = 'none';
  if (dot)  dot.style.display = 'none';
}

function _hideHoverMarker(clearLock = false) {
  const root = _hoverMarkerEl();
  if (!root) return;
  root.classList.remove('visible');
  if (clearLock) {
    _hoverMarkerLocked = false;
    _hoverMarkerTime = null;
    _hoverMarkerPrice = null;
    root.classList.remove('locked');
  }
  _HOVER_MARKER_KEYS.forEach(name => _hideHoverMarkerItem(root, name));
}

function _mainPriceFromParam(param) {
  if (!param?.point || !candleSeries) return null;
  let price = null;
  try { price = candleSeries.coordinateToPrice(param.point.y); } catch (_) { price = null; }
  return Number.isFinite(Number(price)) ? Number(price) : null;
}

function _formatHoverMarkerTime(time) {
  const d = new Date(time * 1000);
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function _signedLarge(v) {
  const value = Number(v || 0);
  return `${value >= 0 ? '+' : '-'}${fmt.large(Math.abs(value))}`;
}

function _signedOfv(v) {
  const value = Number(v || 0);
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function _clip(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function _absPercentile(values, pct, fallback) {
  const sorted = values
    .map(v => Math.abs(Number(v)))
    .filter(v => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct)));
  return sorted[idx] || fallback;
}

function _setHoverMarkerItem(root, innerRect, left, name, panelId, series, value, text) {
  const chip = root.querySelector(`[data-marker-chip="${name}"]`);
  const dot  = root.querySelector(`[data-marker-dot="${name}"]`);
  const panel = document.getElementById(panelId);
  if (!chip || !dot || !panel || !series || value == null || !panel.getClientRects().length) {
    _hideHoverMarkerItem(root, name);
    return;
  }

  let y = null;
  try { y = series.priceToCoordinate(value); } catch (_) { y = null; }
  if (!Number.isFinite(y)) {
    _hideHoverMarkerItem(root, name);
    return;
  }

  const panelRect = panel.getBoundingClientRect();
  const top = panelRect.top - innerRect.top + y;
  const right = panelRect.right - innerRect.left - 4;
  chip.textContent = text;
  chip.style.left = `${right}px`;
  chip.style.top = `${top}px`;
  chip.style.display = '';
  dot.style.left = `${left}px`;
  dot.style.top = `${top}px`;
  dot.style.display = '';
}

function _renderHoverMarker(time, mainPrice = null) {
  const root = _hoverMarkerEl();
  const inner = document.querySelector('#chart-modal .modal-inner');
  const main = document.getElementById('chart-container');
  const axis = document.getElementById('chart-time-axis');
  if (!root || !inner || !main || !axis || !chart || time == null) {
    _hideHoverMarker();
    return;
  }

  let x = null;
  try { x = chart.timeScale().timeToCoordinate(time); } catch (_) { x = null; }
  if (!Number.isFinite(x)) {
    root.classList.remove('visible');
    return;
  }

  const innerRect = inner.getBoundingClientRect();
  const mainRect = main.getBoundingClientRect();
  const axisRect = axis.getBoundingClientRect();
  const left = mainRect.left - innerRect.left + x;
  const minLeft = mainRect.left - innerRect.left;
  const maxLeft = mainRect.right - innerRect.left;
  if (left < minLeft - 1 || left > maxLeft + 1) {
    root.classList.remove('visible');
    return;
  }

  _hoverMarkerTime = time;
  root.classList.add('visible');
  root.classList.toggle('locked', _hoverMarkerLocked);

  const top = mainRect.top - innerRect.top;
  const bottom = axisRect.bottom - innerRect.top;
  const vline = root.querySelector('.chart-hover-vline');
  if (vline) {
    vline.style.left = `${left}px`;
    vline.style.top = `${top}px`;
    vline.style.height = `${Math.max(0, bottom - top)}px`;
  }

  const timeLabel = root.querySelector('.chart-hover-time');
  if (timeLabel) {
    const labelMinLeft = mainRect.left - innerRect.left + 58;
    const labelMaxLeft = mainRect.right - innerRect.left - 58;
    const labelLeft = Math.max(labelMinLeft, Math.min(labelMaxLeft, left));
    timeLabel.textContent = _formatHoverMarkerTime(time);
    timeLabel.style.left = `${labelLeft}px`;
    timeLabel.style.top = `${axisRect.top - innerRect.top + 5}px`;
  }

  const lockLabel = root.querySelector('.chart-hover-lock');
  if (lockLabel) {
    const lockMaxLeft = mainRect.right - innerRect.left - 58;
    lockLabel.style.left = `${Math.min(left + 8, lockMaxLeft)}px`;
    lockLabel.style.top = `${top + 8}px`;
  }

  _HOVER_MARKER_KEYS.forEach(name => _hideHoverMarkerItem(root, name));

  const k = _findByTime(_klineData, time);
  if (k && candleSeries) {
    let displayPrice = Number.isFinite(Number(mainPrice)) ? Number(mainPrice) : null;
    if (displayPrice == null && _hoverMarkerLocked && time === _hoverMarkerTime && Number.isFinite(Number(_hoverMarkerPrice))) {
      displayPrice = Number(_hoverMarkerPrice);
    }
    if (displayPrice == null) displayPrice = k.close;
    _hoverMarkerPrice = displayPrice;
    _setHoverMarkerItem(root, innerRect, left, 'price', 'chart-container', candleSeries, displayPrice, fmt.price(displayPrice));
  }

  if (oiSeries && _oiData.length) {
    const od = _findByTime(_oiData, time);
    if (od) {
      const rawPct = od.pct ?? 0;
      const value = oiMode === 'candles' ? (od.close ?? od.value) : (od.displayPct ?? rawPct);
      const text = oiMode === 'candles'
        ? fmt.oi(value)
        : `${rawPct >= 0 ? '+' : ''}${rawPct.toFixed(3)}%`;
      _setHoverMarkerItem(root, innerRect, left, 'oi', 'oi-panel', oiSeries, value, text);
    }
  }

  if (cvdSeries && _cvdData.length) {
    const cd = _findByTime(_cvdData, time);
    if (cd) {
      const value = cvdMode === 'candles' ? (cd.close ?? cd.value) : cd.value;
      _setHoverMarkerItem(root, innerRect, left, 'cvd', 'cvd-panel', cvdSeries, value, _signedLarge(value));
    }
  }

  if (ofvSeries && _ofvData.length) {
    const fd = _findByTime(_ofvData, time);
    if (fd) {
      const value = fd.close ?? fd.value;
      _setHoverMarkerItem(root, innerRect, left, 'ofv', 'ofv-panel', ofvSeries, value, _signedOfv(value));
    }
  }

  if (lsLongSeries && _lsData.length) {
    const ld = _findByTime(_lsData, time);
    if (ld) {
      _setHoverMarkerItem(root, innerRect, left, 'ls', 'ls-panel', lsLongSeries, ld.long_pct, `L ${ld.long_pct.toFixed(1)}%`);
    }
  }

  if (liqLongSeries && liqShortSeries && _liqData.length) {
    const lq = _findByTime(_liqData, time);
    if (lq) {
      const useShort = (lq.short_usd || 0) >= (lq.long_usd || 0);
      const value = useShort ? (lq.short_usd || 0) : -(lq.long_usd || 0);
      const series = useShort ? liqShortSeries : liqLongSeries;
      const text = useShort ? `S ${fmt.large(lq.short_usd || 0)}` : `L ${fmt.large(lq.long_usd || 0)}`;
      _setHoverMarkerItem(root, innerRect, left, 'liq', 'liq-panel', series, value, text);
    }
  }

  if (macdLineSeries && _macdData.length) {
    const md = _findByTime(_macdData, time);
    if (md) {
      const text = `${md.macd >= 0 ? '+' : ''}${md.macd.toFixed(_macdPrec)}`;
      _setHoverMarkerItem(root, innerRect, left, 'macd', 'macd-panel', macdLineSeries, md.macd, text);
    }
  }
}

function _refreshHoverMarker() {
  const root = _hoverMarkerEl();
  if (root?.classList.contains('visible') && _hoverMarkerTime != null) {
    _renderHoverMarker(_hoverMarkerTime, _hoverMarkerPrice);
  }
}

function _maybeRefreshOI(force = false) {
  if (!_klineData.length || !chartSymbol) return;
  if (!activeInds.has('oi') && !activeInds.has('flow') && !activeInds.has('ofv') && !activeInds.has('analysis')) return;
  const now = Date.now();
  if (!force && now - _lastOiReloadAt < 60_000) return;
  _lastOiReloadAt = now;
  loadOI();
}

// ── Drawing tools ─────────────────────────────────────────────────────────────
function _drawingOverlayEl() {
  return document.getElementById('drawing-overlay');
}

function _drawingStorageKey() {
  return `${DRAW_STORAGE_PREFIX}.${chartSymbol || 'none'}.${chartTf || 'none'}`;
}

function _newDrawingId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function _cloneDrawing(d) {
  return d ? JSON.parse(JSON.stringify(d)) : null;
}

function _isTextInputTarget(target) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
}

function _loadDrawings() {
  _drawSelectedId = null;
  _drawDraft = null;
  _drawDrag = null;
  try {
    const raw = localStorage.getItem(_drawingStorageKey());
    const parsed = raw ? JSON.parse(raw) : [];
    _drawings = Array.isArray(parsed) ? parsed.filter(_validDrawing) : [];
  } catch (_) {
    _drawings = [];
  }
  _updateDrawToolbar();
  _scheduleDrawings();
}

function _saveDrawings() {
  try { localStorage.setItem(_drawingStorageKey(), JSON.stringify(_drawings)); } catch (_) {}
}

function _validPoint(p) {
  return p && Number.isFinite(Number(p.time)) && Number.isFinite(Number(p.price));
}

function _validDrawing(d) {
  if (!d || !d.type || !d.id) return false;
  if (d.type === 'hline') return Number.isFinite(Number(d.price));
  if (d.type === 'note') return _validPoint(d.p) && typeof d.text === 'string' && d.text.trim().length > 0;
  if (d.type === 'entry') return _validPoint(d.entry) && _validPoint(d.stop) && _validPoint(d.target) && Math.abs(Number(d.entry.price) - Number(d.stop.price)) > 0;
  return (d.type === 'trend' || d.type === 'ruler' || d.type === 'fib') && _validPoint(d.p1) && _validPoint(d.p2);
}

function _resetDrawingSession(clearOverlay = false) {
  _drawTool = 'cursor';
  _drawSelectedId = null;
  _drawDraft = null;
  _drawDrag = null;
  _drawLastClick = null;
  if (clearOverlay) _drawings = [];
  _updateDrawToolbar();
  _scheduleDrawings();
}

function _cancelDrawingInteraction() {
  if (_drawDraft || _drawTool !== 'cursor') {
    _drawDraft = null;
    _drawTool = 'cursor';
    _updateDrawToolbar();
    _scheduleDrawings();
    return true;
  }
  return false;
}

function setDrawTool(tool) {
  if (!['cursor', 'ruler', 'hline', 'trend', 'fib', 'note', 'entry'].includes(tool)) tool = 'cursor';
  _drawDraft = null;
  _drawDrag = null;
  _drawLastClick = null;
  _drawTool = _drawTool === tool && tool !== 'cursor' ? 'cursor' : tool;
  _updateDrawToolbar();
  _scheduleDrawings();
}

function _updateDrawToolbar() {
  document.querySelectorAll('.draw-btn[data-draw-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.drawTool === _drawTool);
  });
  const delBtn = document.getElementById('draw-delete-btn');
  if (delBtn) delBtn.classList.toggle('enabled', !!_drawSelectedId);
  const status = document.getElementById('drawing-panel-status');
  if (status) {
    const labels = {
      cursor: 'Курсор', ruler: 'Линейка', hline: 'Уровень',
      trend: 'Тренд', fib: 'Фибо', note: 'Заметка', entry: 'Сделка',
    };
    const draftHint = _drawDraft ? ' · продолжите рисовать' : '';
    status.textContent = `${labels[_drawTool] || 'Курсор'} · рисунков ${_drawings.length}${draftHint}`;
  }
  const overlay = _drawingOverlayEl();
  if (overlay) overlay.classList.toggle('drawing-capturing', _drawTool !== 'cursor' || !!_drawDraft || !!_drawDrag);
}

function _pointerToChartPoint(ev) {
  const container = document.getElementById('chart-container');
  if (!container || !chart || !candleSeries) return null;
  const rect = container.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  // Lightweight Charts' time scale ends before the price axis.  Do not use a
  // fixed axis width here: the axis width changes with the number of digits
  // and was the reason drawings could be shifted or clipped.
  const plotRight = Math.max(0, Number(chart.timeScale().width?.()) || rect.width - DRAW_AXIS_W);
  if (x < 0 || y < 0 || x > plotRight || y > rect.height) return null;
  let time = null;
  let price = null;
  try { time = chart.timeScale().coordinateToTime(x); } catch (_) { time = null; }
  try { price = candleSeries.coordinateToPrice(y); } catch (_) { price = null; }
  time = Number(time);
  price = Number(price);
  if (!Number.isFinite(time) || !Number.isFinite(price)) return null;
  // Keep drawing anchors on real candles. This makes a line stay attached to
  // the same candle after zooming, scrolling, or changing the live bar.
  const nearest = _nearestKlineIndex(time);
  if (nearest >= 0) time = Number(_klineData[nearest].time);
  return { time, price, x, y };
}

function _pointToCoordinate(p) {
  if (!_validPoint(p) || !chart || !candleSeries) return null;
  let x = null;
  let y = null;
  try { x = chart.timeScale().timeToCoordinate(Number(p.time)); } catch (_) { x = null; }
  try { y = candleSeries.priceToCoordinate(Number(p.price)); } catch (_) { y = null; }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function _priceToCoordinate(price) {
  if (!candleSeries || !Number.isFinite(Number(price))) return null;
  let y = null;
  try { y = candleSeries.priceToCoordinate(Number(price)); } catch (_) { y = null; }
  return Number.isFinite(y) ? y : null;
}

function _scheduleDrawings() {
  if (_drawOverlayRaf) return;
  _drawOverlayRaf = requestAnimationFrame(() => {
    _drawOverlayRaf = null;
    _renderDrawings();
  });
}

function _svgEl(name, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v != null) el.setAttribute(k, String(v));
  });
  return el;
}

function _drawLine(svg, d, x1, y1, x2, y2, extraClass = '') {
  const selected = d.id === _drawSelectedId;
  const cls = `drawing-line ${d.type}${selected ? ' selected' : ''}${extraClass ? ' ' + extraClass : ''}`;
  svg.appendChild(_svgEl('line', { x1, y1, x2, y2, class: cls }));
  const hit = _svgEl('line', {
    x1, y1, x2, y2,
    class: 'drawing-hit',
    'data-drawing-id': d.id,
    'data-drag-part': d.type === 'hline' ? 'price' : 'move',
  });
  svg.appendChild(hit);
}

function _drawHandle(svg, d, x, y, part, force = false) {
  if (!force && d.id !== _drawSelectedId && !d.draft) return;
  svg.appendChild(_svgEl('circle', {
    cx: x, cy: y, r: 5,
    class: `drawing-handle${d.id === _drawSelectedId ? ' selected' : ''}`,
    'data-drawing-id': d.id,
    'data-drag-part': part,
  }));
}

function _drawLabel(svg, x, y, text, cls = '', extra = {}) {
  const label = _svgEl('text', {
    x, y,
    class: `drawing-label${cls ? ' ' + cls : ''}`,
    ...extra,
  });
  label.textContent = text;
  svg.appendChild(label);
}

function _cleanNoteText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function _askNoteText(current = '') {
  const text = window.prompt(current ? 'Изменить заметку' : 'Текст заметки', current);
  return text == null ? null : _cleanNoteText(text);
}

function _noteLines(text) {
  const words = _cleanNoteText(text).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 26 && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
    if (lines.length >= 3) break;
  }
  if (line && lines.length < 4) lines.push(line);
  if (!lines.length) lines.push('Заметка');
  if (lines.length > 4) lines.length = 4;
  const last = lines[lines.length - 1] || '';
  const source = _cleanNoteText(text);
  const visible = lines.join(' ');
  if (source.length > visible.length && last.length > 1) {
    lines[lines.length - 1] = `${last.slice(0, Math.max(1, last.length - 1))}…`;
  }
  return lines;
}

function _signedPriceDelta(v) {
  const sign = v >= 0 ? '+' : '-';
  const abs = Math.abs(v);
  let s;
  if (abs >= 1) {
    s = '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else {
    s = '$' + abs.toPrecision(4);
  }
  return sign + s;
}

function _nearestKlineIndex(time) {
  if (!_klineData.length || !Number.isFinite(Number(time))) return -1;
  let lo = 0, hi = _klineData.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (_klineData[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(_klineData[lo - 1].time - time) < Math.abs(_klineData[lo].time - time)) return lo - 1;
  return lo;
}

function _rulerLabel(d) {
  const p1 = d.p1;
  const p2 = d.p2;
  const delta = p2.price - p1.price;
  const pct = p1.price ? (delta / p1.price) * 100 : 0;
  const i1 = _nearestKlineIndex(p1.time);
  const i2 = _nearestKlineIndex(p2.time);
  const bars = i1 >= 0 && i2 >= 0 ? Math.abs(i2 - i1) : Math.round(Math.abs(p2.time - p1.time) / ((_TF_MS[chartTf] || 60000) / 1000));
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%  ${_signedPriceDelta(delta)}  ${bars} бар`;
}

const DRAW_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

function _drawFib(svg, d, p1, p2, plotRight, chartHeight) {
  const selected = d.id === _drawSelectedId;
  const startX = Math.max(0, Math.min(p1.x, p2.x));
  const endX = Math.min(plotRight, Math.max(plotRight, p1.x, p2.x));
  const delta = Number(p2.price) - Number(p1.price);
  const fillTop = Math.min(p1.y, p2.y);
  const fillHeight = Math.min(chartHeight, Math.max(2, Math.abs(p2.y - p1.y)));

  svg.appendChild(_svgEl('rect', {
    x: startX,
    y: fillTop,
    width: Math.max(1, endX - startX),
    height: fillHeight,
    class: `drawing-fib-zone${selected ? ' selected' : ''}`,
  }));
  DRAW_FIB_LEVELS.forEach(level => {
    const price = Number(p1.price) + delta * level;
    // Use the anchor geometry as a guaranteed fallback. This also keeps the
    // levels visible while the price scale is being recalculated after zoom.
    const geometricY = Number(p1.y) + (Number(p2.y) - Number(p1.y)) * level;
    const scaledY = _priceToCoordinate(price);
    const y = Number.isFinite(scaledY) ? scaledY : geometricY;
    if (!Number.isFinite(y)) return;
    const cls = `drawing-fib-line${selected ? ' selected' : ''}${d.draft ? ' draft' : ''}`;
    svg.appendChild(_svgEl('line', {
      x1: startX, y1: y, x2: endX, y2: y, class: cls,
      stroke: selected ? '#f0b429' : 'rgba(210, 153, 34, .9)',
      'stroke-width': selected ? 1.5 : 1,
    }));
    const pctText = `${(level * 100).toFixed(1).replace('.0', '')}%`;
    // Keep both labels together just to the left of the line's left edge.
    // Right-aligning them makes the text grow away from the line instead of
    // covering the Fibonacci levels.
    // If the line starts close to the chart border there is no room outside;
    // keep the labels inside in that case so the price cannot be clipped.
    const outside = startX >= 90;
    const labelX = outside ? startX - 8 : 6;
    const labelAttrs = { 'text-anchor': outside ? 'end' : 'start' };
    _drawLabel(svg, labelX, y - 7, pctText, d.draft ? 'draft' : '', labelAttrs);
    _drawLabel(svg, labelX, y + 8, fmt.price(price), `fib-price${d.draft ? ' draft' : ''}`, labelAttrs);
  });
  _drawHandle(svg, d, p1.x, p1.y, 'p1');
  _drawHandle(svg, d, p2.x, p2.y, 'p2');
}

function _projectEntryTarget(entry, stop, time = null) {
  const entryPrice = Number(entry.price);
  const stopPrice = Number(stop.price);
  const targetPrice = entryPrice + (entryPrice - stopPrice) * 2;
  return {
    time: Number.isFinite(Number(time)) ? Number(time) : stop.time,
    price: targetPrice,
  };
}

function _drawNote(svg, d, point, plotRight, chartHeight) {
  const lines = _noteLines(d.text);
  const maxChars = Math.max(...lines.map(line => line.length), 6);
  const boxW = Math.min(250, Math.max(76, maxChars * 7 + 18));
  const boxH = lines.length * 15 + 12;
  const preferAbove = point.y > boxH + 24;
  let x = point.x + 10;
  let y = preferAbove ? point.y - boxH - 10 : point.y + 10;
  x = Math.max(4, Math.min(x, Math.max(4, plotRight - boxW - 4)));
  y = Math.max(4, Math.min(y, Math.max(4, chartHeight - boxH - 4)));
  const selected = d.id === _drawSelectedId;

  svg.appendChild(_svgEl('line', {
    x1: point.x,
    y1: point.y,
    x2: x + 10,
    y2: y + boxH / 2,
    class: `drawing-note-stem${selected ? ' selected' : ''}`,
  }));
  svg.appendChild(_svgEl('circle', {
    cx: point.x,
    cy: point.y,
    r: selected ? 5 : 4,
    class: `drawing-note-pin${selected ? ' selected' : ''}`,
    'data-drawing-id': d.id,
    'data-drag-part': 'move',
  }));
  svg.appendChild(_svgEl('rect', {
    x,
    y,
    width: boxW,
    height: boxH,
    rx: 4,
    ry: 4,
    class: `drawing-note-box${selected ? ' selected' : ''}`,
    'data-drawing-id': d.id,
    'data-drag-part': 'move',
  }));

  const text = _svgEl('text', {
    x: x + 9,
    y: y + 17,
    class: 'drawing-note-text',
  });
  lines.forEach((line, idx) => {
    const tspan = _svgEl('tspan', { x: x + 9, dy: idx === 0 ? 0 : 15 });
    tspan.textContent = line;
    text.appendChild(tspan);
  });
  svg.appendChild(text);
}

function _entryStats(d) {
  const entry = Number(d.entry.price);
  const stop = Number(d.stop.price);
  const target = Number(d.target.price);
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;
  const dir = target >= entry ? 'long' : 'short';
  return { entry, stop, target, risk, reward, rr, dir };
}

function _drawTradeLine(svg, d, y, x1, x2, cls, label) {
  svg.appendChild(_svgEl('line', { x1, y1: y, x2, y2: y, class: `entry-line ${cls}` }));
  const text = _svgEl('text', { x: Math.max(6, x2 - 92), y: y - 5, class: `entry-label ${cls}` });
  text.textContent = label;
  svg.appendChild(text);
}

function _drawEntry(svg, d, plotRight) {
  const entryPoint = _pointToCoordinate(d.entry);
  const stopPoint = _pointToCoordinate(d.stop);
  const targetPoint = _pointToCoordinate(d.target);
  if (!entryPoint || !stopPoint || !targetPoint) return;

  const stats = _entryStats(d);
  const selected = d.id === _drawSelectedId;
  const x1 = _clip(entryPoint.x, 0, plotRight);
  const x2 = _clip(Math.max(entryPoint.x + 54, stopPoint.x, targetPoint.x), 0, plotRight);
  const width = Math.max(54, x2 - x1);
  const right = Math.min(plotRight, x1 + width);
  const rewardTop = Math.min(entryPoint.y, targetPoint.y);
  const rewardHeight = Math.max(2, Math.abs(targetPoint.y - entryPoint.y));
  const riskTop = Math.min(entryPoint.y, stopPoint.y);
  const riskHeight = Math.max(2, Math.abs(stopPoint.y - entryPoint.y));

  svg.appendChild(_svgEl('rect', {
    x: x1, y: rewardTop, width, height: rewardHeight,
    class: `entry-zone reward ${stats.dir}${selected ? ' selected' : ''}`,
    'data-drawing-id': d.id,
    'data-drag-part': 'move',
  }));
  svg.appendChild(_svgEl('rect', {
    x: x1, y: riskTop, width, height: riskHeight,
    class: `entry-zone risk ${stats.dir}${selected ? ' selected' : ''}`,
    'data-drawing-id': d.id,
    'data-drag-part': 'move',
  }));

  _drawTradeLine(svg, d, entryPoint.y, x1, right, 'entry', `Entry ${fmt.price(stats.entry)}`);
  _drawTradeLine(svg, d, stopPoint.y, x1, right, 'stop', `Stop ${fmt.price(stats.stop)}`);
  _drawTradeLine(svg, d, targetPoint.y, x1, right, 'target', `TP ${fmt.price(stats.target)}`);
  _drawLabel(svg, x1 + 6, Math.min(rewardTop, riskTop) - 8, `R:R ${stats.rr.toFixed(2)}  ${stats.dir.toUpperCase()}`, d.draft ? 'draft' : '');

  const hit = _svgEl('rect', {
    x: x1,
    y: Math.min(rewardTop, riskTop),
    width,
    height: Math.max(12, Math.max(rewardTop + rewardHeight, riskTop + riskHeight) - Math.min(rewardTop, riskTop)),
    class: 'drawing-hit entry-hit',
    'data-drawing-id': d.id,
    'data-drag-part': 'move',
  });
  svg.appendChild(hit);
  _drawHandle(svg, d, entryPoint.x, entryPoint.y, 'entry');
  _drawHandle(svg, d, stopPoint.x, stopPoint.y, 'stop');
  _drawHandle(svg, d, targetPoint.x, targetPoint.y, 'target');
}

function _renderDrawings() {
  const svg = _drawingOverlayEl();
  const container = document.getElementById('chart-container');
  if (!svg || !container) return;
  const w = container.clientWidth || 0;
  const h = container.clientHeight || 0;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.innerHTML = '';
  if (!chart || !candleSeries || !w || !h) return;

  const plotRight = Math.max(0, Number(chart.timeScale().width?.()) || w - DRAW_AXIS_W);
  const items = [..._drawings];
  if (_drawDraft) items.push({ ..._drawDraft, id: '__draft__', draft: true });

  for (const d of items) {
    if (d.type === 'hline') {
      const y = _priceToCoordinate(d.price);
      if (!Number.isFinite(y)) continue;
      const dd = d.draft ? { ...d, id: '__draft__' } : d;
      _drawLine(svg, dd, 0, y, plotRight, y, d.draft ? 'draft' : '');
      _drawHandle(svg, dd, Math.max(12, plotRight - 14), y, 'price', !d.draft);
      _drawLabel(svg, Math.max(8, plotRight - 72), y - 7, fmt.price(d.price), d.draft ? 'draft' : '');
      continue;
    }

    if (d.type === 'note') {
      const p = _pointToCoordinate(d.p);
      if (!p) continue;
      _drawNote(svg, d, p, plotRight, h);
      continue;
    }

    if (d.type === 'entry') {
      const dd = d.draft ? { ...d, id: '__draft__' } : d;
      _drawEntry(svg, dd, plotRight);
      continue;
    }

    if (d.type === 'fib') {
      const p1 = _pointToCoordinate(d.p1);
      const p2 = _pointToCoordinate(d.p2);
      if (!p1 || !p2) continue;
      _drawFib(svg, d, p1, p2, plotRight, h);
      continue;
    }

    if (d.type === 'trend' || d.type === 'ruler') {
      const p1 = _pointToCoordinate(d.p1);
      const p2 = _pointToCoordinate(d.p2);
      if (!p1 || !p2) continue;
      const dd = d.draft ? { ...d, id: '__draft__' } : d;
      _drawLine(svg, dd, p1.x, p1.y, p2.x, p2.y, d.draft ? 'draft' : '');
      _drawHandle(svg, dd, p1.x, p1.y, 'p1');
      _drawHandle(svg, dd, p2.x, p2.y, 'p2');
      if (d.type === 'ruler') {
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2 - 8;
        _drawLabel(svg, mx + 6, my, _rulerLabel(d), d.draft ? 'draft' : '');
      }
    }
  }
}

function _addDrawing(d) {
  if (!_validDrawing(d)) return;
  _drawings.push(d);
  _drawSelectedId = d.id;
  _saveDrawings();
  _updateDrawToolbar();
  _scheduleDrawings();
}

function _deleteDrawingById(id) {
  if (!id) return false;
  const before = _drawings.length;
  _drawings = _drawings.filter(d => d.id !== id);
  if (_drawSelectedId === id) _drawSelectedId = null;
  if (_drawings.length === before) return false;
  _saveDrawings();
  _updateDrawToolbar();
  _scheduleDrawings();
  return true;
}

function deleteSelectedDrawing() {
  return _deleteDrawingById(_drawSelectedId);
}

function clearDrawings() {
  if (!_drawings.length && !_drawDraft) return;
  _drawings = [];
  _drawSelectedId = null;
  _drawDraft = null;
  _drawDrag = null;
  _drawLastClick = null;
  _saveDrawings();
  _updateDrawToolbar();
  _scheduleDrawings();
}

function _startDrawing(ev) {
  const p = _pointerToChartPoint(ev);
  if (!p) return;
  ev.preventDefault();
  ev.stopPropagation();

  if (_drawTool === 'hline') {
    _addDrawing({ id: _newDrawingId(), type: 'hline', price: p.price });
    _drawTool = 'cursor';
    _updateDrawToolbar();
    return;
  }

  if (_drawTool === 'note') {
    const text = _askNoteText();
    if (text) {
      _addDrawing({ id: _newDrawingId(), type: 'note', p: { time: p.time, price: p.price }, text });
    }
    _drawTool = 'cursor';
    _updateDrawToolbar();
    return;
  }

  if (_drawTool === 'entry') {
    if (!_drawDraft) {
      _drawDraft = {
        id: '__draft__',
        type: 'entry',
        entry: { time: p.time, price: p.price },
        stop: { time: p.time, price: p.price },
        target: { time: p.time, price: p.price },
        stage: 'stop',
      };
      _updateDrawToolbar();
      _scheduleDrawings();
      return;
    }
    if (_drawDraft.stage === 'stop') {
      _drawDraft.stop = { time: p.time, price: p.price };
      _drawDraft.target = _projectEntryTarget(_drawDraft.entry, _drawDraft.stop, p.time);
      _drawDraft.stage = 'target';
      _scheduleDrawings();
      return;
    }
    _drawDraft.target = { time: p.time, price: p.price };
    const next = {
      id: _newDrawingId(),
      type: 'entry',
      entry: _drawDraft.entry,
      stop: _drawDraft.stop,
      target: _drawDraft.target,
    };
    _drawDraft = null;
    _addDrawing(next);
    _drawTool = 'cursor';
    _updateDrawToolbar();
    return;
  }

  if (_drawTool === 'trend' || _drawTool === 'ruler' || _drawTool === 'fib') {
    if (!_drawDraft) {
      _drawDraft = {
        id: '__draft__',
        type: _drawTool,
        p1: { time: p.time, price: p.price },
        p2: { time: p.time, price: p.price },
        moved: false,
      };
      _updateDrawToolbar();
      _scheduleDrawings();
      return;
    }
    _drawDraft.p2 = { time: p.time, price: p.price };
    const next = { ..._drawDraft, id: _newDrawingId() };
    _drawDraft = null;
    _addDrawing(next);
    _drawTool = 'cursor';
    _updateDrawToolbar();
  }
}

function _findDrawing(id) {
  return _drawings.find(d => d.id === id) || null;
}

function _startDrawingDrag(ev, id, part) {
  const d = _findDrawing(id);
  const p = _pointerToChartPoint(ev);
  if (!d || !p) return;
  ev.preventDefault();
  ev.stopPropagation();
  _drawSelectedId = id;
  _drawDrag = {
    id,
    part,
    start: { time: p.time, price: p.price },
    original: _cloneDrawing(d),
    moved: false,
  };
  try { _drawingOverlayEl()?.setPointerCapture(ev.pointerId); } catch (_) {}
  _updateDrawToolbar();
  _scheduleDrawings();
}

function _moveDrawingDrag(ev) {
  if (!_drawDrag) return;
  const d = _findDrawing(_drawDrag.id);
  const p = _pointerToChartPoint(ev);
  if (!d || !p) return;
  ev.preventDefault();
  _drawDrag.moved = true;

  const part = _drawDrag.part;
  const original = _drawDrag.original;
  if (d.type === 'hline') {
    d.price = p.price;
  } else if (d.type === 'note') {
    const dt = p.time - _drawDrag.start.time;
    const dp = p.price - _drawDrag.start.price;
    d.p = { time: original.p.time + dt, price: original.p.price + dp };
  } else if (d.type === 'entry') {
    if (part === 'entry' || part === 'stop' || part === 'target') {
      d[part] = { time: p.time, price: p.price };
    } else {
      const dt = p.time - _drawDrag.start.time;
      const dp = p.price - _drawDrag.start.price;
      d.entry = { time: original.entry.time + dt, price: original.entry.price + dp };
      d.stop = { time: original.stop.time + dt, price: original.stop.price + dp };
      d.target = { time: original.target.time + dt, price: original.target.price + dp };
    }
  } else if (part === 'p1' || part === 'p2') {
    d[part] = { time: p.time, price: p.price };
  } else {
    const dt = p.time - _drawDrag.start.time;
    const dp = p.price - _drawDrag.start.price;
    d.p1 = { time: original.p1.time + dt, price: original.p1.price + dp };
    d.p2 = { time: original.p2.time + dt, price: original.p2.price + dp };
  }
  _scheduleDrawings();
}

function _finishDrawingDrag(ev) {
  if (!_drawDrag) return;
  ev.preventDefault();
  try { _drawingOverlayEl()?.releasePointerCapture(ev.pointerId); } catch (_) {}
  _drawDrag = null;
  _saveDrawings();
  _updateDrawToolbar();
  _scheduleDrawings();
}

function _editNoteDrawing(d) {
  if (!d || d.type !== 'note') return;
  const text = _askNoteText(d.text);
  if (text == null) return;
  if (!text) {
    _deleteDrawingById(d.id);
    return;
  }
  d.text = text;
  _drawSelectedId = d.id;
  _saveDrawings();
  _updateDrawToolbar();
  _scheduleDrawings();
}

function _attachDrawingOverlayEvents() {
  const overlay = _drawingOverlayEl();
  if (!overlay || overlay.dataset.bound === '1') return;
  overlay.dataset.bound = '1';

  overlay.addEventListener('pointerdown', ev => {
    const id = ev.target?.dataset?.drawingId;
    const part = ev.target?.dataset?.dragPart;
    if (id && id !== '__draft__') {
      const d = _findDrawing(id);
      if (d?.type === 'note') {
        const now = Date.now();
        const last = _drawLastClick;
        const dx = last ? Math.abs(ev.clientX - last.x) : Infinity;
        const dy = last ? Math.abs(ev.clientY - last.y) : Infinity;
        if (last?.id === id && now - last.ts < 520 && dx < 12 && dy < 12) {
          _drawLastClick = null;
          ev.preventDefault();
          ev.stopPropagation();
          _drawSelectedId = id;
          _editNoteDrawing(d);
          return;
        }
        _drawLastClick = { id, ts: now, x: ev.clientX, y: ev.clientY };
      }
      _startDrawingDrag(ev, id, part || 'move');
      return;
    }
    if (_drawTool !== 'cursor') _startDrawing(ev);
  });

  overlay.addEventListener('pointermove', ev => {
    if (_drawDrag) {
      _moveDrawingDrag(ev);
      return;
    }
    if (_drawDraft) {
      const p = _pointerToChartPoint(ev);
      if (!p) return;
      if (_drawDraft.type === 'entry') {
        if (_drawDraft.stage === 'stop') {
          _drawDraft.stop = { time: p.time, price: p.price };
          _drawDraft.target = _projectEntryTarget(_drawDraft.entry, _drawDraft.stop, p.time);
        } else {
          _drawDraft.target = { time: p.time, price: p.price };
        }
      } else {
        _drawDraft.p2 = { time: p.time, price: p.price };
        if (_drawDraft.type === 'trend' || _drawDraft.type === 'ruler' || _drawDraft.type === 'fib') {
          const dx = Math.abs(Number(p.time) - Number(_drawDraft.p1.time));
          const dy = Math.abs(Number(p.price) - Number(_drawDraft.p1.price));
          _drawDraft.moved = dx > 0 || dy > 0.0000000001;
        }
      }
      _scheduleDrawings();
    }
  });

  overlay.addEventListener('pointerup', ev => {
    _finishDrawingDrag(ev);
    // Support the natural drag gesture as well as the existing two-click
    // gesture. A simple first click only leaves a preview in place.
    if (_drawDraft && (_drawDraft.type === 'trend' || _drawDraft.type === 'ruler' || _drawDraft.type === 'fib') && _drawDraft.moved) {
      const next = { ..._drawDraft, id: _newDrawingId() };
      delete next.moved;
      _drawDraft = null;
      _addDrawing(next);
      _drawTool = 'cursor';
      _updateDrawToolbar();
    }
  });
  overlay.addEventListener('pointercancel', _finishDrawingDrag);
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay && _drawTool === 'cursor') {
      _drawSelectedId = null;
      _updateDrawToolbar();
      _scheduleDrawings();
    }
  });
}

function _toggleHoverMarkerLock(time, mainPrice = null) {
  if (time == null) return;
  _hoverMarkerLocked = !_hoverMarkerLocked;
  _hoverMarkerTime = time;
  _hoverMarkerPrice = Number.isFinite(Number(mainPrice)) ? Number(mainPrice) : null;
  _renderHoverMarker(time, _hoverMarkerPrice);
  if (_hoverMarkerLocked) _syncCrosshairAt(time, null, true, _hoverMarkerPrice);
}

function _handleHoverMarkerClick(param, sourceChart = null) {
  if (param?.time != null) _toggleHoverMarkerLock(param.time, sourceChart === chart ? _mainPriceFromParam(param) : null);
}

function _syncIndicatorRanges() {
  if (!chart) return;
  const range = chart.timeScale().getVisibleLogicalRange();
  if (!range) return;
  _setIndicatorLogicalRange(range);
  _renderTimeAxis();
  _scheduleLiquidityZoneOverlay();
  _scheduleMarketStructure();
  _scheduleOrderbookHeatmap();
  _scheduleVP();
  _scheduleDrawings();
  if (activeInds.has('flow')) _renderFlowPanel(_hoverMarkerTime);
  _renderAnalysisPanel();
  _refreshHoverMarker();
}

function _setIndicatorLogicalRange(range) {
  [oiChart, cvdChart, ofvChart, lsChart, liqChart, macdChart].forEach(c => {
    try { if (c) c.timeScale().setVisibleLogicalRange(range); } catch (_) {}
  });
}

function _setAllLogicalRange(range) {
  try { if (chart) chart.timeScale().setVisibleLogicalRange(range); } catch (_) {}
  _setIndicatorLogicalRange(range);
  _renderTimeAxis();
  _scheduleLiquidityZoneOverlay();
  _scheduleMarketStructure();
  _scheduleOrderbookHeatmap();
  _scheduleDrawings();
  if (activeInds.has('flow')) _renderFlowPanel(_hoverMarkerTime);
  _renderAnalysisPanel();
  _refreshHoverMarker();
}

function _updateTimeScales() {
  const timeOptions = {
    visible: false,
    timeVisible: true,
    secondsVisible: false,
    borderColor: CHART_BORDER_COLOR,
    minimumHeight: 28,
    rightOffset: CHART_RIGHT_OFFSET,
  };

  try {
    if (chart) chart.timeScale().applyOptions(timeOptions);
  } catch (_) {}

  [oiChart, cvdChart, ofvChart, lsChart, liqChart, macdChart].forEach(c => {
    try { if (c) c.timeScale().applyOptions(timeOptions); } catch (_) {}
  });
  _renderTimeAxis();
  _scheduleMarketStructure();
  _scheduleOrderbookHeatmap();
  if (activeInds.has('flow')) _renderFlowPanel(_hoverMarkerTime);
  _renderAnalysisPanel();
  _refreshHoverMarker();
}

function _formatAxisDate(time) {
  const d = new Date(time * 1000);
  return {
    time: d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    date: d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
  };
}

function _renderTimeAxis() {
  const axis = document.getElementById('chart-time-axis');
  if (!axis) return;
  if (!chart || !_klineData.length) {
    axis.innerHTML = '';
    return;
  }

  const range = chart.timeScale().getVisibleLogicalRange();
  if (!range || range.to <= range.from) {
    axis.innerHTML = '';
    return;
  }

  const fromIdx = Math.max(0, Math.ceil(range.from));
  const toIdx = Math.min(_klineData.length - 1, Math.floor(range.to));
  if (toIdx < fromIdx) {
    axis.innerHTML = '';
    return;
  }

  const tickCount = Math.max(3, Math.min(9, Math.floor(axis.clientWidth / 150)));
  const seen = new Set();
  const ticks = [];
  for (let i = 0; i < tickCount; i += 1) {
    const idx = Math.round(fromIdx + (toIdx - fromIdx) * (tickCount === 1 ? 0 : i / (tickCount - 1)));
    if (seen.has(idx)) continue;
    seen.add(idx);

    const k = _klineData[idx];
    const left = Math.max(3, Math.min(97, ((idx - range.from) / (range.to - range.from)) * 100));
    const label = _formatAxisDate(k.time);
    ticks.push(
      `<div class="chart-time-tick" style="left:${left}%">` +
        `<span class="chart-time-main">${label.time}</span>` +
        `<span class="chart-time-date">${label.date}</span>` +
      `</div>`
    );
  }
  axis.innerHTML = ticks.join('');
}

function _clearIndicatorData() {
  _oiStartTime = null;
  _lsStartTime = null;
  _oiData = [];
  _oiHistData = [];
  _oiCandleData = [];
  _lastOiReloadAt = 0;
  _lsData = [];
  _cvdData = [];
  _cvdLineData = [];
  _cvdCandleData = [];
  _ofvData = [];
  _ofvCandleData = [];
  _liqData = [];
  _macdData = [];
  _flowData = [];
  _flowVisibleData = [];
  try { if (oiHistSeries) oiHistSeries.setData([]); } catch (_) {}
  try { if (oiCandleSeries) oiCandleSeries.setData([]); } catch (_) {}
  try { if (cvdLineSeries) cvdLineSeries.setData([]); } catch (_) {}
  try { if (cvdCandleSeries) cvdCandleSeries.setData([]); } catch (_) {}
  try { if (ofvSeries) ofvSeries.setData([]); } catch (_) {}
  try { if (lsLongSeries) lsLongSeries.setData([]); } catch (_) {}
  try { if (lsShortSeries) lsShortSeries.setData([]); } catch (_) {}
  try { if (liqLongSeries) liqLongSeries.setData([]); } catch (_) {}
  try { if (liqShortSeries) liqShortSeries.setData([]); } catch (_) {}
  try { if (macdLineSeries) macdLineSeries.setData([]); } catch (_) {}
  try { if (macdSignalSeries) macdSignalSeries.setData([]); } catch (_) {}
  try { if (macdHistSeries) macdHistSeries.setData([]); } catch (_) {}
  try { if (superTrendUpSeries) superTrendUpSeries.setData([]); } catch (_) {}
  try { if (superTrendDownSeries) superTrendDownSeries.setData([]); } catch (_) {}
  _clearMarketStructure();
  _clearOrderbookHeatmap();
  if (activeInds.has('book')) _setOrderbookPanelMessage('загрузка...');
  else _clearOrderbookPanel();
  _clearVwapData();
  _clearAnalysisPanel();
  _superTrendData = [];
  _clearFlowPanel();
}

function _updateLegend(open, high, low, close, vol, time = null) {
  const el = document.getElementById('chart-legend');
  if (!el) return;
  const chgPct  = open ? ((close - open) / open * 100) : 0;
  const chgCls  = chgPct > 0 ? 'pos' : chgPct < 0 ? 'neg' : '';
  const closeCls = close >= open ? 'pos' : 'neg';
  const st = activeInds.has('st') && time != null ? _findByTime(_superTrendData, time) : null;
  const stHtml = st && Number.isFinite(Number(st.value))
    ? `<span class="leg-lbl">ST</span> <span class="${st.direction > 0 ? 'pos' : 'neg'}">${fmt.price(st.value)}</span>`
    : '';
  el.innerHTML =
    `<span class="leg-lbl">O</span> <span class="leg-val">${fmt.price(open)}</span>` +
    `<span class="leg-lbl">H</span> <span class="pos">${fmt.price(high)}</span>` +
    `<span class="leg-lbl">L</span> <span class="neg">${fmt.price(low)}</span>` +
    `<span class="leg-lbl">C</span> <span class="${closeCls}">${fmt.price(close)}</span>` +
    `<span class="${chgCls}">${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%</span>` +
    `<span class="leg-lbl">Vol</span> <span class="leg-val">${fmt.large(vol)}</span>` +
    stHtml;
}

function _klineVolume(k) {
  return k.quote_volume ?? k.volume;
}

function _pctClass(v, eps = 0) {
  return v > eps ? 'pos' : v < -eps ? 'neg' : '';
}

function _formatSignedPct(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function _flowRegimeTemplate(key) {
  const templates = {
    short_squeeze: { title: 'Short squeeze', desc: 'Шорты уже выбивает на росте', color: '#38bdf8', score: 3 },
    long_flush:    { title: 'Long flush',    desc: 'Лонги уже выбивает на падении', color: '#fb7185', score: -3 },
    squeeze_risk:  { title: 'Squeeze risk',  desc: 'Шорты набирают против роста', color: '#60a5fa', score: 2 },
    flush_risk:    { title: 'Flush risk',    desc: 'Лонги набирают против падения', color: '#f59e0b', score: -2 },
    short_cover:   { title: 'Short covering', desc: 'Рост идёт на снижении OI', color: '#93c5fd', score: 1 },
    long_closing:  { title: 'Long closing',  desc: 'Падение идёт на снижении OI', color: '#fda4af', score: -1 },
    new_longs:     { title: 'New longs',     desc: 'Цена и OI растут, лонги добавляются', color: '#3fb950', score: 1 },
    new_shorts:    { title: 'New shorts',    desc: 'Цена падает, OI растёт, шорты добавляются', color: '#f85149', score: -1 },
    up_pressure:   { title: 'Up pressure',   desc: 'Покупатели давят, подтверждение слабое', color: '#2ea043', score: 1 },
    down_pressure: { title: 'Down pressure', desc: 'Продавцы давят, подтверждение слабое', color: '#da3633', score: -1 },
    neutral:       { title: 'Neutral',       desc: 'Нет явного режима', color: '#6e7681', score: 0 },
  };
  return templates[key] || templates.neutral;
}

function _classifyFlowBar(k, od, ld, lq) {
  const pricePct = k.open ? ((k.close - k.open) / k.open) * 100 : 0;
  const oiPct = od ? Number(od.pct || 0) : null;
  const longPct = ld ? Number(ld.long_pct) : null;
  const shortPct = ld ? Number(ld.short_pct) : null;
  const lsImb = Number.isFinite(longPct) && Number.isFinite(shortPct) ? longPct - shortPct : null;
  const longLiq = lq ? Number(lq.long_usd || 0) : 0;
  const shortLiq = lq ? Number(lq.short_usd || 0) : 0;

  const priceEps = 0.03;
  const oiEps = 0.02;
  const lsEps = 10;
  const liqMin = Math.max(5000, (_klineVolume(k) || 0) * 0.00002);
  const priceDir = pricePct > priceEps ? 1 : pricePct < -priceEps ? -1 : 0;
  const oiDir = oiPct == null ? 0 : oiPct > oiEps ? 1 : oiPct < -oiEps ? -1 : 0;
  const lsBias = lsImb == null ? 0 : lsImb > lsEps ? 1 : lsImb < -lsEps ? -1 : 0;
  const shortLiqStrong = shortLiq >= liqMin && shortLiq > longLiq * 1.5;
  const longLiqStrong = longLiq >= liqMin && longLiq > shortLiq * 1.5;

  let key = 'neutral';
  if (priceDir > 0 && shortLiqStrong) key = 'short_squeeze';
  else if (priceDir < 0 && longLiqStrong) key = 'long_flush';
  else if (priceDir > 0 && oiDir > 0 && lsBias < 0) key = 'squeeze_risk';
  else if (priceDir < 0 && oiDir > 0 && lsBias > 0) key = 'flush_risk';
  else if (priceDir > 0 && oiDir < 0) key = 'short_cover';
  else if (priceDir < 0 && oiDir < 0) key = 'long_closing';
  else if (priceDir > 0 && oiDir > 0) key = 'new_longs';
  else if (priceDir < 0 && oiDir > 0) key = 'new_shorts';
  else if (priceDir > 0) key = 'up_pressure';
  else if (priceDir < 0) key = 'down_pressure';

  const tpl = _flowRegimeTemplate(key);
  return {
    time: k.time,
    key,
    title: tpl.title,
    desc: tpl.desc,
    color: tpl.color,
    score: tpl.score,
    pricePct,
    oiPct,
    lsImb,
    longPct,
    shortPct,
    longLiq,
    shortLiq,
  };
}

function _buildFlowData() {
  if (!_klineData.length) {
    _flowData = [];
    return;
  }
  _flowData = _klineData.map(k => {
    const od = _oiData.length ? _findByTime(_oiData, k.time) : null;
    const ld = _lsData.length ? _findByTime(_lsData, k.time) : null;
    const lq = _liqData.length ? _findByTime(_liqData, k.time) : null;
    return _classifyFlowBar(k, od, ld, lq);
  });
}

function _renderFlowSummary(d) {
  const el = document.getElementById('flow-summary');
  if (!el) return;
  if (!d) {
    el.innerHTML = '<span class="flow-desc">Недостаточно данных</span>';
    return;
  }
  const oiText = d.oiPct == null ? 'OI —' : `OI ${_formatSignedPct(d.oiPct, 3)}`;
  const lsText = d.lsImb == null ? 'L/S —' : `L/S ${_formatSignedPct(d.lsImb, 1)}`;
  const liqText = `Liq L ${fmt.large(d.longLiq || 0)} / S ${fmt.large(d.shortLiq || 0)}`;
  el.innerHTML =
    `<span class="flow-pill" style="background:${d.color}">${d.title}</span>` +
    `<span class="flow-desc">${d.desc}</span>` +
    `<span class="flow-metrics">` +
      `<span class="${_pctClass(d.pricePct)}">Price ${_formatSignedPct(d.pricePct, 2)}</span>` +
      `<span class="${_pctClass(d.oiPct || 0)}">${oiText}</span>` +
      `<span class="${_pctClass(d.lsImb || 0)}">${lsText}</span>` +
      `<span class="${(d.longLiq || 0) > (d.shortLiq || 0) ? 'warn' : ''}">${liqText}</span>` +
    `</span>`;
}

function _clearFlowPanel() {
  _flowVisibleData = [];
  const track = document.getElementById('flow-track');
  const summary = document.getElementById('flow-summary');
  if (track) track.innerHTML = '';
  if (summary) summary.innerHTML = activeInds.has('flow')
    ? '<span class="flow-desc">Загрузка режима...</span>'
    : '';
}

function _renderFlowPanel(selectedTime = null) {
  const panel = document.getElementById('flow-panel');
  const track = document.getElementById('flow-track');
  if (!panel || !track) return;
  if (!activeInds.has('flow')) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  _buildFlowData();
  if (!_flowData.length) {
    _flowVisibleData = [];
    track.innerHTML = '';
    _renderFlowSummary(null);
    return;
  }
  let visible = _flowData;
  _flowLeadGap = 0;
  _flowTrailGap = 0;
  try {
    const range = chart?.timeScale().getVisibleLogicalRange();
    if (range && range.to > range.from) {
      const fromIdx = Math.max(0, Math.ceil(range.from));
      const toIdx = Math.min(_flowData.length - 1, Math.floor(range.to));
      if (toIdx >= fromIdx) {
        visible = _flowData.slice(fromIdx, toIdx + 1);
        // The logical range can extend past real data — e.g. the reserved
        // rightOffset space past the last candle. Segments are flexed to
        // fill 100% of the track, so without accounting for that extra span
        // as blank flex space, the real segments stretch to cover it too,
        // ending glued to the right edge instead of lining up with the last
        // candle (very visible once zoomed in near the live edge).
        _flowLeadGap = Math.max(0, fromIdx - range.from);
        _flowTrailGap = Math.max(0, range.to - (toIdx + 1));
      }
    }
  } catch (_) {}
  _flowVisibleData = visible;
  const selected = selectedTime != null ? _findByTime(visible, selectedTime) : visible[visible.length - 1];
  const selectedBarTime = selected?.time;
  const segsHtml = visible.map(d => (
    `<span class="flow-seg${d.time === selectedBarTime ? ' selected' : ''}" ` +
      `data-time="${d.time}" title="${d.title} · ${d.desc}" style="background:${d.color}"></span>`
  )).join('');
  const leadHtml = _flowLeadGap > 0.01 ? `<span class="flow-gap" style="flex:${_flowLeadGap} 1 0"></span>` : '';
  const trailHtml = _flowTrailGap > 0.01 ? `<span class="flow-gap" style="flex:${_flowTrailGap} 1 0"></span>` : '';
  track.innerHTML = leadHtml + segsHtml + trailHtml;
  _renderFlowSummary(selected);
}

function _attachFlowPanelEvents() {
  const track = document.getElementById('flow-track');
  if (!track || track._bound) return;
  track._bound = true;
  const timeFromEvent = e => {
    const data = _flowVisibleData.length ? _flowVisibleData : _flowData;
    if (!data.length) return null;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return null;
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    // Track width includes the lead/trail blank flex space (see _renderFlowPanel),
    // so map pct across the full span before subtracting the lead gap.
    const span = data.length + _flowLeadGap + _flowTrailGap;
    const pos = pct * span - _flowLeadGap;
    const idx = Math.max(0, Math.min(data.length - 1, Math.round(pos)));
    return data[idx]?.time ?? null;
  };
  track.addEventListener('mousemove', e => {
    const time = timeFromEvent(e);
    if (time != null) _syncCrosshairAt(time, null);
  });
  track.addEventListener('click', e => {
    const time = timeFromEvent(e);
    if (time != null) _toggleHoverMarkerLock(time);
  });
  track.addEventListener('mouseleave', _syncCrosshairLeave);
}

// ── SuperTrend overlay ────────────────────────────────────────────────────────
function _superTrendSeriesOptions(color) {
  return {
    color,
    lineWidth: 2,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  };
}

function _ensureSuperTrendSeries() {
  if (!chart) return;
  if (superTrendUpSeries && superTrendDownSeries) return;
  _destroySuperTrend();
  superTrendUpSeries = chart.addLineSeries(_superTrendSeriesOptions(SUPER_TREND_UP_COLOR));
  superTrendDownSeries = chart.addLineSeries(_superTrendSeriesOptions(SUPER_TREND_DOWN_COLOR));
}

function _destroySuperTrend() {
  if (chart && superTrendUpSeries) {
    try { chart.removeSeries(superTrendUpSeries); } catch (_) {}
  }
  if (chart && superTrendDownSeries) {
    try { chart.removeSeries(superTrendDownSeries); } catch (_) {}
  }
  superTrendUpSeries = null;
  superTrendDownSeries = null;
  _superTrendData = [];
}

function _trueRange(k, prevClose) {
  const high = Number(k.high);
  const low = Number(k.low);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  if (!Number.isFinite(prevClose)) return high - low;
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

function _calcSuperTrend(data, period = SUPER_TREND_PERIOD, mult = SUPER_TREND_MULT) {
  const rows = data
    .map(k => ({
      time: k.time,
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
    }))
    .filter(k => k.time != null && Number.isFinite(k.high) && Number.isFinite(k.low) && Number.isFinite(k.close));
  if (rows.length < period) return [];

  const atr = Array(rows.length).fill(null);
  let trSum = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const tr = _trueRange(rows[i], i > 0 ? rows[i - 1].close : NaN);
    if (!Number.isFinite(tr)) continue;
    if (i < period) trSum += tr;
    if (i === period - 1) atr[i] = trSum / period;
    else if (i >= period && atr[i - 1] != null) atr[i] = ((atr[i - 1] * (period - 1)) + tr) / period;
  }

  const out = [];
  let finalUpper = null;
  let finalLower = null;
  let prevSuperTrend = null;

  for (let i = 0; i < rows.length; i += 1) {
    if (atr[i] == null) continue;
    const row = rows[i];
    const hl2 = (row.high + row.low) / 2;
    const basicUpper = hl2 + mult * atr[i];
    const basicLower = hl2 - mult * atr[i];

    if (finalUpper == null || finalLower == null || prevSuperTrend == null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      const direction = row.close >= hl2 ? 1 : -1;
      const value = direction > 0 ? finalLower : finalUpper;
      prevSuperTrend = value;
      out.push({ time: row.time, value, direction, upper: finalUpper, lower: finalLower });
      continue;
    }

    const prevUpper = finalUpper;
    const prevLower = finalLower;
    const prevClose = rows[i - 1].close;
    finalUpper = (basicUpper < prevUpper || prevClose > prevUpper) ? basicUpper : prevUpper;
    finalLower = (basicLower > prevLower || prevClose < prevLower) ? basicLower : prevLower;

    let direction;
    let value;
    if (prevSuperTrend === prevUpper) {
      if (row.close <= finalUpper) {
        direction = -1;
        value = finalUpper;
      } else {
        direction = 1;
        value = finalLower;
      }
    } else if (row.close >= finalLower) {
      direction = 1;
      value = finalLower;
    } else {
      direction = -1;
      value = finalUpper;
    }

    prevSuperTrend = value;
    out.push({ time: row.time, value, direction, upper: finalUpper, lower: finalLower });
  }

  return out;
}

function _superTrendLine(points, direction) {
  const line = points.map(p => ({ time: p.time }));
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (p.direction !== direction) continue;
    line[i] = { time: p.time, value: p.value };
    if (i > 0 && points[i - 1].direction !== direction) {
      line[i - 1] = { time: points[i - 1].time, value: points[i - 1].value };
    }
  }
  return line;
}

function _renderSuperTrend() {
  if (!activeInds.has('st') || !_klineData.length) {
    _superTrendData = [];
    try { if (superTrendUpSeries) superTrendUpSeries.setData([]); } catch (_) {}
    try { if (superTrendDownSeries) superTrendDownSeries.setData([]); } catch (_) {}
    return;
  }
  _ensureSuperTrendSeries();
  _superTrendData = _calcSuperTrend(_klineData);
  try { if (superTrendUpSeries) superTrendUpSeries.setData(_superTrendLine(_superTrendData, 1)); } catch (_) {}
  try { if (superTrendDownSeries) superTrendDownSeries.setData(_superTrendLine(_superTrendData, -1)); } catch (_) {}
}

function _liquidityZoneTolerance(data) {
  const recent = data.slice(-120);
  const avgRange = recent.reduce((sum, k) => sum + Math.max(0, k.high - k.low), 0) / Math.max(1, recent.length);
  const lastClose = data[data.length - 1]?.close || 0;
  return Math.max(avgRange * 0.35, lastClose * 0.0007);
}

function _collectSwingLevels(data, span, fromIdx) {
  const levels = [];
  const start = Math.max(span, fromIdx);
  const end = data.length - span;
  for (let i = start; i < end; i += 1) {
    const k = data[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j += 1) {
      if (j === i) continue;
      if (data[j].high > k.high) isHigh = false;
      if (data[j].low < k.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) levels.push({ kind: 'buy', price: k.high, index: i, source: 'swing', weight: 1 });
    if (isLow) levels.push({ kind: 'sell', price: k.low, index: i, source: 'swing', weight: 1 });
  }
  return levels;
}

function _lastKlineIndexBefore(time) {
  let out = 0;
  for (let i = 0; i < _klineData.length; i += 1) {
    if (Number(_klineData[i].time) < Number(time)) out = i;
    else break;
  }
  return out;
}

function _collectHtfStopLevels() {
  if (_klineData.length < 4) return [];
  const last = _klineData[_klineData.length - 1];
  const dayIdx = _lastKlineIndexBefore(_utcDayStart(last.time));
  const weekIdx = _lastKlineIndexBefore(_utcWeekStart(last.time));
  return _calcHtfLevels(true)
    .filter(l => l.kind === 'high' || l.kind === 'low')
    .map(l => ({
      kind: l.kind === 'high' ? 'buy' : 'sell',
      price: Number(l.price),
      index: l.key?.startsWith('pw') ? weekIdx : dayIdx,
      source: l.label,
      weight: l.key?.startsWith('pw') ? 2.2 : 1.8,
    }))
    .filter(l => Number.isFinite(l.price));
}

function _collectSessionStopLevels(fromIdx) {
  if (_tfSeconds() >= 86400 || _klineData.length < 20) return [];
  const chartStart = _klineData[Math.max(0, fromIdx)]?.time || _klineData[0].time;
  const lastTime = _klineData[_klineData.length - 1].time;
  const day = 86400;
  const firstDay = Math.floor(chartStart / day) * day - day;
  const lastDay = Math.floor(lastTime / day) * day;
  const levels = [];

  for (let d = firstDay; d <= lastDay; d += day) {
    SESSION_DEFS.forEach(session => {
      let x0 = d + session.startHour * 3600;
      let x1 = d + session.endHour * 3600;
      if (x1 <= x0) x1 += day;
      if (x1 > lastTime || x1 < chartStart) return;
      const stats = _calcSessionStats(x0, x1);
      if (!stats) return;
      const index = _lastKlineIndexBefore(x1);
      levels.push({ kind: 'buy', price: stats.high, index, source: session.label[0], weight: 1.45 });
      levels.push({ kind: 'sell', price: stats.low, index, source: session.label[0], weight: 1.45 });
    });
  }
  return levels.filter(l => Number.isFinite(l.price)).slice(-36);
}

function _stopZoneSwept(kind, min, max, lastIndex, tolerance, data) {
  const start = Math.max(0, Number(lastIndex) + 1);
  for (let i = start; i < data.length; i += 1) {
    const k = data[i];
    if (kind === 'buy' && Number(k.high) > Number(max) + tolerance) return true;
    if (kind === 'sell' && Number(k.low) < Number(min) - tolerance) return true;
  }
  return false;
}

function _clusterLiquidityLevels(levels, tolerance, totalBars, data = _klineData) {
  const clusters = [];
  const sorted = [...levels].sort((a, b) => a.price - b.price);

  for (const level of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(level.price - last.price) <= tolerance) {
      last.touches += 1;
      last.weight += Number(level.weight) || 1;
      last.sources.add(level.source || 'swing');
      last.totalPrice += level.price;
      last.price = last.totalPrice / last.touches;
      last.lastIndex = Math.max(last.lastIndex, level.index);
      last.firstIndex = Math.min(last.firstIndex, level.index);
      last.min = Math.min(last.min, level.price);
      last.max = Math.max(last.max, level.price);
    } else {
      clusters.push({
        kind: level.kind,
        price: level.price,
        totalPrice: level.price,
        touches: 1,
        firstIndex: level.index,
        lastIndex: level.index,
        min: level.price,
        max: level.price,
        weight: Number(level.weight) || 1,
        sources: new Set([level.source || 'swing']),
      });
    }
  }

  return clusters.map(c => {
    const recency = c.lastIndex / Math.max(1, totalBars - 1);
    const tf = _tfSeconds();
    const ageSeconds = Math.max(0, (totalBars - 1 - c.firstIndex) * tf);
    const persistenceSeconds = Math.max(0, (c.lastIndex - c.firstIndex) * tf);
    const width = Math.max(tolerance * 0.5, (c.max - c.min) / 2);
    const sourceText = [...c.sources]
      .filter(s => s && s !== 'swing')
      .slice(0, 2)
      .join('+');
    return {
      kind: c.kind,
      price: c.price,
      width,
      touches: c.touches,
      sourceText,
      swept: _stopZoneSwept(c.kind, c.min, c.max, c.lastIndex, tolerance, data),
      ageSeconds,
      persistenceSeconds,
      score: c.touches * 10 + c.weight * 5 + recency * 2 + Math.min(4, ageSeconds / 21600),
    };
  });
}

function _isSeniorLiquidityTf() {
  return _tfSeconds() > LIQUIDITY_SENIOR_TF_SECONDS;
}

function _formatLiquidityAge(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s >= 604800) return `${Math.round(s / 604800)}н`;
  if (s >= 86400) return `${Math.round(s / 86400)}д`;
  if (s >= 3600) return `${Math.round(s / 3600)}ч`;
  return `${Math.max(1, Math.round(s / 60))}м`;
}

function _selectLiquidityZones(clusters, currentPrice, kind, tolerance, seniorOnly = false) {
  let side = clusters.filter(z =>
    !z.swept &&
    (kind === 'buy' ? z.price > currentPrice : z.price < currentPrice)
  );
  if (seniorOnly) {
    side = side.filter(z =>
      z.ageSeconds >= LIQUIDITY_SENIOR_MIN_AGE_SECONDS &&
      (z.touches > 1 || z.sourceText)
    );
  }
  const repeated = side.filter(z => z.touches > 1 || z.sourceText);
  const pool = repeated.length >= 2 ? repeated : side;
  const selected = [];
  const minGap = tolerance * 1.35;
  for (const zone of pool.sort((a, b) => b.score - a.score || Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice))) {
    if (selected.every(z => Math.abs(z.price - zone.price) >= minGap)) {
      selected.push(zone);
      if (selected.length >= LIQUIDITY_ZONES_PER_SIDE) break;
    }
  }
  return selected;
}

function _calcLiquidityZones() {
  if (_klineData.length < 30) return [];
  const seniorOnly = _isSeniorLiquidityTf();
  const span = seniorOnly ? 2 : 3;
  const fromIdx = Math.max(0, _klineData.length - (seniorOnly ? 400 : 300));
  const tolerance = _liquidityZoneTolerance(_klineData);
  const levels = [
    ..._collectSwingLevels(_klineData, span, fromIdx),
    ..._collectHtfStopLevels(),
    ..._collectSessionStopLevels(fromIdx),
  ];
  const currentPrice = _klineData[_klineData.length - 1].close;
  const highClusters = _clusterLiquidityLevels(levels.filter(l => l.kind === 'buy'), tolerance, _klineData.length, _klineData);
  const lowClusters = _clusterLiquidityLevels(levels.filter(l => l.kind === 'sell'), tolerance, _klineData.length, _klineData);
  const buyZones = _selectLiquidityZones(highClusters, currentPrice, 'buy', tolerance, seniorOnly);
  const sellZones = _selectLiquidityZones(lowClusters, currentPrice, 'sell', tolerance, seniorOnly);

  return [...buyZones, ...sellZones].map(z => ({
    ...z,
    color: z.kind === 'buy' ? LIQUIDITY_BUY_COLOR : LIQUIDITY_SELL_COLOR,
    senior: seniorOnly,
    ageText: _formatLiquidityAge(z.ageSeconds),
    label: z.kind === 'buy' ? 'BSL' : 'SSL',
    title: `${z.kind === 'buy' ? 'BSL' : 'SSL'} ${z.touches}x${z.sourceText ? ` ${z.sourceText}` : ''} ${_formatLiquidityAge(z.ageSeconds)}`,
  }));
}

function _clearLiquidityZones() {
  if (candleSeries && liquidityZoneLines.length) {
    liquidityZoneLines.forEach(line => {
      try { candleSeries.removePriceLine(line); } catch (_) {}
    });
  }
  liquidityZoneLines = [];
  liquidityZones = [];
  const overlay = document.getElementById('liquidity-zone-overlay');
  if (overlay) overlay.innerHTML = '';
}

function _renderLiquidityZones() {
  _clearLiquidityZones();
  if (!activeInds.has('zones') || !candleSeries || !_klineData.length) return;

  liquidityZones = _calcLiquidityZones();
  const lineStyle = LightweightCharts.LineStyle?.Dashed ?? 2;
  liquidityZoneLines = liquidityZones.map(z => candleSeries.createPriceLine({
    price: z.price,
    color: z.color,
    lineWidth: 1,
    lineStyle,
    axisLabelVisible: true,
    title: z.title,
  }));
  _scheduleLiquidityZoneOverlay();
}

function _positionLiquidityZoneOverlay() {
  const overlay = document.getElementById('liquidity-zone-overlay');
  if (!overlay) return;
  if (!activeInds.has('zones') || !candleSeries || !liquidityZones.length) {
    overlay.innerHTML = '';
    return;
  }

  const bands = [];
  for (const z of liquidityZones) {
    const center = candleSeries.priceToCoordinate(z.price);
    if (center == null) continue;

    const upper = candleSeries.priceToCoordinate(z.price + z.width);
    const lower = candleSeries.priceToCoordinate(z.price - z.width);
    let height = upper != null && lower != null ? Math.abs(lower - upper) : 8;
    height = Math.max(6, Math.min(28, height));
    const top = center - height / 2;
    if (top > overlay.clientHeight || top + height < 0) continue;
    const sourceText = z.sourceText ? ` ${z.sourceText}` : '';
    const label = `<span class="liquidity-zone-label">${z.label} ${z.touches}x${sourceText}</span>`;
    bands.push(`<div class="liquidity-zone-band ${z.kind}${z.senior ? ' senior' : ''}" style="top:${top}px;height:${height}px">${label}</div>`);
  }
  overlay.innerHTML = bands.join('');
}

function _scheduleLiquidityZoneOverlay() {
  if (_liqZoneOverlayRaf) return;
  _liqZoneOverlayRaf = requestAnimationFrame(() => {
    _liqZoneOverlayRaf = null;
    _positionLiquidityZoneOverlay();
  });
}

// ── Sessions, impulses, imbalances ────────────────────────────────────────────
function _marketStructureOverlayEl() {
  return document.getElementById('market-structure-overlay');
}

function _clearMarketStructure() {
  if (_marketStructureRaf) {
    cancelAnimationFrame(_marketStructureRaf);
    _marketStructureRaf = null;
  }
  const overlay = _marketStructureOverlayEl();
  if (overlay) overlay.innerHTML = '';
  try { if (candleSeries) candleSeries.setMarkers([]); } catch (_) {}
}

function _median(values) {
  const arr = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function _medianWindow(values, from, to) {
  return _median(values.slice(Math.max(0, from), Math.max(0, to)));
}

function _tfSeconds() {
  return Math.max(60, Math.round((_TF_MS[chartTf] || 60000) / 1000));
}

function _chartPlotRight(container) {
  const axisW = (chart && chart.priceScale('right').width()) || VP_AXIS_W;
  return Math.max(0, (container?.clientWidth || 0) - axisW);
}

function _timeToLogical(time) {
  if (!_klineData.length || !Number.isFinite(Number(time))) return null;
  const t = Number(time);
  const first = _klineData[0].time;
  const lastIdx = _klineData.length - 1;
  const tf = _tfSeconds();
  if (t <= first) return (t - first) / tf;

  for (let i = 1; i < _klineData.length; i += 1) {
    const prev = _klineData[i - 1].time;
    const next = _klineData[i].time;
    if (t <= next) {
      const span = Math.max(1, next - prev);
      return i - 1 + (t - prev) / span;
    }
  }

  return lastIdx + (t - _klineData[lastIdx].time) / tf;
}

function _timeToX(time, plotRight) {
  const range = chart?.timeScale().getVisibleLogicalRange();
  if (!range || range.to <= range.from) return null;
  const logical = _timeToLogical(time);
  if (!Number.isFinite(logical)) return null;
  return ((logical - range.from) / (range.to - range.from)) * plotRight;
}

function _structureSpan() {
  const tf = _tfSeconds();
  if (tf >= 86400) return 2;
  if (tf >= 14400) return 3;
  return 4;
}

function _structureTolerance() {
  if (!_klineData.length) return 0;
  const last = _klineData[_klineData.length - 1]?.close || 0;
  return Math.max(_liquidityZoneTolerance(_klineData) * 0.15, last * 0.00015);
}

function _detectSwings(data = _klineData, span = _structureSpan(), fromIdx = 0) {
  const swings = [];
  const start = Math.max(span, fromIdx);
  const end = data.length - span;
  for (let i = start; i < end; i += 1) {
    const k = data[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j += 1) {
      if (j === i) continue;
      if (Number(data[j].high) >= Number(k.high)) isHigh = false;
      if (Number(data[j].low) <= Number(k.low)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ type: 'high', index: i, time: k.time, price: Number(k.high) });
    if (isLow) swings.push({ type: 'low', index: i, time: k.time, price: Number(k.low) });
  }
  return swings.sort((a, b) => a.index - b.index || (a.type === 'low' ? -1 : 1));
}

function _calcStructureEvents(force = false) {
  if (!force && !activeInds.has('structure')) return [];
  if (_klineData.length < 20) return [];
  const swings = _detectSwings(_klineData, _structureSpan(), Math.max(0, _klineData.length - 260));
  const tol = _structureTolerance();
  const events = [];
  let ptr = 0;
  let lastHigh = null;
  let lastLow = null;
  let trend = 0;
  let brokenHigh = -1;
  let brokenLow = -1;

  for (let i = 0; i < _klineData.length; i += 1) {
    while (ptr < swings.length && swings[ptr].index < i) {
      const s = swings[ptr];
      if (s.type === 'high') lastHigh = s;
      if (s.type === 'low') lastLow = s;
      ptr += 1;
    }
    const k = _klineData[i];
    const close = Number(k.close);
    if (lastHigh && lastHigh.index !== brokenHigh && close > lastHigh.price + tol) {
      const kind = trend < 0 ? 'CHOCH' : 'BOS';
      events.push({ kind, dir: 'up', time: k.time, fromTime: lastHigh.time, price: lastHigh.price, index: i });
      trend = 1;
      brokenHigh = lastHigh.index;
      continue;
    }
    if (lastLow && lastLow.index !== brokenLow && close < lastLow.price - tol) {
      const kind = trend > 0 ? 'CHOCH' : 'BOS';
      events.push({ kind, dir: 'down', time: k.time, fromTime: lastLow.time, price: lastLow.price, index: i });
      trend = -1;
      brokenLow = lastLow.index;
    }
  }

  return events.slice(-26);
}

function _calcLiquiditySweeps(force = false) {
  if (!force && !activeInds.has('sweeps')) return [];
  if (_klineData.length < 20) return [];
  const swings = _detectSwings(_klineData, _structureSpan(), Math.max(0, _klineData.length - 260));
  const tol = _structureTolerance();
  const sweeps = [];
  let ptr = 0;
  let lastHigh = null;
  let lastLow = null;
  let sweptHigh = -1;
  let sweptLow = -1;

  for (let i = 0; i < _klineData.length; i += 1) {
    while (ptr < swings.length && swings[ptr].index < i) {
      const s = swings[ptr];
      if (s.type === 'high') lastHigh = s;
      if (s.type === 'low') lastLow = s;
      ptr += 1;
    }
    const k = _klineData[i];
    const high = Number(k.high);
    const low = Number(k.low);
    const close = Number(k.close);
    if (lastHigh && sweptHigh !== lastHigh.index && high > lastHigh.price + tol && close < lastHigh.price) {
      sweeps.push({ dir: 'high', time: k.time, levelTime: lastHigh.time, price: lastHigh.price, index: i });
      sweptHigh = lastHigh.index;
    }
    if (lastLow && sweptLow !== lastLow.index && low < lastLow.price - tol && close > lastLow.price) {
      sweeps.push({ dir: 'low', time: k.time, levelTime: lastLow.time, price: lastLow.price, index: i });
      sweptLow = lastLow.index;
    }
  }

  return sweeps.slice(-28);
}

function _utcDayStart(time) {
  return Math.floor(Number(time) / 86400) * 86400;
}

function _utcWeekStart(time) {
  const day = _utcDayStart(time);
  const d = new Date(day * 1000);
  const utcDay = d.getUTCDay() || 7;
  return day - (utcDay - 1) * 86400;
}

function _periodStats(startFn) {
  const groups = [];
  let current = null;
  for (const k of _klineData) {
    const start = startFn(k.time);
    if (!current || current.start !== start) {
      current = {
        start,
        open: Number(k.open),
        high: Number(k.high),
        low: Number(k.low),
        lastTime: k.time,
      };
      groups.push(current);
    } else {
      current.high = Math.max(current.high, Number(k.high));
      current.low = Math.min(current.low, Number(k.low));
      current.lastTime = k.time;
    }
  }
  return groups;
}

function _calcHtfLevels(force = false) {
  if (!force && !activeInds.has('htf')) return [];
  if (_klineData.length < 4) return [];
  const levels = [];
  const days = _periodStats(_utcDayStart);
  const weeks = _periodStats(_utcWeekStart);
  const curDay = days[days.length - 1];
  const prevDay = days[days.length - 2];
  const curWeek = weeks[weeks.length - 1];
  const prevWeek = weeks[weeks.length - 2];
  if (prevDay) {
    levels.push({ key: 'pdh', label: 'PDH', price: prevDay.high, kind: 'high' });
    levels.push({ key: 'pdl', label: 'PDL', price: prevDay.low, kind: 'low' });
  }
  if (curDay) levels.push({ key: 'do', label: 'D Open', price: curDay.open, kind: 'open' });
  if (prevWeek) {
    levels.push({ key: 'pwh', label: 'PWH', price: prevWeek.high, kind: 'high' });
    levels.push({ key: 'pwl', label: 'PWL', price: prevWeek.low, kind: 'low' });
  }
  if (curWeek) levels.push({ key: 'wo', label: 'W Open', price: curWeek.open, kind: 'open' });
  return levels.filter(l => Number.isFinite(l.price));
}

function _calcPremiumDiscount(force = false) {
  if (!force && !activeInds.has('pd')) return null;
  if (_klineData.length < 20) return null;
  const from = Math.max(0, _klineData.length - 180);
  const swings = _detectSwings(_klineData, _structureSpan(), from);
  const highs = swings.filter(s => s.type === 'high').map(s => s.price);
  const lows = swings.filter(s => s.type === 'low').map(s => s.price);
  const recent = _klineData.slice(from);
  const high = highs.length ? Math.max(...highs) : Math.max(...recent.map(k => Number(k.high)));
  const low = lows.length ? Math.min(...lows) : Math.min(...recent.map(k => Number(k.low)));
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;
  return { high, low, eq: (high + low) / 2 };
}

function _calcSessionStats(x0, x1) {
  let high = -Infinity;
  let low = Infinity;
  let open = null;
  let close = null;
  for (const k of _klineData) {
    if (k.time < x0 || k.time >= x1) continue;
    if (open == null) open = Number(k.open);
    close = Number(k.close);
    high = Math.max(high, Number(k.high));
    low = Math.min(low, Number(k.low));
  }
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  const rangePct = open ? ((high - low) / open) * 100 : null;
  return { high, low, open, close, rangePct };
}

function _calcSessionZones() {
  if (!activeInds.has('sessions') || !_klineData.length || _tfSeconds() >= 86400) return [];
  const chartStart = _klineData[0].time;
  const chartEnd = _klineData[_klineData.length - 1].time + _tfSeconds();
  const day = 86400;
  const firstDay = Math.floor(chartStart / day) * day - day;
  const lastDay = Math.floor(chartEnd / day) * day + day;
  const zones = [];

  for (let d = firstDay; d <= lastDay; d += day) {
    SESSION_DEFS.forEach((session, sessionIndex) => {
      let x0 = d + session.startHour * 3600;
      let x1 = d + session.endHour * 3600;
      if (x1 <= x0) x1 += day;
      if (x1 <= chartStart || x0 >= chartEnd) return;
      const start = Math.max(x0, chartStart);
      const end = Math.min(x1, chartEnd);
      zones.push({
        ...session,
        sessionIndex,
        x0: start,
        x1: end,
        stats: _calcSessionStats(start, end),
      });
    });
  }
  return zones;
}

function _calcImbalances(force = false) {
  if (!force && !activeInds.has('imbalance')) return [];
  if (_klineData.length < 3) return [];
  const ranges = _klineData.map(k => Math.max(0, Number(k.high) - Number(k.low)));
  const medianRange = _median(ranges.filter(v => v > 0)) || 0;
  const minGapPct = 0.045;
  const maxZones = 18;
  const maxFilledZones = 6;
  const tf = _tfSeconds();
  const chartEnd = _klineData[_klineData.length - 1].time + tf;
  const zones = [];

  for (let i = 2; i < _klineData.length; i += 1) {
    const left = _klineData[i - 2];
    const mid = _klineData[i - 1];
    const cur = _klineData[i];
    let kind = null;
    let lower = null;
    let upper = null;

    if (Number(cur.low) > Number(left.high)) {
      kind = 'bull';
      lower = Number(left.high);
      upper = Number(cur.low);
    } else if (Number(cur.high) < Number(left.low)) {
      kind = 'bear';
      lower = Number(cur.high);
      upper = Number(left.low);
    }
    if (!kind || !Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) continue;

    const gap = upper - lower;
    const refPrice = Math.max(upper, Number(cur.close) || upper);
    const gapPct = refPrice > 0 ? (gap / refPrice) * 100 : 0;
    if (gapPct < minGapPct && medianRange > 0 && gap < medianRange * 0.12) continue;

    let x1 = chartEnd;
    let status = 'fresh';
    let fillPct = 0;
    const midPrice = (lower + upper) / 2;
    for (let j = i + 1; j < _klineData.length; j += 1) {
      const k = _klineData[j];
      if (kind === 'bull') {
        const probe = Number(k.low);
        if (probe <= upper) {
          fillPct = Math.max(fillPct, _clip((upper - probe) / gap, 0, 1));
          status = fillPct >= 0.5 ? 'mid' : 'touched';
        }
        if (probe <= lower) {
          status = Number(k.close) < lower ? 'invalidated' : 'filled';
          fillPct = 1;
          x1 = k.time;
          break;
        }
      } else {
        const probe = Number(k.high);
        if (probe >= lower) {
          fillPct = Math.max(fillPct, _clip((probe - lower) / gap, 0, 1));
          status = fillPct >= 0.5 ? 'mid' : 'touched';
        }
        if (probe >= upper) {
          status = Number(k.close) > upper ? 'invalidated' : 'filled';
          fillPct = 1;
          x1 = k.time;
          break;
        }
      }
    }

    if (x1 <= mid.time) continue;
    zones.push({
      kind,
      lower,
      upper,
      mid: midPrice,
      x0: mid.time,
      x1,
      filled: status === 'filled' || status === 'invalidated',
      status,
      fillPct,
      gapPct,
    });
  }

  const openZones = zones.filter(z => !z.filled).slice(-maxZones);
  const filledSlots = Math.min(maxFilledZones, Math.max(0, maxZones - openZones.length));
  const filledZones = filledSlots > 0 ? zones.filter(z => z.filled).slice(-filledSlots) : [];
  return [...filledZones, ...openZones].sort((a, b) => a.x0 - b.x0);
}

function _calcImpulseEvents(force = false) {
  if (!force && !activeInds.has('impulses')) return [];
  if (_klineData.length < 8) return [];
  const body = _klineData.map(k => Math.abs(Number(k.close) - Number(k.open)));
  const range = _klineData.map(k => Math.max(0, Number(k.high) - Number(k.low)));
  const volume = _klineData.map(k => Number(_klineVolume(k)) || 0);
  const events = [];

  for (let i = 5; i < _klineData.length; i += 1) {
    const k = _klineData[i];
    const baseBody = _medianWindow(body, i - 20, i);
    const baseRange = _medianWindow(range, i - 20, i);
    const baseVol = _medianWindow(volume, i - 20, i);
    const candleRange = range[i];
    if (!baseBody || !baseRange || !candleRange) continue;

    const bodyShare = body[i] / candleRange;
    const bodyRatio = body[i] / baseBody;
    const rangeRatio = candleRange / baseRange;
    const volRatio = baseVol ? volume[i] / baseVol : 1;
    const isImpulse = bodyShare >= 0.58 && bodyRatio >= 2.0 && rangeRatio >= 1.35 && volRatio >= 1.35;
    if (!isImpulse) continue;

    const bullish = Number(k.close) >= Number(k.open);
    events.push({
      index: i,
      time: k.time,
      bullish,
      volRatio,
      rangeRatio,
      bodyRatio,
    });
  }
  return events;
}

function _calcImpulseMarkers() {
  return _calcImpulseEvents(false).map(event => ({
      time: event.time,
      position: event.bullish ? 'belowBar' : 'aboveBar',
      color: event.bullish ? '#7ee787' : '#ff7b86',
      shape: event.bullish ? 'arrowUp' : 'arrowDown',
      text: `IMP ${event.volRatio.toFixed(1)}x`,
      size: 1,
    })).slice(-28);
}

function _renderImpulseMarkers() {
  try {
    if (candleSeries) candleSeries.setMarkers(_calcImpulseMarkers());
  } catch (_) {}
}

function _levelNearPrice(levels, price, tolerance) {
  return levels.find(l => Math.abs(Number(l.price) - price) <= tolerance) || null;
}

function _activeVwapValues() {
  const values = [];
  const sets = _vwapData || {};
  Object.entries(sets).forEach(([key, points]) => {
    const last = Array.isArray(points) ? points[points.length - 1] : null;
    if (last && Number.isFinite(Number(last.value))) values.push({ key, price: Number(last.value) });
  });
  return values;
}

function _calcConfluenceScore() {
  if (!_klineData.length) return { score: 0, tags: ['Нет данных'], bias: 'neutral' };
  const last = _klineData[_klineData.length - 1];
  const price = Number(last.close);
  const tol = Math.max(price * 0.0035, _liquidityZoneTolerance(_klineData) * 1.2);
  const tags = [];
  let score = 0;

  const fvg = _calcImbalances(true).find(z => !z.filled && price >= z.lower - tol && price <= z.upper + tol);
  if (fvg) { score += 2; tags.push(`${fvg.kind === 'bull' ? 'Bull' : 'Bear'} FVG`); }

  const liq = _levelNearPrice(_calcLiquidityZones(), price, tol);
  if (liq) { score += 1.5; tags.push(liq.label); }

  const htf = _levelNearPrice(_calcHtfLevels(true), price, tol);
  if (htf) { score += 1.25; tags.push(htf.label); }

  const vwap = _levelNearPrice(_activeVwapValues(), price, tol);
  if (vwap) { score += 1; tags.push(`VWAP ${vwap.key.toUpperCase()}`); }

  const lastIndex = _klineData.length - 1;
  const recentImpulse = _calcImpulseEvents(true).find(e => lastIndex - e.index <= 12);
  if (recentImpulse) { score += 1.25; tags.push(recentImpulse.bullish ? 'IMP up' : 'IMP down'); }

  const recentSweep = _calcLiquiditySweeps(true).find(s => lastIndex - s.index <= 12);
  if (recentSweep) { score += 1.25; tags.push(`Sweep ${recentSweep.dir === 'high' ? 'H' : 'L'}`); }

  const pd = _calcPremiumDiscount(true);
  if (pd) {
    if (price <= pd.eq) { score += 0.75; tags.push('Discount'); }
    else { score += 0.75; tags.push('Premium'); }
  }

  const cvdNow = _cvdLineData[_cvdLineData.length - 1]?.value;
  const cvdPrev = _cvdLineData[Math.max(0, _cvdLineData.length - 8)]?.value;
  if (Number.isFinite(cvdNow) && Number.isFinite(cvdPrev) && Math.abs(cvdNow - cvdPrev) > 0) {
    score += 0.75;
    tags.push(cvdNow > cvdPrev ? 'CVD+' : 'CVD-');
  }

  const oiNow = _oiData[_oiData.length - 1]?.close ?? _oiData[_oiData.length - 1]?.value;
  const oiPrev = _oiData[Math.max(0, _oiData.length - 8)]?.close ?? _oiData[Math.max(0, _oiData.length - 8)]?.value;
  if (Number.isFinite(oiNow) && Number.isFinite(oiPrev) && Math.abs(oiNow - oiPrev) > 0) {
    score += 0.75;
    tags.push(oiNow > oiPrev ? 'OI+' : 'OI-');
  }

  score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));
  const bias = score >= 7 ? 'high' : score >= 4 ? 'mid' : 'low';
  return { score, tags: tags.slice(0, 8), bias };
}

function _analysisPanelEl() {
  return document.getElementById('analysis-panel');
}

function _clearAnalysisPanel() {
  const panel = _analysisPanelEl();
  if (panel) {
    panel.innerHTML = '';
    panel.classList.remove('visible');
  }
}

function _fmtAnalysisPrice(price) {
  return Number.isFinite(Number(price)) ? fmt.price(Number(price)) : '—';
}

function _fmtAnalysisPct(from, to) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !a) return '—';
  const pct = ((b - a) / a) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function _nearestLevelCandidates(price, tolerance) {
  const candidates = [];
  _calcHtfLevels(true).forEach(l => candidates.push({ type: 'HTF', label: l.label, price: l.price, side: l.price >= price ? 'above' : 'below', weight: 3 }));
  _calcLiquidityZones().forEach(l => candidates.push({ type: 'LIQ', label: l.label, price: l.price, side: l.price >= price ? 'above' : 'below', weight: 2.8 }));
  _activeVwapValues().forEach(v => candidates.push({ type: 'VWAP', label: `VWAP ${v.key.toUpperCase()}`, price: v.price, side: v.price >= price ? 'above' : 'below', weight: 2.1 }));
  const pd = _calcPremiumDiscount(true);
  if (pd) {
    candidates.push({ type: 'PD', label: 'EQ', price: pd.eq, side: pd.eq >= price ? 'above' : 'below', weight: 1.8 });
    candidates.push({ type: 'PD', label: 'Range High', price: pd.high, side: 'above', weight: 1.6 });
    candidates.push({ type: 'PD', label: 'Range Low', price: pd.low, side: 'below', weight: 1.6 });
  }
  _calcImbalances(true)
    .filter(z => !z.filled)
    .forEach(z => {
      const middle = z.mid || (z.lower + z.upper) / 2;
      candidates.push({
        type: 'FVG',
        label: z.kind === 'bull' ? 'Bull FVG' : 'Bear FVG',
        price: middle,
        side: middle >= price ? 'above' : 'below',
        weight: z.status === 'fresh' ? 2.6 : 2.0,
      });
    });

  return candidates
    .filter(c => Number.isFinite(Number(c.price)))
    .map(c => ({
      ...c,
      distance: Math.abs(Number(c.price) - price),
      near: Math.abs(Number(c.price) - price) <= tolerance,
    }))
    .sort((a, b) => (a.distance / Math.max(0.1, a.weight)) - (b.distance / Math.max(0.1, b.weight)));
}

function _latestFlowSignal() {
  const lastIndex = _klineData.length - 1;
  const impulse = _calcImpulseEvents(true).filter(e => lastIndex - e.index <= 16).pop();
  const sweep = _calcLiquiditySweeps(true).filter(s => lastIndex - s.index <= 16).pop();
  const structure = _calcStructureEvents(true).filter(e => lastIndex - e.index <= 24).pop();
  const cvdNow = _cvdLineData[_cvdLineData.length - 1]?.value;
  const cvdPrev = _cvdLineData[Math.max(0, _cvdLineData.length - 8)]?.value;
  const oiNow = _oiData[_oiData.length - 1]?.close ?? _oiData[_oiData.length - 1]?.value;
  const oiPrev = _oiData[Math.max(0, _oiData.length - 8)]?.close ?? _oiData[Math.max(0, _oiData.length - 8)]?.value;
  return {
    impulse,
    sweep,
    structure,
    cvdDir: Number.isFinite(cvdNow) && Number.isFinite(cvdPrev) ? Math.sign(cvdNow - cvdPrev) : 0,
    oiDir: Number.isFinite(oiNow) && Number.isFinite(oiPrev) ? Math.sign(oiNow - oiPrev) : 0,
  };
}

function _deriveAnalysisBias(score, price, pd, flow) {
  let points = 0;
  const reasons = [];
  const fvg = _calcImbalances(true).find(z => !z.filled && price >= z.lower && price <= z.upper);
  if (fvg?.kind === 'bull') { points += 2; reasons.push('цена в бычьем FVG'); }
  if (fvg?.kind === 'bear') { points -= 2; reasons.push('цена в медвежьем FVG'); }
  if (pd) {
    if (price <= pd.eq) { points += 1; reasons.push('цена в discount'); }
    else { points -= 1; reasons.push('цена в premium'); }
  }
  if (flow.structure?.dir === 'up') { points += flow.structure.kind === 'CHOCH' ? 1.6 : 1.1; reasons.push(`${flow.structure.kind} вверх`); }
  if (flow.structure?.dir === 'down') { points -= flow.structure.kind === 'CHOCH' ? 1.6 : 1.1; reasons.push(`${flow.structure.kind} вниз`); }
  if (flow.sweep?.dir === 'low') { points += 1.2; reasons.push('снятие low'); }
  if (flow.sweep?.dir === 'high') { points -= 1.2; reasons.push('снятие high'); }
  if (flow.impulse?.bullish) { points += 0.8; reasons.push('последний импульс вверх'); }
  if (flow.impulse && !flow.impulse.bullish) { points -= 0.8; reasons.push('последний импульс вниз'); }
  if (flow.cvdDir > 0) { points += 0.6; reasons.push('CVD растёт'); }
  if (flow.cvdDir < 0) { points -= 0.6; reasons.push('CVD падает'); }
  if (flow.oiDir > 0) reasons.push('OI растёт');
  if (flow.oiDir < 0) reasons.push('OI снижается');

  const abs = Math.abs(points);
  const side = abs < 1.2 ? 'neutral' : points > 0 ? 'long' : 'short';
  const confidence = Math.max(1, Math.min(10, Math.round((score.score * 0.55 + abs * 1.35) * 10) / 10));
  return { side, points, confidence, reasons: reasons.slice(0, 8) };
}

function _scenarioFromSide(side, price, levels, atr) {
  const below = levels.filter(l => l.price < price).sort((a, b) => b.price - a.price);
  const above = levels.filter(l => l.price > price).sort((a, b) => a.price - b.price);
  const support = below[0];
  const resistance = above[0];
  const buffer = Math.max(atr * 0.38, price * 0.0012);

  if (side === 'long') {
    const entryAnchor = support?.near ? support.price : Math.min(price, support?.price ?? price);
    const entryLow = Math.min(price, entryAnchor + buffer * 0.35);
    const entryHigh = Math.max(entryLow, price + buffer * 0.55);
    const stop = (support?.price ?? price - atr) - buffer;
    const risk = Math.max(price - stop, atr * 0.55);
    const t1 = Math.max(resistance?.price && resistance.price > price ? resistance.price : price + risk * 1.2, price + risk);
    const t2 = Math.max(above[1]?.price && above[1].price > price ? above[1].price : price + risk * 2, t1 + risk * 0.75, price + risk * 1.8);
    const t3 = Math.max(above[2]?.price && above[2].price > price ? above[2].price : price + risk * 3, t2 + risk * 0.75, price + risk * 2.6);
    const targets = [t1, t2, t3];
    return {
      side,
      title: 'Long сценарий',
      trigger: 'Закрепление выше входной зоны + удержание VWAP/FVG; желательно после sweep low или BOS вверх.',
      entryLow,
      entryHigh,
      stop,
      targets,
      invalidation: `Отмена long при закрытии ниже ${_fmtAnalysisPrice(stop)} или новом BOS вниз.`,
      anchor: support?.label || 'ближайшая поддержка',
    };
  }

  const entryAnchor = resistance?.near ? resistance.price : Math.max(price, resistance?.price ?? price);
  const entryHigh = Math.max(price, entryAnchor - buffer * 0.35);
  const entryLow = Math.min(entryHigh, price - buffer * 0.55);
  const stop = (resistance?.price ?? price + atr) + buffer;
  const risk = Math.max(stop - price, atr * 0.55);
  const t1 = Math.min(support?.price && support.price < price ? support.price : price - risk * 1.2, price - risk);
  const t2 = Math.min(below[1]?.price && below[1].price < price ? below[1].price : price - risk * 2, t1 - risk * 0.75, price - risk * 1.8);
  const t3 = Math.min(below[2]?.price && below[2].price < price ? below[2].price : price - risk * 3, t2 - risk * 0.75, price - risk * 2.6);
  const targets = [t1, t2, t3];
  return {
    side,
    title: 'Short сценарий',
    trigger: 'Отбой от входной зоны + потеря VWAP/FVG; желательно после sweep high или BOS вниз.',
    entryLow,
    entryHigh,
    stop,
    targets,
    invalidation: `Отмена short при закрытии выше ${_fmtAnalysisPrice(stop)} или новом BOS вверх.`,
    anchor: resistance?.label || 'ближайшее сопротивление',
  };
}

function _analysisAtr() {
  const ranges = _klineData.slice(-80).map(k => Number(k.high) - Number(k.low)).filter(v => Number.isFinite(v) && v > 0);
  return _median(ranges) || (_klineData[_klineData.length - 1]?.close || 0) * 0.004;
}

function _calcTradeAnalysis() {
  if (!_klineData.length) return null;
  const last = _klineData[_klineData.length - 1];
  const price = Number(last.close);
  const atr = _analysisAtr();
  const tol = Math.max(price * 0.004, atr * 0.9);
  const score = _calcConfluenceScore();
  const pd = _calcPremiumDiscount(true);
  const flow = _latestFlowSignal();
  const bias = _deriveAnalysisBias(score, price, pd, flow);
  const levels = _nearestLevelCandidates(price, tol);
  const mainSide = bias.side === 'neutral'
    ? (pd && price <= pd.eq ? 'long' : 'short')
    : bias.side;
  const primary = _scenarioFromSide(mainSide, price, levels, atr);
  const alternate = _scenarioFromSide(mainSide === 'long' ? 'short' : 'long', price, levels, atr);
  const nearest = levels.slice(0, 5);
  return { price, atr, score, pd, flow, bias, primary, alternate, nearest };
}

function _scenarioHtml(s, price, primary = false) {
  if (!s) return '';
  const risk = s.side === 'long' ? price - s.stop : s.stop - price;
  const rr = s.targets.map(t => {
    const reward = s.side === 'long' ? t - price : price - t;
    return risk > 0 ? Math.max(0, reward / risk) : 0;
  });
  return (
    `<div class="analysis-scenario ${primary ? 'primary' : ''} ${s.side}">` +
      `<div class="analysis-scenario-head"><b>${s.title}</b><span>${primary ? 'основной' : 'альтернатива'}</span></div>` +
      `<div class="analysis-grid">` +
        `<span>Вход</span><b>${_fmtAnalysisPrice(s.entryLow)} - ${_fmtAnalysisPrice(s.entryHigh)}</b>` +
        `<span>Стоп</span><b>${_fmtAnalysisPrice(s.stop)}</b>` +
        `<span>TP1</span><b>${_fmtAnalysisPrice(s.targets[0])} · R ${rr[0].toFixed(2)}</b>` +
        `<span>TP2</span><b>${_fmtAnalysisPrice(s.targets[1])} · R ${rr[1].toFixed(2)}</b>` +
        `<span>TP3</span><b>${_fmtAnalysisPrice(s.targets[2])} · R ${rr[2].toFixed(2)}</b>` +
      `</div>` +
      `<p>${s.trigger}</p>` +
      `<p>${s.invalidation}</p>` +
    `</div>`
  );
}

function _renderAnalysisPanel() {
  const panel = _analysisPanelEl();
  if (!panel) return;
  if (!activeInds.has('analysis') || !chart || !_klineData.length) {
    panel.innerHTML = '';
    panel.classList.remove('visible');
    return;
  }

  const a = _calcTradeAnalysis();
  if (!a) {
    panel.innerHTML = '';
    panel.classList.remove('visible');
    return;
  }

  const biasText = a.bias.side === 'long' ? 'LONG bias' : a.bias.side === 'short' ? 'SHORT bias' : 'NEUTRAL';
  const biasClass = a.bias.side === 'long' ? 'long' : a.bias.side === 'short' ? 'short' : 'neutral';
  const nearest = a.nearest.length
    ? a.nearest.map(l => `<span>${l.label} ${_fmtAnalysisPrice(l.price)} ${_fmtAnalysisPct(a.price, l.price)}</span>`).join('')
    : '<span>Нет близких уровней</span>';
  const reasons = a.bias.reasons.length ? a.bias.reasons.map(r => `<span>${r}</span>`).join('') : '<span>Сигналы смешанные</span>';

  panel.innerHTML = (
    `<div class="analysis-head">` +
      `<div><b>Анализ ${chartSymbol || ''}</b><span>${chartTf} · цена ${_fmtAnalysisPrice(a.price)}</span></div>` +
      `<button type="button" onclick="toggleInd('analysis')" title="Скрыть анализ">×</button>` +
    `</div>` +
    `<div class="analysis-bias ${biasClass}">` +
      `<b>${biasText}</b><span>Score ${a.score.score}/10 · confidence ${a.bias.confidence}/10</span>` +
    `</div>` +
    `<div class="analysis-tags">${reasons}</div>` +
    _scenarioHtml(a.primary, a.price, true) +
    _scenarioHtml(a.alternate, a.price, false) +
    `<div class="analysis-nearest"><b>Ближайшие зоны</b><div>${nearest}</div></div>` +
    `<div class="analysis-note">Сценарии считаются от текущих OHLCV/OI/CVD/VWAP/FVG/HTF/плотностей. Это план условий, а не команда входить без подтверждения.</div>`
  );
  panel.classList.add('visible');
}

function _pushHorzLevel(html, className, price, label, plotRight, x0 = 0, x1 = null) {
  const y = candleSeries.priceToCoordinate(price);
  if (!Number.isFinite(y)) return;
  const left = _clip(x0, 0, plotRight);
  const right = _clip(x1 == null ? plotRight : x1, 0, plotRight);
  const width = Math.max(0, right - left);
  if (width < 8) return;
  html.push(`<div class="${className}" style="left:${left}px;top:${y}px;width:${width}px"><span>${label}</span></div>`);
}

function _renderMarketStructure() {
  const overlay = _marketStructureOverlayEl();
  if (!overlay) return;
  overlay.innerHTML = '';
  _renderImpulseMarkers();
  if (!chart || !candleSeries || !_klineData.length) return;

  const container = document.getElementById('chart-container');
  const plotRight = _chartPlotRight(container);
  if (!plotRight) return;
  const html = [];
  const chartHeight = container.clientHeight || 0;

  const pd = _calcPremiumDiscount();
  if (pd) {
    const yHigh = candleSeries.priceToCoordinate(pd.high);
    const yEq = candleSeries.priceToCoordinate(pd.eq);
    const yLow = candleSeries.priceToCoordinate(pd.low);
    if ([yHigh, yEq, yLow].every(Number.isFinite)) {
      const premiumTop = Math.min(yHigh, yEq);
      const premiumH = Math.max(4, Math.abs(yEq - yHigh));
      const discountTop = Math.min(yEq, yLow);
      const discountH = Math.max(4, Math.abs(yLow - yEq));
      html.push(`<div class="pd-zone premium" style="top:${premiumTop}px;height:${premiumH}px;width:${plotRight}px"><span>Premium</span></div>`);
      html.push(`<div class="pd-zone discount" style="top:${discountTop}px;height:${discountH}px;width:${plotRight}px"><span>Discount</span></div>`);
      html.push(`<div class="pd-eq-line" style="top:${yEq}px;width:${plotRight}px"><span>EQ ${fmt.price(pd.eq)}</span></div>`);
    }
  }

  for (const zone of _calcSessionZones()) {
    const x0 = _timeToX(zone.x0, plotRight);
    const x1 = _timeToX(zone.x1, plotRight);
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
    const left = _clip(Math.min(x0, x1), 0, plotRight);
    const right = _clip(Math.max(x0, x1), 0, plotRight);
    const width = right - left;
    if (width < 2) continue;
    const labelX = left + width / 2;
    const labelTop = 28 + zone.sessionIndex * 16;
    html.push(`<div class="session-zone ${zone.key}" style="left:${left}px;width:${width}px"></div>`);
    if (width >= 42) {
      const rangeText = zone.stats?.rangePct != null ? ` ${zone.stats.rangePct.toFixed(2)}%` : '';
      html.push(`<div class="session-label" style="left:${labelX}px;top:${labelTop}px">${zone.label}${rangeText}</div>`);
    }
    if (zone.stats && width >= 70 && _tfSeconds() <= 3600) {
      const highY = candleSeries.priceToCoordinate(zone.stats.high);
      const lowY = candleSeries.priceToCoordinate(zone.stats.low);
      if (Number.isFinite(highY)) html.push(`<div class="session-hilo high" style="left:${left}px;top:${highY}px;width:${width}px"><span>H</span></div>`);
      if (Number.isFinite(lowY)) html.push(`<div class="session-hilo low" style="left:${left}px;top:${lowY}px;width:${width}px"><span>L</span></div>`);
    }
  }

  for (const level of _calcHtfLevels()) {
    _pushHorzLevel(html, `htf-level ${level.kind}`, level.price, `${level.label} ${fmt.price(level.price)}`, plotRight);
  }

  for (const ev of _calcStructureEvents()) {
    const x0 = _timeToX(ev.fromTime, plotRight);
    const x1 = _timeToX(ev.time, plotRight);
    const y = candleSeries.priceToCoordinate(ev.price);
    if (![x0, x1, y].every(Number.isFinite)) continue;
    const left = _clip(Math.min(x0, x1), 0, plotRight);
    const right = _clip(Math.max(x0, x1), 0, plotRight);
    const width = right - left;
    if (width < 12 || y < -20 || y > chartHeight + 20) continue;
    const labelX = _clip(x1, 30, plotRight - 46);
    html.push(`<div class="structure-line ${ev.dir}" style="left:${left}px;top:${y}px;width:${width}px"></div>`);
    html.push(`<div class="structure-label ${ev.dir}" style="left:${labelX}px;top:${y}px">${ev.kind}</div>`);
  }

  for (const sweep of _calcLiquiditySweeps()) {
    const x = _timeToX(sweep.time, plotRight);
    const x0 = _timeToX(sweep.levelTime, plotRight);
    const y = candleSeries.priceToCoordinate(sweep.price);
    if (![x, y].every(Number.isFinite)) continue;
    const left = Number.isFinite(x0) ? _clip(Math.min(x0, x), 0, plotRight) : _clip(x - 34, 0, plotRight);
    const width = Math.max(18, _clip(Math.abs(x - left), 18, 120));
    const labelY = sweep.dir === 'high' ? y - 18 : y + 8;
    html.push(`<div class="sweep-line ${sweep.dir}" style="left:${left}px;top:${y}px;width:${width}px"></div>`);
    html.push(`<div class="sweep-label ${sweep.dir}" style="left:${_clip(x, 30, plotRight - 72)}px;top:${labelY}px">Sweep ${sweep.dir === 'high' ? 'H' : 'L'}</div>`);
  }

  for (const zone of _calcImbalances()) {
    const x0 = _timeToX(zone.x0, plotRight);
    const x1 = _timeToX(zone.x1, plotRight);
    const yUpper = candleSeries.priceToCoordinate(zone.upper);
    const yLower = candleSeries.priceToCoordinate(zone.lower);
    const yMid = candleSeries.priceToCoordinate(zone.mid);
    if (![x0, x1, yUpper, yLower, yMid].every(Number.isFinite)) continue;
    const left = _clip(Math.min(x0, x1), 0, plotRight);
    const right = _clip(Math.max(x0, x1), 0, plotRight);
    const width = right - left;
    if (width < 5) continue;
    const top = Math.min(yUpper, yLower);
    const height = Math.max(4, Math.abs(yLower - yUpper));
    const statusLabel = zone.status === 'mid' ? '50%' : zone.status === 'touched' ? 'touch' : zone.status === 'filled' ? 'fill' : zone.status === 'invalidated' ? 'inv' : 'fresh';
    const label = `${zone.kind === 'bull' ? 'FVG+' : 'FVG-'} ${statusLabel}`;
    const state = ` ${zone.status}`;
    const showLabel = x0 >= 0 && x0 <= plotRight && width >= 48;
    html.push(
      `<div class="imbalance-zone ${zone.kind}${state}" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px">` +
        `<span class="imbalance-midline" style="top:${_clip(yMid - top, 0, height)}px"></span>` +
        (showLabel ? `<span class="imbalance-label">${label}</span>` : '') +
      `</div>`
    );
  }

  if (activeInds.has('score')) {
    const score = _calcConfluenceScore();
    html.push(
      `<div class="confluence-card ${score.bias}">` +
        `<b>Score ${score.score.toFixed(score.score % 1 ? 1 : 0)}/10</b>` +
        `<span>${score.tags.length ? score.tags.join(' · ') : 'Нет факторов'}</span>` +
      `</div>`
    );
  }

  overlay.innerHTML = html.join('');
}

function _scheduleMarketStructure() {
  if (_marketStructureRaf) return;
  _marketStructureRaf = requestAnimationFrame(() => {
    _marketStructureRaf = null;
    _renderMarketStructure();
  });
}

// ── Anchored VWAP ──────────────────────────────────────────────────────────────
function _ensureVwapSeries() {
  if (!chart || vwapDaySeries) return;
  vwapDaySeries = chart.addLineSeries({
    color: '#f0b429', lineWidth: 1, lastValueVisible: true, priceLineVisible: false,
    title: 'VWAP D',
  });
  vwapWeekSeries = chart.addLineSeries({
    color: '#58a6ff', lineWidth: 1, lastValueVisible: true, priceLineVisible: false,
    title: 'VWAP W',
  });
  vwapImpulseSeries = chart.addLineSeries({
    color: '#d2a8ff', lineWidth: 1, lastValueVisible: true, priceLineVisible: false,
    title: 'VWAP IMP',
  });
}

function _destroyVwap() {
  [vwapDaySeries, vwapWeekSeries, vwapImpulseSeries].forEach(series => {
    try { if (chart && series) chart.removeSeries(series); } catch (_) {}
  });
  vwapDaySeries = vwapWeekSeries = vwapImpulseSeries = null;
  _vwapData = { day: [], week: [], impulse: [] };
}

function _clearVwapData() {
  _vwapData = { day: [], week: [], impulse: [] };
  try { if (vwapDaySeries) vwapDaySeries.setData([]); } catch (_) {}
  try { if (vwapWeekSeries) vwapWeekSeries.setData([]); } catch (_) {}
  try { if (vwapImpulseSeries) vwapImpulseSeries.setData([]); } catch (_) {}
}

function _vwapVolume(k, typical) {
  const base = Number(k.volume);
  if (Number.isFinite(base) && base > 0) return base;
  const quote = Number(k.quote_volume);
  return Number.isFinite(quote) && quote > 0 && typical > 0 ? quote / typical : 0;
}

function _calcVwapFromIndex(anchorIdx) {
  if (anchorIdx == null || anchorIdx < 0 || anchorIdx >= _klineData.length) return [];
  const out = [];
  let pv = 0;
  let vol = 0;
  for (let i = anchorIdx; i < _klineData.length; i += 1) {
    const k = _klineData[i];
    const typical = (Number(k.high) + Number(k.low) + Number(k.close)) / 3;
    const v = _vwapVolume(k, typical);
    if (!Number.isFinite(typical) || !v) continue;
    pv += typical * v;
    vol += v;
    if (vol > 0) out.push({ time: k.time, value: pv / vol });
  }
  return out;
}

function _firstIndexFromTime(startTime) {
  return _klineData.findIndex(k => k.time >= startTime);
}

function _lastImpulseAnchorIndex() {
  const events = _calcImpulseEvents(true);
  const last = events[events.length - 1];
  return last ? last.index : Math.max(0, _klineData.length - 80);
}

function _renderVwap() {
  if (!activeInds.has('vwap') || !_klineData.length) {
    _clearVwapData();
    return;
  }
  _ensureVwapSeries();
  const lastTime = _klineData[_klineData.length - 1].time;
  const dayIdx = _firstIndexFromTime(_utcDayStart(lastTime));
  const weekIdx = _firstIndexFromTime(_utcWeekStart(lastTime));
  _vwapData = {
    day: _calcVwapFromIndex(dayIdx >= 0 ? dayIdx : 0),
    week: _calcVwapFromIndex(weekIdx >= 0 ? weekIdx : 0),
    impulse: _calcVwapFromIndex(_lastImpulseAnchorIndex()),
  };
  try { if (vwapDaySeries) vwapDaySeries.setData(_vwapData.day); } catch (_) {}
  try { if (vwapWeekSeries) vwapWeekSeries.setData(_vwapData.week); } catch (_) {}
  try { if (vwapImpulseSeries) vwapImpulseSeries.setData(_vwapData.impulse); } catch (_) {}
  _scheduleMarketStructure();
  _renderAnalysisPanel();
}

// ── Live orderbook heatmap ─────────────────────────────────────────────────────
function _orderbookOverlayEl() {
  return document.getElementById('orderbook-heatmap-overlay');
}

function _orderbookPanelEl() {
  return document.getElementById('orderbook-panel');
}

function _setOrderbookPanelVisible(visible) {
  const panel = _orderbookPanelEl();
  const axis = document.getElementById('chart-time-axis');
  let changed = false;
  if (panel) {
    changed = panel.classList.contains('open') !== !!visible;
    panel.classList.toggle('open', !!visible);
    panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }
  if (axis) axis.classList.toggle('book-open', !!visible);
  if (!changed) return;
  requestAnimationFrame(() => {
    try {
      if (chart) {
        const container = document.getElementById('chart-container');
        if (container) chart.resize(container.clientWidth, container.clientHeight);
      }
    } catch (_) {}
    _renderTimeAxis();
    _scheduleOrderbookHeatmap();
    _scheduleVP();
  });
}

function _clearOrderbookHeatmap(clearData = true) {
  if (_orderbookRaf) {
    cancelAnimationFrame(_orderbookRaf);
    _orderbookRaf = null;
  }
  if (_orderbookHeatmapTimer) {
    clearTimeout(_orderbookHeatmapTimer);
    _orderbookHeatmapTimer = null;
  }
  if (_orderbookPanelRaf) {
    cancelAnimationFrame(_orderbookPanelRaf);
    _orderbookPanelRaf = null;
  }
  if (_orderbookPanelTimer) {
    clearTimeout(_orderbookPanelTimer);
    _orderbookPanelTimer = null;
  }
  if (clearData) {
    _orderbookData = null;
    _orderbookDataDirty = false;
    _orderbookDirtySymbol = null;
    _orderbookDirtyEventTime = null;
    _orderbookHeatmapStableStep = 0;
    _orderbookHeatmapStableSymbol = null;
    _orderbookHeatmapLastRenderAt = 0;
    _resetOrderbookAccumulator();
    _resetOrderbookHistory();
  }
  if (_orderbookAutoscaleRange) {
    _orderbookAutoscaleRange = null;
    try { if (candleSeries) candleSeries.applyOptions({ autoscaleInfoProvider: _mainAutoscaleInfoProvider }); } catch (_) {}
  }
  const overlay = _orderbookOverlayEl();
  _orderbookOverlayHtml = '';
  if (overlay) overlay.innerHTML = '';
}

function _clearOrderbookPanel() {
  _setOrderbookPanelVisible(false);
  const ids = ['orderbook-asks', 'orderbook-bids', 'orderbook-mid'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
}

function _orderbookStatusHtml(text) {
  return `<div class="orderbook-status">${text}</div>`;
}

function _setOrderbookOverlayHtml(html, overlay = _orderbookOverlayEl()) {
  const next = String(html || '');
  if (!overlay || next === _orderbookOverlayHtml) return;
  _orderbookOverlayHtml = next;
  overlay.innerHTML = next;
}

function _orderbookMidFromSides(asks = [], bids = []) {
  const refMid = Number(_orderbookData?.reference_mid ?? _orderbookBookMeta?.reference_mid);
  if (_orderbookSourceMode() === 'multi' && Number.isFinite(refMid) && refMid > 0) return refMid;
  const bestAsk = Number(asks?.[0]?.price);
  const bestBid = Number(bids?.[0]?.price);
  if (Number.isFinite(bestAsk) && Number.isFinite(bestBid) && bestAsk > 0 && bestBid > 0) return (bestAsk + bestBid) / 2;
  const last = Number(_klineData[_klineData.length - 1]?.close);
  return Number.isFinite(last) && last > 0 ? last : 0;
}

function _mainAutoscaleInfoProvider(baseImplementation) {
  const base = typeof baseImplementation === 'function' ? baseImplementation() : null;
  if (!base?.priceRange || !activeInds.has('book') || !_orderbookAutoscaleRange) return base;
  const baseMin = Number(base.priceRange.minValue);
  const baseMax = Number(base.priceRange.maxValue);
  const bookMin = Number(_orderbookAutoscaleRange.min);
  const bookMax = Number(_orderbookAutoscaleRange.max);
  if (
    !Number.isFinite(baseMin) ||
    !Number.isFinite(baseMax) ||
    !Number.isFinite(bookMin) ||
    !Number.isFinite(bookMax)
  ) return base;
  return {
    ...base,
    priceRange: {
      minValue: Math.min(baseMin, bookMin),
      maxValue: Math.max(baseMax, bookMax),
    },
  };
}

function _selectOrderbookAutoscaleRows(rows, mid) {
  if (!rows?.length || !Number.isFinite(mid) || mid <= 0) return [];
  const maxDistance = mid * _orderbookHeatmapRangePct();
  const nearRows = rows.filter(row => {
    const price = Number(row.price);
    return Number.isFinite(price) && Math.abs(price - mid) <= maxDistance;
  });
  const selected = [];
  ['bid', 'ask'].forEach(side => {
    const zonesPerSide = _orderbookHeatmapZonesPerSide();
    const sideRows = nearRows
      .filter(row => row.side === side)
      .sort((a, b) => Number(b.score || b.notional) - Number(a.score || a.notional));
    const eligible = sideRows.filter(row => Number(row.maxNotional || row.notional) >= ORDERBOOK_HEATMAP_MIN_NOTIONAL);
    const source = eligible.length >= zonesPerSide
      ? eligible
      : [...eligible, ...sideRows.filter(row => !eligible.includes(row))];
    selected.push(...source.slice(0, zonesPerSide));
  });
  return selected;
}

function _setOrderbookAutoscaleRange(rows, asks = [], bids = []) {
  const mid = _orderbookMidFromSides(asks, bids);
  const selected = _selectOrderbookAutoscaleRows(rows, mid);
  let next = null;
  if (selected.length && mid > 0) {
    const rangePct = _orderbookHeatmapRangePct();
    const capMin = mid * (1 - rangePct);
    const capMax = mid * (1 + rangePct);
    const min = Math.max(capMin, Math.min(...selected.map(row => Number(row.minPrice ?? row.lower ?? row.price)).filter(Number.isFinite)));
    const max = Math.min(capMax, Math.max(...selected.map(row => Number(row.maxPrice ?? row.upper ?? row.price)).filter(Number.isFinite)));
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) next = { min, max };
  }
  const prev = _orderbookAutoscaleRange;
  const changed = !!prev !== !!next || (
    prev && next && (
      Math.abs(prev.min - next.min) > mid * 0.00001 ||
      Math.abs(prev.max - next.max) > mid * 0.00001
    )
  );
  _orderbookAutoscaleRange = next;
  if (changed && candleSeries) {
    try { candleSeries.applyOptions({ autoscaleInfoProvider: _mainAutoscaleInfoProvider }); } catch (_) {}
    requestAnimationFrame(() => _scheduleOrderbookHeatmap());
  }
}

function _setOrderbookPanelMessage(text) {
  const panel = _orderbookPanelEl();
  if (!panel || !activeInds.has('book')) return;
  _setOrderbookPanelVisible(true);
  const sym = document.getElementById('orderbook-panel-symbol');
  const asks = document.getElementById('orderbook-asks');
  const bids = document.getElementById('orderbook-bids');
  const mid = document.getElementById('orderbook-mid');
  if (sym) sym.textContent = chartSymbol || '—';
  if (asks) asks.innerHTML = `<div class="orderbook-message">${text}</div>`;
  if (bids) bids.innerHTML = '';
  if (mid) mid.innerHTML = '';
}

function _setOrderbookStatus(text) {
  const overlay = _orderbookOverlayEl();
  if (ORDERBOOK_HEATMAP_ENABLED && overlay && activeInds.has('book')) _setOrderbookOverlayHtml(_orderbookStatusHtml(text), overlay);
  _setOrderbookPanelMessage(text.replace(/^Book:\s*/, ''));
}

function _pickOrderbookOption(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function _orderbookHeatmapRangeCount() {
  const count = Number(_orderbookSettings?.heatmapRanges);
  return _pickOrderbookOption(count, ORDERBOOK_HEATMAP_RANGE_OPTIONS, ORDERBOOK_HEATMAP_DEFAULT_RANGES);
}

function _orderbookHeatmapZonesPerSide() {
  return Math.max(1, Math.ceil(_orderbookHeatmapRangeCount() / 2));
}

function _orderbookHeatmapRangePct() {
  const pct = Number(_orderbookSettings?.heatmapRangePct);
  return _pickOrderbookOption(pct, ORDERBOOK_HEATMAP_RANGE_PCT_OPTIONS, ORDERBOOK_HEATMAP_DEFAULT_RANGE_PCT);
}

function _fmtOrderbookRangePct(value = _orderbookHeatmapRangePct()) {
  const pct = Number(value) * 100;
  if (!Number.isFinite(pct) || pct <= 0) return '—';
  return `${pct.toLocaleString('en-US', { maximumFractionDigits: pct < 10 ? 1 : 0 })}%`;
}

function _orderbookPanelRangePct() {
  const pct = Number(_orderbookSettings?.panelRangePct);
  return _pickOrderbookOption(pct, ORDERBOOK_PANEL_RANGE_PCT_OPTIONS, ORDERBOOK_PANEL_DEFAULT_RANGE_PCT);
}

function _orderbookSourceMode() {
  return _pickOrderbookOption(String(_orderbookSettings?.sourceMode || ''), ORDERBOOK_SOURCE_OPTIONS, ORDERBOOK_DEFAULT_SOURCE);
}

function _normalizeOrderbookSettings(raw = {}) {
  const defaults = ORDERBOOK_DEFAULT_SETTINGS;
  const rows = Number(raw.rows);
  const depthLimit = Number(raw.depthLimit);
  const groupStep = Number(raw.groupStep);
  const minNotional = Number(raw.minNotional);
  const panelRangePct = Number(raw.panelRangePct);
  const heatmapRanges = Number(raw.heatmapRanges);
  const heatmapStep = Number(raw.heatmapStep);
  const heatmapRangePct = Number(raw.heatmapRangePct);
  return {
    sourceMode: _pickOrderbookOption(String(raw.sourceMode || ''), ORDERBOOK_SOURCE_OPTIONS, defaults.sourceMode),
    rows: _pickOrderbookOption(rows, ORDERBOOK_PANEL_ROW_OPTIONS, defaults.rows),
    depthLimit: _pickOrderbookOption(depthLimit, [100, 500, 1000], defaults.depthLimit),
    updateSpeed: _pickOrderbookOption(String(raw.updateSpeed || ''), ['100ms', '500ms'], defaults.updateSpeed),
    groupMode: raw.groupMode === 'manual' ? 'manual' : 'auto',
    groupStep: Number.isFinite(groupStep) && groupStep > 0 ? groupStep : defaults.groupStep,
    minNotional: _pickOrderbookOption(minNotional, [0, 25000, 100000, 500000, 1000000], defaults.minNotional),
    panelRangePct: _pickOrderbookOption(panelRangePct, ORDERBOOK_PANEL_RANGE_PCT_OPTIONS, defaults.panelRangePct),
    heatmapRanges: _pickOrderbookOption(heatmapRanges, ORDERBOOK_HEATMAP_RANGE_OPTIONS, defaults.heatmapRanges),
    heatmapWindow: _pickOrderbookOption(String(raw.heatmapWindow || ''), ORDERBOOK_HEATMAP_WINDOW_OPTIONS, defaults.heatmapWindow),
    heatmapStep: Number.isFinite(heatmapStep) && heatmapStep > 0 ? heatmapStep : defaults.heatmapStep,
    heatmapRangePct: _pickOrderbookOption(heatmapRangePct, ORDERBOOK_HEATMAP_RANGE_PCT_OPTIONS, defaults.heatmapRangePct),
  };
}

function _loadOrderbookSettings() {
  try {
    return _normalizeOrderbookSettings(JSON.parse(localStorage.getItem(ORDERBOOK_SETTINGS_STORAGE_KEY) || '{}'));
  } catch (_) {
    return { ...ORDERBOOK_DEFAULT_SETTINGS };
  }
}

function _saveOrderbookSettings() {
  try { localStorage.setItem(ORDERBOOK_SETTINGS_STORAGE_KEY, JSON.stringify(_orderbookSettings)); } catch (_) {}
}

function _setOrderbookControlValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = String(value);
}

function _syncOrderbookSettingsControls() {
  _setOrderbookControlValue('orderbook-source-mode', _orderbookSettings.sourceMode);
  _setOrderbookControlValue('orderbook-group-mode', _orderbookSettings.groupMode);
  _setOrderbookControlValue('orderbook-group-step', _orderbookSettings.groupStep || '');
  _setOrderbookControlValue('orderbook-rows', _orderbookSettings.rows);
  _setOrderbookControlValue('orderbook-min-notional', _orderbookSettings.minNotional);
  _setOrderbookControlValue('orderbook-panel-range-pct', _orderbookSettings.panelRangePct);
  _setOrderbookControlValue('orderbook-heatmap-ranges', _orderbookSettings.heatmapRanges);
  _setOrderbookControlValue('orderbook-heatmap-window', _orderbookSettings.heatmapWindow);
  _setOrderbookControlValue('orderbook-heatmap-step', _orderbookSettings.heatmapStep || '');
  _setOrderbookControlValue('orderbook-heatmap-range-pct', _orderbookSettings.heatmapRangePct);
  _setOrderbookControlValue('orderbook-depth', _orderbookSettings.depthLimit);
  _setOrderbookControlValue('orderbook-speed', _orderbookSettings.updateSpeed);
  const step = document.getElementById('orderbook-group-step');
  if (step) {
    step.disabled = _orderbookSettings.groupMode !== 'manual';
    step.placeholder = _orderbookSettings.groupMode === 'manual' ? 'auto' : '';
  }
}

function updateOrderbookSettings(reconnect = true) {
  const prev = _orderbookSettings;
  const read = (id, fallback = '') => document.getElementById(id)?.value ?? fallback;
  _orderbookSettings = _normalizeOrderbookSettings({
    sourceMode: read('orderbook-source-mode', prev.sourceMode),
    groupMode: read('orderbook-group-mode', prev.groupMode),
    groupStep: read('orderbook-group-step', prev.groupStep),
    rows: read('orderbook-rows', prev.rows),
    minNotional: read('orderbook-min-notional', prev.minNotional),
    panelRangePct: read('orderbook-panel-range-pct', prev.panelRangePct),
    heatmapRanges: read('orderbook-heatmap-ranges', prev.heatmapRanges),
    heatmapWindow: read('orderbook-heatmap-window', prev.heatmapWindow),
    heatmapStep: read('orderbook-heatmap-step', prev.heatmapStep),
    heatmapRangePct: read('orderbook-heatmap-range-pct', prev.heatmapRangePct),
    depthLimit: read('orderbook-depth', prev.depthLimit),
    updateSpeed: read('orderbook-speed', prev.updateSpeed),
  });
  _saveOrderbookSettings();
  _syncOrderbookSettingsControls();

  const needsReconnect = prev.depthLimit !== _orderbookSettings.depthLimit ||
    prev.sourceMode !== _orderbookSettings.sourceMode ||
    prev.updateSpeed !== _orderbookSettings.updateSpeed;
  const needsHeatmapReset = prev.heatmapStep !== _orderbookSettings.heatmapStep ||
    prev.heatmapRanges !== _orderbookSettings.heatmapRanges ||
    prev.heatmapWindow !== _orderbookSettings.heatmapWindow;
  const needsRangeRender = prev.heatmapRangePct !== _orderbookSettings.heatmapRangePct;
  if (activeInds.has('book')) {
    if (needsHeatmapReset) {
      _orderbookHeatmapStableStep = 0;
      _orderbookHeatmapStableSymbol = null;
      _orderbookOverlayHtml = '';
      _resetOrderbookAccumulator();
      _resetOrderbookHistory();
      _setOrderbookOverlayHtml(_orderbookStatusHtml(`Tape ${_orderbookHeatmapWindowLabel()}: накопление сделок...`));
    }
    if (needsRangeRender) {
      _orderbookAutoscaleRange = null;
      _orderbookOverlayHtml = '';
      try { if (candleSeries) candleSeries.applyOptions({ autoscaleInfoProvider: _mainAutoscaleInfoProvider }); } catch (_) {}
    }
    if (reconnect && needsReconnect) _startOrderbookRefresh();
    else _scheduleOrderbookRender();
  }
}

function _resetOrderbookBook(clearData = true) {
  _orderbookBook = { bids: new Map(), asks: new Map() };
  _orderbookBookSources = [];
  _orderbookBookMeta = {};
  _orderbookPendingEvents = [];
  _orderbookSnapshotId = null;
  _orderbookLastUpdateId = null;
  _orderbookLastEventAt = 0;
  _orderbookSnapshotLoadedAt = 0;
  _orderbookDataDirty = false;
  _orderbookDirtySymbol = null;
  _orderbookDirtyEventTime = null;
  _orderbookSynced = false;
  if (clearData) {
    _orderbookData = null;
    _resetOrderbookAccumulator();
  }
}

function _orderbookPriceKey(price) {
  const n = Number(price);
  return Number.isFinite(n) ? String(n) : String(price);
}

function _setOrderbookLevel(sideMap, price, qty, meta = {}) {
  const p = Number(price);
  const q = Number(qty);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(q)) return;
  const key = _orderbookPriceKey(p);
  if (q <= 0) {
    sideMap.delete(key);
    return;
  }
  const sources = Array.isArray(meta.sources)
    ? meta.sources.filter(Boolean)
    : meta.source ? [meta.source] : ['binance'];
  const notional = Number(meta.notional);
  sideMap.set(key, {
    price: p,
    qty: q,
    notional: Number.isFinite(notional) && notional > 0 ? notional : p * q,
    sources,
    source: sources.join('+'),
    exchange_count: Number(meta.exchange_count) || sources.length,
  });
}

function _fillOrderbookSide(rows) {
  const map = new Map();
  (rows || []).forEach(l => {
    const price = Array.isArray(l) ? l[0] : l.price;
    const qty = Array.isArray(l) ? l[1] : l.qty;
    _setOrderbookLevel(map, price, qty, Array.isArray(l) ? {} : l);
  });
  return map;
}

function _orderbookSideLevels(side) {
  const map = side === 'bid' ? _orderbookBook.bids : _orderbookBook.asks;
  const rawLimit = _orderbookSourceMode() === 'multi'
    ? _orderbookSettings.depthLimit * 4
    : _orderbookSettings.depthLimit;
  return [...map.values()]
    .filter(l => Number.isFinite(l.price) && Number.isFinite(l.qty) && l.qty > 0)
    .sort((a, b) => side === 'bid' ? b.price - a.price : a.price - b.price)
    .slice(0, rawLimit)
    .map(l => ({
      price: l.price,
      qty: l.qty,
      notional: l.notional || l.price * l.qty,
      sources: l.sources || [l.source || 'binance'],
      source: l.source || 'binance',
      exchange_count: l.exchange_count || 1,
    }));
}

function _pruneOrderbookSide(side) {
  const map = side === 'bid' ? _orderbookBook.bids : _orderbookBook.asks;
  const rawLimit = _orderbookSourceMode() === 'multi'
    ? _orderbookSettings.depthLimit * 4
    : _orderbookSettings.depthLimit;
  if (map.size <= rawLimit + 120) return;
  const keep = new Set(_orderbookSideLevels(side).map(l => _orderbookPriceKey(l.price)));
  for (const key of map.keys()) {
    if (!keep.has(key)) map.delete(key);
  }
}

function _rebuildOrderbookData(symbol, updateId = null, eventTime = null) {
  _orderbookData = {
    symbol: symbol || chartSymbol || _orderbookWsSymbol,
    last_update_id: updateId ?? _orderbookLastUpdateId,
    event_time: eventTime,
    live: _orderbookSynced,
    bids: _orderbookSideLevels('bid'),
    asks: _orderbookSideLevels('ask'),
    source_mode: _orderbookSourceMode(),
    sources: _orderbookBookSources,
    ..._orderbookBookMeta,
  };
}

function _applyOrderbookDepthEvent(event) {
  (event.b || []).forEach(([price, qty]) => _setOrderbookLevel(_orderbookBook.bids, price, qty));
  (event.a || []).forEach(([price, qty]) => _setOrderbookLevel(_orderbookBook.asks, price, qty));
  _orderbookLastUpdateId = Number(event.u);
  _orderbookLastEventAt = Date.now();
  _orderbookSynced = true;
  _pruneOrderbookSide('bid');
  _pruneOrderbookSide('ask');
  _orderbookDataDirty = true;
  _orderbookDirtySymbol = event.s || _orderbookWsSymbol;
  _orderbookDirtyEventTime = event.E || null;
}

function _scheduleOrderbookRender() {
  if (_orderbookPanelRaf || _orderbookPanelTimer) return;
  const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const delay = Math.max(0, ORDERBOOK_RENDER_MIN_MS - (now - _orderbookLastRenderAt));
  const requestRender = () => {
    _orderbookPanelTimer = null;
    _orderbookPanelRaf = requestAnimationFrame(() => {
      _orderbookPanelRaf = null;
      _orderbookLastRenderAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      if (_orderbookDataDirty) {
        _rebuildOrderbookData(_orderbookDirtySymbol, _orderbookLastUpdateId, _orderbookDirtyEventTime);
        _orderbookDataDirty = false;
      }
      _renderOrderbookPanel();
      _scheduleOrderbookHeatmap();
    });
  };
  if (delay <= 16) requestRender();
  else _orderbookPanelTimer = setTimeout(requestRender, delay);
}

function _stopOrderbookWatchdog() {
  if (_orderbookWatchdogTimer) {
    clearInterval(_orderbookWatchdogTimer);
    _orderbookWatchdogTimer = null;
  }
}

function _startOrderbookWatchdog(symbol, seq) {
  _stopOrderbookWatchdog();
  _orderbookWatchdogTimer = setInterval(() => {
    if (seq !== _orderbookSeq || _orderbookWsSymbol !== symbol || !activeInds.has('book')) {
      _stopOrderbookWatchdog();
      return;
    }
    if (_orderbookReconnectTimer) return;
    const now = Date.now();
    if (_orderbookSnapshotLoadedAt && !_orderbookSynced && now - _orderbookSnapshotLoadedAt > ORDERBOOK_SYNC_TIMEOUT_MS) {
      _queueOrderbookResync('sync timeout');
      return;
    }
    if (_orderbookSynced && _orderbookLastEventAt && now - _orderbookLastEventAt > ORDERBOOK_STALE_MS) {
      _queueOrderbookResync('stale');
    }
  }, ORDERBOOK_WATCHDOG_MS);
}

function _queueOrderbookResync(reason = '') {
  if (!_orderbookWsSymbol || !activeInds.has('book')) return;
  if (_orderbookReconnectTimer) return;
  _stopOrderbookWatchdog();
  if (_orderbookPanelRaf) {
    cancelAnimationFrame(_orderbookPanelRaf);
    _orderbookPanelRaf = null;
  }
  if (_orderbookPanelTimer) {
    clearTimeout(_orderbookPanelTimer);
    _orderbookPanelTimer = null;
  }
  if (_orderbookHeatmapTimer) {
    clearTimeout(_orderbookHeatmapTimer);
    _orderbookHeatmapTimer = null;
  }
  if (_orderbookRaf) {
    cancelAnimationFrame(_orderbookRaf);
    _orderbookRaf = null;
  }
  _orderbookDataDirty = false;
  _orderbookSynced = false;
  _setOrderbookStatus(reason ? `Book: ресинхронизация (${reason})` : 'Book: ресинхронизация...');
  const symbol = _orderbookWsSymbol;
  if (_orderbookWs) {
    const ws = _orderbookWs;
    _orderbookWs = null;
    try { ws.close(1000, 'resync'); } catch (_) {}
  }
  _orderbookReconnectTimer = setTimeout(() => {
    _orderbookReconnectTimer = null;
    if (_orderbookWsSymbol === symbol && activeInds.has('book')) _startOrderbookRefresh();
  }, ORDERBOOK_WS_RECONNECT_MS);
}

function _tryApplyFirstOrderbookEvent(event) {
  const first = Number(event.U);
  const final = Number(event.u);
  const snapshot = Number(_orderbookSnapshotId);
  if (!Number.isFinite(first) || !Number.isFinite(final) || !Number.isFinite(snapshot)) return 'stale';
  if (final < snapshot) return 'stale';
  if (first <= snapshot + 1 && final >= snapshot) {
    _applyOrderbookDepthEvent(event);
    return 'applied';
  }
  return first > snapshot + 1 ? 'gap' : 'stale';
}

function _handleOrderbookDepthEvent(event, symbol, seq) {
  if (seq !== _orderbookSeq || _orderbookWsSymbol !== symbol || !activeInds.has('book')) return;
  if (!event || event.e !== 'depthUpdate') return;
  _orderbookLastEventAt = Date.now();
  if (_orderbookSnapshotId == null) {
    _orderbookPendingEvents.push(event);
    if (_orderbookPendingEvents.length > ORDERBOOK_WS_BUFFER_LIMIT) _orderbookPendingEvents.shift();
    return;
  }

  if (!_orderbookSynced) {
    const result = _tryApplyFirstOrderbookEvent(event);
    if (result === 'applied') _scheduleOrderbookRender();
    else if (result === 'gap') _queueOrderbookResync('gap');
    return;
  }

  const final = Number(event.u);
  const first = Number(event.U);
  if (!Number.isFinite(final) || final <= Number(_orderbookLastUpdateId)) return;
  if (event.pu != null && Number(event.pu) !== Number(_orderbookLastUpdateId)) {
    _queueOrderbookResync('seq');
    return;
  }
  if (event.pu == null && Number.isFinite(first) && first > Number(_orderbookLastUpdateId) + 1) {
    _queueOrderbookResync('gap');
    return;
  }
  _applyOrderbookDepthEvent(event);
  _scheduleOrderbookRender();
}

function _applyBufferedOrderbookEvents(symbol, seq) {
  const events = _orderbookPendingEvents;
  _orderbookPendingEvents = [];
  for (const event of events) {
    if (seq !== _orderbookSeq || _orderbookWsSymbol !== symbol) return;
    _handleOrderbookDepthEvent(event, symbol, seq);
    if (_orderbookReconnectTimer) return;
  }
}

function _orderbookSnapshotUrl(symbol) {
  const limit = Number(_orderbookSettings.depthLimit) || 1000;
  if (_orderbookSourceMode() === 'multi') {
    return `/api/futures/${encodeURIComponent(symbol)}/multi-orderbook?limit=${limit}`;
  }
  return `/api/futures/${encodeURIComponent(symbol)}/orderbook?limit=${limit}`;
}

async function _loadOrderbookSnapshot(symbol, seq, quiet = false) {
  const multi = _orderbookSourceMode() === 'multi';
  if (!quiet) _setOrderbookStatus(multi ? 'Multi: snapshot...' : 'Book: snapshot...');
  try {
    const res = await fetch(_orderbookSnapshotUrl(symbol), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (seq !== _orderbookSeq || _orderbookWsSymbol !== symbol || !activeInds.has('book')) return;
    _orderbookBookSources = data.sources || [];
    _orderbookBookMeta = {
      reference_mid: data.reference_mid,
      crossed: !!data.crossed,
      ok_source_count: data.ok_source_count,
      best_bid: data.best_bid,
      best_ask: data.best_ask,
      bid_range: data.bid_range,
      ask_range: data.ask_range,
    };
    _orderbookBook = {
      bids: _fillOrderbookSide(data.bids),
      asks: _fillOrderbookSide(data.asks),
    };
    _orderbookSnapshotId = Number(data.last_update_id);
    _orderbookLastUpdateId = _orderbookSnapshotId;
    _orderbookSnapshotLoadedAt = Date.now();
    _orderbookSynced = multi;
    _rebuildOrderbookData(data.symbol || symbol, _orderbookLastUpdateId, data.event_time || null);
    _renderOrderbookPanel();
    if (multi) {
      _scheduleOrderbookHeatmap();
      return;
    }
    _applyBufferedOrderbookEvents(symbol, seq);
    if (!_orderbookSynced) _setOrderbookStatus('Book: синхронизация...');
    else _scheduleOrderbookRender();
  } catch (e) {
    if (seq === _orderbookSeq && _orderbookWsSymbol === symbol) {
      _setOrderbookStatus(multi ? 'Multi: ошибка snapshot' : 'Book: ошибка snapshot');
      if (!multi) _queueOrderbookResync('snapshot');
    }
    console.warn('Orderbook snapshot error:', e);
  }
}

function _fmtOrderbookQty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n >= 100000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
  if (n >= 0.001) return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
  return n.toPrecision(3);
}

function _orderbookQtyUnit() {
  const base = String(chartFuture?.base_asset || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (base) return base;
  const symbol = String(chartSymbol || _orderbookData?.symbol || '').toUpperCase();
  const inferred = symbol.replace(/(USDT|USDC|BUSD|FDUSD|USD|PERP)$/i, '');
  return inferred || 'qty';
}

function _resetOrderbookAccumulator() {
  _orderbookAccumSamples = [];
  _orderbookAccumLastSampleAt = 0;
  _orderbookAccumStep = 0;
  _orderbookAccumSymbol = null;
}

function _orderbookAccumWindowLabel() {
  const mins = Math.round(ORDERBOOK_ACCUM_WINDOW_MS / 60000);
  return `${mins}m`;
}

function _orderbookHeatmapWindowLabel() {
  return _pickOrderbookOption(
    String(_orderbookSettings?.heatmapWindow || ''),
    ORDERBOOK_HEATMAP_WINDOW_OPTIONS,
    ORDERBOOK_DEFAULT_SETTINGS.heatmapWindow
  );
}

function _resetOrderbookHistory() {
  _orderbookHistoryZones = [];
  _orderbookHistoryMeta = null;
  _orderbookHistoryKey = '';
  _orderbookHistoryLoading = false;
  _orderbookHistoryLoaded = false;
  _orderbookHistoryLoadedAt = 0;
  _orderbookHistorySeq += 1;
}

function _orderbookHistoryRequestKey(symbol) {
  const step = Number(_orderbookSettings.heatmapStep) || 0;
  return [
    String(symbol || '').toUpperCase(),
    _orderbookHeatmapWindowLabel(),
    _orderbookHeatmapRangeCount(),
    step > 0 ? step : 0,
  ].join(':');
}

function _normalizeOrderbookHistoryZone(row) {
  const rawSide = String(row?.side || '').toLowerCase();
  const side = rawSide === 'sell' || rawSide === 'ask' ? 'ask' : 'bid';
  const flowSide = rawSide === 'sell' || rawSide === 'ask' ? 'sell' : 'buy';
  const lower = Number(row?.lower ?? row?.minPrice ?? row?.price);
  const upper = Number(row?.upper ?? row?.maxPrice ?? row?.price);
  const price = Number(row?.price);
  const qty = Number(row?.qty);
  const notional = Number(row?.notional);
  if (
    !Number.isFinite(lower) ||
    !Number.isFinite(upper) ||
    !Number.isFinite(price) ||
    !Number.isFinite(qty) ||
    !Number.isFinite(notional) ||
    qty <= 0 ||
    notional <= 0
  ) return null;
  return {
    side,
    lower,
    upper,
    minPrice: Number.isFinite(Number(row?.minPrice)) ? Number(row.minPrice) : Math.min(lower, upper),
    maxPrice: Number.isFinite(Number(row?.maxPrice)) ? Number(row.maxPrice) : Math.max(lower, upper),
    price,
    qty,
    notional,
    maxNotional: Number(row?.maxNotional) || notional,
    lastNotional: Number(row?.lastNotional) || notional,
    score: Number(row?.score) || notional,
    persistence: _clip(Number(row?.persistence) || 0, 0, 1),
    count: Math.max(1, Number(row?.count) || 1),
    sampleCount: Math.max(1, Number(row?.sampleCount) || 1),
    flowSide,
    source: row?.source || 'trades',
  };
}

async function _loadOrderbookHistory(symbol, seq) {
  if (!ORDERBOOK_HISTORY_ENABLED || !symbol) return;
  const key = _orderbookHistoryRequestKey(symbol);
  const sameKey = _orderbookHistoryKey === key;
  if (sameKey && _orderbookHistoryLoading) return;
  if (sameKey && _orderbookHistoryLoaded && Date.now() - _orderbookHistoryLoadedAt < ORDERBOOK_HISTORY_REFRESH_MS) return;

  _orderbookHistoryKey = key;
  _orderbookHistoryLoading = true;
  if (!sameKey) {
    _orderbookHistoryLoaded = false;
    _orderbookHistoryZones = [];
    _orderbookHistoryMeta = null;
    _orderbookHistoryLoadedAt = 0;
  }
  const historySeq = ++_orderbookHistorySeq;
  try {
    const params = new URLSearchParams({
      window: _orderbookHeatmapWindowLabel(),
      ranges: String(_orderbookHeatmapRangeCount()),
      step: String(Number(_orderbookSettings.heatmapStep) || 0),
      min_notional: String(Number(_orderbookSettings.minNotional) || 0),
    });
    const res = await fetch(`/api/futures/${encodeURIComponent(symbol)}/trade-zones?${params}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (
      historySeq !== _orderbookHistorySeq ||
      seq !== _orderbookSeq ||
      _orderbookWsSymbol !== symbol ||
      !activeInds.has('book')
    ) return;
    _orderbookHistoryZones = (data.zones || [])
      .map(_normalizeOrderbookHistoryZone)
      .filter(Boolean);
    _orderbookHistoryMeta = data;
    _orderbookHistoryLoaded = true;
    _orderbookHistoryLoadedAt = Date.now();
    _scheduleOrderbookHeatmap();
  } catch (e) {
    if (historySeq === _orderbookHistorySeq) {
      _orderbookHistoryLoaded = true;
      _orderbookHistoryLoadedAt = Date.now();
      if (!sameKey) {
        _orderbookHistoryZones = [];
        _orderbookHistoryMeta = null;
      }
    }
    console.warn('Trade liquidity history error:', e);
  } finally {
    if (historySeq === _orderbookHistorySeq) _orderbookHistoryLoading = false;
  }
}

function _ensureOrderbookHistory(symbol, seq) {
  if (!ORDERBOOK_HISTORY_ENABLED || !symbol) return;
  _loadOrderbookHistory(symbol, seq);
}

function _sameOrderbookStep(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return false;
  return Math.abs(x - y) <= Math.max(x, y) * 0.000001;
}

function _orderbookHeatmapGroupStep(asks, bids) {
  const rows = [...(asks || []), ...(bids || [])];
  if (!rows.length) return 1;
  const prices = rows.map(l => Number(l.price)).filter(p => Number.isFinite(p) && p > 0);
  const tick = _detectOrderbookTick(rows);
  const manualStep = Number(_orderbookSettings.heatmapStep);
  if (Number.isFinite(manualStep) && manualStep > 0) return Math.max(manualStep, tick || 0);
  const baseStep = _orderbookGroupStep(asks || [], bids || []);
  const bestAsk = asks?.[0]?.price;
  const bestBid = bids?.[0]?.price;
  const mid = Number.isFinite(bestAsk) && Number.isFinite(bestBid)
    ? (bestAsk + bestBid) / 2
    : prices.length ? prices.reduce((sum, p) => sum + p, 0) / prices.length : 0;
  const nearLimit = mid > 0
    ? Math.max(mid * ORDERBOOK_HEATMAP_NEAR_PRICE_PCT, tick * ORDERBOOK_GROUP_MIN_TICKS * ORDERBOOK_HEATMAP_STEP_MULT)
    : Infinity;
  const scopedPrices = mid > 0 ? prices.filter(p => Math.abs(p - mid) <= nearLimit) : prices;
  const span = scopedPrices.length > 1 ? Math.max(...scopedPrices) - Math.min(...scopedPrices) : 0;
  const targetZones = Math.max(_orderbookHeatmapRangeCount(), 1);
  const raw = Math.max(
    baseStep * ORDERBOOK_HEATMAP_STEP_MULT,
    span / Math.max(targetZones * 5, 1),
    tick * ORDERBOOK_GROUP_MIN_TICKS * ORDERBOOK_HEATMAP_STEP_MULT,
    mid > 0 ? mid * 0.00002 : 0
  );
  const step = mid > 0
    ? _niceOrderbookStepAtMost(raw, mid * ORDERBOOK_HEATMAP_MAX_STEP_PCT, tick)
    : _niceOrderbookStep(raw, tick);
  return Math.max(step, tick || 0);
}

function _stableOrderbookHeatmapGroupStep(asks, bids) {
  const next = _orderbookHeatmapGroupStep(asks, bids);
  const symbol = chartSymbol || _orderbookData?.symbol || _orderbookWsSymbol || '';
  const manualStep = Number(_orderbookSettings.heatmapStep);
  if (Number.isFinite(manualStep) && manualStep > 0) {
    _orderbookHeatmapStableSymbol = symbol || null;
    _orderbookHeatmapStableStep = next;
    return next;
  }
  if (
    !symbol ||
    _orderbookHeatmapStableSymbol !== symbol ||
    !_orderbookHeatmapStableStep ||
    !_orderbookAccumSamples.length
  ) {
    _orderbookHeatmapStableSymbol = symbol || null;
    _orderbookHeatmapStableStep = next;
    return next;
  }

  const current = Number(_orderbookHeatmapStableStep);
  const ratio = next > 0 && current > 0 ? next / current : 1;
  if (ratio >= 4 || ratio <= 0.25) {
    _orderbookHeatmapStableStep = next;
    return next;
  }
  return current;
}

function _sampleOrderbookAccumulation(rows, step) {
  const now = Date.now();
  const symbol = chartSymbol || _orderbookData?.symbol || _orderbookWsSymbol || '';
  if (!symbol || !rows?.length || !Number.isFinite(Number(step)) || Number(step) <= 0) return;

  if (_orderbookAccumSymbol !== symbol || !_sameOrderbookStep(_orderbookAccumStep, step)) {
    _resetOrderbookAccumulator();
    _orderbookAccumSymbol = symbol;
    _orderbookAccumStep = step;
  }

  if (_orderbookAccumLastSampleAt && now - _orderbookAccumLastSampleAt < ORDERBOOK_ACCUM_SAMPLE_MS) return;
  const sampleRows = rows
    .map(l => ({
      side: l.side === 'ask' ? 'ask' : 'bid',
      lower: Number(l.lower ?? l.minPrice ?? l.price),
      upper: Number(l.upper ?? l.maxPrice ?? l.price),
      price: Number(l.price),
      qty: Number(l.qty),
      notional: Number(l.notional),
    }))
    .filter(l =>
      Number.isFinite(l.lower) &&
      Number.isFinite(l.upper) &&
      Number.isFinite(l.price) &&
      Number.isFinite(l.qty) &&
      Number.isFinite(l.notional) &&
      l.qty > 0 &&
      l.notional > 0
    );
  if (!sampleRows.length) return;
  _orderbookAccumSamples.push({ ts: now, rows: sampleRows });
  _orderbookAccumLastSampleAt = now;
  const cutoff = now - ORDERBOOK_ACCUM_WINDOW_MS;
  _orderbookAccumSamples = _orderbookAccumSamples.filter(s => s.ts >= cutoff);
}

function _accumulatedOrderbookZones() {
  const now = Date.now();
  const cutoff = now - ORDERBOOK_ACCUM_WINDOW_MS;
  _orderbookAccumSamples = _orderbookAccumSamples.filter(s => s.ts >= cutoff);
  const totalSamples = _orderbookAccumSamples.length;
  if (totalSamples < ORDERBOOK_ACCUM_MIN_HITS) return [];

  const precision = _orderbookStepPrecision(_orderbookAccumStep || 1);
  const buckets = new Map();
  _orderbookAccumSamples.forEach(sample => {
    (sample.rows || []).forEach(row => {
      const lower = _roundOrderbookPrice(row.lower, _orderbookAccumStep || 1);
      const upper = _roundOrderbookPrice(row.upper, _orderbookAccumStep || 1);
      const key = `${row.side}:${lower.toFixed(precision)}:${upper.toFixed(precision)}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          side: row.side,
          lower,
          upper,
          minPrice: Math.min(lower, upper),
          maxPrice: Math.max(lower, upper),
          hitCount: 0,
          score: 0,
          qtySum: 0,
          notionalSum: 0,
          weightedPrice: 0,
          maxNotional: 0,
          lastSeen: 0,
          lastNotional: 0,
        };
        buckets.set(key, bucket);
      }
      bucket.hitCount += 1;
      bucket.score += row.notional;
      bucket.qtySum += row.qty;
      bucket.notionalSum += row.notional;
      bucket.weightedPrice += row.price * row.notional;
      bucket.maxNotional = Math.max(bucket.maxNotional, row.notional);
      if (sample.ts >= bucket.lastSeen) {
        bucket.lastSeen = sample.ts;
        bucket.lastNotional = row.notional;
      }
    });
  });

  const minHits = ORDERBOOK_ACCUM_MIN_HITS;
  return [...buckets.values()]
    .filter(b => b.hitCount >= minHits)
    .map(b => ({
      side: b.side,
      lower: b.lower,
      upper: b.upper,
      minPrice: b.minPrice,
      maxPrice: b.maxPrice,
      price: b.notionalSum > 0 ? b.weightedPrice / b.notionalSum : (b.minPrice + b.maxPrice) / 2,
      qty: b.qtySum / Math.max(b.hitCount, 1),
      notional: b.notionalSum / Math.max(b.hitCount, 1),
      maxNotional: b.maxNotional,
      lastNotional: b.lastNotional,
      score: b.score,
      persistence: b.hitCount / totalSamples,
      count: b.hitCount,
      sampleCount: totalSamples,
    }));
}

function _mergeOrderbookHeatmapSources(historyRows = [], liveRows = [], step = 0) {
  const rows = [
    ...(historyRows || []).map(row => ({ ...row, source: 'history' })),
    ...(liveRows || []).map(row => ({ ...row, source: 'live' })),
  ];
  if (!rows.length) return [];
  if (!historyRows?.length || !liveRows?.length) return rows.map(row => ({ ...row }));

  const manualStep = Number(step);
  const historySamples = Math.max(0, ...historyRows.map(row => Number(row.sampleCount) || 0));
  const liveSamples = Math.max(0, ...liveRows.map(row => Number(row.sampleCount) || 0));
  const totalSamples = Math.max(1, historySamples + liveSamples);
  const buckets = new Map();

  rows.forEach(row => {
    const price = Number(row.price);
    const qty = Number(row.qty);
    const notional = Number(row.notional);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(notional) || qty <= 0 || notional <= 0) return;

    let bucketStep = manualStep > 0 ? manualStep : Number(row.upper) - Number(row.lower);
    if (!Number.isFinite(bucketStep) || bucketStep <= 0) bucketStep = Math.max(Math.abs(price) * 0.00001, 1e-12);
    const lower = manualStep > 0
      ? _roundOrderbookPrice(Math.floor(price / manualStep) * manualStep, manualStep)
      : _roundOrderbookPrice(Number(row.lower ?? row.minPrice ?? price), bucketStep);
    const upper = manualStep > 0
      ? _roundOrderbookPrice(lower + manualStep, manualStep)
      : _roundOrderbookPrice(Number(row.upper ?? row.maxPrice ?? price), bucketStep);
    const precision = _orderbookStepPrecision(bucketStep);
    const side = row.side === 'ask' ? 'ask' : 'bid';
    const key = `${side}:${lower.toFixed(precision)}:${upper.toFixed(precision)}`;
    const count = Math.max(1, Number(row.count) || 1);
    const score = Number(row.score) || notional * count;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        side,
        lower,
        upper,
        minPrice: Math.min(lower, upper),
        maxPrice: Math.max(lower, upper),
        hitCount: 0,
        score: 0,
        qtySum: 0,
        notionalSum: 0,
        weightedPrice: 0,
        maxNotional: 0,
        lastNotional: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.hitCount += count;
    bucket.score += score;
    bucket.qtySum += qty * count;
    bucket.notionalSum += notional * count;
    bucket.weightedPrice += price * Math.max(score, notional);
    bucket.maxNotional = Math.max(bucket.maxNotional, Number(row.maxNotional) || notional);
    bucket.lastNotional = Number(row.lastNotional) || notional;
  });

  return [...buckets.values()].map(bucket => ({
    side: bucket.side,
    lower: bucket.lower,
    upper: bucket.upper,
    minPrice: bucket.minPrice,
    maxPrice: bucket.maxPrice,
    price: bucket.weightedPrice > 0 ? bucket.weightedPrice / Math.max(bucket.score, 1) : (bucket.minPrice + bucket.maxPrice) / 2,
    qty: bucket.qtySum / Math.max(bucket.hitCount, 1),
    notional: bucket.notionalSum / Math.max(bucket.hitCount, 1),
    maxNotional: bucket.maxNotional,
    lastNotional: bucket.lastNotional,
    score: bucket.score,
    persistence: _clip(bucket.hitCount / totalSamples, 0, 1),
    count: bucket.hitCount,
    sampleCount: totalSamples,
    source: 'mixed',
  }));
}

function _pickOrderbookHeatmapZones(rows) {
  const picked = [];
  ['bid', 'ask'].forEach(side => {
    const zonesPerSide = _orderbookHeatmapZonesPerSide();
    const sideRows = rows
      .filter(l => l.side === side)
      .sort((a, b) => Number(b.score || b.notional) - Number(a.score || a.notional));
    const eligible = sideRows.filter(l => Number(l.maxNotional || l.notional) >= ORDERBOOK_HEATMAP_MIN_NOTIONAL);
    const source = eligible.length >= zonesPerSide
      ? eligible
      : [...eligible, ...sideRows.filter(row => !eligible.includes(row))];
    picked.push(...source
      .filter(row => Number.isFinite(Number(row.y)))
      .slice(0, zonesPerSide)
      .map(row => ({ ...row })));
  });
  return picked
    .sort((a, b) => Number(b.score || b.notional) - Number(a.score || a.notional))
    .slice(0, _orderbookHeatmapRangeCount());
}

function _layoutOrderbookBandLabels(rows, overlayHeight) {
  const height = Math.max(Number(overlayHeight) || 0, 80);
  const topLimit = 24;
  const bottomLimit = Math.max(topLimit, height - 12);
  const out = (rows || []).map(row => ({ ...row, labelY: Number(row.y) }));

  ['bid', 'ask'].forEach(side => {
    const sideRows = out
      .filter(row => row.side === side && Number.isFinite(Number(row.y)))
      .sort((a, b) => Number(a.y) - Number(b.y));
    if (!sideRows.length) return;

    let prev = topLimit - ORDERBOOK_HEATMAP_LABEL_GAP_PX;
    sideRows.forEach(row => {
      row.labelY = Math.max(Number(row.y), prev + ORDERBOOK_HEATMAP_LABEL_GAP_PX);
      prev = row.labelY;
    });

    const overflow = sideRows[sideRows.length - 1].labelY - bottomLimit;
    if (overflow > 0) sideRows.forEach(row => { row.labelY -= overflow; });

    let last = topLimit - ORDERBOOK_HEATMAP_LABEL_GAP_PX;
    sideRows.forEach(row => {
      row.labelY = _clip(row.labelY, last + ORDERBOOK_HEATMAP_LABEL_GAP_PX, bottomLimit);
      last = row.labelY;
    });
  });

  return out;
}

function _detectOrderbookTick(rows) {
  const prices = [...new Set((rows || [])
    .map(l => Number(l.price))
    .filter(p => Number.isFinite(p) && p > 0))]
    .sort((a, b) => a - b);
  let tick = Infinity;
  for (let i = 1; i < prices.length; i += 1) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0 && diff < tick) tick = diff;
  }
  return Number.isFinite(tick) ? tick : 0;
}

function _niceOrderbookStep(raw, tick = 0) {
  const minStep = tick > 0 ? tick : 0;
  const n = Math.max(Number(raw) || 0, minStep);
  if (!Number.isFinite(n) || n <= 0) return minStep || 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const base = n / pow;
  const nice = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
  return Math.max(nice * pow, minStep || 0);
}

function _niceOrderbookStepAtMost(raw, maxStep, tick = 0) {
  const cap = Number(maxStep);
  if (!Number.isFinite(cap) || cap <= 0) return _niceOrderbookStep(raw, tick);
  const minStep = tick > 0 ? tick : 0;
  if (minStep >= cap) return minStep;
  const desired = Math.max(Number(raw) || 0, minStep || 0);
  const maxPow = Math.floor(Math.log10(cap));
  const candidates = [];
  for (let exp = maxPow - 8; exp <= maxPow + 1; exp += 1) {
    const pow = Math.pow(10, exp);
    [1, 2, 5, 10].forEach(mult => {
      const value = mult * pow;
      if (value >= (minStep || 0) && value <= cap) candidates.push(value);
    });
  }
  candidates.sort((a, b) => a - b);
  return candidates.find(v => v >= desired) || candidates[candidates.length - 1] || Math.max(minStep, cap);
}

function _orderbookStepPrecision(step) {
  const n = Math.abs(Number(step));
  if (!Number.isFinite(n) || n <= 0) return 2;
  return Math.max(0, Math.min(12, Math.ceil(-Math.log10(n)) + 4));
}

function _roundOrderbookPrice(v, step) {
  return Number(Number(v).toFixed(_orderbookStepPrecision(step)));
}

function _orderbookGroupStep(asks, bids) {
  const all = [...(asks || []), ...(bids || [])];
  if (!all.length) return 1;
  const tick = _detectOrderbookTick(all);
  if (_orderbookSettings.groupMode === 'manual' && _orderbookSettings.groupStep > 0) {
    return Math.max(_orderbookSettings.groupStep, tick || 0);
  }
  const bestAsk = asks?.[0]?.price;
  const bestBid = bids?.[0]?.price;
  const mid = Number.isFinite(bestAsk) && Number.isFinite(bestBid)
    ? (bestAsk + bestBid) / 2
    : Number(all[0]?.price || 0);
  const askSpan = asks?.length > 1 ? Math.max(0, asks[asks.length - 1].price - asks[0].price) : 0;
  const bidSpan = bids?.length > 1 ? Math.max(0, bids[0].price - bids[bids.length - 1].price) : 0;
  const depthSpan = Math.max(askSpan, bidSpan);
  const raw = Math.max(
    depthSpan / Math.max(_orderbookSettings.rows, 1),
    tick * ORDERBOOK_GROUP_MIN_TICKS,
    mid > 0 ? mid * 0.00002 : 0
  );
  return _niceOrderbookStep(raw, tick);
}

function _fmtOrderbookStep(step) {
  const n = Number(step);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const precision = Math.max(2, Math.min(12, Math.ceil(-Math.log10(n)) + 2));
  return '$' + n.toFixed(precision).replace(/\.?0+$/, '');
}

function _fmtOrderbookZone(row) {
  const price = fmt.price(row.price);
  if (row.count <= 1) return price;
  return '~' + price;
}

function _fmtOrderbookZoneTitle(row) {
  if (row.count <= 1 || row.minPrice === row.maxPrice) return fmt.price(row.price);
  return `${fmt.price(row.minPrice)} - ${fmt.price(row.maxPrice)} (${row.count} уров.)`;
}

function _fmtOrderbookZoneRange(row) {
  const min = Number(row.minPrice ?? row.lower ?? row.price);
  const max = Number(row.maxPrice ?? row.upper ?? row.price);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return fmt.price(row.price);
  if (Math.abs(max - min) <= Math.max(Math.abs(min), Math.abs(max), 1) * 1e-10) return fmt.price(min);
  const a = fmt.price(Math.min(min, max));
  const b = fmt.price(Math.max(min, max)).replace(/^\$/, '');
  return `${a}-${b}`;
}

function _groupOrderbookRows(rows, side, step, maxRows = _orderbookSettings.rows, applyMinFilter = true) {
  const grouped = new Map();
  const precision = _orderbookStepPrecision(step);
  (rows || []).forEach(l => {
    const price = Number(l.price);
    const qty = Number(l.qty);
    const notional = Number(l.notional);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(notional) || qty <= 0 || notional <= 0) return;
    const lower = _roundOrderbookPrice(Math.floor(price / step) * step, step);
    const key = lower.toFixed(precision);
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = {
        side,
        lower,
        upper: _roundOrderbookPrice(lower + step, step),
        qty: 0,
        notional: 0,
        weightedPrice: 0,
        minPrice: price,
        maxPrice: price,
        count: 0,
        sources: new Set(),
      };
      grouped.set(key, bucket);
    }
    bucket.qty += qty;
    bucket.notional += notional;
    bucket.weightedPrice += price * notional;
    bucket.minPrice = Math.min(bucket.minPrice, price);
    bucket.maxPrice = Math.max(bucket.maxPrice, price);
    bucket.count += 1;
    (l.sources || [l.source]).forEach(src => { if (src) bucket.sources.add(src); });
  });

  const sorted = [...grouped.values()]
    .map(b => ({
      side: b.side,
      price: b.notional ? b.weightedPrice / b.notional : (b.lower + b.upper) / 2,
      lower: b.lower,
      upper: b.upper,
      qty: b.qty,
      notional: b.notional,
      minPrice: b.minPrice,
      maxPrice: b.maxPrice,
      count: b.count,
      sources: [...b.sources].sort(),
      exchange_count: b.sources.size,
    }))
    .filter(b => !applyMinFilter || !_orderbookSettings.minNotional || b.notional >= _orderbookSettings.minNotional)
    .sort((a, b) => side === 'ask' ? a.minPrice - b.minPrice : b.maxPrice - a.maxPrice)
    .slice(0, Number.isFinite(Number(maxRows)) ? Number(maxRows) : undefined);

  let cum = 0;
  return sorted.map(l => {
    cum += l.notional;
    return { ...l, cumNotional: cum };
  });
}

function _prepareOrderbookRows(rows, side, groupStep) {
  const sorted = [...(rows || [])]
    .map(l => ({
      price: Number(l.price),
      qty: Number(l.qty),
      notional: Number(l.notional),
      sources: l.sources || [l.source],
      source: l.source,
      exchange_count: l.exchange_count,
    }))
    .filter(l =>
      Number.isFinite(l.price) &&
      Number.isFinite(l.qty) &&
      Number.isFinite(l.notional) &&
      l.qty > 0 &&
      l.notional > 0
    )
    .sort((a, b) => side === 'ask' ? a.price - b.price : b.price - a.price);
  return _groupOrderbookRows(sorted, side, groupStep || _orderbookGroupStep([], sorted));
}

function _filterOrderbookPanelRange(rows, mid) {
  const rangePct = _orderbookPanelRangePct();
  if (!rows?.length || !Number.isFinite(mid) || mid <= 0 || rangePct >= 1) return rows || [];
  const maxDistance = mid * rangePct;
  return rows.filter(row => Math.abs(Number(row.price) - mid) <= maxDistance);
}

function _renderOrderbookRows(rows, side, maxNotional) {
  const displayRows = side === 'ask' ? [...rows].reverse() : rows;
  return displayRows.map(l => {
    const pct = maxNotional > 0 ? _clip((l.notional / maxNotional) * 100, 4, 100) : 4;
    const majorClass = pct >= 65 ? ' is-major' : '';
    const count = l.count > 1 ? `<em>${l.count}</em>` : '';
    const sources = (l.sources || []).length ? ` · ${(l.sources || []).join('+')}` : '';
    return `<div class="orderbook-row ${side}${majorClass}" title="${_fmtOrderbookZoneTitle(l)} · ${_fmtOrderbookQty(l.qty)} · ${fmt.large(l.notional)} · cumul ${fmt.large(l.cumNotional)}${sources}">` +
      `<span class="orderbook-depth" style="width:${pct}%"></span>` +
      `<span class="orderbook-price">${_fmtOrderbookZone(l)}${count}</span>` +
      `<span>${_fmtOrderbookQty(l.qty)}</span>` +
      `<span>${fmt.large(l.notional)}</span>` +
    `</div>`;
  }).join('');
}

function _renderOrderbookPanel() {
  const panel = _orderbookPanelEl();
  if (!panel) return;
  _setOrderbookPanelVisible(activeInds.has('book'));
  if (!activeInds.has('book')) return;

  const sym = document.getElementById('orderbook-panel-symbol');
  const asksEl = document.getElementById('orderbook-asks');
  const bidsEl = document.getElementById('orderbook-bids');
  const midEl = document.getElementById('orderbook-mid');
  if (sym) sym.textContent = chartSymbol || _orderbookData?.symbol || '—';
  if (!asksEl || !bidsEl || !midEl) return;
  if (!_orderbookData) {
    _setOrderbookPanelMessage('загрузка...');
    return;
  }

  const rawAsks = [...(_orderbookData.asks || [])]
    .map(l => ({ price: Number(l.price), qty: Number(l.qty), notional: Number(l.notional), sources: l.sources || [l.source], source: l.source, exchange_count: l.exchange_count }))
    .filter(l => Number.isFinite(l.price) && Number.isFinite(l.qty) && Number.isFinite(l.notional) && l.qty > 0 && l.notional > 0)
    .sort((a, b) => a.price - b.price);
  const rawBids = [...(_orderbookData.bids || [])]
    .map(l => ({ price: Number(l.price), qty: Number(l.qty), notional: Number(l.notional), sources: l.sources || [l.source], source: l.source, exchange_count: l.exchange_count }))
    .filter(l => Number.isFinite(l.price) && Number.isFinite(l.qty) && Number.isFinite(l.notional) && l.qty > 0 && l.notional > 0)
    .sort((a, b) => b.price - a.price);
  const bestAsk = rawAsks[0]?.price;
  const bestBid = rawBids[0]?.price;
  const mid = Number.isFinite(bestAsk) && Number.isFinite(bestBid)
    ? (bestAsk + bestBid) / 2
    : _orderbookMidFromSides(rawAsks, rawBids);
  const rangeAsks = _filterOrderbookPanelRange(rawAsks, mid);
  const rangeBids = _filterOrderbookPanelRange(rawBids, mid);
  const groupStep = _orderbookGroupStep(rangeAsks, rangeBids);
  const asks = _prepareOrderbookRows(rangeAsks, 'ask', groupStep);
  const bids = _prepareOrderbookRows(rangeBids, 'bid', groupStep);
  if (!asks.length && !bids.length) {
    _setOrderbookPanelMessage(rawAsks.length || rawBids.length ? 'нет зон в диапазоне' : 'нет заявок');
    return;
  }

  const maxNotional = Math.max(
    ...asks.map(l => l.notional),
    ...bids.map(l => l.notional),
    1
  );
  const askBottomGap = Math.max(0, asksEl.scrollHeight - asksEl.scrollTop - asksEl.clientHeight);
  const keepAsksPinnedToMid = asksEl.scrollHeight <= asksEl.clientHeight || askBottomGap < 24;
  const bidScrollTop = bidsEl.scrollTop;
  asksEl.innerHTML = _renderOrderbookRows(asks, 'ask', maxNotional);
  bidsEl.innerHTML = _renderOrderbookRows(bids, 'bid', maxNotional);
  if (keepAsksPinnedToMid) {
    asksEl.scrollTop = asksEl.scrollHeight;
  } else {
    asksEl.scrollTop = Math.max(0, asksEl.scrollHeight - asksEl.clientHeight - askBottomGap);
  }
  bidsEl.scrollTop = Math.min(bidScrollTop, Math.max(0, bidsEl.scrollHeight - bidsEl.clientHeight));

  if (Number.isFinite(bestAsk) && Number.isFinite(bestBid)) {
    const crossed = _orderbookData.crossed || bestBid > bestAsk;
    const spread = bestAsk - bestBid;
    const spreadAbs = Math.abs(spread);
    const spreadPct = mid ? (spreadAbs / mid) * 100 : 0;
    const spreadLabel = crossed && _orderbookData.source_mode === 'multi' ? 'Cross' : 'Spread';
    const liveState = _orderbookSynced ? 'LIVE' : 'SYNC';
    const minText = _orderbookSettings.minNotional ? ` · мин ${fmt.large(_orderbookSettings.minNotional)}` : '';
    const rangeText = ` · стакан ±${_fmtOrderbookRangePct(_orderbookPanelRangePct())}`;
    const okSources = (_orderbookData.sources || []).filter(src => src.ok);
    const sourceText = _orderbookData.source_mode === 'multi'
      ? ` · Multi ${okSources.length}/${(_orderbookData.sources || []).length || 4}`
      : ' · Binance';
    if (sym) sym.textContent = `${chartSymbol || _orderbookData?.symbol || '—'} · ${liveState}${sourceText}`;
    midEl.innerHTML =
      `<span class="orderbook-mid-price">${fmt.price(mid)}</span>` +
      `<span>${spreadLabel} ${fmt.price(spreadAbs)} · ${spreadPct.toFixed(3)}% · шаг ${_fmtOrderbookStep(groupStep)}${sourceText}${rangeText}${minText}</span>`;
  } else {
    midEl.innerHTML = '<span class="orderbook-mid-price">—</span><span>Spread —</span>';
  }
}

function _renderOrderbookHeatmap() {
  const overlay = _orderbookOverlayEl();
  if (!overlay) return;
  if (!ORDERBOOK_HEATMAP_ENABLED) return;
  if (!activeInds.has('book') || !_orderbookData || !chart || !candleSeries || !_klineData.length) return;

  const container = document.getElementById('chart-container');
  const plotRight = _chartPlotRight(container);
  if (!plotRight) return;

  const raw = [
    ...(_orderbookData.bids || []).map(l => ({ ...l, side: 'bid' })),
    ...(_orderbookData.asks || []).map(l => ({ ...l, side: 'ask' })),
  ].filter(l =>
    Number.isFinite(Number(l.price)) &&
    Number.isFinite(Number(l.notional)) &&
    Number(l.notional) > 0
  );
  if (!raw.length) {
    _setOrderbookOverlayHtml(_orderbookStatusHtml('Book: нет заявок'), overlay);
    return;
  }

  const rawAsks = raw.filter(l => l.side === 'ask').sort((a, b) => Number(a.price) - Number(b.price));
  const rawBids = raw.filter(l => l.side === 'bid').sort((a, b) => Number(b.price) - Number(a.price));
  const heatmapStep = _stableOrderbookHeatmapGroupStep(rawAsks, rawBids);
  const symbol = chartSymbol || _orderbookData?.symbol || _orderbookWsSymbol || '';
  _ensureOrderbookHistory(symbol, _orderbookSeq);
  const heatmapRows = _orderbookHistoryZones.map(row => ({ ...row }));
  if (!heatmapRows.length) {
    _setOrderbookAutoscaleRange([], rawAsks, rawBids);
    const text = _orderbookHistoryLoading
      ? `Tape ${_orderbookHeatmapWindowLabel()}: история...`
      : `Tape ${_orderbookHeatmapWindowLabel()}: накопление сделок...`;
    _setOrderbookOverlayHtml(_orderbookStatusHtml(text), overlay);
    return;
  }
  _setOrderbookAutoscaleRange(heatmapRows, rawAsks, rawBids);
  const mid = _orderbookMidFromSides(rawAsks, rawBids);
  const maxHeatmapDistance = mid > 0 ? mid * _orderbookHeatmapRangePct() : Infinity;

  const grouped = heatmapRows
    .map(l => ({ ...l, y: candleSeries.priceToCoordinate(Number(l.price)) }))
    .filter(l =>
      Number.isFinite(Number(l.y)) &&
      Number(l.y) >= -24 &&
      Number(l.y) <= overlay.clientHeight + 24 &&
      (mid <= 0 || Math.abs(Number(l.price) - mid) <= maxHeatmapDistance)
    );
  if (!grouped.length) {
    _setOrderbookOverlayHtml(_orderbookStatusHtml(`Tape ${_orderbookHeatmapWindowLabel()}: зоны вне видимой цены`), overlay);
    return;
  }
  const visible = _layoutOrderbookBandLabels(_pickOrderbookHeatmapZones(grouped), overlay.clientHeight);
  const maxScore = Math.max(...visible.map(l => Number(l.score || l.notional)), 0);
  if (!visible.length || !maxScore) {
    _setOrderbookOverlayHtml(_orderbookStatusHtml(`Tape ${_orderbookHeatmapWindowLabel()}: нет видимых зон`), overlay);
    return;
  }

  const requestedRanges = _orderbookHeatmapRangeCount();
  const visibleCount = visible.length === requestedRanges ? String(visible.length) : `${visible.length}/${requestedRanges}`;
  const displayStep = Number(_orderbookHistoryMeta?.step) || heatmapStep;
  const html = [_orderbookStatusHtml(`Tape ${_orderbookHeatmapWindowLabel()}: ${visibleCount} зон · шаг ${_fmtOrderbookStep(displayStep)} · диап ±${_fmtOrderbookRangePct()}`)];
  html.push(...visible
    .sort((a, b) => a.price - b.price)
    .map(l => {
      const unit = _orderbookQtyUnit();
      const strength = _clip(Number(l.score || l.notional) / maxScore, 0.12, 1);
      const upperY = candleSeries.priceToCoordinate(Number(l.upper ?? l.maxPrice ?? l.price));
      const lowerY = candleSeries.priceToCoordinate(Number(l.lower ?? l.minPrice ?? l.price));
      const centerY = Number(l.y);
      const rangePx = Number.isFinite(upperY) && Number.isFinite(lowerY) ? Math.abs(lowerY - upperY) : 0;
      const height = _clip(Math.max(rangePx, 6 + strength * 8), 7, 30);
      const top = centerY - height / 2;
      const labelShift = _clip(Number(l.labelY ?? centerY) - centerY, -90, 90).toFixed(1);
      const sideLabel = l.flowSide === 'sell' || l.side === 'ask' ? 'SELL' : 'BUY';
      const persistence = Math.round(_clip(Number(l.persistence || 0), 0, 1) * 100);
      const rangeLabel = _fmtOrderbookZoneRange(l);
      const label = `<span><b>${sideLabel}</b><strong>${fmt.large(l.notional)}</strong><em>${persistence}%</em><i>${rangeLabel}</i></span>`;
      const majorClass = strength > 0.6 ? ' is-major' : '';
      const title = `Executed ${sideLabel} ${_fmtOrderbookZoneTitle(l)} · volume ${fmt.large(l.notional)} · max ${fmt.large(l.maxNotional)} · ${_fmtOrderbookQty(l.qty)} ${unit} · ${persistence}% за ${_orderbookHeatmapWindowLabel()}`;
      const alpha = (0.08 + strength * 0.22).toFixed(3);
      const edgeAlpha = (0.22 + strength * 0.48).toFixed(3);
      return `<div class="orderbook-band ${l.side}${majorClass}" title="${title}" style="left:0;top:${top}px;width:${plotRight}px;height:${height}px;--book-alpha:${alpha};--book-edge:${edgeAlpha};--label-shift:${labelShift}px">${label}</div>`;
    }));
  _setOrderbookOverlayHtml(html.join(''), overlay);
}

function _scheduleOrderbookHeatmap() {
  if (_orderbookRaf || _orderbookHeatmapTimer) return;
  const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const delay = Math.max(0, ORDERBOOK_HEATMAP_RENDER_MS - (now - _orderbookHeatmapLastRenderAt));
  const requestRender = () => {
    _orderbookHeatmapTimer = null;
    _orderbookRaf = requestAnimationFrame(() => {
      _orderbookRaf = null;
      _orderbookHeatmapLastRenderAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      _renderOrderbookHeatmap();
    });
  };
  if (delay <= 16) requestRender();
  else _orderbookHeatmapTimer = setTimeout(requestRender, delay);
}

function _stopOrderbookRefresh() {
  _orderbookSeq += 1;
  _stopOrderbookWatchdog();
  if (_orderbookPollTimer) {
    clearTimeout(_orderbookPollTimer);
    _orderbookPollTimer = null;
  }
  if (_orderbookReconnectTimer) {
    clearTimeout(_orderbookReconnectTimer);
    _orderbookReconnectTimer = null;
  }
  if (_orderbookPanelRaf) {
    cancelAnimationFrame(_orderbookPanelRaf);
    _orderbookPanelRaf = null;
  }
  if (_orderbookPanelTimer) {
    clearTimeout(_orderbookPanelTimer);
    _orderbookPanelTimer = null;
  }
  if (_orderbookHeatmapTimer) {
    clearTimeout(_orderbookHeatmapTimer);
    _orderbookHeatmapTimer = null;
  }
  if (_orderbookRaf) {
    cancelAnimationFrame(_orderbookRaf);
    _orderbookRaf = null;
  }
  if (_orderbookWs) {
    const ws = _orderbookWs;
    _orderbookWs = null;
    try { ws.close(1000, 'stopped'); } catch (_) {}
  }
  _orderbookWsSymbol = null;
  _resetOrderbookBook(true);
  _resetOrderbookHistory();
}

function _startOrderbookSnapshotPolling(symbol, seq) {
  const poll = async (quiet = false) => {
    if (seq !== _orderbookSeq || _orderbookWsSymbol !== symbol || !activeInds.has('book')) return;
    await _loadOrderbookSnapshot(symbol, seq, quiet);
    if (seq !== _orderbookSeq || _orderbookWsSymbol !== symbol || !activeInds.has('book')) return;
    _orderbookPollTimer = setTimeout(() => poll(true), ORDERBOOK_MULTI_POLL_MS);
  };
  poll(false);
}

function _startOrderbookRefresh() {
  _stopOrderbookRefresh();
  if (!activeInds.has('book') || !chartSymbol) return;
  const symbol = chartSymbol;
  const seq = ++_orderbookSeq;
  _orderbookWsSymbol = symbol;
  const multi = _orderbookSourceMode() === 'multi';
  _setOrderbookStatus(multi ? 'Multi: подключение...' : 'Book: подключение...');

  if (multi) {
    _startOrderbookSnapshotPolling(symbol, seq);
    return;
  }

  const stream = `${symbol.toLowerCase()}@depth@${_orderbookSettings.updateSpeed}`;
  const url = `wss://fstream.binance.com/public/stream?streams=${stream}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    _setOrderbookStatus('Book: ошибка WebSocket');
    console.warn('Orderbook WebSocket error:', e);
    return;
  }
  _orderbookWs = ws;
  _startOrderbookWatchdog(symbol, seq);

  ws.onopen = () => {
    if (_orderbookWs !== ws || _orderbookWsSymbol !== symbol || seq !== _orderbookSeq) return;
    _loadOrderbookSnapshot(symbol, seq);
  };

  ws.onmessage = (ev) => {
    if (_orderbookWs !== ws || _orderbookWsSymbol !== symbol || seq !== _orderbookSeq) {
      try { ws.close(1000, 'stale'); } catch (_) {}
      return;
    }
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    const data = msg.data || msg;
    _handleOrderbookDepthEvent(data, symbol, seq);
  };

  ws.onerror = (e) => {
    if (_orderbookWs === ws && _orderbookWsSymbol === symbol) {
      console.warn('Orderbook WebSocket error:', e);
    }
  };

  ws.onclose = () => {
    if (_orderbookWs === ws && _orderbookWsSymbol === symbol && seq === _orderbookSeq && activeInds.has('book')) {
      _orderbookWs = null;
      _orderbookSynced = false;
      _setOrderbookStatus('Book: переподключение...');
      _orderbookReconnectTimer = setTimeout(() => {
        _orderbookReconnectTimer = null;
        if (!_orderbookWs && _orderbookWsSymbol === symbol && activeInds.has('book')) _startOrderbookRefresh();
      }, ORDERBOOK_WS_RECONNECT_MS);
    }
  };
}

function loadOrderbook() {
  _startOrderbookRefresh();
}

// ── Volume Profile ─────────────────────────────────────────────────────────────
function _getVPCanvas() {
  if (!_vpCanvas) {
    _vpCanvas = document.createElement('canvas');
    Object.assign(_vpCanvas.style, {
      position: 'absolute', top: '0', left: '0',
      pointerEvents: 'none', zIndex: '1',
    });
    document.getElementById('chart-container').appendChild(_vpCanvas);
  }
  return _vpCanvas;
}

function _destroyVP() {
  if (_vpRaf) { cancelAnimationFrame(_vpRaf); _vpRaf = null; }
  if (_vpCanvas) { _vpCanvas.remove(); _vpCanvas = null; }
}

function _clearVolumeProfile() {
  if (_vpCanvas) {
    const ctx = _vpCanvas.getContext('2d');
    ctx.clearRect(0, 0, _vpCanvas.width, _vpCanvas.height);
  }
}

function _calcVolumeProfile(data) {
  let hiPrice = -Infinity, loPrice = Infinity;
  for (const k of data) {
    if (k.high > hiPrice) hiPrice = k.high;
    if (k.low  < loPrice) loPrice = k.low;
  }
  const range = hiPrice - loPrice;
  if (!range) return [];

  const step = range / VP_BUCKETS;
  const buckets = Array.from({ length: VP_BUCKETS }, (_, i) => ({
    priceBot: loPrice + i * step,
    priceTop: loPrice + (i + 1) * step,
    priceMid: loPrice + (i + 0.5) * step,
    vol: 0, buy: 0,
  }));

  for (const k of data) {
    const vol = k.quote_volume ?? k.volume ?? 0;
    if (!vol) continue;
    const buy    = Math.min(vol, Math.max(0, (vol + (k.delta || 0)) / 2));
    const cRange = k.high - k.low;
    const iFrom  = Math.max(0, Math.floor((k.low  - loPrice) / step));
    const iTo    = Math.min(VP_BUCKETS - 1, Math.floor((k.high - loPrice) / step));
    for (let i = iFrom; i <= iTo; i++) {
      const overlap  = cRange > 0
        ? (Math.min(k.high, buckets[i].priceTop) - Math.max(k.low, buckets[i].priceBot)) / cRange
        : 1 / (iTo - iFrom + 1);
      buckets[i].vol  += vol  * overlap;
      buckets[i].buy  += buy  * overlap;
    }
  }
  return buckets;
}

function _drawVolumeProfile() {
  if (!_vpCanvas || !activeInds.has('vp') || !candleSeries || !_klineData.length) return;

  const container = document.getElementById('chart-container');
  const W = container.clientWidth;
  const H = container.clientHeight;
  _vpCanvas.width  = W;
  _vpCanvas.height = H;
  const ctx = _vpCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // Use real price axis width to avoid overlap with axis labels
  const axisW = (chart && chart.priceScale('right').width()) || VP_AXIS_W;

  const profile = _calcVolumeProfile(_klineData);
  if (!profile.length) return;

  let maxVol = 0;
  for (const b of profile) if (b.vol > maxVol) maxVol = b.vol;
  if (!maxVol) return;

  // POC = bucket with highest volume
  let pocIdx = 0;
  for (let i = 1; i < profile.length; i++) {
    if (profile[i].vol > profile[pocIdx].vol) pocIdx = i;
  }

  // Value Area: expand outward from POC until 70% of total volume
  const totalVol = profile.reduce((s, b) => s + b.vol, 0);
  let vaLo = pocIdx, vaHi = pocIdx, vaVol = profile[pocIdx].vol;
  while (vaVol < totalVol * VP_VA_PCT) {
    const nextLo = vaLo > 0 ? profile[vaLo - 1].vol : -1;
    const nextHi = vaHi < profile.length - 1 ? profile[vaHi + 1].vol : -1;
    if (nextLo < 0 && nextHi < 0) break;
    if (nextLo >= nextHi) { vaVol += nextLo; vaLo--; }
    else                  { vaVol += nextHi; vaHi++; }
  }

  const maxBarW = (W - axisW) * VP_MAX_WIDTH;
  const right   = W - axisW;

  for (let i = 0; i < profile.length; i++) {
    const b    = profile[i];
    const yTop = candleSeries.priceToCoordinate(b.priceTop);
    const yBot = candleSeries.priceToCoordinate(b.priceBot);
    if (yTop == null || yBot == null) continue;

    const top    = Math.min(yTop, yBot);
    const height = Math.max(1, Math.abs(yBot - yTop) - 0.5);
    const barW   = (b.vol / maxVol) * maxBarW;

    if (i === pocIdx) {
      ctx.fillStyle = 'rgba(240,180,30,.85)';
      ctx.fillRect(right - barW, top, barW, height);
    } else {
      const inVA   = i >= vaLo && i <= vaHi;
      const alpha  = inVA ? 0.50 : 0.28;
      const buyFrac = b.vol > 0 ? b.buy / b.vol : 0.5;
      const buyW   = barW * buyFrac;
      ctx.fillStyle = `rgba(63,185,80,${alpha})`;
      ctx.fillRect(right - barW, top, buyW, height);
      ctx.fillStyle = `rgba(248,81,73,${alpha})`;
      ctx.fillRect(right - barW + buyW, top, barW - buyW, height);
    }
  }

  // POC dashed line + label
  const pocY = candleSeries.priceToCoordinate(profile[pocIdx].priceMid);
  if (pocY != null) {
    ctx.save();
    ctx.strokeStyle = 'rgba(240,180,30,.65)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, pocY);
    ctx.lineTo(right, pocY);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(240,180,30,.9)';
    ctx.font      = 'bold 10px monospace';
    ctx.fillText('POC', 4, pocY - 3);
  }
}

function _scheduleVP() {
  if (_vpRaf) return;
  _vpRaf = requestAnimationFrame(() => { _vpRaf = null; _drawVolumeProfile(); });
}

function _renderVolumeProfile() {
  if (!activeInds.has('vp') || !_klineData.length) { _clearVolumeProfile(); return; }
  _getVPCanvas();
  // double rAF: first frame lets LightweightCharts finish its own layout,
  // second frame draws on the updated coordinate system
  requestAnimationFrame(() => _scheduleVP());
}

// OI is always fetched at a finer resolution than the kline interval
// so _oiToCandles() gets multiple points per bar → real OHLC bodies
const _OI_INTERVAL = {
  '1m':'5m',  '3m':'5m',  '5m':'5m',
  '15m':'5m', '30m':'5m',
  '1h':'15m', '2h':'15m', '4h':'30m',
  '6h':'1h',  '12h':'1h',
  '1d':'1h',  '1w':'1h',
};

const _OI_MODE_KEY = 'cryptoskriner_oi_mode';
let oiMode = (() => {
  try { return localStorage.getItem(_OI_MODE_KEY) === 'candles' ? 'candles' : 'hist'; }
  catch (_) { return 'hist'; }
})();

function _oiModeTitle() {
  return oiMode === 'candles' ? 'OI свечи' : 'OI Δ%';
}

function _updateOiModeButton() {
  const btn = document.getElementById('oi-mode-btn');
  if (!btn) return;
  btn.textContent = _oiModeTitle();
  btn.classList.toggle('active', activeInds.has('oi'));
}

function _oiHistOptions() {
  return {
    base: 0,
    lastValueVisible: true,
    priceLineVisible: false,
    priceFormat: { type: 'price', precision: 3, minMove: 0.001 },
    autoscaleInfoProvider: () => ({
      priceRange: { minValue: -_oiHistScale, maxValue: _oiHistScale },
      margins: { above: 0.08, below: 0.08 },
    }),
  };
}

function _createOiSeries() {
  if (!oiChart) return;
  oiHistSeries = oiChart.addHistogramSeries(_oiHistOptions());
  oiCandleSeries = oiChart.addCandlestickSeries({
    upColor: '#3fb950',
    downColor: '#f85149',
    borderUpColor: '#3fb950',
    borderDownColor: '#f85149',
    wickUpColor: '#3fb950',
    wickDownColor: '#f85149',
    lastValueVisible: true,
    priceLineVisible: false,
    priceFormat: { type: 'price', precision: 0, minMove: 1 },
  });
  _applyOiSeriesMode();
}

function _applyOiSeriesMode() {
  _updateOiModeButton();
  if (!oiChart) return;
  oiSeries = oiMode === 'candles' ? oiCandleSeries : oiHistSeries;
  try { if (oiHistSeries) oiHistSeries.setData(oiMode === 'hist' ? _oiHistData : []); } catch (_) {}
  try { if (oiCandleSeries) oiCandleSeries.setData(oiMode === 'candles' ? _oiCandleData : []); } catch (_) {}
  _syncIndicatorRanges();
}

function toggleOiMode() {
  oiMode = oiMode === 'hist' ? 'candles' : 'hist';
  try { localStorage.setItem(_OI_MODE_KEY, oiMode); } catch (_) {}
  _applyOiSeriesMode();
}

const _CVD_MODE_KEY = 'cryptoskriner_cvd_mode';
let cvdMode = (() => {
  try { return localStorage.getItem(_CVD_MODE_KEY) === 'candles' ? 'candles' : 'line'; }
  catch (_) { return 'line'; }
})();

function _cvdModeTitle() {
  return cvdMode === 'candles' ? 'CVD свечи' : 'CVD линия';
}

function _updateCvdModeButton() {
  const btn = document.getElementById('cvd-mode-btn');
  if (!btn) return;
  btn.textContent = _cvdModeTitle();
  btn.classList.toggle('active', activeInds.has('cvd'));
}

function _createCvdSeries() {
  if (!cvdChart) return;
  cvdLineSeries = cvdChart.addLineSeries({
    color: '#f0b429',
    lineWidth: 1,
    lastValueVisible: true,
    priceLineVisible: false,
    priceFormat: { type: 'volume' },
  });
  cvdCandleSeries = cvdChart.addCandlestickSeries({
    upColor: '#3fb950',
    downColor: '#f85149',
    borderUpColor: '#3fb950',
    borderDownColor: '#f85149',
    wickUpColor: '#3fb950',
    wickDownColor: '#f85149',
    lastValueVisible: true,
    priceLineVisible: false,
    priceFormat: { type: 'volume' },
  });
  _applyCvdSeriesMode();
}

function _applyCvdSeriesMode() {
  _updateCvdModeButton();
  const lbl = document.querySelector('#cvd-panel .ind-label');
  if (lbl) lbl.textContent = _cvdModeTitle();
  if (!cvdChart) return;
  cvdSeries = cvdMode === 'candles' ? cvdCandleSeries : cvdLineSeries;
  try { if (cvdLineSeries) cvdLineSeries.setData(cvdMode === 'line' ? _cvdLineData : []); } catch (_) {}
  try { if (cvdCandleSeries) cvdCandleSeries.setData(cvdMode === 'candles' ? _cvdCandleData : []); } catch (_) {}
  _syncIndicatorRanges();
}

function toggleCvdMode() {
  cvdMode = cvdMode === 'line' ? 'candles' : 'line';
  try { localStorage.setItem(_CVD_MODE_KEY, cvdMode); } catch (_) {}
  _applyCvdSeriesMode();
}

function _createMacdSeries() {
  if (!macdChart) return;
  macdHistSeries = macdChart.addHistogramSeries({
    base: 0,
    lastValueVisible: false,
    priceLineVisible: false,
  });
  macdLineSeries = macdChart.addLineSeries({
    color: '#58a6ff',
    lineWidth: 1,
    lastValueVisible: true,
    priceLineVisible: false,
    title: 'MACD',
  });
  macdSignalSeries = macdChart.addLineSeries({
    color: '#f0b429',
    lineWidth: 1,
    lastValueVisible: true,
    priceLineVisible: false,
    title: 'Signal',
  });
}

function _createOfvSeries() {
  if (!ofvChart) return;
  ofvSeries = ofvChart.addCandlestickSeries({
    upColor: '#3fb950',
    downColor: '#f85149',
    borderUpColor: '#3fb950',
    borderDownColor: '#f85149',
    wickUpColor: '#3fb950',
    wickDownColor: '#f85149',
    lastValueVisible: true,
    priceLineVisible: false,
    priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
  });
  ofvZeroLine = ofvSeries.createPriceLine({
    price: 0,
    color: 'rgba(125,133,144,.55)',
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle?.Dashed ?? 2,
    axisLabelVisible: true,
    title: '0',
  });
  try { ofvSeries.setData(_ofvCandleData); } catch (_) {}
}

function _ofvToSeriesData() {
  if (!_klineData.length || !_oiData.length) return { candles: [], lookup: [] };

  const inputs = _klineData.map(k => {
    const vol = Number(_klineVolume(k)) || 0;
    const delta = Number(k.delta) || 0;
    const od = _findByTime(_oiData, k.time);
    const pricePct = k.open ? ((Number(k.close) - Number(k.open)) / Number(k.open)) * 100 : 0;
    return {
      time: k.time,
      vol,
      delta,
      pricePct,
      cvdPct: vol > 0 ? (delta / vol) * 100 : 0,
      oiPct: od ? Number(od.pct || 0) : 0,
    };
  });

  const priceBase = Math.max(_absPercentile(inputs.map(d => d.pricePct), 0.90, 0.15), 0.01);
  const cvdBase = Math.max(_absPercentile(inputs.map(d => d.cvdPct), 0.90, 1), 0.05);
  const oiBase = Math.max(_absPercentile(inputs.map(d => d.oiPct), 0.90, 0.05), 0.005);
  const candles = [];
  const lookup = [];
  let prevScore = 0;

  for (let i = 0; i < inputs.length; i++) {
    const d = inputs[i];
    const avgFrom = Math.max(0, i - 19);
    let avgVol = 0;
    for (let j = avgFrom; j <= i; j++) avgVol += inputs[j].vol;
    avgVol /= Math.max(1, i - avgFrom + 1);

    const priceNorm = _clip(d.pricePct / priceBase, -2, 2);
    const cvdNorm = _clip(d.cvdPct / cvdBase, -2, 2);
    const oiNorm = _clip(d.oiPct / oiBase, -2, 2);
    const volRatio = avgVol > 0 ? d.vol / avgVol : 1;
    const volBoost = Math.sqrt(_clip(volRatio, 0.25, 4));
    const flowNorm = _clip(cvdNorm * 0.55 + priceNorm * 0.45, -2, 2);
    const opening = Math.max(0, oiNorm);
    const closing = Math.max(0, -oiNorm);
    const absorption = Math.sign(cvdNorm) !== Math.sign(priceNorm) && Math.abs(cvdNorm) > 0.35
      ? cvdNorm * opening * 0.35
      : 0;
    const score = (flowNorm * (0.15 + opening * 0.80 + closing * 0.25) + absorption) * volBoost * 7;
    const open = prevScore;
    const close = score;
    const intensity = Math.min(2.5, Math.abs(cvdNorm) * 0.35 + Math.abs(oiNorm) * 0.45 + Math.max(0, volBoost - 1) * 0.45);
    const wick = Math.max(0.25, Math.abs(close - open) * 0.22 + intensity * 0.28);
    const high = Math.max(open, close, 0) + wick;
    const low = Math.min(open, close, 0) - wick;
    const neutral = Math.abs(score) < 0.15;
    const color = neutral ? '#7d8590' : score > 0 ? '#3fb950' : '#f85149';

    const candle = {
      time: d.time,
      open,
      high,
      low,
      close,
      color,
      borderColor: color,
      wickColor: color,
    };
    candles.push(candle);
    lookup.push({
      ...candle,
      value: close,
      impulse: score,
      pricePct: d.pricePct,
      cvdPct: d.cvdPct,
      oiPct: d.oiPct,
      volRatio,
    });
    prevScore = score;
  }

  return { candles, lookup };
}

function loadOFV() {
  if (!ofvSeries && !activeInds.has('ofv')) return;
  const { candles, lookup } = _ofvToSeriesData();
  _ofvCandleData = candles;
  _ofvData = lookup;
  try { if (ofvSeries) ofvSeries.setData(_ofvCandleData); } catch (_) {}
  const lbl = document.querySelector('#ofv-panel .ind-label');
  if (lbl) lbl.textContent = 'OFV';
  _syncIndicatorRanges();
}

const DEFAULT_ACTIVE_INDS = [
  'oi', 'cvd', 'ofv', 'ls', 'liq', 'flow', 'zones', 'st', 'vp',
  'sessions', 'impulses', 'imbalance', 'vwap', 'score',
];
const VALID_ACTIVE_INDS = new Set([
  ...DEFAULT_ACTIVE_INDS,
  'structure', 'sweeps', 'htf', 'pd', 'book', 'analysis', 'macd',
]);
const activeInds = new Set(_loadActiveIndicators());

function _loadActiveIndicators() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHART_INDS_STORAGE_KEY) || 'null');
    if (Array.isArray(saved)) {
      return saved.filter(name => VALID_ACTIVE_INDS.has(name));
    }
  } catch (_) {}
  return DEFAULT_ACTIVE_INDS;
}

function _saveActiveIndicators() {
  try { localStorage.setItem(CHART_INDS_STORAGE_KEY, JSON.stringify([...activeInds])); } catch (_) {}
}

function _syncIndicatorButtons() {
  document.querySelectorAll('.ind-btn[data-ind]').forEach(btn => {
    btn.classList.toggle('active', activeInds.has(btn.dataset.ind));
  });
  _updateOiModeButton();
  _updateCvdModeButton();
}

// ── Shared crosshair sync helpers ──────────────────────────────────────────────
// Called from subscribeCrosshairMove of ANY chart (main or indicator).
// sourceChart is excluded from setCrosshairPosition to avoid self-calls.
function _syncCrosshairAt(time, sourceChart, force = false, mainPrice = null) {
  if (_crosshairBusy) return;
  if (_hoverMarkerLocked && !force && _hoverMarkerTime != null) {
    _syncCrosshairAt(_hoverMarkerTime, null, true, _hoverMarkerPrice);
    return;
  }
  _crosshairBusy = true;
  try {
    // Bottom time label is rendered by the shared hover marker.
    const timeLabel = document.getElementById('chart-time-label');
    if (timeLabel) timeLabel.classList.remove('visible');

    // OHLCV legend from klineData lookup
    const k = _findByTime(_klineData, time);
    if (k) _updateLegend(k.open, k.high, k.low, k.close, _klineVolume(k), k.time);
    const priceForMain = Number.isFinite(Number(mainPrice))
      ? Number(mainPrice)
      : (_hoverMarkerLocked && time === _hoverMarkerTime && Number.isFinite(Number(_hoverMarkerPrice)) ? Number(_hoverMarkerPrice) : null);
    _renderHoverMarker(time, priceForMain);
    if (activeInds.has('flow')) _renderFlowPanel(time);

    // Main chart
    if (sourceChart !== chart && chart && candleSeries && k) {
      chart.setCrosshairPosition(priceForMain ?? k.close, time, candleSeries);
    }

    // OI panel
    if (oiSeries && _oiData.length) {
      const od = _findByTime(_oiData, time);
      if (od) {
        const lbl = document.querySelector('#oi-panel .ind-label');
        const sign = (od.pct || 0) >= 0 ? '+' : '';
        if (lbl) lbl.textContent = `${_oiModeTitle()}   ${fmt.oi(od.value)}  ${sign}${(od.pct || 0).toFixed(3)}%`;
        const crossValue = oiMode === 'candles' ? (od.close ?? od.value) : (od.displayPct ?? od.pct ?? 0);
        if (sourceChart !== oiChart && (oiMode !== 'candles' || od.value > 0)) {
          oiChart.setCrosshairPosition(crossValue, time, oiSeries);
        }
      }
    }

    // CVD panel
    if (cvdSeries && _cvdData.length) {
      const cd = _findByTime(_cvdData, time);
      if (cd) {
        const sign = (cd.delta || 0) >= 0 ? '+' : '';
        const lbl = document.querySelector('#cvd-panel .ind-label');
        if (lbl) {
          if (cvdMode === 'candles') {
            const valueSign = (cd.value || 0) >= 0 ? '+' : '';
            lbl.textContent = `${_cvdModeTitle()}   Δ ${sign}${fmt.large(Math.abs(cd.delta || 0))}  C ${valueSign}${fmt.large(Math.abs(cd.value || 0))}`;
          } else {
            const valueSign = (cd.value || 0) >= 0 ? '+' : '';
            lbl.textContent = `${_cvdModeTitle()}   ${valueSign}${fmt.large(Math.abs(cd.value || 0))}`;
          }
        }
        const crossValue = cvdMode === 'candles' ? (cd.close ?? cd.value) : cd.value;
        if (sourceChart !== cvdChart) cvdChart.setCrosshairPosition(crossValue, time, cvdSeries);
      }
    }

    // OFV panel
    if (ofvSeries && _ofvData.length) {
      const fd = _findByTime(_ofvData, time);
      if (fd) {
        const lbl = document.querySelector('#ofv-panel .ind-label');
        if (lbl) {
          lbl.textContent = `OFV   Score ${_signedOfv(fd.close ?? fd.value)}  CVD ${_formatSignedPct(fd.cvdPct || 0, 2)}  OI ${_formatSignedPct(fd.oiPct || 0, 3)}  Vol x${(fd.volRatio || 0).toFixed(2)}`;
        }
        if (sourceChart !== ofvChart) ofvChart.setCrosshairPosition(fd.close ?? fd.value, time, ofvSeries);
      }
    }

    // L/S panel
    if (lsLongSeries && _lsData.length) {
      const ld = _findByTime(_lsData, time);
      if (ld) {
        const lbl = document.querySelector('#ls-panel .ind-label');
        if (lbl) lbl.textContent = `L/S   L ${ld.long_pct.toFixed(1)}%  S ${ld.short_pct.toFixed(1)}%`;
        if (sourceChart !== lsChart) lsChart.setCrosshairPosition(ld.long_pct, time, lsLongSeries);
      }
    }

    // Liq panel
    if (liqLongSeries && _liqData.length) {
      const lq = _findByTime(_liqData, time);
      if (lq) {
        const lbl = document.querySelector('#liq-panel .ind-label');
        if (lbl) lbl.textContent = `Ликв  L ${fmt.large(lq.long_usd)}  S ${fmt.large(lq.short_usd)}`;
        if (sourceChart !== liqChart) liqChart.setCrosshairPosition(lq.short_usd, time, liqShortSeries);
      }
    }

    // MACD panel
    if (macdLineSeries && _macdData.length) {
      const md = _findByTime(_macdData, time);
      if (md) {
        const lbl = document.querySelector('#macd-panel .ind-label');
        const hSign = md.hist >= 0 ? '+' : '';
        if (lbl) lbl.textContent = `MACD 12/26/9   ${md.macd.toFixed(_macdPrec)}  S ${md.signal.toFixed(_macdPrec)}  H ${hSign}${md.hist.toFixed(_macdPrec)}`;
        if (sourceChart !== macdChart) macdChart.setCrosshairPosition(md.macd, time, macdLineSeries);
      }
    }
  } catch (_) {}
  _crosshairBusy = false;
}

function _syncCrosshairLeave() {
  if (_crosshairBusy) return;
  if (_hoverMarkerLocked && _hoverMarkerTime != null) {
    _syncCrosshairAt(_hoverMarkerTime, null, true, _hoverMarkerPrice);
    return;
  }

  const timeLabel = document.getElementById('chart-time-label');
  if (timeLabel) timeLabel.classList.remove('visible');
  _hideHoverMarker();

  // Show last candle values in legend
  if (_klineData.length) {
    const last = _klineData[_klineData.length - 1];
    _updateLegend(last.open, last.high, last.low, last.close, _klineVolume(last), last.time);
  }

  // Clear crosshair on all charts
  try { if (chart)    chart.clearCrosshairPosition();    } catch (_) {}
  try { if (oiChart)  oiChart.clearCrosshairPosition();  } catch (_) {}
  try { if (cvdChart) cvdChart.clearCrosshairPosition(); } catch (_) {}
  try { if (ofvChart) ofvChart.clearCrosshairPosition(); } catch (_) {}
  try { if (lsChart)  lsChart.clearCrosshairPosition();  } catch (_) {}
  try { if (liqChart) liqChart.clearCrosshairPosition(); } catch (_) {}
  try { if (macdChart) macdChart.clearCrosshairPosition(); } catch (_) {}

  // Reset indicator labels
  const oiLbl  = document.querySelector('#oi-panel .ind-label');
  const cvdLbl = document.querySelector('#cvd-panel .ind-label');
  const ofvLbl = document.querySelector('#ofv-panel .ind-label');
  const lsLbl  = document.querySelector('#ls-panel .ind-label');
  const liqLbl = document.querySelector('#liq-panel .ind-label');
  const macdLbl = document.querySelector('#macd-panel .ind-label');
  if (oiLbl)  oiLbl.textContent  = _oiModeTitle();
  if (cvdLbl) cvdLbl.textContent = _cvdModeTitle();
  if (ofvLbl) ofvLbl.textContent = 'OFV';
  if (lsLbl)  lsLbl.textContent  = 'L/S %';
  if (liqLbl) liqLbl.textContent = 'Ликв $';
  if (macdLbl) macdLbl.textContent = 'MACD 12/26/9';
  if (activeInds.has('flow')) _renderFlowPanel();
}

// Attach bidirectional crosshair sync to an indicator chart instance
function _attachIndSync(indChart) {
  indChart.subscribeCrosshairMove(param => {
    if (param.time) _syncCrosshairAt(param.time, indChart);
    else _syncCrosshairLeave();
  });
  indChart.subscribeClick(param => _handleHoverMarkerClick(param, indChart));
}

// ── Chart open / close ─────────────────────────────────────────────────────────
function openChart(future) {
  if (activeInds.has('book')) {
    _stopOrderbookRefresh();
    _clearOrderbookHeatmap();
    _clearOrderbookPanel();
  }
  chartFuture = future;
  chartSymbol = future.symbol;
  _klineData  = [];
  _orderbookData = null;
  _oiData = []; _lsData = []; _cvdData = []; _cvdLineData = []; _cvdCandleData = []; _ofvData = []; _ofvCandleData = []; _flowData = [];
  _hideHoverMarker(true);
  _resetDrawingSession(true);

  document.getElementById('chart-symbol').textContent = future.symbol;
  document.getElementById('chart-rank').textContent   = future.cg_rank ? '#' + future.cg_rank : '';
  updateChartMeta(future);

  document.getElementById('chart-modal').classList.add('open');
  document.body.style.overflow = 'hidden';

  // double rAF: first frame renders display:flex, second has actual dimensions
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!chart) {
      initChart();
      initIndicators();
    }
    loadKlines();
  }));
}

function updateChartMeta(f) {
  document.getElementById('chart-price').textContent = fmt.price(f.last_price);
  const chg = f.price_change_pct;
  const el  = document.getElementById('chart-change');
  el.textContent = chg != null ? (chg > 0 ? '+' : '') + chg.toFixed(2) + '%' : '';
  el.className   = chg > 0 ? 'pos' : chg < 0 ? 'neg' : 'neutral';
}

function closeChart() {
  _stopRtWs();
  _hideHoverMarker(true);
  _resetDrawingSession(true);
  document.getElementById('chart-modal').classList.remove('open');
  document.body.style.overflow = '';
  destroyChart();
  destroyIndicators();
}

// ── Real-time WebSocket (Binance Futures stream) ───────────────────────────────
function _stopRtPriceFallback() {
  if (_rtPricePollTimer) {
    clearInterval(_rtPricePollTimer);
    _rtPricePollTimer = null;
  }
}

function _stopQueuedLiveChartPrice() {
  if (_rtChartPriceTimer) {
    clearTimeout(_rtChartPriceTimer);
    _rtChartPriceTimer = null;
  }
  _rtChartPricePending = null;
  _rtChartPriceLastPatchAt = 0;
}

function _stopRtWs() {
  _stopRtPriceFallback();
  _stopQueuedLiveChartPrice();
  if (_rtWs) {
    const ws = _rtWs;
    _rtWs = null;
    try { ws.onmessage = ws.onerror = ws.onclose = null; } catch (_) {}
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'switch');
      }
    } catch (_) {}
  }
  _rtSymbol = null; _rtTf = null; _rtLastTickAt = 0;
}

// Interval string → milliseconds for candle boundary detection
const _TF_MS = {
  '1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,
  '1h':3600000,'2h':7200000,'4h':14400000,'12h':43200000,
  '1d':86400000,'1w':604800000,
};

function _updateChartHeaderPrice(price) {
  const priceEl = document.getElementById('chart-price');
  if (priceEl && Number.isFinite(price) && price > 0) priceEl.textContent = fmt.price(price);
}

function _finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _candleTimeFromExchangeTime(timeSec, tf) {
  const step = (_TF_MS[tf] || 0) / 1000;
  const t = Number(timeSec);
  if (!step || !Number.isFinite(t)) return null;
  return Math.floor(t / step) * step;
}

function _mainCandlePoint(k) {
  return { time: k.time, open: k.open, high: k.high, low: k.low, close: k.close };
}

function _mainVolumePoint(k) {
  return {
    time: k.time,
    value: _klineVolume(k) || 0,
    color: k.close >= k.open ? '#3fb95055' : '#f8514955',
  };
}

function _setMainSeriesData() {
  try { candleSeries.setData(_klineData.map(_mainCandlePoint)); } catch (_) {}
  try { volSeries.setData(_klineData.map(_mainVolumePoint)); } catch (_) {}
}

function _redrawLiveOverlays(isNewBar = false) {
  _renderSuperTrend();
  _renderVwap();
  _scheduleMarketStructure();
  _scheduleOrderbookHeatmap();
  _renderAnalysisPanel();
  if (isNewBar) {
    _renderTimeAxis();
    _scheduleVP();
    _scheduleLiquidityZoneOverlay();
    if (activeInds.has('flow')) _renderFlowPanel(_hoverMarkerTime);
  }
  _scheduleDrawings();
}

function _applyLiveKlineBar(bar) {
  if (!bar || !_klineData.length || !candleSeries) return { changed: false, isNew: false };
  const time = Number(bar.time);
  const close = Number(bar.close);
  if (!Number.isFinite(time) || !Number.isFinite(close) || close <= 0) return { changed: false, isNew: false };

  const last = _klineData[_klineData.length - 1];
  const idx = time >= last.time ? _klineData.length - 1 : _klineData.findIndex(k => k.time === time);
  const prev = idx >= 0 && time === _klineData[idx].time ? _klineData[idx] : null;
  const open = _finiteOr(bar.open, prev?.open ?? last.close ?? close);
  const high = Math.max(_finiteOr(bar.high, prev?.high ?? open), open, close);
  const low = Math.min(_finiteOr(bar.low, prev?.low ?? open), open, close);
  const next = {
    ...(prev || {}),
    time,
    open,
    high,
    low,
    close,
  };
  if (Number.isFinite(Number(bar.volume))) next.volume = Number(bar.volume);
  if (Number.isFinite(Number(bar.quote_volume))) next.quote_volume = Number(bar.quote_volume);
  if (Number.isFinite(Number(bar.delta))) next.delta = Number(bar.delta);

  if (time === last.time) {
    _klineData[_klineData.length - 1] = next;
    try { candleSeries.update(_mainCandlePoint(next)); } catch (_) {}
    try { volSeries.update(_mainVolumePoint(next)); } catch (_) {}
  } else if (time > last.time) {
    _klineData.push(next);
    try { candleSeries.update(_mainCandlePoint(next)); } catch (_) {}
    try { volSeries.update(_mainVolumePoint(next)); } catch (_) {}
  } else if (idx >= 0) {
    _klineData[idx] = next;
    _setMainSeriesData();
  } else {
    return { changed: false, isNew: false };
  }

  if (time >= last.time) _updateChartHeaderPrice(close);
  return { changed: true, isNew: time > last.time };
}

function _patchLiveChartPrice(price, eventTimeSec = null) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0 || !_klineData.length || !candleSeries) return;
  const candleTime = _candleTimeFromExchangeTime(eventTimeSec, _rtTf || chartTf);
  const last = _klineData[_klineData.length - 1];
  const time = candleTime != null && candleTime >= last.time ? candleTime : last.time;
  const result = _applyLiveKlineBar({ time, close: n });
  if (result.changed) _redrawLiveOverlays(result.isNew);
}

function _queueLiveChartPrice(price, eventTimeSec = null) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return;
  const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  _rtChartPricePending = { price: n, eventTimeSec };

  const flush = () => {
    _rtChartPriceTimer = null;
    const tick = _rtChartPricePending;
    _rtChartPricePending = null;
    _rtChartPriceLastPatchAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    if (tick) _patchLiveChartPrice(tick.price, tick.eventTimeSec);
  };

  if (!_rtChartPriceTimer && now - _rtChartPriceLastPatchAt >= CHART_PRICE_PATCH_MS) {
    flush();
    return;
  }

  if (!_rtChartPriceTimer) {
    const delay = Math.max(16, CHART_PRICE_PATCH_MS - (now - _rtChartPriceLastPatchAt));
    _rtChartPriceTimer = setTimeout(flush, delay);
  }
}

function _startRtPriceFallback(symbol, tf) {
  _stopRtPriceFallback();
  const poll = async () => {
    if (_rtSymbol !== symbol || _rtTf !== tf || !chart || !_klineData.length) return;
    if (_rtLastTickAt && Date.now() - _rtLastTickAt < RT_WS_STALE_MS) return;
    try {
      const res = await fetch(`/api/futures/${symbol}/last-price`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (_rtSymbol !== symbol || _rtTf !== tf) return;
      const price = Number(data.last_price);
      if (price > 0) _patchLiveChartPrice(price, data.time);
    } catch (_) {}
  };
  _rtPricePollTimer = setInterval(poll, RT_PRICE_POLL_MS);
}

function _startRtWs(symbol, tf) {
  _stopRtWs();
  if (!symbol || !tf) return;
  _rtSymbol = symbol; _rtTf = tf;
  _rtLastTickAt = 0;
  _startRtPriceFallback(symbol, tf);

  const sym  = symbol.toLowerCase();
  // kline stream + raw trades keep chart price aligned with Binance Last.
  const url  = `wss://fstream.binance.com/stream?streams=${sym}@kline_${tf}/${sym}@trade`;
  let ws;
  try { ws = new WebSocket(url); } catch (_) { return; }
  _rtWs = ws;

  ws.onmessage = (ev) => {
    if (_rtWs !== ws || _rtSymbol !== symbol || _rtTf !== tf) {
      try { ws.close(1000, 'stale'); } catch (_) {}
      return;
    }
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    _rtLastTickAt = Date.now();

    const data = msg.data || msg;
    const streamType = (msg.stream || '').split('@')[1] || data.e;

    if (streamType === 'trade' || data.e === 'trade') {
      const price = Number(data.p);
      const eventTimeSec = data.E ? Number(data.E) / 1000 : Date.now() / 1000;
      _queueLiveChartPrice(price, eventTimeSec);
      return;
    }

    // ── kline event ───────────────────────────────────────────────────────────
    const k = data.k;
    if (!k || !_klineData.length) return;
    const candleTime = Math.floor(k.t / 1000); // candle open time in seconds
    const o = parseFloat(k.o), h = parseFloat(k.h),
          l = parseFloat(k.l), c = parseFloat(k.c);
    const vol = parseFloat(k.v), qv = parseFloat(k.q);
    const last = _klineData[_klineData.length - 1];
    const takerBuyQuote = k.Q != null ? parseFloat(k.Q) : NaN;
    const fallbackDelta = candleTime === last.time && Number.isFinite(Number(last.delta)) ? Number(last.delta) : 0;
    const delta = Number.isFinite(qv) && Number.isFinite(takerBuyQuote)
      ? Math.round((2 * takerBuyQuote - qv) * 100) / 100
      : fallbackDelta;
    const result = _applyLiveKlineBar({
      time: candleTime,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: vol,
      quote_volume: qv,
      delta,
    });
    const cvdDirty = result.changed;
    if (cvdDirty) {
      _redrawLiveOverlays(result.isNew);
      _maybeRefreshOI();
    }
    if (cvdDirty && activeInds.has('cvd')) loadCVD();
    if (cvdDirty && activeInds.has('ofv')) loadOFV();
    if (cvdDirty && activeInds.has('macd')) loadMACD();
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    // reconnect after 3 s if still on same symbol/tf
    if (_rtWs === ws && _rtSymbol === symbol && _rtTf === tf) {
      _rtWs = null;
      setTimeout(() => { if (!_rtWs && _rtSymbol === symbol && _rtTf === tf) _startRtWs(symbol, tf); }, 3000);
    }
  };
}

function handleModalClick(e) {
  if (e.target === document.getElementById('chart-modal')) closeChart();
}

document.addEventListener('keydown', e => {
  if (_isTextInputTarget(e.target)) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (deleteSelectedDrawing()) e.preventDefault();
    return;
  }
  if (e.key !== 'Escape') return;
  if (_cancelDrawingInteraction()) {
    e.preventDefault();
    return;
  }
  if (_hoverMarkerLocked) {
    _hideHoverMarker(true);
    e.preventDefault();
    return;
  }
  closeChart();
});

// ── Main chart init / destroy ──────────────────────────────────────────────────
function initChart() {
  const container = document.getElementById('chart-container');
  _attachDrawingOverlayEvents();
  _updateDrawToolbar();
  chart = LightweightCharts.createChart(container, {
    layout: {
      background: { type: 'solid', color: '#161b22' },
      textColor: CHART_TEXT_COLOR,
    },
    grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
    crosshair: {
      mode: 0,
      vertLine: { visible: false, labelVisible: false },
      horzLine: { width: 1, color: '#5d6672', style: 0, labelVisible: false },
    },
    rightPriceScale: { borderColor: '#30363d', mode: _chartScaleModeValue() },
    timeScale: { borderColor: CHART_BORDER_COLOR, timeVisible: true, secondsVisible: false, rightOffset: CHART_RIGHT_OFFSET },
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: '#3fb950', downColor: '#f85149',
    borderUpColor: '#3fb950', borderDownColor: '#f85149',
    wickUpColor:   '#3fb950', wickDownColor:   '#f85149',
    priceLineVisible: true,
    priceLineWidth: 1,
    priceLineColor: '#5d6672',
    lastValueVisible: true,
    autoscaleInfoProvider: _mainAutoscaleInfoProvider,
  });

  volSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    lastValueVisible: false, priceLineVisible: false,
  });
  volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.5, bottom: 0 } });

  // Crosshair: delegates to shared sync helpers so all panels stay in sync
  chart.subscribeCrosshairMove(param => {
    if (param.time) _syncCrosshairAt(param.time, chart, false, _mainPriceFromParam(param));
    else _syncCrosshairLeave();
  });
  chart.subscribeClick(param => _handleHoverMarkerClick(param, chart));

  chart.timeScale().subscribeVisibleLogicalRangeChange(_syncIndicatorRanges);
  chart.timeScale().subscribeVisibleTimeRangeChange(() => {
    _scheduleMarketStructure();
    _scheduleOrderbookHeatmap();
    _scheduleVP();
  });
  chart.subscribeCrosshairMove(() => _scheduleVP());

  const ro = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    if (chart && width > 0 && height > 0) {
      try { chart.resize(width, height); } catch (_) {}
      _scheduleLiquidityZoneOverlay();
      _scheduleMarketStructure();
      _scheduleOrderbookHeatmap();
      _scheduleVP();
      _scheduleDrawings();
      _refreshHoverMarker();
    }
  });
  ro.observe(container);
  chart._ro = ro;
}

function destroyChart() {
  _stopOrderbookRefresh();
  _clearLiquidityZones();
  _clearMarketStructure();
  _clearOrderbookHeatmap();
  _clearOrderbookPanel();
  _clearAnalysisPanel();
  _destroyVP();
  _destroySuperTrend();
  _destroyVwap();
  if (chart) {
    if (chart._ro) chart._ro.disconnect();
    chart.remove();
    chart = null;
  }
  candleSeries = volSeries = null;
}

// ── Indicator init / destroy ───────────────────────────────────────────────────
function _makeIndChart(id) {
  const container = document.getElementById(id);
  const c = LightweightCharts.createChart(container, {
    layout: { background: { type: 'solid', color: '#161b22' }, textColor: CHART_TEXT_COLOR },
    grid:   { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
    crosshair: {
      mode: 1,
      vertLine: { visible: false, labelVisible: false },
      horzLine: { width: 1, color: '#5d6672', style: 0, labelVisible: false },
    },
    rightPriceScale: { borderColor: '#30363d' },
    timeScale: {
      visible: false,
      timeVisible: true,
      secondsVisible: false,
      borderColor: CHART_BORDER_COLOR,
      rightOffset: CHART_RIGHT_OFFSET,
    },
    handleScroll: false,
    handleScale:  false,
  });
  const ro = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    if (width > 0 && height > 0) {
      try { c.resize(width, height); } catch (_) {}
      _refreshHoverMarker();
    }
  });
  ro.observe(container);
  c._ro = ro;
  return c;
}

function initIndicators() {
  // OI
  if (activeInds.has('oi')) {
    document.getElementById('oi-panel').style.display = '';
    oiChart  = _makeIndChart('oi-panel');
    _createOiSeries();
    _attachIndSync(oiChart);
  } else {
    document.getElementById('oi-panel').style.display = 'none';
  }

  // CVD
  if (activeInds.has('cvd')) {
    document.getElementById('cvd-panel').style.display = '';
    cvdChart  = _makeIndChart('cvd-panel');
    _createCvdSeries();
    _attachIndSync(cvdChart);
  } else {
    document.getElementById('cvd-panel').style.display = 'none';
    _updateCvdModeButton();
  }

  // OFV
  if (activeInds.has('ofv')) {
    document.getElementById('ofv-panel').style.display = '';
    ofvChart = _makeIndChart('ofv-panel');
    _createOfvSeries();
    _attachIndSync(ofvChart);
  } else {
    document.getElementById('ofv-panel').style.display = 'none';
  }

  // L/S
  if (activeInds.has('ls')) {
    document.getElementById('ls-panel').style.display = '';
    lsChart      = _makeIndChart('ls-panel');
    lsLongSeries = lsChart.addLineSeries({
      color: '#3fb950', lineWidth: 1,
      lastValueVisible: true, priceLineVisible: false,
      title: 'L',
      priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
    });
    lsShortSeries = lsChart.addLineSeries({
      color: '#f85149', lineWidth: 1,
      lastValueVisible: true, priceLineVisible: false,
      title: 'S',
      priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
    });
    _attachIndSync(lsChart);
  } else {
    document.getElementById('ls-panel').style.display = 'none';
  }

  // Liquidations
  if (activeInds.has('liq')) {
    document.getElementById('liq-panel').style.display = '';
    liqChart       = _makeIndChart('liq-panel');
    liqShortSeries = liqChart.addHistogramSeries({
      color: LIQ_SHORT_COLOR, base: 0,
      lastValueVisible: false, priceLineVisible: false,
      priceFormat: { type: 'volume' },
    });
    liqLongSeries  = liqChart.addHistogramSeries({
      color: LIQ_LONG_COLOR, base: 0,
      lastValueVisible: false, priceLineVisible: false,
      priceFormat: { type: 'volume' },
    });
    _attachIndSync(liqChart);
  } else {
    document.getElementById('liq-panel').style.display = 'none';
  }

  // MACD
  if (activeInds.has('macd')) {
    document.getElementById('macd-panel').style.display = '';
    macdChart = _makeIndChart('macd-panel');
    _createMacdSeries();
    _attachIndSync(macdChart);
  } else {
    document.getElementById('macd-panel').style.display = 'none';
  }

  if (activeInds.has('flow')) {
    document.getElementById('flow-panel').style.display = '';
    _attachFlowPanelEvents();
    _renderFlowPanel();
  } else {
    document.getElementById('flow-panel').style.display = 'none';
  }

  _updateTimeScales();
}

function _destroyIndChart(c) {
  if (!c) return;
  if (c._ro) c._ro.disconnect();
  c.remove();
}

function destroyIndicators() {
  _destroyIndChart(oiChart);  oiChart = oiSeries = oiHistSeries = oiCandleSeries = null;
  _destroyIndChart(cvdChart); cvdChart = cvdSeries = cvdLineSeries = cvdCandleSeries = null;
  _destroyIndChart(ofvChart); ofvChart = ofvSeries = ofvZeroLine = null;
  _destroyIndChart(lsChart);  lsChart  = lsLongSeries = lsShortSeries = null;
  _destroyIndChart(liqChart); liqChart = liqLongSeries = liqShortSeries = null;
  _destroyIndChart(macdChart); macdChart = macdLineSeries = macdSignalSeries = macdHistSeries = null;
}

// ── Toggle indicator on/off ────────────────────────────────────────────────────
function toggleInd(name) {
  const btn = document.querySelector(`.ind-btn[data-ind="${name}"]`);
  if (!btn) return;
  const panel = document.getElementById(name + '-panel');
  const structureLayer = ['sessions', 'impulses', 'imbalance', 'structure', 'sweeps', 'htf', 'pd', 'score'].includes(name);
  if (activeInds.has(name)) {
    activeInds.delete(name);
    btn.classList.remove('active');
    if (name === 'oi'  && oiChart)  { _destroyIndChart(oiChart);  oiChart = oiSeries = oiHistSeries = oiCandleSeries = null; }
    if (name === 'cvd' && cvdChart) { _destroyIndChart(cvdChart); cvdChart = cvdSeries = cvdLineSeries = cvdCandleSeries = null; }
    if (name === 'ofv' && ofvChart) { _destroyIndChart(ofvChart); ofvChart = ofvSeries = ofvZeroLine = null; }
    if (name === 'ls'  && lsChart)  { _destroyIndChart(lsChart);  lsChart  = lsLongSeries = lsShortSeries = null; }
    if (name === 'liq' && liqChart) { _destroyIndChart(liqChart); liqChart = liqLongSeries = liqShortSeries = null; }
    if (name === 'macd' && macdChart) { _destroyIndChart(macdChart); macdChart = macdLineSeries = macdSignalSeries = macdHistSeries = null; }
    if (name === 'zones') _clearLiquidityZones();
    if (name === 'vp') _clearVolumeProfile();
    if (name === 'st') _destroySuperTrend();
    if (name === 'vwap') _destroyVwap();
    if (name === 'book') { _stopOrderbookRefresh(); _clearOrderbookHeatmap(); _clearOrderbookPanel(); }
    if (name === 'analysis') _renderAnalysisPanel();
    if (name === 'flow') _flowData = [];
    if (structureLayer) _scheduleMarketStructure();
    if (panel) panel.style.display = 'none';
    if (name === 'oi') _updateOiModeButton();
    if (name === 'cvd') _updateCvdModeButton();
    _updateTimeScales();
  } else {
    activeInds.add(name);
    btn.classList.add('active');
    if (panel) panel.style.display = '';
    // need indicator charts to exist; recreate only the toggled one
    if (name === 'oi') {
      oiChart  = _makeIndChart('oi-panel');
      _createOiSeries();
      _attachIndSync(oiChart);
      loadOI();
    } else if (name === 'cvd') {
      cvdChart  = _makeIndChart('cvd-panel');
      _createCvdSeries();
      _attachIndSync(cvdChart);
      loadCVD();
    } else if (name === 'ofv') {
      ofvChart = _makeIndChart('ofv-panel');
      _createOfvSeries();
      _attachIndSync(ofvChart);
      if (!_oiData.length) loadOI();
      else loadOFV();
    } else if (name === 'ls') {
      lsChart      = _makeIndChart('ls-panel');
      lsLongSeries = lsChart.addLineSeries({
        color: '#3fb950', lineWidth: 1, lastValueVisible: true, priceLineVisible: false,
        title: 'L', priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      });
      lsShortSeries = lsChart.addLineSeries({
        color: '#f85149', lineWidth: 1, lastValueVisible: true, priceLineVisible: false,
        title: 'S', priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      });
      _attachIndSync(lsChart);
      loadLS();
    } else if (name === 'liq') {
      liqChart       = _makeIndChart('liq-panel');
      liqShortSeries = liqChart.addHistogramSeries({
        color: LIQ_SHORT_COLOR, base: 0,
        lastValueVisible: false, priceLineVisible: false,
        priceFormat: { type: 'volume' },
      });
      liqLongSeries  = liqChart.addHistogramSeries({
        color: LIQ_LONG_COLOR, base: 0,
        lastValueVisible: false, priceLineVisible: false,
        priceFormat: { type: 'volume' },
      });
      _attachIndSync(liqChart);
      loadLiqs();
    } else if (name === 'macd') {
      macdChart = _makeIndChart('macd-panel');
      _createMacdSeries();
      _attachIndSync(macdChart);
      loadMACD();
    } else if (name === 'flow') {
      _attachFlowPanelEvents();
      _renderFlowPanel();
      if (!_oiData.length) loadOI();
      if (!_lsData.length) loadLS();
      if (!_liqData.length) loadLiqs();
    } else if (name === 'zones') {
      _renderLiquidityZones();
    } else if (name === 'st') {
      _renderSuperTrend();
    } else if (name === 'vp') {
      _renderVolumeProfile();
    } else if (name === 'vwap') {
      _renderVwap();
    } else if (name === 'book') {
      _startOrderbookRefresh();
    } else if (name === 'analysis') {
      if (!_cvdLineData.length) loadCVD();
      if (!_oiData.length) loadOI();
      _renderAnalysisPanel();
    } else if (structureLayer) {
      _scheduleMarketStructure();
    }
    _updateTimeScales();
    _syncIndicatorRanges();
  }
  _saveActiveIndicators();
}

// ── Prefetch cache (populated on mouseenter) ───────────────────────────────────
const _prefetch = {}; // key: symbol_tf → fetch Promise

function prefetchKlines(symbol) {
  const key = symbol + '_' + chartTf;
  if (_prefetch[key]) return;
  _prefetch[key] = fetch(`/api/futures/${symbol}/klines?interval=${chartTf}&limit=${CHART_KLINE_LIMIT}`);
  setTimeout(() => delete _prefetch[key], 12000);
}

// ── Klines ─────────────────────────────────────────────────────────────────────
async function loadKlines() {
  const seq = ++_loadSeq;
  const loader = document.getElementById('chart-loader');
  loader.style.display = 'flex';
  loader.textContent   = 'Загрузка...';
  _hideHoverMarker(true);
  _stopOrderbookRefresh();
  _clearIndicatorData();
  _clearLiquidityZones();
  _loadDrawings();

  // Start all 3 fetches simultaneously
  const key = chartSymbol + '_' + chartTf;
  const klineFetch = _prefetch[key] || fetch(`/api/futures/${chartSymbol}/klines?interval=${chartTf}&limit=${CHART_KLINE_LIMIT}`);
  delete _prefetch[key];
  const _oiTf  = _OI_INTERVAL[chartTf] || '5m';
  const needFlowData = activeInds.has('flow');
  const needOfvData = activeInds.has('ofv');
  const needAnalysisData = activeInds.has('analysis');
  const oiFetch = (activeInds.has('oi') || needFlowData || needOfvData || needAnalysisData) ? fetch(`/api/futures/${chartSymbol}/oi?interval=${_oiTf}&limit=${CHART_OI_LIMIT}`) : null;
  const lsFetch = (activeInds.has('ls') || needFlowData) ? fetch(`/api/futures/${chartSymbol}/ls-ratio?interval=${chartTf}&limit=${CHART_INDICATOR_LIMIT}`) : null;

  try {
    const res = await klineFetch;
    if (seq !== _loadSeq) return;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.json();
    if (seq !== _loadSeq) return;

    _klineData = [...raw]
      .sort((a, b) => a.time - b.time)
      .filter((k, i, arr) => i === 0 || k.time !== arr[i - 1].time);

    if (!_klineData.length) throw new Error('Нет данных');

    const _lastPrice = _klineData[_klineData.length - 1]?.close || 0;
    const _prec = _pricePrecision(_lastPrice);
    candleSeries.applyOptions({ priceFormat: { type: 'price', precision: _prec, minMove: Math.pow(10, -_prec) } });

    candleSeries.setData(_klineData.map(k => ({
      time: k.time, open: k.open, high: k.high, low: k.low, close: k.close,
    })));
    volSeries.setData(_klineData.map(k => ({
      time: k.time, value: _klineVolume(k),
      color: k.close >= k.open ? '#3fb95055' : '#f8514955',
    })));
    _renderSuperTrend();
    _renderVwap();
    chart.timeScale().fitContent();
    _renderLiquidityZones();
    _renderMarketStructure();
    _renderVolumeProfile();
    _renderAnalysisPanel();
    if (activeInds.has('book')) {
      _startOrderbookRefresh();
    }
    _scheduleDrawings();
    if (activeInds.has('flow')) _renderFlowPanel();
    requestAnimationFrame(_syncIndicatorRanges);

    // CVD is synchronous (computed from klines)
    if (activeInds.has('cvd') || activeInds.has('analysis')) loadCVD();

    // MACD is also synchronous (computed from klines)
    if (activeInds.has('macd')) loadMACD();

    // Liquidations: independent fetch, no need to wait for klines-aligned data
    if (activeInds.has('liq') || activeInds.has('flow')) loadLiqs();

    // OI and LS fetches already in flight — just await their responses
    await Promise.all([
      oiFetch ? _applyOI(oiFetch, seq)  : Promise.resolve(),
      lsFetch ? _applyLS(lsFetch, seq)  : Promise.resolve(),
    ]);
    if (seq === _loadSeq) {
      _fitKlineRange();
      loader.style.display = 'none';
      _scheduleMarketStructure();
      _renderAnalysisPanel();
      _startRtWs(chartSymbol, chartTf);
    }
  } catch (e) {
    if (seq === _loadSeq) loader.textContent = 'Ошибка: ' + e.message;
    console.error('Chart error:', e);
  }
}

// Show the full candle history. Indicator data may start later than klines.
function _fitKlineRange() {
  if (!chart || !_klineData.length) return;
  _setAllLogicalRange({ from: 0, to: _klineData.length - 1 + CHART_RIGHT_OFFSET });
}

function _alignToKlines(data, mapFn) {
  const src = data
    .map(mapFn)
    .filter(p => p && p.time != null)
    .sort((a, b) => a.time - b.time);
  const out = [];
  let idx = 0;
  let last = null;
  for (const k of _klineData) {
    while (idx < src.length && src[idx].time <= k.time) {
      last = src[idx];
      idx += 1;
    }
    out.push(last ? { ...last, time: k.time } : { time: k.time });
  }
  return out;
}

// Aggregate raw OI points into per-kline delta histogram, OI candles, and labels.
function _oiToSeriesData(data) {
  const src = [...data].sort((a, b) => a.time - b.time);
  const bars = [];
  const candles = [];
  const levels = [];
  let si = 0;
  let prevOi = null;

  for (let ki = 0; ki < _klineData.length; ki++) {
    const kStart = _klineData[ki].time;
    const kEnd   = ki + 1 < _klineData.length
      ? _klineData[ki + 1].time
      : kStart + (ki > 0 ? kStart - _klineData[ki - 1].time : 60);

    while (si < src.length && src[si].time < kStart) si++;

    const vals = [];
    const si0 = si;
    while (si < src.length && src[si].time < kEnd) {
      const oi = Number(src[si].oi);
      if (Number.isFinite(oi)) vals.push(oi);
      si++;
    }
    if (!vals.length) {
      si = si0;
      bars.push({ time: kStart, value: 0, color: 'rgba(0,0,0,0)' });
      if (prevOi !== null) {
        candles.push({
          time: kStart, open: prevOi, high: prevOi, low: prevOi, close: prevOi,
          color: 'rgba(0,0,0,0)', borderColor: 'rgba(0,0,0,0)', wickColor: 'rgba(0,0,0,0)',
        });
      } else {
        candles.push({ time: kStart });
      }
      levels.push({ time: kStart, value: prevOi || 0, open: prevOi || 0, high: prevOi || 0, low: prevOi || 0, close: prevOi || 0, pct: 0, displayPct: 0 });
      continue;
    }

    const openOi  = prevOi !== null ? prevOi : vals[0];
    const highOi  = Math.max(openOi, ...vals);
    const lowOi   = Math.min(openOi, ...vals);
    const closeOi = vals[vals.length - 1];
    const delta   = closeOi - openOi;
    const pct     = openOi > 0 ? (delta / openOi) * 100 : 0;
    prevOi = closeOi;

    bars.push({
      time:  kStart,
      value: pct,
      color: pct >= 0 ? 'rgba(63,185,80,0.75)' : 'rgba(248,81,73,0.75)',
    });
    candles.push({
      time: kStart,
      open: openOi,
      high: highOi,
      low: lowOi,
      close: closeOi,
      color: closeOi >= openOi ? '#3fb950' : '#f85149',
      borderColor: closeOi >= openOi ? '#3fb950' : '#f85149',
      wickColor: closeOi >= openOi ? '#3fb950' : '#f85149',
    });
    levels.push({ time: kStart, value: closeOi, open: openOi, high: highOi, low: lowOi, close: closeOi, pct, displayPct: pct });
  }

  // Clamp visual outliers, but keep raw pct in levels for labels.
  _oiHistScale = 0.05;
  if (bars.length > 10) {
    const absPcts = bars.map(b => Math.abs(b.value)).filter(v => v > 0).sort((a, b) => a - b);
    const p90 = absPcts[Math.floor(absPcts.length * 0.9)] || 0;
    const maxRaw = absPcts[absPcts.length - 1] || 0;
    const cap = Math.max(p90 * 3, 0.05);
    _oiHistScale = Math.max(0.05, Math.min(maxRaw || cap, cap));
    bars.forEach(b => {
      const raw = b.value;
      b.value = Math.max(-_oiHistScale, Math.min(_oiHistScale, raw));
    });
  }

  levels.forEach(l => {
    l.displayPct = Math.max(-_oiHistScale, Math.min(_oiHistScale, l.pct || 0));
  });
  return { bars, candles, levels };
}

// ── OI ─────────────────────────────────────────────────────────────────────────
async function loadOI() {
  const seq    = _loadSeq;
  const oiTf   = _OI_INTERVAL[chartTf] || '5m';
  const fetch$ = fetch(`/api/futures/${chartSymbol}/oi?interval=${oiTf}&limit=${CHART_OI_LIMIT}`);
  await _applyOI(fetch$, seq);
}

async function _applyOI(fetch$, seq) {
  if ((!oiChart && !activeInds.has('flow') && !activeInds.has('ofv') && !activeInds.has('analysis')) || !_klineData.length) return;
  _oiStartTime = null;
  try {
    const res = await fetch$;
    if (!res.ok || seq !== _loadSeq) return;
    const data = await res.json();
    if (!data.length || seq !== _loadSeq) return;
    _oiStartTime = data[0].time;
    const { bars, candles, levels } = _oiToSeriesData(data);
    _oiHistData = bars;
    _oiCandleData = candles;
    _oiData = levels;
    _lastOiReloadAt = Date.now();
    try { if (oiHistSeries) oiHistSeries.applyOptions(_oiHistOptions()); } catch (_) {}
    _applyOiSeriesMode();
    if (activeInds.has('ofv')) loadOFV();
    if (activeInds.has('flow')) _renderFlowPanel(_hoverMarkerTime);
    _syncIndicatorRanges();
    _renderAnalysisPanel();
  } catch (e) { console.warn('OI error:', e); }
}

// ── CVD ────────────────────────────────────────────────────────────────────────
function loadCVD() {
  if (!_klineData.length) return;
  let cum = 0;
  const lineData = [];
  const candleData = [];
  const lookupData = [];
  _klineData.forEach(k => {
    const delta = Number.isFinite(Number(k.delta)) ? Number(k.delta) : 0;
    const open  = Math.round(cum);
    cum += delta;
    const close = Math.round(cum);
    const high  = Math.max(open, close);
    const low   = Math.min(open, close);
    lineData.push({ time: k.time, value: close });
    candleData.push({ time: k.time, open, high, low, close });
    lookupData.push({ time: k.time, value: close, open, high, low, close, delta: Math.round(delta) });
  });
  _cvdLineData = lineData;
  _cvdCandleData = candleData;
  _cvdData = lookupData;
  _applyCvdSeriesMode();
  _syncIndicatorRanges();
  _renderAnalysisPanel();
}

// ── MACD (12/26/9, computed client-side from close prices) ─────────────────────
function _pricePrecision(price) {
  return price >= 1000 ? 2 : price >= 1 ? 4 : price >= 0.1 ? 5 : price >= 0.01 ? 6 : price >= 0.001 ? 7 : 8;
}

// EMA over `values`, tolerating leading nulls (e.g. the MACD line feeding the
// signal EMA). Returns null until `period` non-null values have accumulated.
function _ema(values, period) {
  const out = new Array(values.length).fill(null);
  let start = 0;
  while (start < values.length && values[start] == null) start++;
  if (values.length - start < period) return out;

  let sum = 0;
  for (let i = start; i < start + period; i++) sum += values[i];
  let prev = sum / period;
  const seedIdx = start + period - 1;
  out[seedIdx] = prev;

  const k = 2 / (period + 1);
  for (let i = seedIdx + 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function loadMACD() {
  if (!_klineData.length) { _macdData = []; return; }
  const closes = _klineData.map(k => k.close);
  const emaFast = _ema(closes, 12);
  const emaSlow = _ema(closes, 26);
  const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
  const signalLine = _ema(macdLine, 9);

  _macdPrec = _pricePrecision(closes[closes.length - 1] || 0);
  const priceFormat = { type: 'price', precision: _macdPrec, minMove: Math.pow(10, -_macdPrec) };
  // One entry per kline (whitespace points during EMA warmup) — the panel is its
  // own chart instance, so logical-range sync with the main chart requires the
  // same bar count, or the whole indicator renders shifted off its true position.
  _macdData = [];
  const histPoints = [];
  const macdPoints = [];
  const signalPoints = [];
  for (let i = 0; i < _klineData.length; i++) {
    const time = _klineData[i].time;
    const macd = macdLine[i];
    const signal = signalLine[i];
    if (macd == null || signal == null) {
      histPoints.push({ time });
      macdPoints.push({ time });
      signalPoints.push({ time });
      continue;
    }
    const hist = macd - signal;
    histPoints.push({ time, value: hist, color: hist >= 0 ? 'rgba(63,185,80,0.75)' : 'rgba(248,81,73,0.75)' });
    macdPoints.push({ time, value: macd });
    signalPoints.push({ time, value: signal });
    _macdData.push({ time, macd, signal, hist });
  }

  try {
    if (macdHistSeries) {
      macdHistSeries.applyOptions({ priceFormat });
      macdHistSeries.setData(histPoints);
    }
    if (macdLineSeries) {
      macdLineSeries.applyOptions({ priceFormat });
      macdLineSeries.setData(macdPoints);
    }
    if (macdSignalSeries) {
      macdSignalSeries.applyOptions({ priceFormat });
      macdSignalSeries.setData(signalPoints);
    }
  } catch (_) {}
  _syncIndicatorRanges();
}

// ── L/S ────────────────────────────────────────────────────────────────────────
async function loadLS() {
  const seq    = _loadSeq;
  const fetch$ = fetch(`/api/futures/${chartSymbol}/ls-ratio?interval=${chartTf}&limit=${CHART_INDICATOR_LIMIT}`);
  await _applyLS(fetch$, seq);
}

async function _applyLS(fetch$, seq) {
  if ((!lsLongSeries && !activeInds.has('flow')) || !_klineData.length) return;
  _lsStartTime = null;
  try {
    const res = await fetch$;
    if (!res.ok || seq !== _loadSeq) return;
    const data = await res.json();
    if (!data.length || seq !== _loadSeq) return;
    _lsStartTime = data[0].time;
    _lsData = data.map(d => ({ time: d.time, long_pct: d.long_pct, short_pct: d.short_pct }));
    if (lsLongSeries) lsLongSeries.setData( _alignToKlines(data, d => ({ time: d.time, value: d.long_pct  })));
    if (lsShortSeries) lsShortSeries.setData(_alignToKlines(data, d => ({ time: d.time, value: d.short_pct })));
    if (activeInds.has('flow')) _renderFlowPanel(_hoverMarkerTime);
    _syncIndicatorRanges();
    _renderAnalysisPanel();
  } catch (e) { console.warn('L/S error:', e); }
}

// ── Liquidations ───────────────────────────────────────────────────────────────
function _alignLiqsToKlines(data) {
  const src = data
    .map(d => ({ time: d.time, long_usd: d.long, short_usd: d.short }))
    .filter(d => d.time != null)
    .sort((a, b) => a.time - b.time);

  let idx = 0;
  return _klineData.map((k, i) => {
    const start = k.time;
    const end = i + 1 < _klineData.length
      ? _klineData[i + 1].time
      : start + (i > 0 ? k.time - _klineData[i - 1].time : 60);
    let long_usd = 0;
    let short_usd = 0;

    while (idx < src.length && src[idx].time < start) idx += 1;
    while (idx < src.length && src[idx].time < end) {
      long_usd += src[idx].long_usd || 0;
      short_usd += src[idx].short_usd || 0;
      idx += 1;
    }

    return { time: start, long_usd, short_usd };
  });
}

async function loadLiqs() {
  const seq = _loadSeq;
  if (!liqLongSeries && !activeInds.has('flow')) return;
  try {
    const res = await fetch(`/api/futures/${chartSymbol}/liquidations?limit=10000`);
    if (!res.ok || seq !== _loadSeq) return;
    const data = await res.json();
    if (seq !== _loadSeq) return;
    _liqData = _alignLiqsToKlines(data);
    // shorts liquidated → green bars (positive); longs liquidated → red bars (negative)
    if (liqShortSeries) liqShortSeries.setData(_liqData.map(d => ({ time: d.time, value:  d.short_usd })));
    if (liqLongSeries) liqLongSeries.setData( _liqData.map(d => ({ time: d.time, value: -d.long_usd  })));
    if (activeInds.has('flow')) _renderFlowPanel(_hoverMarkerTime);
    _syncIndicatorRanges();
    _renderAnalysisPanel();
  } catch (e) { console.warn('Liq error:', e); }
}

function setTf(tf) {
  _stopRtWs();
  _hideHoverMarker(true);
  chartTf = tf;
  _saveChartTf();
  _syncChartTfButtons();
  loadKlines();
}

function toggleFullscreen() {
  const inner = document.querySelector('#chart-modal .modal-inner');
  const btn   = document.getElementById('fullscreen-btn');
  const isFs  = inner.classList.toggle('fullscreen');
  btn.textContent = isFs ? '⊡' : '⛶';
  btn.title = isFs ? 'Свернуть' : 'На весь экран';
}
const spot = { sortCol: 'rank',            sortOrder: 'asc'  };
const fut  = { sortCol: 'quote_volume_24h', sortOrder: 'desc' };
let filterTimer  = null;

// ── L/S OI helpers ────────────────────────────────────────────────────────────
function _longOI(f) {
  if (!f.oi_usd) return null;
  const pct = lsMethod === 'global'  ? f.ls_long_pct
            : lsMethod === 'top_acc' ? f.ls_ta_long_pct
            :                          f.ls_top_long_pct;
  return pct != null ? f.oi_usd * pct / 100 : null;
}
function _shortOI(f) {
  if (!f.oi_usd) return null;
  const pct = lsMethod === 'global'  ? f.ls_short_pct
            : lsMethod === 'top_acc' ? f.ls_ta_short_pct
            :                          f.ls_top_short_pct;
  return pct != null ? f.oi_usd * pct / 100 : null;
}

// ── Formatters ─────────────────────────────────────────────────────────────────
const fmt = {
  _num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  },
  price(v) {
    // Chart/API values can briefly be NaN while a series is being rebuilt.
    // Never let that leak into drawing labels (notably Fibonacci levels).
    const price = this._num(v);
    if (price == null) return '—';
    if (price >= 1000) return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 1)    return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return '$' + price.toPrecision(4);
  },
  rank(v) {
    const rank = this._num(v);
    return rank != null && rank > 0 ? String(Math.trunc(rank)) : '—';
  },
  pct(v, bold) {
    const value = this._num(v);
    if (value == null) return '<span class="neutral">—</span>';
    const cls = value > 0 ? 'pos' : value < 0 ? 'neg' : 'neutral';
    const w   = bold ? ' font-weight:600;' : '';
    return `<span class="${cls}" style="${w}">${value > 0 ? '+' : ''}${value.toFixed(2)}%</span>`;
  },
  large(v) {
    const value = this._num(v);
    if (value == null) return '—';
    if (value >= 1e12) return '$' + (value / 1e12).toFixed(2) + 'T';
    if (value >= 1e9)  return '$' + (value / 1e9 ).toFixed(2) + 'B';
    if (value >= 1e6)  return '$' + (value / 1e6 ).toFixed(2) + 'M';
    if (value >= 1e3)  return '$' + (value / 1e3 ).toFixed(1) + 'K';
    return '$' + value.toFixed(2);
  },
  spike(v) {
    const value = this._num(v);
    if (value == null) return '<span class="neutral">—</span>';
    const x    = value.toFixed(1) + '×';
    const cls  = value >= 10 ? 'spike-huge' : value >= 5 ? 'spike-high' : value >= 2 ? 'spike-mid' : 'spike-low';
    return `<span class="${cls}">${x}</span>`;
  },
  funding(v) {
    const value = this._num(v);
    if (value == null) return '<span class="funding-zero">—</span>';
    const pct = (value * 100).toFixed(4);
    const cls = value > 0 ? 'funding-pos' : value < 0 ? 'funding-neg' : 'funding-zero';
    return `<span class="${cls}">${value > 0 ? '+' : ''}${pct}%</span>`;
  },
  date(v) {
    if (!v) return '—';
    return new Date(v + 'Z').toLocaleTimeString('ru-RU');
  },
  ls(v) {
    const value = this._num(v);
    if (value == null) return '<span class="neutral">—</span>';
    const cls = value >= 1 ? 'pos' : 'neg';
    return `<span class="${cls}">${value.toFixed(2)}</span>`;
  },
  oi(v) {
    const value = this._num(v);
    if (value == null) return '—';
    if (value >= 1e9)  return (value / 1e9).toFixed(2)  + 'B';
    if (value >= 1e6)  return (value / 1e6).toFixed(2)  + 'M';
    if (value >= 1e3)  return (value / 1e3).toFixed(1)  + 'K';
    return value.toFixed(0);
  },
  cvd(v) {
    const value = this._num(v);
    if (value == null) return '<span class="neutral">—</span>';
    const cls = value > 0 ? 'pos' : value < 0 ? 'neg' : 'neutral';
    const abs = Math.abs(value);
    let s = abs >= 1e9 ? (abs/1e9).toFixed(2)+'B' : abs >= 1e6 ? (abs/1e6).toFixed(2)+'M' : abs >= 1e3 ? (abs/1e3).toFixed(1)+'K' : abs.toFixed(0);
    return `<span class="${cls}">${value > 0 ? '+' : '-'}${s}</span>`;
  },
  takerPct(v) {
    const value = this._num(v);
    if (value == null) return '<span class="neutral">—</span>';
    const cls = value > 52 ? 'pos' : value < 48 ? 'neg' : 'neutral';
    return `<span class="${cls}">${value.toFixed(1)}%</span>`;
  },
};

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SPOT_FILTER_IDS = ['search', 'min-change', 'max-change', 'min-cap'];
const FUT_FILTER_IDS = [
  'f-search', 'f-quote', 'f-exclude-top', 'f-min-5m', 'f-max-5m',
  'f-min-15m', 'f-max-15m', 'f-vol-spike', 'f-min-change', 'f-max-change',
];

function _readControlValues(ids) {
  return ids.reduce((out, id) => {
    const el = document.getElementById(id);
    if (el) out[id] = el.value;
    return out;
  }, {});
}

function _writeControlValues(values = {}) {
  Object.entries(values).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.value = value ?? '';
  });
}

function _syncQuickButtons() {
  document.querySelectorAll('.quick-btn').forEach(btn => {
    const mode = btn.id.replace(/^qb-/, '');
    btn.className = 'quick-btn' + (mode === activeQuick ? ' active-' + activeQuick : '');
  });
  const hint = document.getElementById('quick-hint');
  if (hint) hint.textContent = QUICK_HINTS[activeQuick] || '';
}

function _syncSortHeaders(selector, state) {
  document.querySelectorAll(selector).forEach(th => {
    const active = th.dataset.col === state.sortCol;
    th.classList.toggle('active', active);
    th.classList.toggle('asc', active && state.sortOrder === 'asc');
    th.classList.toggle('desc', active && state.sortOrder === 'desc');
  });
}

function _syncLsMethodButtons() {
  document.querySelectorAll('.ls-method-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === lsMethod);
  });
}

function _saveScreenerSettings() {
  _safeJsonWrite(SCREENER_SETTINGS_STORAGE_KEY, {
    currentTab,
    activeQuick,
    lsMethod,
    spotSort: { ...spot },
    futSort: { ...fut },
    spotFilters: _readControlValues(SPOT_FILTER_IDS),
    futFilters: _readControlValues(FUT_FILTER_IDS),
  });
}

function _restoreScreenerSettings() {
  const saved = _safeJsonRead(SCREENER_SETTINGS_STORAGE_KEY, {});
  currentTab = saved.currentTab === 'futures' ? 'futures' : 'spot';
  activeQuick = ['all', 'fav', 'pump', 'dump', 'vol'].includes(saved.activeQuick) ? saved.activeQuick : 'all';
  lsMethod = ['global', 'top_pos', 'top_acc'].includes(saved.lsMethod) ? saved.lsMethod : 'top_pos';

  if (saved.spotSort?.sortCol) {
    spot.sortCol = saved.spotSort.sortCol;
    spot.sortOrder = saved.spotSort.sortOrder === 'asc' ? 'asc' : 'desc';
  }
  if (saved.futSort?.sortCol) {
    fut.sortCol = saved.futSort.sortCol;
    fut.sortOrder = saved.futSort.sortOrder === 'asc' ? 'asc' : 'desc';
  }

  _writeControlValues(saved.spotFilters);
  _writeControlValues(saved.futFilters);
  _syncQuickButtons();
  _syncLsMethodButtons();
  _syncSortHeaders('th.sortable', spot);
  _syncSortHeaders('th.f-sortable', fut);
}

function _stopSpotPriceWs() {
  if (_spotPriceReconnectTimer) {
    clearTimeout(_spotPriceReconnectTimer);
    _spotPriceReconnectTimer = null;
  }
  if (_spotPriceFlushRaf) {
    cancelAnimationFrame(_spotPriceFlushRaf);
    _spotPriceFlushRaf = null;
  }
  _spotPriceWss.forEach(ws => {
    try { ws.onmessage = ws.onerror = ws.onclose = null; } catch (_) {}
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'switch');
    } catch (_) {}
  });
  _spotPriceWss = [];
  _spotPriceWsKey = '';
  _spotPriceSymbols = new Set();
  _spotPricePending.clear();
  _spotPriceCells = new Map();
}

function _stopFuturesPriceWs() {
  if (_futuresPriceReconnectTimer) {
    clearTimeout(_futuresPriceReconnectTimer);
    _futuresPriceReconnectTimer = null;
  }
  if (_futuresPriceFlushRaf) {
    cancelAnimationFrame(_futuresPriceFlushRaf);
    _futuresPriceFlushRaf = null;
  }
  _futuresPriceWss.forEach(ws => {
    try { ws.onmessage = ws.onerror = ws.onclose = null; } catch (_) {}
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'switch');
    } catch (_) {}
  });
  _futuresPriceWss = [];
  _futuresPriceWsKey = '';
  _futuresPriceSymbols = new Set();
  _futuresPricePending.clear();
  _futuresPriceCells = new Map();
}

function _priceFromTicker(data) {
  for (const value of [data?.c, data?.lastPrice, data?.price]) {
    const last = Number(value);
    if (last > 0) return last;
  }
  const bid = Number(data?.b);
  const ask = Number(data?.a);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  const fallback = Number(data?.b || data?.a || 0);
  return fallback > 0 ? fallback : null;
}

function _updatePriceCell(cell, price) {
  if (!cell || !Number.isFinite(price) || price <= 0) return;
  const prev = Number(cell.dataset.price || 0);
  cell.dataset.price = String(price);
  cell.textContent = fmt.price(price);
  cell.classList.remove('price-tick-up', 'price-tick-down');
  if (prev > 0 && price !== prev) {
    cell.classList.add(price > prev ? 'price-tick-up' : 'price-tick-down');
    clearTimeout(cell._priceTickTimer);
    cell._priceTickTimer = setTimeout(() => cell.classList.remove('price-tick-up', 'price-tick-down'), TABLE_PRICE_FLASH_MS);
  }
}

function _updateSpotPriceCell(symbol, price) {
  _updatePriceCell(_spotPriceCells.get(symbol), price);
}

function _updateFuturesPriceCell(symbol, price) {
  _updatePriceCell(_futuresPriceCells.get(symbol), price);
}

function _spotUsdtPairFromCoin(coin) {
  const base = String(coin?.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!base || ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'FDUSD'].includes(base)) return null;
  return `${base}USDT`;
}

function _cachePriceCells(tbody, attr) {
  return new Map([...tbody.querySelectorAll(`[${attr}]`)].map(cell => [cell.getAttribute(attr), cell]));
}

function _tickerItems(payload) {
  if (Array.isArray(payload)) return payload;
  return payload ? [payload] : [];
}

function _flushSpotPriceUpdates() {
  _spotPriceFlushRaf = null;
  const pending = _spotPricePending;
  _spotPricePending = new Map();
  pending.forEach((price, symbol) => _updateSpotPriceCell(symbol, price));
}

function _flushFuturesPriceUpdates() {
  _futuresPriceFlushRaf = null;
  const pending = _futuresPricePending;
  _futuresPricePending = new Map();
  pending.forEach((price, symbol) => _updateFuturesPriceCell(symbol, price));
}

function _scheduleSpotPriceFlush() {
  if (!_spotPriceFlushRaf) _spotPriceFlushRaf = requestAnimationFrame(_flushSpotPriceUpdates);
}

function _scheduleFuturesPriceFlush() {
  if (!_futuresPriceFlushRaf) _futuresPriceFlushRaf = requestAnimationFrame(_flushFuturesPriceUpdates);
}

function _applySpotTickerPayload(payload) {
  _tickerItems(payload).forEach(data => {
    const symbol = data?.s;
    if (!symbol || !_spotPriceSymbols.has(symbol)) return;
    const price = _priceFromTicker(data);
    if (!price) return;
    _spotPricePending.set(symbol, price);
  });
  if (_spotPricePending.size) _scheduleSpotPriceFlush();
}

function _startSpotPriceWs(symbols) {
  const unique = [...new Set((symbols || []).map(s => String(s || '').toUpperCase()).filter(Boolean))];
  if (currentTab !== 'spot' || !unique.length) {
    _stopSpotPriceWs();
    return;
  }
  _spotPriceSymbols = new Set(unique);
  const key = unique.join(',');
  const hasLiveSockets = _spotPriceWss.some(ws => ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
  _spotPriceWsKey = key;
  if (hasLiveSockets || _spotPriceReconnectTimer) return;

  let ws;
  try {
    ws = new WebSocket(SPOT_PRICE_STREAM_URL);
  } catch (e) {
    console.warn('Spot price WebSocket error:', e);
    return;
  }
  _spotPriceWss = [ws];
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    _applySpotTickerPayload(msg.data || msg);
  };
  ws.onerror = e => console.warn('Spot price WebSocket error:', e);
  ws.onclose = () => {
    _spotPriceWss = _spotPriceWss.filter(item => item !== ws);
    if (currentTab !== 'spot' || !_spotPriceSymbols.size || _spotPriceReconnectTimer) return;
    _spotPriceReconnectTimer = setTimeout(() => {
      _spotPriceReconnectTimer = null;
      if (currentTab === 'spot' && _spotPriceSymbols.size) _startSpotPriceWs([..._spotPriceSymbols]);
    }, SPOT_PRICE_WS_RECONNECT_MS);
  };
}

function _applyFuturesTickerPayload(payload) {
  _tickerItems(payload).forEach(data => {
    const symbol = data?.s;
    if (!symbol || !_futuresPriceSymbols.has(symbol)) return;
    const price = _priceFromTicker(data);
    if (!price) return;
    _futuresPricePending.set(symbol, price);
  });
  if (_futuresPricePending.size) _scheduleFuturesPriceFlush();
}

function _startFuturesPriceWs(symbols) {
  const unique = [...new Set((symbols || []).map(s => String(s || '').toUpperCase()).filter(Boolean))];
  if (currentTab !== 'futures' || !unique.length) {
    _stopFuturesPriceWs();
    return;
  }
  _futuresPriceSymbols = new Set(unique);
  const key = unique.join(',');
  const hasLiveSockets = _futuresPriceWss.some(ws => ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
  _futuresPriceWsKey = key;
  if (hasLiveSockets || _futuresPriceReconnectTimer) return;

  let ws;
  try {
    ws = new WebSocket(FUTURES_PRICE_STREAM_URL);
  } catch (e) {
    console.warn('Futures price WebSocket error:', e);
    return;
  }
  _futuresPriceWss = [ws];
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    _applyFuturesTickerPayload(msg.data || msg);
  };
  ws.onerror = e => console.warn('Futures price WebSocket error:', e);
  ws.onclose = () => {
    _futuresPriceWss = _futuresPriceWss.filter(item => item !== ws);
    if (currentTab !== 'futures' || !_futuresPriceSymbols.size || _futuresPriceReconnectTimer) return;
    _futuresPriceReconnectTimer = setTimeout(() => {
      _futuresPriceReconnectTimer = null;
      if (currentTab === 'futures' && _futuresPriceSymbols.size) _startFuturesPriceWs([..._futuresPriceSymbols]);
    }, FUTURES_PRICE_WS_RECONNECT_MS);
  };
}

// ── Tab switching ──────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const isSpot = tab === 'spot';
  document.getElementById('spot-filters').style.display    = isSpot ? '' : 'none';
  document.getElementById('spot-panel').style.display      = isSpot ? '' : 'none';
  document.getElementById('futures-filters').style.display = isSpot ? 'none' : '';
  document.getElementById('futures-panel').style.display   = isSpot ? 'none' : '';
  _saveScreenerSettings();
  if (isSpot) _stopFuturesPriceWs();
  else _stopSpotPriceWs();
  isSpot ? loadCoins() : loadFutures();
}

// ── Quick filters ──────────────────────────────────────────────────────────────
const QUICK_HINTS = {
  all:  '',
  fav:  'сохранённые монеты',
  pump: 'vol ≥ 2× + изм. 15м > 0',
  dump: 'vol ≥ 2× + изм. 15м < 0',
  vol:  'объём ≥ 3× нормы за 15м',
};

function quickFilter(mode) {
  activeQuick = mode;
  document.querySelectorAll('.quick-btn').forEach(b => {
    b.className = 'quick-btn' + (b.id === 'qb-' + mode ? ' active-' + mode : '');
  });
  document.getElementById('quick-hint').textContent = QUICK_HINTS[mode] || '';

  // reset manual short-term inputs
  ['f-min-5m','f-max-5m','f-min-15m','f-max-15m','f-vol-spike'].forEach(id => {
    const el = document.getElementById(id);
    if (el.tagName === 'SELECT') el.value = '';
    else el.value = '';
  });

  if (mode === 'pump') {
    document.getElementById('f-min-15m').value  = '0.3';
    document.getElementById('f-vol-spike').value = '2';
  } else if (mode === 'dump') {
    document.getElementById('f-max-15m').value  = '-0.3';
    document.getElementById('f-vol-spike').value = '2';
  } else if (mode === 'vol') {
    document.getElementById('f-vol-spike').value = '3';
  }
  // fav: no server filters — filtered client-side in loadFutures

  _saveScreenerSettings();
  loadFutures();
}

// ── SPOT ───────────────────────────────────────────────────────────────────────
function buildSpotQuery() {
  const p = new URLSearchParams({ sort_by: spot.sortCol, order: spot.sortOrder, limit: 200 });
  const s   = document.getElementById('search').value.trim();
  const minC = document.getElementById('min-change').value;
  const maxC = document.getElementById('max-change').value;
  const minCap = document.getElementById('min-cap').value;
  if (s)     p.set('search', s);
  if (minC)  p.set('min_change_24h', minC);
  if (maxC)  p.set('max_change_24h', maxC);
  if (minCap) p.set('min_market_cap', minCap);
  return '/api/coins?' + p;
}

async function loadCoins() {
  const tbody = document.getElementById('coins-body');
  try {
    const res = await fetch(buildSpotQuery());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    document.getElementById('last-updated').textContent = 'Обновлено: ' + fmt.date(data.last_updated);
    document.getElementById('stats-bar').textContent = `Показано: ${data.coins.length} из ${data.total}`;

    if (!data.coins.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="loading">Нет данных по фильтру</td></tr>';
      _stopSpotPriceWs();
      return;
    }

    tbody.innerHTML = data.coins.map(c => {
      const spotPair = _spotUsdtPairFromCoin(c);
      const priceAttrs = spotPair ? ` data-spot-price="${esc(spotPair)}" data-price="${Number(c.price_usd || 0)}"` : '';
      return `
      <tr>
        <td class="muted">${fmt.rank(c.rank)}</td>
        <td><div class="coin-cell">
          ${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy"/>` : ''}
          <div><div class="coin-name">${esc(c.name)}</div><div class="coin-symbol">${esc(c.symbol)}</div></div>
        </div></td>
        <td class="right num"${priceAttrs}>${fmt.price(c.price_usd)}</td>
        <td class="right num">${fmt.pct(c.change_1h)}</td>
        <td class="right num">${fmt.pct(c.change_24h)}</td>
        <td class="right num">${fmt.pct(c.change_7d)}</td>
        <td class="right num">${fmt.large(c.market_cap)}</td>
        <td class="right num">${fmt.large(c.volume_24h)}</td>
        <td class="right num">${fmt.pct(c.ath_change_pct)}</td>
      </tr>`;
    }).join('');
    _spotPriceCells = _cachePriceCells(tbody, 'data-spot-price');
    _startSpotPriceWs([..._spotPriceCells.keys()]);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="9" class="error">Ошибка: ${esc(e.message)}</td></tr>`;
    _stopSpotPriceWs();
  }
}

function applyFilters() {
  _saveScreenerSettings();
  clearTimeout(filterTimer);
  filterTimer = setTimeout(loadCoins, 300);
}

// ── FUTURES ────────────────────────────────────────────────────────────────────
function buildFutQuery() {
  const p = new URLSearchParams({ sort_by: fut.sortCol, order: fut.sortOrder, limit: 600 });
  const s     = document.getElementById('f-search').value.trim();
  const q     = document.getElementById('f-quote').value;
  const exTop = document.getElementById('f-exclude-top').value;
  const min5  = document.getElementById('f-min-5m').value;
  const max5  = document.getElementById('f-max-5m').value;
  const min15 = document.getElementById('f-min-15m').value;
  const max15 = document.getElementById('f-max-15m').value;
  const spike = document.getElementById('f-vol-spike').value;
  const minC  = document.getElementById('f-min-change').value;
  const maxC  = document.getElementById('f-max-change').value;

  if (s)     p.set('search', s);
  if (q)     p.set('quote', q);
  if (exTop) p.set('exclude_top', exTop);
  if (min5)  p.set('min_change_5m', min5);
  if (max5)  p.set('max_change_5m', max5);
  if (min15) p.set('min_change_15m', min15);
  if (max15) p.set('max_change_15m', max15);
  if (spike) p.set('min_vol_spike', spike);
  if (minC)  p.set('min_change', minC);
  if (maxC)  p.set('max_change', maxC);

  return '/api/futures?' + p;
}

async function loadFutures() {
  const tbody = document.getElementById('futures-body');
  try {
    const res = await fetch(buildFutQuery());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    document.getElementById('last-updated').textContent = 'Обновлено: ' + fmt.date(data.last_updated);
    document.getElementById('f-stats-bar').textContent  = `Показано: ${data.futures.length} из ${data.total}`;

    // client-side favourites filter
    const list = activeQuick === 'fav'
      ? data.futures.filter(f => favorites.has(f.symbol))
      : data.futures;

    if (!list.length) {
      const msg = activeQuick === 'fav' ? 'Нет избранных монет — нажмите ★ в таблице' : 'Нет данных по фильтру';
      tbody.innerHTML = `<tr><td colspan="26" class="loading">${msg}</td></tr>`;
      _stopFuturesPriceWs();
      return;
    }

    tbody.innerHTML = list.map((f, i) => {
      const isPump = f.change_15m != null && f.change_15m > 1 && f.vol_spike != null && f.vol_spike >= 2;
      const isDump = f.change_15m != null && f.change_15m < -1 && f.vol_spike != null && f.vol_spike >= 2;
      const isFav  = favorites.has(f.symbol);
      const rowCls = [isPump ? 'row-pump' : isDump ? 'row-dump' : isFav ? 'row-fav' : '', 'clickable'].join(' ').trim();
      return `
      <tr class="${rowCls}" data-symbol="${esc(f.symbol)}" onmouseenter="prefetchKlines('${esc(f.symbol)}')" onclick="openChart(${JSON.stringify(f).replace(/"/g, '&quot;')})">
        <td><button class="fav-btn${isFav ? ' active' : ''}" data-sym="${esc(f.symbol)}" onclick="toggleFavorite('${esc(f.symbol)}',event)">★</button></td>
        <td><button class="alert-btn${alertsCache[f.symbol]?.some(a=>a.active) ? ' has-alert' : ''}" data-sym="${esc(f.symbol)}" onclick="openAlertModal('${esc(f.symbol)}',event)">🔔</button></td>
        <td class="muted">${i + 1}</td>
        <td><div>
          <div class="coin-name">${esc(f.symbol)}</div>
          <div class="coin-symbol">${esc(f.base_asset)}${f.cg_rank ? ' · #' + f.cg_rank : ''}</div>
        </div></td>
        <td class="right num" data-f-price="${esc(f.symbol)}" data-price="${Number(f.last_price || 0)}">${fmt.price(f.last_price)}</td>
        <td class="right num">${fmt.pct(f.change_5m,  true)}</td>
        <td class="right num">${fmt.pct(f.change_15m, true)}</td>
        <td class="right num">${fmt.pct(f.change_30m)}</td>
        <td class="right num">${fmt.pct(f.change_1h)}</td>
        <td class="right num">${fmt.pct(f.price_change_pct)}</td>
        <td class="right num">${fmt.spike(f.vol_spike)}</td>
        <td class="right num">${fmt.large(f.quote_volume_24h)}</td>
        <td class="right num">${fmt.funding(f.funding_rate)}</td>
        <td class="right num">${fmt.ls(f.ls_account_ratio)}</td>
        <td class="right num">${fmt.ls(f.ls_taker_ratio)}</td>
        <td class="right num">${fmt.ls(f.ls_top_account)}</td>
        <td class="right num">${fmt.ls(f.ls_top_position)}</td>
        <td class="right num">${fmt.oi(f.oi_value)}</td>
        <td class="right num pos">${fmt.large(_longOI(f))}</td>
        <td class="right num neg">${fmt.large(_shortOI(f))}</td>
        <td class="right num">${fmt.pct(f.oi_change_5m)}</td>
        <td class="right num">${fmt.pct(f.oi_change_30m)}</td>
        <td class="right num">${fmt.pct(f.oi_change_1h)}</td>
        <td class="right num">${fmt.pct(f.oi_change_24h)}</td>
        <td class="right num">${fmt.cvd(f.cvd_1h)}</td>
        <td class="right num">${fmt.takerPct(f.taker_buy_pct)}</td>
      </tr>`;
    }).join('');
    _futuresPriceCells = _cachePriceCells(tbody, 'data-f-price');
    _startFuturesPriceWs([..._futuresPriceCells.keys()]);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="26" class="error">Ошибка: ${esc(e.message)}</td></tr>`;
    _stopFuturesPriceWs();
  }
}

function applyFFilters() {
  activeQuick = 'all'; // manual change clears quick preset
  _syncQuickButtons();
  _saveScreenerSettings();
  clearTimeout(filterTimer);
  filterTimer = setTimeout(loadFutures, 300);
}

// ── Manual refresh ─────────────────────────────────────────────────────────────
async function manualRefresh() {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning'); btn.textContent = '↻ ...';
  try {
    currentTab === 'spot' ? await loadCoins() : await loadFutures();
  } finally {
    btn.classList.remove('spinning'); btn.textContent = '↻ Обновить';
  }
}

// ── Sorting ────────────────────────────────────────────────────────────────────
function setupSort(selector, state, loader) {
  document.querySelectorAll(selector).forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (!col) return;
      if (state.sortCol === col) state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
      else { state.sortCol = col; state.sortOrder = 'desc'; }
      _syncSortHeaders(selector, state);
      _saveScreenerSettings();
      loader();
    });
  });
}

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  _restoreScreenerSettings();
  setupSort('th.sortable',   spot, loadCoins);
  setupSort('th.f-sortable', fut,  loadFutures);
  _syncSortHeaders('th.sortable', spot);
  _syncSortHeaders('th.f-sortable', fut);
  _updateOiModeButton();
  _updateCvdModeButton();
  _updateChartScaleButtons();
  _syncChartTfButtons();
  _syncIndicatorButtons();
  _syncOrderbookSettingsControls();

  switchTab(currentTab);
  setInterval(() => { if (currentTab === 'spot')    loadCoins();   }, 60_000);
  setInterval(() => { if (currentTab === 'futures') loadFutures(); }, 5_000);
});
