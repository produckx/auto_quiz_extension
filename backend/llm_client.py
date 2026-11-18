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
- "answer": key của lựa chọn đúng nhất, đúng nguyên văn key trong danh sách lựa chọn (ví dụ A, B, C, D hoặc 1, 2, 3)
- "reasoning": giải thích ngắn gọn bằng tiếng Việt
- "confidence": độ tự tin từ 0.0 đến 1.0
"""

# Prompt cho câu hỏi tự luận / điền đáp án (không có lựa chọn)
SYSTEM_PROMPT_TEXT_ANSWER = """Bạn là trợ lý chuyên trả lời câu hỏi tự luận ngắn và điền đáp án.

Quy tắc BẮT BUỘC:
1. Đọc câu hỏi và trả lời chính xác, ngắn gọn.
2. Chỉ trả về đúng nội dung cần điền (số, từ, cụm từ hoặc câu ngắn), không thêm tiền tố như "Đáp án:".
3. Trả lời bằng đúng ngôn ngữ của câu hỏi.
4. Trả lời theo đúng định dạng JSON sau, KHÔNG thêm bất kỳ text nào khác:

{
  "answer": "nội dung cần điền",
  "reasoning": "Lý do/giải thích ngắn gọn",
  "confidence": 0.9
}
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
        if options:
            options_text = "\n".join([f"{opt['key']}. {opt['text']}" for opt in options])
            user_text = f"Câu hỏi: {question}\n\nCác lựa chọn:\n{options_text}"
        else:
            # Câu hỏi tự luận / điền đáp án: không có lựa chọn
            user_text = f"Câu hỏi: {question}\n\nHãy trả lời ngắn gọn nội dung cần điền."
        if context:
            user_text = f"Ngữ cảnh: {context}\n\n{user_text}"

        # Xây dựng message gửi lên LLM
        system_prompt = SYSTEM_PROMPT if options else SYSTEM_PROMPT_TEXT_ANSWER
        messages = [{"role": "system", "content": system_prompt}]

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

            # Một số endpoint/proxy trả choices rỗng hoặc message.content = None
            if not getattr(response, "choices", None):
                raise ValueError("LLM không trả về lựa chọn nào (choices rỗng).")

            choice = response.choices[0]
            message = choice.message
            raw_text = (message.content or "").strip()

            # Reasoning model/proxy có thể chỉ trả reasoning_content/reasoning
            if not raw_text:
                raw_text = (
                    getattr(message, "reasoning_content", None)
                    or getattr(message, "reasoning", None)
                    or ""
                ).strip()

            if not raw_text:
                finish_reason = getattr(choice, "finish_reason", "unknown")
                logger.error(f"LLM trả về nội dung rỗng (finish_reason={finish_reason}).")
                raise ValueError(
                    f"LLM trả về nội dung rỗng (finish_reason={finish_reason}). "
                    "Kiểm tra model/endpoint hoặc tăng max_tokens."
                )

            valid_keys = [str(opt["key"]) for opt in options] if options else []
            return self._parse_response(raw_text, valid_keys)

        except ValueError:
            raise
        except OpenAIError as e:
            logger.error(f"Lỗi gọi LLM API: {e}")
            raise ValueError(f"Lỗi kết nối LLM: {str(e)}")
        except Exception as e:
            logger.error(f"Lỗi không xác định khi gọi LLM: {e}")
            raise ValueError(f"Lỗi hệ thống: {str(e)}")

    def _parse_response(self, raw_text: str, valid_keys=None) -> dict:
        """
        Phân tích phản hồi từ LLM, trả về dict chuẩn.
        - Có valid_keys (trắc nghiệm/dropdown/sao): chuẩn hóa đáp án về đúng key.
        - Không có valid_keys (tự luận): giữ nguyên nội dung trả lời.
        """
        valid_keys = [str(k).upper() for k in (valid_keys or [])]

        # Thử parse JSON trực tiếp
        try:
            # Tìm JSON block trong response (LLM đôi khi thêm text xung quanh)
            json_match = re.search(r'\{[^{}]+\}', raw_text, re.DOTALL)
            if json_match:
                data = json.loads(json_match.group())
                raw_answer = str(data.get("answer", "")).strip()

                if valid_keys:
                    answer = raw_answer.upper()
                    if answer not in valid_keys:
                        # LLM có thể trả "Option A" thay vì "A" -> lấy ký tự đầu nếu hợp lệ
                        first_char = answer[:1]
                        answer = first_char if first_char in valid_keys else answer
                else:
                    answer = raw_answer

                return {
                    "answer": answer,
                    "reasoning": str(data.get("reasoning", "")).strip(),
                    "confidence": float(data.get("confidence", 0.7))
                }
        except (json.JSONDecodeError, ValueError):
            pass

        logger.warning(f"LLM không trả JSON chuẩn, fallback parse. Raw: {raw_text[:200]}")

        # Fallback cho câu hỏi tự luận: dùng nguyên văn phản hồi
        if not valid_keys:
            return {
                "answer": raw_text.strip()[:500],
                "reasoning": "LLM không trả JSON chuẩn, dùng nguyên văn phản hồi.",
                "confidence": 0.5
            }

        # Fallback: tìm ký tự đáp án trong text
        answer = self._extract_answer_fallback(raw_text, valid_keys)
        return {
            "answer": answer,
            "reasoning": raw_text[:300],  # Lấy phần đầu làm reasoning
            "confidence": 0.5             # Confidence thấp vì parse fallback
        }

    def _extract_answer_fallback(self, text: str, valid_keys) -> str:
        """
        Tìm đáp án trong text khi không parse được JSON.
        Ưu tiên pattern như 'Đáp án: A' hoặc 'answer: B'.
        """
        text_upper = text.upper()

        # Tìm pattern: "ĐÁP ÁN: A" hoặc "ANSWER: A" hoặc "CHỌN A"
        patterns = [
            r'(?:ĐÁP ÁN|ANSWER|CHỌN|SELECT|CORRECT)[:\s]+([A-Z0-9]+)',
            r'"ANSWER"\s*:\s*"([^"]+)"',
        ]
        for pattern in patterns:
            match = re.search(pattern, text_upper)
            if match:
                candidate = match.group(1).strip()
                if candidate in valid_keys:
                    return candidate
                if candidate[:1] in valid_keys:
                    return candidate[:1]

        # Tìm key xuất hiện đơn lẻ trong text
        for key in valid_keys:
            if re.search(rf'(^|[^A-Z0-9]){re.escape(key)}([^A-Z0-9]|$)', text_upper):
                return key

        return valid_keys[0] if valid_keys else ""
