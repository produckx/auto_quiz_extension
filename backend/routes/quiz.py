"""
routes/quiz.py - API giải quiz (stateless, không dùng database)
Extension gửi kèm cấu hình AI; backend chỉ gọi LLM và trả đáp án.
"""

import time
import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from llm_client import LLMClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["Quiz"])


# ==========================================
# Pydantic Schemas (Request / Response validation)
# ==========================================

class OptionItem(BaseModel):
    """Một lựa chọn câu hỏi (ví dụ: A, B, C...)"""
    key: str = Field(..., description="Ký tự đại diện lựa chọn: A, B, C, D...")
    text: str = Field(..., description="Nội dung của lựa chọn")


class AIConfigPayload(BaseModel):
    """Cấu hình AI do extension gửi lên (lưu tại chrome.storage.local)"""
    provider: str = Field(default="openai_compatible", description="ollama | openrouter | openai_compatible")
    base_url: str = Field(..., description="Base URL của API endpoint")
    api_key: Optional[str] = Field(default=None, description="API Key (Ollama có thể để trống)")
    model_name: str = Field(..., description="Tên model")
    temperature: float = Field(default=0.3, ge=0.0, le=2.0)
    max_tokens: int = Field(default=512, ge=16, le=32768)


class AnswerRequest(BaseModel):
    """Dữ liệu câu hỏi gửi lên từ extension"""
    website_url: str = Field(..., description="URL trang web đang làm trắc nghiệm")
    question_text: str = Field(..., description="Nội dung câu hỏi")
    question_type: str = Field(default="text", description="Loại câu hỏi: text, image, table")
    options: List[OptionItem] = Field(..., description="Danh sách các lựa chọn")
    image_base64: Optional[str] = Field(default=None, description="Ảnh base64 nếu câu hỏi có hình ảnh")
    ai_config: Optional[AIConfigPayload] = Field(default=None, description="Cấu hình AI do extension gửi kèm")


class AnswerResponse(BaseModel):
    """Kết quả trả về cho extension"""
    answer_key: str
    reasoning: str
    confidence: float
    response_time_ms: int
    from_cache: bool = False


# ==========================================
# Endpoints
# ==========================================

@router.post("/answer", response_model=AnswerResponse)
def answer_quiz(payload: AnswerRequest):
    """
    POST /api/answer:
    Nhận câu hỏi + cấu hình AI từ extension, gọi LLM và trả đáp án.
    Không ghi database; lịch sử và cache do extension tự quản lý.
    """
    cfg = payload.ai_config
    if not cfg:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Thiếu cấu hình AI. Vui lòng lưu cấu hình AI trong extension trước."
        )

    options_dict_list = [{"key": opt.key, "text": opt.text} for opt in payload.options]
    start_time = time.time()

    # Tạo LLM client từ cấu hình extension gửi lên
    try:
        client = LLMClient(
            provider=cfg.provider,
            base_url=cfg.base_url,
            api_key=cfg.api_key or "",
            model_name=cfg.model_name,
            temperature=cfg.temperature,
            max_tokens=cfg.max_tokens
        )
    except Exception as e:
        logger.error(f"Lỗi khởi tạo LLM Client: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Không thể khởi tạo AI client: {str(e)}"
        )

    # Gọi LLM
    try:
        result = client.ask(
            question=payload.question_text,
            options=options_dict_list,
            image_base64=payload.image_base64 if payload.question_type == "image" else None
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Lỗi khi gọi AI: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Lỗi khi xử lý câu hỏi: {str(e)}"
        )

    return AnswerResponse(
        answer_key=result.get("answer", ""),
        reasoning=result.get("reasoning", ""),
        confidence=result.get("confidence", 0.0),
        response_time_ms=int((time.time() - start_time) * 1000),
        from_cache=False
    )
