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
const CHART_RIGHT_OFFSET = 5;

// Indicator charts
let oiChart  = null, oiSeries  = null;
let cvdChart = null, cvdSeries = null;
let lsChart  = null, lsLongSeries = null, lsShortSeries = null;
let liqChart = null, liqLongSeries = null, liqShortSeries = null;

// Sequence counter: incremented on every loadKlines() call.
// Async handlers capture their seq at start and bail if it changed.
let _loadSeq = 0;

// Prevents re-entrant crosshair sync when setCrosshairPosition fires move events
let _crosshairBusy = false;

// Indicator data caches for crosshair value lookup
let _oiData  = [];
let _lsData  = [];
let _cvdData = [];
let _liqData = [];  // [{time, long_usd, short_usd}] — 1m buckets
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

function _syncIndicatorRanges() {
  if (!chart) return;
  const range = chart.timeScale().getVisibleLogicalRange();
  if (!range) return;
  _setIndicatorLogicalRange(range);
}

function _setIndicatorLogicalRange(range) {
  [oiChart, cvdChart, lsChart, liqChart].forEach(c => {
    try { if (c) c.timeScale().setVisibleLogicalRange(range); } catch (_) {}
  });
}

function _setAllLogicalRange(range) {
  try { if (chart) chart.timeScale().setVisibleLogicalRange(range); } catch (_) {}
  _setIndicatorLogicalRange(range);
}

function _clearIndicatorData() {
  _oiStartTime = null;
  _lsStartTime = null;
  _oiData = [];
  _lsData = [];
  _cvdData = [];
  _liqData = [];
  try { if (oiSeries) oiSeries.setData([]); } catch (_) {}
  try { if (cvdSeries) cvdSeries.setData([]); } catch (_) {}
  try { if (lsLongSeries) lsLongSeries.setData([]); } catch (_) {}
  try { if (lsShortSeries) lsShortSeries.setData([]); } catch (_) {}
  try { if (liqLongSeries) liqLongSeries.setData([]); } catch (_) {}
  try { if (liqShortSeries) liqShortSeries.setData([]); } catch (_) {}
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

const activeInds = new Set(['oi', 'cvd', 'ls', 'liq']);

// ── Shared crosshair sync helpers ──────────────────────────────────────────────
// Called from subscribeCrosshairMove of ANY chart (main or indicator).
// sourceChart is excluded from setCrosshairPosition to avoid self-calls.
function _syncCrosshairAt(time, sourceChart) {
  if (_crosshairBusy) return;
  _crosshairBusy = true;
  try {
    // Time label
    const timeLabel = document.getElementById('chart-time-label');
    if (timeLabel) {
      const d = new Date(time * 1000);
      timeLabel.textContent = d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
      timeLabel.classList.add('visible');
    }

    // OHLCV legend from klineData lookup
    const k = _findByTime(_klineData, time);
    if (k) _updateLegend(k.open, k.high, k.low, k.close, _klineVolume(k));

    // Main chart
    if (sourceChart !== chart && chart && candleSeries && k) {
      chart.setCrosshairPosition(k.close, time, candleSeries);
    }

    // OI panel
    if (oiSeries && _oiData.length) {
      const od = _findByTime(_oiData, time);
      if (od) {
        const lbl = document.querySelector('#oi-panel .ind-label');
        if (lbl) lbl.textContent = `OI   ${fmt.large(od.value)}`;
        if (sourceChart !== oiChart) oiChart.setCrosshairPosition(od.value, time, oiSeries);
      }
    }

    // CVD panel
    if (cvdSeries && _cvdData.length) {
      const cd = _findByTime(_cvdData, time);
      if (cd) {
        const sign = cd.value >= 0 ? '+' : '';
        const lbl = document.querySelector('#cvd-panel .ind-label');
        if (lbl) lbl.textContent = `CVD   ${sign}${fmt.large(Math.abs(cd.value))}`;
        if (sourceChart !== cvdChart) cvdChart.setCrosshairPosition(cd.value, time, cvdSeries);
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

  const timeLabel = document.getElementById('chart-time-label');
  if (timeLabel) timeLabel.classList.remove('visible');

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
  if (oiLbl)  oiLbl.textContent  = 'OI $';
  if (cvdLbl) cvdLbl.textContent = 'CVD';
  if (lsLbl)  lsLbl.textContent  = 'L/S %';
  if (liqLbl) liqLbl.textContent = 'Ликв $';
}

// Attach bidirectional crosshair sync to an indicator chart instance
function _attachIndSync(indChart) {
  indChart.subscribeCrosshairMove(param => {
    if (param.time) _syncCrosshairAt(param.time, indChart);
    else _syncCrosshairLeave();
  });
}

// ── Chart open / close ─────────────────────────────────────────────────────────
function openChart(future) {
  chartFuture = future;
  chartSymbol = future.symbol;
  _klineData  = [];
  _oiData = []; _lsData = []; _cvdData = [];

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
  document.getElementById('chart-modal').classList.remove('open');
  document.body.style.overflow = '';
  destroyChart();
  destroyIndicators();
}

function handleModalClick(e) {
  if (e.target === document.getElementById('chart-modal')) closeChart();
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeChart(); });

// ── Main chart init / destroy ──────────────────────────────────────────────────
function initChart() {
  const container = document.getElementById('chart-container');
  chart = LightweightCharts.createChart(container, {
    layout: {
      background: { type: 'solid', color: '#161b22' },
      textColor: '#7d8590',
    },
    grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
    crosshair: {
      mode: 1,
      vertLine: { width: 1, color: '#5d6672', style: 0, labelBackgroundColor: '#2d333b' },
      horzLine: { width: 1, color: '#5d6672', style: 0, labelBackgroundColor: '#2d333b' },
    },
    rightPriceScale: { borderColor: '#30363d' },
    timeScale: { borderColor: '#30363d', timeVisible: true, secondsVisible: false, rightOffset: CHART_RIGHT_OFFSET },
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
    if (param.time) _syncCrosshairAt(param.time, chart);
    else _syncCrosshairLeave();
  });

  chart.timeScale().subscribeVisibleLogicalRangeChange(_syncIndicatorRanges);

  const ro = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    if (chart && width > 0 && height > 0) try { chart.resize(width, height); } catch (_) {}
  });
  ro.observe(container);
  chart._ro = ro;
}

function destroyChart() {
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
    layout: { background: { type: 'solid', color: '#161b22' }, textColor: '#7d8590' },
    grid:   { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
    crosshair:       { mode: 1 },
    rightPriceScale: { borderColor: '#30363d' },
    timeScale: { visible: false, rightOffset: CHART_RIGHT_OFFSET },
    handleScroll: false,
    handleScale:  false,
  });
  const ro = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    if (width > 0 && height > 0) try { c.resize(width, height); } catch (_) {}
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
    oiSeries = oiChart.addAreaSeries({
      lineColor: '#388bfd', topColor: 'rgba(56,139,253,0.25)', bottomColor: 'rgba(56,139,253,0)',
      lineWidth: 1, lastValueVisible: true, priceLineVisible: false,
      priceFormat: { type: 'volume' },
    });
    _attachIndSync(oiChart);
  } else {
    document.getElementById('oi-panel').style.display = 'none';
  }

  // CVD
  if (activeInds.has('cvd')) {
    document.getElementById('cvd-panel').style.display = '';
    cvdChart  = _makeIndChart('cvd-panel');
    cvdSeries = cvdChart.addLineSeries({
      color: '#f0b429', lineWidth: 1,
      lastValueVisible: true, priceLineVisible: false,
      priceFormat: { type: 'volume' },
    });
    _attachIndSync(cvdChart);
  } else {
    document.getElementById('cvd-panel').style.display = 'none';
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
      color: '#3fb950', base: 0,
      lastValueVisible: false, priceLineVisible: false,
      priceFormat: { type: 'volume' },
    });
    liqLongSeries  = liqChart.addHistogramSeries({
      color: '#f85149', base: 0,
      lastValueVisible: false, priceLineVisible: false,
      priceFormat: { type: 'volume' },
    });
    _attachIndSync(liqChart);
  } else {
    document.getElementById('liq-panel').style.display = 'none';
  }
}

function _destroyIndChart(c) {
  if (!c) return;
  if (c._ro) c._ro.disconnect();
  c.remove();
}

function destroyIndicators() {
  _destroyIndChart(oiChart);  oiChart  = oiSeries  = null;
  _destroyIndChart(cvdChart); cvdChart = cvdSeries = null;
  _destroyIndChart(lsChart);  lsChart  = lsLongSeries = lsShortSeries = null;
  _destroyIndChart(liqChart); liqChart = liqLongSeries = liqShortSeries = null;
}

// ── Toggle indicator on/off ────────────────────────────────────────────────────
function toggleInd(name) {
  const btn = document.querySelector(`.ind-btn[data-ind="${name}"]`);
  if (activeInds.has(name)) {
    activeInds.delete(name);
    btn.classList.remove('active');
    if (name === 'oi'  && oiChart)  { _destroyIndChart(oiChart);  oiChart  = oiSeries  = null; }
    if (name === 'cvd' && cvdChart) { _destroyIndChart(cvdChart); cvdChart = cvdSeries = null; }
    if (name === 'ls'  && lsChart)  { _destroyIndChart(lsChart);  lsChart  = lsLongSeries = lsShortSeries = null; }
    if (name === 'liq' && liqChart) { _destroyIndChart(liqChart); liqChart = liqLongSeries = liqShortSeries = null; }
    document.getElementById(name + '-panel').style.display = 'none';
  } else {
    activeInds.add(name);
    btn.classList.add('active');
    document.getElementById(name + '-panel').style.display = '';
    // need indicator charts to exist; recreate only the toggled one
    if (name === 'oi') {
      oiChart  = _makeIndChart('oi-panel');
      oiSeries = oiChart.addAreaSeries({
        lineColor: '#388bfd', topColor: 'rgba(56,139,253,0.25)', bottomColor: 'rgba(56,139,253,0)',
        lineWidth: 1, lastValueVisible: true, priceLineVisible: false,
        priceFormat: { type: 'volume' },
      });
      _attachIndSync(oiChart);
      loadOI();
    } else if (name === 'cvd') {
      cvdChart  = _makeIndChart('cvd-panel');
      cvdSeries = cvdChart.addLineSeries({
        color: '#f0b429', lineWidth: 1,
        lastValueVisible: true, priceLineVisible: false,
        priceFormat: { type: 'volume' },
      });
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
        color: '#3fb950', base: 0,
        lastValueVisible: false, priceLineVisible: false,
        priceFormat: { type: 'volume' },
      });
      liqLongSeries  = liqChart.addHistogramSeries({
        color: '#f85149', base: 0,
        lastValueVisible: false, priceLineVisible: false,
        priceFormat: { type: 'volume' },
      });
      _attachIndSync(liqChart);
      loadLiqs();
    }
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
  _clearIndicatorData();

  // Start all 3 fetches simultaneously
  const key = chartSymbol + '_' + chartTf;
  const klineFetch = _prefetch[key] || fetch(`/api/futures/${chartSymbol}/klines?interval=${chartTf}&limit=400`);
  delete _prefetch[key];
  const oiFetch = activeInds.has('oi') ? fetch(`/api/futures/${chartSymbol}/oi?interval=${chartTf}&limit=500`) : null;
  const lsFetch = activeInds.has('ls') ? fetch(`/api/futures/${chartSymbol}/ls-ratio?interval=${chartTf}&limit=500`) : null;

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

    candleSeries.setData(_klineData.map(k => ({
      time: k.time, open: k.open, high: k.high, low: k.low, close: k.close,
    })));
    volSeries.setData(_klineData.map(k => ({
      time: k.time, value: _klineVolume(k),
      color: k.close >= k.open ? '#3fb95055' : '#f8514955',
    })));
    chart.timeScale().fitContent();
    requestAnimationFrame(_syncIndicatorRanges);

    // CVD is synchronous (computed from klines)
    if (activeInds.has('cvd')) loadCVD();

    // Liquidations: independent fetch, no need to wait for klines-aligned data
    if (activeInds.has('liq')) loadLiqs();

    // OI and LS fetches already in flight — just await their responses
    await Promise.all([
      oiFetch ? _applyOI(oiFetch, seq)  : Promise.resolve(),
      lsFetch ? _applyLS(lsFetch, seq)  : Promise.resolve(),
    ]);
    if (seq === _loadSeq) {
      _fitCommonRange();
      loader.style.display = 'none';
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

// ── OI ─────────────────────────────────────────────────────────────────────────
async function loadOI() {
  const seq    = _loadSeq;
  const fetch$ = fetch(`/api/futures/${chartSymbol}/oi?interval=${chartTf}&limit=500`);
  await _applyOI(fetch$, seq);
}

async function _applyOI(fetch$, seq) {
  if (!oiSeries || !_klineData.length) return;
  _oiStartTime = null;
  try {
    const res = await fetch$;
    if (!res.ok || seq !== _loadSeq) return;
    const data = await res.json();
    if (!data.length || !oiSeries || seq !== _loadSeq) return;
    _oiStartTime = data[0].time;
    _oiData = data.map(d => ({ time: d.time, value: d.value }));
    oiSeries.setData(_alignToKlines(data, d => ({ time: d.time, value: d.value })));
    _syncIndicatorRanges();
  } catch (e) { console.warn('OI error:', e); }
}

// ── CVD ────────────────────────────────────────────────────────────────────────
function loadCVD() {
  if (!cvdSeries || !_klineData.length) return;
  let cum = 0;
  const data = _klineData.map(k => {
    cum += (k.delta || 0);
    return { time: k.time, value: Math.round(cum) };
  });
  _cvdData = data;
  cvdSeries.setData(data);
  _syncIndicatorRanges();
}

// ── L/S ────────────────────────────────────────────────────────────────────────
async function loadLS() {
  const seq    = _loadSeq;
  const fetch$ = fetch(`/api/futures/${chartSymbol}/ls-ratio?interval=${chartTf}&limit=500`);
  await _applyLS(fetch$, seq);
}

async function _applyLS(fetch$, seq) {
  if (!lsLongSeries || !_klineData.length) return;
  _lsStartTime = null;
  try {
    const res = await fetch$;
    if (!res.ok || seq !== _loadSeq) return;
    const data = await res.json();
    if (!data.length || !lsLongSeries || seq !== _loadSeq) return;
    _lsStartTime = data[0].time;
    _lsData = data.map(d => ({ time: d.time, long_pct: d.long_pct, short_pct: d.short_pct }));
    lsLongSeries.setData( _alignToKlines(data, d => ({ time: d.time, value: d.long_pct  })));
    lsShortSeries.setData(_alignToKlines(data, d => ({ time: d.time, value: d.short_pct })));
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
  if (!liqLongSeries) return;
  try {
    const res = await fetch(`/api/futures/${chartSymbol}/liquidations?limit=10000`);
    if (!res.ok || seq !== _loadSeq || !liqLongSeries) return;
    const data = await res.json();
    if (seq !== _loadSeq || !liqLongSeries) return;
    _liqData = _alignLiqsToKlines(data);
    // shorts liquidated → green bars (positive); longs liquidated → red bars (negative)
    liqShortSeries.setData(_liqData.map(d => ({ time: d.time, value:  d.short_usd })));
    liqLongSeries.setData( _liqData.map(d => ({ time: d.time, value: -d.long_usd  })));
    _syncIndicatorRanges();
  } catch (e) { console.warn('Liq error:', e); }
}

function setTf(tf) {
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
    const url = currentTab === 'spot' ? '/api/refresh' : '/api/futures/refresh';
    await fetch(url, { method: 'POST' });
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

  // mark default "Все" button
  document.getElementById('qb-all').classList.add('active-all');

  loadCoins();
  setInterval(() => { if (currentTab === 'spot')    loadCoins();   }, 60_000);
  setInterval(() => { if (currentTab === 'futures') loadFutures(); }, 15_000);
});
