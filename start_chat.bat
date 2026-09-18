@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================
echo  MegaChat666 - запуск сервера
echo ================================
python server.py
if errorlevel 1 (
  echo.
  echo [ОШИБКА] Python не найден. Установите Python 3 с https://www.python.org/downloads/
  echo При установке поставьте галочку "Add python.exe to PATH".
)
pause
