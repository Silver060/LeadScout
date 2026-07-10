@echo off
rem Weekly Lead Scout run — point Windows Task Scheduler at this file.
cd /d "%~dp0"
node agent\run.js --trigger=cron >> data\run-history.log 2>&1
