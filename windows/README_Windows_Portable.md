# Портативное приложение для Windows 11

Этот вариант собирает переносимую папку с приложением, локальным Python, зависимостями, моделями и журналами. Python не нужно устанавливать в систему.

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
