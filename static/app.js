// ── State ──────────────────────────────────────────────────────────────────────
let currentTab  = 'spot';
let activeQuick = 'all';
let lsMethod    = 'top_pos'; // 'global' | 'top_pos' | 'top_acc'

function setLsMethod(method) {
  lsMethod = method;
  document.querySelectorAll('.ls-method-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.method === method)
  );
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
let chartTf      = '15m';
let chartFuture  = null;
let _klineData   = [];

// ── Real-time WebSocket ────────────────────────────────────────────────────────
let _rtWs        = null;
let _rtSymbol    = null;
let _rtTf        = null;
const CHART_RIGHT_OFFSET = 5;
const CHART_TEXT_COLOR = '#aeb8c4';
const CHART_BORDER_COLOR = '#4a5568';
const LIQ_LONG_COLOR = '#f59e0b';
const LIQ_SHORT_COLOR = '#38bdf8';
const LIQUIDITY_BUY_COLOR = '#d29922';
const LIQUIDITY_SELL_COLOR = '#38bdf8';
const LIQUIDITY_ZONES_PER_SIDE = 3;
let liquidityZoneLines = [];
let liquidityZones = [];
let _liqZoneOverlayRaf = null;

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
let lsChart  = null, lsLongSeries = null, lsShortSeries = null;
let liqChart = null, liqLongSeries = null, liqShortSeries = null;

// Sequence counter: incremented on every loadKlines() call.
// Async handlers capture their seq at start and bail if it changed.
let _loadSeq = 0;

// Prevents re-entrant crosshair sync when setCrosshairPosition fires move events
let _crosshairBusy = false;
let _hoverMarkerLocked = false;
let _hoverMarkerTime = null;
let _hoverMarkerPrice = null;

// Indicator data caches for crosshair value lookup
let _oiData  = [];
let _oiHistData = [];
let _oiCandleData = [];
let _oiHistScale = 0.05;
let _lsData  = [];
let _cvdData = [];
let _cvdLineData = [];
let _cvdCandleData = [];
let _liqData = [];  // [{time, long_usd, short_usd}] — 1m buckets
let _flowData = [];
let _flowVisibleData = [];
let _oiStartTime = null;
let _lsStartTime = null;

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

const _HOVER_MARKER_KEYS = ['price', 'oi', 'cvd', 'ls', 'liq'];

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
  chip.textContent = text;
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
    const labelLeft = Math.max(58, Math.min(innerRect.width - 58, left));
    timeLabel.textContent = _formatHoverMarkerTime(time);
    timeLabel.style.left = `${labelLeft}px`;
    timeLabel.style.top = `${axisRect.top - innerRect.top + 5}px`;
  }

  const lockLabel = root.querySelector('.chart-hover-lock');
  if (lockLabel) {
    lockLabel.style.left = `${Math.min(left + 8, innerRect.width - 58)}px`;
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
}

function _refreshHoverMarker() {
  const root = _hoverMarkerEl();
  if (root?.classList.contains('visible') && _hoverMarkerTime != null) {
    _renderHoverMarker(_hoverMarkerTime, _hoverMarkerPrice);
  }
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
  _scheduleVP();
  if (activeInds.has('flow')) _renderFlowPanel(_hoverMarkerTime);
  _refreshHoverMarker();
}

function _setIndicatorLogicalRange(range) {
  [oiChart, cvdChart, lsChart, liqChart].forEach(c => {
    try { if (c) c.timeScale().setVisibleLogicalRange(range); } catch (_) {}
  });
}

function _setAllLogicalRange(range) {
  try { if (chart) chart.timeScale().setVisibleLogicalRange(range); } catch (_) {}
  _setIndicatorLogicalRange(range);
  _renderTimeAxis();
  _scheduleLiquidityZoneOverlay();
  if (activeInds.has('flow')) _renderFlowPanel(_hoverMarkerTime);
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

  [oiChart, cvdChart, lsChart, liqChart].forEach(c => {
    try { if (c) c.timeScale().applyOptions(timeOptions); } catch (_) {}
  });
  _renderTimeAxis();
  if (activeInds.has('flow')) _renderFlowPanel(_hoverMarkerTime);
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
  _lsData = [];
  _cvdData = [];
  _cvdLineData = [];
  _cvdCandleData = [];
  _liqData = [];
  _flowData = [];
  _flowVisibleData = [];
  try { if (oiHistSeries) oiHistSeries.setData([]); } catch (_) {}
  try { if (oiCandleSeries) oiCandleSeries.setData([]); } catch (_) {}
  try { if (cvdLineSeries) cvdLineSeries.setData([]); } catch (_) {}
  try { if (cvdCandleSeries) cvdCandleSeries.setData([]); } catch (_) {}
  try { if (lsLongSeries) lsLongSeries.setData([]); } catch (_) {}
  try { if (lsShortSeries) lsShortSeries.setData([]); } catch (_) {}
  try { if (liqLongSeries) liqLongSeries.setData([]); } catch (_) {}
  try { if (liqShortSeries) liqShortSeries.setData([]); } catch (_) {}
  _clearFlowPanel();
}

function _updateLegend(open, high, low, close, vol) {
  const el = document.getElementById('chart-legend');
  if (!el) return;
  const chgPct  = open ? ((close - open) / open * 100) : 0;
  const chgCls  = chgPct > 0 ? 'pos' : chgPct < 0 ? 'neg' : '';
  const closeCls = close >= open ? 'pos' : 'neg';
  el.innerHTML =
    `<span class="leg-lbl">O</span> <span class="leg-val">${fmt.price(open)}</span>` +
    `<span class="leg-lbl">H</span> <span class="pos">${fmt.price(high)}</span>` +
    `<span class="leg-lbl">L</span> <span class="neg">${fmt.price(low)}</span>` +
    `<span class="leg-lbl">C</span> <span class="${closeCls}">${fmt.price(close)}</span>` +
    `<span class="${chgCls}">${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%</span>` +
    `<span class="leg-lbl">Vol</span> <span class="leg-val">${fmt.large(vol)}</span>`;
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
  try {
    const range = chart?.timeScale().getVisibleLogicalRange();
    if (range && range.to > range.from) {
      const fromIdx = Math.max(0, Math.ceil(range.from));
      const toIdx = Math.min(_flowData.length - 1, Math.floor(range.to));
      if (toIdx >= fromIdx) visible = _flowData.slice(fromIdx, toIdx + 1);
    }
  } catch (_) {}
  _flowVisibleData = visible;
  const selected = selectedTime != null ? _findByTime(visible, selectedTime) : visible[visible.length - 1];
  const selectedBarTime = selected?.time;
  track.innerHTML = visible.map(d => (
    `<span class="flow-seg${d.time === selectedBarTime ? ' selected' : ''}" ` +
      `data-time="${d.time}" title="${d.title} · ${d.desc}" style="background:${d.color}"></span>`
  )).join('');
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
    const idx = Math.max(0, Math.min(data.length - 1, Math.round(pct * (data.length - 1))));
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
    if (isHigh) levels.push({ kind: 'buy', price: k.high, index: i });
    if (isLow) levels.push({ kind: 'sell', price: k.low, index: i });
  }
  return levels;
}

function _clusterLiquidityLevels(levels, tolerance, totalBars) {
  const clusters = [];
  const sorted = [...levels].sort((a, b) => a.price - b.price);

  for (const level of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(level.price - last.price) <= tolerance) {
      last.touches += 1;
      last.totalPrice += level.price;
      last.price = last.totalPrice / last.touches;
      last.lastIndex = Math.max(last.lastIndex, level.index);
      last.min = Math.min(last.min, level.price);
      last.max = Math.max(last.max, level.price);
    } else {
      clusters.push({
        kind: level.kind,
        price: level.price,
        totalPrice: level.price,
        touches: 1,
        lastIndex: level.index,
        min: level.price,
        max: level.price,
      });
    }
  }

  return clusters.map(c => {
    const recency = c.lastIndex / Math.max(1, totalBars - 1);
    const width = Math.max(tolerance * 0.5, (c.max - c.min) / 2);
    return {
      kind: c.kind,
      price: c.price,
      width,
      touches: c.touches,
      score: c.touches * 10 + recency * 2,
    };
  });
}

function _selectLiquidityZones(clusters, currentPrice, kind, tolerance) {
  const side = clusters.filter(z => kind === 'buy' ? z.price > currentPrice : z.price < currentPrice);
  const repeated = side.filter(z => z.touches > 1);
  const pool = repeated.length >= 2 ? repeated : side;
  const selected = [];
  const minGap = tolerance * 1.6;
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
  const span = 3;
  const fromIdx = Math.max(0, _klineData.length - 300);
  const tolerance = _liquidityZoneTolerance(_klineData);
  const levels = _collectSwingLevels(_klineData, span, fromIdx);
  const currentPrice = _klineData[_klineData.length - 1].close;
  const highClusters = _clusterLiquidityLevels(levels.filter(l => l.kind === 'buy'), tolerance, _klineData.length);
  const lowClusters = _clusterLiquidityLevels(levels.filter(l => l.kind === 'sell'), tolerance, _klineData.length);
  const buyZones = _selectLiquidityZones(highClusters, currentPrice, 'buy', tolerance);
  const sellZones = _selectLiquidityZones(lowClusters, currentPrice, 'sell', tolerance);

  return [...buyZones, ...sellZones].map(z => ({
    ...z,
    color: z.kind === 'buy' ? LIQUIDITY_BUY_COLOR : LIQUIDITY_SELL_COLOR,
    label: z.kind === 'buy' ? 'BSL' : 'SSL',
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
    title: z.label,
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
    bands.push(`<div class="liquidity-zone-band ${z.kind}" style="top:${top}px;height:${height}px"></div>`);
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

const activeInds = new Set(['oi', 'cvd', 'ls', 'liq', 'flow', 'zones', 'vp']);

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
    if (k) _updateLegend(k.open, k.high, k.low, k.close, _klineVolume(k));
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
    _updateLegend(last.open, last.high, last.low, last.close, _klineVolume(last));
  }

  // Clear crosshair on all charts
  try { if (chart)    chart.clearCrosshairPosition();    } catch (_) {}
  try { if (oiChart)  oiChart.clearCrosshairPosition();  } catch (_) {}
  try { if (cvdChart) cvdChart.clearCrosshairPosition(); } catch (_) {}
  try { if (lsChart)  lsChart.clearCrosshairPosition();  } catch (_) {}
  try { if (liqChart) liqChart.clearCrosshairPosition(); } catch (_) {}

  // Reset indicator labels
  const oiLbl  = document.querySelector('#oi-panel .ind-label');
  const cvdLbl = document.querySelector('#cvd-panel .ind-label');
  const lsLbl  = document.querySelector('#ls-panel .ind-label');
  const liqLbl = document.querySelector('#liq-panel .ind-label');
  if (oiLbl)  oiLbl.textContent  = _oiModeTitle();
  if (cvdLbl) cvdLbl.textContent = _cvdModeTitle();
  if (lsLbl)  lsLbl.textContent  = 'L/S %';
  if (liqLbl) liqLbl.textContent = 'Ликв $';
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
  chartFuture = future;
  chartSymbol = future.symbol;
  _klineData  = [];
  _oiData = []; _lsData = []; _cvdData = []; _cvdLineData = []; _cvdCandleData = []; _flowData = [];
  _hideHoverMarker(true);

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
  document.getElementById('chart-modal').classList.remove('open');
  document.body.style.overflow = '';
  destroyChart();
  destroyIndicators();
}

// ── Real-time WebSocket (Binance Futures stream) ───────────────────────────────
function _stopRtWs() {
  if (_rtWs) { try { _rtWs.close(); } catch (_) {} _rtWs = null; }
  _rtSymbol = null; _rtTf = null;
}

// Interval string → milliseconds for candle boundary detection
const _TF_MS = {
  '1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,
  '1h':3600000,'2h':7200000,'4h':14400000,'12h':43200000,
  '1d':86400000,'1w':604800000,
};

function _startRtWs(symbol, tf) {
  _stopRtWs();
  if (!symbol || !tf) return;
  _rtSymbol = symbol; _rtTf = tf;

  const sym  = symbol.toLowerCase();
  // kline stream + markPrice (1s tick for live price)
  const url  = `wss://fstream.binance.com/stream?streams=${sym}@kline_${tf}/${sym}@markPrice@1s`;
  let ws;
  try { ws = new WebSocket(url); } catch (_) { return; }
  _rtWs = ws;

  ws.onmessage = (ev) => {
    if (_rtSymbol !== symbol || _rtTf !== tf) { ws.close(); return; }
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }

    const data = msg.data || msg;
    const streamType = (msg.stream || '').split('@')[1] || data.e;

    // ── markPrice tick: update price header only ──────────────────────────────
    if (streamType === 'markPriceUpdate' || data.e === 'markPriceUpdate') {
      const mp = parseFloat(data.p || data.markPrice || 0);
      if (mp > 0 && _klineData.length) {
        const last = _klineData[_klineData.length - 1];
        // patch last candle close with mark price for visual continuity
        const updated = { ...last, close: mp,
          high: Math.max(last.high, mp), low: Math.min(last.low, mp) };
        _klineData[_klineData.length - 1] = updated;
        try { candleSeries.update({ time: updated.time, open: updated.open,
          high: updated.high, low: updated.low, close: updated.close }); } catch (_) {}
        // update header price
        const priceEl = document.getElementById('chart-price');
        if (priceEl) priceEl.textContent = fmt.price(mp);
      }
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
    let cvdDirty = false;

    if (candleTime === last.time) {
      // update current candle
      const updated = { ...last, high: h, low: l, close: c,
        volume: vol, quote_volume: qv, delta };
      _klineData[_klineData.length - 1] = updated;
      try { candleSeries.update({ time: candleTime, open: o, high: h, low: l, close: c }); } catch (_) {}
      try { volSeries.update({ time: candleTime, value: qv,
        color: c >= o ? '#3fb95055' : '#f8514955' }); } catch (_) {}
      cvdDirty = true;
    } else if (candleTime > last.time && k.x === false) {
      // new candle opened (x=false means not yet closed)
      const newBar = { time: candleTime, open: o, high: h, low: l, close: c,
        volume: vol, quote_volume: qv, delta };
      _klineData.push(newBar);
      try { candleSeries.update({ time: candleTime, open: o, high: h, low: l, close: c }); } catch (_) {}
      try { volSeries.update({ time: candleTime, value: qv,
        color: c >= o ? '#3fb95055' : '#f8514955' }); } catch (_) {}
      cvdDirty = true;
    }
    if (cvdDirty && activeInds.has('cvd')) loadCVD();
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    // reconnect after 3 s if still on same symbol/tf
    if (_rtSymbol === symbol && _rtTf === tf) {
      setTimeout(() => { if (_rtSymbol === symbol && _rtTf === tf) _startRtWs(symbol, tf); }, 3000);
    }
  };
}

function handleModalClick(e) {
  if (e.target === document.getElementById('chart-modal')) closeChart();
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
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
    rightPriceScale: { borderColor: '#30363d' },
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
  chart.timeScale().subscribeVisibleTimeRangeChange(() => _scheduleVP());
  chart.subscribeCrosshairMove(() => _scheduleVP());

  const ro = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    if (chart && width > 0 && height > 0) {
      try { chart.resize(width, height); } catch (_) {}
      _scheduleLiquidityZoneOverlay();
      _scheduleVP();
      _refreshHoverMarker();
    }
  });
  ro.observe(container);
  chart._ro = ro;
}

function destroyChart() {
  _clearLiquidityZones();
  _destroyVP();
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
  _destroyIndChart(lsChart);  lsChart  = lsLongSeries = lsShortSeries = null;
  _destroyIndChart(liqChart); liqChart = liqLongSeries = liqShortSeries = null;
}

// ── Toggle indicator on/off ────────────────────────────────────────────────────
function toggleInd(name) {
  const btn = document.querySelector(`.ind-btn[data-ind="${name}"]`);
  if (!btn) return;
  const panel = document.getElementById(name + '-panel');
  if (activeInds.has(name)) {
    activeInds.delete(name);
    btn.classList.remove('active');
    if (name === 'oi'  && oiChart)  { _destroyIndChart(oiChart);  oiChart = oiSeries = oiHistSeries = oiCandleSeries = null; }
    if (name === 'cvd' && cvdChart) { _destroyIndChart(cvdChart); cvdChart = cvdSeries = cvdLineSeries = cvdCandleSeries = null; }
    if (name === 'ls'  && lsChart)  { _destroyIndChart(lsChart);  lsChart  = lsLongSeries = lsShortSeries = null; }
    if (name === 'liq' && liqChart) { _destroyIndChart(liqChart); liqChart = liqLongSeries = liqShortSeries = null; }
    if (name === 'zones') _clearLiquidityZones();
    if (name === 'vp') _clearVolumeProfile();
    if (name === 'flow') _flowData = [];
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
    } else if (name === 'flow') {
      _attachFlowPanelEvents();
      _renderFlowPanel();
      if (!_oiData.length) loadOI();
      if (!_lsData.length) loadLS();
      if (!_liqData.length) loadLiqs();
    } else if (name === 'zones') {
      _renderLiquidityZones();
    } else if (name === 'vp') {
      _renderVolumeProfile();
    }
    _updateTimeScales();
    _syncIndicatorRanges();
  }
}

// ── Prefetch cache (populated on mouseenter) ───────────────────────────────────
const _prefetch = {}; // key: symbol_tf → fetch Promise

function prefetchKlines(symbol) {
  const key = symbol + '_' + chartTf;
  if (_prefetch[key]) return;
  _prefetch[key] = fetch(`/api/futures/${symbol}/klines?interval=${chartTf}&limit=400`);
  setTimeout(() => delete _prefetch[key], 12000);
}

// ── Klines ─────────────────────────────────────────────────────────────────────
async function loadKlines() {
  const seq = ++_loadSeq;
  const loader = document.getElementById('chart-loader');
  loader.style.display = 'flex';
  loader.textContent   = 'Загрузка...';
  _hideHoverMarker(true);
  _clearIndicatorData();
  _clearLiquidityZones();

  // Start all 3 fetches simultaneously
  const key = chartSymbol + '_' + chartTf;
  const klineFetch = _prefetch[key] || fetch(`/api/futures/${chartSymbol}/klines?interval=${chartTf}&limit=400`);
  delete _prefetch[key];
  const _oiTf  = _OI_INTERVAL[chartTf] || '5m';
  const needFlowData = activeInds.has('flow');
  const oiFetch = (activeInds.has('oi') || needFlowData) ? fetch(`/api/futures/${chartSymbol}/oi?interval=${_oiTf}&limit=500`) : null;
  const lsFetch = (activeInds.has('ls') || needFlowData) ? fetch(`/api/futures/${chartSymbol}/ls-ratio?interval=${chartTf}&limit=500`) : null;

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
    const _prec = _lastPrice >= 1000 ? 2 : _lastPrice >= 1 ? 4 : _lastPrice >= 0.1 ? 5 : _lastPrice >= 0.01 ? 6 : _lastPrice >= 0.001 ? 7 : 8;
    candleSeries.applyOptions({ priceFormat: { type: 'price', precision: _prec, minMove: Math.pow(10, -_prec) } });

    candleSeries.setData(_klineData.map(k => ({
      time: k.time, open: k.open, high: k.high, low: k.low, close: k.close,
    })));
    volSeries.setData(_klineData.map(k => ({
      time: k.time, value: _klineVolume(k),
      color: k.close >= k.open ? '#3fb95055' : '#f8514955',
    })));
    chart.timeScale().fitContent();
    _renderLiquidityZones();
    _renderVolumeProfile();
    if (activeInds.has('flow')) _renderFlowPanel();
    requestAnimationFrame(_syncIndicatorRanges);

    // CVD is synchronous (computed from klines)
    if (activeInds.has('cvd')) loadCVD();

    // Liquidations: independent fetch, no need to wait for klines-aligned data
    if (activeInds.has('liq') || activeInds.has('flow')) loadLiqs();

    // OI and LS fetches already in flight — just await their responses
    await Promise.all([
      oiFetch ? _applyOI(oiFetch, seq)  : Promise.resolve(),
      lsFetch ? _applyLS(lsFetch, seq)  : Promise.resolve(),
    ]);
    if (seq === _loadSeq) {
      _fitCommonRange();
      loader.style.display = 'none';
      _startRtWs(chartSymbol, chartTf);
    }
  } catch (e) {
    if (seq === _loadSeq) loader.textContent = 'Ошибка: ' + e.message;
    console.error('Chart error:', e);
  }
}

// Подстроить видимый диапазон под общие данные всех индикаторов
function _fitCommonRange() {
  if (!chart || !_klineData.length) return;
  // Берём наиболее позднее начало среди всех активных индикаторов
  let fromTime = _klineData[0].time;
  if (activeInds.has('oi') && _oiStartTime)  fromTime = Math.max(fromTime, _oiStartTime);
  if (activeInds.has('ls') && _lsStartTime)  fromTime = Math.max(fromTime, _lsStartTime);
  // CVD использует klines — не ограничивает диапазон
  const idx = _klineData.findIndex(k => k.time >= fromTime);
  const from = idx >= 0 ? idx : 0;
  _setAllLogicalRange({ from, to: _klineData.length - 1 + CHART_RIGHT_OFFSET });
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
  const fetch$ = fetch(`/api/futures/${chartSymbol}/oi?interval=${oiTf}&limit=500`);
  await _applyOI(fetch$, seq);
}

async function _applyOI(fetch$, seq) {
  if ((!oiChart && !activeInds.has('flow')) || !_klineData.length) return;
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
    try { if (oiHistSeries) oiHistSeries.applyOptions(_oiHistOptions()); } catch (_) {}
    _applyOiSeriesMode();
    if (activeInds.has('flow')) _renderFlowPanel(_hoverMarkerTime);
    _syncIndicatorRanges();
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
}

// ── L/S ────────────────────────────────────────────────────────────────────────
async function loadLS() {
  const seq    = _loadSeq;
  const fetch$ = fetch(`/api/futures/${chartSymbol}/ls-ratio?interval=${chartTf}&limit=500`);
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
  } catch (e) { console.warn('Liq error:', e); }
}

function setTf(tf) {
  _stopRtWs();
  _hideHoverMarker(true);
  chartTf = tf;
  document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
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
  price(v) {
    if (v == null) return '—';
    if (v >= 1000) return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1)    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return '$' + v.toPrecision(4);
  },
  pct(v, bold) {
    if (v == null) return '<span class="neutral">—</span>';
    const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'neutral';
    const w   = bold ? ' font-weight:600;' : '';
    return `<span class="${cls}" style="${w}">${v > 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
  },
  large(v) {
    if (v == null) return '—';
    if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9)  return '$' + (v / 1e9 ).toFixed(2) + 'B';
    if (v >= 1e6)  return '$' + (v / 1e6 ).toFixed(2) + 'M';
    if (v >= 1e3)  return '$' + (v / 1e3 ).toFixed(1) + 'K';
    return '$' + v.toFixed(2);
  },
  spike(v) {
    if (v == null) return '<span class="neutral">—</span>';
    const x    = v.toFixed(1) + '×';
    const cls  = v >= 10 ? 'spike-huge' : v >= 5 ? 'spike-high' : v >= 2 ? 'spike-mid' : 'spike-low';
    return `<span class="${cls}">${x}</span>`;
  },
  funding(v) {
    if (v == null) return '<span class="funding-zero">—</span>';
    const pct = (v * 100).toFixed(4);
    const cls = v > 0 ? 'funding-pos' : v < 0 ? 'funding-neg' : 'funding-zero';
    return `<span class="${cls}">${v > 0 ? '+' : ''}${pct}%</span>`;
  },
  date(v) {
    if (!v) return '—';
    return new Date(v + 'Z').toLocaleTimeString('ru-RU');
  },
  ls(v) {
    if (v == null) return '<span class="neutral">—</span>';
    const cls = v >= 1 ? 'pos' : 'neg';
    return `<span class="${cls}">${v.toFixed(2)}</span>`;
  },
  oi(v) {
    if (v == null) return '—';
    if (v >= 1e9)  return (v / 1e9).toFixed(2)  + 'B';
    if (v >= 1e6)  return (v / 1e6).toFixed(2)  + 'M';
    if (v >= 1e3)  return (v / 1e3).toFixed(1)  + 'K';
    return v.toFixed(0);
  },
  cvd(v) {
    if (v == null) return '<span class="neutral">—</span>';
    const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'neutral';
    const abs = Math.abs(v);
    let s = abs >= 1e9 ? (abs/1e9).toFixed(2)+'B' : abs >= 1e6 ? (abs/1e6).toFixed(2)+'M' : abs >= 1e3 ? (abs/1e3).toFixed(1)+'K' : abs.toFixed(0);
    return `<span class="${cls}">${v > 0 ? '+' : '-'}${s}</span>`;
  },
  takerPct(v) {
    if (v == null) return '<span class="neutral">—</span>';
    const cls = v > 52 ? 'pos' : v < 48 ? 'neg' : 'neutral';
    return `<span class="${cls}">${v.toFixed(1)}%</span>`;
  },
};

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      return;
    }

    tbody.innerHTML = data.coins.map(c => `
      <tr>
        <td class="muted">${c.rank}</td>
        <td><div class="coin-cell">
          ${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy"/>` : ''}
          <div><div class="coin-name">${esc(c.name)}</div><div class="coin-symbol">${esc(c.symbol)}</div></div>
        </div></td>
        <td class="right num">${fmt.price(c.price_usd)}</td>
        <td class="right num">${fmt.pct(c.change_1h)}</td>
        <td class="right num">${fmt.pct(c.change_24h)}</td>
        <td class="right num">${fmt.pct(c.change_7d)}</td>
        <td class="right num">${fmt.large(c.market_cap)}</td>
        <td class="right num">${fmt.large(c.volume_24h)}</td>
        <td class="right num">${fmt.pct(c.ath_change_pct)}</td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="9" class="error">Ошибка: ${esc(e.message)}</td></tr>`;
  }
}

function applyFilters() {
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
      return;
    }

    tbody.innerHTML = list.map((f, i) => {
      const isPump = f.change_15m != null && f.change_15m > 1 && f.vol_spike != null && f.vol_spike >= 2;
      const isDump = f.change_15m != null && f.change_15m < -1 && f.vol_spike != null && f.vol_spike >= 2;
      const isFav  = favorites.has(f.symbol);
      const rowCls = [isPump ? 'row-pump' : isDump ? 'row-dump' : isFav ? 'row-fav' : '', 'clickable'].join(' ').trim();
      return `
      <tr class="${rowCls}" onmouseenter="prefetchKlines('${esc(f.symbol)}')" onclick="openChart(${JSON.stringify(f).replace(/"/g, '&quot;')})">
        <td><button class="fav-btn${isFav ? ' active' : ''}" data-sym="${esc(f.symbol)}" onclick="toggleFavorite('${esc(f.symbol)}',event)">★</button></td>
        <td><button class="alert-btn${alertsCache[f.symbol]?.some(a=>a.active) ? ' has-alert' : ''}" data-sym="${esc(f.symbol)}" onclick="openAlertModal('${esc(f.symbol)}',event)">🔔</button></td>
        <td class="muted">${i + 1}</td>
        <td><div>
          <div class="coin-name">${esc(f.symbol)}</div>
          <div class="coin-symbol">${esc(f.base_asset)}${f.cg_rank ? ' · #' + f.cg_rank : ''}</div>
        </div></td>
        <td class="right num">${fmt.price(f.last_price)}</td>
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
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="26" class="error">Ошибка: ${esc(e.message)}</td></tr>`;
  }
}

function applyFFilters() {
  activeQuick = 'all'; // manual change clears quick preset
  document.querySelectorAll('.quick-btn').forEach(b => b.className = 'quick-btn');
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
      document.querySelectorAll(selector).forEach(t => t.classList.remove('active','asc','desc'));
      th.classList.add('active', state.sortOrder);
      loader();
    });
  });
}

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupSort('th.sortable',   spot, loadCoins);
  setupSort('th.f-sortable', fut,  loadFutures);
  _updateOiModeButton();
  _updateCvdModeButton();

  // mark default "Все" button
  document.getElementById('qb-all').classList.add('active-all');

  loadCoins();
  setInterval(() => { if (currentTab === 'spot')    loadCoins();   }, 60_000);
  setInterval(() => { if (currentTab === 'futures') loadFutures(); }, 15_000);
});
