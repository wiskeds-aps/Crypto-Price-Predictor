@echo off
set "APP_ROOT=%~dp0.."
set "CRYPTO_PREDICTOR_HOME=%APP_ROOT%\portable_data"
set "PYTHONNOUSERSITE=1"
cd /d "%APP_ROOT%"
echo Starting Crypto Predictor on http://127.0.0.1:8502
start "Liquidation Collector" /min python "%APP_ROOT%\liquidation_collector.py"
start "" "http://127.0.0.1:8502"
python -m streamlit run app.py --server.address 127.0.0.1 --server.port 8502 --server.headless true --browser.gatherUsageStats false
pause
