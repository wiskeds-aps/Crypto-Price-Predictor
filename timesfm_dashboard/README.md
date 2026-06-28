# TimesFM Forecast Dashboard

This branch snapshot contains the BTC TimesFM forecast generators and River model
snapshots used by the dashboard runtime.

## Layout

- `timesfm_project/` - TimesFM forecast generators for BTCUSDT.
- `river/live_1h.py` - legacy hourly River shadow forecast shown in the dashboard.
- `../coins/BTCUSDT/models/river_*.pkl` - tracked Crypto Predictor River BTC
  model snapshots.
- `river/models/BTCUSDT_1h_river_v3.pkl` - tracked legacy River shadow model
  snapshot.
- `../deploy/systemd/` - systemd service/timer units for forecast generators.

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
`/root/timesfm-project` and River shadow files under `/root/river`.
