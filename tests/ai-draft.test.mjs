import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHOR_PROMPT, parseAIDraft, applyAIDraft } from '../src/ai-draft.js';
import {
  createDocument, createTask, validateDocument, stringifyDocument, parseImport,
  importAsCopy, dueInRange,
} from '../src/model.js';
import { exportAIText, exportDocx } from '../src/exporters.js';
import { extractDocument } from '../src/importers.js';

const example = () => ({
  kind: 'handover-ai-draft',
  groups: [{
    title: '정기 운영',
    tasks: [{
      title: '월간 점검',
      when: '매월 초 · 2026-11-01은 원문에 적힌 참고일',
      method: '  합성 메모 그대로\n표 항목\t확인\n<img src=x onerror=alert(1)>  ',
    }],
  }],
});
const raw = (value = example()) => JSON.stringify(value, null, 2);

test('author prompt requests exact JSON and forbids invented facts and dates', () => {
  assert.match(AUTHOR_PROMPT, /handover-ai-draft/);
  assert.match(AUTHOR_PROMPT, /추측하거나 만들어 내지/);
  assert.match(AUTHOR_PROMPT, /빈 문자열/);
  assert.match(AUTHOR_PROMPT, /비밀번호.*인증키/);
  assert.match(AUTHOR_PROMPT, /날짜로 계산하거나 확정하지/);
});

test('parse returns clean group/task values while preserving original method text', () => {
  const value = example();
  const groups = parseAIDraft(raw(value));
  assert.deepEqual(groups, value.groups);
  assert.notEqual(groups, value.groups);
});

test('apply appends groups and tasks without mutating existing data or inferring dates', () => {
  const document = createDocument({
    title: '기존 문서',
    groups: [{ id: 'existing-group', title: '기존 영역' }],
    tasks: [createTask({ id: 'existing-task', groupId: 'existing-group', title: '기존 업무' })],
  });
  const before = stringifyDocument(document);
  const input = raw();
  const groups = parseAIDraft(input);
  const draft = applyAIDraft(document, groups);
  assert.equal(stringifyDocument(document), before);
  assert.equal(draft.id, document.id);
  assert.deepEqual(draft.tasks[0], document.tasks[0]);
  assert.notEqual(draft.tasks[0], document.tasks[0]);
  assert.equal(draft.groups.length, 2);
  assert.equal(draft.tasks.length, 2);
  const task = draft.tasks[1];
  assert.equal(task.groupId, draft.groups[1].id);
  assert.equal(task.method, example().groups[0].tasks[0].method);
  assert.equal(task.timing.kind, 'event');
  assert.equal(task.timing.trigger, `[AI 초안 · 시점 확인] ${example().groups[0].tasks[0].when}`);
  assert.equal(task.timing.date, '');
  assert.equal(task.timing.anchorDate, '');
  assert.equal(task.verifiedAt, '');
  assert.equal(task.accessChecked, false);
  assert.deepEqual(task.sourceRefs, [draft.sourceFiles[0].id]);
  assert.equal(draft.sourceFiles[0].excerpt, input);
  assert.match(draft.sourceFiles[0].warnings.join(' '), /미검증/);
  assert.equal(validateDocument(draft).ok, true);
  assert.deepEqual(dueInRange(task, '2026-11-01', '2026-11-30').dates, []);
});

test('IDs are fresh across repeated applications and stable through JSON transfer', () => {
  const groups = parseAIDraft(raw());
  const first = applyAIDraft(createDocument(), groups);
  const second = applyAIDraft(first, groups);
  const ids = [...second.groups, ...second.tasks, ...second.sourceFiles].map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(second.tasks[0].id, first.tasks[0].id);
  const transferred = parseImport(stringifyDocument(second)).document;
  assert.deepEqual(transferred, second);
  const copy = importAsCopy(transferred);
  assert.equal(validateDocument(copy).ok, true);
  assert.notEqual(copy.tasks[0].id, transferred.tasks[0].id);
  assert.equal(copy.tasks[0].groupId, copy.groups[0].id);
  assert.deepEqual(copy.tasks[0].sourceRefs, [copy.sourceFiles[0].id]);
});

test('AI authoring exports for an AI recipient and a non-AI DOCX recipient', async () => {
  const draft = applyAIDraft(createDocument({ title: '합성 인수인계' }), parseAIDraft(raw()));
  const aiText = exportAIText(draft);
  assert.match(aiText, /정기 운영/);
  assert.match(aiText, /월간 점검/);
  assert.match(aiText, /AI 초안 · 시점 확인/);
  const bytes = await exportDocx(draft);
  const extracted = await extractDocument({
    name: 'synthetic-ai-recipient.docx',
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  const text = extracted.blocks.map((block) => block.text).join('\n');
  assert.match(text, /정기 운영/);
  assert.match(text, /월간 점검/);
  assert.match(text, /AI 초안 · 시점 확인/);
  assert.match(text, /<img src=x onerror=alert\(1\)>/);
});

test('edited/programmatic groups get provenance matching the applied values', () => {
  const groups = parseAIDraft(raw());
  groups[0].tasks[0].method = '검토한 수정';
  const result = applyAIDraft(createDocument(), groups);
  assert.equal(JSON.parse(result.sourceFiles[0].excerpt).groups[0].tasks[0].method, '검토한 수정');
  const direct = applyAIDraft(createDocument(), example().groups);
  assert.equal(JSON.parse(direct.sourceFiles[0].excerpt).kind, 'handover-ai-draft');
});

test('unknown, missing and wrong-kind fields are rejected at every level', () => {
  for (const change of [
    (v) => { v.extra = 'no'; },
    (v) => { v.groups[0].extra = 'no'; },
    (v) => { v.groups[0].tasks[0].date = '2026-01-01'; },
    (v) => { delete v.groups[0].tasks[0].when; },
    (v) => { v.kind = 'handover'; },
    (v) => { v.groups[0].tasks[0].method = 42; },
  ]) {
    const value = example(); change(value);
    assert.throws(() => parseAIDraft(raw(value)));
  }
  assert.throws(() => parseAIDraft('```json\n' + raw() + '\n```'), /JSON/);
});

test('prototype keys, escaped duplicate keys and unsafe unicode are rejected', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    assert.throws(() => parseAIDraft(`{"kind":"handover-ai-draft","groups":[],"${key}":{}}`), /prototype/);
  }
  assert.throws(() => parseAIDraft('{"kind":"handover-ai-draft","k\\u0069nd":"handover-ai-draft","groups":[]}'), /중복/);
  for (const text of ['x\u0000y', 'x\u0085y', 'x\u202ey', 'x\ud800y', 'x\udc00y']) {
    const value = example(); value.groups[0].tasks[0].method = text;
    assert.throws(() => parseAIDraft(raw(value)), /제어문자|서로게이트/);
  }
  const value = example(); value.groups[0].title = '😀';
  assert.equal(parseAIDraft(raw(value))[0].title, '😀');
});

test('UTF-8 input, field, group and overall task limits are enforced', () => {
  assert.throws(() => parseAIDraft(' '.repeat(1024 * 1024 + 1)), /1 MiB/);
  assert.throws(() => parseAIDraft('한'.repeat(400000)), /1 MiB/);
  for (const [key, length] of [['title', 301], ['when', 1001], ['method', 20001]]) {
    const value = example(); value.groups[0].tasks[0][key] = 'x'.repeat(length);
    assert.throws(() => parseAIDraft(raw(value)), /최대/);
  }
  const tooManyGroups = example();
  tooManyGroups.groups = Array.from({ length: 31 }, () => ({ title: '', tasks: [] }));
  assert.throws(() => parseAIDraft(raw(tooManyGroups)), /30/);
  const tooManyTasks = example();
  tooManyTasks.groups = Array.from({ length: 2 }, () => ({
    title: '', tasks: Array.from({ length: 51 }, () => ({ title: '', when: '', method: '' })),
  }));
  assert.throws(() => parseAIDraft(raw(tooManyTasks)), /전체 합계 최대 100/);
  assert.throws(() => parseAIDraft('['.repeat(9) + ']'.repeat(9)), /중첩/);
});

test('unknown information stays blank and does not become an invented date', () => {
  const draft = applyAIDraft(createDocument(), [{ title: '', tasks: [{ title: '', when: '', method: '' }] }]);
  assert.equal(draft.tasks[0].title, '');
  assert.equal(draft.tasks[0].method, '');
  assert.equal(draft.tasks[0].timing.trigger, '[AI 초안 · 시점 확인]');
  assert.equal(validateDocument(draft).ok, true);
});

test('programmatic getters, hidden/extra fields, sparse arrays and exotic objects are rejected without executing', () => {
  let calls = 0;
  const group = { tasks: [] };
  Object.defineProperty(group, 'title', { enumerable: true, get() { calls++; return 'bad'; } });
  assert.throws(() => applyAIDraft(createDocument(), [group]), /접근자/);
  assert.equal(calls, 0);
  const groups = example().groups;
  groups.extra = true;
  assert.throws(() => applyAIDraft(createDocument(), groups), /추가 속성/);
  assert.throws(() => applyAIDraft(createDocument(), new Array(1)), /빈 배열 칸|추가 속성/);
  assert.throws(() => applyAIDraft(createDocument(), [new Date()]), /일반 JSON 객체/);
});

test('invalid or full target document fails atomically without mutating the original', () => {
  const document = createDocument({
    groups: Array.from({ length: 100 }, (_, i) => ({ id: `old-group-${i}`, title: '기존' })),
  });
  const before = JSON.stringify(document);
  assert.throws(() => applyAIDraft(document, parseAIDraft(raw())), /최대 100/);
  assert.equal(JSON.stringify(document), before);
  const unsafe = { ...createDocument(), extra: true };
  assert.throws(() => applyAIDraft(unsafe, parseAIDraft(raw())), /알 수 없는 속성/);
});
