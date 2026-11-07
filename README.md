# Duck Quiz Agent

Duck Quiz Agent là dự án gồm Chrome Extension Manifest V3 và backend Python FastAPI. Extension thao tác trực tiếp trên tab Chrome/Brave đang mở; backend kết nối tới Ollama local hoặc API tương thích OpenAI như OpenRouter. Backend không dùng database: cấu hình AI, lịch sử và cache câu hỏi–đáp án được lưu trong `chrome.storage.local`.

> Chỉ sử dụng trên bài kiểm tra/form mà bạn được phép tự động hóa. AI có thể trả lời sai; hãy kiểm tra lại đáp án trước khi nộp.

## Tính năng

- Đọc nội dung câu hỏi và lựa chọn trên trang; hỗ trợ văn bản, một số ảnh và bảng HTML.
- Dùng Element Picker để chọn phần tử cha chứa câu hỏi và các đáp án.
- Gửi câu hỏi tới backend chạy trên máy cục bộ; backend gọi Ollama, OpenRouter hoặc endpoint OpenAI-compatible.
- Chọn đáp án trên trang và chạy Auto Agent. Hỗ trợ trang có nhiều câu cuộn và trang có nút chuyển tiếp khi cấu trúc website cho phép nhận diện.
- Có tùy chọn tự chuyển trang, trả lời bằng AI hoặc chọn ngẫu nhiên.
- Lưu lịch sử và cache câu hỏi–đáp án trong `chrome.storage.local`. Khi bật cache, câu hỏi cùng nội dung và lựa chọn có thể được trả lời từ cache mà không cần gọi LLM.
- Cấu hình URL, API key và tên model trong popup Extension (lưu cục bộ, không gửi vào database).

## Cấu trúc thư mục

```text
AI_Quiz/
├── backend/
│   ├── main.py                 # FastAPI app, mặc định cổng 8765
│   ├── llm_client.py           # Client OpenAI-compatible cho LLM
│   ├── requirements.txt
│   ├── start.bat               # Khởi động backend trên Windows
│   └── routes/
│       └── quiz.py             # API trả lời câu hỏi (stateless)
└── extension/
    ├── manifest.json           # Khai báo Chrome Extension Manifest V3
    ├── config.js               # Biến môi trường (BACKEND_URL, giới hạn lịch sử/cache)
    ├── background.js           # Gọi backend, chrome.storage.local và điều phối message
    ├── content.js              # Đọc trang, Widget, Element Picker và thao tác DOM
    ├── content.css
    ├── popup.html
    ├── popup.js
    ├── popup.css
    └── icons/
```

## Yêu cầu

- Windows 10/11.
- Python 3.10 trở lên.
- Chrome hoặc Brave hỗ trợ Chrome Extension Manifest V3.
- Một LLM endpoint tương thích OpenAI. Có thể dùng Ollama local hoặc dịch vụ cloud như OpenRouter. Dịch vụ cloud cần kết nối Internet và API key tương ứng.

## Cài đặt và chạy backend

Mở PowerShell tại thư mục dự án:

```powershell
cd d:\App\Extension\AI_Quiz\backend
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
```

Sau khi cài dependencies lần đầu, khởi động backend bằng cách chạy:

```text
backend\start.bat
```

Hoặc chạy trực tiếp trong PowerShell:

```powershell
cd d:\App\Extension\AI_Quiz\backend
.\venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8765
```

Backend mặc định lắng nghe tại `http://127.0.0.1:8765`. Kiểm tra nhanh bằng cách mở URL này; response mong đợi có `"status": "online"`. Tài liệu API Swagger có tại `http://127.0.0.1:8765/docs`.

Backend không tạo database. Toàn bộ dữ liệu của Extension (cấu hình AI, lịch sử, cache) nằm trong `chrome.storage.local` và có thể xóa bằng cách gỡ Extension hoặc xóa dữ liệu Extension trong Chrome.

### Đổi địa chỉ backend

Địa chỉ backend dùng chung được khai báo trong file:

```text
extension\config.js
```

```js
const APP_CONFIG = {
  BACKEND_URL: "http://127.0.0.1:8765",
  HISTORY_LIMIT: 500,
  CACHE_LIMIT: 500
};
```

Chrome Extension không hỗ trợ file `.env` khi chạy runtime, nên `config.js` đóng vai trò file biến môi trường tĩnh. Sau khi sửa, vào `chrome://extensions/` bấm **Reload** cho Extension. Nếu đổi host/port, cập nhật đồng thời lệnh chạy backend (hoặc `start.bat`).

### Dùng Ollama local

1. Cài và chạy Ollama.
2. Tải một model phù hợp, ví dụ:

   ```powershell
   ollama pull qwen2.5:7b
   ```

3. Đảm bảo Ollama đang phục vụ tại `http://localhost:11434`.
4. Trong popup Extension, dùng API URL `http://localhost:11434/v1`, API key để trống và tên model đúng với model đã tải (ví dụ `qwen2.5:7b`).

Hỗ trợ đọc ảnh phụ thuộc vào model Vision và khả năng endpoint tương thích OpenAI nhận nội dung ảnh. Ví dụ model văn bản thuần có thể không phân tích được ảnh.

### Dùng OpenRouter hoặc endpoint khác

Trong popup, điền URL API tương thích OpenAI, API key và đúng tên model của nhà cung cấp. Ví dụ OpenRouter thường dùng URL `https://openrouter.ai/api/v1`. Backend tự nhận diện OpenRouter dựa vào URL; URL khác được xem là endpoint OpenAI-compatible.

## Cài Extension vào Chrome/Brave

1. Khởi động backend trước.
2. Mở `chrome://extensions/` trên Chrome hoặc `brave://extensions/` trên Brave.
3. Bật **Developer mode**.
4. Chọn **Load unpacked**.
5. Chọn đúng thư mục `d:\App\Extension\AI_Quiz\extension`.
6. Sau khi thay đổi code Extension, bấm **Reload** ở trang quản lý Extension rồi tải lại tab website cần dùng.

Extension không mở trình duyệt riêng và không dùng Playwright/CDP; content script chạy trong tab hiện tại. Trình duyệt không cho Extension inject vào một số trang đặc biệt như `chrome://` và Chrome Web Store.

## Cấu hình và sử dụng

1. Mở một trang quiz/form mà bạn được phép thao tác.
2. Bấm biểu tượng Duck Quiz Agent trên thanh công cụ, vào tab **Cấu hình AI**.
3. Điền ba trường:
   - **API URL**: URL OpenAI-compatible; Ollama thường là `http://localhost:11434/v1`.
   - **API Key**: để trống với Ollama nếu không yêu cầu; nhập key cho dịch vụ cần xác thực.
   - **Tên Model**: tên chính xác mà endpoint cung cấp.
4. Bấm **Lưu cấu hình**. Khung **Cấu hình đang sử dụng** hiển thị trạng thái, URL, loại endpoint được suy ra, model và trạng thái API key (không hiển thị giá trị key).
5. Có thể bấm **Test kết nối AI** để gửi câu hỏi thử. Request test không lưu vào lịch sử và bỏ qua cache.
6. Dùng nút **Chọn Câu Hỏi** rồi click vùng cha chứa câu hỏi và lựa chọn. Nhấn `ESC` để hủy Element Picker.
7. Chọn cách trả lời:
   - **Độ tin cậy cao nhất**: gửi câu hỏi đến LLM để phân tích.
   - **Chọn ngẫu nhiên**: chọn ngẫu nhiên một lựa chọn, không gọi LLM.
8. Bật **Auto Agent** nếu muốn xử lý nhiều câu. Có thể cấu hình độ trễ, tự Next trang và tái sử dụng Cache. Extension không tự bấm nộp bài.

### Lưu ý về tự động hóa

- Extension không có tính năng tự nộp bài; bạn tự bấm nút Gửi/Nộp trên trang khi đã kiểm tra xong.
- Nhận diện câu hỏi và nút Next phụ thuộc cấu trúc DOM, ngôn ngữ và thiết kế từng website. Không có selector chung đảm bảo hoạt động trên mọi hệ thống; dùng Element Picker hoặc điều khiển thủ công nếu trang không nhận diện đúng.
- Nút **Chọn Câu Hỏi** là Element Picker để chọn vùng DOM; nó không có nghĩa chỉ chọn text bằng cách bôi đen.
- Cache chỉ khớp khi nội dung câu hỏi và danh sách lựa chọn sau chuẩn hóa khớp nhau. Lần đầu gặp câu hỏi, backend gọi AI rồi Extension mới lưu đáp án vào `chrome.storage.local` để tái sử dụng.
- Câu trả lời từ cache là đáp án đã lưu trước đó, không được xác minh độc lập là đúng. Có thể tắt switch **Cache** hoặc xóa dữ liệu Extension để làm mới.

## API backend chính

Các endpoint đều dùng base URL `http://127.0.0.1:8765`.

| Method | Endpoint | Mục đích |
|---|---|---|
| `GET` | `/` | Kiểm tra backend hoạt động |
| `POST` | `/api/answer` | Trả lời câu hỏi; nhận kèm `ai_config` từ Extension |

Backend stateless: không có endpoint lưu cấu hình, lịch sử hay cache. Extension quản lý các dữ liệu này trong `chrome.storage.local`.

Chi tiết request/response và thử API trực tiếp tại `http://127.0.0.1:8765/docs`.

## Khắc phục lỗi thường gặp

### Popup báo Backend offline

- Xác nhận cửa sổ backend đang chạy và không đóng.
- Kiểm tra URL `http://127.0.0.1:8765/`.
- Kiểm tra port 8765 có bị chương trình khác chiếm dụng không.

### Lỗi gọi LLM

- Kiểm tra URL API, model name và API key.
- Với Ollama, xác nhận model đã tải bằng `ollama list` và Ollama đang chạy.
- Bấm **Test kết nối AI** để xem lỗi trả về từ backend/LLM.

### Không thấy Widget hoặc không nhận diện câu hỏi

- Reload Extension tại `chrome://extensions/` hoặc `brave://extensions/`, sau đó reload trang quiz.
- Một số website render câu hỏi trong iframe hoặc dùng DOM đặc biệt; content script có thể không đọc được nội dung đó.
- Dùng **Chọn Câu Hỏi** và chọn phần tử cha chứa cả nội dung câu hỏi lẫn các lựa chọn.
- Kiểm tra Console của trang và Service Worker của Extension nếu cần xem log kỹ thuật.

### Không tự Next

- Kiểm tra switch **Tự động chuyển trang (Next)** đang bật và nút thực tế có label/role phù hợp.
- Một số trang có nút trong iframe hoặc dùng icon không có label; Extension có thể không nhận ra.
- Luôn quan sát trang khi chạy Auto Agent; dừng bằng nút **Dừng Auto Agent** nếu hành vi không như mong muốn.
