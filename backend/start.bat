@echo off
chcp 65001 >nul
title Duck Quiz Agent - Backend FastAPI
cd /d %~dp0

REM Kiểm tra virtualenv
if exist "venv\Scripts\python.exe" (
    echo [AI Quiz] Dùng Python từ virtualenv...
    set PYTHON=venv\Scripts\python.exe
) else (
    echo [AI Quiz] Dùng Python hệ thống...
    set PYTHON=python
)

REM Chạy backend trên 127.0.0.1:8765
echo [AI Quiz] Khởi động FastAPI tại http://127.0.0.1:8765
echo [AI Quiz] Nhấn Ctrl+C để dừng.
echo.
%PYTHON% -m uvicorn main:app --host 127.0.0.1 --port 8765 --reload

pause
