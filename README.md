# CryptoScreener

FastAPI screener for spot coins and Binance futures with a static web UI.

## Run

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open:

```text
http://127.0.0.1:8000
```

## Windows Portable

GitHub Actions builds a portable Windows zip on pushes to the `crypto-screener` branch.

Manual local build on Windows:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\windows\Build-CryptoScreener-Portable.ps1
```

The output is:

```text
dist\CryptoScreenerPortable
```

Run:

```text
dist\CryptoScreenerPortable\Start CryptoScreener.bat
```

## Telegram Alerts

Copy `.env.example` to `.env` or export the variables before starting the app:

```bash
export TELEGRAM_TOKEN="..."
export TELEGRAM_CHAT_ID="..."
```

If the variables are empty, Telegram alerts are disabled.

## Data

The SQLite database is created locally at:

```text
data/crypto.db
```

The `data/` directory is intentionally ignored by git.
