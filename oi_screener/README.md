# OI Pump/Dump Screener

Скринер Binance USDT-M futures для поиска резких движений, где одновременно
растут open interest, объем и цена.

## Идея сигнала

- `PUMP`: цена растет, OI растет, объем выше нормы.
- `DUMP`: цена падает, OI растет, объем выше нормы.
- `SHORT_SQUEEZE`: цена растет, OI падает.
- `LONG_SQUEEZE`: цена падает, OI падает.

Главные поля:

- `price_move_pct` - изменение цены за выбранный lookback.
- `oi_change_pct` - изменение open interest за тот же период.
- `volume_ratio` - текущий объем относительно базового среднего.
- `taker_buy_ratio` - доля агрессивных покупок в последнем всплеске.
- `score` - сводная оценка силы движения от 0 до 100.

## Запуск панели

```bash
pip install -r requirements.txt
streamlit run app.py --server.address 0.0.0.0 --server.port 8503
```

## Windows portable

Отдельная portable-сборка для Windows 11:

```powershell
.\windows\Build-OI-Screener-Portable.ps1
```

Готовая папка появится в `dist\OIScreenerPortable`.
Запускать нужно `Start OI Screener.bat`.

## CLI-сканер

```bash
python3 run_scan.py --interval 5m --lookback-bars 12 --top-n 120
```

Постоянный режим:

```bash
python3 run_scan.py --interval 5m --lookback-bars 12 --top-n 120 --repeat-seconds 60
```

Результаты CLI пишутся в `data/signals_log.csv`, если задан `OI_SCREENER_HOME`.
Иначе файл пишется рядом с запуском.

## Telegram alerts

Можно включить уведомления для сильных core-сигналов:

```bash
export TELEGRAM_BOT_TOKEN="123456:token"
export TELEGRAM_CHAT_ID="123456789"
python3 run_scan.py --interval 5m --lookback-bars 12 --top-n 120 --repeat-seconds 60 --alert-score 60
```

Повторный алерт по той же паре и направлению ограничен `--cooldown-minutes`.

## Практическое использование

Для раннего движения смотри `5m`, `lookback 12`, `recent volume bars 3`.
Для более спокойного подтверждения смотри `15m`, `lookback 8-16`.

Сильный сигнал обычно выглядит так:

- `is_core_signal = True`
- `score >= 60`
- `oi_change_pct >= 2-3%`
- `volume_ratio >= 2x`
- цена уже начала идти в сторону сигнала

Это не торговый совет. Скринер показывает аномалии, а не гарантирует продолжение
движения.
