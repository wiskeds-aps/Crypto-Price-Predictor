# Портативная версия CryptoScreener для Windows 11

Сборка создаёт переносимую папку с локальным Python, зависимостями и приложением.
Python в систему устанавливать не нужно.

## Сборка

В корне репозитория запусти PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\windows\Build-CryptoScreener-Portable.ps1
```

Готовая папка появится здесь:

```text
dist\CryptoScreenerPortable
```

## Запуск

Открой:

```text
dist\CryptoScreenerPortable\Start CryptoScreener.bat
```

Приложение будет доступно по адресу:

```text
http://127.0.0.1:8000
```

## Telegram

Если нужны Telegram-уведомления, скопируй:

```text
dist\CryptoScreenerPortable\.env.example
```

в:

```text
dist\CryptoScreenerPortable\.env
```

и заполни `TELEGRAM_TOKEN` и `TELEGRAM_CHAT_ID`.

## Данные

SQLite-база создаётся внутри portable-сборки:

```text
dist\CryptoScreenerPortable\data\crypto.db
```
