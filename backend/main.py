"""
main.py - Entry point chính của ứng dụng FastAPI cho Duck Quiz Agent
"""

import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from models import init_db
from routes.quiz import router as quiz_router
from routes.config import router as config_router

# Thiết lập logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("AIQuizBackend")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Quản lý vòng đời ứng dụng: khởi tạo cơ sở dữ liệu khi khởi động"""
    logger.info("Đang khởi tạo cơ sở dữ liệu SQLite...")
    init_db()
    logger.info("Cơ sở dữ liệu đã sẵn sàng.")
    yield
    logger.info("Backend đang tắt...")


# Khởi tạo FastAPI app
app = FastAPI(
    title="Duck Quiz Agent Backend",
    description="Backend API hỗ trợ giải câu hỏi trắc nghiệm tự động qua LLM cho Chrome Extension",
    version="1.0.0",
    lifespan=lifespan
)

# Cấu hình CORS: Cho phép Chrome Extension và local development truy cập
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Hỗ trợ chrome-extension://* và localhost
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Middleware bắt exception toàn cục và trả về lỗi chuẩn dạng JSON
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Lỗi chưa xử lý tại {request.url.path}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": f"Lỗi máy chủ nội bộ: {str(exc)}"}
    )


# Mount các router
app.include_router(quiz_router)
app.include_router(config_router)


@app.get("/")
def root():
    """Kiểm tra tình trạng hoạt động của server"""
    return {
        "status": "online",
        "app": "Duck Quiz Agent Backend",
        "version": "1.0.0"
    }


if __name__ == "__main__":
    import uvicorn
    # Chạy trên port 8765
    uvicorn.run("main:app", host="127.0.0.1", port=8765, reload=True)
