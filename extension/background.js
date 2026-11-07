/**
 * background.js - Service Worker trung gian điều phối tác vụ
 * Gọi Backend FastAPI, lưu cấu hình AI / lịch sử / cache trong chrome.storage.local
 */

importScripts("config.js");

const BACKEND_BASE_URL = APP_CONFIG.BACKEND_URL;
const HISTORY_LIMIT = APP_CONFIG.HISTORY_LIMIT || 500;
const CACHE_LIMIT = APP_CONFIG.CACHE_LIMIT || 500;

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

function normalizeText(text) {
  return (text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Băm câu hỏi + đáp án để tra cache local (SHA-256)
 */
async function hashQuestion(questionText, options) {
  const optionsPart = (options || [])
    .map(o => `${normalizeText(o.key)}:${normalizeText(o.text)}`)
    .join("|");
  const raw = `${normalizeText(questionText)}##${optionsPart}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Giới hạn số entry cache, xóa các entry cũ nhất (theo thứ tự chèn)
 */
function trimCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= CACHE_LIMIT) return;
  keys.slice(0, keys.length - CACHE_LIMIT).forEach(k => delete cache[k]);
}

/**
 * Thêm 1 bản ghi lịch sử vào đầu danh sách (mới nhất trước)
 */
async function appendHistory(payload, answerKey, modelName, elapsedMs) {
  const { history } = await getStore(["history"]);
  const list = history || [];
  list.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    website_url: payload.website_url || "",
    question_text: payload.question_text || "",
    question_type: payload.question_type || "text",
    options: payload.options || [],
    selected_answer: answerKey,
    ai_model_used: modelName || null,
    response_time_ms: elapsedMs,
    created_at: new Date().toISOString()
  });
  await setStore({ history: list.slice(0, HISTORY_LIMIT) });
}

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
  const startedAt = Date.now();
  const useCache = payload.use_cache !== false;
  const { aiConfig, qaCache } = await getStore(["aiConfig", "qaCache"]);
  const cache = qaCache || {};
  const qhash = await hashQuestion(payload.question_text, payload.options);

  // 1. Trúng cache local -> trả ngay, không gọi AI
  if (useCache && cache[qhash]) {
    const hit = cache[qhash];
    const elapsed = Date.now() - startedAt;
    if (!payload.skip_history) {
      await appendHistory(payload, hit.answer_key, hit.model_name, elapsed);
    }
    return {
      success: true,
      data: {
        answer_key: hit.answer_key,
        reasoning: hit.reasoning || "Lấy từ cache local (câu hỏi đã từng giải).",
        confidence: 1.0,
        response_time_ms: elapsed,
        from_cache: true
      }
    };
  }

  // 2. Chưa cấu hình AI -> báo lỗi rõ ràng
  if (!aiConfig) {
    return { success: false, error: "Chưa cấu hình AI. Hãy mở tab 'Cấu hình AI' và lưu cấu hình trước." };
  }

  // 3. Gọi backend, gửi kèm cấu hình AI (backend không dùng database)
  const res = await callBackend("/api/answer", "POST", { ...payload, ai_config: aiConfig });
  if (!res.success) return res;

  const data = res.data;

  // 4. Lưu lịch sử + cache vào chrome.storage.local
  if (!payload.skip_history) {
    await appendHistory(payload, data.answer_key, aiConfig.model_name, data.response_time_ms);
  }
  if (useCache) {
    cache[qhash] = {
      answer_key: data.answer_key,
      reasoning: data.reasoning,
      model_name: aiConfig.model_name
    };
    trimCache(cache);
    await setStore({ qaCache: cache });
  }

  return res;
}

/* ==========================================================================
   HISTORY (đọc/xóa từ chrome.storage.local)
   ========================================================================== */

async function getHistory({ page = 1, page_size = 10, url = "" } = {}) {
  const { history } = await getStore(["history"]);
  let items = history || [];

  const keyword = (url || "").trim().toLowerCase();
  if (keyword) {
    items = items.filter(item =>
      (item.question_text || "").toLowerCase().includes(keyword) ||
      (item.website_url || "").toLowerCase().includes(keyword)
    );
  }

  const total = items.length;
  const start = (page - 1) * page_size;

  return {
    success: true,
    data: {
      total: total,
      page: page,
      page_size: page_size,
      total_pages: Math.ceil(total / page_size),
      items: items.slice(start, start + page_size)
    }
  };
}

async function deleteHistoryItem(id) {
  const { history } = await getStore(["history"]);
  const list = (history || []).filter(item => item.id !== id);
  await setStore({ history: list });
  return { success: true };
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

    // 2. Gửi câu hỏi lên AI (cache + lịch sử xử lý local)
    case "SOLVE_QUIZ_API": {
      solveQuiz(payload || {})
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 3. Lấy lịch sử các câu đã giải từ chrome.storage.local
    case "GET_HISTORY": {
      getHistory(payload || {})
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 4. Xóa 1 bản ghi lịch sử
    case "DELETE_HISTORY_ITEM": {
      deleteHistoryItem(payload?.id)
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    // 5. Cập nhật trạng thái Auto từ Content Script hoặc Popup
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
