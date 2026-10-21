// These tests simulate IndexedDB requests, serialized transactions and rollback.
// They verify persistence plumbing, not a real browser's disk durability or tab lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDocument, createTask } from '../src/model.js';
import { encodeBase64 } from '../src/image-data.js';
import { DATA_KEY, LEGACY_DATA_KEY, MIGRATION_KEY, PROGRESS_KEY } from '../src/storage.js';
import {
  openDocumentStore, DATABASE_NAME, DATABASE_VERSION, STORE_NAME, RECORD_KEY, LEGACY_RECORD_KEY,
} from '../src/document-store.js';

function memory(raw = null) {
  const values = new Map(raw === null ? [] : [[LEGACY_DATA_KEY, raw]]);
  return {
    writes: 0,
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { this.writes++; values.set(key, value); },
    removeItem: key => values.delete(key),
  };
}

function namedError(name) {
  return Object.assign(new Error(name), { name });
}

function fakeIndexedDB(initialRecord, previousRecord) {
  const control = {
    record: structuredClone(initialRecord),
    previousRecord: structuredClone(previousRecord), writtenKeys: [],
    openError: null, blocked: false, heldOpen: false,
    failNextRead: null, failAfterRead: null, failNextPut: null,
    holdNextCommit: false, heldCommits: [], beforeCommit: null,
    puts: 0, commits: 0, aborts: 0, closes: 0, connections: [],
  };
  const queue = [];
  let running = false;
  let exists = initialRecord !== undefined || previousRecord !== undefined;
  let storeExists = exists;
  function runNext() {
    if (running || !queue.length) return;
    running = true;
    queue.shift()();
  }
  function makeTransaction() {
    const operations = [];
    let started = false;
    let done = false;
    let staged;
    let stagedPrevious;
    let wrote = false;
    let readFailure;
    let afterReadFailure;
    let putFailure;
    let held;
    const tx = {
      error: null,
      abort() {
        if (done) throw namedError('InvalidStateError');
        done = true;
        control.aborts++;
        queueMicrotask(() => { tx.onabort?.(); running = false; runNext(); });
      },
      objectStore(name) {
        assert.equal(name, STORE_NAME);
        return {
          get(key) {
            assert.ok([RECORD_KEY, LEGACY_RECORD_KEY].includes(key));
            const request = {};
            operations.push(() => {
              if (readFailure) return fail(request, readFailure);
              request.result = structuredClone(key === RECORD_KEY ? staged : stagedPrevious);
              request.onsuccess?.();
              // Both keys form one source snapshot in the v3 transition.
              if (!done && afterReadFailure && key === RECORD_KEY) {
                tx.error = afterReadFailure;
                tx.abort();
              }
            });
            return request;
          },
          put(value, key) {
            assert.equal(key, RECORD_KEY);
            const request = {};
            const copy = structuredClone(value);
            control.puts++;
            control.writtenKeys.push(key);
            operations.push(() => {
              if (putFailure) return fail(request, putFailure);
              staged = copy;
              wrote = true;
              request.result = key;
              request.onsuccess?.();
            });
            return request;
          },
        };
      },
    };
    function fail(request, error) {
      request.error = tx.error = error;
      request.onerror?.();
      tx.onerror?.({ target: request });
      tx.abort();
    }
    function commit() {
      if (done) return;
      control.beforeCommit?.();
      if (done) return;
      if (wrote) control.record = structuredClone(staged);
      done = true;
      control.commits++;
      tx.oncomplete?.();
      running = false;
      runNext();
    }
    function step() {
      if (!started || done) return;
      const operation = operations.shift();
      if (operation) {
        operation();
        if (!done) queueMicrotask(step);
      } else if (held) control.heldCommits.push(commit);
      else commit();
    }
    queue.push(() => {
      staged = structuredClone(control.record);
      stagedPrevious = structuredClone(control.previousRecord);
      readFailure = control.failNextRead;
      afterReadFailure = control.failAfterRead;
      putFailure = control.failNextPut;
      held = control.holdNextCommit;
      control.failNextRead = control.failAfterRead = control.failNextPut = null;
      control.holdNextCommit = false;
      started = true;
      queueMicrotask(step);
    });
    queueMicrotask(runNext);
    return tx;
  }
  const factory = {
    open(name, version) {
      assert.equal(name, DATABASE_NAME);
      assert.equal(version, DATABASE_VERSION);
      const request = {};
      const database = {
        closed: false,
        objectStoreNames: { contains: name => storeExists && name === STORE_NAME },
        createObjectStore(name) { assert.equal(name, STORE_NAME); storeExists = true; },
        close() {
          if (!this.closed) control.closes++;
          this.closed = true;
        },
        transaction(name, mode) {
          assert.equal(name, STORE_NAME);
          assert.ok(['readonly', 'readwrite'].includes(mode));
          if (this.closed) throw namedError('InvalidStateError');
          return makeTransaction();
        },
      };
      control.connections.push(database);
      function succeed() {
        request.result = database;
        if (!exists) {
          let aborted = false;
          request.transaction = { abort() { aborted = true; control.aborts++; } };
          request.onupgradeneeded?.();
          if (aborted) {
            request.error = namedError('AbortError');
            request.onerror?.();
            return;
          }
          exists = true;
        }
        request.onsuccess?.();
      }
      control.releaseOpen = succeed;
      queueMicrotask(() => {
        if (control.openError) {
          request.error = control.openError;
          request.onerror?.();
        } else if (control.blocked) request.onblocked?.();
        else if (!control.heldOpen) succeed();
      });
      return request;
    },
  };
  return { factory, control };
}

const record = (raw, legacyRaw = null) => ({ version: 1, raw, legacyRaw, fallbackRaw: null, previousExists: false, previousRaw: null });
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const photoBytes = new Uint8Array(await readFile(new URL('../fixtures/images/landscape.png', import.meta.url)));
const legacyTask = overrides => { const task = createTask(overrides); delete task.firstAction; return task; };
const photoDocument = () => createDocument({
  schemaVersion: 2, title: '사진과 한글을 함께 보관',
  tasks: [legacyTask({
    title: '화면 확인', method: '첫째 줄\n둘째 줄',
    images: [{
      id: 'stored-photo', section: 'method', caption: '가상 참고 화면',
      mime: 'image/png', width: 480, height: 300, data: encodeBase64(photoBytes),
    }],
  })],
});

test('IndexedDB plumbing: migration preserves exact old text and independent progress', async () => {
  const document = photoDocument();
  const legacyRaw = JSON.stringify([document], null, 2);
  const storage = memory(legacyRaw);
  storage.setItem(PROGRESS_KEY, '{"separate":true}');
  const writesBefore = storage.writes;
  const { factory, control } = fakeIndexedDB();
  const store = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(store.kind, 'indexedDB');
  assert.equal(store.readOnly, false);
  assert.equal(store.raw, legacyRaw);
  assert.deepEqual(store.documents, [document]);
  assert.deepEqual(control.record, record(legacyRaw, legacyRaw));
  assert.equal(control.commits, 1);
  assert.equal(storage.writes, writesBefore);
  assert.equal(storage.getItem(LEGACY_DATA_KEY), legacyRaw);
  assert.equal(storage.getItem(PROGRESS_KEY), '{"separate":true}');
});

test('IndexedDB plumbing: sequential saves, reload and a new connection restore exact image bytes', async () => {
  const storage = memory();
  const { factory, control } = fakeIndexedDB();
  const store = await openDocumentStore({ storage, indexedDB: factory });
  const document = photoDocument();
  const first = await store.save([document], null);
  document.title = '다시 저장한 문서';
  const second = await store.save([document], first);
  assert.notEqual(second, first);
  const mutable = store.documents;
  mutable[0].title = '저장되지 않은 외부 변경';
  assert.equal(store.documents[0].title, document.title);
  assert.deepEqual(await store.reload(), { documents: [document], raw: second });
  store.close();
  assert.equal(control.connections[0].closed, true);
  const reopened = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(reopened.raw, second);
  assert.deepEqual(reopened.documents, [document]);
  assert.equal(reopened.documents[0].tasks[0].images[0].data, encodeBase64(photoBytes));
  assert.equal(storage.getItem(DATA_KEY), null);
});

test('IndexedDB plumbing: save stays pending and keeps prior snapshot until the transaction completes', async () => {
  const storage = memory();
  const { factory, control } = fakeIndexedDB();
  const store = await openDocumentStore({ storage, indexedDB: factory });
  control.holdNextCommit = true;
  let completed = false;
  const document = createDocument();
  const saving = store.save([document], null).then(value => { completed = true; return value; });
  await flush();
  assert.equal(control.heldCommits.length, 1);
  assert.equal(completed, false);
  assert.equal(store.raw, null);
  assert.equal(control.record.raw, null);
  control.heldCommits.shift()();
  const raw = await saving;
  assert.equal(completed, true);
  assert.equal(control.record.raw, raw);
  assert.equal(store.raw, raw);
});

test('IndexedDB plumbing: simultaneous writers serialize compare-and-write and reject the stale writer', async () => {
  const storage = memory();
  const { factory, control } = fakeIndexedDB();
  const first = await openDocumentStore({ storage, indexedDB: factory });
  const second = await openDocumentStore({ storage, indexedDB: factory });
  const firstDocument = createDocument({ title: '첫 번째 창' });
  const secondDocument = createDocument({ title: '두 번째 창' });
  const outcomes = await Promise.allSettled([
    first.save([firstDocument], null), second.save([secondDocument], null),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[1].reason.code, 'STORAGE_CONFLICT');
  assert.equal(second.raw, null, 'a conflict must not change the losing view silently');
  assert.equal(second.readOnly, false);
  assert.equal(control.record.raw, outcomes[0].value);
  assert.deepEqual(await second.reload(), { documents: [firstDocument], raw: outcomes[0].value });
  const next = await second.save([secondDocument], second.raw);
  assert.equal(control.record.raw, next);
});

test('IndexedDB plumbing: migration quota failure preserves readable legacy documents without writing localStorage', async () => {
  const legacyRaw = JSON.stringify([photoDocument()]);
  const storage = memory(legacyRaw);
  const { factory, control } = fakeIndexedDB();
  control.failNextPut = namedError('QuotaExceededError');
  const store = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(store.kind, 'memory');
  assert.equal(store.readOnly, true);
  assert.equal(store.errorCode, 'STORAGE_QUOTA');
  assert.equal(store.raw, legacyRaw);
  assert.deepEqual(store.documents, JSON.parse(legacyRaw));
  assert.equal(control.record, undefined);
  assert.equal(storage.getItem(LEGACY_DATA_KEY), legacyRaw);
  assert.equal(storage.writes, 0);
  await assert.rejects(store.save([]), { code: 'STORAGE_QUOTA' });
  assert.equal(storage.writes, 0);
});

test('IndexedDB plumbing: quota and abort rollback retain previous IDB data and permit a later retry', async () => {
  const storage = memory();
  const { factory, control } = fakeIndexedDB();
  const store = await openDocumentStore({ storage, indexedDB: factory });
  const original = createDocument({ title: '저장 완료 원본' });
  const previousRaw = await store.save([original], null);
  const next = createDocument({ title: '실패한 변경' });
  for (const name of ['QuotaExceededError', 'AbortError']) {
    control.failNextPut = namedError(name);
    await assert.rejects(store.save([next], previousRaw));
    assert.equal(store.raw, previousRaw);
    assert.deepEqual(store.documents, [original]);
    assert.equal(control.record.raw, previousRaw);
    assert.equal(store.kind, 'indexedDB');
    assert.equal(store.readOnly, false);
  }
  const nextRaw = await store.save([next], previousRaw);
  assert.equal(control.record.raw, nextRaw);
  assert.equal(store.warning, '');
  assert.equal(storage.writes, 0);
});

test('IndexedDB plumbing: a transaction failing after a valid IDB read retains that newer snapshot', async () => {
  const oldDocument = createDocument({ title: '이전 localStorage' });
  const newDocument = createDocument({ title: '더 최근 IndexedDB' });
  const legacyRaw = JSON.stringify([oldDocument]);
  const currentRaw = JSON.stringify([newDocument]);
  const storage = memory(legacyRaw);
  const { factory, control } = fakeIndexedDB(record(currentRaw, legacyRaw));
  control.failAfterRead = namedError('AbortError');
  const store = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(store.kind, 'memory');
  assert.equal(store.raw, currentRaw);
  assert.deepEqual(store.documents, [newDocument]);
  assert.equal(control.record.raw, currentRaw);
  assert.deepEqual(new Map(store.recoveryRecords.map(item => [item.source, item.raw])),
    new Map([['localStorage', legacyRaw], ['indexedDB', currentRaw]]));
});

test('IndexedDB plumbing: changed legacy source on reopen exposes both originals and blocks writes', async () => {
  const original = JSON.stringify([createDocument({ title: '이관할 원본' })]);
  const storage = memory(original);
  const { factory, control } = fakeIndexedDB();
  const first = await openDocumentStore({ storage, indexedDB: factory });
  const newest = await first.save([createDocument({ title: '새 저장소 최신 내용' })], original);
  first.close();
  const changed = JSON.stringify([createDocument({ title: '구버전 창에서 편집' })]);
  storage.setItem(LEGACY_DATA_KEY, changed);
  const reopened = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(reopened.kind, 'memory');
  assert.equal(reopened.errorCode, 'STORAGE_LEGACY_CHANGED');
  assert.equal(reopened.raw, newest);
  await assert.rejects(reopened.save([]), { code: 'STORAGE_LEGACY_CHANGED' });
  assert.equal(control.record.raw, newest);
  assert.equal(storage.getItem(LEGACY_DATA_KEY), changed);
  assert.deepEqual(new Map(reopened.recoveryRecords.map(item => [item.source, item.raw])),
    new Map([['localStorage', changed], ['indexedDB', newest]]));
});

test('IndexedDB plumbing: an old-version edit during an open session prevents overwriting either source', async () => {
  const original = JSON.stringify([createDocument()]);
  const storage = memory(original);
  const { factory, control } = fakeIndexedDB();
  const store = await openDocumentStore({ storage, indexedDB: factory });
  const changed = JSON.stringify([createDocument({ title: '구버전의 동시 변경' })]);
  storage.setItem(LEGACY_DATA_KEY, changed);
  await assert.rejects(store.save([createDocument()], original), { code: 'STORAGE_LEGACY_CHANGED' });
  assert.equal(control.record.raw, original);
  assert.equal(storage.getItem(LEGACY_DATA_KEY), changed);
  assert.equal(store.readOnly, true);
});

test('IndexedDB plumbing: legacy changes between request and migration commit are reported after commit', async () => {
  const original = JSON.stringify([createDocument({ title: '처음 읽은 원본' })]);
  const changed = JSON.stringify([createDocument({ title: '이관 도중 변경된 원본' })]);
  const storage = memory(original);
  const { factory, control } = fakeIndexedDB();
  control.beforeCommit = () => { storage.setItem(LEGACY_DATA_KEY, changed); };
  const store = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(store.errorCode, 'STORAGE_LEGACY_CHANGED');
  assert.equal(store.readOnly, true);
  assert.equal(control.record.raw, original);
  assert.equal(control.record.legacyRaw, original);
  assert.equal(storage.getItem(LEGACY_DATA_KEY), changed);
});

test('IndexedDB plumbing: absent IndexedDB allows an explicit legacy fallback with conflict and quota checks', async () => {
  const storage = memory();
  const store = await openDocumentStore({ storage, indexedDB: null });
  assert.equal(store.kind, 'localStorage');
  assert.match(store.warning, /IndexedDB/);
  const document = photoDocument();
  const raw = await store.save([document], null);
  assert.equal(storage.getItem(DATA_KEY), raw);
  assert.deepEqual(await store.reload(), { raw, documents: [document] });
  await assert.rejects(store.save([], null), { code: 'STORAGE_CONFLICT' });
  storage.setItem = () => { throw namedError('QuotaExceededError'); };
  await assert.rejects(store.save([], raw), { code: 'STORAGE_QUOTA' });
  assert.equal(store.raw, raw);
  assert.equal(storage.getItem(DATA_KEY), raw);
});

test('IndexedDB plumbing: present but denied or broken IndexedDB never falls back to localStorage writes', async () => {
  const raw = JSON.stringify([createDocument()]);
  for (const factory of [
    { open() { throw namedError('SecurityError'); } },
    {},
  ]) {
    const storage = memory(raw);
    const store = await openDocumentStore({ storage, indexedDB: factory });
    assert.equal(store.kind, 'memory');
    assert.equal(store.readOnly, true);
    assert.equal(store.raw, raw);
    await assert.rejects(store.save([]));
    assert.equal(storage.writes, 0);
  }
  const { factory, control } = fakeIndexedDB();
  control.openError = namedError('VersionError');
  const store = await openDocumentStore({ storage: memory(raw), indexedDB: factory });
  assert.equal(store.kind, 'memory');
  assert.equal(store.raw, raw);
});

test('IndexedDB plumbing: malformed legacy documents remain recoverable and are never migrated', async () => {
  for (const raw of ['{broken', JSON.stringify([createDocument(), { schemaVersion: 99 }])]) {
    const storage = memory(raw);
    const { factory, control } = fakeIndexedDB();
    const store = await openDocumentStore({ storage, indexedDB: factory });
    assert.equal(store.errorCode, 'STORAGE_INVALID');
    assert.equal(store.readOnly, true);
    assert.equal(store.raw, raw);
    assert.equal(control.record, undefined);
    assert.equal(control.puts, 0);
    assert.equal(store.recoveryRecords.find(item => item.source === 'localStorage').raw, raw);
  }
});

test('IndexedDB plumbing: malformed IDB records remain recoverable and are never overwritten with legacy data', async () => {
  const legacyRaw = JSON.stringify([createDocument()]);
  const storage = memory(legacyRaw);
  const { factory, control } = fakeIndexedDB(record('{broken', legacyRaw));
  const store = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(store.errorCode, 'STORAGE_INVALID');
  assert.equal(store.readOnly, true);
  assert.equal(control.record.raw, '{broken');
  assert.equal(control.puts, 0);
  assert.equal(store.recoveryRecords.find(item => item.source === 'indexedDB').raw, '{broken');
  assert.deepEqual(store.documents, JSON.parse(legacyRaw));
});

test('IndexedDB plumbing: duplicate IDs and invalid drafts cannot replace the prior snapshot', async () => {
  const storage = memory();
  const { factory, control } = fakeIndexedDB();
  const store = await openDocumentStore({ storage, indexedDB: factory });
  const document = createDocument();
  const raw = await store.save([document], null);
  const putsBefore = control.puts;
  await assert.rejects(store.save([document, document], raw), { code: 'STORAGE_INVALID' });
  await assert.rejects(store.save([{ ...document, schemaVersion: 99 }], raw));
  const accessor = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { throw new Error('must not run'); } });
  await assert.rejects(store.save(accessor, raw), { code: 'STORAGE_INVALID' });
  assert.equal(control.puts, putsBefore);
  assert.equal(control.record.raw, raw);
});

test('IndexedDB plumbing: aggregate UTF-8 budget rejects before assembling the whole document array', async t => {
  const storage = memory();
  const { factory, control } = fakeIndexedDB();
  const store = await openDocumentStore({ storage, indexedDB: factory });
  const prior = await store.save([createDocument({ title: '보존할 원본' })], null);
  // Each document is below v2's 24 MiB limit. Their combined UTF-8 bytes exceed
  // 64 MiB, while their total JavaScript string length remains below that limit.
  const text = '가'.repeat(200_000);
  const documents = Array.from({ length: 4 }, () => createDocument({
    schemaVersion: 2,
    tasks: Array.from({ length: 32 }, () => legacyTask({ method: text })),
  }));
  const untouched = createDocument({ schemaVersion: 99 });
  documents.push(untouched);
  const stringify = JSON.stringify;
  let wholeArrayAttempted = false;
  let laterDocumentVisited = false;
  t.mock.method(JSON, 'stringify', function(value, ...args) {
    if (value === documents) {
      wholeArrayAttempted = true;
      throw new Error('The oversized document array must not be assembled');
    }
    if (value === untouched) laterDocumentVisited = true;
    return stringify.call(this, value, ...args);
  });
  const putsBefore = control.puts;
  await assert.rejects(store.save(documents, prior), { code: 'STORAGE_LIMIT' });
  assert.equal(wholeArrayAttempted, false);
  assert.equal(laterDocumentVisited, false);
  assert.equal(control.puts, putsBefore);
  assert.equal(store.raw, prior);
  assert.equal(control.record.raw, prior);
});

test('IndexedDB plumbing: version-change closes the connection and preserves a recoverable readonly view', async () => {
  const raw = JSON.stringify([photoDocument()]);
  const { factory, control } = fakeIndexedDB(record(raw));
  const store = await openDocumentStore({ storage: memory(), indexedDB: factory });
  control.connections[0].onversionchange();
  assert.equal(control.connections[0].closed, true);
  assert.equal(store.kind, 'memory');
  assert.equal(store.errorCode, 'STORAGE_VERSION_CHANGED');
  assert.equal(store.raw, raw);
  await assert.rejects(store.save([]), { code: 'STORAGE_VERSION_CHANGED' });
});

test('IndexedDB plumbing: version change while committing keeps the readonly warning and latest committed recovery data', async () => {
  const { factory, control } = fakeIndexedDB();
  const store = await openDocumentStore({ storage: memory(), indexedDB: factory });
  const document = createDocument({ title: '닫히는 동안 완료된 트랜잭션' });
  control.holdNextCommit = true;
  const saving = store.save([document], null);
  const rejected = assert.rejects(saving, { code: 'STORAGE_VERSION_CHANGED' });
  await flush();
  control.connections[0].onversionchange();
  control.heldCommits.shift()();
  await rejected;
  assert.equal(store.kind, 'memory');
  assert.equal(store.readOnly, true);
  assert.equal(store.errorCode, 'STORAGE_VERSION_CHANGED');
  assert.match(store.warning, /버전이 변경/);
  assert.deepEqual(store.documents, [document]);
  assert.equal(store.raw, control.record.raw);
});

test('IndexedDB plumbing: blocked open times out and closes a late successful connection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const raw = JSON.stringify([createDocument()]);
  const { factory, control } = fakeIndexedDB(record(raw));
  control.blocked = true;
  const opening = openDocumentStore({ storage: memory(), indexedDB: factory, timeoutMs: 50 });
  await flush();
  t.mock.timers.tick(51);
  const store = await opening;
  assert.equal(store.errorCode, 'STORAGE_BLOCKED');
  assert.equal(store.readOnly, true);
  control.releaseOpen();
  assert.equal(control.connections[0].closed, true);
  assert.equal(control.puts, 0);
});

test('IndexedDB plumbing: late upgrade after an open timeout is aborted and closed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const storage = memory(JSON.stringify([createDocument()]));
  const { factory, control } = fakeIndexedDB();
  control.heldOpen = true;
  const opening = openDocumentStore({ storage, indexedDB: factory, timeoutMs: 50 });
  await flush();
  t.mock.timers.tick(51);
  const store = await opening;
  assert.equal(store.errorCode, 'STORAGE_TIMEOUT');
  control.releaseOpen();
  assert.equal(control.connections[0].closed, true);
  assert.equal(control.aborts, 1);
  assert.equal(control.record, undefined);
});

test('IndexedDB plumbing: transaction timeout aborts uncommitted data and never reports a successful save', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { factory, control } = fakeIndexedDB();
  const store = await openDocumentStore({ storage: memory(), indexedDB: factory, timeoutMs: 50 });
  control.holdNextCommit = true;
  const saving = store.save([createDocument()], null);
  const rejected = assert.rejects(saving, { code: 'STORAGE_TIMEOUT' });
  await flush();
  t.mock.timers.tick(51);
  await rejected;
  control.heldCommits.shift()();
  assert.equal(control.record.raw, null);
  assert.equal(store.raw, null);
  assert.equal(store.readOnly, true);
});

test('IndexedDB plumbing: failed reload after reading retains latest IDB documents for recovery', async () => {
  const { factory, control } = fakeIndexedDB();
  const store = await openDocumentStore({ storage: memory(), indexedDB: factory });
  const newer = createDocument({ title: '다른 창의 최신 저장' });
  const currentRaw = JSON.stringify([newer]);
  control.record = record(currentRaw);
  control.failAfterRead = namedError('AbortError');
  await assert.rejects(store.reload());
  assert.equal(store.kind, 'memory');
  assert.equal(store.raw, currentRaw);
  assert.deepEqual(store.documents, [newer]);
});

test('IndexedDB plumbing: unavailable legacy access still exposes readable current IDB documents', async () => {
  const document = createDocument({ title: '읽을 수 있는 최신 문서' });
  const raw = JSON.stringify([document]);
  const storage = { getItem() { throw namedError('SecurityError'); } };
  const { factory, control } = fakeIndexedDB(record(raw));
  const store = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(store.errorCode, 'STORAGE_LEGACY_UNAVAILABLE');
  assert.equal(store.raw, raw);
  assert.deepEqual(store.documents, [document]);
  assert.equal(store.readOnly, true);
  assert.equal(control.record.raw, raw);
});

test('v3 transition copies the latest old IDB text exactly and leaves rollback records untouched', async () => {
  const first = createDocument({ schemaVersion: 1, title: '이전 v1', tasks: [legacyTask({ method: '보존할 줄\n두 번째 줄' })] });
  const second = photoDocument();
  const legacyRaw = JSON.stringify([first]);
  first.title = 'old IDB에서 더 최근에 고침';
  const latest = JSON.stringify([first, second], null, 2);
  const oldRecord = { version: 1, raw: latest, legacyRaw };
  const storage = memory(legacyRaw);
  const { factory, control } = fakeIndexedDB(undefined, oldRecord);
  const store = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(store.readOnly, false);
  assert.equal(store.raw, latest);
  assert.deepEqual(store.documents.map(doc => doc.schemaVersion), [1, 2]);
  assert.deepEqual(control.previousRecord, oldRecord);
  assert.equal(control.record.raw, latest);
  assert.equal(control.record.previousRaw, latest);
  assert.equal(control.record.previousExists, true);
  assert.deepEqual(control.writtenKeys, [RECORD_KEY]);
  assert.equal(storage.getItem(LEGACY_DATA_KEY), legacyRaw);
  assert.equal(storage.getItem(DATA_KEY), null);
  const documents = store.documents;
  documents.push(createDocument({ title: '새 v3에서만 작성', tasks: [createTask({ firstAction: '확인된 첫 행동' })] }));
  const newRaw = await store.save(documents, store.raw);
  assert.deepEqual(control.previousRecord, oldRecord, 'rolling back still sees exact old current');
  assert.equal(storage.getItem(LEGACY_DATA_KEY), legacyRaw);
  assert.equal(control.record.raw, newRaw);
  assert.equal(JSON.parse(newRaw).at(-1).schemaVersion, 3);
  const reopened = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(reopened.raw, newRaw);
  assert.deepEqual(reopened.documents, documents);
});

test('old IDB edits during a v3 session or rollback cannot overwrite the v3 snapshot', async () => {
  const original = JSON.stringify([createDocument({ schemaVersion: 1, title: '기존 원본' })]);
  const oldRecord = { version: 1, raw: original, legacyRaw: null };
  const { factory, control } = fakeIndexedDB(undefined, oldRecord);
  const storage = memory();
  const store = await openDocumentStore({ storage, indexedDB: factory });
  const newRaw = await store.save([createDocument({ title: 'v3에서 새로 작업함' })], original);
  const changed = JSON.stringify([createDocument({ schemaVersion: 1, title: '구버전에서 작업함' })]);
  control.previousRecord = { ...oldRecord, raw: changed };
  await assert.rejects(store.save([], newRaw), { code: 'STORAGE_LEGACY_CHANGED' });
  assert.equal(store.readOnly, true);
  assert.equal(control.record.raw, newRaw);
  assert.equal(control.previousRecord.raw, changed);
  const reopened = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(reopened.errorCode, 'STORAGE_LEGACY_CHANGED');
  assert.equal(reopened.raw, newRaw);
  assert.equal(reopened.documents[0].title, 'v3에서 새로 작업함');
  assert.equal(reopened.recoveryRecords.find(item => item.source === 'indexedDB-previous').raw, changed);
  assert.equal(reopened.recoveryRecords.find(item => item.source === 'indexedDB').raw, newRaw);
});

test('v3 fallback preserves the old key and detects an old-version edit across a restart', async () => {
  const original = JSON.stringify([createDocument({ schemaVersion: 1, title: '이전 원본' })], null, 2);
  const storage = memory(original);
  const store = await openDocumentStore({ storage, indexedDB: null });
  assert.equal(store.raw, original);
  assert.equal(storage.getItem(DATA_KEY), null);
  const newRaw = await store.save([createDocument({ title: '새 내용' })], original);
  assert.equal(storage.getItem(LEGACY_DATA_KEY), original);
  assert.equal(storage.getItem(DATA_KEY), newRaw);
  assert.match(JSON.parse(storage.getItem(MIGRATION_KEY)).legacyHash, /^[a-f0-9]{64}$/);
  const reopened = await openDocumentStore({ storage, indexedDB: null });
  assert.equal(reopened.readOnly, false);
  assert.equal(reopened.raw, newRaw);
  storage.setItem(LEGACY_DATA_KEY, JSON.stringify([createDocument({ schemaVersion: 1, title: '구버전 수정' })]));
  const conflict = await openDocumentStore({ storage, indexedDB: null });
  assert.equal(conflict.errorCode, 'STORAGE_LEGACY_CHANGED');
  assert.equal(conflict.documents[0].title, '새 내용');
  await assert.rejects(conflict.save([]));
  assert.equal(storage.getItem(DATA_KEY), newRaw);
});

test('fallback quota during first data write preserves old data and cannot claim migration succeeded', async () => {
  const original = JSON.stringify([createDocument({ schemaVersion: 1, title: '반드시 보존' })]);
  const storage = memory(original), write = storage.setItem.bind(storage);
  const store = await openDocumentStore({ storage, indexedDB: null });
  storage.setItem = (key, value) => { if (key === DATA_KEY) throw namedError('QuotaExceededError'); write(key, value); };
  await assert.rejects(store.save([createDocument()], original), { code: 'STORAGE_QUOTA' });
  assert.equal(storage.getItem(LEGACY_DATA_KEY), original);
  assert.equal(storage.getItem(DATA_KEY), null);
  assert.equal(store.raw, original);
  assert.ok(storage.getItem(MIGRATION_KEY), 'a prepared small metadata record is harmless without v3 data');
  const reopened = await openDocumentStore({ storage, indexedDB: null });
  assert.equal(reopened.raw, original);
  assert.equal(reopened.readOnly, false);
});

test('a corrupt old IDB record is recoverable and never creates or replaces the v3 record', async () => {
  const storage = memory(JSON.stringify([createDocument({ schemaVersion: 1 })]));
  const oldRecord = { version: 1, raw: '{broken', legacyRaw: storage.getItem(LEGACY_DATA_KEY) };
  const { factory, control } = fakeIndexedDB(undefined, oldRecord);
  const store = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(store.errorCode, 'STORAGE_INVALID');
  assert.equal(control.record, undefined);
  assert.deepEqual(control.previousRecord, oldRecord);
  assert.equal(control.puts, 0);
  assert.equal(store.recoveryRecords.find(item => item.source === 'indexedDB-previous').raw, '{broken');
});

test('different new fallback and newer old IDB histories stop instead of guessing a winner', async () => {
  const initial = JSON.stringify([createDocument({ schemaVersion: 1, title: '처음' })]);
  const oldRaw = JSON.stringify([createDocument({ schemaVersion: 1, title: '구 IDB의 작업' })]);
  const newRaw = JSON.stringify([createDocument({ title: '새 간이 저장소의 작업' })]);
  const storage = memory(initial); storage.setItem(DATA_KEY, newRaw);
  const previous = { version: 1, raw: oldRaw, legacyRaw: initial };
  const { factory, control } = fakeIndexedDB(undefined, previous);
  const store = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(store.errorCode, 'STORAGE_LEGACY_CHANGED');
  assert.equal(control.record, undefined);
  assert.deepEqual(control.previousRecord, previous);
  assert.equal(storage.getItem(DATA_KEY), newRaw);
  assert.equal(storage.getItem(LEGACY_DATA_KEY), initial);
  assert.equal(control.puts, 0);
});

test('direct v3 fallback seeding and later IDB migration preserve data and guard subsequent fallback edits', async () => {
  const newRaw = JSON.stringify([createDocument({ title: 'v3 간이 저장' })], null, 2);
  const storage = memory(); storage.setItem(DATA_KEY, newRaw);
  const { factory, control } = fakeIndexedDB();
  const store = await openDocumentStore({ storage, indexedDB: factory });
  assert.equal(store.readOnly, false);
  assert.equal(store.raw, newRaw);
  assert.equal(control.record.fallbackRaw, newRaw);
  assert.equal(storage.getItem(DATA_KEY), newRaw);
  storage.setItem(DATA_KEY, JSON.stringify([createDocument({ title: '다른 창의 간이 저장' })]));
  await assert.rejects(store.save([], store.raw), { code: 'STORAGE_LEGACY_CHANGED' });
  assert.equal(control.record.raw, newRaw);
});

test('simply opening the old app may create an unchanged old record without locking v3 editing', async () => {
  for (const original of [null, JSON.stringify([createDocument({ schemaVersion: 1, title: '이전 원본' })])]) {
    const storage = memory(original);
    const { factory, control } = fakeIndexedDB();
    const store = await openDocumentStore({ storage, indexedDB: factory });
    const newRaw = await store.save([createDocument({ title: '새 버전의 작업' })], original);
    control.previousRecord = { version: 1, raw: original, legacyRaw: original };
    const reopened = await openDocumentStore({ storage, indexedDB: factory });
    assert.equal(reopened.readOnly, false);
    assert.equal(reopened.raw, newRaw);
    await reopened.save(reopened.documents, newRaw);
    control.previousRecord.raw = JSON.stringify([createDocument({ schemaVersion: 1, title: '실제 구버전 수정' })]);
    await assert.rejects(reopened.save([], reopened.raw), { code: 'STORAGE_LEGACY_CHANGED' });
    assert.equal(control.record.raw, newRaw);
  }
});
