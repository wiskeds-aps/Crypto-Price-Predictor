# TimesFM Forecast Dashboard

This branch snapshot contains the BTC TimesFM dashboard that is currently deployed
on the server, plus the Crypto Predictor River 24h dashboard export.

## Layout

- `timesfm_project/` - TimesFM forecast generators for BTCUSDT.
- `live/` - static dashboard and small read-only HTTP server.
- `live/crypto_river_24h.py` - exports Crypto Predictor River 24h BTC forecast
  for the dashboard.
- `river/live_1h.py` - legacy hourly River shadow forecast shown in the dashboard.
- `../coins/BTCUSDT/models/river_*.pkl` - tracked Crypto Predictor River BTC
  model snapshots.
- `river/models/BTCUSDT_1h_river_v3.pkl` - tracked legacy River shadow model
  snapshot.
- `../deploy/systemd/` - systemd service/timer units used on the server.
- `../deploy/caddy/Caddyfile` - Caddy reverse proxy example.

## Runtime Data

Tracked model files are snapshots. The live bots keep training their local model
files; commit and push updated snapshots when you intentionally want to share
the latest learned state.

Do not commit generated forecast/log files:

- `forecast*.json`
- `forecast*.csv`
- `history/`
- dashboard history CSV files

The live server currently stores generated TimesFM files under
`/root/timesfm-project`, dashboard files under `/root/live`, and River shadow
files under `/root/river`.

## Main Endpoints

- Dashboard: `https://144-31-84-161.sslip.io`
- Current TimesFM 5m forecast: `/api/current?interval=5m`
- Current TimesFM 1h forecast: `/api/current?interval=1h`
- Current Crypto Predictor River 24h forecast: `/api/crypto-river/current`
