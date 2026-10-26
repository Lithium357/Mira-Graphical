@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Mira Graphical.exe" "%~dp0mira-lsp.cjs" --stdio
