@echo off
REM Opens the Affidavit Filler in Chrome (or Edge, or the default browser). Runs fully offline.
cd /d "%~dp0"
set "PAGE=%~dp0Affidavit Filler.html"

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%PAGE%"
  goto :eof
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%PAGE%"
  goto :eof
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%PAGE%"
  goto :eof
)
start "" "%PAGE%"
