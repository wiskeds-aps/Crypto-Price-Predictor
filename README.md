# Crypto Price Predictor

Репозиторий содержит два отдельных Windows-приложения:

## 1. CryptoPredictorPortable

Основной прогнозатор цен с моделями LightGBM и River, графиками и журналами.

- Ветка: `windows-portable`
- Windows portable workflow: `.github/workflows/windows-portable.yml`
- Документация: `windows/README_Windows_Portable.md`

## 2. OIScreenerPortable

Скринер Binance USDT-M futures для поиска всплесков `OI`, объема и цены.

- Ветка: `oi-screener`
- Windows portable workflow: `.github/workflows/oi-screener-windows-portable.yml`
- Документация: `windows/README_OI_Screener_Windows_Portable.md`

## Как использовать

Если нужен готовый Windows-пакет:

1. Открой нужную ветку в GitHub Actions.
2. Скачай artifact или release zip.
3. Распакуй архив.
4. Запусти `Start Crypto Predictor.bat` или `Start OI Screener.bat`.

Если нужен исходный код:

1. Клонируй репозиторий.
2. Переключись на нужную ветку.
3. Запусти соответствующий build script из папки `windows/`.

## Кратко по веткам

- `main` - основное приложение сервера
- `windows-portable` - Windows-сборка основного приложения
- `oi-screener` - OI screener и его Windows portable-сборка
