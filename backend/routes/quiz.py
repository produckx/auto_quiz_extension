"""
routes/quiz.py - Xử lý API giải quiz, xem lịch sử, thống kê
"""

import time
import json
import hashlib
import re
import logging
from typing import Optional, List
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import func

from models import get_db, QuizHistory, AIConfig, QACache
from llm_client import create_llm_client_from_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["Quiz"])


# ==========================================
# Pydantic Schemas (Request / Response validation)
# ==========================================

class OptionItem(BaseModel):
    """Một lựa chọn câu hỏi (ví dụ: A, B, C...)"""
    key: str = Field(..., description="Ký tự đại diện lựa chọn: A, B, C, D...")
    text: str = Field(..., description="Nội dung của lựa chọn")


class AnswerRequest(BaseModel):
    """Dữ liệu câu hỏi gửi lên từ extension"""
    website_url: str = Field(..., description="URL trang web đang làm trắc nghiệm")
    question_text: str = Field(..., description="Nội dung câu hỏi")
    question_type: str = Field(default="text", description="Loại câu hỏi: text, image, table")
    options: List[OptionItem] = Field(..., description="Danh sách các lựa chọn")
    image_base64: Optional[str] = Field(default=None, description="Ảnh base64 nếu câu hỏi có hình ảnh")
    skip_history: bool = Field(default=False, description="Bỏ qua ghi lịch sử (dùng cho test kết nối AI)")
    use_cache: bool = Field(default=True, description="Dùng lại đáp án đã lưu trong database nếu câu hỏi trùng")


class AnswerResponse(BaseModel):
    """Kết quả trả về cho extension"""
    answer_key: str
    reasoning: str
    confidence: float
    response_time_ms: int
    from_cache: bool = False   # True nếu lấy từ database thay vì gọi AI


# ==========================================
# Helper: Cache câu hỏi - đáp án
# ==========================================

def normalize_text(text: str) -> str:
    """Chuẩn hóa text: bỏ khoảng trắng thừa, chữ thường"""
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def compute_question_hash(question_text: str, options: List[OptionItem]) -> str:
    """
    Tính hash SHA-256 của câu hỏi + các lựa chọn để tra cứu cache.
    Chuẩn hóa nội dung để các câu hỏi giống nhau (khác khoảng trắng/hoa thường) khớp cache.
    """
    norm_q = normalize_text(question_text)
    norm_opts = "|".join(
        f"{normalize_text(opt.key)}:{normalize_text(opt.text)}"
        for opt in options
    )
    raw = f"{norm_q}##{norm_opts}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def upsert_cache(db: Session, qhash: str, question_text: str,
                 options_dict_list: List[dict], answer_key: str,
                 reasoning: str, model_name: Optional[str]) -> None:
    """Lưu hoặc cập nhật đáp án vào bảng qa_cache"""
    try:
        existing = db.query(QACache).filter(QACache.question_hash == qhash).first()
        if existing:
            existing.answer_key = answer_key
            existing.reasoning = reasoning
            existing.model_name = model_name
        else:
            db.add(QACache(
                question_hash=qhash,
                question_text=question_text,
                options_json=json.dumps(options_dict_list, ensure_ascii=False),
                answer_key=answer_key,
                reasoning=reasoning,
                model_name=model_name,
                hit_count=0
            ))
        db.commit()
    except Exception as e:
        db.rollback()
        logger.error(f"Lỗi khi lưu cache câu hỏi: {e}")


def save_history(db: Session, payload: AnswerRequest, options_dict_list: List[dict],
                 answer_key: str, model_name: Optional[str], elapsed_ms: int) -> None:
    """Ghi lịch sử giải câu hỏi (bỏ qua nếu skip_history)"""
    if payload.skip_history:
        return
    try:
        db.add(QuizHistory(
            website_url=payload.website_url,
            question_text=payload.question_text,
            question_type=payload.question_type,
            options=json.dumps(options_dict_list, ensure_ascii=False),
            selected_answer=answer_key,
            ai_model_used=model_name,
            response_time_ms=elapsed_ms
        ))
        db.commit()
    except Exception as e:
        db.rollback()
        logger.error(f"Lỗi khi lưu lịch sử câu hỏi: {e}")


# ==========================================
# Endpoints
# ==========================================

@router.post("/answer", response_model=AnswerResponse)
def answer_quiz(payload: AnswerRequest, db: Session = Depends(get_db)):
    """
    POST /api/answer:
    Nhận câu hỏi từ extension. Nếu bật use_cache và câu hỏi đã có trong database
    thì trả lại đáp án ngay (không gọi AI). Ngược lại gọi LLM, lưu cache + lịch sử.
    """
    options_dict_list = [{"key": opt.key, "text": opt.text} for opt in payload.options]
    start_time = time.time()

    # 1. Tra cứu cache nếu được bật (không cần gọi AI -> phản hồi tức thì)
    qhash = compute_question_hash(payload.question_text, payload.options)
    if payload.use_cache:
        cached = db.query(QACache).filter(QACache.question_hash == qhash).first()
        if cached:
            cached.hit_count = (cached.hit_count or 0) + 1
            db.commit()

            elapsed_ms = int((time.time() - start_time) * 1000)
            save_history(db, payload, options_dict_list, cached.answer_key, cached.model_name, elapsed_ms)

            logger.info(f"[Cache HIT] Trả đáp án {cached.answer_key} từ database (hit_count={cached.hit_count})")
            return AnswerResponse(
                answer_key=cached.answer_key,
                reasoning=cached.reasoning or "Lấy từ cơ sở dữ liệu (câu hỏi đã từng giải).",
                confidence=1.0,
                response_time_ms=elapsed_ms,
                from_cache=True
            )

    # 2. Lấy cấu hình AI đang active (chỉ cần khi phải gọi LLM)
    config = db.query(AIConfig).filter(AIConfig.is_active == True).first()
    if not config:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Chưa cấu hình AI! Vui lòng cấu hình provider tại /api/config trước."
        )

    # 3. Tạo LLM client
    try:
        client = create_llm_client_from_config(config)
    except Exception as e:
        logger.error(f"Lỗi khởi tạo LLM Client: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Không thể khởi tạo AI client: {str(e)}"
        )

    # 4. Gọi LLM
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

    elapsed_ms = int((time.time() - start_time) * 1000)
    answer_key = result.get("answer", "")
    reasoning = result.get("reasoning", "")

    # 5. Lưu cache câu hỏi - đáp án để lần sau dùng lại
    upsert_cache(db, qhash, payload.question_text, options_dict_list, answer_key, reasoning, config.model_name)

    # 6. Ghi lịch sử
    save_history(db, payload, options_dict_list, answer_key, config.model_name, elapsed_ms)

    return AnswerResponse(
        answer_key=answer_key,
        reasoning=reasoning,
        confidence=result.get("confidence", 0.0),
        response_time_ms=elapsed_ms,
        from_cache=False
    )


# ==========================================
# Quản lý cache câu hỏi - đáp án
# ==========================================

@router.get("/cache")
def list_cache(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    search: Optional[str] = Query(None, description="Tìm theo nội dung câu hỏi"),
    db: Session = Depends(get_db)
):
    """GET /api/cache: Danh sách câu hỏi - đáp án đã lưu trong database"""
    query = db.query(QACache)
    if search:
        query = query.filter(QACache.question_text.contains(search))

    total = query.count()
    records = query.order_by(QACache.updated_at.desc()) \
                   .offset((page - 1) * page_size).limit(page_size).all()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": (total + page_size - 1) // page_size if total > 0 else 0,
        "items": [{
            "id": r.id,
            "question_text": r.question_text,
            "options": json.loads(r.options_json) if r.options_json else [],
            "answer_key": r.answer_key,
            "reasoning": r.reasoning,
            "model_name": r.model_name,
            "hit_count": r.hit_count,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None
        } for r in records]
    }


@router.get("/cache/stats")
def cache_stats(db: Session = Depends(get_db)):
    """GET /api/cache/stats: Thống kê cache"""
    total = db.query(QACache).count()
    total_hits = db.query(func.sum(QACache.hit_count)).scalar() or 0
    return {
        "total_cached_questions": total,
        "total_reused_hits": int(total_hits)
    }


@router.delete("/cache/{cache_id}")
def delete_cache_item(cache_id: int, db: Session = Depends(get_db)):
    """DELETE /api/cache/{id}: Xóa 1 câu hỏi khỏi cache"""
    record = db.query(QACache).filter(QACache.id == cache_id).first()
    if not record:
        raise HTTPException(status_code=404, detail=f"Không tìm thấy cache id {cache_id}")
    db.delete(record)
    db.commit()
    return {"message": "Đã xóa khỏi cache", "id": cache_id}


@router.delete("/cache")
def clear_cache(db: Session = Depends(get_db)):
    """DELETE /api/cache: Xóa toàn bộ cache câu hỏi - đáp án"""
    deleted = db.query(QACache).delete()
    db.commit()
    return {"message": f"Đã xóa toàn bộ cache ({deleted} câu hỏi)"}


@router.get("/history")
def get_history(
    page: int = Query(1, ge=1, description="Số trang (bắt đầu từ 1)"),
    page_size: int = Query(10, ge=1, le=100, description="Số dòng mỗi trang"),
    url: Optional[str] = Query(None, description="Lọc theo URL website"),
    db: Session = Depends(get_db)
):
    """
    GET /api/history:
    Lấy danh sách lịch sử câu hỏi với phân trang và tìm kiếm theo URL.
    """
    query = db.query(QuizHistory)

    if url:
        query = query.filter(QuizHistory.website_url.contains(url))

    total = query.count()
    records = query.order_by(QuizHistory.created_at.desc()) \
                   .offset((page - 1) * page_size) \
                   .limit(page_size) \
                   .all()

    items = []
    for r in records:
        opts = []
        if r.options:
            try:
                opts = json.loads(r.options)
            except Exception:
                opts = []

        items.append({
            "id": r.id,
            "website_url": r.website_url,
            "question_text": r.question_text,
            "question_type": r.question_type,
            "options": opts,
            "selected_answer": r.selected_answer,
            "correct_answer": r.correct_answer,
            "is_correct": r.is_correct,
            "ai_model_used": r.ai_model_used,
            "response_time_ms": r.response_time_ms,
            "created_at": r.created_at.isoformat() if r.created_at else None
        })

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": (total + page_size - 1) // page_size if total > 0 else 0,
        "items": items
    }


@router.delete("/history/{history_id}")
def delete_history_item(history_id: int, db: Session = Depends(get_db)):
    """
    DELETE /api/history/{id}:
    Xóa 1 record trong lịch sử.
    """
    record = db.query(QuizHistory).filter(QuizHistory.id == history_id).first()
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Không tìm thấy bản ghi lịch sử với id {history_id}"
        )

    db.delete(record)
    db.commit()
    return {"message": "Đã xóa bản ghi thành công", "id": history_id}


@router.get("/stats")
def get_stats(db: Session = Depends(get_db)):
    """
    GET /api/stats:
    Thống kê tổng hợp: tổng câu đã giải, tỉ lệ đúng, thời gian phản hồi TB, thống kê theo domain.
    """
    total_questions = db.query(QuizHistory).count()

    # Tính tỉ lệ đúng nếu có ghi nhận is_correct
    correct_count = db.query(QuizHistory).filter(QuizHistory.is_correct == True).count()
    answered_correctness_known = db.query(QuizHistory).filter(QuizHistory.is_correct != None).count()

    correct_rate = 0.0
    if answered_correctness_known > 0:
        correct_rate = round((correct_count / answered_correctness_known) * 100, 2)

    # Thời gian phản hồi trung bình (ms)
    avg_response_time = db.query(func.avg(QuizHistory.response_time_ms)).scalar()
    avg_response_time_ms = round(avg_response_time, 2) if avg_response_time else 0

    # Phân nhóm theo domain
    all_urls = db.query(QuizHistory.website_url).all()
    domain_counts = {}
    for (item_url,) in all_urls:
        if not item_url:
            continue
        try:
            parsed = urlparse(item_url)
            domain = parsed.netloc or item_url
        except Exception:
            domain = item_url
        domain_counts[domain] = domain_counts.get(domain, 0) + 1

    domains_stats = [
        {"domain": domain, "total_questions": count}
        for domain, count in sorted(domain_counts.items(), key=lambda x: x[1], reverse=True)
    ]

    return {
        "total_questions": total_questions,
        "correct_count": correct_count,
        "correctness_verified_count": answered_correctness_known,
        "correct_rate_percent": correct_rate,
        "avg_response_time_ms": avg_response_time_ms,
        "by_domain": domains_stats
    }
