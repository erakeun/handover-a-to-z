import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_SCHEMA_VERSION, createDocument, createTask, createCase, validateDocument, stringifyDocument,
  parseImport, importAsCopy, dueInRange, issuesFor, exampleDocument,
} from '../src/model.js';

const valid = (document) => assert.deepEqual(validateDocument(document).errors, []);

test('new tasks and cases have optional first action and an explicitly unknown current state', () => {
  const task = createTask({ title: '가상 접수' });
  const item = createCase({ title: '가상 건' });
  assert.equal(task.firstAction, '');
  assert.equal(item.status, 'unknown');
  assert.equal(item.statusConfirmed, false);
  assert.equal(item.taskId, '');
  assert.equal(CURRENT_SCHEMA_VERSION, 3);
  assert.equal(createDocument().schemaVersion, 3);
  valid(createDocument({ tasks: [task], cases: [item] }));
});

test('legacy imports preserve old states and do not insert confirmation or action fields', () => {
  for (const schemaVersion of [1, 2]) {
    const task = createTask({ title: '기존 업무', method: '원래 설명' });
    delete task.firstAction;
    const item = createCase({ title: '기존 건', status: 'done' });
    delete item.statusConfirmed; delete item.taskId;
    const original = createDocument({ schemaVersion, tasks: [task], cases: [item] });
    const json = JSON.stringify(original, null, 2);
    const parsed = parseImport(json).document;
    assert.equal(stringifyDocument(parsed), json);
    const copied = importAsCopy(parsed);
    assert.equal(parsed.schemaVersion, schemaVersion);
    assert.equal(copied.schemaVersion, schemaVersion);
    assert.equal(copied.cases[0].status, 'done');
    assert.equal(Object.hasOwn(copied.tasks[0], 'firstAction'), false);
    assert.equal(Object.hasOwn(copied.cases[0], 'statusConfirmed'), false);
    assert.equal(Object.hasOwn(copied.cases[0], 'taskId'), false);
  }
});

test('first action is optional but bounded; current-state confirmation must be a boolean', () => {
  const doc = createDocument({ tasks: [createTask({ firstAction: '가'.repeat(2_000) })], cases: [createCase()] });
  valid(doc);
  doc.tasks[0].firstAction += '나';
  assert.match(validateDocument(doc).errors.join(' '), /firstAction.*2,000/);
  delete doc.tasks[0].firstAction;
  doc.cases[0].statusConfirmed = 'yes';
  assert.match(validateDocument(doc).errors.join(' '), /statusConfirmed/);
  doc.cases[0].statusConfirmed = false; doc.cases[0].status = 'not-a-state';
  assert.match(validateDocument(doc).errors.join(' '), /진행 상태/);
});

test('related task IDs validate, survive JSON, and remap on a copied document', () => {
  const first = createTask({ title: '가상 업무 1' }), second = createTask({ title: '가상 업무 2' });
  const doc = createDocument({ tasks: [first, second], cases: [createCase({ taskId: second.id }), createCase()] });
  valid(doc);
  const copy = importAsCopy(parseImport(stringifyDocument(doc)).document);
  assert.equal(copy.cases[0].taskId, copy.tasks[1].id);
  assert.notEqual(copy.cases[0].taskId, second.id);
  assert.equal(copy.cases[1].taskId, '');
  assert.equal(doc.cases[0].taskId, second.id);
  doc.cases[0].taskId = 'missing';
  assert.match(validateDocument(doc).errors.join(' '), /존재하지 않는 업무/);
  doc.tasks = {};
  assert.equal(validateDocument(doc).ok, false);
});

test('unconfirmed month-end is a period, while exact legacy monthEnd dates retain their meaning', () => {
  const task = createTask({ timing: { kind: 'regular', cadence: 'monthly', dayRule: 'monthEndUnconfirmed' } });
  valid(createDocument({ tasks: [task] }));
  const range = dueInRange(task, '2028-02-01', '2028-03-31');
  assert.deepEqual(range.dates, []);
  assert.equal(range.unresolved, true);
  assert.match(range.reason, /월말.*미확인/);
  task.timing.dayRule = 'monthEnd';
  assert.deepEqual(dueInRange(task, '2028-02-01', '2028-03-31').dates, ['2028-02-29', '2028-03-31']);
});

test('only an explicitly confirmed completed case is exempt from a next-action check', () => {
  const old = createCase({ status: 'done' }); delete old.statusConfirmed;
  const doc = createDocument({ cases: [old, createCase({ status: 'done', statusConfirmed: false }), createCase({ status: 'done', statusConfirmed: true }), createCase()] });
  const ids = issuesFor(doc, '2026-10-20').filter(item => item.kind === 'missing-next-action').map(item => item.itemId);
  assert.deepEqual(ids, [doc.cases[0].id, doc.cases[1].id, doc.cases[3].id]);
  assert.ok(exampleDocument('2026-10-20').cases.every(item => item.statusConfirmed === true));
});
