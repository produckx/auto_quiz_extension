/**
 * background.js - Service Worker trung gian điều phối tác vụ
 * Quản lý trạng thái, gửi request HTTP sang Local Backend và hỗ trợ tab communication
 */

const BACKEND_BASE_URL = "http://127.0.0.1:8765";

// Trạng thái runtime
let agentState = {
  isRunning: false,
  activeTabId: null,
  nextDelay: 2
};

// Khôi phục trạng thái khi Service Worker bị Chrome tạm dừng rồi khởi động lại
chrome.storage.session.get(["agentState"], (res) => {
  if (res && res.agentState) {
    agentState = { ...agentState, ...res.agentState };
  }
});

// Khởi tạo các giá trị mặc định trong storage khi cài đặt extension
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Duck Quiz Agent Background] Extension installed/updated.");
  chrome.storage.local.get(["nextDelay", "backendUrl"], (data) => {
    if (data.nextDelay === undefined) {
      chrome.storage.local.set({ nextDelay: 2 });
    }
    if (!data.backendUrl) {
      chrome.storage.local.set({ backendUrl: BACKEND_BASE_URL });
    }
  });
});

/**
 * Gửi HTTP Request sang backend Python FastAPI
 * @param {string} endpoint 
 * @param {string} method 
 * @param {object} body 
 * @returns {Promise<any>}
 */
async function callBackend(endpoint, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(["backendUrl"], async (storage) => {
      const baseUrl = storage.backendUrl || BACKEND_BASE_URL;
      const url = `${baseUrl.replace(/\/$/, "")}${endpoint}`;

      const options = {
        method: method,
        headers: {
          "Content-Type": "application/json"
        }
      };

      if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
        options.body = JSON.stringify(body);
      }

      try {
        const response = await fetch(url, options);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errMsg = errorData.detail || `Lỗi máy chủ (${response.status}): ${response.statusText}`;
          return resolve({ success: false, error: errMsg, status: response.status });
        }
        const data = await response.json();
        resolve({ success: true, data: data });
      } catch (err) {
        console.error(`[Background] Lỗi gọi ${url}:`, err);
        resolve({
          success: false,
          error: "Không thể kết nối Backend FastAPI (http://127.0.0.1:8765). Hãy chắc chắn backend đang chạy."
        });
      }
    });
  });
}

/**
 * Xử lý các message đến từ content script hoặc popup
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action, payload } = request;

  switch (action) {
    // 1. Kiểm tra trạng thái kết nối Backend
    case "CHECK_BACKEND_HEALTH": {
      callBackend("/")
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // asynchronous response
    }

    // 2. Gửi câu hỏi lên API để nhận đáp án
    case "SOLVE_QUIZ_API": {
      callBackend("/api/answer", "POST", payload)
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 3. Lấy cấu hình AI hiện tại
    case "GET_CONFIG": {
      callBackend("/api/config", "GET")
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 4. Lưu cấu hình AI
    case "SAVE_CONFIG": {
      callBackend("/api/config", "POST", payload)
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 5. Lấy danh sách Provider gợi ý
    case "GET_PROVIDERS": {
      callBackend("/api/config/providers", "GET")
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 6. Lấy lịch sử các câu đã giải
    case "GET_HISTORY": {
      const page = payload?.page || 1;
      const pageSize = payload?.page_size || 10;
      const filterUrl = payload?.url ? `&url=${encodeURIComponent(payload.url)}` : "";
      callBackend(`/api/history?page=${page}&page_size=${pageSize}${filterUrl}`, "GET")
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 7. Xóa 1 bản ghi lịch sử
    case "DELETE_HISTORY_ITEM": {
      callBackend(`/api/history/${payload.id}`, "DELETE")
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 8. Cập nhật trạng thái Auto từ Content Script hoặc Popup
    case "UPDATE_AUTO_STATE": {
      agentState.isRunning = Boolean(request.isRunning);
      if (sender.tab) {
        agentState.activeTabId = sender.tab.id;
      }
      // Lưu lại để không mất khi Service Worker ngủ
      chrome.storage.session.set({ agentState });
      // Broadcast thông báo cho popup nếu đang mở
      chrome.runtime.sendMessage({
        action: "BROADCAST_AUTO_STATE",
        isRunning: agentState.isRunning
      }).catch(() => {
        // Bỏ qua lỗi nếu popup không mở
      });
      sendResponse({ success: true, isRunning: agentState.isRunning });
      break;
    }

    // 9. Lấy trạng thái Agent hiện tại
    case "GET_AGENT_STATUS": {
      sendResponse({
        isRunning: agentState.isRunning,
        activeTabId: agentState.activeTabId
      });
      break;
    }

    // 10. Kiểm tra xem tab gửi message có nên tự khôi phục Auto không
    // (dùng khi trang bị reload trong lúc đang chạy Auto)
    case "RESUME_STATE": {
      const senderTabId = sender.tab ? sender.tab.id : null;
      sendResponse({
        shouldRun: Boolean(
          agentState.isRunning &&
          senderTabId !== null &&
          agentState.activeTabId === senderTabId
        )
      });
      break;
    }

    default:
      break;
  }
});
