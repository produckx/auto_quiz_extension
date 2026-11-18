/**
 * background.js - Service Worker trung gian điều phối tác vụ
 * Gọi Backend FastAPI, lưu cấu hình AI / lịch sử / cache trong chrome.storage.local
 */

importScripts("config.js");

const BACKEND_BASE_URL = APP_CONFIG.BACKEND_URL;
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

// Khởi tạo giá trị mặc định khi cài đặt extension
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Duck Quiz Agent Background] Extension installed/updated.");
  chrome.storage.local.get(["nextDelay"], (data) => {
    if (data.nextDelay === undefined) {
      chrome.storage.local.set({ nextDelay: 2 });
    }
  });
});

/* ==========================================================================
   STORAGE HELPERS (chrome.storage.local)
   ========================================================================== */

const getStore = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
const setStore = (obj) => new Promise((resolve) => chrome.storage.local.set(obj, resolve));

/* ==========================================================================
   BACKEND CALL
   ========================================================================== */

/**
 * Gửi HTTP Request sang backend Python FastAPI
 * @param {string} endpoint
 * @param {string} method
 * @param {object} body
 * @returns {Promise<any>}
 */
async function callBackend(endpoint, method = "GET", body = null) {
  const baseUrl = (BACKEND_BASE_URL || "").replace(/\/$/, "");
  const url = `${baseUrl}${endpoint}`;

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
      return { success: false, error: errMsg, status: response.status };
    }
    const data = await response.json();
    return { success: true, data: data };
  } catch (err) {
    console.error(`[Background] Lỗi gọi ${url}:`, err);
    return {
      success: false,
      error: `Không thể kết nối Backend (${baseUrl}). Hãy chắc chắn backend đang chạy.`
    };
  }
}

/* ==========================================================================
   SOLVE QUIZ: tra cache local -> gọi AI -> lưu lịch sử + cache
   ========================================================================== */

async function solveQuiz(payload) {
  const { aiConfig } = await getStore(["aiConfig"]);

  // 1. Chưa cấu hình AI -> báo lỗi rõ ràng
  if (!aiConfig) {
    return { success: false, error: "Chưa cấu hình AI. Hãy mở tab 'Cấu hình AI' và lưu cấu hình trước." };
  }

  // 2. Gọi backend, gửi kèm cấu hình AI (stateless, không lưu db/cache/history)
  return await callBackend("/api/answer", "POST", { ...payload, ai_config: aiConfig });
}

/* ==========================================================================
   MESSAGE ROUTER
   ========================================================================== */

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

    // 2. Gửi câu hỏi lên AI
    case "SOLVE_QUIZ_API": {
      solveQuiz(payload || {})
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 3. Cập nhật trạng thái Auto từ Content Script hoặc Popup
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

    // 6. Lấy trạng thái Agent hiện tại
    case "GET_AGENT_STATUS": {
      sendResponse({
        isRunning: agentState.isRunning,
        activeTabId: agentState.activeTabId
      });
      break;
    }

    // 7. Kiểm tra xem tab gửi message có nên tự khôi phục Auto không
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
