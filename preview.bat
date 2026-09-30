@echo off
chcp 65001 >nul
cd /d "%~dp0\entry\src\main\js\MainAbility\pages\index"
echo export default [];> books.js
echo preview mode: books.js cleared
pause