@echo off
rem Runs the Tauri CLI with a complete MSVC x64 toolchain on PATH (see vcvars.cmd for how it is found).
call "%~dp0vcvars.cmd"
bun x tauri %*
