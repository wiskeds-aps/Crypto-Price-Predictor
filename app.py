import html
import os
from contextlib import contextmanager
import streamlit as st
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from datetime import datetime, timezone

from data import fetch_klines, fetch_market_screener, fetch_chart_indicators
from features import add_features
from liquidations import get_liquidation_status, liquidation_summary, start_liquidation_collector
from model import train_model, predict, is_trained, HORIZONS
from river_model import update_river_model, predict_river, get_river_stats, backtest_river
from paths import coin_log_path

try:
    import fcntl
except ImportError:
    fcntl = None

try:
    import msvcrt
except ImportError:
    msvcrt = None


@st.cache_data(ttl=60)
def _fetch(symbol: str, interval: str, limit: int) -> pd.DataFrame:
    return fetch_klines(symbol, interval, limit)


@st.cache_data(ttl=30)
def _market_screener() -> pd.DataFrame:
    return fetch_market_screener()


@st.cache_data(ttl=60)
def _chart_indicators(symbol: str, interval: str, limit: int) -> pd.DataFrame:
    return fetch_chart_indicators(symbol, interval, limit)


@st.cache_resource
def _start_liquidation_stream() -> dict:
    return start_liquidation_collector()


CHART_LIMITS = {
    "1h": 240,
    "24h": 720,
    "7d": 365,
}

HORIZON_LABELS = {
    "1h": "прогноз на 1 час - свечи 1 час",
    "24h": "прогноз на 24 часа - свечи 1 час",
    "7d": "прогноз на 7 дней - свечи 1 день",
}


@contextmanager
def locked_file(lock_path: str):
    lock_dir = os.path.dirname(lock_path)
    if lock_dir:
        os.makedirs(lock_dir, exist_ok=True)

    with open(lock_path, "a+") as lock_file:
        locked = False
        try:
            if fcntl is not None:
                fcntl.flock(lock_file, fcntl.LOCK_EX)
                locked = True
            elif msvcrt is not None:
                lock_file.seek(0)
                lock_file.write("0")
                lock_file.flush()
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
                locked = True
            yield
        finally:
            if locked and fcntl is not None:
                fcntl.flock(lock_file, fcntl.LOCK_UN)
            elif locked and msvcrt is not None:
                try:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass


def log_prediction(result: dict, model_type: str = "LightGBM") -> None:
    log_path = coin_log_path(result["symbol"])
    row = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "model": model_type,
        "symbol": result["symbol"],
        "horizon": result["horizon"],
        "current_price": round(result["current_price"], 10),
        "predicted_price": round(result["predicted_price"], 10),
        "predicted_return_pct": round(result["predicted_return_pct"], 4),
        "direction": result["direction"],
        "confidence": round(result["confidence"], 2),
    }
    df_row = pd.DataFrame([row])
    with locked_file(log_path + ".lock"):
        if not os.path.exists(log_path):
            df_row.to_csv(log_path, index=False)
        else:
            existing_cols = pd.read_csv(log_path, nrows=0).columns.tolist()
            if existing_cols != list(row.keys()):
                old = pd.read_csv(log_path)
                for col in df_row.columns:
                    if col not in old.columns:
                        default = "LightGBM" if col == "model" else pd.NA
                        old.insert(list(df_row.columns).index(col), col, default)
                old = old[df_row.columns]
                pd.concat([old, df_row], ignore_index=True).to_csv(log_path, index=False)
            else:
                df_row.to_csv(log_path, mode="a", header=False, index=False)


def symbol_label(symbol: str, quote_asset: str) -> str:
    return symbol.replace(quote_asset, f"/{quote_asset}") if symbol.endswith(quote_asset) else symbol


def format_market_price(value: float, quote_asset: str) -> str:
    if pd.isna(value):
        return "N/A"
    value = float(value)
    abs_value = abs(value)
    if abs_value >= 1_000:
        formatted = f"{value:,.2f}"
    elif abs_value >= 1:
        formatted = f"{value:,.4f}"
    elif abs_value >= 0.01:
        formatted = f"{value:,.6f}"
    elif abs_value >= 0.0001:
        formatted = f"{value:,.8f}"
    else:
        formatted = f"{value:,.10f}"

    if quote_asset in {"USDT", "USDC", "FDUSD", "BUSD", "TUSD", "USD"}:
        return f"${formatted}"
    return f"{formatted} {quote_asset}"


def format_millions(value) -> str:
    if pd.isna(value):
        return "N/A"
    return f"{float(value) / 1_000_000:,.1f}M"


def format_quote_amount(value, quote_asset: str = "USDT") -> str:
    if pd.isna(value):
        return "N/A"
    value = float(value)
    abs_value = abs(value)
    if abs_value >= 1_000_000_000:
        formatted = f"{value / 1_000_000_000:,.2f}B"
    elif abs_value >= 1_000_000:
        formatted = f"{value / 1_000_000:,.2f}M"
    elif abs_value >= 1_000:
        formatted = f"{value / 1_000:,.1f}K"
    elif abs_value >= 1:
        formatted = f"{value:,.2f}"
    else:
        formatted = f"{value:,.4f}"
    return f"{formatted} {quote_asset}"


def render_active_header(symbol: str, quote_asset: str, horizon: str, interval: str, bars_count: int) -> None:
    pair = html.escape(symbol_label(symbol, quote_asset))
    horizon_text = html.escape(HORIZON_LABELS.get(horizon, horizon))
    raw_symbol = html.escape(symbol)
    st.markdown(
        f"""
        <div translate="no" style="margin: 0 0 0.75rem 0;">
          <div style="font-size: 1.45rem; line-height: 1.25; font-weight: 700;">
            {pair} · {horizon_text}
          </div>
          <div style="font-size: 0.85rem; color: #9ca3af; margin-top: 0.25rem;">
            symbol: <code>{raw_symbol}</code> · candles: {bars_count} x {html.escape(interval)}
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def ensure_screener_columns(df: pd.DataFrame) -> pd.DataFrame:
    defaults = {
        "symbol": "",
        "base_asset": "",
        "quote_asset": "USDT",
        "last_price": pd.NA,
        "change_pct_24h": 0.0,
        "quote_volume_24h": 0.0,
        "base_volume_24h": 0.0,
        "trades_24h": 0,
        "onboard_date": pd.NA,
        "open_interest_quote": 0.0,
        "volatility_pct_24h": 0.0,
        "funding_rate_pct": 0.0,
        "liquidations_quote_24h": pd.NA,
    }
    df = df.copy()
    for col, default in defaults.items():
        if col not in df.columns:
            df[col] = default
    return df


def selected_event_rows(event) -> list[int]:
    selection = getattr(event, "selection", None)
    if isinstance(selection, dict):
        return selection.get("rows", [])
    return getattr(selection, "rows", [])


def apply_table_selection(event, symbols: list[str], source: str) -> None:
    selected_rows = selected_event_rows(event)
    if not selected_rows:
        return
    row_idx = selected_rows[0]
    if row_idx >= len(symbols):
        return
    selected = symbols[row_idx]
    if st.session_state.get("active_symbol") != selected:
        st.session_state["active_symbol"] = selected
        st.session_state["pending_symbol_widget"] = selected
        key = f"{source}_version"
        st.session_state[key] = st.session_state.get(key, 0) + 1
        st.rerun()


def sync_active_symbol_from_widget() -> None:
    selected = st.session_state.get("symbol_select_widget")
    if selected:
        st.session_state["active_symbol"] = selected


def build_chart(
    df: pd.DataFrame,
    df_feat: pd.DataFrame,
    chart_indicators: pd.DataFrame,
    title: str,
) -> go.Figure:
    fig = make_subplots(
        rows=6, cols=1,
        shared_xaxes=True,
        row_heights=[0.44, 0.12, 0.12, 0.12, 0.12, 0.08],
        subplot_titles=["Price + BB + EMA", "RSI", "Volume", "Open Interest", "CVD", "Liquidations"],
        vertical_spacing=0.05,
    )
    fig.add_trace(go.Candlestick(
        x=df.index, open=df["open"], high=df["high"],
        low=df["low"], close=df["close"], name="Price",
        increasing_line_color="#26a69a", decreasing_line_color="#ef5350",
    ), row=1, col=1)
    fig.add_trace(go.Scatter(x=df_feat.index, y=df_feat["bb_upper"],
                             line=dict(color="rgba(100,100,255,0.3)", width=1),
                             name="BB Upper", showlegend=False), row=1, col=1)
    fig.add_trace(go.Scatter(x=df_feat.index, y=df_feat["bb_lower"],
                             fill="tonexty", fillcolor="rgba(100,100,255,0.05)",
                             line=dict(color="rgba(100,100,255,0.3)", width=1),
                             name="BB Lower", showlegend=False), row=1, col=1)
    for period in [7, 25, 99]:
        col_name = f"ema_{period}"
        if col_name in df_feat.columns:
            fig.add_trace(go.Scatter(x=df_feat.index, y=df_feat[col_name],
                                     line=dict(width=1), name=f"EMA{period}"), row=1, col=1)
    fig.add_trace(go.Scatter(x=df_feat.index, y=df_feat["rsi_14"],
                             line=dict(color="#f59e0b", width=1.5), name="RSI"), row=2, col=1)
    fig.add_hline(y=70, line_dash="dash", line_color="red", row=2, col=1)
    fig.add_hline(y=30, line_dash="dash", line_color="green", row=2, col=1)
    colors = ["#26a69a" if df["close"].iloc[i] >= df["open"].iloc[i] else "#ef5350"
              for i in range(len(df))]
    fig.add_trace(go.Bar(x=df.index, y=df["volume"], marker_color=colors,
                         name="Volume", showlegend=False), row=3, col=1)

    if chart_indicators is not None and not chart_indicators.empty:
        if "open_interest_value" in chart_indicators:
            oi_value_m = chart_indicators["open_interest_value"] / 1_000_000
            fig.add_trace(go.Scatter(
                x=chart_indicators.index, y=oi_value_m,
                line=dict(color="#60a5fa", width=1.5),
                name="OI Value, M",
            ), row=4, col=1)
        if "cvd_quote" in chart_indicators:
            fig.add_trace(go.Scatter(
                x=chart_indicators.index, y=chart_indicators["cvd_quote"] / 1_000_000,
                line=dict(color="#a78bfa", width=1.5),
                name="CVD Quote, M",
            ), row=5, col=1)
        has_liq_sides = (
            "long_liquidations_quote" in chart_indicators
            and "short_liquidations_quote" in chart_indicators
        )
        if has_liq_sides:
            long_liq = pd.to_numeric(chart_indicators["long_liquidations_quote"], errors="coerce").fillna(0.0)
            short_liq = pd.to_numeric(chart_indicators["short_liquidations_quote"], errors="coerce").fillna(0.0)
            if long_liq.gt(0).any() or short_liq.gt(0).any():
                fig.add_trace(go.Bar(
                    x=chart_indicators.index, y=long_liq / 1_000_000,
                    marker_color="#ef4444",
                    name="Long Liq, M",
                ), row=6, col=1)
                fig.add_trace(go.Bar(
                    x=chart_indicators.index, y=short_liq / 1_000_000,
                    marker_color="#22c55e",
                    name="Short Liq, M",
                ), row=6, col=1)
            else:
                fig.add_annotation(
                    text="No local liquidation events collected yet",
                    xref="paper", yref="paper", x=0.5, y=0.04,
                    showarrow=False, font=dict(color="#9ca3af", size=11),
                )
        elif "liquidations_quote" in chart_indicators:
            liq = pd.to_numeric(chart_indicators["liquidations_quote"], errors="coerce")
            if liq.notna().any() and liq.gt(0).any():
                fig.add_trace(go.Bar(
                    x=chart_indicators.index, y=liq / 1_000_000,
                    marker_color="#ef4444",
                    name="Liquidations, M",
                ), row=6, col=1)
    fig.update_layout(
        title={"text": title, "x": 0.0, "xanchor": "left"},
        height=820,
        xaxis_rangeslider_visible=False,
        template="plotly_dark",
        showlegend=True,
        legend=dict(orientation="h", y=1.02),
        margin=dict(l=0, r=0, t=55, b=0),
        uirevision=title,
        barmode="stack",
    )
    fig.update_yaxes(title_text="OI M", row=4, col=1)
    fig.update_yaxes(title_text="CVD M", row=5, col=1)
    fig.update_yaxes(title_text="Liq M", row=6, col=1)
    return fig


# ── Page config ──────────────────────────────────────────────────────────────
st.set_page_config(page_title="Crypto Predictor", page_icon="📈", layout="wide")
st.title("📈 Crypto Price Predictor")
_start_liquidation_stream()

# ── Sidebar ───────────────────────────────────────────────────────────────────
st.sidebar.header("Settings")
liq_status = get_liquidation_status()
if liq_status.get("connected"):
    st.sidebar.success("Liquidation stream: live")
elif liq_status.get("running"):
    st.sidebar.warning("Liquidation stream: connecting")
else:
    st.sidebar.error("Liquidation stream: stopped")
if liq_status.get("last_event_time"):
    st.sidebar.caption(f"Last liq: {liq_status['last_event_time']}")
st.sidebar.caption(f"Liq events saved: {liq_status.get('events_written', 0)}")
if liq_status.get("last_error"):
    st.sidebar.caption(f"Liq stream error: {liq_status['last_error']}")
try:
    market_df = _market_screener()
except Exception as e:
    st.sidebar.error(f"Market screener unavailable: {e}")
    market_df = pd.DataFrame([
        {"symbol": s, "base_asset": s.replace("USDT", ""), "quote_asset": "USDT",
         "last_price": None, "change_pct_24h": None, "quote_volume_24h": 0, "trades_24h": 0,
         "open_interest_quote": 0, "volatility_pct_24h": 0, "funding_rate_pct": 0,
         "liquidations_quote_24h": pd.NA}
        for s in ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT"]
    ])
market_df = ensure_screener_columns(market_df)

st.sidebar.subheader("Futures Screener")
quote_assets = sorted(market_df["quote_asset"].dropna().unique().tolist())
preferred_quotes = [q for q in ["USDT", "USDC"] if q in quote_assets]
quote_options = preferred_quotes + [q for q in quote_assets if q not in preferred_quotes]
quote_asset = st.sidebar.selectbox("Quote", quote_options, index=0 if "USDT" in quote_options else 0)
search = st.sidebar.text_input("Search", value="", placeholder="BTC, ETH, PEPE...")
min_volume_m = st.sidebar.number_input("Min 24h quote volume, M", min_value=0.0, value=10.0, step=5.0)
min_oi_m = st.sidebar.number_input("Min OI, M", min_value=0.0, value=0.0, step=5.0)
min_volatility = st.sidebar.number_input("Min volatility 24h, %", min_value=0.0, value=0.0, step=1.0)
max_abs_funding = st.sidebar.number_input("Max abs funding, %", min_value=0.0, value=1.0, step=0.01)
min_age_days = st.sidebar.number_input("Min contract age, days", min_value=0, value=30, step=10)
sort_label = st.sidebar.selectbox(
    "Sort by",
    ["Volume 24h", "Open Interest", "Volatility 24h", "Funding", "Gainers 24h", "Losers 24h", "Trades 24h", "Symbol"],
)

filtered = market_df[market_df["quote_asset"] == quote_asset].copy()
if search.strip():
    needle = search.strip().upper()
    filtered = filtered[
        filtered["symbol"].str.contains(needle, na=False)
        | filtered["base_asset"].str.contains(needle, na=False)
    ]
filtered = filtered[filtered["quote_volume_24h"].fillna(0) >= min_volume_m * 1_000_000]
filtered = filtered[filtered["open_interest_quote"].fillna(0) >= min_oi_m * 1_000_000]
filtered = filtered[filtered["volatility_pct_24h"].fillna(0) >= min_volatility]
filtered = filtered[filtered["funding_rate_pct"].fillna(0).abs() <= max_abs_funding]
if min_age_days > 0 and "onboard_date" in filtered.columns:
    onboard = pd.to_numeric(filtered["onboard_date"], errors="coerce")
    age_days = (pd.Timestamp.now(tz="UTC").timestamp() * 1000 - onboard) / 86_400_000
    filtered = filtered[age_days.fillna(min_age_days) >= min_age_days]

sort_map = {
    "Volume 24h": ("quote_volume_24h", False),
    "Open Interest": ("open_interest_quote", False),
    "Volatility 24h": ("volatility_pct_24h", False),
    "Funding": ("funding_rate_pct", False),
    "Gainers 24h": ("change_pct_24h", False),
    "Losers 24h": ("change_pct_24h", True),
    "Trades 24h": ("trades_24h", False),
    "Symbol": ("symbol", True),
}
sort_col, ascending = sort_map[sort_label]
filtered = filtered.sort_values(sort_col, ascending=ascending, na_position="last")
if filtered.empty:
    st.sidebar.warning("No symbols match these filters")
    filtered = market_df[market_df["quote_asset"] == quote_asset].sort_values("quote_volume_24h", ascending=False)

symbol_options = filtered["symbol"].head(200).tolist()
if not symbol_options:
    symbol_options = ["BTCUSDT"]

valid_symbols = set(market_df["symbol"].dropna().tolist())
if "active_symbol" not in st.session_state:
    st.session_state["active_symbol"] = st.session_state.get("selected_symbol", symbol_options[0])

pending_symbol = st.session_state.pop("pending_symbol_widget", None)
if pending_symbol in valid_symbols:
    st.session_state["active_symbol"] = pending_symbol
elif st.session_state.get("symbol_select_widget") in valid_symbols:
    st.session_state["active_symbol"] = st.session_state["symbol_select_widget"]

active_symbol = st.session_state.get("active_symbol")
if active_symbol not in valid_symbols:
    active_symbol = symbol_options[0]
    st.session_state["active_symbol"] = active_symbol

if active_symbol not in symbol_options:
    symbol_options = [active_symbol] + [s for s in symbol_options if s != active_symbol]

if (
    pending_symbol in valid_symbols
    or st.session_state.get("symbol_select_widget") not in symbol_options
):
    st.session_state["symbol_select_widget"] = active_symbol
quote_lookup = market_df.set_index("symbol")["quote_asset"].to_dict()

preview_cols = [
    "symbol", "last_price", "change_pct_24h", "quote_volume_24h",
    "open_interest_quote", "volatility_pct_24h", "funding_rate_pct",
]
preview_symbols = filtered["symbol"].head(12).tolist()
preview = filtered[preview_cols].head(12).copy()
if not preview.empty:
    preview["quote_volume_24h"] = (preview["quote_volume_24h"] / 1_000_000).round(1)
    preview["open_interest_quote"] = (preview["open_interest_quote"] / 1_000_000).round(1)
    preview["volatility_pct_24h"] = preview["volatility_pct_24h"].round(2)
    preview["funding_rate_pct"] = preview["funding_rate_pct"].round(4)
    preview["last_price"] = preview["last_price"].apply(lambda x: format_market_price(x, quote_asset))
    preview.rename(columns={
        "symbol": "Symbol",
        "last_price": "Price",
        "change_pct_24h": "24h %",
        "quote_volume_24h": "Vol M",
        "open_interest_quote": "OI M",
        "volatility_pct_24h": "Volatility %",
        "funding_rate_pct": "Funding %",
    }, inplace=True)
    st.sidebar.caption("Click a row or use the Coin dropdown below")
    screener_event = st.sidebar.dataframe(
        preview,
        hide_index=True,
        width="stretch",
        height=340,
        key=f"screener_preview_{st.session_state.get('screener_preview_version', 0)}",
        on_select="rerun",
        selection_mode="single-row",
    )
    apply_table_selection(screener_event, preview_symbols, "screener_preview")

symbol = st.sidebar.selectbox(
    "Coin",
    symbol_options,
    key="symbol_select_widget",
    format_func=lambda x: symbol_label(x, quote_lookup.get(x, quote_asset)),
    on_change=sync_active_symbol_from_widget,
)
if symbol != st.session_state.get("active_symbol"):
    st.session_state["active_symbol"] = symbol
    st.rerun()
symbol = st.session_state["active_symbol"]

horizon = st.sidebar.selectbox(
    "Horizon",
    list(HORIZONS.keys()),
    key="selected_horizon",
    format_func=lambda x: HORIZON_LABELS.get(x, x),
)
selected_row = market_df[market_df["symbol"] == symbol]
selected_quote = quote_asset if selected_row.empty else selected_row.iloc[0]["quote_asset"]
selected_liq_24h = liquidation_summary(symbol, hours=24)

st.sidebar.markdown("---")
st.sidebar.subheader("Selected Contract")
st.sidebar.markdown(f"**{symbol_label(symbol, selected_quote)}** · `{HORIZON_LABELS.get(horizon, horizon)}`")
if not selected_row.empty:
    selected_data = selected_row.iloc[0]
    c1, c2 = st.sidebar.columns(2)
    c1.metric("24h", f"{selected_data['change_pct_24h']:+.2f}%")
    c2.metric("Funding", f"{selected_data['funding_rate_pct']:+.4f}%")
    c1, c2 = st.sidebar.columns(2)
    c1.metric("Volume", format_millions(selected_data["quote_volume_24h"]))
    c2.metric("OI", format_millions(selected_data["open_interest_quote"]))
    c1, c2 = st.sidebar.columns(2)
    c1.metric("Liq 24h", format_quote_amount(selected_liq_24h["quote_qty"], selected_quote))
    c2.metric("Trades", f"{int(selected_data['trades_24h']):,}")
    st.sidebar.caption(
        f"Long liq: {format_quote_amount(selected_liq_24h['long_quote_qty'], selected_quote)} · "
        f"Short liq: {format_quote_amount(selected_liq_24h['short_quote_qty'], selected_quote)}"
    )
    st.sidebar.caption(f"Volatility 24h: {selected_data['volatility_pct_24h']:.2f}%")

st.sidebar.markdown("---")
st.sidebar.subheader("LightGBM")
if is_trained(symbol, horizon):
    st.sidebar.success(f"Model ready: {symbol} {horizon}")
else:
    st.sidebar.warning("Not trained yet")

st.sidebar.markdown("---")
st.sidebar.subheader("River (Online)")
r_stats = get_river_stats(symbol, horizon)
if r_stats["n_samples"] > 0:
    st.sidebar.success(f"Samples: {r_stats['n_samples']}")
    if r_stats["mae"] is not None:
        st.sidebar.caption(f"Running MAE: {r_stats['mae']:.6f}")
else:
    st.sidebar.warning("Not initialized")

# ── Shared data (cached, fetched once per render) ─────────────────────────────
cfg = HORIZONS[horizon]
chart_limit = min(cfg["limit"], CHART_LIMITS.get(horizon, 200))
df = _fetch(symbol, cfg["interval"], chart_limit)
df_feat = add_features(df)
try:
    chart_indicators = _chart_indicators(symbol, cfg["interval"], chart_limit)
except Exception:
    chart_indicators = pd.DataFrame()

render_active_header(symbol, selected_quote, horizon, cfg["interval"], len(df))
if not selected_row.empty:
    selected_data = selected_row.iloc[0]
    m1, m2, m3, m4, m5, m6, m7 = st.columns(7)
    m1.metric("Price", format_market_price(selected_data["last_price"], selected_quote))
    m2.metric("24h Change", f"{selected_data['change_pct_24h']:+.2f}%")
    m3.metric("Volume", format_millions(selected_data["quote_volume_24h"]))
    m4.metric("OI", format_millions(selected_data["open_interest_quote"]))
    m5.metric("Funding", f"{selected_data['funding_rate_pct']:+.4f}%")
    m6.metric("Liq 24h", format_quote_amount(selected_liq_24h["quote_qty"], selected_quote))
    m7.metric("Chart Bars", f"{len(df)} x {cfg['interval']}")
    st.caption(
        f"Liquidations 24h: long {format_quote_amount(selected_liq_24h['long_quote_qty'], selected_quote)}, "
        f"short {format_quote_amount(selected_liq_24h['short_quote_qty'], selected_quote)}, "
        f"events {selected_liq_24h['count']}"
    )
else:
    st.caption(f"Active futures symbol: {symbol_label(symbol, selected_quote)} · {HORIZON_LABELS.get(horizon, horizon)}")

# ── Tabs ──────────────────────────────────────────────────────────────────────
tab_lgbm, tab_river, tab_market, tab_log = st.tabs([
    "LightGBM", "River (Online)", "Market Overview", "Predictions Log"
])

# ── Tab 1: LightGBM ───────────────────────────────────────────────────────────
with tab_lgbm:
    chart_col, pred_col = st.columns([2, 1])

    with chart_col:
        chart_title = f"{symbol_label(symbol, selected_quote)} - {HORIZON_LABELS.get(horizon, horizon)}"
        st.plotly_chart(
            build_chart(df, df_feat, chart_indicators, chart_title),
            width="stretch",
            key=f"chart_lgbm_{symbol}_{horizon}",
        )

    with pred_col:
        st.subheader("Prediction")
        lgbm_state_key = f"lgbm_prediction_{symbol}_{horizon}"

        if st.button("Train / Retrain", key="btn_train_lgbm", width="stretch"):
            with st.spinner(f"Training {symbol} {horizon}..."):
                train_result = train_model(symbol, horizon)
            st.success(f"Done! CV MAE: {train_result['cv_mae']:.4f}")

        if not is_trained(symbol, horizon):
            st.info("Click 'Train / Retrain' to train the model")
        else:
            try:
                if st.button("Run LightGBM Prediction", key="btn_predict_lgbm", type="primary", width="stretch"):
                    result = predict(symbol, horizon, df=df)
                    st.session_state[lgbm_state_key] = result
                    log_prediction(result, "LightGBM")
                else:
                    result = st.session_state.get(lgbm_state_key)

                if result is None:
                    st.info("Click 'Run LightGBM Prediction' to generate and log a prediction")
                else:
                    arrow = "🟢 ▲" if result["direction"] == "UP" else "🔴 ▼"
                    st.metric("Current Price", format_market_price(result["current_price"], selected_quote))
                    st.metric(
                        f"Predicted ({horizon})",
                        format_market_price(result["predicted_price"], selected_quote),
                        delta=f"{result['predicted_return_pct']:+.2f}%",
                    )
                    st.markdown(f"### {arrow} {result['direction']}")
                    st.progress(int(result["confidence"]),
                                text=f"Signal strength: {result['confidence']:.1f}%")

                st.markdown("---")
                st.markdown("**Key Indicators**")
                last = df_feat.iloc[-1]
                for label, val in [
                    ("RSI (14)", f"{last.get('rsi_14', 0):.1f}"),
                    ("MACD", f"{last.get('macd', 0):.4f}"),
                    ("BB %", f"{last.get('bb_pct', 0):.2f}"),
                    ("ATR %", f"{last.get('atr_pct', 0)*100:.2f}%"),
                    ("Vol Ratio", f"{last.get('volume_ratio', 0):.2f}x"),
                ]:
                    c1, c2 = st.columns(2)
                    c1.caption(label)
                    c2.caption(val)
            except Exception as e:
                st.error(f"Prediction error: {e}")

# ── Tab 2: River ──────────────────────────────────────────────────────────────
with tab_river:
    chart_col, pred_col = st.columns([2, 1])

    with chart_col:
        chart_title = f"{symbol_label(symbol, selected_quote)} - {HORIZON_LABELS.get(horizon, horizon)}"
        st.plotly_chart(
            build_chart(df, df_feat, chart_indicators, chart_title),
            width="stretch",
            key=f"chart_river_{symbol}_{horizon}",
        )

    with pred_col:
        st.subheader("Prediction")
        river_state_key = f"river_prediction_{symbol}_{horizon}"

        if st.button("Update River Model", key="btn_update_river", width="stretch"):
            with st.spinner("Learning from new data..."):
                _r = update_river_model(symbol, horizon)
            r_stats = get_river_stats(symbol, horizon)
            st.success(f"Done! {_r['n_samples']} samples learned")

        if r_stats["n_samples"] == 0:
            st.info("Click 'Update River Model' to initialize")
        else:
            try:
                if st.button("Run River Prediction", key="btn_predict_river", type="primary", width="stretch"):
                    r = predict_river(symbol, horizon, df=df)
                    st.session_state[river_state_key] = r
                    log_prediction(r, "River")
                else:
                    r = st.session_state.get(river_state_key)

                if r is None:
                    st.info("Click 'Run River Prediction' to generate and log a prediction")
                else:
                    r_arrow = "🟢 ▲" if r["direction"] == "UP" else "🔴 ▼"
                    st.metric("Current Price", format_market_price(r["current_price"], selected_quote))
                    st.metric(
                        f"Predicted ({horizon})",
                        format_market_price(r["predicted_price"], selected_quote),
                        delta=f"{r['predicted_return_pct']:+.2f}%",
                    )
                    st.markdown(f"### {r_arrow} {r['direction']}")
                    st.progress(int(r["confidence"]),
                                text=f"Signal strength: {r['confidence']:.1f}%")

                st.markdown("---")
                st.markdown("**Model Stats**")
                st.metric("Samples learned", r_stats["n_samples"])
                if r_stats["mae"] is not None:
                    st.metric("Running MAE", f"{r_stats['mae']:.6f}")
                st.caption("Online model — updates incrementally with each new candle")

                st.markdown("---")
                st.markdown("**Backtest**")
                if st.button("Run River Backtest", key="btn_backtest_river", width="stretch"):
                    with st.spinner(f"Backtesting {symbol} {horizon}..."):
                        st.session_state["river_backtest"] = backtest_river(symbol, horizon)

                bt = st.session_state.get("river_backtest")
                if bt and bt.get("symbol") == symbol and bt.get("horizon") == horizon:
                    if bt.get("error"):
                        st.warning(bt["error"])
                    else:
                        c1, c2 = st.columns(2)
                        c1.metric("Direction Accuracy", f"{bt['direction_accuracy_pct']:.1f}%")
                        c2.metric("MAE", f"{bt['mae_pct']:.3f}%")

                        c1, c2 = st.columns(2)
                        c1.metric("Naive MAE", f"{bt['zero_mae_pct']:.3f}%")
                        mae_delta = bt["mae_vs_zero_pct"]
                        c2.metric(
                            "MAE vs Naive",
                            f"{mae_delta:+.1f}%" if mae_delta is not None else "N/A",
                        )

                        c1, c2 = st.columns(2)
                        c1.metric("Strategy Avg", f"{bt['strategy_avg_return_pct']:+.3f}%")
                        c2.metric("Buy/Hold Avg", f"{bt['buy_hold_avg_return_pct']:+.3f}%")
                        st.caption(f"Test samples: {bt['n_test']}")
            except Exception as e:
                st.error(f"River error: {e}")

# ── Tab 3: Market Overview ────────────────────────────────────────────────────
with tab_market:
    st.subheader(f"Futures Screener: {quote_asset}")
    overview_symbols = filtered["symbol"].head(50).tolist()
    overview_cols = [
        "symbol", "last_price", "change_pct_24h", "quote_volume_24h",
        "open_interest_quote", "volatility_pct_24h", "funding_rate_pct",
        "liquidations_quote_24h", "trades_24h",
    ]
    overview = filtered[overview_cols].head(50).copy()
    overview["quote_volume_24h"] = (overview["quote_volume_24h"] / 1_000_000).round(2)
    overview["open_interest_quote"] = (overview["open_interest_quote"] / 1_000_000).round(2)
    overview["liquidations_quote_24h"] = overview["liquidations_quote_24h"].apply(
        lambda x: "N/A" if pd.isna(x) else format_quote_amount(x, quote_asset)
    )
    overview["volatility_pct_24h"] = overview["volatility_pct_24h"].round(2)
    overview["funding_rate_pct"] = overview["funding_rate_pct"].round(4)
    overview["last_price"] = overview["last_price"].apply(lambda x: format_market_price(x, quote_asset))
    overview.rename(columns={
        "symbol": "Symbol",
        "last_price": "Price",
        "change_pct_24h": "24h %",
        "quote_volume_24h": "Quote Vol M",
        "open_interest_quote": "OI M",
        "volatility_pct_24h": "Volatility %",
        "funding_rate_pct": "Funding %",
        "liquidations_quote_24h": "Liquidations 24h",
        "trades_24h": "Trades",
    }, inplace=True)
    overview_event = st.dataframe(
        overview,
        hide_index=True,
        width="stretch",
        height=460,
        key=f"market_overview_table_{st.session_state.get('market_overview_table_version', 0)}",
        on_select="rerun",
        selection_mode="single-row",
    )
    apply_table_selection(overview_event, overview_symbols, "market_overview_table")

    st.markdown("---")
    st.subheader("Selected Symbol")
    cols = st.columns(3)
    related = filtered["symbol"].head(6).tolist()
    if symbol not in related:
        related = [symbol] + related[:5]
    for i, coin in enumerate(related):
        row = market_df[market_df["symbol"] == coin]
        label = coin
        if not row.empty:
            q = row.iloc[0]["quote_asset"]
            label = symbol_label(coin, q)
            price = row.iloc[0].get("last_price")
        else:
            q = selected_quote
            price = None
        with cols[i % 3]:
            if price is not None and not pd.isna(price):
                st.metric(label, format_market_price(price, q))
            else:
                st.metric(label, "N/A")

# ── Tab 4: Predictions Log ────────────────────────────────────────────────────
with tab_log:
    st.subheader(f"Predictions Log: {symbol_label(symbol, selected_quote)}")
    log_path = coin_log_path(symbol)
    if os.path.exists(log_path):
        df_log = pd.read_csv(log_path).iloc[::-1].reset_index(drop=True)

        col_info, col_dl, col_clear = st.columns([2, 1, 1])
        col_info.caption(f"{len(df_log)} entries")
        with col_dl:
            st.download_button(
                "Download CSV",
                data=df_log.to_csv(index=False).encode(),
                file_name=f"{symbol}_predictions_log.csv",
                mime="text/csv",
            )
        with col_clear:
            if st.button("Clear Log"):
                os.remove(log_path)
                for ext in ["", ".lock"]:
                    p = log_path + ext
                    if os.path.exists(p):
                        os.remove(p)
                st.session_state["just_cleared"] = True
                st.rerun()

        def highlight_direction(val):
            if val == "UP":
                return "color: #26a69a; font-weight: bold"
            elif val == "DOWN":
                return "color: #ef5350; font-weight: bold"
            return ""

        def highlight_model(val):
            if val == "LightGBM":
                return "color: #3b82f6"
            elif val == "River":
                return "color: #f59e0b"
            return ""

        st.dataframe(
            df_log.style
                  .map(highlight_direction, subset=["direction"])
                  .map(highlight_model, subset=["model"]),
            width="stretch",
            height=500,
        )
    else:
        st.info(f"No predictions yet for {symbol}. Open the LightGBM or River tab to generate predictions.")
