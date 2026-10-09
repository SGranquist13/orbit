@echo off
rem Runs cargo in src-tauri with a complete MSVC x64 toolchain (VS 2026 here lacks x64 libs).
rem   scripts\cargo.cmd test      scripts\cargo.cmd build
if "%VCVARS%"=="" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
call "%VCVARS%" >nul 2>&1
cd /d "%~dp0..\src-tauri"
cargo %*
