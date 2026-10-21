import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  LIMITS, makeId, createDocument, createTask, createCase, validateDocument,
  parseImport, importAsCopy, stringifyDocument, issuesFor, dueInRange, exampleDocument, dateISO,
} from "../src/model.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
const task = (timing) => createTask({ title: "가상 일정", timing });
const due = (timing, first, last = first) => dueInRange(task(timing), first, last);
const valid = (document) => {
  const result = validateDocument(document);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  return result;
};
const invalid = (document, pattern) => {
  const result = validateDocument(document);
  assert.equal(result.ok, false);
  if (pattern) assert.match(result.errors.join("\n"), pattern);
  return result;
};
const fixture = () => {
  // Preserve v1 import, text-budget and raw-JSON parser coverage when the
  // editable draft constructor advances to a newer schema.
  const document = createDocument({ schemaVersion: 1, title: "가상 검증용 문서" });
  document.sourceFiles.push({
    id: makeId(), name: "[가상] 원본.txt", format: "text", importedAt: document.createdAt,
    excerpt: "항목\t담당\t완료 기준\r\n접수\t가상 역할\t기록 남김", warnings: [],
  });
  const sourceRefs = [document.sourceFiles[0].id];
  document.tasks.push(createTask({ title: "가상 업무", timing: { kind: "date", date: "2026-10-20", startRule: "3일 전 시작" }, sourceRefs: [...sourceRefs] }));
  delete document.tasks[0].firstAction;
  document.cases.push(createCase({ title: "가상 진행 건", status: "todo", sourceRefs: [...sourceRefs] }));
  delete document.cases[0].statusConfirmed;
  delete document.cases[0].taskId;
  return document;
};

test("constructors create independent valid editable drafts and support overrides", () => {
  const first = createDocument();
  const second = createDocument();
  first.tasks.push(createTask());
  first.cases.push(createCase());
  valid(first);
  valid(second);
  assert.equal(first.schemaVersion, 3);
  assert.equal(second.schemaVersion, 3);
  assert.equal(second.tasks.length, 0);
  assert.notEqual(first.id, second.id);
  assert.equal(createTask({ timing: { kind: "regular", cadence: "monthly", day: "" } }).timing.day, "");
  assert.equal(createCase({ title: "한글", status: "waiting" }).title, "한글");
  assert.equal(createDocument({ onboarding: { dayOne: "첫날" } }).onboarding.firstWeek, "");
  assert.equal(new Set(Array.from({ length: 2_000 }, makeId)).size, 2_000);
});

test("JSON roundtrip preserves Korean, emoji, CRLF/newlines/tabs, markup and long table text exactly", () => {
  const document = fixture();
  const text = "첫 번째 줄: 한글 e\u0301 🐻\r\n열 A\t열 B\t열 C\n<script>alert('문자열')</script>\n";
  document.tasks[0].method = text;
  document.tasks[0].steps = text.repeat(2_000);
  document.cases[0].notes = "계속된 메모\n\n빈 줄도 그대로\n" + text;
  document.onboarding.dayOne = text;
  document.provenance = { provider: "가상 제공자", table: [["열1", "열2"], ["값1", "값2"]], nested: { number: 12, enabled: false, absent: null } };
  valid(document);
  const serialized = stringifyDocument(document);
  assert.deepEqual(parseImport(serialized).document, document);
  assert.equal(parseImport(serialized).document.tasks[0].steps, text.repeat(2_000));
  assert.equal(parseImport(serialized).document.id, document.id);
});

test("import preserves IDs and references; copying regenerates all IDs without mutating original", () => {
  const document = fixture();
  document.provenance = { department: "가상 부서", nested: { raw: "원문\n그대로" }, copyHistory: "사용자 원본 필드" };
  const before = clone(document);
  const imported = parseImport(stringifyDocument(document)).document;
  const copied = importAsCopy(imported);
  valid(copied);
  assert.deepEqual(document, before);
  assert.deepEqual(imported, before);
  const oldIds = new Set([document.id, document.tasks[0].id, document.cases[0].id, document.sourceFiles[0].id]);
  const newIds = [copied.id, copied.tasks[0].id, copied.cases[0].id, copied.sourceFiles[0].id];
  newIds.forEach((id) => assert.equal(oldIds.has(id), false));
  assert.equal(new Set(newIds).size, newIds.length);
  assert.deepEqual(copied.tasks[0].sourceRefs, [copied.sourceFiles[0].id]);
  assert.deepEqual(copied.cases[0].sourceRefs, [copied.sourceFiles[0].id]);
  assert.equal(copied.title, document.title);
  assert.equal(copied.provenance.originDocumentId, document.id);
  assert.equal(copied.provenance.copiedFromDocumentId, document.id);
  assert.deepEqual(copied.provenance.sourceProvenance, document.provenance);
  assert.equal(copied.provenance.copyHistory[0].idMap[document.tasks[0].id], copied.tasks[0].id);
  assert.equal(copied.provenance.copyHistory[0].sourceCreatedAt, document.createdAt);
  copied.tasks[0].timing.date = "2027-01-01";
  copied.sourceFiles[0].warnings.push("새 경고");
  assert.deepEqual(document, before);
});

test("repeated copies keep the stable origin, preserved metadata and complete successive ID maps", () => {
  const document = fixture();
  document.provenance = { originDocumentId: "external-origin", note: "가상 외부 시스템에서 이관" };
  const copied = importAsCopy(document);
  const copiedBefore = clone(copied);
  const copiedAgain = importAsCopy(copied);
  valid(copiedAgain);
  assert.deepEqual(copied, copiedBefore);
  assert.equal(copiedAgain.provenance.originDocumentId, "external-origin");
  assert.deepEqual(copiedAgain.provenance.sourceProvenance, document.provenance);
  assert.equal(copiedAgain.provenance.copyHistory.length, 2);
  assert.deepEqual(copiedAgain.provenance.copyHistory[0], copied.provenance.copyHistory[0]);
  assert.equal(copiedAgain.provenance.copyHistory[1].idMap[copied.sourceFiles[0].id], copiedAgain.sourceFiles[0].id);
});

test("groups roundtrip and remap with tasks, while original v1 documents retain omitted optional fields", () => {
  const document = fixture();
  document.groups = [
    { id: makeId(), title: "[가상] 일상 운영" },
    { id: makeId(), title: "[가상] 정기 업무" },
    { id: makeId(), title: "[가상] 행사 업무" },
  ];
  document.tasks[0].groupId = document.groups[1].id;
  const before = clone(document);
  assert.deepEqual(parseImport(stringifyDocument(document)).document, document);
  const copied = importAsCopy(document);
  valid(copied);
  assert.deepEqual(document, before);
  assert.deepEqual(copied.groups.map((item) => item.title), document.groups.map((item) => item.title));
  assert.equal(copied.tasks[0].groupId, copied.groups[1].id);
  assert.notEqual(copied.groups[1].id, document.groups[1].id);
  assert.equal(copied.provenance.copyHistory[0].idMap[document.groups[1].id], copied.groups[1].id);
  const legacy = fixture();
  delete legacy.groups;
  for (const key of ["groupId", "ownerRole", "supportRole", "accessStatus", "firstAction"]) delete legacy.tasks[0][key];
  delete legacy.tasks[0].timing.dayRule;
  const roundtrip = parseImport(stringifyDocument(legacy)).document;
  assert.deepEqual(roundtrip, legacy);
  const legacyCopy = importAsCopy(legacy);
  assert.equal(legacyCopy.schemaVersion, 1);
  assert.equal(Object.hasOwn(legacyCopy, "groups"), false);
  for (const key of ["groupId", "ownerRole", "supportRole", "accessStatus", "firstAction"]) assert.equal(Object.hasOwn(legacyCopy.tasks[0], key), false);
  for (const key of ["statusConfirmed", "taskId"]) assert.equal(Object.hasOwn(legacyCopy.cases[0], key), false);
});

test("group references, duplicate group IDs and optional role/access fields are validated", () => {
  for (const edit of [
    (doc) => { doc.groups = [{ id: doc.tasks[0].id, title: "중복" }]; },
    (doc) => { doc.groups = [{ id: "g1", title: "첫" }, { id: "g1", title: "둘" }]; },
    (doc) => { doc.tasks[0].groupId = "missing-group"; },
    (doc) => { doc.tasks[0].groupId = null; },
    (doc) => { doc.tasks[0].ownerRole = "가".repeat(1001); },
    (doc) => { doc.tasks[0].supportRole = 123; },
    (doc) => { doc.tasks[0].accessStatus = "maybe"; },
    (doc) => { doc.tasks[0].timing.dayRule = "lastWorkday"; },
  ]) {
    const document = fixture();
    edit(document);
    invalid(document);
  }
  const document = fixture();
  document.tasks[0].ownerRole = "가상 주담당 역할";
  document.tasks[0].supportRole = "미확인";
  document.tasks[0].accessStatus = "notApplicable";
  valid(document);
  assert.deepEqual(parseImport(stringifyDocument(document)).document, document);
});

test("schema rejects unsupported versions, missing fields, wrong types and unknown fields without stripping them", () => {
  for (const edit of [
    (doc) => { doc.schemaVersion = "1"; },
    (doc) => { doc.schemaVersion = 4; },
    (doc) => { delete doc.onboarding; },
    (doc) => { doc.tasks[0].accessChecked = "true"; },
    (doc) => { doc.cases[0].status = "invalid-state"; },
    (doc) => { doc.tasks[0].timing.kind = "seasonal"; },
    (doc) => { doc.tasks[0].timing.cadence = "biweekly"; },
    (doc) => { doc.tasks[0].timing.weekday = 0; },
    (doc) => { doc.tasks[0].timing.day = 32; },
    (doc) => { doc.tasks[0].timing.month = 13; },
    (doc) => { doc.tasks[0].timing.offsetDays = 1.5; },
    (doc) => { doc.tasks[0].firstWeek = null; },
    (doc) => { doc.onboarding.extra = "누락시키면 안 되는 원문"; },
    (doc) => { doc.extra = "누락시키면 안 되는 원문"; },
    (doc) => { doc.tasks[0].extra = "누락시키면 안 되는 원문"; },
    (doc) => { doc.sourceFiles[0].warnings = "배열 아님"; },
    (doc) => { doc.provenance = []; },
  ]) {
    const document = fixture();
    edit(document);
    invalid(document);
    assert.throws(() => parseImport(JSON.stringify(document)));
  }
  for (const value of [null, [], true, 1, "문자열"]) invalid(value);
});

test("duplicate IDs across all collections and dangling/duplicate source references are rejected", () => {
  for (const edit of [
    (doc) => { doc.tasks[0].id = doc.id; },
    (doc) => { doc.cases[0].id = doc.tasks[0].id; },
    (doc) => { doc.sourceFiles[0].id = doc.cases[0].id; },
    (doc) => { doc.tasks.push(clone(doc.tasks[0])); },
    (doc) => { doc.tasks[0].sourceRefs = ["missing-id"]; },
    (doc) => { doc.tasks[0].sourceRefs.push(doc.sourceFiles[0].id); },
    (doc) => { doc.id = "__proto__"; },
  ]) {
    const document = fixture();
    edit(document);
    invalid(document, /중복|출처|안전하지/);
  }
});

test("malformed JSON, duplicate properties including escaped aliases, prototype keys are rejected", () => {
  for (const text of ["", "{", '{"a":1,}', "\uFEFF{}", "[1,undefined]"]) assert.throws(() => parseImport(text), /JSON/);
  const json = stringifyDocument(fixture());
  assert.throws(() => parseImport(json.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1')), /중복/);
  assert.throws(() => parseImport(json.replace('"schemaVersion": 1', '"schemaVersion": 1, "\\u0073chemaVersion": 1')), /중복/);
  for (const key of ["__proto__", "constructor", "prototype", "\\u005f_proto__"]) {
    assert.throws(() => parseImport(json.replace('"schemaVersion": 1', `"provenance": {"nested":[{"${key}":{"polluted":true}}]}, "schemaVersion": 1`)), /prototype/);
  }
  assert.equal({}.polluted, undefined);
  const safe = fixture();
  safe.provenance = { list: [{ key: "한글" }, { key: "별도 객체의 같은 속성은 유효" }], text: "{\"key\":1,\"key\":2}" };
  valid(parseImport(stringifyDocument(safe)).document);
});

test("dangerous controls and lone surrogates rejected recursively, while ordinary formatted text is allowed", () => {
  for (const control of ["\0", "\u0001", "\u000B", "\u001B", "\u007F", "\u0085", "\u061C", "\u200F", "\u202E", "\u2066", "\uFEFF", "\uD800", "\uDC00"]) {
    const document = fixture();
    document.provenance = { nested: [{ text: `가상${control}문서` }] };
    invalid(document, /제어문자|서로게이트/);
    assert.throws(() => parseImport(JSON.stringify(document)), /제어문자|서로게이트/);
  }
  const document = fixture();
  document.tasks[0].method = " \t\r\n한글 🐻\r\n";
  valid(document);
  assert.equal(parseImport(stringifyDocument(document)).document.tasks[0].method, document.tasks[0].method);
});

test("JSON-only preservation rejects cycles, accessors, hidden fields, exotic types and sparse/augmented arrays", () => {
  const document = fixture();
  document.provenance = {};
  document.provenance.loop = document.provenance;
  invalid(document, /순환/);
  let getterInvoked = false;
  const accessor = fixture();
  accessor.provenance = {};
  Object.defineProperty(accessor.provenance, "secret", { enumerable: true, get() { getterInvoked = true; return "value"; } });
  invalid(accessor, /접근자/);
  assert.equal(getterInvoked, false);
  const hidden = fixture();
  Object.defineProperty(hidden, "hidden", { value: "not serializable", enumerable: false });
  invalid(hidden, /숨김/);
  for (const value of [undefined, Number.NaN, Infinity, -0, Number.MAX_SAFE_INTEGER + 1, 1n, () => 1, new Date(), new Map(), Symbol("x")]) {
    const current = fixture();
    current.provenance = { value };
    invalid(current);
  }
  for (const array of [new Array(2), Object.assign(["ok"], { extra: "lost" }), Object.assign([, "ok"], { 4294967295: "lost" })]) {
    const current = fixture();
    current.provenance = { array };
    invalid(current, /配列|배열/);
  }
});

test("resource limits reject UTF-8 oversize, long fields, too many entries and deep nesting", () => {
  const utf8Oversize = { ...fixture(), title: "가".repeat(Math.floor(LIMITS.jsonBytes / 3) + 1) };
  assert.throws(() => parseImport(JSON.stringify(utf8Oversize)), /v1.*5 MiB/);
  const oversized = fixture();
  oversized.sourceFiles = Array.from({ length: 6 }, () => ({
    id: makeId(), name: "[가상] 큰 텍스트.txt", format: "text",
    importedAt: oversized.createdAt, excerpt: "a".repeat(900_000), warnings: [],
  }));
  oversized.tasks[0].sourceRefs = [];
  oversized.cases[0].sourceRefs = [];
  invalid(oversized, /5 MiB/);
  const long = fixture();
  long.tasks[0].method = "a".repeat(LIMITS.text + 1);
  invalid(long, /200,000/);
  const tooMany = createDocument({ tasks: Array.from({ length: LIMITS.tasks + 1 }, () => createTask()) });
  invalid(tooMany, /500/);
  const deep = fixture();
  let nested = {};
  deep.provenance = nested;
  for (let i = 0; i < LIMITS.depth + 1; i++) nested = nested.child = {};
  invalid(deep, /중첩/);
  assert.throws(() => parseImport(JSON.stringify(deep)), /중첩/);
});

test("exact JSON nesting limit roundtrips, and raw abusive depth/count are rejected before allocation", () => {
  const document = fixture();
  let nested = document.provenance = {};
  for (let i = 0; i < LIMITS.depth - 1; i++) nested = nested.child = {};
  valid(document);
  assert.deepEqual(parseImport(stringifyDocument(document)).document, document);
  nested.child = {};
  invalid(document, /중첩/);
  assert.throws(() => parseImport(`${"[".repeat(100_000)}0${"]".repeat(100_000)}`), /중첩/);
  assert.throws(() => parseImport(`[${"0,".repeat(LIMITS.nodes)}0]`), /항목 수/);
  // Unsupported versions now have a dedicated message. Keep the unsafe-number
  // assertion on an ordinary preserved field so that numeric validation runs.
  assert.throws(() => parseImport(stringifyDocument(fixture()).replace('"schemaVersion": 1', '"provenance": {"unsafeInteger": 9007199254740993}, "schemaVersion": 1')), /숫자/);
});

test("validation accepts blank draft dates but rejects nonexistent days and malformed timestamps", () => {
  const document = fixture();
  document.tasks[0].timing = { kind: "relative", anchorDate: "", offsetDays: "", day: "", month: "", weekday: "", cadence: "", date: "", startRule: "" };
  document.tasks[0].verifiedAt = "";
  document.cases[0].dueDate = "";
  valid(document);
  for (const value of ["2026-02-29", "1900-02-29", "2100-02-29", "2026-04-31", "2026-1-01", "0000-01-01", "2026-13-01", "2026-00-01", " 2026-01-01", "2026-01-01T00:00:00Z"]) {
    const current = fixture();
    current.tasks[0].timing.date = value;
    invalid(current, /날짜/);
  }
  for (const value of ["2026-02-31T00:00:00Z", "2026-10-20T24:00:00Z", "2026-10-20T12:60:00Z", "2026-10-20T12:00:60Z", "2026-10-20T12:00:00", "2026-10-20", "2026-10-20T00:00:00+14:01"]) {
    const current = fixture();
    current.createdAt = value;
    invalid(current, /ISO/);
  }
  for (const value of ["2000-02-29", "2024-02-29", "0001-01-01", "9999-12-31"]) {
    const current = fixture();
    current.tasks[0].timing.date = value;
    valid(current);
  }
  const timestamp = fixture();
  timestamp.createdAt = "2026-10-20T12:34:56.123456789+09:00";
  timestamp.tasks[0].verifiedAt = "2026-10-20T12:34:56Z";
  valid(timestamp);
});

test("daily and weekly recurrence use inclusive local dates and ISO weekdays", () => {
  assert.deepEqual(due({ kind: "regular", cadence: "daily" }, "2024-02-28", "2024-03-01").dates, ["2024-02-28", "2024-02-29", "2024-03-01"]);
  assert.deepEqual(due({ kind: "regular", cadence: "weekly", weekday: 1 }, "2026-10-18", "2026-10-26").dates, ["2026-10-19", "2026-10-26"]);
  assert.deepEqual(due({ kind: "regular", cadence: "weekly", weekday: 7 }, "2026-10-18", "2026-10-25").dates, ["2026-10-18", "2026-10-25"]);
  assert.deepEqual(due({ kind: "regular", cadence: "daily" }, "0001-01-01").dates, ["0001-01-01"]);
  assert.deepEqual(due({ kind: "regular", cadence: "weekly", weekday: 1 }, "0001-01-01").dates, ["0001-01-01"]);
  assert.deepEqual(due({ kind: "regular", cadence: "daily" }, "9999-12-31").dates, ["9999-12-31"]);
});

test("monthly recurrence skips invalid month days without rolling forward or clamping", () => {
  assert.deepEqual(due({ kind: "regular", cadence: "monthly", day: 31 }, "2026-01-01", "2026-05-31").dates, ["2026-01-31", "2026-03-31", "2026-05-31"]);
  assert.deepEqual(due({ kind: "regular", cadence: "monthly", day: 31 }, "2026-02-01", "2026-02-28"), { dates: [], unresolved: false, reason: "" });
  assert.deepEqual(due({ kind: "regular", cadence: "monthly", day: 29 }, "2024-02-01", "2024-02-29").dates, ["2024-02-29"]);
  assert.deepEqual(due({ kind: "regular", cadence: "monthly", day: 29 }, "2025-02-01", "2025-02-28").dates, []);
});

test("monthly monthEnd uses actual leap/nonleap month ends and uncertain month starts stay unresolved", () => {
  const monthEnd = { kind: "regular", cadence: "monthly", dayRule: "monthEnd" };
  assert.deepEqual(due(monthEnd, "2024-01-01", "2024-04-30").dates, ["2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30"]);
  assert.deepEqual(due(monthEnd, "2026-02-01", "2026-02-28").dates, ["2026-02-28"]);
  assert.deepEqual(due(monthEnd, "2100-02-01", "2100-02-28").dates, ["2100-02-28"]);
  assert.deepEqual(due({ ...monthEnd, day: 1 }, "2026-02-01", "2026-02-28").dates, ["2026-02-28"]);
  assert.deepEqual(due({ kind: "regular", cadence: "monthly", dayRule: "dayOfMonth", day: 1 }, "2026-02-01", "2026-02-28").dates, ["2026-02-01"]);
  for (const dayRule of ["monthStartUnconfirmed", "firstBusinessDay"]) {
    const result = due({ kind: "regular", cadence: "monthly", dayRule, day: 1 }, "2026-02-01", "2026-02-28");
    assert.equal(result.unresolved, true);
    assert.ok(result.reason.length > 0);
    assert.deepEqual(result.dates, []);
  }
});

test("quarterly and half-year cadence are anchored to the supplied month and cross years", () => {
  assert.deepEqual(due({ kind: "regular", cadence: "quarterly", month: 2, day: 15 }, "2026-01-01", "2027-02-15").dates, ["2026-02-15", "2026-05-15", "2026-08-15", "2026-11-15", "2027-02-15"]);
  assert.deepEqual(due({ kind: "regular", cadence: "quarterly", month: 11, day: 31 }, "2026-01-01", "2026-12-31").dates, ["2026-05-31", "2026-08-31"]);
  assert.deepEqual(due({ kind: "regular", cadence: "halfyear", month: 12, day: 30 }, "2026-01-01", "2027-12-31").dates, ["2026-06-30", "2026-12-30", "2027-06-30", "2027-12-30"]);
  assert.equal(due({ kind: "regular", cadence: "quarterly", day: 15 }, "2026-01-01").unresolved, true);
  assert.equal(due({ kind: "regular", cadence: "halfyear", month: 0, day: 1 }, "2026-01-01").unresolved, true);
});

test("yearly dates respect Gregorian century leap rules and never invent February 31", () => {
  const rule = { kind: "regular", cadence: "yearly", month: 2, day: 29 };
  assert.deepEqual(due(rule, "1899-01-01", "1901-12-31").dates, []);
  assert.deepEqual(due(rule, "1999-01-01", "2001-12-31").dates, ["2000-02-29"]);
  assert.deepEqual(due(rule, "2099-01-01", "2101-12-31").dates, []);
  assert.deepEqual(due({ kind: "regular", cadence: "yearly", month: 12, day: 31 }, "2026-01-01", "2027-12-31").dates, ["2026-12-31", "2027-12-31"]);
  const impossible = due({ kind: "regular", cadence: "yearly", month: 2, day: 31 }, "2026-01-01", "2026-12-31");
  assert.equal(impossible.unresolved, true);
  assert.deepEqual(impossible.dates, []);
});

test("absolute dates only occur in range; invalid actual dates stay unresolved", () => {
  const rule = { kind: "date", date: "2026-10-20" };
  assert.deepEqual(due(rule, "2026-10-20").dates, ["2026-10-20"]);
  assert.deepEqual(due(rule, "2026-10-21", "2026-10-30").dates, []);
  assert.equal(due({ kind: "date", date: "2026-02-31" }, "2026-01-01", "2026-12-31").unresolved, true);
  assert.deepEqual(due({ kind: "date", date: "2026-02-31" }, "2026-01-01", "2026-12-31").dates, []);
});

test("relative offsets count calendar days through leap days, months and years including zero/negative", () => {
  for (const [anchorDate, offsetDays, expected] of [
    ["2026-12-31", 1, "2027-01-01"],
    ["2027-01-01", -1, "2026-12-31"],
    ["2024-02-28", 1, "2024-02-29"],
    ["2024-02-28", 2, "2024-03-01"],
    ["1900-02-28", 1, "1900-03-01"],
    ["2000-02-28", 1, "2000-02-29"],
    ["2100-02-28", 1, "2100-03-01"],
    ["2026-01-31", 1, "2026-02-01"],
    ["2026-10-20", 0, "2026-10-20"],
    ["0001-01-01", 0, "0001-01-01"],
  ]) {
    assert.deepEqual(due({ kind: "relative", anchorDate, offsetDays }, expected).dates, [expected]);
  }
  for (const [anchorDate, offsetDays] of [["", 0], ["2026-02-31", 1], ["2026-10-20", ""], ["2026-10-20", 0.5], ["0001-01-01", -1], ["9999-12-31", 1], ["2026-10-20", LIMITS.offsetDays + 1]]) {
    const result = due({ kind: "relative", anchorDate, offsetDays }, "2026-01-01", "2026-12-31");
    assert.equal(result.unresolved, true);
    assert.deepEqual(result.dates, []);
  }
});

test("semester/event/missing rules and invalid or abusive date ranges explain unresolved state", () => {
  for (const timing of [
    { kind: "regular", cadence: "semester", month: 3, day: 1 },
    { kind: "event", trigger: "승인 접수 시" },
    { kind: "event", trigger: "" },
    { kind: "regular", cadence: "" },
    { kind: "regular", cadence: "weekly", weekday: "" },
    { kind: "regular", cadence: "monthly", day: "" },
    { kind: "unknown" },
  ]) {
    const result = due(timing, "2026-01-01", "2026-12-31");
    assert.equal(result.unresolved, true);
    assert.ok(result.reason.length > 0);
    assert.deepEqual(result.dates, []);
  }
  assert.equal(dueInRange({}, "2026-01-01", "2026-01-01").unresolved, true);
  assert.equal(due({ kind: "date", date: "2026-01-01" }, "2026-02-31").unresolved, true);
  assert.equal(due({ kind: "regular", cadence: "daily" }, "2026-01-02", "2026-01-01").unresolved, true);
  assert.equal(due({ kind: "regular", cadence: "daily" }, "0001-01-01", "9999-12-31").unresolved, true);
});

test("dateISO uses the caller's local calendar date rather than UTC slicing, including DST", () => {
  const moduleURL = new URL("../src/model.js", import.meta.url).href;
  const cases = [
    ["Pacific/Kiritimati", "2026-01-01T00:30:00+14:00", "2026-01-01"],
    ["America/Los_Angeles", "2026-01-01T23:30:00-08:00", "2026-01-01"],
    ["America/New_York", "2026-03-08T03:30:00-04:00", "2026-03-08"],
    ["Asia/Seoul", "2026-10-20T00:30:00+09:00", "2026-10-20"],
  ];
  for (const [timezone, instant, expected] of cases) {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `import { dateISO, dueInRange } from ${JSON.stringify(moduleURL)}; console.log(JSON.stringify({date:dateISO(new Date(${JSON.stringify(instant)})),due:dueInRange({timing:{kind:"relative",anchorDate:"2026-03-07",offsetDays:2}},"2026-03-09","2026-03-09").dates}));`], { env: { ...process.env, TZ: timezone }, encoding: "utf8" });
    assert.deepEqual(JSON.parse(output), { date: expected, due: ["2026-03-09"] });
  }
  assert.throws(() => dateISO(new Date("invalid")), /유효한/);
  assert.throws(() => dateISO("2026-10-20"), /유효한/);
});

test("issues target deadline start rules, actionable open cases, material access and last verification", () => {
  const document = createDocument();
  document.tasks = [
    createTask({ title: "일간", timing: { kind: "regular", cadence: "daily" }, verifiedAt: "2026-10-20" }),
    createTask({ title: "주간", timing: { kind: "regular", cadence: "weekly", weekday: 1 }, verifiedAt: "2026-10-20" }),
    createTask({ title: "사건", timing: { kind: "event", trigger: "접수" }, verifiedAt: "2026-10-20" }),
    createTask({ title: "마감", timing: { kind: "date", date: "2026-10-23" }, verifiedAt: "", materials: "원문 자료" }),
    createTask({ title: "월간", timing: { kind: "regular", cadence: "monthly", day: 1 }, verifiedAt: "2026-07-21" }),
    createTask({ title: "확인 경계", timing: { kind: "event", trigger: "접수" }, verifiedAt: "2026-07-22" }),
    createTask({ title: "미래", timing: { kind: "event", trigger: "접수" }, verifiedAt: "2026-10-21" }),
  ];
  document.cases = [
    createCase({ title: "진행", status: "doing", nextAction: "" }),
    createCase({ title: "대기", status: "waiting", nextAction: "담당자에게 내일 확인" }),
    createCase({ title: "완료", status: "done", statusConfirmed: true, nextAction: "" }),
  ];
  const before = clone(document);
  const issues = issuesFor(document, "2026-10-20");
  assert.deepEqual(document, before);
  assert.deepEqual(issuesFor(document, "2026-10-20"), issues);
  const kinds = (item) => issues.filter((issue) => issue.itemId === item.id).map((issue) => issue.kind);
  document.tasks.slice(0, 3).forEach((item) => assert.deepEqual(kinds(item), []));
  assert.deepEqual(kinds(document.tasks[3]), ["missing-start", "access-unchecked", "verification-missing"]);
  assert.deepEqual(kinds(document.tasks[4]), ["missing-start", "verification-stale"]);
  assert.deepEqual(kinds(document.tasks[5]), []);
  assert.deepEqual(kinds(document.tasks[6]), ["verification-future"]);
  assert.deepEqual(kinds(document.cases[0]), ["missing-next-action"]);
  assert.deepEqual(kinds(document.cases[1]), []);
  assert.deepEqual(kinds(document.cases[2]), []);
  assert.equal(new Set(issues.map((issue) => issue.id)).size, issues.length);
  assert.throws(() => issuesFor(document, "2026-02-31"), /기준일/);
});

test("access checks respect explicit three-state selection and preserve legacy boolean semantics", () => {
  const document = createDocument();
  const base = { title: "가상 접근 점검", materials: "가상 자료", verifiedAt: "2026-10-20" };
  const legacyConfirmed = createTask({ ...base, accessChecked: true });
  delete legacyConfirmed.accessStatus;
  const legacyUnconfirmed = createTask({ ...base, accessChecked: false });
  delete legacyUnconfirmed.accessStatus;
  document.tasks = [
    createTask({ ...base, accessStatus: "notApplicable" }),
    createTask({ ...base, accessStatus: "confirmed" }),
    createTask({ ...base, accessStatus: "unconfirmed", accessChecked: true }),
    legacyConfirmed,
    legacyUnconfirmed,
  ];
  valid(document);
  const checkedIds = issuesFor(document, "2026-10-20").filter((issue) => issue.kind === "access-unchecked").map((issue) => issue.itemId);
  assert.deepEqual(checkedIds, [document.tasks[2].id, document.tasks[4].id]);
  assert.equal(createTask({ accessChecked: true }).accessStatus, "confirmed");
  assert.equal(createTask({ accessStatus: "confirmed" }).accessChecked, true);
});

test("sample includes ten explicitly synthetic tasks, three useful cases, source and onboarding", () => {
  const document = exampleDocument("2026-10-20");
  valid(document);
  assert.equal(document.tasks.length, 10);
  assert.equal(document.cases.length, 3);
  assert.equal(document.groups.length, 3);
  assert.equal(new Set(document.tasks.map((item) => item.groupId)).size, 3);
  for (const item of document.tasks) assert.ok(document.groups.some((group) => group.id === item.groupId));
  assert.match(document.title, /가상/);
  for (const item of [...document.tasks, ...document.cases]) assert.match(item.title, /가상/);
  for (const item of document.tasks) {
    for (const key of ["method", "purpose", "materials", "steps", "contacts", "approval", "exceptions", "doneWhen", "evidence"]) assert.ok(item[key].length > 0, `${item.title}: ${key}`);
  }
  assert.ok(document.onboarding.dayOne.length > 100);
  assert.ok(document.onboarding.firstWeek.length > 100);
  assert.ok(document.tasks.some((item) => item.firstDay));
  assert.ok(document.tasks.some((item) => item.firstWeek));
  assert.ok(issuesFor(document, "2026-10-20").some((issue) => issue.kind === "access-unchecked"));
  assert.ok(issuesFor(document, "2026-10-20").some((issue) => issue.kind === "missing-next-action"));
  assert.deepEqual(parseImport(stringifyDocument(document)).document, document);
  assert.throws(() => exampleDocument("2026-02-31"), /기준일/);
});
