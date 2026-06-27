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

// Indicator charts
let oiChart  = null, oiSeries  = null;
let cvdChart = null, cvdSeries = null;
let lsChart  = null, lsLongSeries = null, lsShortSeries = null;

const activeInds = new Set(['oi', 'cvd', 'ls']);

// ── Chart open / close ─────────────────────────────────────────────────────────
function openChart(future) {
  chartFuture = future;
  chartSymbol = future.symbol;
  _klineData  = [];

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
    crosshair:       { mode: 1 },
    rightPriceScale: { borderColor: '#30363d' },
    timeScale:       { borderColor: '#30363d', timeVisible: true, secondsVisible: false, visible: false, rightOffset: 3 },
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: '#3fb950', downColor: '#f85149',
    borderUpColor: '#3fb950', borderDownColor: '#f85149',
    wickUpColor:   '#3fb950', wickDownColor:   '#f85149',
  });

  volSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    lastValueVisible: false, priceLineVisible: false,
  });
  volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.5, bottom: 0 } });

  // Crosshair time label at top of chart
  const timeLabel = document.getElementById('chart-time-label');
  chart.subscribeCrosshairMove(param => {
    if (!timeLabel) return;
    if (param.time) {
      const d = new Date(param.time * 1000);
      const s = d.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      timeLabel.textContent = s;
      timeLabel.classList.add('visible');
    } else {
      timeLabel.classList.remove('visible');
    }
  });

  // Main chart drives all indicator chart timescales (by timestamp, not bar index)
  chart.timeScale().subscribeVisibleTimeRangeChange(range => {
    if (!range) return;
    if (oiChart)  oiChart.timeScale().setVisibleRange(range);
    if (cvdChart) cvdChart.timeScale().setVisibleRange(range);
    if (lsChart)  lsChart.timeScale().setVisibleRange(range);
  });

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
    timeScale: { visible: false, rightOffset: 3 },
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
  } else {
    document.getElementById('ls-panel').style.display = 'none';
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
      loadOI();
    } else if (name === 'cvd') {
      cvdChart  = _makeIndChart('cvd-panel');
      cvdSeries = cvdChart.addLineSeries({
        color: '#f0b429', lineWidth: 1,
        lastValueVisible: true, priceLineVisible: false,
        priceFormat: { type: 'volume' },
      });
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
      loadLS();
    }
    // sync current time range
    if (chart) {
      const range = chart.timeScale().getVisibleRange();
      if (range) {
        if (oiChart)  oiChart.timeScale().setVisibleRange(range);
        if (cvdChart) cvdChart.timeScale().setVisibleRange(range);
        if (lsChart)  lsChart.timeScale().setVisibleRange(range);
      }
    }
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
  const loader = document.getElementById('chart-loader');
  loader.style.display = 'flex';
  loader.textContent   = 'Загрузка...';

  // Start all 3 fetches simultaneously
  const key = chartSymbol + '_' + chartTf;
  const klineFetch = _prefetch[key] || fetch(`/api/futures/${chartSymbol}/klines?interval=${chartTf}&limit=400`);
  delete _prefetch[key];
  const oiFetch = activeInds.has('oi') ? fetch(`/api/futures/${chartSymbol}/oi?interval=${chartTf}&limit=500`) : null;
  const lsFetch = activeInds.has('ls') ? fetch(`/api/futures/${chartSymbol}/ls-ratio?interval=${chartTf}&limit=500`) : null;

  try {
    const res = await klineFetch;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.json();

    _klineData = [...raw]
      .sort((a, b) => a.time - b.time)
      .filter((k, i, arr) => i === 0 || k.time !== arr[i - 1].time);

    if (!_klineData.length) throw new Error('Нет данных');

    candleSeries.setData(_klineData.map(k => ({
      time: k.time, open: k.open, high: k.high, low: k.low, close: k.close,
    })));
    volSeries.setData(_klineData.map(k => ({
      time: k.time, value: k.volume,
      color: k.close >= k.open ? '#3fb95055' : '#f8514955',
    })));
    chart.timeScale().fitContent();
    loader.style.display = 'none';

    // CVD is synchronous (computed from klines)
    if (activeInds.has('cvd')) loadCVD();

    // OI and LS fetches already in flight — just await their responses
    await Promise.all([
      oiFetch ? _applyOI(oiFetch)  : Promise.resolve(),
      lsFetch ? _applyLS(lsFetch)  : Promise.resolve(),
    ]);
    _fitCommonRange();
  } catch (e) {
    loader.textContent = 'Ошибка: ' + e.message;
    console.error('Chart error:', e);
  }
}

// Синхронизировать один индикатор с основным графиком
function _syncToMain(indChart) {
  if (!chart || !indChart) return;
  const range = chart.timeScale().getVisibleRange();
  if (range) indChart.timeScale().setVisibleRange(range);
}

// Синхронизировать все индикаторы разом (по временным меткам)
function _syncAllInds() {
  if (!chart) return;
  const range = chart.timeScale().getVisibleRange();
  if (!range) return;
  if (oiChart)  oiChart.timeScale().setVisibleRange(range);
  if (cvdChart) cvdChart.timeScale().setVisibleRange(range);
  if (lsChart)  lsChart.timeScale().setVisibleRange(range);
}

// Подстроить видимый диапазон под общие данные всех индикаторов
let _oiStartTime = null;
let _lsStartTime = null;

function _fitCommonRange() {
  if (!chart || !_klineData.length) return;
  const klinesEnd = _klineData[_klineData.length - 1].time;
  // Берём наиболее позднее начало среди всех активных индикаторов
  let fromTime = _klineData[0].time;
  if (activeInds.has('oi') && _oiStartTime)  fromTime = Math.max(fromTime, _oiStartTime);
  if (activeInds.has('ls') && _lsStartTime)  fromTime = Math.max(fromTime, _lsStartTime);
  // CVD использует klines — не ограничивает диапазон
  chart.timeScale().setVisibleRange({ from: fromTime, to: klinesEnd });
  // подписка на timeRangeChange разошлёт диапазон всем индикаторам
}

// Binance OI/LS данные на 1 бар позади klines — дублируем последний бар
// чтобы временные оси совпадали по правому краю
function _padToKlines(data, mapFn) {
  const points = data.map(mapFn);
  if (points.length && _klineData.length) {
    const lastTime  = _klineData[_klineData.length - 1].time;
    const lastPoint = points[points.length - 1];
    if (lastPoint.time < lastTime) {
      // duplicate last value at current kline time
      const padded = { ...lastPoint, time: lastTime };
      points.push(padded);
    }
  }
  return points;
}

// ── OI ─────────────────────────────────────────────────────────────────────────
async function loadOI() {
  const fetch$ = fetch(`/api/futures/${chartSymbol}/oi?interval=${chartTf}&limit=500`);
  await _applyOI(fetch$);
}

async function _applyOI(fetch$) {
  if (!oiSeries || !_klineData.length) return;
  _oiStartTime = null;
  try {
    const res = await fetch$;
    if (!res.ok) return;
    const data = await res.json();
    if (!data.length || !oiSeries) return;
    _oiStartTime = data[0].time;
    oiSeries.setData(_padToKlines(data, d => ({ time: d.time, value: d.value })));
  } catch (e) { console.warn('OI error:', e); }
}

// ── CVD ────────────────────────────────────────────────────────────────────────
function loadCVD() {
  if (!cvdSeries || !_klineData.length) return;
  let cum = 0;
  const data = _klineData.map(k => {
    cum += (k.delta || 0);
    return { time: k.time, value: cum };
  });
  cvdSeries.setData(data);
}

// ── L/S ────────────────────────────────────────────────────────────────────────
async function loadLS() {
  const fetch$ = fetch(`/api/futures/${chartSymbol}/ls-ratio?interval=${chartTf}&limit=500`);
  await _applyLS(fetch$);
}

async function _applyLS(fetch$) {
  if (!lsLongSeries || !_klineData.length) return;
  _lsStartTime = null;
  try {
    const res = await fetch$;
    if (!res.ok) return;
    const data = await res.json();
    if (!data.length || !lsLongSeries) return;
    _lsStartTime = data[0].time;
    lsLongSeries.setData( _padToKlines(data, d => ({ time: d.time, value: d.long_pct  })));
    lsShortSeries.setData(_padToKlines(data, d => ({ time: d.time, value: d.short_pct })));
  } catch (e) { console.warn('L/S error:', e); }
}

function setTf(tf) {
  chartTf = tf;
  document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
  loadKlines();
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
      tbody.innerHTML = `<tr><td colspan="11" class="loading">${msg}</td></tr>`;
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
      </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="10" class="error">Ошибка: ${esc(e.message)}</td></tr>`;
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
