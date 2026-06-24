# Портативное приложение для Windows 11

Этот вариант собирает переносимую папку с приложением, локальным Python, зависимостями, моделями и журналами. Python не нужно устанавливать в систему.

## Готовая сборка из GitHub

Если не хочешь собирать приложение вручную, скачай готовый архив из GitHub Releases:

```text
https://github.com/wiskeds-aps/Crypto-Price-Predictor/releases/tag/windows-portable-latest
```

На странице релиза скачай `CryptoPredictorPortable.zip`, распакуй архив и запусти `Start Crypto Predictor.bat`.

Также архив можно скачать из GitHub Actions:

1. Открой репозиторий на GitHub.
2. Перейди в раздел `Actions`.
3. Открой последний успешный запуск `Windows portable build`.
4. Внизу страницы скачай artifact `CryptoPredictorPortable`.
5. Распакуй архив и запусти `Start Crypto Predictor.bat`.

Такая сборка уже содержит portable Python и все Python-зависимости.

## Сборка на Windows 11

Открой PowerShell в папке проекта и выполни:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\windows\Build-Portable.ps1
```

Готовая папка появится здесь:

```text
dist\CryptoPredictorPortable
```

Её можно переносить на другой компьютер с Windows 11.

## Запуск

Открой:

```text
dist\CryptoPredictorPortable\Start Crypto Predictor.bat
```

Приложение будет доступно в браузере:

```text
http://127.0.0.1:8502
```

## Где хранятся данные

В портативной сборке все модели и журналы лежат внутри:

```text
dist\CryptoPredictorPortable\data\coins
```

То есть каждая монета продолжает иметь свою папку с моделями и журналом.

## Важно

- Для работы нужны интернет и доступ к Binance futures API.
- Первый запуск сборщика скачивает Python и Python-зависимости.
- Если порт `8502` занят, закрой старый экземпляр приложения или поменяй порт в `Start Crypto Predictor.bat`.
- Если Windows Defender спросит разрешение на доступ к сети, разрешение нужно для получения рыночных данных.
