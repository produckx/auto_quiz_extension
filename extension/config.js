/**
 * config.js - Biến môi trường dùng chung cho extension
 *
 * Chrome Extension KHÔNG hỗ trợ file .env khi chạy runtime.
 * Thay vào đó, file này đóng vai trò "env" tĩnh: sửa giá trị rồi Reload extension.
 * Được nạp vào background.js bằng importScripts("config.js").
 */

const APP_CONFIG = {
  // Địa chỉ backend FastAPI (đổi khi chạy backend ở host/port khác)
  BACKEND_URL: "http://127.0.0.1:8765",

  // Số bản ghi lịch sử / cache tối đa lưu trong chrome.storage.local
  HISTORY_LIMIT: 500,
  CACHE_LIMIT: 500
};
