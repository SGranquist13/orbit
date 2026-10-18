@echo off
rem Runs the Tauri CLI with a complete MSVC x64 toolchain on PATH (see vcvars.cmd for how it is found).
call "%~dp0vcvars.cmd"
rem Release builds: rewrite the builder's home folder (cargo registry, rustup) to "~" in embedded
rem source paths, so the shipped binary does not carry the local username.
if /I "%~1"=="build" set "RUSTFLAGS=%RUSTFLAGS% --remap-path-prefix=%USERPROFILE%=~"
bun x tauri %*
