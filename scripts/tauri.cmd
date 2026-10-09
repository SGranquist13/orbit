@echo off
rem Runs the Tauri CLI with a complete MSVC x64 toolchain on PATH.
rem VS 2026 on this machine lacks the x64 libs (msvcrt.lib), so prefer VS 2022 unless VCVARS is set.
if "%VCVARS%"=="" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
call "%VCVARS%" >nul 2>&1
bun x tauri %*
