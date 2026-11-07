"""
routes/config.py - Quản lý cấu hình AI (Provider, Base URL, API Key, Model)
"""

import logging
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from models import get_db, AIConfig

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/config", tags=["Config"])

# Danh sách provider mẫu gợi ý cho frontend / extension
PRESET_PROVIDERS = [
    {
        "provider": "ollama",
        "name": "Ollama (Local)",
        "base_url": "http://localhost:11434/v1",
        "requires_api_key": False,
        "default_models": ["llama3", "mistral", "qwen2.5:7b", "llava"]
    },
    {
        "provider": "openrouter",
        "name": "OpenRouter (Cloud)",
        "base_url": "https://openrouter.ai/api/v1",
        "requires_api_key": True,
        "default_models": [
            "openai/gpt-4o-mini",
            "anthropic/claude-3.5-sonnet",
            "meta-llama/llama-3.1-8b-instruct",
            "google/gemini-flash-1.5"
        ]
    },
    {
        "provider": "openai_compatible",
        "name": "OpenAI-Compatible Custom",
        "base_url": "https://api.openai.com/v1",
        "requires_api_key": True,
        "default_models": ["gpt-4o-mini", "gpt-3.5-turbo"]
    }
]


# ==========================================
# Pydantic Schemas
# ==========================================

class ConfigSaveRequest(BaseModel):
    """Payload lưu cấu hình AI"""
    provider: Optional[str] = Field(default=None, description="Tự suy ra theo URL nếu không truyền")
    base_url: str = Field(..., description="Base URL của API endpoint")
    api_key: Optional[str] = Field(default=None, description="API Key. Nếu gửi '***' sẽ giữ nguyên key cũ")
    model_name: str = Field(..., description="Tên model")
    temperature: Optional[float] = Field(default=None, ge=0.0, le=2.0, description="Độ sáng tạo (giữ cấu hình cũ nếu không truyền)")
    max_tokens: Optional[int] = Field(default=None, ge=16, le=32768, description="Giới hạn token (giữ cấu hình cũ nếu không truyền)")


class ConfigResponse(BaseModel):
    """Thông tin cấu hình trả về (ẩn API key)"""
    id: Optional[int] = None
    provider: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None  # Luôn trả về '***' nếu đã có key, hoặc null
    model_name: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    is_active: Optional[bool] = None


# ==========================================
# Endpoints
# ==========================================

@router.get("", response_model=Optional[ConfigResponse])
def get_current_config(db: Session = Depends(get_db)):
    """
    GET /api/config:
    Lấy cấu hình AI đang kích hoạt (active).
    API key được che giấu thành '***' để đảm bảo bảo mật.
    """
    config = db.query(AIConfig).filter(AIConfig.is_active == True).first()
    if not config:
        return None

    masked_key = "***" if (config.api_key and config.api_key.strip()) else None

    return ConfigResponse(
        id=config.id,
        provider=config.provider,
        base_url=config.base_url,
        api_key=masked_key,
        model_name=config.model_name,
        temperature=config.temperature,
        max_tokens=config.max_tokens,
        is_active=config.is_active
    )


def infer_provider(base_url: str) -> str:
    """Suy ra loại endpoint từ URL để UI không cần chọn provider riêng."""
    normalized = (base_url or "").strip().lower()
    if "openrouter.ai" in normalized:
        return "openrouter"
    if "localhost:11434" in normalized or "127.0.0.1:11434" in normalized:
        return "ollama"
    return "openai_compatible"


@router.post("", response_model=ConfigResponse)
def save_config(payload: ConfigSaveRequest, db: Session = Depends(get_db)):
    """
    POST /api/config:
    Lưu cấu hình AI mới. Nếu đã có cấu hình cũ, cập nhật hoặc vô hiệu hóa cấu hình cũ.
    Duy trì 1 record duy nhất active.
    """
    current_active = db.query(AIConfig).filter(AIConfig.is_active == True).first()
    provider = payload.provider or infer_provider(payload.base_url)

    # Giữ API key cũ nếu gửi '***' hoặc bỏ trống khi đã có key.
    final_api_key = payload.api_key
    if current_active and current_active.api_key and payload.api_key in (None, "", "***"):
        final_api_key = current_active.api_key
    elif provider == "ollama" and not final_api_key:
        final_api_key = "ollama"  # Ollama chấp nhận bất kỳ key nào

    temperature = payload.temperature
    max_tokens = payload.max_tokens
    if current_active:
        temperature = temperature if temperature is not None else current_active.temperature
        max_tokens = max_tokens if max_tokens is not None else current_active.max_tokens
    else:
        temperature = temperature if temperature is not None else 0.3
        max_tokens = max_tokens if max_tokens is not None else 512

    if current_active:
        # Cập nhật record đang active
        current_active.provider = provider
        current_active.base_url = payload.base_url.rstrip("/")
        current_active.api_key = final_api_key
        current_active.model_name = payload.model_name
        current_active.temperature = temperature
        current_active.max_tokens = max_tokens
        db.commit()
        db.refresh(current_active)
        target = current_active
    else:
        # Tạo mới bản ghi cấu hình đầu tiên
        new_config = AIConfig(
            provider=provider,
            base_url=payload.base_url.rstrip("/"),
            api_key=final_api_key,
            model_name=payload.model_name,
            temperature=temperature,
            max_tokens=max_tokens,
            is_active=True
        )
        db.add(new_config)
        db.commit()
        db.refresh(new_config)
        target = new_config

    masked_key = "***" if (target.api_key and target.api_key.strip()) else None

    return ConfigResponse(
        id=target.id,
        provider=target.provider,
        base_url=target.base_url,
        api_key=masked_key,
        model_name=target.model_name,
        temperature=target.temperature,
        max_tokens=target.max_tokens,
        is_active=target.is_active
    )


@router.get("/providers")
def get_providers_list():
    """
    GET /api/config/providers:
    Trả về danh sách các provider mẫu cùng base_url và gợi ý model để frontend dễ lựa chọn.
    """
    return {
        "providers": PRESET_PROVIDERS
    }
