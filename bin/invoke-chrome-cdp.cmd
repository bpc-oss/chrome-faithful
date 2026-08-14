@echo off
REM Chrome Faithful - MCP server launcher (stdio transport)
REM Resolves the plugin root from this script's location, so it works from any checkout.
REM Requires: Node.js >= 20 and a configured bridge (started automatically if port 18755 is free).
setlocal
set "PLUGIN_DIR=%~dp0.."
set "NODE_EXE=node"

REM Start the bridge if it is not already listening on the default port.
netstat -an | findstr "18755" >nul 2>&1
if errorlevel 1 (
    start /b "" "%NODE_EXE%" "%PLUGIN_DIR%\src\bridge-server.mjs" >nul 2>&1
    timeout /t 2 /nobreak >nul
)

REM Start MCP server (stdio)
"%NODE_EXE%" "%PLUGIN_DIR%\src\mcp-server.mjs" %*
