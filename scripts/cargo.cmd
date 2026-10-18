@echo off
rem Runs cargo in src-tauri with a complete MSVC x64 toolchain.
rem   scripts\cargo.cmd test      scripts\cargo.cmd build
rem Toolchain lookup is in vcvars.cmd: cl.exe already on PATH, then %VCVARS% (path to vcvars64.bat),
rem then vswhere (VS 2022 preferred), then the default VS 2022 Community path.
call "%~dp0vcvars.cmd"
cd /d "%~dp0..\src-tauri"
cargo %*
