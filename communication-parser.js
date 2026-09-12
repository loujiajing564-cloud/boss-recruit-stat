(function (root, factory) {
  const parser = factory();
  if (typeof module === "object" && module.exports) module.exports = parser;
  else root.BossDupCommunicationParser = parser;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function clean(value) {
    return String(value || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  }

  function namesFromRecord(value) {
    const text = clean(value);
    const names = [];
    const directedToColleague = /Ta\s*向\s*([\u3400-\u9FFFA-Za-z·•]{1,20})\s*发起沟通/gi;
    const directedToCandidate = /(?:^|[\s：:，,。；;【\[])\s*([\u3400-\u9FFFA-Za-z·•]{1,20})\s*向\s*Ta\s*发起沟通/gi;
    for (const pattern of [directedToColleague, directedToCandidate]) {
      let match;
      while ((match = pattern.exec(text))) names.push(clean(match[1]));
    }
    return [...new Set(names)];
  }

  function namesFromRecords(records) {
    return [...new Set((records || []).flatMap(namesFromRecord))];
  }

  return { namesFromRecord, namesFromRecords };
});
