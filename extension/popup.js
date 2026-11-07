/**
 * popup.js - Quản lý giao diện Popup của Duck Quiz Agent
 * Điều khiển tác vụ Auto, cấu hình Duck Quiz Agent và hiển thị lịch sử câu hỏi
 */

document.addEventListener("DOMContentLoaded", () => {
  // 1. DOM Elements
  // Header
  const backendStatusBadge = document.getElementById("backendStatusBadge");
  const backendStatusText = document.getElementById("backendStatusText");
  const btnRefreshHealth = document.getElementById("btnRefreshHealth");

  // Tabs
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabPanes = document.querySelectorAll(".tab-pane");

  // Control Tab
  const currentSiteUrl = document.getElementById("currentSiteUrl");
  const currentSiteStatus = document.getElementById("currentSiteStatus");
  const btnSolveManual = document.getElementById("btnSolveManual");
  const btnToggleAuto = document.getElementById("btnToggleAuto");
  const autoIcon = document.getElementById("autoIcon");
  const autoBtnText = document.getElementById("autoBtnText");
  const delayPills = document.querySelectorAll(".delay-options .btn-pill");
  const delayValueBadge = document.getElementById("delayValueBadge");
  const logTerminal = document.getElementById("logTerminal");
  const btnClearLogs = document.getElementById("btnClearLogs");
  const toggleAutoNextPage = document.getElementById("toggleAutoNextPage");
  const toggleUseCache = document.getElementById("toggleUseCache");
  const answerModeRadios = document.querySelectorAll('input[name="answerMode"]');

  // Settings Tab
  const aiConfigForm = document.getElementById("aiConfigForm");
  const aiBaseUrl = document.getElementById("aiBaseUrl");
  const aiApiKey = document.getElementById("aiApiKey");
  const btnToggleApiKey = document.getElementById("btnToggleApiKey");
  const aiModelName = document.getElementById("aiModelName");
  const btnTestAI = document.getElementById("btnTestAI");
  const savedConfigStatus = document.getElementById("savedConfigStatus");
  const savedConfigDetails = document.getElementById("savedConfigDetails");

  // History Tab
  const historySearchInput = document.getElementById("historySearchInput");
  const btnRefreshHistory = document.getElementById("btnRefreshHistory");
  const historyListContainer = document.getElementById("historyListContainer");
  const historyPagination = document.getElementById("historyPagination");
  const btnPrevPage = document.getElementById("btnPrevPage");
  const btnNextPage = document.getElementById("btnNextPage");
  const pageIndicator = document.getElementById("pageIndicator");

  // Trạng thái cục bộ
  let isAutoRunning = false;
  let activeTab = null;
  let historyCurrentPage = 1;
  let historyTotalPages = 1;

  /* ==========================================================================
     LOGGING SYSTEM (MINI TERMINAL)
     ========================================================================== */

  function addLog(text, type = "info") {
    const timeStr = new Date().toLocaleTimeString();
    const line = document.createElement("div");
    line.className = `log-line ${type}`;
    line.innerText = `[${timeStr}] ${text}`;
    logTerminal.appendChild(line);
    logTerminal.scrollTop = logTerminal.scrollHeight;
  }

  btnClearLogs.addEventListener("click", () => {
    logTerminal.innerHTML = `<div class="log-line info">[System] Nhật ký đã được xóa.</div>`;
  });

  /* ==========================================================================
     TAB NAVIGATION
     ========================================================================== */

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-tab");
      tabButtons.forEach(b => b.classList.remove("active"));
      tabPanes.forEach(p => p.classList.remove("active"));

      btn.classList.add("active");
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add("active");

      // Nạp dữ liệu tương ứng khi chuyển tab
      if (targetId === "tab-history") {
        loadHistory(1);
      } else if (targetId === "tab-settings") {
        loadConfig();
      }
    });
  });

  /* ==========================================================================
     BACKEND HEALTH CHECK
     ========================================================================== */

  function checkBackendHealth() {
    backendStatusBadge.className = "status-badge checking";
    backendStatusText.innerText = "Checking...";

    chrome.runtime.sendMessage({ action: "CHECK_BACKEND_HEALTH" }, (response) => {
      if (response && response.success) {
        backendStatusBadge.className = "status-badge online";
        backendStatusText.innerText = "Online";
        addLog("Đã kết nối Backend FastAPI thành công.", "success");
      } else {
        backendStatusBadge.className = "status-badge offline";
        backendStatusText.innerText = "Offline";
        const msg = response?.error || "Không thể kết nối FastAPI backend.";
        addLog(msg, "error");
      }
    });
  }

  btnRefreshHealth.addEventListener("click", checkBackendHealth);

  /* ==========================================================================
     ACTIVE TAB DETECTION & INITIAL STATE
     ========================================================================== */

  async function initActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab;

    if (tab && tab.url) {
      try {
        const u = new URL(tab.url);
        currentSiteUrl.innerText = `${u.hostname}${u.pathname}`;
      } catch (e) {
        currentSiteUrl.innerText = tab.url;
      }

      // Ping content script trên tab
      chrome.tabs.sendMessage(tab.id, { action: "GET_STATE" }, (res) => {
        if (chrome.runtime.lastError || !res) {
          currentSiteStatus.innerText = "Trạng thái: Chưa nhận diện bài thi (hoặc tải lại tab)";
          currentSiteStatus.style.color = "var(--text-muted)";
        } else {
          currentSiteStatus.innerText = "Trạng thái: Sẵn sàng giải trắc nghiệm";
          currentSiteStatus.style.color = "var(--success)";
          if (res.isAutoRunning) {
            updateAutoButtonUI(true);
          }
        }
      });
    } else {
      currentSiteUrl.innerText = "Không có tab hoạt động";
    }

    // Đọc cài đặt delay từ storage
    chrome.storage.local.get(["nextDelay"], (res) => {
      const delay = res.nextDelay || 2;
      setDelayUI(delay);
    });

    // Kiểm tra trạng thái Agent từ background
    chrome.runtime.sendMessage({ action: "GET_AGENT_STATUS" }, (res) => {
      if (res && res.isRunning) {
        updateAutoButtonUI(true);
      }
    });
  }

  function setDelayUI(sec) {
    delayValueBadge.innerText = `${sec}s`;
    delayPills.forEach(pill => {
      if (parseInt(pill.getAttribute("data-delay"), 10) === sec) {
        pill.classList.add("active");
      } else {
        pill.classList.remove("active");
      }
    });
    chrome.storage.local.set({ nextDelay: sec });
  }

  delayPills.forEach(pill => {
    pill.addEventListener("click", () => {
      const sec = parseInt(pill.getAttribute("data-delay"), 10);
      setDelayUI(sec);
      addLog(`Đã cài đặt thời gian trễ chuyển câu: ${sec} giây.`, "info");
    });
  });

  /* ==========================================================================
     CONTROL TAB ACTIONS (Manual Solve & Auto Mode)
     ========================================================================== */

  // Giải câu hiện tại (Manual) -> chuyển thành "Chọn Câu Hỏi" bằng Element Picker
  btnSolveManual.addEventListener("click", () => {
    if (!activeTab || !activeTab.id) {
      addLog("Không tìm thấy tab trình duyệt mục tiêu.", "error");
      return;
    }

    addLog("Đang bật chế độ chọn câu hỏi trên trang. Hãy click vào vùng câu hỏi + đáp án...", "info");

    chrome.tabs.sendMessage(activeTab.id, { action: "PICK_QUESTION" }, (response) => {
      if (chrome.runtime.lastError) {
        addLog(`Lỗi: ${chrome.runtime.lastError.message}. Vui lòng F5 lại trang.`, "error");
        return;
      }
      if (response && response.success) {
        addLog("Đã bật Element Picker. Hãy click chọn vùng câu hỏi trên trang (ESC để hủy).", "success");
        // Đóng popup để người dùng thao tác trên trang
        window.close();
      } else {
        addLog("Không thể bật chế độ chọn câu hỏi.", "warning");
      }
    });
  });

  /* ==========================================================================
     HÀNH VI TỰ ĐỘNG: Toggle Next page + Answer mode
     ========================================================================== */

  // Nạp cài đặt hành vi từ storage
  function loadBehaviorSettings() {
    chrome.storage.local.get(
      ["autoNextPage", "answerMode", "useCache"],
      (data) => {
        toggleAutoNextPage.checked = data.autoNextPage !== false;
        toggleUseCache.checked = data.useCache !== false;
        const mode = data.answerMode === "random" ? "random" : "confidence";
        answerModeRadios.forEach(r => { r.checked = (r.value === mode); });
      }
    );
  }

  // Đồng bộ cài đặt xuống content script đang mở
  function pushSettingsToContent() {
    const settings = {
      autoNextPage: toggleAutoNextPage.checked,
      useCache: toggleUseCache.checked,
      answerMode: document.querySelector('input[name="answerMode"]:checked')?.value || "confidence"
    };

    chrome.storage.local.set(settings);

    if (activeTab && activeTab.id) {
      chrome.tabs.sendMessage(activeTab.id, { action: "UPDATE_SETTINGS", settings: settings }, () => {
        // Bỏ qua lỗi nếu content script chưa sẵn sàng
        void chrome.runtime.lastError;
      });
    }
  }

  toggleAutoNextPage.addEventListener("change", () => {
    pushSettingsToContent();
    addLog(`Tự động chuyển trang: ${toggleAutoNextPage.checked ? "BẬT" : "TẮT"}`, "info");
  });

  toggleUseCache.addEventListener("change", () => {
    pushSettingsToContent();
    addLog(`Dùng lại đáp án đã lưu (Cache): ${toggleUseCache.checked ? "BẬT" : "TẮT"}`, "info");
  });

  answerModeRadios.forEach(radio => {
    radio.addEventListener("change", () => {
      pushSettingsToContent();
      addLog(`Cách thức trả lời: ${radio.value === "random" ? "Chọn ngẫu nhiên" : "Độ tin cậy cao nhất"}`, "info");
    });
  });

  loadBehaviorSettings();

  function updateAutoButtonUI(running) {
    isAutoRunning = running;
    if (running) {
      btnToggleAuto.className = "btn btn-danger";
      autoIcon.innerText = "⏹";
      autoBtnText.innerText = "Dừng Auto Agent";
    } else {
      btnToggleAuto.className = "btn btn-success";
      autoIcon.innerText = "▶";
      autoBtnText.innerText = "Bắt đầu Auto Agent";
    }
  }

  // Bật/Tắt Auto Agent
  btnToggleAuto.addEventListener("click", () => {
    if (!activeTab || !activeTab.id) {
      addLog("Không tìm thấy tab trình duyệt mục tiêu.", "error");
      return;
    }

    const nextState = !isAutoRunning;
    const actionName = nextState ? "START_AUTO" : "STOP_AUTO";

    chrome.tabs.sendMessage(activeTab.id, { action: actionName }, (res) => {
      if (chrome.runtime.lastError) {
        addLog(`Lỗi: ${chrome.runtime.lastError.message}`, "error");
        return;
      }
      updateAutoButtonUI(nextState);
      if (nextState) {
        addLog("Đã KÍCH HOẠT chế độ Auto Agent. Tự động giải và chuyển câu.", "success");
      } else {
        addLog("Đã DỪNG chế độ Auto Agent.", "info");
      }
    });
  });

  // Lắng nghe broadcast trạng thái từ background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "BROADCAST_AUTO_STATE") {
      updateAutoButtonUI(Boolean(msg.isRunning));
    }
  });

  /* ==========================================================================
     SETTINGS TAB: Cấu hình AI & Đồng bộ Backend
     ========================================================================== */

  // Hiện/Ẩn API key
  btnToggleApiKey.addEventListener("click", () => {
    if (aiApiKey.type === "password") {
      aiApiKey.type = "text";
      btnToggleApiKey.innerText = "🔒";
    } else {
      aiApiKey.type = "password";
      btnToggleApiKey.innerText = "👁";
    }
  });

  function inferProviderLabel(baseUrl) {
    const url = (baseUrl || "").toLowerCase();
    if (url.includes("openrouter.ai")) return "OpenRouter";
    if (url.includes("localhost:11434") || url.includes("127.0.0.1:11434")) return "Ollama Local";
    return "OpenAI-compatible";
  }

  // Suy ra provider giống backend để gửi kèm khi giải câu hỏi
  function inferProvider(baseUrl) {
    const url = (baseUrl || "").toLowerCase();
    if (url.includes("openrouter.ai")) return "openrouter";
    if (url.includes("localhost:11434") || url.includes("127.0.0.1:11434")) return "ollama";
    return "openai_compatible";
  }

  function renderSavedConfig(config) {
    if (!config) {
      savedConfigStatus.className = "config-status-badge not-configured";
      savedConfigStatus.innerText = "Chưa cấu hình";
      savedConfigDetails.innerText = "Chưa có cấu hình AI được lưu trong Chrome Storage. Nhập URL, API key và tên model rồi bấm Lưu cấu hình.";
      return;
    }

    const url = config.base_url || "";
    const model = config.model_name || "(chưa có model)";
    const providerName = inferProviderLabel(url);
    const keyStatus = config.api_key ? "Đã lưu (ẩn)" : "Không dùng API key";

    savedConfigStatus.className = "config-status-badge configured";
    savedConfigStatus.innerText = "Đang dùng";

    savedConfigDetails.replaceChildren();
    [
      ["Endpoint", url || "(chưa có URL)"],
      ["Loại dịch vụ", providerName],
      ["Model", model],
      ["API key", keyStatus]
    ].forEach(([label, value]) => {
      const row = document.createElement("div");
      row.className = "saved-config-row";
      const name = document.createElement("span");
      name.className = "saved-config-label";
      name.innerText = label;
      const detail = document.createElement("span");
      detail.className = "saved-config-value";
      detail.innerText = value;
      row.append(name, detail);
      savedConfigDetails.appendChild(row);
    });
  }

  // Nạp cấu hình AI đã lưu trong chrome.storage.local
  function loadConfig() {
    savedConfigStatus.className = "config-status-badge loading";
    savedConfigStatus.innerText = "Đang tải...";

    chrome.storage.local.get(["aiConfig"], (res) => {
      const cfg = res.aiConfig || null;
      renderSavedConfig(cfg);
      aiBaseUrl.value = cfg?.base_url || "";
      aiApiKey.value = cfg?.api_key || "";
      aiModelName.value = cfg?.model_name || "";
    });
  }

  // Lưu cấu hình vào chrome.storage.local (không ghi database backend)
  aiConfigForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const base_url = aiBaseUrl.value.trim();
    const typedKey = aiApiKey.value.trim();
    const model_name = aiModelName.value.trim();
    if (!base_url || !model_name) return;

    chrome.storage.local.get(["aiConfig"], (res) => {
      const old = res.aiConfig || {};
      // Giữ API key cũ nếu người dùng để trống hoặc nhập '***'
      const api_key = (typedKey && typedKey !== "***") ? typedKey : (old.api_key || "");

      const config = {
        provider: inferProvider(base_url),
        base_url: base_url.replace(/\/$/, ""),
        api_key: api_key,
        model_name: model_name,
        temperature: old.temperature ?? 0.3,
        max_tokens: old.max_tokens ?? 512
      };

      chrome.storage.local.set({ aiConfig: config }, () => {
        renderSavedConfig(config);
        addLog("Đã lưu cấu hình AI vào Chrome Storage!", "success");
      });
    });
  });

  // Test kết nối AI bằng 1 câu hỏi mẫu nhanh
  btnTestAI.addEventListener("click", () => {
    btnTestAI.disabled = true;
    btnTestAI.innerText = "Đang thử...";
    addLog("Đang gửi câu hỏi test đến AI...", "info");

    const testPayload = {
      website_url: "http://extension-test.local",
      question_text: "Thủ đô của Việt Nam là gì?",
      question_type: "text",
      options: [
        { key: "A", text: "Hà Nội" },
        { key: "B", text: "TP. Hồ Chí Minh" },
        { key: "C", text: "Đà Nẵng" },
        { key: "D", text: "Hải Phòng" }
      ],
      // Không ghi câu test vào lịch sử, và bỏ qua cache để test đúng kết nối AI
      skip_history: true,
      use_cache: false
    };

    chrome.runtime.sendMessage({ action: "SOLVE_QUIZ_API", payload: testPayload }, (res) => {
      btnTestAI.disabled = false;
      btnTestAI.innerText = "🔌 Test kết nối AI";

      if (res && res.success) {
        const d = res.data;
        addLog(`AI phản hồi thành công trong ${d.response_time_ms}ms: [${d.answer_key}] - ${d.reasoning}`, "success");
        alert(`Kết nối AI thành công!\nĐáp án: ${d.answer_key}\nThời gian: ${d.response_time_ms}ms\nGiải thích: ${d.reasoning}`);
      } else {
        const err = res?.error || "Lỗi không xác định khi gọi AI";
        addLog(`Test AI thất bại: ${err}`, "error");
        alert(`Thử nghiệm thất bại: ${err}`);
      }
    });
  });

  /* ==========================================================================
     HISTORY TAB: Xem lại danh sách câu hỏi đã giải
     ========================================================================== */

  function loadHistory(page = 1) {
    historyListContainer.innerHTML = '<div class="history-empty">Đang tải lịch sử...</div>';

    const payload = {
      page: page,
      page_size: 8,
      url: historySearchInput.value.trim()
    };

    chrome.runtime.sendMessage({ action: "GET_HISTORY", payload: payload }, (res) => {
      if (!res || !res.success || !res.data) {
        historyListContainer.innerHTML = `<div class="history-empty">${res?.error || "Không thể tải lịch sử."}</div>`;
        return;
      }

      const data = res.data;
      historyCurrentPage = data.page;
      historyTotalPages = data.total_pages;

      renderHistoryItems(data.items);
      updatePaginationUI();
    });
  }

  function renderHistoryItems(items) {
    if (!items || items.length === 0) {
      historyListContainer.innerHTML = '<div class="history-empty">Chưa có câu hỏi nào trong lịch sử.</div>';
      return;
    }

    historyListContainer.innerHTML = "";
    items.forEach(item => {
      const div = document.createElement("div");
      div.className = "history-item";

      let timeFormatted = "";
      if (item.created_at) {
        const d = new Date(item.created_at);
        timeFormatted = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")} ${d.getDate()}/${d.getMonth() + 1}`;
      }

      div.innerHTML = `
        <div class="history-header">
          <span class="history-badge">Đáp án: ${item.selected_answer || "--"}</span>
          <span class="history-time">${timeFormatted}</span>
        </div>
        <div class="history-q-text">${escapeHtml(item.question_text)}</div>
        <div class="history-footer">
          <span>Model: ${escapeHtml(item.ai_model_used || "N/A")}</span>
          <button class="btn-text-sm btn-delete-history" data-id="${item.id}" title="Xóa">Xóa</button>
        </div>
      `;

      div.querySelector(".btn-delete-history").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteHistoryItem(item.id);
      });

      historyListContainer.appendChild(div);
    });
  }

  function deleteHistoryItem(id) {
    chrome.runtime.sendMessage({ action: "DELETE_HISTORY_ITEM", payload: { id: id } }, (res) => {
      if (res && res.success) {
        loadHistory(historyCurrentPage);
      }
    });
  }

  function updatePaginationUI() {
    if (historyTotalPages > 1) {
      historyPagination.style.display = "flex";
      pageIndicator.innerText = `Trang ${historyCurrentPage}/${historyTotalPages}`;
      btnPrevPage.disabled = historyCurrentPage <= 1;
      btnNextPage.disabled = historyCurrentPage >= historyTotalPages;
    } else {
      historyPagination.style.display = "none";
    }
  }

  btnPrevPage.addEventListener("click", () => {
    if (historyCurrentPage > 1) loadHistory(historyCurrentPage - 1);
  });

  btnNextPage.addEventListener("click", () => {
    if (historyCurrentPage < historyTotalPages) loadHistory(historyCurrentPage + 1);
  });

  btnRefreshHistory.addEventListener("click", () => loadHistory(1));

  let searchDebounce = null;
  historySearchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      loadHistory(1);
    }, 400);
  });

  function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Khởi động
  checkBackendHealth();
  initActiveTab();
});
