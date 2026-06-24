# Портативная версия OI Screener для Windows 11

Этот скрипт собирает переносимую папку со скринером, локальным Python и зависимостями.
Python в систему ставить не нужно.

## Сборка

В корне репозитория запусти PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\windows\Build-OI-Screener-Portable.ps1
```

Готовая папка появится здесь:

```text
dist\OIScreenerPortable
```

## Запуск

Открой:

```text
dist\OIScreenerPortable\Start OI Screener.bat
```

Приложение будет доступно по адресу:

```text
http://127.0.0.1:8503
```

## Где хранятся данные

Папка данных создается внутри portable-сборки:

```text
dist\OIScreenerPortable\data
```

Там лежат логи сканов и служебное состояние.
