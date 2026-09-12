const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const storageKey = "bossDupStateV1";
const dingTalkConfigKey = "bossDupDingTalkConfigV1";
let saved = {
  settings: { members: ["甲"], revision: 1, overlayPosition: null },
  session: { active: false, id: null, startedAt: null, endedAt: null, jobTitle: "", baseCity: "" },
  candidates: {},
  history: [
    { id: "old-1", startedAt: "2026-08-18T01:00:00.000Z", endedAt: "2026-08-18T02:00:00.000Z", jobTitle: "淘宝自营客诉专家 _ 滁州 9-14K", baseCity: "滁州市", viewed: 10, detected: 8, duplicates: 2, unknown: 2, rate: 25 },
    { id: "old-2", startedAt: "2026-08-18T03:00:00.000Z", endedAt: "2026-08-18T04:00:00.000Z", jobTitle: "淘宝自营客诉专家", baseCity: "滁州", viewed: 5, detected: 4, duplicates: 1, unknown: 1, rate: 25 },
    { id: "other-base", startedAt: "2026-08-18T03:00:00.000Z", endedAt: "2026-08-18T04:00:00.000Z", jobTitle: "岗位 C", baseCity: "合肥", viewed: 99, detected: 99, duplicates: 99, unknown: 0, rate: 100 }
  ],
  current: { status: "idle", matchedMembers: [], reason: "旧数据" }
};
let listener;
const storage = { [storageKey]: saved };
const posted = [];
let makeFetchHang = false;
const chrome = {
  storage: {
    local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(value) {
        Object.assign(storage, value);
        if (value[storageKey]) saved = value[storageKey];
      },
      async remove(key) { delete storage[key]; }
    }
  },
  runtime: { onMessage: { addListener(value) { listener = value; } } }
};

vm.runInNewContext(fs.readFileSync("boss-duplicate-tracker/background.js", "utf8"), {
  chrome,
  crypto: webcrypto,
  console,
  Date,
  Map,
  Set,
  Promise,
  Object,
  Array,
  Number,
  String,
  Boolean,
  Math,
  RegExp,
  URL,
  AbortController,
  setTimeout: (callback, delay, ...args) => setTimeout(callback, delay === 15000 ? 25 : delay, ...args),
  clearTimeout,
  fetch: async (url, options) => {
    posted.push({ url, options, body: JSON.parse(options.body) });
    if (makeFetchHang) return new Promise(() => {});
    return { ok: true, status: 200, async text() { return JSON.stringify({ success: true }); } };
  }
});

function send(message, sender = {}) {
  return new Promise((resolve) => listener(message, sender, resolve));
}

(async () => {
  let result = await send({ type: "GET_STATE" });
  assert.equal(result.ok, true);
  assert.equal(result.state.history.length, 3);
  assert.equal(result.state.recruitDailyHistory.length, 0);

  const snapshot = {
    date: "2026-08-18",
    jobTitle: "淘宝自营客诉专家",
    baseCity: "滁州",
    capturedAt: "2026-08-18T12:00:00.000Z",
    boss: { viewedByMe: 79, viewedMe: 12, greetedByMe: 49, newGreetings: 1, communicatedByMe: 49, resumesReceived: 13, contactsExchanged: 4 }
  };
  result = await send({ type: "RECRUIT_DRAFT", snapshot }, { tab: { id: 1 }, frameId: 0 });
  assert.equal(result.state.recruitDraftDuplicate.viewed, 15);
  assert.equal(result.state.recruitDraftDuplicate.detected, 12);
  assert.equal(result.state.recruitDraftDuplicate.duplicates, 3);
  assert.equal(result.state.recruitDraftDuplicate.duplicateRate, 25);
  assert.equal(result.state.recruitDraftDuplicate.freshRate, 75);

  result = await send({ type: "SAVE_RECRUIT_DAILY" });
  assert.equal(result.error, "RECRUIT_DUPLICATE_MATCH_FOUND");
  assert.equal(result.matchCount, 2);
  result = await send({ type: "SAVE_RECRUIT_DAILY", mergeDuplicate: true });
  assert.equal(result.ok, true);
  assert.equal(result.state.recruitDailyHistory.length, 1);
  const firstId = result.state.recruitDailyHistory[0].id;
  assert.equal(result.state.recruitDailyHistory[0].duplicate.viewed, 15);

  result = await send({ type: "SAVE_DINGTALK_CONFIG", webhookUrl: "https://example.com/webhook/flow/not-allowed" });
  assert.equal(result.error, "INVALID_DINGTALK_WEBHOOK");
  result = await send({ type: "SAVE_DINGTALK_CONFIG", webhookUrl: "https://connector.dingtalk.com/webhook/flow/test-secret" });
  assert.equal(result.ok, true);
  assert.equal(result.config.configured, true);
  assert.equal(Object.hasOwn(result.config, "webhookUrl"), false);
  assert.equal(storage[dingTalkConfigKey].webhookUrl, "https://connector.dingtalk.com/webhook/flow/test-secret");
  result = await send({ type: "GET_DINGTALK_CONFIG" });
  assert.equal(result.ok, true);
  assert.equal(result.config.configured, true);
  assert.ok(result.config.updatedAt);
  assert.equal(Object.hasOwn(result.config, "webhookUrl"), false);

  result = await send({ type: "SYNC_RECRUIT_DAILY", id: firstId });
  assert.equal(result.ok, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.eventType, "boss_recruit_daily");
  assert.equal(posted[0].body.viewCount, 15);
  assert.equal(posted[0].body.duplicateCount, 3);
  assert.equal(posted[0].body.greetCount, 49);
  assert.equal(posted[0].body.syncKey, "2026-08-18_滁州_淘宝自营客诉专家");
  assert.equal(result.state.recruitDailyHistory[0].dingTalkSync.status, "success");

  makeFetchHang = true;
  result = await send({ type: "SYNC_RECRUIT_DAILY", id: firstId });
  makeFetchHang = false;
  assert.equal(result.ok, false);
  assert.equal(result.error, "DINGTALK_SYNC_FAILED");
  assert.match(result.message, /超过 15 秒/);
  assert.equal(result.state.recruitDailyHistory[0].dingTalkSync.status, "failed");

  result = await send({ type: "SAVE_RECRUIT_DAILY" });
  assert.equal(result.error, "DUPLICATE_RECRUIT_DAILY");
  result = await send({ type: "SAVE_RECRUIT_DAILY", overwrite: true });
  assert.equal(result.error, "RECRUIT_DUPLICATE_MATCH_FOUND");
  result = await send({ type: "SAVE_RECRUIT_DAILY", overwrite: true, mergeDuplicate: true });
  assert.equal(result.state.recruitDailyHistory.length, 1);
  assert.equal(result.state.recruitDailyHistory[0].id, firstId);
  assert.equal(result.state.recruitDailyHistory[0].duplicateSourceIds.length, 2);

  result = await send({ type: "SAVE_RECRUIT_DAILY", overwrite: true, mergeDuplicate: false });
  assert.equal(result.ok, true);
  assert.equal(result.state.recruitDailyHistory[0].duplicate, null);
  result = await send({ type: "SYNC_RECRUIT_DAILY", id: firstId });
  assert.equal(result.error, "RECRUIT_DAILY_NOT_MERGED");
  assert.equal(posted.length, 2);

  const incomplete = { ...snapshot, boss: { ...snapshot.boss, newGreetings: null } };
  await send({ type: "RECRUIT_DRAFT", snapshot: incomplete });
  result = await send({ type: "SAVE_RECRUIT_DAILY", overwrite: true });
  assert.equal(result.error, "MISSING_RECRUIT_METRICS");
  assert.equal(saved.recruitDailyHistory.length, 1);

  result = await send({ type: "START_SESSION", members: ["甲"] });
  const sessionId = result.state.session.id;
  await send({ type: "JOB_CONTEXT", sessionId, jobTitle: "岗位 A _ 滁州 8-10K", baseCity: "滁州" });
  await send({ type: "CANDIDATE_SEEN", sessionId, candidateKey: "id:1", viewToken: "view-1" });
  result = await send({ type: "CANDIDATE_RESULT", sessionId, candidateKey: "id:1", viewToken: "view-1", ready: true, colleagueNames: ["甲"] });
  assert.equal(result.state.statistics.viewed, 1);
  assert.equal(result.state.statistics.duplicates, 1);
  result = await send({ type: "END_SESSION" });
  assert.equal(result.ok, true);
  assert.equal(result.state.history.length, 4);
  assert.equal(result.state.recruitDailyHistory.length, 1);

  console.log("background smoke test ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
