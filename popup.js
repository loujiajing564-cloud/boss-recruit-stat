const $ = (selector) => document.querySelector(selector);
const request = (message) => chrome.runtime.sendMessage(message);
const requestWithTimeout = (message, timeoutMs = 18000) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("BACKGROUND_TIMEOUT")), timeoutMs);
  request(message).then(resolve, reject).finally(() => clearTimeout(timeout));
});
const RECRUIT_METRIC_FIELDS = {
  viewedByMe: ["#recruitViewedByMe", "我看过"],
  viewedMe: ["#recruitViewedMe", "看过我"],
  greetedByMe: ["#recruitGreetedByMe", "我打招呼"],
  newGreetings: ["#recruitNewGreetings", "牛人新招呼"],
  communicatedByMe: ["#recruitCommunicatedByMe", "我沟通"],
  resumesReceived: ["#recruitResumesReceived", "收获简历"],
  contactsExchanged: ["#recruitContactsExchanged", "交换联系方式"]
};
let currentState;
let draftReadThisPopup = false;
let dingTalkConfigured = false;
const syncingRecruitIds = new Set();
const syncingRecruitErrors = new Map();

function members() {
  return [...new Set($("#members").value.split(/[、，,；;\r\n]+/).map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function formatMetric(value) {
  return Number.isInteger(value) && value >= 0 ? String(value) : "读取失败 / null";
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Number(value).toFixed(2)}%` : "暂无";
}

function hasCompleteDraft(draft) {
  return Boolean(draft?.date && draft?.jobTitle && draft?.baseCity)
    && Object.keys(RECRUIT_METRIC_FIELDS).every((key) => Number.isInteger(draft.boss?.[key]) && draft.boss[key] >= 0);
}

function renderHistory(history) {
  const list = $("#historyList");
  list.replaceChildren();
  $("#emptyHistory").hidden = history.length > 0;
  $("#clear").hidden = history.length === 0;
  for (const item of history) {
    const card = document.createElement("article");
    card.className = "history-item";
    card.innerHTML = `<div class="history-title"><span class="history-date"></span><button class="delete">删除</button></div><div class="history-job"></div><div class="history-base"></div><div class="history-members"></div><div class="history-stats"><span>查看<strong>${Number(item.viewed) || 0}</strong></span><span>识别<strong>${Number(item.detected) || 0}</strong></span><span>已沟通<strong>${Number(item.duplicates) || 0}</strong></span><span>失败<strong>${Number(item.unknown) || 0}</strong></span><span>重复率<strong>${Number(item.rate).toFixed(1)}%</strong></span></div>`;
    card.querySelector(".history-date").textContent = formatDate(item.endedAt);
    card.querySelector(".history-job").textContent = `岗位：${item.jobTitle || "未识别"}`;
    card.querySelector(".history-base").textContent = `Base：${item.baseCity || "未识别"}`;
    card.querySelector(".history-members").textContent = `同事：${item.members?.join("、") || "未设置"}`;
    card.querySelector(".delete").onclick = async () => {
      if (!confirm("确定删除这条重复统计历史吗？")) return;
      const result = await request({ type: "DELETE_HISTORY", id: item.id });
      if (result?.ok) render(result.state);
    };
    list.append(card);
  }
}

function fillRecruitRecordRow(row, item) {
  row.querySelector(".daily-date").textContent = item.date || "日期缺失";
  row.querySelector(".daily-job").textContent = item.jobTitle || "读取失败 / null";
  row.querySelector(".daily-base").textContent = `Base：${item.baseCity || "读取失败 / null"}`;
  const bossText = Object.entries(RECRUIT_METRIC_FIELDS)
    .map(([key, [, label]]) => `${label} ${formatMetric(item.boss?.[key])}`)
    .join("　");
  row.querySelector(".daily-boss").textContent = `BOSS：${bossText}`;
  row.querySelector(".daily-duplicate").textContent = item.duplicate
    ? `已合并重复统计：浏览 ${item.duplicate.viewed}　识别 ${item.duplicate.detected}　重复 ${item.duplicate.duplicates}　失败 ${item.duplicate.unknown}　重复率 ${formatPercent(item.duplicate.duplicateRate)}　新鲜率 ${formatPercent(item.duplicate.freshRate)}`
    : "重复统计：未合并";
  const syncState = row.querySelector(".sync-state");
  if (syncingRecruitIds.has(item.id)) {
    syncState.textContent = "正在发送，最多等待 15 秒…";
    syncState.className = "sync-state";
  } else if (syncingRecruitErrors.has(item.id)) {
    syncState.textContent = syncingRecruitErrors.get(item.id);
    syncState.className = "sync-state failed";
  } else if (item.dingTalkSync?.status === "success") {
    syncState.textContent = `已同步 ${formatDate(item.dingTalkSync.syncedAt)}`;
    syncState.className = "sync-state success";
  } else if (item.dingTalkSync?.status === "failed") {
    syncState.textContent = `失败：${item.dingTalkSync.error || "请重试"}`;
    syncState.className = "sync-state failed";
  } else {
    syncState.textContent = item.duplicate ? (dingTalkConfigured ? "未同步" : "未配置工作流") : "合并后可同步";
    syncState.className = dingTalkConfigured || !item.duplicate ? "sync-state" : "sync-state failed";
  }
}

function renderRecruitHistory(history) {
  const list = $("#recruitHistoryList");
  list.replaceChildren();
  $("#emptyRecruitHistory").hidden = history.length > 0;
  list.closest(".daily-table-wrap").hidden = history.length === 0;
  for (const item of history) {
    const row = document.createElement("tr");
    row.innerHTML = `<td class="daily-date"></td><td><div class="daily-job"></div><div class="daily-base"></div></td><td><div class="daily-boss"></div><div class="daily-duplicate"></div></td><td><button class="sync">同步</button><div class="sync-state"></div><button class="delete">删除</button></td>`;
    fillRecruitRecordRow(row, item);
    const syncButton = row.querySelector(".sync");
    syncButton.disabled = !item.duplicate || syncingRecruitIds.has(item.id);
    syncButton.textContent = syncingRecruitIds.has(item.id) ? "同步中…" : !dingTalkConfigured ? "先配置" : item.dingTalkSync?.status === "success" ? "重新同步" : item.dingTalkSync?.status === "failed" ? "重试" : "同步";
    syncButton.onclick = async () => {
      if (!item.duplicate) return;
      if (!dingTalkConfigured) {
        $("#dingtalkSettings").open = true;
        $("#dingtalkConfigMsg").textContent = "请先粘贴并保存钉钉自动化工作流 Webhook，再点击同步。";
        $("#dingtalkWebhook").focus();
        return;
      }
      if (item.dingTalkSync?.status === "success" && !confirm("该记录已经同步过，是否使用相同同步键重新发送？")) return;
      syncingRecruitErrors.delete(item.id);
      syncingRecruitIds.add(item.id);
      renderRecruitHistory(currentState?.recruitDailyHistory || []);
      try {
        const result = await requestWithTimeout({ type: "SYNC_RECRUIT_DAILY", id: item.id });
        syncingRecruitIds.delete(item.id);
        if (result?.state) render(result.state);
        if (result?.ok) {
          $("#recruitMsg").textContent = "已发送到钉钉 AI 表格工作流。";
        } else if (result?.error === "DINGTALK_NOT_CONFIGURED") {
          dingTalkConfigured = false;
          renderRecruitHistory(currentState?.recruitDailyHistory || []);
          $("#dingtalkSettings").open = true;
          $("#dingtalkConfigMsg").textContent = "Webhook 尚未保存，请配置后重试。";
        } else if (result?.error === "RECRUIT_DAILY_NOT_MERGED") {
          $("#recruitMsg").textContent = "该日报尚未合并查重数据，不能同步完整记录。";
        } else {
          const message = result?.message || `同步失败（${result?.error || "未知错误"}）`;
          syncingRecruitErrors.set(item.id, message);
          renderRecruitHistory(currentState?.recruitDailyHistory || []);
          $("#recruitMsg").textContent = message;
        }
      } catch {
        syncingRecruitIds.delete(item.id);
        syncingRecruitErrors.set(item.id, "等待后台超过 18 秒，请重新加载扩展并检查钉钉工作流");
        renderRecruitHistory(currentState?.recruitDailyHistory || []);
        $("#recruitMsg").textContent = syncingRecruitErrors.get(item.id);
      }
    };
    row.querySelector(".delete").onclick = async () => {
      if (!confirm("确定删除这条招聘日报吗？此操作不会删除重复统计历史。")) return;
      const result = await request({ type: "DELETE_RECRUIT_DAILY", id: item.id });
      if (result?.ok) render(result.state);
    };
    list.append(row);
  }
}

function renderDingTalkConfig(config) {
  dingTalkConfigured = Boolean(config?.configured);
  $("#savedDingTalkConfig").hidden = !dingTalkConfigured;
  $("#dingtalkWebhookLabel").hidden = dingTalkConfigured;
  $("#dingtalkWebhook").hidden = dingTalkConfigured;
  $("#saveDingTalk").hidden = dingTalkConfigured;
  $("#clearDingTalk").hidden = !dingTalkConfigured;
  $("#dingtalkWebhook").value = "";
  $("#dingtalkWebhook").placeholder = "https://connector.dingtalk.com/webhook/flow/…";
  $("#dingtalkConfigMsg").textContent = dingTalkConfigured
    ? `配置已保存${config.updatedAt ? `（${formatDate(config.updatedAt)}）` : ""}，完整地址仅保存在本机。`
    : "尚未配置。Webhook 仅保存在本机，不会写入插件源码。";
  if (currentState) renderRecruitHistory(currentState.recruitDailyHistory || []);
}

function renderRecruitDraft(draft, duplicate) {
  $("#recruitPreview").hidden = !draft;
  $("#readRecruit").textContent = draft ? "重新读取" : "读取当前日报";
  if (!draft) {
    $("#saveRecruit").disabled = true;
    if (!$("#recruitMsg").textContent) $("#recruitMsg").textContent = "尚未读取当前日报。";
    return;
  }
  $("#recruitDate").textContent = draft.date || "读取失败 / null";
  $("#recruitJob").textContent = draft.jobTitle || "读取失败 / null";
  $("#recruitBase").textContent = draft.baseCity || "读取失败 / null";
  for (const [key, [selector]] of Object.entries(RECRUIT_METRIC_FIELDS)) {
    $(selector).textContent = formatMetric(draft.boss?.[key]);
    $(selector).classList.toggle("missing", draft.boss?.[key] === null || draft.boss?.[key] === undefined);
  }

  $("#noDuplicateData").hidden = Boolean(duplicate);
  $("#duplicatePreview").hidden = !duplicate;
  $("#duplicateTitle").textContent = duplicate
    ? "发现同日、同岗位、同 Base 的重复统计"
    : "可合并的重复统计";
  if (duplicate) {
    $("#dupViewed").textContent = duplicate.viewed;
    $("#dupDetected").textContent = duplicate.detected;
    $("#dupDuplicates").textContent = duplicate.duplicates;
    $("#dupUnknown").textContent = duplicate.unknown;
    $("#dupRate").textContent = formatPercent(duplicate.duplicateRate);
    $("#freshRate").textContent = formatPercent(duplicate.freshRate);
  }

  const contacts = draft.boss?.contactsExchanged;
  const resumes = draft.boss?.resumesReceived;
  const warning = Number.isInteger(contacts) && Number.isInteger(resumes) && contacts > resumes
    ? "提示：交换联系方式大于收获简历，请核对 BOSS 页面口径。确认无误后仍可保存。"
    : "";
  $("#recruitWarning").hidden = !warning;
  $("#recruitWarning").textContent = warning;
  $("#saveRecruit").disabled = !draftReadThisPopup || !hasCompleteDraft(draft);
  if (draftReadThisPopup) {
    $("#recruitMsg").textContent = hasCompleteDraft(draft)
      ? `读取完成：${formatDate(draft.capturedAt)}，请核对后保存。`
      : "部分字段读取失败，请等待页面加载完成后重新读取；失败字段不会被当作 0。";
  } else {
    $("#recruitMsg").textContent = "这是最近一次预览。保存前请点击“重新读取”确认当前页面。";
  }
}

function render(state) {
  currentState = state;
  $("#members").value = (state.settings.members || []).join("、");
  const stats = state.statistics;
  $("#viewed").textContent = stats.viewed;
  $("#detected").textContent = stats.detected;
  $("#duplicates").textContent = stats.duplicates;
  $("#unknown").textContent = stats.unknown;
  $("#rate").textContent = `${stats.rate.toFixed(1)}%`;
  $("#start").hidden = state.session.active;
  $("#end").hidden = !state.session.active;
  renderHistory(state.history || []);
  renderRecruitDraft(state.recruitDraft, state.recruitDraftDuplicate);
  renderRecruitHistory(state.recruitDailyHistory || []);
}

async function readCurrentRecruitPage() {
  $("#readRecruit").disabled = true;
  $("#recruitMsg").textContent = "正在读取当前页面…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("ACTIVE_TAB_NOT_FOUND");
    const parsed = await chrome.tabs.sendMessage(tab.id, { type: "READ_RECRUIT_DAILY" });
    if (!parsed?.ok || !parsed.snapshot) throw new Error(parsed?.error || "RECRUIT_PARSE_FAILED");
    const result = await request({ type: "RECRUIT_DRAFT", snapshot: parsed.snapshot });
    if (!result?.ok) throw new Error(result?.error || "RECRUIT_DRAFT_SAVE_FAILED");
    draftReadThisPopup = true;
    render(result.state);
  } catch (error) {
    draftReadThisPopup = false;
    const cleared = await request({ type: "CLEAR_RECRUIT_DRAFT" });
    if (cleared?.ok) render(cleared.state);
    const code = error?.message || String(error);
    $("#recruitMsg").textContent = code === "NOT_RECRUIT_DATA_PAGE"
      ? "当前页不是“招聘数据—日报”，请人工进入日报页后重试。"
      : "未在当前标签页找到已加载的日报数据。请刷新 BOSS 页面，等待数字出现后重试。";
  } finally {
    $("#readRecruit").disabled = false;
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== tab.dataset.tab; });
  };
});

$("#save").onclick = async () => {
  const result = await request({ type: "SAVE_MEMBERS", members: members() });
  if (result?.ok) {
    render(result.state);
    $("#msg").textContent = "同事名单已保存，已统一使用顿号分隔";
  }
};

$("#start").onclick = async () => {
  const result = await request({ type: "START_SESSION", members: members() });
  if (result?.ok) {
    render(result.state);
    $("#box").hidden = true;
    $("#msg").textContent = "已开始，请关闭窗口并正常查看候选人";
  }
};

$("#end").onclick = async () => {
  if (!confirm("确定结束本次统计并生成报告吗？")) return;
  let result = await request({ type: "END_SESSION" });
  if (!result?.ok) return;
  if (result.mergeCandidateIds?.length && confirm(`发现今天同一岗位、同一 Base 地已有 ${result.mergeCandidateIds.length} 条记录，是否合并？`)) {
    result = await request({ type: "MERGE_HISTORY", id: result.state.session.id, mergeIds: result.mergeCandidateIds });
  }
  render(result.state);
  const state = result.state;
  const record = state.history.find((item) => item.id === state.session.id);
  $("#report").value = JSON.stringify({
    岗位名称: record?.jobTitle || state.session.jobTitle || "未识别",
    Base地: record?.baseCity || state.session.baseCity || "未识别",
    开始时间: record?.startedAt || state.session.startedAt,
    结束时间: record?.endedAt || state.session.endedAt,
    查看总人数: record?.viewed ?? state.statistics.viewed,
    成功识别人数: record?.detected ?? state.statistics.detected,
    已经沟通过人数: record?.duplicates ?? state.statistics.duplicates,
    识别失败人数: record?.unknown ?? state.statistics.unknown,
    有效重复率: `${Number(record?.rate ?? state.statistics.rate).toFixed(1)}%`
  }, null, 2);
  $("#box").hidden = false;
  $("#msg").textContent = "统计已结束，已保存到历史记录";
};

$("#copy").onclick = async () => {
  await navigator.clipboard.writeText($("#report").value);
  $("#msg").textContent = "报告已复制";
};

$("#clear").onclick = async () => {
  if (!confirm("确定清空全部重复统计历史吗？此操作无法撤销。")) return;
  if (!confirm("请再次确认：要清空全部重复统计历史吗？招聘日报不会被删除。")) return;
  const result = await request({ type: "CLEAR_HISTORY" });
  if (result?.ok) render(result.state);
};

$("#readRecruit").onclick = readCurrentRecruitPage;

$("#saveDingTalk").onclick = async () => {
  const webhookUrl = $("#dingtalkWebhook").value.trim();
  if (!webhookUrl) {
    $("#dingtalkConfigMsg").textContent = "请粘贴完整的钉钉自动化工作流 Webhook。";
    return;
  }
  const result = await request({ type: "SAVE_DINGTALK_CONFIG", webhookUrl });
  if (result?.ok) renderDingTalkConfig(result.config);
  else $("#dingtalkConfigMsg").textContent = "地址无效，只支持 connector.dingtalk.com/webhook/flow/…";
};

$("#replaceDingTalk").onclick = () => {
  $("#savedDingTalkConfig").hidden = true;
  $("#dingtalkWebhookLabel").hidden = false;
  $("#dingtalkWebhook").hidden = false;
  $("#saveDingTalk").hidden = false;
  $("#clearDingTalk").hidden = true;
  $("#dingtalkConfigMsg").textContent = "粘贴新地址并保存后才会替换当前配置；取消更换可关闭并重新打开插件。";
  $("#dingtalkWebhook").focus();
};

$("#clearDingTalk").onclick = async () => {
  if (!confirm("确定清除本机保存的钉钉 Webhook 吗？历史记录不会被删除。")) return;
  const result = await request({ type: "CLEAR_DINGTALK_CONFIG" });
  if (result?.ok) renderDingTalkConfig(result.config);
};

$("#saveRecruit").onclick = async () => {
  if (!draftReadThisPopup || !hasCompleteDraft(currentState?.recruitDraft)) return;
  const snapshot = currentState.recruitDraft;
  const saveMessage = { type: "SAVE_RECRUIT_DAILY", snapshot };
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = await request(saveMessage);
    if (result?.error === "DUPLICATE_RECRUIT_DAILY" && saveMessage.overwrite !== true) {
      if (!confirm("今日该岗位已有记录，是否覆盖更新？")) return;
      saveMessage.overwrite = true;
      continue;
    }
    if (result?.error === "RECRUIT_DUPLICATE_MATCH_FOUND" && typeof saveMessage.mergeDuplicate !== "boolean") {
      const duplicate = result.duplicate;
      saveMessage.mergeDuplicate = confirm(
        `发现 ${result.matchCount} 条日期、岗位和 Base 均相同的重复统计记录。\n\n` +
        `浏览 ${duplicate.viewed}，识别 ${duplicate.detected}，重复 ${duplicate.duplicates}，重复率 ${formatPercent(duplicate.duplicateRate)}。\n\n` +
        "是否合并到本次招聘日报？\n确定：合并后保存；取消：不合并，仅保存 BOSS 日报。"
      );
      continue;
    }
    break;
  }
  if (result?.ok) {
    render(result.state);
    $("#recruitMsg").textContent = saveMessage.mergeDuplicate === true
      ? "招聘日报已与重复统计合并，并保存到历史表格。"
      : "招聘日报已保存；重复统计未合并。";
  } else if (result?.error === "MISSING_RECRUIT_METRICS" || result?.error === "MISSING_RECRUIT_CONTEXT") {
    $("#recruitMsg").textContent = "存在读取失败字段，未保存。请等待页面加载后重新读取。";
  } else {
    $("#recruitMsg").textContent = "保存失败，请重新读取后再试。";
  }
};

Promise.all([
  request({ type: "GET_DINGTALK_CONFIG" }),
  request({ type: "GET_STATE" })
]).then(([configResult, stateResult]) => {
  if (configResult?.ok) renderDingTalkConfig(configResult.config);
  if (stateResult?.ok) render(stateResult.state);
});
