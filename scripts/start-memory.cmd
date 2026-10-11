@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -ExecutablePath "%~dp0..\release\0.4.0-evidence-memory\win-unpacked\Morrow.exe"
if errorlevel 1 pause
