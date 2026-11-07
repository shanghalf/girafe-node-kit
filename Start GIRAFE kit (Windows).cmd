@echo off
rem Double-click to start the GIRAFE node kit.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start.ps1"
if errorlevel 1 pause
