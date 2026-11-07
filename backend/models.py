"""
models.py - Định nghĩa các bảng SQLite với SQLAlchemy
"""

import os
import json
from datetime import datetime
from sqlalchemy import (
    create_engine, Column, Integer, String, Float, Boolean,
    Text, DateTime
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

# Đường dẫn file database
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "quiz.db")
DATABASE_URL = f"sqlite:///{DB_PATH}"

# Khởi tạo engine và session
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}  # Cho phép đa luồng với SQLite
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class QuizHistory(Base):
    """Bảng lưu lịch sử câu hỏi và đáp án"""
    __tablename__ = "quiz_history"

    id = Column(Integer, primary_key=True, index=True)
    website_url = Column(String(500), nullable=False, index=True)       # URL trang web
    question_text = Column(Text, nullable=False)                         # Nội dung câu hỏi
    question_type = Column(String(20), default="text")                  # text / image / table
    options = Column(Text, nullable=True)                                # JSON: [{key, text}]
    selected_answer = Column(String(10), nullable=True)                  # Đáp án AI chọn (A/B/C/D)
    correct_answer = Column(String(10), nullable=True)                   # Đáp án đúng (nếu có)
    is_correct = Column(Boolean, nullable=True)                          # Đúng/sai (nếu biết)
    ai_model_used = Column(String(100), nullable=True)                   # Model AI đã dùng
    response_time_ms = Column(Integer, nullable=True)                    # Thời gian phản hồi (ms)
    created_at = Column(DateTime, default=datetime.utcnow)              # Thời điểm tạo


class AIConfig(Base):
    """Bảng lưu cấu hình AI (chỉ 1 row active tại một thời điểm)"""
    __tablename__ = "ai_config"

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(50), nullable=False)           # ollama / openrouter / openai_compatible
    base_url = Column(String(500), nullable=False)          # Base URL của API
    api_key = Column(String(500), nullable=True)            # API key (ẩn khi trả về)
    model_name = Column(String(200), nullable=False)        # Tên model
    temperature = Column(Float, default=0.3)                # Độ sáng tạo (0.0 - 1.0)
    max_tokens = Column(Integer, default=512)               # Số token tối đa
    is_active = Column(Boolean, default=True)               # Config đang dùng
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class QACache(Base):
    """Bảng cache câu hỏi - đáp án đã giải (dùng lại khi gặp câu hỏi trùng)"""
    __tablename__ = "qa_cache"

    id = Column(Integer, primary_key=True, index=True)
    question_hash = Column(String(64), unique=True, index=True, nullable=False)  # SHA-256 của câu hỏi + đáp án
    question_text = Column(Text, nullable=False)             # Nội dung câu hỏi (bản gốc)
    options_json = Column(Text, nullable=True)               # JSON danh sách lựa chọn
    answer_key = Column(String(10), nullable=False)          # Đáp án đã chọn (A/B/C/D)
    reasoning = Column(Text, nullable=True)                  # Lý do của AI
    model_name = Column(String(200), nullable=True)          # Model đã dùng
    hit_count = Column(Integer, default=0)                   # Số lần được dùng lại
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


def get_db():
    """Dependency injection: lấy DB session cho mỗi request"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Tạo tất cả bảng nếu chưa tồn tại"""
    # Đảm bảo thư mục data tồn tại
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    Base.metadata.create_all(bind=engine)
