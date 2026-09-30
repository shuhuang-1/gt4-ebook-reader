@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==================================
echo    GT4 电子书打包工具
echo ==================================
echo.
node mkvol.js --list
echo.
echo 输入要打包的编号，空格分隔（如：1 3）
echo 直接回车 = 全部打包
echo.
set /p IDS=编号:
echo.
node mkvol.js %IDS%
echo.
pause