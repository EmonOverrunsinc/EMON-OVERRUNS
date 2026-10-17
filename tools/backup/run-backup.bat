@echo off
rem EMON OVERRUNS E-Portal backup. Double-click to run, or let Windows Task Scheduler run it every day.
cd /d "%~dp0"
if not exist node_modules\pg call npm install --no-audit --no-fund
node backup.mjs
if "%1"=="" pause
