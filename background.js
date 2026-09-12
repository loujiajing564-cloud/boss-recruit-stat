const STORAGE_KEY = "bossDupStateV1";
const DINGTALK_CONFIG_KEY = "bossDupDingTalkConfigV1";
const RECRUIT_METRIC_KEYS = [
  "viewedByMe",
  "viewedMe",
  "greetedByMe",
  "newGreetings",
  "communicatedByMe",
  "resumesReceived",
  "contactsExchanged"
];
let queue = Promise.resolve();

function emptyState() {
  return {
    settings: { members: [], revision: 0, overlayPosition: null },
    session: { active: false, id: null, startedAt: null, endedAt: null, jobTitle: "", baseCity: "" },
    candidates: {},
    history: [],
    recruitDraft: null,
    recruitDailyHistory: [],
    current: { status: "idle", matchedMembers: [], reason: "尚未开始统计" }
  };
}

function clean(value) {
  return String(value || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

async function readState() {
  const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  const base = emptyState();
  if (!saved) return base;
  return {
    settings: {
      members: Array.isArray(saved.settings?.members) ? saved.settings.members.map(clean).filter(Boolean) : [],
      revision: Number(saved.settings?.revision) || 0,
      overlayPosition: saved.settings?.overlayPosition && Number.isFinite(saved.settings.overlayPosition.left) && Number.isFinite(saved.settings.overlayPosition.top)
        ? { left: saved.settings.overlayPosition.left, top: saved.settings.overlayPosition.top }
        : null
    },
    session: { ...base.session, ...(saved.session || {}) },
    candidates: saved.candidates && typeof saved.candidates === "object" ? saved.candidates : {},
    history: Array.isArray(saved.history) ? saved.history : [],
    recruitDraft: saved.recruitDraft && typeof saved.recruitDraft === "object" ? saved.recruitDraft : null,
    recruitDailyHistory: Array.isArray(saved.recruitDailyHistory) ? saved.recruitDailyHistory : [],
    current: { ...base.current, ...(saved.current || {}) }
  };
}

async function writeState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function sanitizeDingTalkWebhook(value) {
  try {
    const url = new URL(clean(value));
    if (url.protocol !== "https:" || url.hostname !== "connector.dingtalk.com" || !url.pathname.startsWith("/webhook/flow/")) return "";
    return url.href;
  } catch {
    return "";
  }
}

async function readDingTalkConfig() {
  const saved = (await chrome.storage.local.get(DINGTALK_CONFIG_KEY))[DINGTALK_CONFIG_KEY];
  const webhookUrl = sanitizeDingTalkWebhook(saved?.webhookUrl);
  return { webhookUrl, updatedAt: webhookUrl ? clean(saved?.updatedAt) : "" };
}

async function writeDingTalkConfig(webhookUrl) {
  await chrome.storage.local.set({ [DINGTALK_CONFIG_KEY]: { webhookUrl, updatedAt: new Date().toISOString() } });
  const verified = await readDingTalkConfig();
  if (verified.webhookUrl !== webhookUrl) throw new Error("DINGTALK_CONFIG_SAVE_FAILED");
  return verified;
}

function dingTalkConfigState(config) {
  return {
    configured: Boolean(config.webhookUrl),
    host: config.webhookUrl ? "connector.dingtalk.com" : "",
    updatedAt: config.webhookUrl ? config.updatedAt || "" : ""
  };
}

function statistics(state) {
  const candidates = Object.values(state.candidates);
  const detected = candidates.filter((item) => item.status === "duplicate" || item.status === "not_duplicate").length;
  const duplicates = candidates.filter((item) => item.status === "duplicate").length;
  const unknown = candidates.filter((item) => item.status === "unknown").length;
  return { viewed: candidates.length, detected, duplicates, unknown, rate: detected ? duplicates / detected * 100 : 0 };
}

function publicState(state) {
  return {
    settings: state.settings,
    session: state.session,
    current: state.current,
    statistics: statistics(state),
    history: state.history,
    recruitDraft: state.recruitDraft,
    recruitDraftDuplicate: state.recruitDraft
      ? aggregateDuplicateForRecruit(state, state.recruitDraft.date, state.recruitDraft.baseCity, state.recruitDraft.jobTitle)
      : null,
    recruitDailyHistory: state.recruitDailyHistory
  };
}

function localDay(value) {
  if (!value) return "";
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function localIsoDay(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function roundRate(value) {
  return Math.round(value * 100) / 100;
}

function normalizeBase(value) {
  return clean(value).replace(/市$/, "").toLocaleLowerCase();
}

function normalizeRecruitJob(value, baseCity) {
  let text = clean(value).normalize("NFKC").replace(/\s*[竞普]\s*$/, "");
  const base = clean(baseCity).replace(/市$/, "");
  if (base) {
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`\\s*[_＿]\\s*${escapedBase}(?:市)?\\s*\\d+(?:\\.\\d+)?\\s*-\\s*\\d+(?:\\.\\d+)?K(?:\\s*[·・]\\s*\\d+薪)?\\s*$`, "i"), "");
  }
  return text.replace(/\s+/g, "").toLocaleLowerCase();
}

function sameRecruitContext(record, date, baseCity, jobTitle) {
  return localIsoDay(record.endedAt || record.startedAt) === date
    && normalizeBase(record.baseCity) === normalizeBase(baseCity)
    && normalizeRecruitJob(record.jobTitle, record.baseCity) === normalizeRecruitJob(jobTitle, baseCity);
}

function aggregateDuplicateRecords(records) {
  if (!records.length) return null;
  const duplicate = {
    viewed: records.reduce((sum, item) => sum + (Number(item.viewed) || 0), 0),
    detected: records.reduce((sum, item) => sum + (Number(item.detected) || 0), 0),
    duplicates: records.reduce((sum, item) => sum + (Number(item.duplicates) || 0), 0),
    unknown: records.reduce((sum, item) => sum + (Number(item.unknown) || 0), 0),
    duplicateRate: null,
    freshRate: null
  };
  if (duplicate.detected > 0) {
    duplicate.duplicateRate = roundRate(duplicate.duplicates / duplicate.detected * 100);
    duplicate.freshRate = roundRate(100 - duplicate.duplicateRate);
  }
  return duplicate;
}

function duplicateRecordsForRecruit(state, date, baseCity, jobTitle) {
  if (!validDateString(date) || !normalizeBase(baseCity) || !normalizeRecruitJob(jobTitle, baseCity)) return [];
  const records = (Array.isArray(state.history) ? state.history : []).filter((record) =>
    sameRecruitContext(record, date, baseCity, jobTitle)
  );
  if (state.session.active && state.session.id && sameRecruitContext(state.session, date, baseCity, jobTitle)
    && !records.some((record) => record.id === state.session.id)) {
    records.push({ id: state.session.id, ...state.session, ...statistics(state) });
  }
  return records;
}

function aggregateDuplicateForRecruit(state, date, baseCity, jobTitle) {
  return aggregateDuplicateRecords(duplicateRecordsForRecruit(state, date, baseCity, jobTitle));
}

function validDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function sanitizeRecruitSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const boss = {};
  for (const key of RECRUIT_METRIC_KEYS) {
    const value = snapshot.boss?.[key];
    boss[key] = Number.isInteger(value) && value >= 0 ? value : null;
  }
  const capturedDate = new Date(snapshot.capturedAt);
  const draft = {
    date: validDateString(snapshot.date) ? snapshot.date : null,
    jobTitle: clean(snapshot.jobTitle) || null,
    baseCity: clean(snapshot.baseCity) || null,
    capturedAt: Number.isNaN(capturedDate.getTime()) ? new Date().toISOString() : capturedDate.toISOString(),
    boss,
    missingFields: []
  };
  draft.missingFields = [
    ...(["date", "jobTitle", "baseCity"].filter((key) => !draft[key])),
    ...RECRUIT_METRIC_KEYS.filter((key) => draft.boss[key] === null)
  ];
  return draft;
}

function recruitDailyKey(record) {
  return [record?.date, normalizeBase(record?.baseCity), normalizeRecruitJob(record?.jobTitle, record?.baseCity)].join("|");
}

function dingTalkSyncKey(record) {
  return `${clean(record.date)}_${clean(record.baseCity)}_${clean(record.jobTitle)}`;
}

function buildDingTalkPayload(record) {
  if (!record?.duplicate) return null;
  return {
    eventType: "boss_recruit_daily",
    date: record.date,
    jobName: record.jobTitle,
    baseCity: record.baseCity,
    viewCount: record.duplicate.viewed,
    duplicateCount: record.duplicate.duplicates,
    greetCount: record.boss?.greetedByMe,
    viewMeCount: record.boss?.viewedMe,
    newGreetCount: record.boss?.newGreetings,
    communicationCount: record.boss?.communicatedByMe,
    contactCount: record.boss?.contactsExchanged,
    syncKey: dingTalkSyncKey(record)
  };
}

async function postDingTalkWorkflow(webhookUrl, payload) {
  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      const error = new Error("SYNC_TIMEOUT");
      error.name = "TimeoutError";
      reject(error);
    }, 15000);
  });
  const requestPromise = (async () => {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "omit",
      signal: controller.signal
    });
    const responseText = await response.text();
    let responseData = null;
    try {
      responseData = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseData = null;
    }
    const businessFailed = responseData?.success === false
      || (Number.isFinite(Number(responseData?.errcode)) && Number(responseData.errcode) !== 0);
    if (!response.ok || businessFailed) {
      const error = new Error(response.ok ? "WORKFLOW_REJECTED" : `HTTP_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return { status: response.status };
  })();
  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function dingTalkFailureText(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError" || error?.message === "SYNC_TIMEOUT") {
    return "同步超过 15 秒，已停止；请检查网络、Webhook 是否有效以及钉钉工作流是否已启用";
  }
  if (/^HTTP_/.test(error?.message || "")) return `工作流返回异常状态（${error.message.replace("HTTP_", "")}）`;
  if (error?.message === "WORKFLOW_REJECTED") return "工作流拒绝了本次数据，请检查工作流字段配置";
  return "无法连接钉钉工作流，请检查 Webhook 配置和网络";
}

function sameHistoryGroup(left, right) {
  return Boolean(left && right && clean(left.jobTitle) && clean(left.baseCity)
    && clean(left.jobTitle) === clean(right.jobTitle)
    && clean(left.baseCity) === clean(right.baseCity)
    && localDay(left.endedAt || left.startedAt) === localDay(right.endedAt || right.startedAt));
}

function rematchAllCandidates(state) {
  const members = new Set(state.settings.members.map(clean));
  for (const candidate of Object.values(state.candidates)) {
    if (!Array.isArray(candidate.colleagueNames) || candidate.status === "unknown" || candidate.status === "loading") continue;
    candidate.matchedMembers = [...new Set(candidate.colleagueNames.map(clean).filter((name) => members.has(name)))];
    candidate.status = candidate.matchedMembers.length ? "duplicate" : "not_duplicate";
  }
  const currentCandidate = state.current.candidateKey ? state.candidates[state.current.candidateKey] : null;
  if (currentCandidate && state.current.status !== "unknown" && state.current.status !== "loading") {
    state.current.status = currentCandidate.status;
    state.current.matchedMembers = currentCandidate.matchedMembers;
    state.current.reason = "同事名单更新后已重新匹配";
  }
}

async function handle(message, sender) {
  const state = await readState();
  switch (message?.type) {
    case "GET_STATE":
      return { ok: true, state: publicState(state) };
    case "GET_DINGTALK_CONFIG": {
      if (sender?.tab) return { ok: false, error: "POPUP_ONLY" };
      return { ok: true, config: dingTalkConfigState(await readDingTalkConfig()) };
    }
    case "SAVE_DINGTALK_CONFIG": {
      if (sender?.tab) return { ok: false, error: "POPUP_ONLY" };
      const webhookUrl = sanitizeDingTalkWebhook(message.webhookUrl);
      if (!webhookUrl) return { ok: false, error: "INVALID_DINGTALK_WEBHOOK" };
      const savedConfig = await writeDingTalkConfig(webhookUrl);
      return { ok: true, config: dingTalkConfigState(savedConfig) };
    }
    case "CLEAR_DINGTALK_CONFIG":
      if (sender?.tab) return { ok: false, error: "POPUP_ONLY" };
      await chrome.storage.local.remove(DINGTALK_CONFIG_KEY);
      return { ok: true, config: dingTalkConfigState({ webhookUrl: "" }) };
    case "SAVE_MEMBERS":
      state.settings.members = [...new Set((message.members || []).map(clean).filter(Boolean))];
      state.settings.revision = Date.now();
      rematchAllCandidates(state);
      break;
    case "SAVE_OVERLAY_POSITION":
      if (Number.isFinite(message.position?.left) && Number.isFinite(message.position?.top)) {
        state.settings.overlayPosition = { left: message.position.left, top: message.position.top };
      }
      break;
    case "START_SESSION":
      state.settings.members = [...new Set((message.members || []).map(clean).filter(Boolean))];
      state.settings.revision = Date.now();
      state.session = { active: true, id: crypto.randomUUID(), startedAt: new Date().toISOString(), endedAt: null, jobTitle: "", baseCity: "" };
      state.candidates = {};
      state.current = { status: "idle", matchedMembers: [], reason: "等待打开候选人" };
      break;
    case "END_SESSION":
      if (!state.session.active) return { ok: true, state: publicState(state), ignored: true };
      state.session.active = false;
      state.session.endedAt = new Date().toISOString();
      state.current = { ...state.current, reason: "本次统计已结束" };
      let endedRecord = state.history.find((item) => item.id === state.session.id);
      if (state.session.id && !endedRecord) {
        const result = statistics(state);
        endedRecord = {
          id: state.session.id,
          startedAt: state.session.startedAt,
          endedAt: state.session.endedAt,
          members: [...state.settings.members],
          jobTitle: state.session.jobTitle || "",
          baseCity: state.session.baseCity || "",
          ...result
        };
        state.history.unshift(endedRecord);
      }
      await writeState(state);
      return {
        ok: true,
        state: publicState(state),
        mergeCandidateIds: state.history.filter((item) => item.id !== endedRecord?.id && sameHistoryGroup(item, endedRecord)).map((item) => item.id)
      };
    case "MERGE_HISTORY": { 
      const current = state.history.find((item) => item.id === message.id);
      if (!current) return { ok: false, error: "HISTORY_NOT_FOUND" };
      const requested = new Set(Array.isArray(message.mergeIds) ? message.mergeIds : []);
      const matches = state.history.filter((item) => requested.has(item.id) && sameHistoryGroup(item, current));
      if (!matches.length) return { ok: true, state: publicState(state), ignored: true };
      const records = [current, ...matches];
      const detected = records.reduce((sum, item) => sum + (Number(item.detected) || 0), 0);
      const merged = {
        ...current,
        startedAt: records.map((item) => item.startedAt).filter(Boolean).sort()[0] || current.startedAt,
        endedAt: records.map((item) => item.endedAt).filter(Boolean).sort().at(-1) || current.endedAt,
        members: [...new Set(records.flatMap((item) => Array.isArray(item.members) ? item.members : []).map(clean).filter(Boolean))],
        viewed: records.reduce((sum, item) => sum + (Number(item.viewed) || 0), 0),
        detected,
        duplicates: records.reduce((sum, item) => sum + (Number(item.duplicates) || 0), 0),
        unknown: records.reduce((sum, item) => sum + (Number(item.unknown) || 0), 0)
      };
      merged.rate = detected ? merged.duplicates / detected * 100 : 0;
      const removed = new Set(records.map((item) => item.id));
      state.history = [merged, ...state.history.filter((item) => !removed.has(item.id))];
      break;
    }
    case "JOB_CONTEXT":
      if (!state.session.active || message.sessionId !== state.session.id) return { ok: true, ignored: true };
      state.session.jobTitle = clean(message.jobTitle);
      state.session.baseCity = clean(message.baseCity);
      break;
    case "DELETE_HISTORY":
      state.history = state.history.filter((item) => item.id !== message.id);
      break;
    case "CLEAR_HISTORY":
      state.history = [];
      break;
    case "RECRUIT_DRAFT": {
      if (sender?.tab && sender.frameId !== 0) return { ok: true, state: publicState(state), ignored: true };
      const draft = sanitizeRecruitSnapshot(message.snapshot);
      if (!draft) return { ok: false, error: "INVALID_RECRUIT_DRAFT" };
      state.recruitDraft = draft;
      break;
    }
    case "CLEAR_RECRUIT_DRAFT":
      state.recruitDraft = null;
      break;
    case "SAVE_RECRUIT_DAILY": { 
      const draft = sanitizeRecruitSnapshot(message.snapshot || state.recruitDraft);
      if (!draft) return { ok: false, error: "RECRUIT_DRAFT_NOT_FOUND" };
      const missingContext = ["date", "jobTitle", "baseCity"].filter((key) => !draft[key]);
      if (missingContext.length) return { ok: false, error: "MISSING_RECRUIT_CONTEXT", missingFields: missingContext };
      const missingMetrics = RECRUIT_METRIC_KEYS.filter((key) => draft.boss[key] === null);
      if (missingMetrics.length) return { ok: false, error: "MISSING_RECRUIT_METRICS", missingFields: missingMetrics };
      const key = recruitDailyKey(draft);
      const existingIndex = state.recruitDailyHistory.findIndex((item) => recruitDailyKey(item) === key);
      if (existingIndex >= 0 && message.overwrite !== true) {
        return { ok: false, error: "DUPLICATE_RECRUIT_DAILY", existingId: state.recruitDailyHistory[existingIndex].id };
      }
      const duplicateRecords = duplicateRecordsForRecruit(state, draft.date, draft.baseCity, draft.jobTitle);
      const duplicateCandidate = aggregateDuplicateRecords(duplicateRecords);
      if (duplicateCandidate && typeof message.mergeDuplicate !== "boolean") {
        return {
          ok: false,
          error: "RECRUIT_DUPLICATE_MATCH_FOUND",
          matchCount: duplicateRecords.length,
          duplicate: duplicateCandidate
        };
      }
      const now = new Date().toISOString();
      const existing = existingIndex >= 0 ? state.recruitDailyHistory[existingIndex] : null;
      const record = {
        id: existing?.id || crypto.randomUUID(),
        ...draft,
        duplicate: message.mergeDuplicate === true ? duplicateCandidate : null,
        duplicateSourceIds: message.mergeDuplicate === true ? duplicateRecords.map((item) => item.id).filter(Boolean) : [],
        savedAt: existing?.savedAt || now,
        updatedAt: now
      };
      if (existingIndex >= 0) state.recruitDailyHistory.splice(existingIndex, 1);
      state.recruitDailyHistory.unshift(record);
      break;
    }
    case "DELETE_RECRUIT_DAILY":
      state.recruitDailyHistory = state.recruitDailyHistory.filter((item) => item.id !== message.id);
      break;
    case "SYNC_RECRUIT_DAILY": { 
      if (sender?.tab) return { ok: false, error: "POPUP_ONLY" };
      const record = state.recruitDailyHistory.find((item) => item.id === message.id);
      if (!record) return { ok: false, error: "RECRUIT_DAILY_NOT_FOUND" };
      const payload = buildDingTalkPayload(record);
      if (!payload) return { ok: false, error: "RECRUIT_DAILY_NOT_MERGED", state: publicState(state) };
      const config = await readDingTalkConfig();
      if (!config.webhookUrl) return { ok: false, error: "DINGTALK_NOT_CONFIGURED", state: publicState(state) };
      try {
        const response = await postDingTalkWorkflow(config.webhookUrl, payload);
        record.dingTalkSync = {
          status: "success",
          syncKey: payload.syncKey,
          syncedAt: new Date().toISOString(),
          responseStatus: response.status
        };
      } catch (error) {
        record.dingTalkSync = {
          status: "failed",
          syncKey: payload.syncKey,
          attemptedAt: new Date().toISOString(),
          error: dingTalkFailureText(error)
        };
        await writeState(state);
        return { ok: false, error: "DINGTALK_SYNC_FAILED", message: record.dingTalkSync.error, state: publicState(state) };
      }
      break;
    }
    case "CANDIDATE_SEEN": {
      if (!state.session.active || !state.session.jobTitle || !state.session.baseCity || message.sessionId !== state.session.id || !message.candidateKey) return { ok: true, ignored: true };
      const key = message.candidateKey;
      const old = state.candidates[key];
      state.candidates[key] = old
        ? { ...old, lastSeenAt: new Date().toISOString() }
        : { status: "loading", colleagueNames: [], matchedMembers: [], firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
      state.current = { candidateKey: key, viewToken: message.viewToken || null, status: old?.status || "loading", matchedMembers: old?.matchedMembers || [], reason: old ? "已浏览过该候选人" : "已计入当前候选人" };
      break;
    }
    case "CANDIDATE_RESULT": {
      if (!state.session.active || !state.session.jobTitle || !state.session.baseCity || message.sessionId !== state.session.id || !message.candidateKey) return { ok: true, ignored: true };
      const key = message.candidateKey;
      const names = Array.isArray(message.colleagueNames) ? message.colleagueNames.map(clean).filter(Boolean) : [];
      const members = new Set(state.settings.members.map(clean));
      const matchedMembers = [...new Set(names.filter((name) => members.has(name)))];
      const status = message.ready ? (matchedMembers.length ? "duplicate" : "not_duplicate") : "unknown";
      const old = state.candidates[key];
      state.candidates[key] = { status, colleagueNames: [...new Set(names)], matchedMembers, firstSeenAt: old?.firstSeenAt || new Date().toISOString(), lastSeenAt: new Date().toISOString() };
      if (state.current.candidateKey === key && state.current.viewToken === (message.viewToken || null)) {
        state.current = { candidateKey: key, viewToken: message.viewToken || null, status, matchedMembers, reason: message.reason || "识别完成" };
      }
      break;
    }
    default:
      return { ok: false, error: "UNKNOWN_MESSAGE" };
  }
  await writeState(state);
  return { ok: true, state: publicState(state) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  queue = queue
    .then(() => handle(message, _sender))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
