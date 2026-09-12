const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("boss-duplicate-tracker/content.js", "utf8");
const start = source.indexOf("  function isPossibleJobTitle");
const end = source.indexOf("  function parseSelectedRecruitJob", start);
assert.ok(start >= 0 && end > start);

const context = vm.createContext({
  clean: (value) => String(value || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim(),
  RECRUIT_LABELS: new Set(["我看过", "看过我", "我打招呼", "牛人新招呼", "我沟通", "收获简历", "交换电话微信"])
});
vm.runInContext(source.slice(start, end), context);

function parse(lines) {
  context.inputLines = lines;
  return vm.runInContext("contextFromLines(inputLines)", context);
}

let result = parse(["淘宝自营客诉专家（杭州-全额客服） 竞", "滁州 (9-14K)"]);
assert.equal(result.jobTitle, "淘宝自营客诉专家（杭州-全额客服）");
assert.equal(result.baseCity, "滁州");

result = parse(["淘宝自营客诉专家（杭州-全额客服）", "竞", "滁州市（9-14K）"]);
assert.equal(result.jobTitle, "淘宝自营客诉专家（杭州-全额客服）");
assert.equal(result.baseCity, "滁州");

result = parse(["AIGC运营-淘宝 普", "杭州 (25-50K·16薪)"]);
assert.equal(result.jobTitle, "AIGC运营-淘宝");
assert.equal(result.baseCity, "杭州");

result = parse(["电商客诉客服-杭州办公 竞", "湖州 (1-1.3万元)"]);
assert.equal(result.jobTitle, "电商客诉客服-杭州办公");
assert.equal(result.baseCity, "湖州");

result = parse(["电商客诉客服-杭州办公", "竞", "湖州市（1-1.3万元）"]);
assert.equal(result.jobTitle, "电商客诉客服-杭州办公");
assert.equal(result.baseCity, "湖州");

context.salaryLine = "滁州 (9-14K)";
assert.equal(vm.runInContext("isRecruitSalaryBaseLine(salaryLine)", context), true);
context.salaryLine = "杭州（20-40K·16薪）";
assert.equal(vm.runInContext("isRecruitSalaryBaseLine(salaryLine)", context), true);
context.salaryLine = "湖州 (1-1.3万元)";
assert.equal(vm.runInContext("isRecruitSalaryBaseLine(salaryLine)", context), true);
context.salaryLine = "杭州 (2-4万元·16月)";
assert.equal(vm.runInContext("isRecruitSalaryBaseLine(salaryLine)", context), true);
context.salaryLine = "上海（800-1200元/天）";
assert.equal(vm.runInContext("isRecruitSalaryBaseLine(salaryLine)", context), true);
context.salaryLine = "置顶卡";
assert.equal(vm.runInContext("isRecruitSalaryBaseLine(salaryLine)", context), false);

console.log("recruit context parser smoke test ok");
