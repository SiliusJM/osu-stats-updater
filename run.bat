@echo off
cd /d "%~dp0"

if not exist node_modules (
    echo Instalando dependencias, por favor espera...
    call npm install
    echo.
)

wscript.exe "%~dp0run.vbs"
