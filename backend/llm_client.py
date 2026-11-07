"""
llm_client.py - Client gọi LLM qua OpenAI-compatible API
Hỗ trợ: Ollama (local), OpenRouter, bất kỳ endpoint OpenAI-compatible nào
"""

import re
import json
import logging
from typing import Optional
from openai import OpenAI, OpenAIError

logger = logging.getLogger(__name__)

# Prompt hệ thống yêu cầu LLM trả đáp án dạng chuẩn
SYSTEM_PROMPT = """Bạn là trợ lý chuyên trả lời câu hỏi trắc nghiệm.

Quy tắc BẮT BUỘC:
1. Phân tích câu hỏi và các lựa chọn cẩn thận.
2. Chọn ĐÚP MỘT đáp án đúng nhất.
3. Trả lời theo đúng định dạng JSON sau, KHÔNG thêm bất kỳ text nào khác:

{
  "answer": "A",
  "reasoning": "Lý do chọn đáp án này",
  "confidence": 0.9
}

Trong đó:
- "answer": chính xác là ký tự đáp án (A, B, C, D hoặc 1, 2, 3, 4) - chỉ 1 ký tự
- "reasoning": giải thích ngắn gọn bằng tiếng Việt
- "confidence": độ tự tin từ 0.0 đến 1.0
"""


class LLMClient:
    """
    Client gọi LLM qua OpenAI-compatible API.
    Hoạt động với Ollama local và OpenRouter cloud.
    """

    def __init__(self, provider: str, base_url: str, api_key: str,
                 model_name: str, temperature: float = 0.3, max_tokens: int = 512):
        """
        Khởi tạo LLM client.
        
        Args:
            provider: 'ollama' | 'openrouter' | 'openai_compatible'
            base_url: URL gốc của API (vd: http://localhost:11434/v1)
            api_key: API key (Ollama dùng 'ollama')
            model_name: Tên model (vd: 'llama3', 'gpt-4o-mini')
            temperature: Độ sáng tạo (0.0 = chắc chắn, 1.0 = sáng tạo)
            max_tokens: Số token tối đa trong response
        """
        self.provider = provider
        self.model_name = model_name
        self.temperature = temperature
        self.max_tokens = max_tokens

        # Chuẩn hóa base_url: Ollama cần /v1 ở cuối
        if provider == "ollama" and not base_url.rstrip("/").endswith("/v1"):
            base_url = base_url.rstrip("/") + "/v1"

        # Khởi tạo OpenAI client (tương thích mọi endpoint OpenAI-compatible)
        self.client = OpenAI(
            base_url=base_url,
            api_key=api_key or "not-needed"
        )

    def ask(
        self,
        question: str,
        options: list[dict],
        context: str = "",
        image_base64: Optional[str] = None
    ) -> dict:
        """
        Gửi câu hỏi trắc nghiệm đến LLM và nhận đáp án.

        Args:
            question: Nội dung câu hỏi
            options: Danh sách lựa chọn [{key: "A", text: "..."}, ...]
            context: Ngữ cảnh bổ sung (nếu có)
            image_base64: Ảnh base64 (nếu câu hỏi dạng hình ảnh)

        Returns:
            {answer: str, reasoning: str, confidence: float}
        """
        # Tạo nội dung câu hỏi dạng text
        options_text = "\n".join([f"{opt['key']}. {opt['text']}" for opt in options])
        user_text = f"Câu hỏi: {question}\n\nCác lựa chọn:\n{options_text}"
        if context:
            user_text = f"Ngữ cảnh: {context}\n\n{user_text}"

        # Xây dựng message gửi lên LLM
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]

        if image_base64:
            # Câu hỏi có hình ảnh: dùng content dạng multipart
            user_content = [
                {"type": "text", "text": user_text},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/jpeg;base64,{image_base64}"
                    }
                }
            ]
            messages.append({"role": "user", "content": user_content})
        else:
            messages.append({"role": "user", "content": user_text})

        try:
            response = self.client.chat.completions.create(
                model=self.model_name,
                messages=messages,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
            )
            raw_text = response.choices[0].message.content.strip()
            return self._parse_response(raw_text)

        except OpenAIError as e:
            logger.error(f"Lỗi gọi LLM API: {e}")
            raise ValueError(f"Lỗi kết nối LLM: {str(e)}")
        except Exception as e:
            logger.error(f"Lỗi không xác định khi gọi LLM: {e}")
            raise ValueError(f"Lỗi hệ thống: {str(e)}")

    def _parse_response(self, raw_text: str) -> dict:
        """
        Phân tích phản hồi từ LLM, trả về dict chuẩn.
        Có fallback nếu LLM không trả đúng định dạng JSON.
        """
        # Thử parse JSON trực tiếp
        try:
            # Tìm JSON block trong response (LLM đôi khi thêm text xung quanh)
            json_match = re.search(r'\{[^{}]+\}', raw_text, re.DOTALL)
            if json_match:
                data = json.loads(json_match.group())
                answer = str(data.get("answer", "")).strip().upper()
                # Normalize: lấy ký tự đầu tiên nếu LLM trả "Option A" thay vì "A"
                if len(answer) > 1:
                    first_char = answer[0]
                    if first_char in "ABCD1234":
                        answer = first_char
                return {
                    "answer": answer,
                    "reasoning": str(data.get("reasoning", "")).strip(),
                    "confidence": float(data.get("confidence", 0.7))
                }
        except (json.JSONDecodeError, ValueError):
            pass

        # Fallback: tìm ký tự đáp án trong text
        logger.warning(f"LLM không trả JSON chuẩn, fallback parse. Raw: {raw_text[:200]}")
        answer = self._extract_answer_fallback(raw_text)
        return {
            "answer": answer,
            "reasoning": raw_text[:300],  # Lấy phần đầu làm reasoning
            "confidence": 0.5             # Confidence thấp vì parse fallback
        }

    def _extract_answer_fallback(self, text: str) -> str:
        """
        Tìm đáp án trong text khi không parse được JSON.
        Ưu tiên tìm pattern như 'Đáp án: A' hoặc 'answer: B'.
        """
        text_upper = text.upper()

        # Tìm pattern: "ĐÁP ÁN: A" hoặc "ANSWER: A" hoặc "CHỌN A"
        patterns = [
            r'(?:ĐÁP ÁN|ANSWER|CHỌN|SELECT|CORRECT)[:\s]+([ABCD1234])',
            r'"ANSWER"\s*:\s*"([ABCD1234])"',
            r'\b([ABCD])\b',   # Ký tự đơn A/B/C/D
        ]
        for pattern in patterns:
            match = re.search(pattern, text_upper)
            if match:
                return match.group(1)

        return "A"  # Mặc định nếu không tìm được
