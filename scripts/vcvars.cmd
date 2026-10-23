@echo off
rem Puts the MSVC x64 toolchain on PATH for the calling script. Used by cargo.cmd and tauri.cmd.
rem Order: cl.exe already on PATH (e.g. a Developer Command Prompt) -> %VCVARS% -> vswhere -> default path.
rem VS 2022 ([17,18)) is preferred over newer installs, some of which ship without the x64 libs.
where cl.exe >nul 2>&1
if not errorlevel 1 goto :tools
if not "%VCVARS%"=="" goto :load
set "VSDIR=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer"
if not exist "%VSDIR%\vswhere.exe" goto :fallback
rem Run vswhere from its own folder so the command line needs no quoted path (cmd's quote rules and the
rem parentheses in "Program Files (x86)" break a quoted path inside for /f).
pushd "%VSDIR%"
set "VSPATH="
for /f "usebackq delims=" %%i in (`.\vswhere.exe -latest -products * -version "[17.0,18.0)" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if defined VSPATH goto :found
for /f "usebackq delims=" %%i in (`.\vswhere.exe -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
:found
popd
if defined VSPATH set "VCVARS=%VSPATH%\VC\Auxiliary\Build\vcvars64.bat"
:fallback
if "%VCVARS%"=="" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
:load
call "%VCVARS%" >nul 2>&1
:tools
rem Voice input builds whisper.cpp: it needs CMake, and bindgen needs libclang (LLVM).
where cmake.exe >nul 2>&1
if errorlevel 1 if exist "%ProgramFiles%\CMake\bin\cmake.exe" set "PATH=%PATH%;%ProgramFiles%\CMake\bin"
where cmake.exe >nul 2>&1
if errorlevel 1 if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\cmake.exe" set "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Links"
if "%LIBCLANG_PATH%"=="" if exist "%ProgramFiles%\LLVM\bin\libclang.dll" set "LIBCLANG_PATH=%ProgramFiles%\LLVM\bin"
exit /b 0
