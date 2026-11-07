/**
 * content.js - Bộ não cào DOM, trích xuất câu hỏi/đáp án và tương tác trên trang trắc nghiệm
 * Hoạt động trên các trang web thi: Google Forms, Azota, Quizizz, Kahoot, Canvas, LMS, Moodle, web tùy biến...
 */

(() => {
  // Tránh inject trùng lặp nếu script chạy nhiều lần
  if (window.__AI_QUIZ_AGENT_INITIALIZED__) return;
  window.__AI_QUIZ_AGENT_INITIALIZED__ = true;

  // Trạng thái cục bộ
  let isAutoRunning = false;
  let autoTimer = null;
  let currentDetectedQuestion = null;

  // Cấu hình hành vi của Agent
  const agentSettings = {
    autoNextPage: true,        // Tự động chuyển trang khi hết câu
    answerMode: "confidence",  // "confidence" = độ tin cậy cao nhất, "random" = chọn ngẫu nhiên
    useCache: true,            // Dùng lại đáp án đã lưu trong chrome.storage.local (câu hỏi trùng)
    nextDelay: 2
  };

  // Trạng thái chọn câu hỏi (Element Picker)
  let isPickingQuestion = false;
  let pickerHighlightEl = null;
  let pickedContainer = null;
  let pickerOverlayEl = null;
  let pickerHandlers = null;

  /**
   * Đọc cấu hình hành vi từ chrome.storage.local
   */
  function loadAgentSettings(callback) {
    chrome.storage.local.get(
      ["autoNextPage", "answerMode", "useCache", "nextDelay"],
      (data) => {
        agentSettings.autoNextPage = data.autoNextPage !== false;
        agentSettings.answerMode = data.answerMode === "random" ? "random" : "confidence";
        agentSettings.useCache = data.useCache !== false;
        agentSettings.nextDelay = data.nextDelay || 2;
        if (typeof callback === "function") callback(agentSettings);
      }
    );
  }

  console.log("[Duck Quiz Agent] Content script đã tải thành công.");

  /* ==========================================================================
     1. DOM EXTRACTOR: Trích xuất Câu hỏi, Hình ảnh, Bảng biểu, Đáp án
     ========================================================================== */

  /**
   * Chuyển hình ảnh thẻ <img> thành chuỗi Base64 thông qua HTML5 Canvas
   * @param {HTMLImageElement} imgElement 
   * @returns {Promise<string|null>} Chuỗi base64 không gồm header hoặc null
   */
  async function convertImageToBase64(imgElement) {
    if (!imgElement || !imgElement.src) return null;

    // Nếu ảnh đã là data URL base64
    if (imgElement.src.startsWith("data:image")) {
      const parts = imgElement.src.split(",");
      return parts.length > 1 ? parts[1] : null;
    }

    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
            const base64 = dataUrl.split(",")[1];
            resolve(base64);
          } catch (e) {
            console.warn("[Duck Quiz Agent] Không thể chuyển ảnh canvas (CORS):", e);
            resolve(null);
          }
        };
        img.onerror = () => resolve(null);
        img.src = imgElement.src;
      } catch (err) {
        resolve(null);
      }
    });
  }

  /**
   * Trích xuất nội dung bảng biểu HTML thành biểu diễn Markdown/Text
   * @param {HTMLTableElement} tableElement 
   * @returns {string} Text mô phỏng bảng
   */
  function extractTableData(tableElement) {
    if (!tableElement) return "";
    const rows = Array.from(tableElement.querySelectorAll("tr"));
    if (rows.length === 0) return "";

    return rows.map(tr => {
      const cells = Array.from(tr.querySelectorAll("th, td"))
        .map(c => c.innerText.trim().replace(/\s+/g, " "));
      return "| " + cells.join(" | ") + " |";
    }).join("\n");
  }

  /**
   * Lấy text hiển thị của một lựa chọn.
   * Nhiều nền tảng (Google Forms, MS Forms) không render text trong .innerText
   * mà chỉ đặt ở aria-label / data-value / title -> cần fallback.
   */
  function getElementText(el) {
    if (!el) return "";
    let t = (el.innerText || "").trim();

    if (!t) t = (el.getAttribute("aria-label") || "").trim();
    if (!t) t = (el.getAttribute("data-value") || "").trim();
    if (!t) t = (el.getAttribute("title") || "").trim();
    if (!t) {
      const inp = el.querySelector("input[type='radio'], input[type='checkbox']");
      if (inp) t = (inp.getAttribute("aria-label") || inp.value || "").trim();
    }

    return t.replace(/\s+/g, " ").trim();
  }

  /**
   * Tìm khối container của tất cả câu hỏi trắc nghiệm trên trang.
   * Lựa chọn bộ selector bao quát và tìm được NHIỀU CÂU HỎI HỢP LỆ NHẤT.
   */
  function findQuestionContainers() {
    const selectors = [
      // Google Forms
      'div[role="listitem"]',
      'div[jsmodel][data-params]',
      // Các nền tảng LMS thông dụng (Azota, Moodle, Canvas, Substudy)
      '.question-item',
      '.quiz-question',
      '.question-container',
      '.content-question',
      '.que.multichoice',
      '.form-group.question',
      '[class*="question-item"]',
      '[class*="QuestionItem"]',
      '[class*="question_wrapper"]',
      'fieldset',
      '.card.question',
      '[class*="question"]'
    ];

    let bestContainers = [];

    // Tìm bộ selector cho ra số lượng câu hỏi hợp lệ lớn nhất
    for (const sel of selectors) {
      const found = Array.from(document.querySelectorAll(sel));
      const valid = found.filter(el => {
        if (el.closest("#ai-quiz-floating-widget")) return false;
        // Phải chứa ít nhất 2 lựa chọn (radio hoặc checkbox hoặc role="radio")
        const choices = el.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
        return choices.length >= 2;
      });

      if (valid.length > bestContainers.length) {
        bestContainers = valid;
      }
    }

    // Nếu các class có sẵn tìm được >= 1 câu hỏi, trả về bộ lớn nhất
    if (bestContainers.length > 0) {
      return bestContainers;
    }

    // Fallback thông minh: Gom nhóm từ chính các nút radio/checkbox
    // Mỗi nhóm radio/checkbox có chung container cha gần nhất
    const allChoices = Array.from(document.querySelectorAll(
      'input[type="radio"]:not([name*="widget"]), [role="radio"]'
    ));

    if (allChoices.length > 0) {
      const parentGroups = new Set();
      allChoices.forEach(choice => {
        // Tìm khối cha bao quanh (trong vòng 4 cấp)
        let p = choice.closest('div[role="listitem"], fieldset, form, [class*="item"], [class*="group"]') ||
                choice.parentElement?.parentElement?.parentElement ||
                choice.parentElement?.parentElement;
        if (p && !p.closest("#ai-quiz-floating-widget")) {
          parentGroups.add(p);
        }
      });

      if (parentGroups.size > 0) {
        return Array.from(parentGroups);
      }
    }

    return [];
  }

  /**
   * Phân tích một khối câu hỏi container để lấy text, ảnh, table, và các lựa chọn đáp án
   * @param {HTMLElement} container 
   */
  async function parseQuestionContainer(container) {
    if (!container) return null;

    // 1. Trích xuất text câu hỏi
    let questionText = "";
    const questionTextSelectors = [
      // Google Forms tiêu đề câu hỏi đặc thù
      '.M7eMe',
      '[class*="M7eMe"]',
      'div[role="heading"] span',
      '[role="heading"]',
      // Class trắc nghiệm thông dụng
      '.question-title',
      '.question-content',
      '.question-text',
      '.qtext',
      '.title-question',
      '[class*="question-title"]',
      '[class*="question-text"]',
      'legend',
      'h2, h3, h4, h5, strong, p'
    ];

    let titleEl = null;
    for (const sel of questionTextSelectors) {
      const el = container.querySelector(sel);
      if (el && el.innerText.trim().length > 3) {
        titleEl = el;
        questionText = el.innerText.trim();
        break;
      }
    }

    // Fallback nếu không khớp selector: lấy text trên đầu container
    if (!questionText) {
      questionText = container.innerText.split("\n")[0] || "Câu hỏi trắc nghiệm";
    }

    // 2. Tìm ảnh trong câu hỏi (nếu có)
    let imageBase64 = null;
    let questionType = "text";
    const imgEl = container.querySelector("img:not([src*='icon']):not([src*='avatar']):not([width='1'])");
    if (imgEl && imgEl.naturalWidth > 50) {
      imageBase64 = await convertImageToBase64(imgEl);
      if (imageBase64) {
        questionType = "image";
      }
    }

    // 3. Tìm bảng biểu trong câu hỏi
    const tableEl = container.querySelector("table");
    if (tableEl) {
      const tableText = extractTableData(tableEl);
      if (tableText) {
        questionText += "\n\n[Bảng dữ liệu]:\n" + tableText;
        if (questionType === "text") questionType = "table";
      }
    }

    // 4. Tìm danh sách các lựa chọn (options)
    const optionItems = [];
    const optionSelectors = [
      // Google Forms
      'div[role="radio"]',
      'div[role="checkbox"]',
      // Class thông dụng
      '.option-item',
      '.answer-item',
      '.quiz-option',
      '[class*="option-item"]',
      '[class*="choice-item"]',
      '[class*="answer-item"]',
      '[class*="answer_item"]',
      // Input labels
      'label:has(> input[type="radio"])',
      'label:has(> input[type="checkbox"])',
      // Li có chứa input (tránh bắt menu/nav của trang)
      'li:has(input[type="radio"])',
      'li:has(input[type="checkbox"])'
    ];

    let candidateElements = [];
    for (const sel of optionSelectors) {
      const els = Array.from(container.querySelectorAll(sel)).filter(el => {
        // Loại bỏ chính container hoặc widget
        return el !== container && !el.closest("#ai-quiz-floating-widget");
      });

      // Thường trắc nghiệm có 2 đến 6 lựa chọn
      if (els.length >= 2 && els.length <= 10) {
        candidateElements = els;
        break;
      }
    }

    // Fallback: tìm trực tiếp thẻ input[type="radio"]
    if (candidateElements.length === 0) {
      const inputs = Array.from(container.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      if (inputs.length >= 2) {
        candidateElements = inputs.map(inp => inp.closest("label") || inp.parentElement || inp);
      }
    }

    const keyChars = ["A", "B", "C", "D", "E", "F", "G"];
    candidateElements.forEach((el, index) => {
      let fullText = getElementText(el);
      let key = keyChars[index] || String(index + 1);

      // Thử phát hiện ký tự đầu như "A.", "B)", "1.", "A:"
      const match = fullText.match(/^([A-Ga-g1-9])[\.\:\)\s]\s*(.*)$/);
      let text = fullText;
      if (match) {
        key = match[1].toUpperCase();
        text = match[2];
      }

      optionItems.push({
        key: key,
        text: text || fullText || `Lựa chọn ${key}`,
        element: el
      });
    });

    return {
      container: container,
      questionText: questionText.replace(/\s+/g, " ").trim(),
      questionType: questionType,
      options: optionItems,
      imageBase64: imageBase64
    };
  }

  /**
   * Kiểm tra xem một khối câu hỏi đã được chọn đáp án hay chưa.
   * Hỗ trợ Google Forms (aria-checked="true"), input:checked tiêu chuẩn, và class highlight.
   * @param {HTMLElement} container 
   * @returns {boolean}
   */
  function isContainerAnswered(container) {
    if (!container) return false;

    // 1. Kiểm tra input HTML tiêu chuẩn
    const checkedInput = container.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked');
    if (checkedInput) return true;

    // 2. Kiểm tra ARIA (Google Forms, Material UI: div[role="radio"][aria-checked="true"])
    const ariaChecked = container.querySelector('[role="radio"][aria-checked="true"], [role="checkbox"][aria-checked="true"]');
    if (ariaChecked) return true;

    // 3. Kiểm tra class highlight do AI đã click trước đó
    const highlighted = container.querySelector('.ai-quiz-selected-highlight');
    if (highlighted) return true;

    // 4. Kiểm tra các class active/selected phổ biến trên các thư viện UI
    const customSelected = container.querySelector('[class*="is-selected"], [class*="selected"], [class*="active"][role="button"]');
    if (customSelected && !customSelected.closest("#ai-quiz-floating-widget")) return true;

    return false;
  }

  /**
   * Phát hiện câu hỏi hiện tại cần giải:
   * 1. Ưu tiên `pickedContainer` nếu người dùng đã chọn bằng Element Picker.
   * 2. Ngược lại: ưu tiên câu hỏi CHƯA TRẢ LỜI đầu tiên trên trang.
   * Tự động cuộn màn hình (scroll) tới câu hỏi đó.
   */
  async function detectCurrentQuestion() {
    // 1. Ưu tiên container đã chọn thủ công bằng Element Picker
    if (pickedContainer && document.body.contains(pickedContainer)) {
      // Nếu vùng đã chọn đã được trả lời -> bỏ chọn để tránh giải lặp lại
      if (isContainerAnswered(pickedContainer)) {
        pickedContainer = null;
      } else {
        pickedContainer.scrollIntoView({ behavior: "smooth", block: "center" });
        const parsedPicked = await parseQuestionContainer(pickedContainer);
        if (parsedPicked && parsedPicked.options.length > 0) {
          currentDetectedQuestion = parsedPicked;
          return parsedPicked;
        }
        console.warn("[Duck Quiz Agent] Không tìm thấy đáp án trong vùng đã chọn, chuyển sang tự động dò.");
      }
    }

    const containers = findQuestionContainers();
    if (containers.length === 0) {
      console.warn("[Duck Quiz Agent] Không tìm thấy khối câu hỏi trên trang.");
      return null;
    }

    // Tìm câu hỏi chưa trả lời đầu tiên
    let targetContainer = null;
    for (const c of containers) {
      if (!isContainerAnswered(c)) {
        targetContainer = c;
        break;
      }
    }

    // Nếu tất cả đã trả lời hoặc không phân biệt được, ưu tiên container trong viewport
    if (!targetContainer) {
      const windowHeight = window.innerHeight;
      for (const c of containers) {
        const rect = c.getBoundingClientRect();
        if (rect.top >= -100 && rect.top < windowHeight * 0.7 && rect.height > 40) {
          targetContainer = c;
          break;
        }
      }
    }

    // Fallback: lấy câu đầu tiên
    if (!targetContainer) {
      targetContainer = containers[0];
    }

    // Tự động cuộn màn hình mượt mà tới câu hỏi
    if (targetContainer) {
      targetContainer.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    const parsed = await parseQuestionContainer(targetContainer);
    if (parsed && parsed.options.length > 0) {
      currentDetectedQuestion = parsed;
      return parsed;
    }

    return null;
  }

  /* ==========================================================================
     1.5 ELEMENT PICKER: Chọn câu hỏi trực quan bằng con trỏ chuột
     ========================================================================== */

  /**
   * Bật chế độ chọn câu hỏi: người dùng di chuột và click vào vùng chứa câu hỏi + đáp án.
   */
  function startQuestionPicker() {
    if (isPickingQuestion) {
      stopQuestionPicker();
      return;
    }
    isPickingQuestion = true;
    document.body.classList.add("ai-quiz-picking");

    // Tạo banner hướng dẫn trên đầu trang
    pickerOverlayEl = document.createElement("div");
    pickerOverlayEl.id = "ai-quiz-picker-banner";
    pickerOverlayEl.innerHTML = `
      <span>🎯 Chọn vùng chứa câu hỏi và đáp án (click chuột trái). Nhấn ESC để hủy.</span>
    `;
    document.body.appendChild(pickerOverlayEl);

    // Hiệu ứng hover: viền xanh nổi bật vùng đang trỏ tới
    pickerHighlightEl = document.createElement("div");
    pickerHighlightEl.id = "ai-quiz-picker-highlight";
    document.body.appendChild(pickerHighlightEl);

    const onMouseMove = (e) => {
      const el = e.target;
      if (!el || el.closest("#ai-quiz-floating-widget, #ai-quiz-picker-banner, #ai-quiz-picker-highlight")) {
        return;
      }
      const rect = el.getBoundingClientRect();
      pickerHighlightEl.style.top = `${rect.top + window.scrollY}px`;
      pickerHighlightEl.style.left = `${rect.left + window.scrollX}px`;
      pickerHighlightEl.style.width = `${rect.width}px`;
      pickerHighlightEl.style.height = `${rect.height}px`;
    };

    const onClick = (e) => {
      const el = e.target;
      if (!el || el.closest("#ai-quiz-floating-widget, #ai-quiz-picker-banner, #ai-quiz-picker-highlight")) {
        return;
      }

      // Chặn hành vi mặc định của trang (tránh click vào link/radio của trang)
      e.preventDefault();
      e.stopPropagation();

      // Ưu tiên tìm cha gần nhất có chứa >= 2 lựa chọn (nếu user click vào text bên trong)
      let container = el.closest(
        'div[role="listitem"], fieldset, [class*="question-item"], [class*="QuestionItem"], [class*="question"]'
      ) || el;

      let found = null;
      for (let i = 0; i < 8 && container; i++) {
        const choices = container.querySelectorAll(
          'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'
        );
        if (choices.length >= 2) {
          found = container;
          break;
        }
        container = container.parentElement;
      }

      pickedContainer = found || el;
      stopQuestionPicker();

      console.log("[Duck Quiz Agent] Đã chọn vùng câu hỏi:", pickedContainer);

      // Tự động giải ngay câu hỏi vừa chọn
      solveCurrentQuestion().then((res) => {
        if (!res.success) {
          updateWidgetStatus("error", "Vùng chọn không có đáp án!");
        }
      });
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        stopQuestionPicker();
        updateWidgetStatus("idle", "Đã hủy chọn câu hỏi");
      }
    };

    pickerHandlers = { onMouseMove, onClick, onKeyDown };
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);

    updateWidgetStatus("solving", "Đang chọn câu hỏi...");
  }

  /**
   * Tắt chế độ chọn câu hỏi và dọn dẹp DOM
   */
  function stopQuestionPicker() {
    isPickingQuestion = false;
    document.body.classList.remove("ai-quiz-picking");

    if (pickerHandlers) {
      document.removeEventListener("mousemove", pickerHandlers.onMouseMove, true);
      document.removeEventListener("click", pickerHandlers.onClick, true);
      document.removeEventListener("keydown", pickerHandlers.onKeyDown, true);
      pickerHandlers = null;
    }

    if (pickerOverlayEl) {
      pickerOverlayEl.remove();
      pickerOverlayEl = null;
    }
    if (pickerHighlightEl) {
      pickerHighlightEl.remove();
      pickerHighlightEl = null;
    }
  }

  /* ==========================================================================
     2. ACTION EXECUTOR: Tự động Click chọn đáp án & Chuyển câu tiếp theo (Next)
     ========================================================================== */

  /**
   * Click kích hoạt sự kiện đầy đủ (Mouse / Pointer / Change)
   * Tương thích tốt với các trang SPA React/Vue/Angular
   */
  function triggerRealisticClick(element) {
    if (!element) return;

    // Cuộn nhẹ tới phần tử nếu nằm ngoài tầm nhìn
    element.scrollIntoView({ behavior: "smooth", block: "nearest" });

    // Kích hoạt chuỗi sự kiện chuột
    const events = ["mouseenter", "mouseover", "mousedown", "mouseup", "click", "change"];
    events.forEach(eventName => {
      const event = new MouseEvent(eventName, {
        view: window,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(event);
    });

    // Native click phòng ngừa framework React/Polymer/Closure của Google
    if (typeof element.click === "function") {
      element.click();
    }

    // Nếu element chứa thẻ role="radio" hoặc role="checkbox" (Google Forms)
    const roleRadio = element.getAttribute("role") === "radio" ? element : element.querySelector('[role="radio"], [role="checkbox"]');
    if (roleRadio && roleRadio !== element && typeof roleRadio.click === "function") {
      roleRadio.click();
    }

    // Nếu element là label có chứa input bên trong
    const innerInput = element.querySelector("input");
    if (innerInput && innerInput !== element) {
      innerInput.checked = true;
      innerInput.dispatchEvent(new Event("change", { bubbles: true }));
      innerInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  /**
   * Chọn đáp án trên trang dựa vào answerKey (A, B, C, D)
   * @param {string} answerKey 
   * @param {object} parsedQuestion 
   */
  function selectAnswer(answerKey, parsedQuestion) {
    const question = parsedQuestion || currentDetectedQuestion;
    if (!question || !question.options) {
      console.error("[Duck Quiz Agent] Không có thông tin câu hỏi để chọn đáp án.");
      return false;
    }

    const normKey = answerKey.trim().toUpperCase();
    let targetOption = question.options.find(opt => opt.key.toUpperCase() === normKey);

    // Nếu không tìm thấy theo key (A, B, C), thử ánh xạ theo vị trí số (1 -> 0, 2 -> 1, ...)
    if (!targetOption && !isNaN(normKey)) {
      const idx = parseInt(normKey, 10) - 1;
      if (idx >= 0 && idx < question.options.length) {
        targetOption = question.options[idx];
      }
    }

    // Không click bừa: nếu AI trả key không khớp lựa chọn nào thì báo lỗi
    if (!targetOption) {
      console.warn(`[Duck Quiz Agent] Không khớp được đáp án "${answerKey}" với lựa chọn nào trên trang.`);
      return false;
    }

    if (targetOption && targetOption.element) {
      // Chỉ xóa highlight cũ trong cùng container của câu hỏi này
      if (question.container) {
        question.container.querySelectorAll(".ai-quiz-selected-highlight").forEach(el => {
          el.classList.remove("ai-quiz-selected-highlight");
        });
      }

      targetOption.element.classList.add("ai-quiz-selected-highlight");
      triggerRealisticClick(targetOption.element);

      console.log(`[Duck Quiz Agent] Đã click chọn đáp án [${targetOption.key}]: ${targetOption.text}`);
      return true;
    }

    return false;
  }

  /* ==========================================================================
     3. FLOATING WIDGET UI: Widget điều khiển nổi trên góc màn hình
     ========================================================================== */

  function injectFloatingWidget() {
    if (document.getElementById("ai-quiz-floating-widget")) return;

    const widget = document.createElement("div");
    widget.id = "ai-quiz-floating-widget";
    widget.innerHTML = `
      <div class="ai-widget-mini-icon" title="Mở Duck Quiz Agent">🦆</div>
      
      <div class="ai-widget-header" id="ai-widget-drag-handle">
        <div class="ai-widget-title-area">
          <span class="ai-widget-logo-badge">🦆</span>
          <span>Duck Quiz Agent</span>
        </div>
        <div class="ai-widget-controls">
          <button class="ai-widget-btn-icon" id="ai-widget-btn-minimize" title="Thu nhỏ">_</button>
          <button class="ai-widget-btn-icon" id="ai-widget-btn-close" title="Ẩn hoàn toàn">×</button>
        </div>
      </div>

      <div class="ai-widget-body">
        <div class="ai-widget-status-row">
          <span style="font-size: 11px; color: #64748b;">Trạng thái:</span>
          <span class="ai-widget-badge idle" id="ai-widget-status-badge">
            <span class="ai-widget-dot"></span>
            <span id="ai-widget-status-text">Sẵn sàng</span>
          </span>
        </div>

        <div class="ai-widget-progress-row" style="display: flex; justify-content: space-between; font-size: 11px; color: #64748b; margin-top: 4px;">
          <span>Tiến độ bài thi:</span>
          <span id="ai-widget-progress-text" style="font-weight: 600; color: #0284c7;">--/-- câu</span>
        </div>

        <div class="ai-widget-result-box" id="ai-widget-result-box">
          <div class="ai-widget-result-ans">
            <span id="ai-widget-ans-text">Đáp án: --</span>
            <span class="ai-widget-confidence" id="ai-widget-confidence-text">Độ tin cậy: --%</span>
          </div>
          <div class="ai-widget-reasoning" id="ai-widget-reasoning-text">
            Nhấn "Chọn Câu Hỏi" rồi click vào vùng chứa câu hỏi + đáp án.
          </div>
        </div>

        <!-- Tùy chọn cách thức trả lời -->
        <div class="ai-widget-settings">
          <div class="ai-widget-setting-label">Cách trả lời:</div>
          <div class="ai-widget-radio-group">
            <label class="ai-widget-radio">
              <input type="radio" name="ai-answer-mode" value="confidence" checked>
              <span>Độ tin cậy cao nhất</span>
            </label>
            <label class="ai-widget-radio">
              <input type="radio" name="ai-answer-mode" value="random">
              <span>Chọn ngẫu nhiên</span>
            </label>
          </div>
        </div>

        <!-- Toggle switch: tự Next trang / cache -->
        <div class="ai-widget-settings">
          <label class="ai-widget-switch-row">
            <span>Tự động chuyển trang (Next)</span>
            <input type="checkbox" id="ai-widget-toggle-nextpage" checked>
            <span class="ai-widget-switch"></span>
          </label>
          <label class="ai-widget-switch-row">
            <span>Dùng lại đáp án đã lưu (Cache)</span>
            <input type="checkbox" id="ai-widget-toggle-cache" checked>
            <span class="ai-widget-switch"></span>
          </label>
        </div>

        <div class="ai-widget-actions">
          <button class="ai-widget-btn ai-widget-btn-primary" id="ai-widget-btn-solve">
            🎯 Chọn Câu Hỏi
          </button>
          <button class="ai-widget-btn ai-widget-btn-secondary ai-widget-btn-auto" id="ai-widget-btn-auto">
            🤖 Auto: Tắt
          </button>
        </div>
      </div>
    `;

    // Ẩn Widget trong lúc đọc trạng thái để tránh lóe ra kích thước lớn khi tải trang.
    widget.style.visibility = "hidden";
    document.body.appendChild(widget);

    // Gán sự kiện cho Widget
    setupWidgetEvents(widget);

    chrome.storage.local.get(["widgetMinimized"], (data) => {
      if (data.widgetMinimized) {
        widget.classList.add("minimized");
      }
      widget.style.visibility = "visible";
    });
  }

  function setupWidgetEvents(widget) {
    const btnMinimize = widget.querySelector("#ai-widget-btn-minimize");
    const btnClose = widget.querySelector("#ai-widget-btn-close");
    const btnSolve = widget.querySelector("#ai-widget-btn-solve");
    const btnAuto = widget.querySelector("#ai-widget-btn-auto");
    const toggleNextPage = widget.querySelector("#ai-widget-toggle-nextpage");
    const toggleCache = widget.querySelector("#ai-widget-toggle-cache");
    const answerModeRadios = widget.querySelectorAll('input[name="ai-answer-mode"]');

    // Vị trí đã kéo trước khi thu nhỏ (null = đang ở vị trí mặc định góc phải dưới)
    let expandedPosition = null;

    // Thu nhỏ: đưa widget về góc dưới bên phải
    function minimizeWidget() {
      // Lưu vị trí đã kéo để mở rộng lại đúng chỗ
      if (widget.style.left) {
        const rect = widget.getBoundingClientRect();
        expandedPosition = { left: rect.left, top: rect.top };
      }
      widget.classList.add("minimized");
      // Xóa vị trí inline để CSS đưa widget về góc dưới bên phải
      widget.style.left = "";
      widget.style.top = "";
      widget.style.right = "";
      widget.style.bottom = "";
      try {
        chrome.storage.local.set({ widgetMinimized: true });
      } catch (err) {
        // Extension vừa được reload -> context cũ không dùng được, bỏ qua lỗi lưu trạng thái
      }
    }

    // Mở rộng lại kích thước và vị trí ban đầu
    function expandWidget() {
      widget.classList.remove("minimized");
      if (expandedPosition) {
        widget.style.bottom = "auto";
        widget.style.right = "auto";
        widget.style.left = `${expandedPosition.left}px`;
        widget.style.top = `${expandedPosition.top}px`;
      }
      try {
        chrome.storage.local.set({ widgetMinimized: false });
      } catch (err) {
        // Extension vừa được reload -> context cũ không dùng được, bỏ qua lỗi lưu trạng thái
      }
    }

    btnMinimize.addEventListener("click", (e) => {
      // Chặn bubble lên widget, tránh handler "click để mở rộng" chạy ngay sau khi thu nhỏ
      e.stopPropagation();
      minimizeWidget();
    });

    // Click vào widget khi đang thu nhỏ -> mở rộng lại
    widget.addEventListener("click", (e) => {
      if (!widget.classList.contains("minimized")) return;
      e.stopPropagation();
      expandWidget();
    });

    // Đóng hoàn toàn chỉ đóng Widget trên tab hiện tại
    btnClose.addEventListener("click", () => {
      widget.style.display = "none";
    });

    // Nút "Chọn Câu Hỏi": bật Element Picker
    btnSolve.addEventListener("click", () => {
      startQuestionPicker();
    });

    // Đồng bộ UI từ cấu hình đã lưu
    loadAgentSettings(() => {
      toggleNextPage.checked = agentSettings.autoNextPage;
      toggleCache.checked = agentSettings.useCache;
      answerModeRadios.forEach(r => {
        r.checked = (r.value === agentSettings.answerMode);
      });
    });

    // Toggle Tự Next trang
    toggleNextPage.addEventListener("change", () => {
      agentSettings.autoNextPage = toggleNextPage.checked;
      chrome.storage.local.set({ autoNextPage: agentSettings.autoNextPage });
    });

    // Toggle Dùng lại đáp án đã lưu (Cache)
    toggleCache.addEventListener("change", () => {
      agentSettings.useCache = toggleCache.checked;
      chrome.storage.local.set({ useCache: agentSettings.useCache });
      updateWidgetStatus("idle", toggleCache.checked ? "Cache: BẬT" : "Cache: TẮT");
    });

    // Radio cách thức trả lời
    answerModeRadios.forEach(radio => {
      radio.addEventListener("change", () => {
        if (radio.checked) {
          agentSettings.answerMode = radio.value;
          chrome.storage.local.set({ answerMode: agentSettings.answerMode });
          updateWidgetStatus("idle", radio.value === "random" ? "Chế độ: Chọn ngẫu nhiên" : "Chế độ: Độ tin cậy cao nhất");
        }
      });
    });

    // Bật/Tắt Auto
    btnAuto.addEventListener("click", () => {
      toggleAutoMode();
    });

    // Hỗ trợ kéo thả toàn bộ Widget (trừ các control tương tác)
    let dragState = null;
    const INTERACTIVE_SELECTOR = "button, input, label, select, textarea, a, .ai-widget-btn, .ai-widget-radio, .ai-widget-switch-row";

    widget.addEventListener("pointerdown", (e) => {
      if (widget.classList.contains("minimized")) return;
      if (e.button !== 0 || e.target.closest(INTERACTIVE_SELECTOR)) return;

      const rect = widget.getBoundingClientRect();
      dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        left: rect.left,
        top: rect.top
      };

      // Chuyển sang định vị tuyệt đối theo left/top để kéo mượt
      widget.style.bottom = "auto";
      widget.style.right = "auto";
      widget.style.left = `${rect.left}px`;
      widget.style.top = `${rect.top}px`;
      widget.classList.add("dragging");
      widget.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    widget.addEventListener("pointermove", (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;

      const maxLeft = Math.max(0, window.innerWidth - widget.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - widget.offsetHeight);
      const left = Math.min(Math.max(0, dragState.left + e.clientX - dragState.startX), maxLeft);
      const top = Math.min(Math.max(0, dragState.top + e.clientY - dragState.startY), maxTop);

      widget.style.left = `${left}px`;
      widget.style.top = `${top}px`;
    });

    function endDrag(e) {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      if (widget.hasPointerCapture(dragState.pointerId)) {
        widget.releasePointerCapture(dragState.pointerId);
      }
      widget.classList.remove("dragging");
      dragState = null;
    }

    widget.addEventListener("pointerup", endDrag);
    widget.addEventListener("pointercancel", endDrag);
  }

  function updateWidgetStatus(state, text) {
    const badge = document.getElementById("ai-widget-status-badge");
    const statusText = document.getElementById("ai-widget-status-text");
    if (!badge || !statusText) return;

    badge.className = `ai-widget-badge ${state}`;
    statusText.innerText = text;
  }

  function updateWidgetProgress(answered, total) {
    const progEl = document.getElementById("ai-widget-progress-text");
    if (progEl) {
      progEl.innerText = `${answered}/${total} câu`;
    }
  }

  /**
   * Đồng bộ trạng thái các control trong Widget theo agentSettings hiện tại.
   */
  function syncWidgetSettingsUI() {
    const toggleNextPage = document.getElementById("ai-widget-toggle-nextpage");
    const toggleCache = document.getElementById("ai-widget-toggle-cache");
    const radios = document.querySelectorAll('#ai-quiz-floating-widget input[name="ai-answer-mode"]');

    if (toggleNextPage) toggleNextPage.checked = agentSettings.autoNextPage;
    if (toggleCache) toggleCache.checked = agentSettings.useCache;
    radios.forEach(r => { r.checked = (r.value === agentSettings.answerMode); });
  }

  function updateWidgetResult(answer, confidence, reasoning) {
    const ansText = document.getElementById("ai-widget-ans-text");
    const confText = document.getElementById("ai-widget-confidence-text");
    const reasonText = document.getElementById("ai-widget-reasoning-text");

    if (ansText) ansText.innerText = `Đáp án: [ ${answer || "--"} ]`;
    if (confText) confText.innerText = `Độ tin cậy: ${confidence ? Math.round(confidence * 100) : "--"}%`;
    if (reasonText) reasonText.innerText = reasoning || "Không có ghi chú thêm.";
  }

  /* ==========================================================================
     4. AGENT SOLVE WORKFLOW: Quá trình giải câu hỏi và vòng lặp tự động
     ========================================================================== */

  /**
   * Giải câu hỏi hiện tại:
   * 1. Cào DOM câu hỏi
   * 2. Gửi message sang background.js để gọi backend API
   * 3. Nhận đáp án và click chọn
   */
  async function solveCurrentQuestion() {
    updateWidgetStatus("solving", "Đang phân tích...");
    const questionData = await detectCurrentQuestion();

    if (!questionData || !questionData.options || questionData.options.length === 0) {
      updateWidgetStatus("error", "Không tìm thấy câu hỏi!");
      updateWidgetResult("--", null, "Không xác định được vùng câu hỏi trên màn hình.");
      return { success: false, reason: "No question found" };
    }

    // Highlight câu hỏi đang làm
    document.querySelectorAll(".ai-quiz-question-highlight").forEach(el => el.classList.remove("ai-quiz-question-highlight"));
    if (questionData.container) {
      questionData.container.classList.add("ai-quiz-question-highlight");
    }

    // CHẾ ĐỘ CHỌN NGẪU NHIÊN: không gọi AI, chọn ngẫu nhiên 1 đáp án
    if (agentSettings.answerMode === "random") {
      const options = questionData.options;
      const randomIndex = Math.floor(Math.random() * options.length);
      const randomOption = options[randomIndex];

      updateWidgetStatus("success", `Ngẫu nhiên: ${randomOption.key}`);
      updateWidgetResult(randomOption.key, 1.0, `Chế độ chọn ngẫu nhiên (không dùng AI). Chọn đáp án ${randomOption.key}.`);

      selectAnswer(randomOption.key, questionData);

      const currentProg = getQuestionsProgress();
      updateWidgetProgress(currentProg.answered, currentProg.total);

      return { success: true, answer: randomOption.key };
    }

    updateWidgetStatus("solving", "Đang hỏi AI...");

    // Chuẩn bị payload gửi backend
    const payload = {
      website_url: window.location.href,
      question_text: questionData.questionText,
      question_type: questionData.questionType,
      options: questionData.options.map(o => ({ key: o.key, text: o.text })),
      image_base64: questionData.imageBase64,
      use_cache: agentSettings.useCache
    };

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "SOLVE_QUIZ_API", payload: payload }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          const errMsg = response?.error || chrome.runtime.lastError?.message || "Không thể kết nối Backend";
          updateWidgetStatus("error", "Lỗi AI");
          updateWidgetResult("--", null, errMsg);
          resolve({ success: false, reason: errMsg });
          return;
        }

        const data = response.data;
        const sourceLabel = data.from_cache ? " (từ Cache)" : "";
        updateWidgetStatus("success", `Đã chọn: ${data.answer_key}${sourceLabel}`);

        const reasoningText = data.from_cache
          ? `♻️ Lấy từ cache local (câu hỏi đã từng giải). ${data.reasoning || ""}`.trim()
          : data.reasoning;
        updateWidgetResult(data.answer_key, data.confidence, reasoningText);

        // Click chọn đáp án trên DOM
        selectAnswer(data.answer_key, questionData);

        const currentProg = getQuestionsProgress();
        updateWidgetProgress(currentProg.answered, currentProg.total);

        resolve({ success: true, answer: data.answer_key, fromCache: Boolean(data.from_cache) });
      });
    });
  }

  /**
   * Bật/Tắt chế độ Auto
   */
  function toggleAutoMode(forceState) {
    if (typeof forceState === "boolean") {
      isAutoRunning = forceState;
    } else {
      isAutoRunning = !isAutoRunning;
    }

    const btnAuto = document.getElementById("ai-widget-btn-auto");
    if (btnAuto) {
      if (isAutoRunning) {
        btnAuto.classList.add("active");
        btnAuto.innerText = "🤖 Auto: BẬT";
      } else {
        btnAuto.classList.remove("active");
        btnAuto.innerText = "🤖 Auto: Tắt";
      }
    }

    // Đồng bộ trạng thái về background
    chrome.runtime.sendMessage({
      action: "UPDATE_AUTO_STATE",
      isRunning: isAutoRunning
    });

    if (isAutoRunning) {
      runAutoLoop();
    } else {
      if (autoTimer) clearTimeout(autoTimer);
    }
  }

  /**
   * Lấy "chữ ký" nhanh của câu hỏi đang hiển thị (dùng để phát hiện đã chuyển câu).
   */
  function getCurrentSignature() {
    const containers = findQuestionContainers();
    if (containers.length === 0) return "";

    let target = containers[0];
    const h = window.innerHeight;
    for (const c of containers) {
      const rect = c.getBoundingClientRect();
      if (rect.top >= -100 && rect.top < h * 0.7 && rect.height > 40) {
        target = c;
        break;
      }
    }
    return (target.innerText || "").replace(/\s+/g, " ").trim().slice(0, 600);
  }

  /**
   * Chờ cho nội dung câu hỏi thay đổi (sau khi bấm Next).
   * Trả về true nếu đã đổi câu, false nếu timeout hoặc bị dừng.
   */
  function waitForQuestionChange(oldSignature, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (!isAutoRunning) {
          clearInterval(timer);
          resolve(false);
          return;
        }
        const current = getCurrentSignature();
        if (current && current !== oldSignature) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 400);
    });
  }

  /**
   * Đếm thống kê câu hỏi trên trang: tổng số câu và số câu chưa trả lời
   */
  function getQuestionsProgress() {
    const containers = findQuestionContainers();
    if (containers.length === 0) return { total: 0, unanswered: 0, answered: 0 };

    let answeredCount = 0;
    for (const c of containers) {
      if (isContainerAnswered(c)) {
        answeredCount++;
      }
    }

    return {
      total: containers.length,
      answered: answeredCount,
      unanswered: containers.length - answeredCount
    };
  }

  // Từ khóa nhận diện nút nộp bài / kết thúc bài thi
  const SUBMIT_KEYWORDS = [
    "gửi", "gửi bài", "gửi đáp án", "nộp bài", "nộp đáp án", "nộp",
    "hoàn thành", "hoàn tất", "kết thúc", "kết thúc bài", "xong",
    "submit", "send", "finish", "complete", "done", "end", "turn in", "hand in"
  ];
  // Từ khóa ngắn cần so khớp chính xác (tránh khớp nhầm substring)
  const SUBMIT_EXACT_KEYWORDS = new Set(["gửi", "nộp", "xong", "submit", "send", "finish", "complete", "done", "end"]);

  // Từ khóa nhận diện nút chuyển trang
  const NEXT_KEYWORDS = ["tiếp tục", "tiếp theo", "câu tiếp", "tiếp", "next", "kế tiếp", "sang trang", "trang tiếp", "continue"];

  /**
   * Kiểm tra một chuỗi (text/aria-label/title) có khớp danh sách từ khóa submit không
   */
  function matchesSubmitKeyword(raw) {
    const s = (raw || "").trim().toLowerCase();
    if (!s) return false;

    return SUBMIT_KEYWORDS.some(kw => {
      if (SUBMIT_EXACT_KEYWORDS.has(kw)) {
        // So khớp chính xác hoặc theo từ (tránh "end" khớp "legend")
        return s === kw || new RegExp(`(^|[^a-zà-ỹ])${kw}([^a-zà-ỹ]|$)`, "i").test(s);
      }
      return s.includes(kw);
    });
  }

  /**
   * Kiểm tra nút có bị vô hiệu hóa không (hỗ trợ cả aria-disabled của Google Forms)
   */
  function isButtonDisabled(btn) {
    if (!btn) return true;
    return btn.disabled === true || btn.getAttribute("aria-disabled") === "true";
  }

  /**
   * Kiểm tra nút có đang hiển thị không
   */
  function isButtonVisible(btn) {
    if (!btn) return false;
    return btn.getClientRects().length > 0;
  }

  /**
   * Tìm nút Next chuyển trang (không bao gồm nút Submit/Gửi bài)
   */
  function clickNextPageButton() {
    const candidates = Array.from(document.querySelectorAll(
      "button, a, div[role='button'], span[role='button']"
    ));

    for (const btn of candidates) {
      if (btn.closest("#ai-quiz-floating-widget")) continue;

      const text = (btn.innerText || btn.value || "").trim().toLowerCase();
      const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
      const title = (btn.getAttribute("title") || "").toLowerCase();

      // Bỏ qua nút Submit/Gửi bài
      if (matchesSubmitKeyword(text) || matchesSubmitKeyword(ariaLabel) || matchesSubmitKeyword(title)) {
        continue;
      }

      const isNext = NEXT_KEYWORDS.some(kw =>
        text === kw || text.includes(kw) || ariaLabel.includes(kw) || title.includes(kw)
      );

      if (isNext && !isButtonDisabled(btn) && isButtonVisible(btn)) {
        btn.scrollIntoView({ behavior: "smooth", block: "center" });
        triggerRealisticClick(btn);
        console.log("[Duck Quiz Agent] Đã bấm nút chuyển trang:", btn);
        return true;
      }
    }
    return false;
  }

  /**
   * Vòng lặp giải tự động thông minh:
   * 1. Hỗ trợ dạng trang cuộn (Google Forms nhiều câu cùng 1 trang): Giải câu 1 -> tự cuộn xuống câu 2 -> câu 3...
   * 2. Hỗ trợ dạng 1 câu có nút Next (Quizizz/Canvas): Giải -> bấm Next -> chờ câu mới -> lặp lại.
   * 3. Tôn trọng cài đặt autoNextPage của người dùng.
   */
  async function runAutoLoop() {
    if (!isAutoRunning) return;

    // Reload cài đặt mới nhất (tránh dùng cache cũ)
    await new Promise(resolve => loadAgentSettings(resolve));

    // 1. Thống kê tiến độ câu hỏi
    const progressBefore = getQuestionsProgress();
    updateWidgetProgress(progressBefore.answered, progressBefore.total);
    console.log(`[Duck Quiz Agent] Tiến độ bài thi: Đã làm ${progressBefore.answered}/${progressBefore.total} câu.`);

    if (progressBefore.total > 0 && progressBefore.unanswered === 0) {
      // Toàn bộ câu hỏi trên trang hiện tại đã được trả lời xong!
      console.log("[Duck Quiz Agent] Tất cả câu hỏi trên trang này đã được làm xong.");
      updateWidgetStatus("idle", `Đã làm xong ${progressBefore.total}/${progressBefore.total} câu!`);

      // Cuộn xuống cuối trang
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      await new Promise(r => setTimeout(r, 600));

      // Nếu bật Auto Next Page: tìm nút chuyển trang
      if (agentSettings.autoNextPage) {
        const hasNextPage = clickNextPageButton();
        if (hasNextPage) {
          updateWidgetStatus("idle", "Đang chuyển trang tiếp theo...");
          setTimeout(() => {
            if (isAutoRunning) runAutoLoop();
          }, 2000);
          return;
        }
      }

      // Không có trang tiếp theo hoặc tắt Auto Next Page -> Kết thúc
      updateWidgetStatus("success", `Hoàn thành ${progressBefore.total}/${progressBefore.total} câu! 🎉`);
      console.log("[Duck Quiz Agent] Không còn câu hỏi chưa làm và không có trang tiếp theo. Dừng Auto.");
      toggleAutoMode(false);
      return;
    }

    // 2. Vẫn còn câu hỏi chưa làm -> giải câu hỏi hiện tại
    updateWidgetStatus("solving", `Đang giải câu (${progressBefore.answered + 1}/${progressBefore.total})...`);
    const signatureBefore = getCurrentSignature();

    const res = await solveCurrentQuestion();
    if (!isAutoRunning) return;

    if (!res || !res.success) {
      updateWidgetStatus("error", "Dừng: không phân tích được câu hỏi");
      console.warn("[Duck Quiz Agent] Không giải được câu hỏi hiện tại, dừng Auto.");
      toggleAutoMode(false);
      return;
    }

    // 3. Delay trước khi chuyển câu
    const delaySec = agentSettings.nextDelay || 2;
    updateWidgetStatus("idle", `Đã chọn đáp án. Chờ ${delaySec}s...`);

    autoTimer = setTimeout(async () => {
      if (!isAutoRunning) return;

      // Kiểm tra xem trên trang còn câu nào chưa trả lời không
      const currentProgress = getQuestionsProgress();
      console.log(`[Duck Quiz Agent] Còn ${currentProgress.unanswered} câu chưa làm trên trang.`);

      if (currentProgress.unanswered > 0) {
        // Còn câu hỏi trên cùng 1 trang -> tiếp tục ngay
        updateWidgetStatus("idle", "Đang cuộn tới câu tiếp theo...");
        if (isAutoRunning) runAutoLoop();
        return;
      }

      // Đã hết câu trên trang này
      if (!agentSettings.autoNextPage) {
        updateWidgetStatus("success", `Hoàn thành ${currentProgress.total}/${currentProgress.total} câu (không chuyển trang).`);
        console.log("[Duck Quiz Agent] Đã tắt tự Next trang, dừng tại đây.");
        toggleAutoMode(false);
        return;
      }

      // Thử chuyển trang (nếu bật)
      if (agentSettings.autoNextPage) {
        updateWidgetStatus("idle", "Đang tìm nút chuyển trang...");
        const nextClicked = clickNextPageButton();
        if (nextClicked) {
          updateWidgetStatus("idle", "Đang chuyển trang...");
          const changed = await waitForQuestionChange(signatureBefore, 8000);
          if (!changed) {
            console.log("[Duck Quiz Agent] Trang không thay đổi sau khi bấm Next.");
          }
          if (isAutoRunning) runAutoLoop();
          return;
        }
      }

      // Không tìm thấy nút chuyển trang -> Kết thúc
      updateWidgetStatus("success", `Hoàn thành 100% (${currentProgress.total}/${currentProgress.total} câu)! 🎉`);
      console.log("[Duck Quiz Agent] Đã hoàn thành toàn bộ bài thi trắc nghiệm.");
      toggleAutoMode(false);
    }, delaySec * 1000);
  }

  /* ==========================================================================
     5. MESSAGE LISTENER: Lắng nghe lệnh từ Popup & Background
     ========================================================================== */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case "PING":
        sendResponse({ status: "ok", url: window.location.href });
        break;

      case "SOLVE_CURRENT":
        solveCurrentQuestion().then(res => sendResponse(res));
        return true; // async sendResponse

      case "START_AUTO":
        toggleAutoMode(true);
        sendResponse({ success: true, isAutoRunning: true });
        break;

      case "STOP_AUTO":
        toggleAutoMode(false);
        sendResponse({ success: true, isAutoRunning: false });
        break;

      case "GET_STATE":
        sendResponse({
          isAutoRunning: isAutoRunning,
          hasWidget: Boolean(document.getElementById("ai-quiz-floating-widget")),
          isPickingQuestion: isPickingQuestion,
          hasPicked: Boolean(pickedContainer && document.body.contains(pickedContainer)),
          settings: agentSettings
        });
        break;

      // Bật/tắt Element Picker từ Popup
      case "PICK_QUESTION":
        if (!document.getElementById("ai-quiz-floating-widget")) {
          injectFloatingWidget();
        }
        startQuestionPicker();
        sendResponse({ success: true, isPicking: true });
        break;

      case "CANCEL_PICK":
        stopQuestionPicker();
        sendResponse({ success: true });
        break;

      // Xóa vùng câu hỏi đã chọn thủ công
      case "CLEAR_PICKED":
        pickedContainer = null;
        sendResponse({ success: true });
        break;

      // Cập nhật cài đặt hành vi từ Popup
      case "UPDATE_SETTINGS":
        if (typeof message.settings === "object" && message.settings) {
          const s = message.settings;
          if (typeof s.autoNextPage === "boolean") agentSettings.autoNextPage = s.autoNextPage;
          if (s.answerMode === "random" || s.answerMode === "confidence") agentSettings.answerMode = s.answerMode;
          if (typeof s.useCache === "boolean") agentSettings.useCache = s.useCache;
          if (typeof s.nextDelay === "number") agentSettings.nextDelay = s.nextDelay;
          syncWidgetSettingsUI();
        }
        sendResponse({ success: true, settings: agentSettings });
        break;

      default:
        break;
    }
  });

  /* ==========================================================================
     6. AUTO DETECTION: Chỉ hiển thị Widget khi thực sự là trang trắc nghiệm
     ========================================================================== */

  /**
   * Nhận biết trang hiện tại có phải trang trắc nghiệm hay không.
   * Điều kiện: có khối câu hỏi hợp lệ hoặc có >= 2 lựa chọn (radio/checkbox).
   */
  function isQuizPage() {
    if (findQuestionContainers().length > 0) return true;
    const choices = document.querySelectorAll(
      'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'
    );
    return choices.length >= 2;
  }

  let detectObserver = null;
  let detectInterval = null;

  function stopDetection() {
    if (detectObserver) {
      detectObserver.disconnect();
      detectObserver = null;
    }
    if (detectInterval) {
      clearInterval(detectInterval);
      detectInterval = null;
    }
  }

  function tryInjectWidget() {
    // Đã có widget -> không cần theo dõi nữa
    if (document.getElementById("ai-quiz-floating-widget")) {
      stopDetection();
      return true;
    }

    // Chưa phải trang trắc nghiệm -> chờ tiếp
    if (!isQuizPage()) return false;

    injectFloatingWidget();
    stopDetection();
    resumeAutoIfNeeded();
    return true;
  }

  function startDetection() {
    // Thử nhận diện ngay khi trang đã tải
    if (tryInjectWidget()) return;

    // Theo dõi thay đổi DOM (SPA) với debounce để tránh tốn CPU
    let debounceTimer = null;
    detectObserver = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(tryInjectWidget, 600);
    });
    detectObserver.observe(document.documentElement, { childList: true, subtree: true });

    // Poll dự phòng mỗi 2 giây (một số trang render câu hỏi trễ)
    detectInterval = setInterval(tryInjectWidget, 2000);
  }

  /**
   * Nếu tab này đang ở chế độ Auto trước khi trang bị reload -> tự khôi phục.
   */
  function resumeAutoIfNeeded() {
    try {
      chrome.runtime.sendMessage({ action: "RESUME_STATE" }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        if (res.shouldRun) toggleAutoMode(true);
      });
    } catch (e) {
      // Extension context có thể đã bị reload -> bỏ qua
    }
  }

  // Khởi động: nạp cấu hình hành vi + bộ nhận diện
  loadAgentSettings();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startDetection);
  } else {
    startDetection();
  }
})();
