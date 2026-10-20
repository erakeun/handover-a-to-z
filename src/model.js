/**
 * Portable v1 data model. All dates are Gregorian civil dates, not UTC instants.
 * Limits apply to editable drafts as well as imported and exported documents.
 */
export const LIMITS = Object.freeze({
  jsonBytes: 5 * 1024 * 1024,
  tasks: 500,
  cases: 500,
  sources: 200,
  groups: 100,
  title: 400,
  text: 200_000,
  excerpt: 1_048_576,
  id: 128,
  references: 200,
  depth: 32,
  nodes: 100_000,
  rangeDays: 3_660,
  offsetDays: 36_600,
});

const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// Tabs and CR/LF are deliberate exceptions: handover tables and paragraphs need them.
const BAD_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const CADENCES = new Set(["daily", "weekly", "monthly", "quarterly", "halfyear", "yearly", "semester"]);
const DAY_RULES = new Set(["dayOfMonth", "monthEnd", "monthStartUnconfirmed", "firstBusinessDay"]);
const KINDS = new Set(["regular", "date", "event", "relative"]);
const STATUSES = new Set(["todo", "doing", "waiting", "done"]);
const ACCESS_STATUSES = new Set(["unconfirmed", "confirmed", "notApplicable"]);
const TASK_TEXT = ["method", "purpose", "materials", "steps", "contacts", "approval", "exceptions", "doneWhen", "evidence"];
const OPTIONAL_TASK_KEYS = ["groupId", "ownerRole", "supportRole", "accessStatus"];
const TASK_KEYS = ["id", "title", "groupId", "ownerRole", "supportRole", "timing", ...TASK_TEXT, "verifiedAt", "accessChecked", "accessStatus", "sourceRefs", "firstDay", "firstWeek"];
const CASE_KEYS = ["id", "title", "status", "nextAction", "dueDate", "waitingFor", "notes", "sourceRefs"];
const SOURCE_KEYS = ["id", "name", "format", "importedAt", "excerpt", "warnings"];
const TIMING_KEYS = ["kind", "cadence", "dayRule", "weekday", "day", "month", "date", "trigger", "anchorDate", "offsetDays", "startRule"];
const DOCUMENT_KEYS = ["schemaVersion", "id", "title", "createdAt", "updatedAt", "groups", "tasks", "cases", "onboarding", "sourceFiles", "provenance"];
const COPY_FORMAT = "handover-a-to-z/v1";
const encoder = new TextEncoder();
let fallbackSequence = 0;

const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonblank = (value) => typeof value === "string" && value.trim().length > 0;
const leap = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const monthDays = (year, month) => [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

function parseCivil(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays(year, month)) return null;
  return { year, month, day };
}

function civilString({ year, month, day }) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function yearStart(year) {
  const prior = year - 1;
  return 365 * prior + Math.floor(prior / 4) - Math.floor(prior / 100) + Math.floor(prior / 400);
}

function ordinal(civil) {
  let days = yearStart(civil.year) + civil.day - 1;
  for (let month = 1; month < civil.month; month++) days += monthDays(civil.year, month);
  return days;
}

const LAST_DAY = yearStart(10_000) - 1;

function fromOrdinal(days) {
  if (!Number.isSafeInteger(days) || days < 0 || days > LAST_DAY) return null;
  let lower = 1;
  let upper = 10_000;
  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (yearStart(middle) <= days) lower = middle;
    else upper = middle;
  }
  let remainder = days - yearStart(lower);
  let month = 1;
  while (remainder >= monthDays(lower, month)) remainder -= monthDays(lower, month++);
  return { year: lower, month, day: remainder + 1 };
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !parseCivil(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return false;
  if (match[5] !== "Z") {
    const hours = +match[5].slice(1, 3);
    const minutes = +match[5].slice(4, 6);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function invalidUnicode(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function makeId() {
  if (globalThis.crypto?.randomUUID) return `id_${globalThis.crypto.randomUUID()}`;
  fallbackSequence += 1;
  return `id_${Date.now().toString(36)}_${fallbackSequence.toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function dateISO(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new RangeError("유효한 날짜 객체가 필요합니다.");
  const civil = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  if (civil.year < 1 || civil.year > 9999) throw new RangeError("날짜는 0001년부터 9999년까지 지원합니다.");
  return civilString(civil);
}

export function createTask(overrides = {}) {
  const defaults = Object.fromEntries(TASK_TEXT.map((key) => [key, ""]));
  return {
    id: makeId(), title: "", groupId: "", ownerRole: "", supportRole: "", ...defaults, verifiedAt: "",
    accessChecked: overrides.accessStatus === "confirmed",
    accessStatus: overrides.accessChecked === true ? "confirmed" : "unconfirmed",
    sourceRefs: [], firstDay: false, firstWeek: false, ...overrides,
    timing: { kind: "event", dayRule: "dayOfMonth", trigger: "", date: "", anchorDate: "", startRule: "", ...overrides.timing },
  };
}

export function createCase(overrides = {}) {
  return {
    id: makeId(), title: "", status: "todo", nextAction: "", dueDate: "",
    waitingFor: "", notes: "", sourceRefs: [], ...overrides,
  };
}

export function createDocument(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, id: makeId(), title: "새 인수인계 문서", createdAt: now, updatedAt: now,
    groups: [], tasks: [], cases: [], sourceFiles: [], ...overrides,
    onboarding: { dayOne: "", firstWeek: "", ...overrides.onboarding },
  };
}

/**
 * Check the full graph before using JSON.stringify or reading schema properties.
 * Accessors, cycles, exotic instances and ignored array/object properties would
 * otherwise create side effects or silently lose data during a JSON round trip.
 */
function inspectJSON(value, addError) {
  const ancestors = new Set();
  let count = 0;
  let stopped = false;
  function walk(node, path, depth) {
    if (stopped) return;
    if (++count > LIMITS.nodes) {
      addError("JSON 항목 수가 제한(100,000개)을 초과했습니다.");
      stopped = true;
      return;
    }
    if (depth > LIMITS.depth) {
      addError(`${path}: JSON 중첩은 ${LIMITS.depth}단계까지 지원합니다.`);
      stopped = true;
      return;
    }
    if (typeof node === "string") {
      if (BAD_CONTROLS.test(node)) addError(`${path}: 허용하지 않는 제어문자가 있습니다.`);
      if (invalidUnicode(node)) addError(`${path}: 짝이 맞지 않는 유니코드 서로게이트가 있습니다.`);
      if (node.length > LIMITS.excerpt) addError(`${path}: 문자열 길이 제한을 초과했습니다.`);
      return;
    }
    if (node === null || typeof node === "boolean") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) addError(`${path}: 유한한 JSON 숫자가 필요합니다.`);
      else if ((Number.isInteger(node) && !Number.isSafeInteger(node)) || Object.is(node, -0)) {
        addError(`${path}: 손실 없이 보존할 수 없는 숫자입니다. 큰 식별 숫자는 문자열로 저장해 주세요.`);
      }
      return;
    }
    if (typeof node !== "object") {
      addError(`${path}: JSON으로 보존할 수 없는 값입니다.`);
      return;
    }
    if (ancestors.has(node)) {
      addError(`${path}: 순환 참조는 허용하지 않습니다.`);
      return;
    }
    const array = Array.isArray(node);
    const prototype = Object.getPrototypeOf(node);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      addError(`${path}: 일반 JSON 객체 또는 배열이 필요합니다.`);
      return;
    }
    const keys = Reflect.ownKeys(node);
    if (keys.length > LIMITS.nodes) {
      addError(`${path}: 객체 항목 수 제한을 초과했습니다.`);
      stopped = true;
      return;
    }
    ancestors.add(node);
    if (array && node.length > LIMITS.nodes) {
      addError(`${path}: 배열 길이 제한을 초과했습니다.`);
      stopped = true;
    }
    if (array && keys.length !== node.length + 1) addError(`${path}: 비어 있는 배열 칸이나 추가 속성은 허용하지 않습니다.`);
    for (const key of keys) {
      if (stopped) break;
      if (array && key === "length") continue;
      if (typeof key !== "string") {
        addError(`${path}: Symbol 속성은 JSON으로 보존할 수 없습니다.`);
        continue;
      }
      const childPath = array ? `${path}[${key}]` : `${path}.${key}`;
      if (BAD_KEYS.has(key)) addError(`${childPath}: 금지된 prototype 관련 속성입니다.`);
      if (BAD_CONTROLS.test(key) || invalidUnicode(key)) addError(`${path}: 안전하지 않은 속성 이름입니다.`);
      if (key.length > LIMITS.title) addError(`${path}: 속성 이름이 너무 깁니다.`);
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= node.length)) {
        addError(`${childPath}: 배열의 추가 속성은 허용하지 않습니다.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !owns(descriptor, "value") || !descriptor.enumerable) {
        addError(`${childPath}: 접근자 또는 숨김 속성은 JSON으로 보존할 수 없습니다.`);
        continue;
      }
      walk(descriptor.value, childPath, depth + 1);
    }
    ancestors.delete(node);
  }
  try {
    walk(value, "$", 0);
  } catch {
    addError("JSON 객체를 안전하게 검사할 수 없습니다.");
  }
}

export function validateDocument(value) {
  const errors = [];
  const warnings = [];
  const error = (message) => { if (errors.length < 80) errors.push(message); };
  const warning = (message) => { if (warnings.length < 100) warnings.push(message); };
  inspectJSON(value, error);
  if (errors.length) return { ok: false, errors, warnings };
  // This is exactly the format stringifyDocument writes, so valid documents can
  // always be exported and imported again under the same byte budget.
  if (encoder.encode(JSON.stringify(value, null, 2)).byteLength > LIMITS.jsonBytes) {
    error("JSON 문서는 UTF-8 기준 5 MiB 이하여야 합니다.");
    return { ok: false, errors, warnings };
  }
  const object = (node, path, allowed, required = allowed) => {
    if (!isRecord(node)) { error(`${path}: 객체가 필요합니다.`); return false; }
    for (const key of Object.keys(node)) if (!allowed.includes(key)) error(`${path}.${key}: v1에서 알 수 없는 속성입니다.`);
    for (const key of required) if (!owns(node, key)) error(`${path}.${key}: 필수 속성이 없습니다.`);
    return true;
  };
  const string = (node, path, maximum = LIMITS.text, requiredContent = false) => {
    if (typeof node !== "string") { error(`${path}: 문자열이 필요합니다.`); return false; }
    if (node.length > maximum) error(`${path}: 최대 ${maximum.toLocaleString("en-US")}자까지 지원합니다.`);
    if (requiredContent && !nonblank(node)) error(`${path}: 빈 문자열은 허용하지 않습니다.`);
    return true;
  };
  const boolean = (node, path) => { if (typeof node !== "boolean") error(`${path}: true 또는 false가 필요합니다.`); };
  const civil = (node, path) => {
    if (string(node, path, 10) && node !== "" && !parseCivil(node)) error(`${path}: 실제로 존재하는 YYYY-MM-DD 날짜가 필요합니다.`);
  };
  const timestamp = (node, path) => {
    if (string(node, path, 40) && !validTimestamp(node)) error(`${path}: 시간대가 포함된 유효한 ISO 시각이 필요합니다.`);
  };
  const ids = new Set();
  const id = (node, path) => {
    if (!string(node, path, LIMITS.id, true)) return;
    if (BAD_KEYS.has(node)) error(`${path}: 안전하지 않은 ID입니다.`);
    if (ids.has(node)) error(`${path}: 문서 내 중복 ID "${node}"가 있습니다.`);
    ids.add(node);
  };
  const list = (node, path, maximum) => {
    if (!Array.isArray(node)) { error(`${path}: 배열이 필요합니다.`); return false; }
    if (node.length > maximum) error(`${path}: 최대 ${maximum}개까지 지원합니다.`);
    return true;
  };
  const refs = [];
  const sourceRefs = (node, path) => {
    if (!list(node, path, LIMITS.references)) return;
    const seen = new Set();
    node.forEach((reference, index) => {
      if (!string(reference, `${path}[${index}]`, LIMITS.id, true)) return;
      if (seen.has(reference)) error(`${path}: 출처 참조가 중복되었습니다.`);
      seen.add(reference);
      refs.push({ reference, path: `${path}[${index}]` });
    });
  };
  const title = (node, path) => {
    if (string(node, path, LIMITS.title) && !nonblank(node)) warning(`${path}: 제목을 작성해 주세요.`);
  };
  const timing = (node, path) => {
    if (!object(node, path, TIMING_KEYS, ["kind"])) return;
    if (!KINDS.has(node.kind)) error(`${path}.kind: 지원하지 않는 일정 종류입니다.`);
    if (owns(node, "cadence") && node.cadence !== "" && !CADENCES.has(node.cadence)) error(`${path}.cadence: 지원하지 않는 반복 주기입니다.`);
    if (owns(node, "dayRule") && !DAY_RULES.has(node.dayRule)) error(`${path}.dayRule: 지원하지 않는 월간 날짜 규칙입니다.`);
    for (const [key, min, max] of [["weekday", 1, 7], ["day", 1, 31], ["month", 1, 12], ["offsetDays", -LIMITS.offsetDays, LIMITS.offsetDays]]) {
      if (owns(node, key) && node[key] !== "" && (!Number.isInteger(node[key]) || node[key] < min || node[key] > max)) {
        error(`${path}.${key}: ${min}부터 ${max}까지의 정수 또는 빈 값이 필요합니다.`);
      }
    }
    for (const key of ["date", "anchorDate"]) if (owns(node, key)) civil(node[key], `${path}.${key}`);
    for (const key of ["trigger", "startRule"]) if (owns(node, key)) string(node[key], `${path}.${key}`);
  };

  if (!object(value, "$", DOCUMENT_KEYS, DOCUMENT_KEYS.filter((key) => !["provenance", "groups"].includes(key)))) return { ok: false, errors, warnings };
  if (value.schemaVersion !== 1) error("$.schemaVersion: 지원하는 스키마 버전은 숫자 1입니다.");
  id(value.id, "$.id");
  title(value.title, "$.title");
  timestamp(value.createdAt, "$.createdAt");
  timestamp(value.updatedAt, "$.updatedAt");
  if (object(value.onboarding, "$.onboarding", ["dayOne", "firstWeek"])) {
    string(value.onboarding.dayOne, "$.onboarding.dayOne");
    string(value.onboarding.firstWeek, "$.onboarding.firstWeek");
  }
  if (owns(value, "provenance") && !isRecord(value.provenance)) error("$.provenance: 출처 정보를 담은 객체가 필요합니다.");
  const groupIds = new Set();
  if (owns(value, "groups") && list(value.groups, "$.groups", LIMITS.groups)) value.groups.forEach((group, index) => {
    const path = `$.groups[${index}]`;
    if (!object(group, path, ["id", "title"])) return;
    id(group.id, `${path}.id`);
    title(group.title, `${path}.title`);
    groupIds.add(group.id);
  });
  if (list(value.tasks, "$.tasks", LIMITS.tasks)) value.tasks.forEach((task, index) => {
    const path = `$.tasks[${index}]`;
    if (!object(task, path, TASK_KEYS, TASK_KEYS.filter((key) => !OPTIONAL_TASK_KEYS.includes(key)))) return;
    id(task.id, `${path}.id`);
    title(task.title, `${path}.title`);
    if (owns(task, "groupId") && string(task.groupId, `${path}.groupId`, LIMITS.id) && task.groupId !== "" && !groupIds.has(task.groupId)) {
      error(`${path}.groupId: 존재하지 않는 업무 영역 ID입니다.`);
    }
    for (const key of ["ownerRole", "supportRole"]) if (owns(task, key)) string(task[key], `${path}.${key}`, 1_000);
    if (owns(task, "accessStatus") && !ACCESS_STATUSES.has(task.accessStatus)) error(`${path}.accessStatus: 지원하지 않는 자료 접근 확인 상태입니다.`);
    timing(task.timing, `${path}.timing`);
    TASK_TEXT.forEach((key) => string(task[key], `${path}.${key}`));
    if (string(task.verifiedAt, `${path}.verifiedAt`, 40) && task.verifiedAt !== "" && !parseCivil(task.verifiedAt) && !validTimestamp(task.verifiedAt)) {
      error(`${path}.verifiedAt: 빈 값, YYYY-MM-DD 날짜 또는 ISO 시각이 필요합니다.`);
    }
    ["accessChecked", "firstDay", "firstWeek"].forEach((key) => boolean(task[key], `${path}.${key}`));
    sourceRefs(task.sourceRefs, `${path}.sourceRefs`);
  });
  if (list(value.cases, "$.cases", LIMITS.cases)) value.cases.forEach((item, index) => {
    const path = `$.cases[${index}]`;
    if (!object(item, path, CASE_KEYS)) return;
    id(item.id, `${path}.id`);
    title(item.title, `${path}.title`);
    if (!STATUSES.has(item.status)) error(`${path}.status: 지원하지 않는 진행 상태입니다.`);
    ["nextAction", "waitingFor", "notes"].forEach((key) => string(item[key], `${path}.${key}`));
    civil(item.dueDate, `${path}.dueDate`);
    sourceRefs(item.sourceRefs, `${path}.sourceRefs`);
  });
  const sourceIds = new Set();
  if (list(value.sourceFiles, "$.sourceFiles", LIMITS.sources)) value.sourceFiles.forEach((source, index) => {
    const path = `$.sourceFiles[${index}]`;
    if (!object(source, path, SOURCE_KEYS)) return;
    id(source.id, `${path}.id`);
    sourceIds.add(source.id);
    string(source.name, `${path}.name`, LIMITS.title, true);
    string(source.format, `${path}.format`, 80, true);
    timestamp(source.importedAt, `${path}.importedAt`);
    string(source.excerpt, `${path}.excerpt`, LIMITS.excerpt);
    if (list(source.warnings, `${path}.warnings`, 200)) source.warnings.forEach((item, itemIndex) => string(item, `${path}.warnings[${itemIndex}]`, 2_000));
  });
  refs.forEach(({ reference, path }) => { if (!sourceIds.has(reference)) error(`${path}: 존재하지 않는 출처 ID "${reference}"입니다.`); });
  return { ok: errors.length === 0, errors, warnings };
}

/** JSON.parse accepts duplicate keys by dropping earlier values. Reject that loss. */
function rejectDuplicateJSONKeys(text) {
  const stack = [];
  let nodes = 0;
  const count = () => {
    if (++nodes > LIMITS.nodes) throw new Error("JSON 항목 수가 제한(100,000개)을 초과했습니다.");
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "{") {
      count();
      stack.push({ object: true, expectingKey: true, keys: new Set() });
      if (stack.length > LIMITS.depth + 1) throw new Error(`JSON 중첩은 ${LIMITS.depth}단계까지 지원합니다.`);
    } else if (character === "[") {
      count();
      stack.push({ object: false });
      if (stack.length > LIMITS.depth + 1) throw new Error(`JSON 중첩은 ${LIMITS.depth}단계까지 지원합니다.`);
    } else if (character === "}" || character === "]") stack.pop();
    else if (character === ",") {
      if (stack.at(-1)?.object) stack.at(-1).expectingKey = true;
    } else if (character === "\"") {
      const start = index;
      while (++index < text.length) {
        if (text[index] === "\\") index++;
        else if (text[index] === "\"") break;
      }
      const parent = stack.at(-1);
      if (parent?.object && parent.expectingKey) {
        const key = JSON.parse(text.slice(start, index + 1));
        if (parent.keys.has(key)) throw new Error(`중복 JSON 속성 "${key}"이 있습니다. 먼저 원본을 수정해 주세요.`);
        if (BAD_KEYS.has(key)) throw new Error(`금지된 prototype 관련 속성 "${key}"이 있습니다.`);
        parent.keys.add(key);
        parent.expectingKey = false;
      } else count();
    } else if (/[0-9tfn-]/.test(character)) {
      count();
      while (index + 1 < text.length && !/[\s,\]}:]/.test(text[index + 1])) index++;
    }
  }
}

export function parseImport(text) {
  if (typeof text !== "string") throw new TypeError("JSON 텍스트를 전달해 주세요.");
  if (encoder.encode(text).byteLength > LIMITS.jsonBytes) throw new Error("JSON 파일은 UTF-8 기준 5 MiB 이하여야 합니다.");
  let document;
  try {
    // Scan nesting/count limits before JSON.parse can allocate an abusive graph.
    rejectDuplicateJSONKeys(text);
    document = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error("올바른 JSON 문서가 아닙니다. 파일의 문법을 확인해 주세요.");
  }
  const result = validateDocument(document);
  if (!result.ok) throw new Error(`가져올 수 없는 인수인계 문서입니다.\n${result.errors.join("\n")}`);
  return { document, warnings: result.warnings };
}

export function stringifyDocument(document) {
  const result = validateDocument(document);
  if (!result.ok) throw new Error(`저장할 수 없는 인수인계 문서입니다.\n${result.errors.join("\n")}`);
  return JSON.stringify(document, null, 2);
}

export function importAsCopy(document) {
  const source = parseImport(stringifyDocument(document)).document;
  const now = new Date().toISOString();
  const map = new Map();
  const oldIds = new Set([source.id, ...(source.groups ?? []).map((item) => item.id), ...source.tasks.map((item) => item.id), ...source.cases.map((item) => item.id), ...source.sourceFiles.map((item) => item.id)]);
  const newIds = new Set();
  function fresh(oldId) {
    let replacement;
    do { replacement = makeId(); } while (oldIds.has(replacement) || newIds.has(replacement));
    map.set(oldId, replacement);
    newIds.add(replacement);
    return replacement;
  }
  const id = fresh(source.id);
  const sourceFiles = source.sourceFiles.map((item) => ({ ...item, id: fresh(item.id) }));
  const groups = source.groups?.map((item) => ({ ...item, id: fresh(item.id) }));
  const remap = (item) => ({
    ...item, id: fresh(item.id), sourceRefs: item.sourceRefs.map((reference) => map.get(reference)),
    ...(owns(item, "groupId") ? { groupId: item.groupId === "" ? "" : map.get(item.groupId) } : {}),
  });
  const tasks = source.tasks.map(remap);
  const cases = source.cases.map(remap);
  const previous = source.provenance;
  const continuing = previous?.copyFormat === COPY_FORMAT
    && typeof previous.originDocumentId === "string"
    && Array.isArray(previous.copyHistory);
  // Preserve arbitrary incoming provenance in full. The envelope is only
  // flattened on subsequent copies made by this model.
  const provenance = continuing ? previous : {
    copyFormat: COPY_FORMAT,
    originDocumentId: nonblank(previous?.originDocumentId) ? previous.originDocumentId : source.id,
    ...(previous ? { sourceProvenance: previous } : {}),
    copyHistory: [],
  };
  provenance.copiedFromDocumentId = source.id;
  provenance.copyHistory.push({
    sourceDocumentId: source.id,
    documentId: id,
    copiedAt: now,
    sourceCreatedAt: source.createdAt,
    sourceUpdatedAt: source.updatedAt,
    idMap: Object.fromEntries(map),
  });
  const copy = { ...source, id, createdAt: now, updatedAt: now, ...(groups ? { groups } : {}), tasks, cases, sourceFiles, provenance };
  const result = validateDocument(copy);
  if (!result.ok) throw new Error(`출처 정보를 보존한 복사본이 문서 제한을 초과했습니다.\n${result.errors.join("\n")}`);
  return copy;
}

export function dueInRange(task, startISO, endISO) {
  const unresolved = (reason) => ({ dates: [], unresolved: true, reason });
  const resolved = (dates = []) => ({ dates, unresolved: false, reason: "" });
  const start = parseCivil(startISO);
  const end = parseCivil(endISO);
  if (!start || !end) return unresolved("조회 범위는 실제로 존재하는 YYYY-MM-DD 날짜여야 합니다.");
  const first = ordinal(start);
  const last = ordinal(end);
  if (first > last) return unresolved("조회 시작일이 종료일보다 늦습니다.");
  if (last - first + 1 > LIMITS.rangeDays) return unresolved(`한 번에 ${LIMITS.rangeDays.toLocaleString("ko-KR")}일 이내를 조회해 주세요.`);
  const timing = task?.timing;
  if (!isRecord(timing)) return unresolved("일정 규칙이 없습니다.");
  const oneDate = (date) => resolved(date >= startISO && date <= endISO ? [date] : []);
  if (timing.kind === "date") {
    if (!parseCivil(timing.date)) return unresolved("확정 날짜를 입력해 주세요. 존재하지 않는 날짜는 계산하지 않습니다.");
    return oneDate(timing.date);
  }
  if (timing.kind === "relative") {
    const anchor = parseCivil(timing.anchorDate);
    if (!anchor) return unresolved("상대 날짜의 기준일이 아직 확정되지 않았습니다.");
    if (!Number.isInteger(timing.offsetDays) || Math.abs(timing.offsetDays) > LIMITS.offsetDays) return unresolved("기준일에서 더하거나 뺄 일수를 정수로 입력해 주세요.");
    const target = fromOrdinal(ordinal(anchor) + timing.offsetDays);
    if (!target) return unresolved("상대 날짜가 지원 범위(0001년~9999년)를 벗어납니다.");
    return oneDate(civilString(target));
  }
  if (timing.kind === "event") return unresolved(nonblank(timing.trigger) ? `사건 발생 시 실행: ${timing.trigger}` : "업무를 시작할 사건·조건을 입력해 주세요.");
  if (timing.kind !== "regular") return unresolved("지원하지 않는 일정 종류입니다.");
  if (!CADENCES.has(timing.cadence)) return unresolved("반복 주기를 선택해 주세요.");
  if (timing.cadence === "semester") return unresolved("학기 일정은 기관별로 다릅니다. 확정 날짜 또는 기준일을 입력해 주세요.");
  const dayRule = timing.dayRule ?? "dayOfMonth";
  if (timing.cadence === "monthly") {
    if (!DAY_RULES.has(dayRule)) return unresolved("지원하지 않는 월간 날짜 규칙입니다.");
    if (dayRule === "monthStartUnconfirmed") return unresolved("월초의 정확한 날짜가 아직 확정되지 않았습니다. 달력 1일인지 다른 기준인지 확인해 주세요.");
    if (dayRule === "firstBusinessDay") return unresolved("첫 영업일은 기관 휴무일·공휴일 확인이 필요합니다. 확정 날짜를 입력해 주세요.");
  }
  if (timing.cadence === "weekly" && (!Number.isInteger(timing.weekday) || timing.weekday < 1 || timing.weekday > 7)) return unresolved("요일을 선택해 주세요(월요일 1~일요일 7).");
  const needsDay = ["quarterly", "halfyear", "yearly"].includes(timing.cadence) || (timing.cadence === "monthly" && dayRule === "dayOfMonth");
  if (needsDay && (!Number.isInteger(timing.day) || timing.day < 1 || timing.day > 31)) return unresolved("반복일을 1일부터 31일 사이로 입력해 주세요.");
  if (["quarterly", "halfyear", "yearly"].includes(timing.cadence) && (!Number.isInteger(timing.month) || timing.month < 1 || timing.month > 12)) return unresolved("반복 기준 월을 1월부터 12월 사이로 입력해 주세요.");
  if (timing.cadence === "yearly" && timing.day > monthDays(2000, timing.month)) return unresolved("해당 월에는 지정한 날짜가 존재하지 않습니다.");
  const dates = [];
  for (let day = first; day <= last; day++) {
    const current = fromOrdinal(day);
    let matches = false;
    switch (timing.cadence) {
      case "daily": matches = true; break;
      case "weekly": matches = day % 7 + 1 === timing.weekday; break;
      case "monthly": matches = current.day === (dayRule === "monthEnd" ? monthDays(current.year, current.month) : timing.day); break;
      case "quarterly": matches = current.day === timing.day && (current.month - timing.month + 12) % 3 === 0; break;
      case "halfyear": matches = current.day === timing.day && (current.month - timing.month + 12) % 6 === 0; break;
      case "yearly": matches = current.day === timing.day && current.month === timing.month; break;
    }
    if (matches) dates.push(civilString(current));
  }
  return resolved(dates);
}

/**
 * Optional todayISO is useful for deterministic review/tests. Completed cases
 * do not need a next action; date/deadline work needs a preparation start rule.
 */
export function issuesFor(document, todayISO = dateISO()) {
  const issues = [];
  const today = parseCivil(todayISO);
  if (!today) throw new RangeError("점검 기준일은 유효한 YYYY-MM-DD 날짜여야 합니다.");
  const add = (item, kind, message) => issues.push({ id: `${item.id}:${kind}`, itemId: item.id, kind, message });
  for (const task of document.tasks ?? []) {
    const timing = task.timing ?? {};
    const needsStart = ["date", "relative"].includes(timing.kind)
      || (timing.kind === "regular" && ["monthly", "quarterly", "halfyear", "yearly", "semester"].includes(timing.cadence));
    if (needsStart && !nonblank(timing.startRule)) add(task, "missing-start", "마감 전에 언제 준비를 시작할지 시작 기준을 적어 주세요.");
    const accessResolved = task.accessStatus === "confirmed" || task.accessStatus === "notApplicable"
      || (!owns(task, "accessStatus") && task.accessChecked === true);
    if ((nonblank(task.materials) || task.sourceRefs?.length > 0) && !accessResolved) add(task, "access-unchecked", "필요한 자료·시스템을 인수자가 실제로 열 수 있는지 확인해 주세요.");
    const verified = parseCivil(task.verifiedAt)
      || (validTimestamp(task.verifiedAt) ? parseCivil(task.verifiedAt.slice(0, 10)) : null);
    if (!verified) add(task, "verification-missing", "이 업무 내용을 마지막으로 확인한 날짜가 없습니다.");
    else if (ordinal(today) - ordinal(verified) > 90) add(task, "verification-stale", "마지막 확인 후 90일이 지났습니다. 절차와 담당자를 다시 확인해 주세요.");
    else if (ordinal(verified) > ordinal(today)) add(task, "verification-future", "마지막 확인일이 미래입니다. 날짜를 확인해 주세요.");
  }
  for (const item of document.cases ?? []) {
    if (item.status !== "done" && !nonblank(item.nextAction)) add(item, "missing-next-action", "이 건을 이어받은 사람이 다음에 할 행동을 한 가지 적어 주세요.");
  }
  return issues;
}

/** All names, procedures and cases below are synthetic learning examples. */
export function exampleDocument(todayISO = dateISO()) {
  const today = parseCivil(todayISO);
  if (!today) throw new RangeError("예시 기준일은 유효한 YYYY-MM-DD 날짜여야 합니다.");
  const atOffset = (days) => {
    const value = fromOrdinal(ordinal(today) + days);
    return value ? civilString(value) : todayISO;
  };
  const document = createDocument({
    title: "[가상 예시] 해솔 학습지원팀 업무 인수인계",
    onboarding: {
      dayOne: "이 문서는 기능 체험용 가상 예시입니다. 실제 기관의 규정·연락처·계정이 아닙니다.\n1. 전임자와 진행 중인 3건의 다음 행동을 함께 읽습니다.\n2. 본인 계정으로 예시 자료실의 열람 권한을 확인합니다. 비밀번호를 전달받지 않습니다.\n3. 오늘 일정과 긴급 문의 전달 경로를 확인하고 체크합니다.",
      firstWeek: "1. 주간 회의 자료를 함께 작성하고 승인받는 과정을 연습합니다.\n2. 월말·학기 업무의 준비 시작일과 실제 마감일을 기관 일정으로 교체합니다.\n3. 예외 상황 1건을 놓고 연락 순서와 완료 증빙을 확인합니다.\n4. 아래 가상 예시를 실제 담당자에게 확인한 내용으로 수정하고 확인일을 기록합니다.",
    },
  });
  const source = {
    id: makeId(), name: "[가상] 업무 연습용 안내문.txt", format: "text",
    importedAt: document.createdAt,
    excerpt: "기능 체험을 위해 만든 가상 자료입니다. 실제 행정 지침이 아닙니다.\n구분\t준비\t확인\n주간 회의\t전 주 기록 검토\t팀 검토\n월말 집계\t누락 점검\t합계 대조\n연락처·링크·운영 규정은 실제 정보로 바꾼 뒤 사용하세요.",
    warnings: ["실무에 적용하기 전에 기관 규정과 담당자를 확인하세요."],
  };
  document.sourceFiles = [source];
  document.groups = [
    { id: makeId(), title: "[가상] 일상 운영" },
    { id: makeId(), title: "[가상] 정기 점검" },
    { id: makeId(), title: "[가상] 행사·학기 운영" },
  ];
  const task = (title, timing, fields) => createTask({
    title: `[가상] ${title}`, timing, purpose: "가상 학습지원팀의 인수인계 절차를 연습합니다.",
    contacts: "가상 담당 역할: 학습지원팀 운영 담당자. 실제 연락처는 인수 시 확인합니다.",
    approval: "최종 공유 전 가상 팀장 역할의 검토를 받습니다.",
    exceptions: "자료가 없거나 권한이 막히면 임의로 진행하지 말고 담당자에게 확인한 뒤 진행 기록을 남깁니다.",
    verifiedAt: todayISO, sourceRefs: [source.id], accessChecked: true, ...fields,
  });
  document.tasks = [
    task("매일 접수함 확인", { kind: "regular", cadence: "daily", startRule: "업무 시작 후 접수함을 확인한다." }, {
      method: "새 접수 내용을 분류하고 담당 역할에 연결합니다.", materials: "가상 접수함, 문의 분류표",
      steps: "1. 새 접수와 미처리 건을 읽습니다.\n2. 중복·긴급 여부를 확인합니다.\n3. 담당 역할과 다음 확인 시각을 기록합니다.",
      doneWhen: "모든 새 접수에 담당 역할과 다음 행동이 기록되어 있습니다.", evidence: "개인정보를 가린 접수 처리 기록", firstDay: true,
    }),
    task("주간 회의 준비", { kind: "regular", cadence: "weekly", weekday: 1, startRule: "회의 전 영업일에 안건을 모은다." }, {
      method: "미해결 안건과 이번 주 일정을 한 페이지로 정리합니다.", materials: "가상 회의 안건 양식, 지난 회의 기록",
      steps: "1. 지난 회의의 미완료 항목을 옮깁니다.\n2. 결정이 필요한 사항을 적습니다.\n3. 검토 후 회의 자료를 공유합니다.",
      doneWhen: "모든 안건에 결정 요청 또는 다음 행동이 있습니다.", evidence: "검토된 안건 문서와 회의 후 결정 기록", firstWeek: true,
    }),
    task("월말 실적 집계", { kind: "regular", cadence: "monthly", dayRule: "monthEnd", startRule: "달력상 월말 5일 전부터 누락을 확인한다." }, {
      method: "월별 가상 운영 건수를 중복 없이 집계합니다.", materials: "가상 운영대장, 집계표",
      steps: "1. 집계 기준 기간을 표시합니다.\n2. 중복과 누락을 대조합니다.\n3. 합계를 원장과 비교하고 승인받습니다.",
      doneWhen: "원장과 집계 합계가 일치하고 검토 이력이 남아 있습니다.", evidence: "검토 완료 집계표",
    }),
    task("분기 비품 점검", { kind: "regular", cadence: "quarterly", month: 3, day: 15, startRule: "점검일 2주 전에 담당 구역을 배정한다." }, {
      method: "가상 비품대장과 실물의 상태를 대조합니다.", materials: "가상 비품대장, 상태 점검표",
      steps: "1. 구역별 목록을 준비합니다.\n2. 수량과 상태를 확인합니다.\n3. 차이를 기록하고 조치 담당을 정합니다.",
      doneWhen: "차이 항목마다 사유 또는 후속 조치가 있습니다.", evidence: "서명 대신 역할명이 적힌 가상 점검표",
    }),
    task("반기 접근 권한 점검", { kind: "regular", cadence: "halfyear", month: 6, day: 20, startRule: "점검일 10일 전 담당 역할 목록을 확인한다." }, {
      method: "담당 업무와 자료 접근 범위가 맞는지 확인합니다.", materials: "가상 역할 목록, 권한 신청 절차",
      steps: "1. 현재 담당 역할을 확인합니다.\n2. 필요한 자료를 본인 계정으로 열어 봅니다.\n3. 변경이 필요하면 정식 승인 절차로 신청합니다.",
      doneWhen: "필요한 권한은 확인되고 변경 요청은 승인 경로에 올라가 있습니다.", evidence: "비밀번호를 포함하지 않은 확인·신청 기록", accessChecked: false,
    }),
    task("연간 자료 보관 점검", { kind: "regular", cadence: "yearly", month: 12, day: 10, startRule: "점검일 한 달 전 보관 기준을 확인한다." }, {
      method: "기관의 실제 보관 규정을 확인한 뒤 자료 목록을 점검합니다.", materials: "가상 보관 목록, 실제 기관에서 확인할 보관 규정",
      steps: "1. 적용할 규정을 담당자에게 확인합니다.\n2. 자료별 보관 위치와 권한을 점검합니다.\n3. 삭제·이관은 별도 승인 후 처리합니다.",
      doneWhen: "목록과 보관 위치가 일치하고 필요한 승인이 기록되어 있습니다.", evidence: "검토된 보관 목록",
    }),
    task("학기 시작 안내 준비", { kind: "regular", cadence: "semester", startRule: "기관 학사일정 확정 후 시작일 3주 전에 준비한다." }, {
      method: "학기 시작일을 실제 기관 일정에서 확인한 뒤 안내를 준비합니다.", materials: "가상 안내문 양식, 확인할 실제 학사일정",
      steps: "1. 학기 시작일을 확정합니다.\n2. 안내 대상과 내용을 검토합니다.\n3. 승인 후 안내하고 문의 경로를 남깁니다.",
      doneWhen: "확정 일정이 반영되고 대상자가 안내를 확인할 수 있습니다.", evidence: "승인된 안내문", verifiedAt: "",
    }),
    task("오리엔테이션 준비 마감", { kind: "date", date: atOffset(7), startRule: "" }, {
      method: "가상 행사에 필요한 장소·자료·참석 안내를 확인합니다.", materials: "가상 행사 점검표",
      steps: "1. 행사 조건과 참석 규모를 확인합니다.\n2. 장소와 자료를 점검합니다.\n3. 최종 확인을 요청합니다.",
      doneWhen: "점검표의 모든 필수 항목에 확인 결과가 있습니다.", evidence: "최종 점검표", firstWeek: true,
    }),
    task("운영 변경 요청 처리", { kind: "event", trigger: "승인된 운영 변경 요청이 접수될 때", startRule: "접수 내용을 확인한 뒤 영향 범위를 검토한다." }, {
      method: "변경 이유와 영향 범위를 정리하고 승인 경로를 확인합니다.", materials: "가상 변경 요청 양식",
      steps: "1. 요청 내용을 확인합니다.\n2. 영향받는 일정과 담당 역할을 정리합니다.\n3. 승인 후 반영하고 요청자에게 결과를 전달합니다.",
      doneWhen: "반영 여부와 사유가 기록되고 요청자에게 결과가 전달되었습니다.", evidence: "승인·반영 기록", verifiedAt: atOffset(-120),
    }),
    task("행사 후 정산 자료 모으기", { kind: "relative", anchorDate: "", offsetDays: 3, startRule: "행사 종료일을 확정한 뒤 다음 날부터 자료를 모은다." }, {
      method: "행사 종료 후 필요한 증빙을 모아 검토 담당에게 전달합니다.", materials: "가상 증빙 목록, 정산 검토 양식",
      steps: "1. 실제 행사 종료일을 기준일에 입력합니다.\n2. 필요한 증빙이 빠짐없이 있는지 대조합니다.\n3. 개인·계좌 정보를 최소화해 승인된 경로로 전달합니다.",
      doneWhen: "필수 증빙이 모이고 검토 담당이 수령을 확인했습니다.", evidence: "민감정보를 제외한 전달·수령 기록",
    }),
  ];
  document.tasks.forEach((item, index) => {
    const groupIndex = index < 3 ? 0 : index < 6 ? 1 : 2;
    item.groupId = document.groups[groupIndex].id;
    item.ownerRole = ["가상 일상 운영 담당 역할", "가상 정기 점검 담당 역할", "가상 행사·학기 담당 역할"][groupIndex];
    item.supportRole = "가상 자료 확인 지원 역할";
  });
  document.cases = [
    createCase({
      title: "[가상] 다음 주 교육실 배정 확인", status: "doing", nextAction: "시설 담당 역할에게 가상 배정안의 검토 결과를 확인한다.",
      dueDate: atOffset(3), waitingFor: "", notes: "현재 상태: 배정안 작성 완료.\n주의: 이 예시의 공간과 담당자는 실제로 존재하지 않습니다.", sourceRefs: [source.id],
    }),
    createCase({
      title: "[가상] 안내문 검토 회신 대기", status: "waiting", nextAction: "기한까지 회신이 없으면 검토 담당 역할에게 진행 상황을 확인한다.",
      dueDate: atOffset(5), waitingFor: "가상 검토 담당 역할의 문구 확인", notes: "전달 완료: 안내문 초안 v1.\n미확정: 최종 일정 문구.", sourceRefs: [source.id],
    }),
    createCase({
      title: "[가상] 자료실 권한 신청 준비", status: "todo", nextAction: "", dueDate: "",
      waitingFor: "", notes: "누락 점검 기능을 체험하기 위해 다음 행동을 비워 둔 가상 사례입니다. 실제 인수 시 신청 담당 역할과 다음 행동을 적으세요.", sourceRefs: [source.id],
    }),
  ];
  return document;
}
