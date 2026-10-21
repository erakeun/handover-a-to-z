import { CURRENT_SCHEMA_VERSION, createTask, makeId, stringifyDocument, validateDocument } from './model.js';

export const AUTHOR_PROMPT = `내가 제공하는 인수인계 메모를 큰 업무 영역과 세부 업무로 정리해 주세요.
내 메모의 사실만 사용하고, 담당자·절차·날짜·주기·승인 조건·시스템 주소·계정·인증정보를 추측하거나 만들어 내지 마세요.
알 수 없는 값은 빈 문자열("")로 두세요. 비밀번호, 인증키, 토큰, 주민등록번호 등 민감정보는 포함하지 마세요.
큰 업무 영역 아래에 세부 업무를 묶고, 각 세부 업무에는 업무명(title), 수행 시점의 원문(when), 하는 방법(method)을 적어 주세요.
when은 "매월 초", "요청이 오면"처럼 메모에 있는 표현을 유지하세요. 날짜로 계산하거나 확정하지 마세요.
method는 사람이 원문과 대조하고 수정할 수 있는 초안으로 작성하고, 원문에 없는 내용을 보충하지 마세요.
큰 업무 영역은 최대 30개, 세부 업무는 전체 합계 최대 100개입니다. title은 300자, when은 1,000자, method는 20,000자 이내로 작성하세요.
설명·Markdown 코드 블록·주석 없이 아래 구조의 JSON 객체 하나만 반환하세요. 표시한 키 외의 속성은 추가하지 마세요.
{"kind":"handover-ai-draft","groups":[{"title":"","tasks":[{"title":"","when":"","method":""}]}]}

정리할 메모:
`;

const MAX_BYTES = 1024 * 1024;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const BAD_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const encoder = new TextEncoder();
const originals = new WeakMap();

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function safeString(value, maximum, path) {
  check(typeof value === 'string', `${path}: 문자열이 필요합니다.`);
  check(value.length <= maximum, `${path}: 최대 ${maximum.toLocaleString('en-US')}자까지 입력할 수 있습니다.`);
  check(!BAD_CONTROLS.test(value), `${path}: 허용하지 않는 제어문자가 있습니다.`);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      check(next >= 0xdc00 && next <= 0xdfff, `${path}: 짝이 맞지 않는 유니코드 서로게이트가 있습니다.`);
      i++;
    } else {
      check(code < 0xdc00 || code > 0xdfff, `${path}: 짝이 맞지 않는 유니코드 서로게이트가 있습니다.`);
    }
  }
  return value;
}

function properties(value, keys, path) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value),
    `${path}: 일반 JSON 객체가 필요합니다.`);
  const prototype = Object.getPrototypeOf(value);
  check(prototype === Object.prototype || prototype === null, `${path}: 일반 JSON 객체가 필요합니다.`);
  const ownKeys = Reflect.ownKeys(value);
  const result = Object.create(null);
  for (const key of ownKeys) {
    check(typeof key === 'string' && !BAD_KEYS.has(key), `${path}: 금지된 prototype 또는 Symbol 속성입니다.`);
    check(keys.includes(key), `${path}.${key}: 알 수 없는 속성입니다.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable,
      `${path}.${key}: 접근자 또는 숨김 속성은 허용하지 않습니다.`);
    result[key] = descriptor.value;
  }
  for (const key of keys) check(Object.hasOwn(result, key), `${path}.${key}: 필수 속성이 없습니다.`);
  return result;
}

function array(value, maximum, path) {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype,
    `${path}: 일반 JSON 배열이 필요합니다.`);
  check(value.length <= maximum, `${path}: 최대 ${maximum}개까지 입력할 수 있습니다.`);
  const keys = Reflect.ownKeys(value);
  check(keys.length === value.length + 1, `${path}: 빈 배열 칸 또는 추가 속성은 허용하지 않습니다.`);
  const items = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    check(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable,
      `${path}[${i}]: 접근자 또는 빈 배열 칸은 허용하지 않습니다.`);
    items.push(descriptor.value);
  }
  return items;
}

function validateGroups(value) {
  let count = 0;
  return array(value, 30, 'groups').map((group, index) => {
    const path = `groups[${index}]`;
    const item = properties(group, ['title', 'tasks'], path);
    const title = safeString(item.title, 300, `${path}.title`);
    const tasks = array(item.tasks, 100, `${path}.tasks`).map((task, taskIndex) => {
      count++;
      check(count <= 100, '세부 업무는 전체 합계 최대 100개까지 입력할 수 있습니다.');
      const taskPath = `${path}.tasks[${taskIndex}]`;
      const fields = properties(task, ['title', 'when', 'method'], taskPath);
      return {
        title: safeString(fields.title, 300, `${taskPath}.title`),
        when: safeString(fields.when, 1000, `${taskPath}.when`),
        method: safeString(fields.method, 20000, `${taskPath}.method`),
      };
    });
    return { title, tasks };
  });
}

// Reject duplicate keys (including escaped spellings) rather than allowing
// JSON.parse to silently discard a prior value. Bound nesting before parsing.
function inspectSyntax(raw) {
  const stack = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '{' || c === '[') {
      stack.push({ object: c === '{', keys: new Set(), expectingKey: c === '{' });
      check(stack.length <= 8, 'AI 초안 JSON 중첩이 너무 깊습니다.');
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') {
      if (stack.at(-1)?.object) stack.at(-1).expectingKey = true;
    } else if (c === '"') {
      const start = i;
      while (++i < raw.length) {
        if (raw[i] === '\\') i++;
        else if (raw[i] === '"') break;
      }
      const top = stack.at(-1);
      if (top?.object && top.expectingKey) {
        let key;
        try { key = JSON.parse(raw.slice(start, i + 1)); }
        catch { throw new Error('AI 초안의 JSON 문법을 확인해 주세요.'); }
        check(!BAD_KEYS.has(key), `금지된 prototype 속성 "${key}"입니다.`);
        check(!top.keys.has(key), `중복 JSON 속성 "${key}"입니다.`);
        top.keys.add(key);
        top.expectingKey = false;
      }
    }
  }
}

function boundedRaw(raw) {
  check(typeof raw === 'string', 'AI 초안을 JSON 텍스트로 붙여 넣으세요.');
  check(raw.length <= MAX_BYTES && encoder.encode(raw).length <= MAX_BYTES,
    'AI 초안은 UTF-8 기준 1 MiB 이하여야 합니다.');
}

export function parseAIDraft(raw) {
  boundedRaw(raw);
  inspectSyntax(raw);
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('올바른 AI 초안 JSON이 아닙니다. 설명과 코드 블록 없이 JSON 객체만 붙여 넣으세요.'); }
  const fields = properties(value, ['kind', 'groups'], 'AI 초안');
  check(fields.kind === 'handover-ai-draft', 'kind는 "handover-ai-draft"여야 합니다.');
  const groups = validateGroups(fields.groups);
  originals.set(groups, { raw, canonical: JSON.stringify(groups) });
  return groups;
}

export function applyAIDraft(document, groups) {
  // Validate before cloning, so getters/toJSON cannot run while copying a draft.
  const documentJSON = stringifyDocument(document);
  const safeGroups = validateGroups(groups);
  const canonical = JSON.stringify({ kind: 'handover-ai-draft', groups: safeGroups });
  boundedRaw(canonical);
  const original = originals.get(groups);
  const excerpt = original?.canonical === JSON.stringify(safeGroups) ? original.raw : canonical;
  const result = JSON.parse(documentJSON);
  result.groups ??= [];
  const usedIds = new Set([
    result.id, ...result.groups.map((g) => g.id), ...result.tasks.map((t) => t.id),
    ...result.cases.map((c) => c.id), ...result.sourceFiles.map((s) => s.id),
  ]);
  const freshId = () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = makeId();
      if (!usedIds.has(id)) { usedIds.add(id); return id; }
    }
    throw new Error('새 항목 ID를 만들지 못했습니다. 다시 시도해 주세요.');
  };
  const now = new Date().toISOString();
  const sourceId = freshId();
  result.sourceFiles.push({
    id: sourceId,
    name: 'AI 구조화 초안 · 원문 대조 필요',
    format: 'handover-ai-draft',
    importedAt: now,
    excerpt,
    warnings: [
      'AI가 작성한 미검증 초안입니다. 원문과 대조하고 사실·누락·민감정보를 확인하세요.',
      '수행 시점은 원문을 보존했습니다. 날짜나 반복 주기로 자동 확정하지 않았으므로 직접 설정하세요.',
    ],
  });
  for (const group of safeGroups) {
    const groupId = freshId();
    result.groups.push({ id: groupId, title: group.title });
    for (const task of group.tasks) {
      result.tasks.push(createTask({
        id: freshId(),
        groupId,
        title: task.title,
        method: task.method,
        timing: { kind: 'event', trigger: `[AI 초안 · 시점 확인]${task.when ? ` ${task.when}` : ''}` },
        sourceRefs: [sourceId],
      }));
    }
  }
  result.schemaVersion = CURRENT_SCHEMA_VERSION;
  result.updatedAt = now;
  const validation = validateDocument(result);
  check(validation.ok, `AI 초안을 추가할 수 없습니다.\n${validation.errors.join('\n')}`);
  return result;
}
