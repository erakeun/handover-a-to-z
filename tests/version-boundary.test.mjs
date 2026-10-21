import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CURRENT_SCHEMA_VERSION, LIMITS, createDocument, createTask, createCase, exampleDocument,
  validateDocument, parseImport, stringifyDocument, importAsCopy, dueInRange,
} from '../src/model.js';
import { reviewExampleDocument } from '../src/review-example.js';

// This was the public HEAD when the v3 boundary was added. Pin the comparison so
// committing this change cannot silently replace the old reader under test.
const PRODUCTION_REVISION = 'da51d9039ff471ef174eaa476f905c078bd79cf8';
const repo = fileURLToPath(new URL('..', import.meta.url));
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const reference = git(['rev-parse', 'HEAD']).trim() === PRODUCTION_REVISION ? 'HEAD' : PRODUCTION_REVISION;
const snapshot = mkdtempSync(join(tmpdir(), 'handover-public-model-'));
const originalSources = new Map();
after(() => rmSync(snapshot, { recursive: true, force: true }));
writeFileSync(join(snapshot, 'package.json'), '{"type":"module"}\n');
symlinkSync(join(repo, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
for (const filename of ['model.js', 'image-data.js', 'example-images.js']) {
  const source = git(['show', `${reference}:src/${filename}`]);
  originalSources.set(filename, source);
  writeFileSync(join(snapshot, filename), source);
  chmodSync(join(snapshot, filename), 0o444);
}
const publicModel = await import(pathToFileURL(join(snapshot, 'model.js')).href);
// Freeze the deployed 0.3.0 reader as well: its inability to read the new
// relationship must be an explicit version failure, never dropped page data.
const V3_PRODUCTION_REVISION = 'e180c825c984ba6f85a2dea8407ed8542797e209';
const snapshotV3 = mkdtempSync(join(tmpdir(), 'handover-public-v3-model-'));
after(() => rmSync(snapshotV3, { recursive: true, force: true }));
writeFileSync(join(snapshotV3, 'package.json'), '{"type":"module"}\n');
symlinkSync(join(repo, 'node_modules'), join(snapshotV3, 'node_modules'), 'dir');
const v3Sources = new Map();
for (const filename of ['model.js', 'image-data.js', 'example-images.js']) {
  const source = git(['show', `${V3_PRODUCTION_REVISION}:src/${filename}`]);
  v3Sources.set(filename, source);
  writeFileSync(join(snapshotV3, filename), source);
  chmodSync(join(snapshotV3, filename), 0o444);
}
const publicV3Model = await import(pathToFileURL(join(snapshotV3, 'model.js')).href);
const valid = (document) => assert.deepEqual(validateDocument(document).errors, []);

function legacyDocument(version) {
  const document = publicModel.createDocument({ schemaVersion: version, title: '가상 기존 문서' });
  document.sourceFiles = [{ id: 'legacy-source', name: '가상 원문.txt', format: 'text',
    importedAt: document.createdAt, excerpt: '표\t사진 설명\r\n한글 e\u0301 🧩', warnings: ['가상 자료'] }];
  document.tasks = [publicModel.createTask({ title: '가상 월말 업무', method: '원문\r\n유지',
    timing: { kind: 'regular', cadence: 'monthly', dayRule: 'monthEnd' }, sourceRefs: ['legacy-source'] })];
  document.cases = [publicModel.createCase({ title: '가상 기존 완료 기록', status: 'done', sourceRefs: ['legacy-source'] })];
  document.provenance = { original: { arbitrary: ['원문', null, false, 12] }, copyHistory: '가상 사용자 원문' };
  if (version === 2) {
    const illustrated = publicModel.exampleDocument('2026-10-20').tasks.find(task => task.images?.length);
    assert.ok(illustrated, 'The public model fixture must actually exercise a v2 image.');
    document.tasks[0].images = structuredClone(illustrated.images);
  }
  // Omitted historical optional fields must not be backfilled on import/copy.
  delete document.groups;
  for (const key of ['groupId', 'ownerRole', 'supportRole', 'accessStatus']) delete document.tasks[0][key];
  assert.equal(publicModel.validateDocument(document).ok, true);
  return document;
}

test('v1/v2 public-reader documents preserve exact JSON, image bytes, states and omitted fields', () => {
  for (const version of [1, 2]) {
    const original = legacyDocument(version);
    const json = publicModel.stringifyDocument(original);
    const restored = parseImport(json).document;
    assert.equal(stringifyDocument(restored), json);
    assert.deepEqual(restored, original);
    const copy = importAsCopy(restored);
    assert.equal(copy.schemaVersion, version);
    assert.equal(copy.cases[0].status, 'done');
    assert.equal(copy.tasks[0].timing.dayRule, 'monthEnd');
    assert.equal(Object.hasOwn(copy, 'groups'), false);
    for (const field of ['firstAction', 'groupId', 'ownerRole', 'supportRole', 'accessStatus']) {
      assert.equal(Object.hasOwn(copy.tasks[0], field), false);
    }
    for (const field of ['statusConfirmed', 'taskId']) assert.equal(Object.hasOwn(copy.cases[0], field), false);
    if (version === 2) assert.equal(copy.tasks[0].images[0].data, original.tasks[0].images[0].data);
    assert.equal(publicModel.validateDocument(copy).ok, true);
    assert.deepEqual(dueInRange(restored.tasks[0], '2028-02-01', '2028-03-31').dates, ['2028-02-29', '2028-03-31']);
    assert.equal(stringifyDocument(restored), json, 'copying cannot mutate the imported original');
  }
});

test('every v3 extension is rejected under both legacy version numbers without deleting information', () => {
  const changes = [
    ['firstAction', doc => { doc.tasks[0].firstAction = ''; }],
    ['statusConfirmed', doc => { doc.cases[0].statusConfirmed = false; }],
    ['taskId', doc => { doc.cases[0].taskId = ''; }],
    ['status', doc => { doc.cases[0].status = 'unknown'; }],
    ['dayRule', doc => { doc.tasks[0].timing.dayRule = 'monthEndUnconfirmed'; }],
    ['pdf', doc => { doc.sourceFiles[0].format = 'pdf'; doc.sourceFiles[0].pdf = {
      data: Buffer.from('%PDF-1.4\n').toString('base64'), pageCount: 1,
    }; }],
  ];
  for (const version of [1, 2]) for (const [field, change] of changes) {
    const document = legacyDocument(version); change(document);
    const before = JSON.stringify(document);
    assert.match(validateDocument(document).errors.join('\n'), new RegExp(field));
    assert.throws(() => parseImport(before), new RegExp(field));
    assert.throws(() => stringifyDocument(document), new RegExp(field));
    assert.equal(JSON.stringify(document), before);
  }
});

test('new documents use v4 while upgrading preserves all legacy information and never invents page relationships', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 4);
  assert.equal(createDocument().schemaVersion, 4);
  assert.equal(exampleDocument('2026-10-20').schemaVersion, 4);
  assert.equal(Object.hasOwn(createTask(), 'sourcePages'), false);
  assert.equal(Object.hasOwn(createCase(), 'sourcePages'), false);
  valid(createDocument({ tasks: [createTask()], cases: [createCase()] }));
  const document = legacyDocument(2), before = structuredClone(document);
  document.schemaVersion = 4;
  valid(document);
  assert.deepEqual({ ...document, schemaVersion: 2 }, before);
  document.tasks[0].firstAction = '이전에 받은 내용을 확인한다.';
  document.tasks[0].timing.dayRule = 'monthEndUnconfirmed';
  Object.assign(document.cases[0], { status: 'unknown', statusConfirmed: false, taskId: document.tasks[0].id });
  document.sourceFiles[0].format = 'pdf';
  document.sourceFiles[0].pdf = { data: Buffer.from('%PDF-1.4\n').toString('base64'), pageCount: 1 };
  const json = stringifyDocument(document);
  assert.equal(stringifyDocument(parseImport(json).document), json);
  const copy = importAsCopy(document);
  assert.equal(copy.schemaVersion, 4);
  assert.equal(copy.cases[0].taskId, copy.tasks[0].id);
  assert.deepEqual(copy.sourceFiles[0].pdf, document.sourceFiles[0].pdf);
  assert.equal(Object.hasOwn(copy.tasks[0], 'sourcePages'), false);
  assert.equal(Object.hasOwn(copy.cases[0], 'sourcePages'), false);
});

test('the immutable public HEAD reader explicitly rejects v3 based on its version alone', () => {
  const document = legacyDocument(1);
  document.schemaVersion = 3;
  valid(document);
  const result = publicModel.validateDocument(document);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.startsWith('$.schemaVersion:')));
  assert.throws(() => publicModel.parseImport(stringifyDocument(document)), /schemaVersion.*1 또는 2/);
  for (const [filename, source] of originalSources) {
    assert.equal(readFileSync(join(snapshot, filename), 'utf8'), source);
    assert.equal(statSync(join(snapshot, filename)).mode & 0o222, 0);
  }
});

test('v3 and v4 keep the shared 24 MiB envelope and v1 keeps its 5 MiB boundary', () => {
  const document = createDocument({ schemaVersion: 3 });
  document.sourceFiles = Array.from({ length: 6 }, (_, index) => ({
    id: `large-source-${index}`, name: '가상 긴 원문.txt', format: 'text', importedAt: document.createdAt,
    excerpt: 'A'.repeat(LIMITS.excerpt), warnings: [],
  }));
  const json = stringifyDocument(document);
  assert.ok(Buffer.byteLength(json) > LIMITS.jsonBytes);
  assert.equal(parseImport(json).document.schemaVersion, 3);
  document.schemaVersion = 4;
  assert.equal(parseImport(stringifyDocument(document)).document.schemaVersion, 4);
  document.schemaVersion = 2;
  valid(document);
  document.schemaVersion = 1;
  assert.throws(() => parseImport(JSON.stringify(document)), /5 MiB/);
  document.schemaVersion = 3;
  document.sourceFiles = Array.from({ length: 25 }, (_, index) => ({ ...document.sourceFiles[0], id: `excess-source-${index}` }));
  assert.match(validateDocument(document).errors.join('\n'), /v3.*24 MiB/);
  assert.throws(() => parseImport(' '.repeat(LIMITS.imageJsonBytes + 1)), /24 MiB/);
});

test('unsupported future formats have an explicit latest-app instruction', () => {
  const document = createDocument({ schemaVersion: 5 });
  const message = '이 파일은 최신 인수인계 A to Z에서 열어 주세요';
  assert.ok(validateDocument(document).errors.some(error => error.includes(message)));
  assert.throws(() => parseImport(JSON.stringify(document)), error =>
    error.message === `${message}. 현재 내용은 바뀌지 않았습니다.`);
});

test('deployed v3 JSON preserves every field and PDF/image byte when opened or copied without page choices', () => {
  const original = reviewExampleDocument();
  assert.equal(original.schemaVersion, 3, 'the existing sample stays an unchanged v3 handoff');
  assert.equal(publicV3Model.validateDocument(original).ok, true);
  const json = publicV3Model.stringifyDocument(original);
  const restored = parseImport(json).document;
  assert.equal(stringifyDocument(restored), json);
  assert.deepEqual(restored, original);
  const copy = importAsCopy(restored);
  assert.equal(copy.schemaVersion, 3);
  assert.equal(publicV3Model.validateDocument(copy).ok, true);
  assert.deepEqual(copy.sourceFiles[0].pdf, original.sourceFiles[0].pdf);
  assert.equal(copy.tasks[0].images[0].data, original.tasks[0].images[0].data);
  assert.deepEqual(copy.cases.map(item => [item.status, item.statusConfirmed]), original.cases.map(item => [item.status, item.statusConfirmed]));
  assert.ok([...copy.tasks, ...copy.cases].every(item => !Object.hasOwn(item, 'sourcePages')));
  assert.equal(stringifyDocument(restored), json);
});

test('explicit v4 task and case page relationships survive JSON and copy with source IDs remapped', () => {
  const document = reviewExampleDocument();
  document.schemaVersion = 4;
  const sourceId = document.sourceFiles[0].id;
  document.tasks[0].sourcePages = [{ sourceId, pages: [1] }];
  document.cases[0].sourcePages = [{ sourceId, pages: [2, 1] }];
  const json = stringifyDocument(document);
  assert.deepEqual(parseImport(json).document, document);
  assert.equal(stringifyDocument(parseImport(json).document), json);
  const copy = importAsCopy(document);
  valid(copy);
  assert.equal(copy.schemaVersion, 4);
  assert.notEqual(copy.sourceFiles[0].id, sourceId);
  assert.deepEqual(copy.tasks[0].sourcePages, [{ sourceId: copy.sourceFiles[0].id, pages: [1] }]);
  assert.deepEqual(copy.cases[0].sourcePages, [{ sourceId: copy.sourceFiles[0].id, pages: [2, 1] }]);
  assert.ok(copy.tasks[0].sourceRefs.includes(copy.tasks[0].sourcePages[0].sourceId));
  assert.equal(Object.hasOwn(copy.tasks[1], 'sourcePages'), false);
  assert.deepEqual(copy.sourceFiles[0].pdf, document.sourceFiles[0].pdf);
  copy.tasks[0].sourcePages[0].pages.push(2);
  assert.deepEqual(document.tasks[0].sourcePages[0].pages, [1]);
  assert.equal(stringifyDocument(document), json, 'copying and editing a copy do not alter the input');
});

test('v4 page relationships reject unlinked, missing, non-PDF, duplicate and out-of-range choices without dropping content', () => {
  const base = reviewExampleDocument();
  base.schemaVersion = 4;
  const sourceId = base.sourceFiles[0].id;
  const invalidRelations = [
    [{ sourceId, pages: [] }],
    [{ sourceId, pages: [0] }],
    [{ sourceId, pages: [3] }],
    [{ sourceId, pages: [1.5] }],
    [{ sourceId, pages: ['1'] }],
    [{ sourceId, pages: [1, 1] }],
    [{ sourceId, pages: [1] }, { sourceId, pages: [2] }],
    [{ sourceId: 'missing-source', pages: [1] }],
    [{ sourceId, pages: [1], guessed: true }],
    [{ sourceId, pages: Array.from({ length: 201 }, (_, index) => index + 1) }],
    null,
  ];
  for (const collection of ['tasks', 'cases']) {
    for (const relation of invalidRelations) {
      const document = structuredClone(base);
      document[collection][0].sourcePages = relation;
      const before = JSON.stringify(document);
      assert.match(validateDocument(document).errors.join('\n'), /sourcePages/);
      assert.throws(() => stringifyDocument(document), /sourcePages/);
      assert.throws(() => parseImport(before), /sourcePages/);
      assert.equal(JSON.stringify(document), before);
    }
    for (const kind of ['unlinked', 'non-PDF']) {
      const document = structuredClone(base);
      document[collection][0].sourcePages = [{ sourceId, pages: [1] }];
      if (kind === 'unlinked') document[collection][0].sourceRefs = [];
      else { delete document.sourceFiles[0].pdf; document.sourceFiles[0].format = 'text'; }
      assert.match(validateDocument(document).errors.join('\n'), /sourcePages/);
    }
  }
});

test('page relationships cannot be mislabeled as legacy v1/v2/v3 files and the deployed v3 reader rejects v4 explicitly', () => {
  for (const version of [1, 2, 3]) {
    const document = version === 3 ? reviewExampleDocument() : legacyDocument(version);
    document.tasks[0].sourcePages = [];
    const before = JSON.stringify(document);
    assert.match(validateDocument(document).errors.join('\n'), /sourcePages.*알 수 없는/);
    assert.throws(() => parseImport(before), /sourcePages/);
    assert.equal(JSON.stringify(document), before);
  }
  const document = reviewExampleDocument();
  document.schemaVersion = 4;
  valid(document);
  assert.equal(publicV3Model.validateDocument(document).ok, false, 'version alone must reject a v4 file');
  assert.throws(() => publicV3Model.parseImport(stringifyDocument(document)), /최신 인수인계 A to Z/);
  document.tasks[0].sourcePages = [{ sourceId: document.sourceFiles[0].id, pages: [1] }];
  assert.throws(() => publicV3Model.parseImport(stringifyDocument(document)), /최신 인수인계 A to Z/);
  for (const [filename, source] of v3Sources) {
    assert.equal(readFileSync(join(snapshotV3, filename), 'utf8'), source);
    assert.equal(statSync(join(snapshotV3, filename)).mode & 0o222, 0);
  }
});
