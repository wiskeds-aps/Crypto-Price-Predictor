from __future__ import annotations

import time

import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import streamlit as st

from scanner import ScanConfig, scan_market, symbol_history

st.set_page_config(page_title="OI Скринер", layout="wide", initial_sidebar_state="expanded")

# ── Compact UI styles ─────────────────────────────────────────────────────────
st.markdown("""
<style>
    .block-container { padding: 0.6rem 1rem 0.5rem 1rem !important; }
    h1 { font-size: 1.1rem !important; margin: 0 0 0.4rem 0 !important; padding: 0 !important; }
    h2, h3 { font-size: 0.9rem !important; margin: 0.15rem 0 !important; }
    [data-testid="stMetricValue"] { font-size: 0.95rem !important; font-weight: 700; line-height: 1.2; }
    [data-testid="stMetricLabel"] { font-size: 0.62rem !important; color: #888 !important; }
    [data-testid="stMetricDelta"] { font-size: 0.62rem !important; }
    div[data-testid="stSidebar"] { font-size: 0.78rem !important; }
    div[data-testid="stSidebar"] label { font-size: 0.75rem !important; }
    div[data-testid="stSidebar"] .stSlider { margin-bottom: 0.25rem !important; }
    div[data-testid="stSidebar"] .element-container { margin-bottom: 0.15rem !important; }
    .stDataFrame { font-size: 0.73rem !important; }
    p, li, .stCaption, caption { font-size: 0.73rem !important; }
    .stAlert p { font-size: 0.73rem !important; }
    div[data-testid="column"] { padding: 0 0.2rem !important; }
</style>
""", unsafe_allow_html=True)


def fmt_money(value: float) -> str:
    if pd.isna(value):
        return "-"
    v = float(value)
    if abs(v) >= 1_000_000_000:
        return f"${v/1e9:.2f}B"
    if abs(v) >= 1_000_000:
        return f"${v/1e6:.1f}M"
    if abs(v) >= 1_000:
        return f"${v/1e3:.1f}K"
    return f"${v:.2f}"


def fmt_pct(v) -> str:
    return f"{float(v):+.2f}%" if pd.notna(v) else "-"


@st.cache_data(ttl=120, show_spinner=False)
def cached_scan(config: ScanConfig):
    t0 = time.time()
    df, errors = scan_market(config)
    return df, errors, time.time() - t0


@st.cache_data(ttl=300, show_spinner=False)
def cached_symbol_history(symbol: str, interval: str, limit: int):
    return symbol_history(symbol, interval, limit)


def build_chart(symbol: str, interval: str) -> go.Figure:
    candles, oi = cached_symbol_history(symbol, interval, 120)
    fig = make_subplots(
        rows=3, cols=1,
        shared_xaxes=True,
        vertical_spacing=0.03,
        row_heights=[0.55, 0.22, 0.23],
    )
    fig.add_trace(go.Candlestick(
        x=candles["open_time"],
        open=candles["open"], high=candles["high"],
        low=candles["low"], close=candles["close"],
        name="Price",
        increasing_line_color="#26a69a", decreasing_line_color="#ef5350",
    ), row=1, col=1)
    fig.add_trace(go.Bar(
        x=candles["open_time"], y=candles["quote_volume"],
        name="Volume", marker_color="#4c78a8",
    ), row=2, col=1)
    if not oi.empty:
        oi_col = "open_interest_quote" if "open_interest_quote" in oi.columns else "open_interest_base"
        fig.add_trace(go.Scatter(
            x=oi["timestamp"], y=oi[oi_col],
            name="OI", mode="lines",
            line=dict(color="#f58518", width=1.5),
        ), row=3, col=1)
    fig.update_layout(
        height=480,
        margin=dict(l=10, r=10, t=18, b=10),
        xaxis_rangeslider_visible=False,
        template="plotly_dark",
        showlegend=False,
        font=dict(size=10),
    )
    fig.update_xaxes(showgrid=True, gridcolor="#2a2a2a")
    fig.update_yaxes(showgrid=True, gridcolor="#2a2a2a")
    return fig


@st.fragment
def render_chart_panel(symbol: str, interval: str) -> None:
    selected = view[view["symbol"] == symbol].iloc[0]
    with st.container(border=True):
        sig_color = "#26a69a" if selected["signal"] == "PUMP" else "#ef5350"
        st.markdown(
            f"<span style='font-size:1rem;font-weight:700'>{symbol}</span>"
            f" &nbsp;<span style='color:{sig_color};font-weight:700'>{selected['signal']}</span>"
            f" &nbsp;<span style='color:#888;font-size:0.8rem'>score {selected['score']}</span>",
            unsafe_allow_html=True,
        )

        m1, m2, m3, m4, m5 = st.columns(5)
        m1.metric("Цена Δ",      fmt_pct(selected["price_move_pct"]))
        m2.metric("OI Δ",        fmt_pct(selected["oi_change_pct"]))
        m3.metric("Объём ×",     f"{selected['volume_ratio']:.2f}×")
        m4.metric("Тейкер",      f"{selected['taker_buy_ratio']:.1%}")
        m5.metric("Рек. объём",  fmt_money(selected["recent_quote_volume"]))

        st.plotly_chart(
            build_chart(symbol, interval),
            use_container_width=True,
            key=f"chart_{symbol}_{interval}",
        )


def style_table(df: pd.DataFrame) -> pd.io.formats.style.Styler:
    def row_style(row):
        sig = row.get("signal", "")
        if sig == "PUMP":
            return ["color: #26a69a" if c == "signal" else "" for c in df.columns]
        if sig == "DUMP":
            return ["color: #ef5350" if c == "signal" else "" for c in df.columns]
        return ["color: #888" if c == "signal" else "" for c in df.columns]

    return df.style.apply(row_style, axis=1).format(precision=2, na_rep="-")


# ── Sidebar ───────────────────────────────────────────────────────────────────
with st.sidebar:
    st.markdown("**⚙ Настройки сканера**")
    interval = st.selectbox("Интервал", ["5m", "15m", "30m", "1h"], index=0, label_visibility="collapsed")
    st.caption(f"Интервал: **{interval}**")

    c1, c2 = st.columns(2)
    lookback_bars = c1.number_input("Баров назад", 6, 48, 12, step=1)
    spike_bars    = c2.number_input("Баров спайка", 1, 12, 3, step=1)

    min_quote_volume = st.number_input("Мин. объём 24ч, $M", 1.0, 500.0, 10.0, step=1.0) * 1_000_000
    exclude_top = st.selectbox("Исключить топ по объему", [0, 25, 50, 100, 200], index=0, format_func=lambda x: "Не исключать" if x == 0 else f"Без топ {x}")
    symbol_query = st.text_input("Поиск монеты", value="", placeholder="например: SIREN, BTC, PEPE")

    st.markdown("**Фильтры**")
    c1, c2 = st.columns(2)
    min_oi    = c1.number_input("Рост OI %", 0.0, 20.0, 1.5, step=0.1)
    min_vol   = c2.number_input("Спайк объёма ×", 1.0, 10.0, 1.8, step=0.1)
    min_price = st.number_input("Движение цены %", 0.0, 10.0, 0.4, step=0.1)

    st.markdown("**Направление**")
    mode = st.radio("Режим", ["ПАМП + ДАМП", "ПАМП", "ДАМП", "ВСЕ"],
                    index=0, label_visibility="collapsed", horizontal=False)

    st.markdown("---")
    auto_refresh = st.checkbox("Автообновление 60с", value=False)
    st.button("▶ Сканировать", use_container_width=True)

# ── Auto refresh ──────────────────────────────────────────────────────────────
if auto_refresh:
    last = st.session_state.get("_last_refresh", 0)
    if time.time() - last >= 60:
        st.session_state["_last_refresh"] = time.time()
        st.cache_data.clear()
        st.rerun()

# ── Scan ──────────────────────────────────────────────────────────────────────
config = ScanConfig(
    interval=interval,
    lookback_bars=lookback_bars,
    spike_bars=min(spike_bars, lookback_bars),
    max_symbols=0,
    min_quote_volume_24h=min_quote_volume,
    min_oi_change_pct=min_oi,
    min_volume_ratio=min_vol,
    min_price_move_pct=min_price,
)

with st.spinner("Сканирование…"):
    df, errors, elapsed = cached_scan(config)

if df.empty:
    st.error("Нет данных от сканера.")
    if errors:
        st.code("\n".join(errors[:20]))
    st.stop()

if mode == "ПАМП":
    view = df[df["signal"] == "PUMP"].copy()
elif mode == "ДАМП":
    view = df[df["signal"] == "DUMP"].copy()
elif mode == "ПАМП + ДАМП":
    view = df[df["signal"].isin(["PUMP", "DUMP"])].copy()
else:
    view = df.copy()

if exclude_top:
    view = view[view["volume_rank"].fillna(0) > exclude_top].copy()

query = symbol_query.strip().upper()
if query:
    view = view[
        view["symbol"].str.upper().str.contains(query, na=False)
        | view["base_asset"].astype(str).str.upper().str.contains(query, na=False)
    ].copy()

core = view[view["is_core_signal"]]

# ── Status bar ────────────────────────────────────────────────────────────────
st.title("📡 OI Памп/Дамп Скринер")
s1, s2, s3, s4, s5 = st.columns(5)
s1.metric("Просканировано", len(df))
s2.metric("Сигналов", len(view))
s3.metric("Ключевых", len(core))
s4.metric("Время скана", f"{elapsed:.1f}с")
s5.metric("Ошибок", len(errors))

st.markdown("---")

# ── Main layout: table left | chart right ────────────────────────────────────
col_table, col_chart = st.columns([4, 6], gap="medium")

with col_table:
    with st.container(border=True):
        show_cols = [
            "symbol", "volume_rank", "signal", "score", "is_core_signal",
            "price_move_pct", "oi_change_pct", "volume_ratio",
            "taker_buy_ratio", "recent_quote_volume", "quote_volume_24h",
        ]
        display = view[show_cols].copy()
        display["recent_quote_volume"] = display["recent_quote_volume"].map(fmt_money)
        display["quote_volume_24h"] = display["quote_volume_24h"].map(fmt_money)
        display = display.rename(columns={
            "volume_rank": "ранг",
            "is_core_signal": "ключ.",
            "price_move_pct": "цена%",
            "oi_change_pct": "OI%",
            "volume_ratio": "объём×",
            "taker_buy_ratio": "тейкер",
            "recent_quote_volume": "рек.объём",
            "quote_volume_24h": "объём 24ч",
        })

        event = st.dataframe(
            display,
            use_container_width=True,
            hide_index=True,
            height=560,
            selection_mode="single-row",
            on_select="rerun",
            key="screener_table",
        )

        if view.empty:
            st.warning("Нет монет после применения фильтров.")
            st.stop()

        try:
            rows = event.selection.rows
            if rows and rows[0] < len(view):
                sym_at_row = view.iloc[rows[0]]["symbol"]
                prev_row = st.session_state.get("_screener_row_idx", -1)
                if rows[0] != prev_row:
                    st.session_state["screener_symbol"] = sym_at_row
                    st.session_state["_screener_row_idx"] = rows[0]
        except Exception:
            pass

selected_symbol = st.session_state.get("screener_symbol")
if not selected_symbol or selected_symbol not in view["symbol"].values:
    selected_symbol = view.iloc[0]["symbol"] if not view.empty else df.iloc[0]["symbol"]
    st.session_state["screener_symbol"] = selected_symbol
    st.session_state["_screener_row_idx"] = 0

with col_chart:
    try:
        render_chart_panel(selected_symbol, interval)
    except Exception as e:
        st.error(f"Ошибка графика: {e}")

if errors:
    with st.expander(f"⚠ Ошибки сканирования ({len(errors)})"):
        st.code("\n".join(errors[:100]))
