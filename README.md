# BTC Forecast Live

Small read-only BTC forecast dashboard served at:

https://144-31-84-161.sslip.io/

The production server currently runs this app from `/root/live` behind Caddy.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Dashboard markup. |
| `app.js` | Browser logic and chart rendering. |
| `style.css` | Dashboard styling. |
| `server.py` | Local HTTP API and static file server on `127.0.0.1:8080`. |
| `crypto_river_24h.py` | Exports the Crypto Predictor River 24h forecast into live JSON/CSV files. |

Generated files are intentionally ignored:

- `crypto_river_24h.json`
- `crypto_river_24h_history.csv`

## Runtime Paths

Defaults match the current VPS layout:

| Env var | Default |
| --- | --- |
| `BTC_FORECAST_WEB_ROOT` | app directory |
| `BTC_FORECAST_HOST` | `127.0.0.1` |
| `BTC_FORECAST_PORT` | `8080` |
| `TIMESFM_PROJECT_ROOT` | `/root/timesfm-project` |
| `RIVER_CURRENT_PATH` | `/root/river/live/forecast_1h.json` |
| `RIVER_HISTORY_PATH` | `/root/river/live/history_1h.csv` |
| `CRYPTO_RIVER_CURRENT_PATH` | `$BTC_FORECAST_WEB_ROOT/crypto_river_24h.json` |
| `CRYPTO_RIVER_HISTORY_PATH` | `$BTC_FORECAST_WEB_ROOT/crypto_river_24h_history.csv` |
| `CRYPTO_PREDICTOR_ROOT` | `/root/claud` |

## Local Run

```bash
python3 server.py
```

Then open:

```text
http://127.0.0.1:8080/
```

## Deployment

Deployment templates are in:

- `deploy/caddy/Caddyfile`
- `deploy/systemd/timesfm-web.service`
- `deploy/systemd/timesfm-web-hardening.conf`
- `deploy/systemd/crypto-river-24h.service`
- `deploy/systemd/crypto-river-24h.timer`
