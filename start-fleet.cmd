@echo off
REM Auto-starts the cortextOS fleet (daemon + dashboard) at user logon.
REM Launched by the "cortextOS fleet" scheduled task. Runs as JasonLinch so
REM Claude Code finds %USERPROFILE%\.claude.json (bypassPermissionsModeAccepted).
REM ecosystem.config.js carries the correct CTX_* defaults, so no env needed.
cd /d C:\Users\JasonLinch\ascendops
call "C:\Users\JasonLinch\AppData\Roaming\npm\pm2.cmd" start ecosystem.config.js
call "C:\Users\JasonLinch\AppData\Roaming\npm\pm2.cmd" save
