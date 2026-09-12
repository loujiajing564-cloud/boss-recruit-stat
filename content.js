(() => {
  if (globalThis.__bossDupTrackerV1) return;
  globalThis.__bossDupTrackerV1 = true;

  const clean = (value) => String(value || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  let stopped = false;
  let session = { active: false, id: null };
  let currentKey = "";
  let pendingKey = "";
  let pendingSince = 0;
  let detectionToken = 0;
  let scanTimer = null;
  let stateTimer = null;
  let recruitTimer = null;
  let lateResultTimer = null;
  let settingsRevision = null;
  let overlayDragging = false;
  let lastJobContext = "";
  let lastRecruitSignature = "";

  const RECRUIT_METRICS = {
    viewedByMe: ["我看过"],
    viewedMe: ["看过我"],
    greetedByMe: ["我打招呼"],
    newGreetings: ["牛人新招呼"],
    communicatedByMe: ["我沟通"],
    resumesReceived: ["收获简历"],
    contactsExchanged: ["交换电话/微信", "交换电话微信", "交换电话 / 微信", "交换联系方式", "交换联系信息"]
  };
  const RECRUIT_LABELS = new Set(Object.values(RECRUIT_METRICS).flat().map(clean));

  function stop() {
    stopped = true;
    detectionToken += 1;
    if (scanTimer !== null) clearInterval(scanTimer);
    if (stateTimer !== null) clearInterval(stateTimer);
    if (recruitTimer !== null) clearInterval(recruitTimer);
    if (lateResultTimer !== null) clearTimeout(lateResultTimer);
  }

  function send(message, callback) {
    if (stopped) return;
    try {
      chrome.runtime.sendMessage(message, (response) => {
        try {
          if (chrome.runtime.lastError) {
            stop();
            return;
          }
          callback?.(response);
        } catch {
          stop();
        }
      });
    } catch {
      stop();
    }
  }

  function applyState(response) {
    if (!response?.ok || !response.state) return;
    const previousId = session.id;
    const nextRevision = response.state.settings?.revision ?? 0;
    const settingsChanged = settingsRevision !== null && nextRevision !== settingsRevision;
    settingsRevision = nextRevision;
    session = response.state.session;
    render(response.state);
    if (previousId !== session.id || !session.active) {
      currentKey = "";
      pendingKey = "";
      detectionToken += 1;
    } else if (settingsChanged && top !== self) {
      currentKey = "";
      pendingKey = "";
      pendingSince = 0;
      detectionToken += 1;
    }
  }

  function render(state) {
    if (top !== self || !state) return;
    let root = document.querySelector("#boss-dup-overlay");
    if (!state.session.active) {
      root?.remove();
      return;
    }
    if (!root) {
      root = document.createElement("aside");
      root.id = "boss-dup-overlay";
      document.documentElement.append(root);
      makeOverlayDraggable(root);
    }
    if (!overlayDragging && state.settings?.overlayPosition) {
      const width = root.offsetWidth || 225;
      const height = root.offsetHeight || 160;
      const left = Math.max(8, Math.min(state.settings.overlayPosition.left, window.innerWidth - width - 8));
      const topPosition = Math.max(8, Math.min(state.settings.overlayPosition.top, window.innerHeight - height - 8));
      root.style.left = `${left}px`;
      root.style.top = `${topPosition}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    }
    const labels = { idle: "等待打开候选人", loading: "🟡 正在识别…", duplicate: "🔴 本组已沟通", not_duplicate: "🟢 未发现本组沟通", unknown: "🟡 暂无法判断" };
    const stats = state.statistics;
    const escapeHtml = (value) => clean(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
    const job = state.session.jobTitle ? `<div class="boss-dup-job">岗位：${escapeHtml(state.session.jobTitle)}</div><div class="boss-dup-base">Base：${escapeHtml(state.session.baseCity || "识别中")}</div>` : `<div class="boss-dup-job">岗位：识别中…</div>`;
    root.innerHTML = `<div class="boss-dup-header"><b>人选重复统计 v1.15.5</b><button type="button" class="boss-dup-drag-handle" aria-label="拖动统计面板" title="按住拖动">✥ 拖动</button></div>${job}<div>${labels[state.current.status] || labels.idle}</div>${state.current.matchedMembers?.length ? `<div>同事：${state.current.matchedMembers.map(escapeHtml).join("、")}</div>` : ""}<small>浏览 ${stats.viewed}　识别 ${stats.detected}　重复 ${stats.duplicates}<br>失败 ${stats.unknown}　重复率 ${stats.rate.toFixed(1)}%</small><em>${escapeHtml(state.current.reason || "")}</em>`;
  }

  function readJobContext() {
    const lines = String(document.body?.innerText || "").split(/\n+/).map(clean).filter(Boolean);
    for (const text of lines) {
      if (text.length < 8 || text.length > 180) continue;
      const match = text.match(/[_＿]\s*([\u3400-\u9FFF]{2,10})\s*(\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?K(?:\s*[·・]\s*\d+薪)?)\s*$/i);
      if (!match) continue;
      const baseCity = clean(match[1]);
      const jobTitle = clean(text.replace(/\s*[_＿]\s*/g, " _ "));
      return { jobTitle, baseCity };
    }
    const salaryElements = [...document.querySelectorAll("body *")].filter((element) =>
      element.offsetParent !== null && /^\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?K$/i.test(clean(element.textContent))
    );
    for (const salaryElement of salaryElements) {
      let container = salaryElement.parentElement;
      for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
        const text = clean(container.innerText || container.textContent);
        const match = text.match(/[_＿]\s*([\u3400-\u9FFF]{2,10})\s*(\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?K)\s*$/i);
        if (match && text.length <= 180) return { jobTitle: clean(text.replace(/\s*[_＿]\s*/g, " _ ")), baseCity: clean(match[1]) };
      }
    }
    return null;
  }

  function reportJobContext() {
    if (!session.active) return;
    const context = readJobContext();
    if (!context) return;
    const signature = `${session.id}|${context.jobTitle}|${context.baseCity}`;
    if (signature === lastJobContext) return;
    lastJobContext = signature;
    send({ type: "JOB_CONTEXT", sessionId: session.id, ...context }, applyState);
  }

  function makeOverlayDraggable(root) {
    let pointerId = null;
    let offsetX = 0;
    let offsetY = 0;
    root.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".boss-dup-drag-handle")) return;
      const rect = root.getBoundingClientRect();
      pointerId = event.pointerId;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      overlayDragging = true;
      root.classList.add("boss-dup-dragging");
      root.setPointerCapture?.(pointerId);
      event.preventDefault();
      event.stopPropagation();
    });
    root.addEventListener("pointermove", (event) => {
      if (!overlayDragging || event.pointerId !== pointerId) return;
      const left = Math.max(8, Math.min(event.clientX - offsetX, window.innerWidth - root.offsetWidth - 8));
      const topPosition = Math.max(8, Math.min(event.clientY - offsetY, window.innerHeight - root.offsetHeight - 8));
      root.style.left = `${left}px`;
      root.style.top = `${topPosition}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    });
    const finish = (event) => {
      if (!overlayDragging || event.pointerId !== pointerId) return;
      overlayDragging = false;
      root.classList.remove("boss-dup-dragging");
      root.releasePointerCapture?.(pointerId);
      pointerId = null;
      const rect = root.getBoundingClientRect();
      send({ type: "SAVE_OVERLAY_POSITION", position: { left: Math.round(rect.left), top: Math.round(rect.top) } });
    };
    root.addEventListener("pointerup", finish);
    root.addEventListener("pointercancel", finish);
  }

  function isRecruitDataUrl(value) {
    try {
      return new URL(value, location.href).pathname.includes("/web/chat/data-recruit");
    } catch {
      return false;
    }
  }

  function hasRecruitDataPageUrl() {
    if (isRecruitDataUrl(location.href) || isRecruitDataUrl(document.referrer)) return true;
    try {
      return isRecruitDataUrl(top.location.href);
    } catch {
      return false;
    }
  }

  function isRecruitDataPage() {
    if (!hasRecruitDataPageUrl()) return false;
    const text = clean(document.body?.innerText || document.body?.textContent);
    const markerFound = text.includes("招聘数据中心") || text.includes("数据概览") || text.includes("招聘数据");
    const metricCount = Object.values(RECRUIT_METRICS).filter((labels) => labels.some((label) => text.includes(label))).length;
    return markerFound && metricCount >= 2;
  }

  function elementText(element) {
    return clean(element?.textContent);
  }

  function exactTextElements(labels) {
    const wanted = new Set(labels.map(clean));
    const found = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!wanted.has(clean(node.nodeValue))) continue;
      const element = node.parentElement;
      if (element && !seen.has(element)) {
        seen.add(element);
        found.push(element);
      }
    }
    if (found.length) return found;
    for (const element of document.querySelectorAll("body *")) {
      if (!wanted.has(elementText(element))) continue;
      if ([...element.children].some((child) => wanted.has(elementText(child)))) continue;
      found.push(element);
    }
    return found;
  }

  function parseNonNegativeInteger(value) {
    const match = clean(value).match(/^(\d[\d,，]*)\s*(?:人|次)?$/);
    if (!match) return null;
    const number = Number(match[1].replace(/[,，]/g, ""));
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  function numericLeaves(container) {
    const candidates = [];
    const elements = [container, ...container.querySelectorAll("*")];
    for (const element of elements) {
      const value = parseNonNegativeInteger(elementText(element));
      if (value === null) continue;
      if ([...element.children].some((child) => parseNonNegativeInteger(elementText(child)) !== null)) continue;
      candidates.push({ element, value });
    }
    return candidates;
  }

  function treeDistance(left, right) {
    const leftAncestors = new Map();
    let node = left;
    let depth = 0;
    while (node && depth < 12) {
      leftAncestors.set(node, depth);
      node = node.parentElement;
      depth += 1;
    }
    node = right;
    depth = 0;
    while (node && depth < 12) {
      if (leftAncestors.has(node)) return depth + leftAncestors.get(node);
      node = node.parentElement;
      depth += 1;
    }
    return 99;
  }

  function chooseMetricNumber(labelElement, candidates) {
    if (!candidates.length) return null;
    const scored = candidates.map((candidate) => {
      const sibling = candidate.element.parentElement === labelElement.parentElement ? 6 : 0;
      const visible = candidate.element.offsetParent !== null ? 1 : 0;
      return { ...candidate, score: sibling + visible - treeDistance(labelElement, candidate.element) };
    }).sort((left, right) => right.score - left.score);
    if (scored.length > 1 && scored[0].score === scored[1].score && scored[0].value !== scored[1].value) return null;
    return scored[0].value;
  }

  function parseMetricByLabels(labels) {
    for (const labelElement of exactTextElements(labels)) {
      let container = labelElement;
      for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
        if (container !== labelElement) {
          const otherMetricLabels = [...container.querySelectorAll("*")].filter((element) => {
            const text = elementText(element);
            return RECRUIT_LABELS.has(text) && !labels.map(clean).includes(text);
          });
          if (otherMetricLabels.length) break;
        }
        const candidates = numericLeaves(container).filter((candidate) => !labelElement.contains(candidate.element));
        const values = [...new Set(candidates.map((candidate) => candidate.value))];
        if (values.length === 1) return values[0];
        if (values.length > 1) {
          const chosen = chooseMetricNumber(labelElement, candidates);
          if (chosen !== null) return chosen;
        }
      }
    }
    return null;
  }

  function toIsoDate(year, month, day) {
    const candidate = new Date(year, month - 1, day);
    if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function dateFromText(value) {
    const text = clean(value)
      .replace(/^(?:日期|日报日期)\s*[:：]\s*/, "")
      .replace(/\s*(?:星期|周)[一二三四五六日天]\s*$/, "");
    if (/^(今天|今日)(?:数据)?$/.test(text)) {
      const now = new Date();
      return toIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
    }
    let match = text.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
    if (match) return toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    match = text.match(/^(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
    if (match) {
      const now = new Date();
      return toIsoDate(now.getFullYear(), Number(match[1]), Number(match[2]));
    }
    return null;
  }

  function parseRecruitDate() {
    const candidates = [];
    for (const element of document.querySelectorAll("body *")) {
      const text = elementText(element);
      if (!text || text.length > 24 || [...element.children].some((child) => elementText(child) === text)) continue;
      const date = dateFromText(text);
      if (!date) continue;
      let score = element.offsetParent !== null ? 2 : 0;
      if (/^\d{4}/.test(text)) score += 2;
      if (/^(今天|今日)(?:数据)?$/.test(text)) score += 6;
      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
        const parentText = elementText(parent);
        if (parentText.includes("日报") || parentText.includes("数据概览")) score += 3;
      }
      candidates.push({ date, score });
    }
    candidates.sort((left, right) => right.score - left.score);
    if (!candidates.length) return null;
    const best = candidates.filter((candidate) => candidate.score === candidates[0].score);
    return new Set(best.map((candidate) => candidate.date)).size === 1 ? best[0].date : null;
  }

  function isPossibleJobTitle(value) {
    const text = clean(value).replace(/\s*[竞普]\s*$/, "");
    return text.length >= 2 && text.length <= 80 && !/^\d/.test(text)
      && !RECRUIT_LABELS.has(text)
      && !/招聘数据|数据概览|日报|趋势|当前岗位|选择岗位|全部岗位|工作城市|Base|城市|筛选|导出/.test(text);
  }

  function normalizeBaseCity(value) {
    const text = clean(value).replace(/^(?:Base|工作城市|工作地点|城市)\s*[:：]?\s*/i, "").replace(/市$/, "");
    return /^[\u3400-\u9FFFA-Za-z·-]{2,20}$/.test(text) ? text : null;
  }

  function isRecruitSalaryText(value) {
    const text = clean(value);
    return /\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*(?:K|千|万元?|元)(?:\s*[／/]\s*(?:月|天|年))?/i.test(text)
      || /(?:薪资)?面议/.test(text);
  }

  function baseCityFromRecruitLine(value) {
    const text = clean(value);
    const match = text.match(/^([\u3400-\u9FFFA-Za-z·-]{2,20})(?:市)?(?:\s*[（(]([^）)]*)[）)])?$/i);
    if (match?.[2] && !isRecruitSalaryText(match[2])) return null;
    return match ? normalizeBaseCity(match[1]) : null;
  }

  function isRecruitSalaryBaseLine(value) {
    const text = clean(value);
    const match = text.match(/^[\u3400-\u9FFFA-Za-z·-]{2,20}(?:市)?\s*[（(]([^）)]*)[）)]$/i);
    return Boolean(match && isRecruitSalaryText(match[1]));
  }

  function normalizeRecruitJobTitle(value) {
    const text = clean(value).replace(/\s*[竞普]\s*$/, "");
    return isPossibleJobTitle(text) ? text : null;
  }

  function contextFromLines(lines) {
    const cleaned = lines.map(clean).filter(Boolean);
    if (cleaned.length < 2 || cleaned.length > 8) return null;
    const explicitBaseIndex = cleaned.findIndex((line) => /^(?:Base|工作城市|工作地点|城市)\s*[:：]/i.test(line));
    if (explicitBaseIndex >= 0) {
      const baseCity = normalizeBaseCity(cleaned[explicitBaseIndex]);
      const jobTitle = cleaned.slice(0, explicitBaseIndex).map(normalizeRecruitJobTitle).find(Boolean)
        || cleaned.slice(explicitBaseIndex + 1).map(normalizeRecruitJobTitle).find(Boolean);
      if (jobTitle && baseCity) return { jobTitle, baseCity };
    }
    if (cleaned.length <= 4) {
      for (let index = cleaned.length - 1; index >= 1; index -= 1) {
        const baseCity = baseCityFromRecruitLine(cleaned[index]);
        if (!baseCity) continue;
        const jobTitle = cleaned.slice(0, index).map(normalizeRecruitJobTitle).find(Boolean);
        if (jobTitle && jobTitle !== baseCity) return { jobTitle: clean(jobTitle), baseCity };
      }
    }
    return null;
  }

  function parseSelectedRecruitJob() {
    const selectedCandidates = [];
    const isSelectedTeal = (element) => {
      const color = getComputedStyle(element).color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
      if (!color) return false;
      const [red, green, blue] = color;
      return red <= 125 && green >= 135 && blue >= 115 && green > red + 35 && Math.abs(green - blue) <= 75;
    };

    for (const baseElement of document.querySelectorAll("body *")) {
      const baseText = elementText(baseElement);
      if (!isRecruitSalaryBaseLine(baseText)) continue;
      if ([...baseElement.children].some((child) => elementText(child) === baseText)) continue;
      const baseRect = baseElement.getBoundingClientRect();
      const inTopRightJobMenu = baseElement.offsetParent !== null
        && baseRect.width > 0 && baseRect.height > 0
        && baseRect.left >= window.innerWidth * 0.5
        && baseRect.top >= 0 && baseRect.top <= window.innerHeight * 0.65;
      if (!inTopRightJobMenu) continue;

      let container = baseElement.parentElement;
      for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
        const raw = String(container.innerText || container.textContent || "");
        if (raw.length > 220) break;
        const context = contextFromLines(raw.split(/\n+/));
        if (!context || !raw.split(/\n+/).some(isRecruitSalaryBaseLine)) continue;
        const titleElement = [container, ...container.querySelectorAll("*")].find((element) => {
          const title = clean(element.innerText || element.textContent).replace(/\s*[竞普]\s*$/, "");
          return title === context.jobTitle
            && ![...element.children].some((child) => clean(child.innerText || child.textContent).replace(/\s*[竞普]\s*$/, "") === context.jobTitle);
        });
        const semanticallySelected = container.matches?.('[aria-selected="true"], [data-selected="true"]')
          || Boolean(container.querySelector?.('[aria-selected="true"], [data-selected="true"]'));
        if (!titleElement || (!isSelectedTeal(titleElement) && !semanticallySelected)) continue;
        selectedCandidates.push({ ...context, depth });
        break;
      }
    }

    selectedCandidates.sort((left, right) => left.depth - right.depth);
    if (selectedCandidates.length) {
      const closest = selectedCandidates.filter((candidate) => candidate.depth === selectedCandidates[0].depth);
      const unique = new Set(closest.map((candidate) => `${candidate.jobTitle}|${candidate.baseCity}`));
      if (unique.size === 1) return closest[0];
    }
    return { jobTitle: null, baseCity: null };
  }

  function readRecruitDailySnapshot() {
    if (!isRecruitDataPage()) return null;
    const context = parseSelectedRecruitJob();
    const boss = {};
    for (const [key, labels] of Object.entries(RECRUIT_METRICS)) boss[key] = parseMetricByLabels(labels);
    const snapshot = {
      date: parseRecruitDate(),
      jobTitle: context.jobTitle,
      baseCity: context.baseCity,
      capturedAt: new Date().toISOString(),
      boss,
      missingFields: []
    };
    snapshot.missingFields = [
      ...["date", "jobTitle", "baseCity"].filter((key) => !snapshot[key]),
      ...Object.keys(RECRUIT_METRICS).filter((key) => snapshot.boss[key] === null)
    ];
    return snapshot;
  }

  function recruitSignature(snapshot) {
    if (!snapshot) return "";
    return JSON.stringify({ date: snapshot.date, jobTitle: snapshot.jobTitle, baseCity: snapshot.baseCity, boss: snapshot.boss });
  }

  function reportRecruitDraft() {
    if (top !== self) return;
    const snapshot = readRecruitDailySnapshot();
    const signature = recruitSignature(snapshot);
    if (!signature || signature === lastRecruitSignature) return;
    lastRecruitSignature = signature;
    send({ type: "RECRUIT_DRAFT", snapshot }, (response) => {
      if (!response?.ok) console.warn("[BossDupRecruit] 日报草稿上报失败", response?.error || "unknown");
    });
  }

  function hash(value) {
    let result = 2166136261;
    for (const character of value) {
      result ^= character.charCodeAt(0);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  }

  function communicationTab() {
    const labels = ["同事沟通", "同事沟通进度"];
    return [...document.querySelectorAll("body *")].find((element) =>
      element.offsetParent !== null && labels.includes(clean(element.textContent)) &&
      ![...element.children].some((child) => labels.includes(clean(child.textContent)))
    ) || null;
  }

  function visiblePageText() {
    return clean(document.body?.innerText);
  }

  function isCandidateDetail() {
    const text = visiblePageText();
    const hasActions = text.includes("打招呼") && (text.includes("帮我联系") || text.includes("不合适"));
    const hasProfile = /(?:^|\D)\d{2}岁(?:\D|$)/.test(text) && /(大专|本科|硕士|博士|高中|中专)/.test(text);
    const hasResume = text.includes("工作经历") || text.includes("经历概览");
    return hasActions && hasProfile && hasResume;
  }

  function candidateKey() {
    if (!isCandidateDetail()) return null;
    const explicit = document.querySelector("[data-geek-id], [data-candidate-id]");
    if (explicit) {
      const value = explicit.getAttribute("data-geek-id") || explicit.getAttribute("data-candidate-id");
      if (value) return `id:${value}`;
    }
    const rawText = document.body?.innerText || "";
    const lines = rawText.split(/\n+/).map(clean).filter(Boolean);
    const name = lines.find((line) => line.length >= 2 && line.length <= 12 && !/推荐牛人|在线|刚刚|活跃|收藏|不合适|举报|转发|帮我联系|打招呼|同事沟通|我的沟通/.test(line)) || "";
    const demographics = lines.find((line) => /(?:^|\D)\d{2}岁(?:\D|$)/.test(line) && /(大专|本科|硕士|博士|高中|中专)/.test(line)) || "";
    const experienceIndex = lines.findIndex((line) => line === "工作经历" || line === "经历概览");
    const firstExperience = experienceIndex >= 0
      ? lines.slice(experienceIndex + 1, experienceIndex + 8).find((line) => line.length >= 4 && line.length <= 80) || ""
      : "";
    if (!name || !demographics) return null;
    return `fp:${hash(`${name}|${demographics}|${firstExperience}`)}`;
  }

  function parseRecords() {
    if (!isCandidateDetail()) return { ready: false, colleagueNames: [], reason: "候选人详情已关闭" };
    const parser = globalThis.BossDupCommunicationParser;
    const recordTexts = [...document.querySelectorAll("body *")]
      .filter((element) => {
        if (element.offsetParent === null) return false;
        const elementText = clean(element.innerText || element.textContent);
        if (!elementText.includes("发起沟通")) return false;
        return ![...element.children].some((child) => clean(child.innerText || child.textContent).includes("发起沟通"));
      })
      .map((element) => clean(element.innerText || element.textContent));
    let names = parser?.namesFromRecords(recordTexts) || [];
    if (!names.length) {
      const lines = String(document.body?.innerText || "").split(/\n+/).map(clean).filter((line) => line.includes("发起沟通"));
      names = parser?.namesFromRecords(lines) || [];
    }
    if (names.length) return { ready: true, colleagueNames: names, reason: "已逐条读取沟通记录" };
    const text = clean(document.body?.innerText || document.body?.textContent);
    const hasCommunicationSection = communicationTab() || /同事沟通(?:进度)?/.test(text);
    if (hasCommunicationSection && /暂无.{0,8}(同事)?沟通|暂无记录/.test(text)) {
      return { ready: true, colleagueNames: [], reason: "明确无沟通记录" };
    }
    return {
      ready: false,
      colleagueNames: [],
      moduleAbsent: !hasCommunicationSection,
      reason: hasCommunicationSection ? "同事沟通模块内容尚未就绪" : "同事沟通模块尚未渲染"
    };
  }

  function watchForLateResult(key, token, viewToken) {
    if (stopped || token !== detectionToken || candidateKey() !== key || !session.active) return;
    const result = parseRecords();
    if (result.ready) {
      send({ type: "CANDIDATE_RESULT", sessionId: session.id, candidateKey: key, viewToken, ready: true, colleagueNames: result.colleagueNames, reason: result.reason }, applyState);
      return;
    }
    lateResultTimer = setTimeout(() => watchForLateResult(key, token, viewToken), 500);
  }

  function detectResult(key, token, viewToken, attempt) {
    if (stopped || token !== detectionToken || candidateKey() !== key) return;
    const result = parseRecords();
    const settledWithoutRecords = !result.ready && attempt >= 8;
    if (result.ready || settledWithoutRecords) {
      const reason = settledWithoutRecords
        ? "未显示同事沟通记录，按未沟通过处理"
        : result.reason;
      send({ type: "CANDIDATE_RESULT", sessionId: session.id, candidateKey: key, viewToken, ready: true, colleagueNames: result.colleagueNames, reason }, applyState);
      // BOSS 有时会晚几秒才补上沟通模块。先按不重复计数，同时继续观察；
      // 如果记录随后出现，后台会用同一个候选人键自动纠正，不会重复增加浏览人数。
      if (settledWithoutRecords) watchForLateResult(key, token, viewToken);
      return;
    }
    setTimeout(() => detectResult(key, token, viewToken, attempt + 1), 250);
  }

  function beginCandidate(key) {
    currentKey = key;
    const token = ++detectionToken;
    const viewToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    send({ type: "CANDIDATE_SEEN", sessionId: session.id, candidateKey: key, viewToken }, (response) => {
      applyState(response);
      detectResult(key, token, viewToken, 0);
    });
  }

  function scan() {
    if (stopped || !session.active) return;
    reportJobContext();
    if (top === self) {
      return;
    }
    if (!session.jobTitle || !session.baseCity) {
      pendingKey = "";
      pendingSince = 0;
      currentKey = "";
      return;
    }
    const key = candidateKey();
    if (!key) {
      pendingKey = "";
      pendingSince = 0;
      currentKey = "";
      detectionToken += 1;
      if (lateResultTimer !== null) clearTimeout(lateResultTimer);
      return;
    }
    if (key !== pendingKey) {
      pendingKey = key;
      pendingSince = Date.now();
      detectionToken += 1;
      if (lateResultTimer !== null) clearTimeout(lateResultTimer);
      return;
    }
    if (key !== currentKey && Date.now() - pendingSince >= 300) beginCandidate(key);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "READ_RECRUIT_DAILY" || !isRecruitDataPage()) return false;
    try {
      const snapshot = readRecruitDailySnapshot();
      if (!snapshot) return false;
      sendResponse({ ok: true, snapshot });
    } catch (error) {
      console.warn("[BossDupRecruit] 读取日报失败", error);
      sendResponse({ ok: false, error: "RECRUIT_PARSE_FAILED" });
    }
    return false;
  });

  send({ type: "GET_STATE" }, (response) => {
    applyState(response);
    if (stopped) return;
    scanTimer = setInterval(scan, 150);
    stateTimer = setInterval(() => send({ type: "GET_STATE" }, applyState), 750);
    if (top === self) {
      reportRecruitDraft();
      recruitTimer = setInterval(reportRecruitDraft, 1000);
    }
  });
})();
