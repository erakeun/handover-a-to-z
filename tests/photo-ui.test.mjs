import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { createDocument, createTask, makeId, parseImport, stringifyDocument } from '../src/model.js';
import { DATA_KEY, CURRENT_KEY, PROGRESS_KEY, loadDocuments } from '../src/storage.js';
import { IMAGE_LIMITS } from '../src/image-data.js';

// DOM integration only: local browser codecs/canvas are represented by explicit
// stubs with a real synthetic PNG payload. These checks do not open a browser,
// select a real OS file, use the system clipboard, download, or visually print.
const png = new Uint8Array(await readFile(new URL('../fixtures/images/landscape.png', import.meta.url)));
const savedGlobals = new Map();
const timers = [];
const windows = [];
const originalSetTimeout = globalThis.setTimeout;
const originalCreateURL = URL.createObjectURL;
const originalRevokeURL = URL.revokeObjectURL;
let ui, sequence = 0;
let downloads = [], requests = [], decoded = 0, closed = 0;

function setGlobal(key, value) {
  if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
async function settle() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
}
async function mount(snapshot = {}, { failWrites } = {}) {
  ui = new Window({ url: 'https://handover-photo-dom-test.invalid/' });
  windows.push(ui);
  ui.document.body.innerHTML = '<div id="app"></div><div id="notice" role="status" hidden></div><div id="modal-root"></div>';
  for (const [key, value] of Object.entries(snapshot)) ui.localStorage.setItem(key, value);
  if (failWrites) {
    const backing = ui.localStorage;
    // Happy DOM binds/caches Storage methods. Wrap the storage boundary before
    // the app captures it, instead of assigning a property on its Storage proxy.
    Object.defineProperty(ui, 'localStorage', { configurable: true, value: {
      getItem: key => backing.getItem(key),
      setItem(key, value) {
        if (key === DATA_KEY && failWrites()) {
          const error = new Error('Quota exceeded (simulated)'); error.name = 'QuotaExceededError'; throw error;
        }
        backing.setItem(key, value);
      },
      removeItem: key => backing.removeItem(key),
      key: index => backing.key(index),
      get length() { return backing.length; },
    } });
  }
  for (const key of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'Event', 'KeyboardEvent']) {
    setGlobal(key, key === 'window' ? ui : key === 'document' ? ui.document : ui[key]);
  }
  setGlobal('setTimeout', (...args) => {
    const timer = originalSetTimeout(...args); timer.unref?.(); timers.push(timer); return timer;
  });
  const rejectNetwork = (...args) => { requests.push(String(args[0])); throw new Error('Network forbidden in photo DOM tests'); };
  setGlobal('fetch', rejectNetwork); ui.fetch = rejectNetwork;
  setGlobal('createImageBitmap', async blob => {
    const data = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    decoded++;
    return { width: view.getUint32(16), height: view.getUint32(20), close() { closed++; } };
  });
  ui.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, fillRect() {} });
  ui.HTMLCanvasElement.prototype.toBlob = function (callback, mime) {
    assert.equal(this.width, 480); assert.equal(this.height, 300);
    assert.equal(mime, 'image/png');
    callback(new Blob([png], { type: mime }));
  };
  URL.createObjectURL = blob => {
    const url = `blob:handover-photo-test-${downloads.length}`;
    downloads.push({ url, blob }); return url;
  };
  URL.revokeObjectURL = () => {};
  ui.HTMLAnchorElement.prototype.click = function () {
    const download = downloads.findLast(item => item.url === this.href);
    if (download) download.name = this.download;
  };
  await import(`../src/app.js?photo-ui-test=${++sequence}`);
  await settle();
  return ui;
}
afterEach(async () => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  for (const window of windows.splice(0)) await window.happyDOM.close();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  savedGlobals.clear();
  URL.createObjectURL = originalCreateURL; URL.revokeObjectURL = originalRevokeURL;
  assert.deepEqual(requests, [], 'image UI makes no network requests');
  assert.equal(decoded, closed, 'every mocked decoded bitmap is released');
  downloads = []; requests = []; decoded = 0; closed = 0;
});

function button(text, root = ui.document) {
  const matches = [...root.querySelectorAll('button')].filter(node => node.textContent.trim() === text);
  assert.equal(matches.length, 1, `one "${text}" button`);
  return matches[0];
}
async function reveal(node) {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  await settle();
}
async function click(target, root = ui.document) {
  if (typeof target === 'string') target = button(target, root);
  assert.ok(target);
  assert.equal(target.disabled, false);
  await reveal(target); target.focus(); target.click(); await settle();
}
function control(text, root = ui.document) {
  const labels = [...root.querySelectorAll('label')].filter(node => node.textContent.trim() === text);
  assert.equal(labels.length, 1, `one "${text}" control`);
  return labels[0].htmlFor ? ui.document.getElementById(labels[0].htmlFor) : labels[0].querySelector('input');
}
async function fill(text, value, root = ui.document) {
  const input = control(text, root); await reveal(input); input.value = value;
  input.dispatchEvent(new ui.Event('input', { bubbles: true })); await settle();
}
const latestDialog = () => [...ui.document.querySelectorAll('dialog')].at(-1);
const photoArea = section => ui.document.querySelector(`[data-photo-section="${section}"]`);
function localDoc() {
  const doc = loadDocuments(ui.localStorage).find(d => d.id === ui.localStorage.getItem(CURRENT_KEY));
  assert.ok(doc); return doc;
}
function snapshot() {
  return Object.fromEntries(Array.from({ length: ui.localStorage.length }, (_, i) => {
    const key = ui.localStorage.key(i); return [key, ui.localStorage.getItem(key)];
  }));
}
function file(bytes = png, type = 'image/png', name = 'synthetic.png') {
  return { name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
}
async function chooseFile(input, value) {
  Object.defineProperty(input, 'files', { value: [value], configurable: true });
  input.dispatchEvent(new ui.Event('change', { bubbles: true })); await settle();
}
async function startNew() {
  const target = [...ui.document.querySelectorAll('.start-card')].find(n => n.querySelector('strong')?.textContent === '인수인계서 만들기');
  await click(target);
}
async function addPhoto(section = 'method', caption = '') {
  await chooseFile(photoArea(section).querySelector('input[type=file]'), file());
  assert.match(latestDialog().textContent, /사진을 확인해 주세요/);
  if (caption) await fill('짧은 설명 (선택)', caption, latestDialog());
  await click('사진 추가', latestDialog());
}
function documentWithImage() {
  return createDocument({ schemaVersion: 3, title: '사진 검증 문서', tasks: [createTask({
    title: '가상 화면 확인', method: '첫 줄\n둘째 줄', steps: '1. 화면 확인\n2. 저장',
    images: [{ id: makeId(), section: 'method', caption: '조회 버튼 위치', mime: 'image/png', width: 480, height: 300, data: Buffer.from(png).toString('base64') }],
  })] });
}
async function openExisting(doc, extraSnapshot = {}) {
  await mount({ ...extraSnapshot, [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('이어서 작성');
  if (doc.tasks.length) await click(ui.document.querySelector('.map-task'));
}

test('photo UI: first photo creates a task only after confirmation, stores bytes and survives reload', async () => {
  await mount(); await startNew();
  await chooseFile(photoArea('method').querySelector('input[type=file]'), file());
  assert.equal(localDoc().tasks.length, 0);
  await click('취소', latestDialog());
  assert.equal(localDoc().schemaVersion, 3);
  assert.equal(localDoc().tasks.length, 0);
  await addPhoto('method', '사진 설명 — 가상 조회 화면');
  const before = localDoc();
  assert.equal(before.schemaVersion, 3);
  assert.equal(before.tasks.length, 1);
  assert.equal(before.tasks[0].images.length, 1);
  assert.equal(before.tasks[0].images[0].caption, '사진 설명 — 가상 조회 화면');
  assert.equal(before.tasks[0].images[0].data, Buffer.from(png).toString('base64'));
  assert.match(ui.document.querySelector('[data-save-status]').textContent, /임시저장됨/);
  await mount(snapshot()); await click('이어서 작성');
  await click(ui.document.querySelector('.map-task'));
  assert.deepEqual(localDoc(), before);
  assert.equal(photoArea('method').querySelectorAll('.photo-edit-item').length, 1);
  await fill('사진 설명 (선택)', '바꾼 설명 <script>실행 안 됨</script>', photoArea('method'));
  assert.equal(localDoc().tasks[0].images[0].caption, '바꾼 설명 <script>실행 안 됨</script>');
  assert.equal(ui.document.querySelectorAll('script').length, 0);
});

test('photo UI: simulated image paste/drop attach to the chosen section; ordinary text paste is untouched', async () => {
  await openExisting(createDocument({ tasks: [createTask({ title: '가상 업무', method: '원문\t표\n보존' })] }));
  const textarea = photoArea('method').querySelector('textarea');
  const plain = new ui.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(plain, 'clipboardData', { value: { items: [{ kind: 'string', type: 'text/plain' }] } });
  textarea.dispatchEvent(plain);
  assert.equal(plain.defaultPrevented, false);
  const paste = new ui.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file() }] } });
  textarea.dispatchEvent(paste); await settle();
  assert.equal(paste.defaultPrevented, true);
  await click('사진 추가', latestDialog());
  const section = photoArea('steps'); await reveal(section);
  const over = new ui.Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(over, 'dataTransfer', { value: { types: ['Files'] } });
  section.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  const drop = new ui.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file()] } });
  section.dispatchEvent(drop); await settle();
  assert.equal(drop.defaultPrevented, true);
  await fill('짧은 설명 (선택)', '2단계 — 저장 버튼', latestDialog());
  await click('사진 추가', latestDialog());
  assert.equal(localDoc().tasks[0].method, '원문\t표\n보존');
  assert.deepEqual(localDoc().tasks[0].images.map(i => i.section), ['method', 'steps']);
});

test('photo UI: JSON download and new-copy import preserve image bytes while progress stays separate', async () => {
  const original = documentWithImage();
  const progress = JSON.stringify({ [original.id]: {
    [`${original.tasks[0].id}@manual`]: { checked: true, at: '2026-10-20T12:00:00.000Z' },
  } });
  await openExisting(original, { [PROGRESS_KEY]: progress });
  await click('인수자 보기');
  await click(ui.document.querySelector('.map-task'));
  assert.equal([...latestDialog().querySelectorAll('label')].some(label => label.textContent.includes('이번 수행 완료')), false,
    'reading a task cannot mark the entire recurring task complete');
  const before = ui.localStorage.getItem(DATA_KEY);
  assert.equal(ui.localStorage.getItem(PROGRESS_KEY), progress, 'legacy personal progress remains intact');
  await click('목록으로 돌아가기', latestDialog().querySelector('.modal-actions'));
  await click('파일로 저장');
  const received = downloads.findLast(item => item.name?.endsWith('.json'));
  assert.ok(received);
  const text = await received.blob.text();
  assert.deepEqual(parseImport(text).document, original);
  assert.equal(text.includes('handover-progress'), false);
  assert.equal(ui.localStorage.getItem(PROGRESS_KEY), progress, 'JSON export does not consume or rewrite private progress');
  // A fresh recipient receives only the explicit JSON, not the sender's store.
  await mount();
  const open = [...ui.document.querySelectorAll('.start-card')].find(n => n.querySelector('strong')?.textContent === '받은 인수인계서 보기');
  await click(open);
  await chooseFile(control('받은 파일 선택', latestDialog()), { name: 'received.json', size: Buffer.byteLength(text), text: async () => text });
  assert.match(latestDialog().textContent, /사진 1장/);
  await click('이 인수인계서 보기', latestDialog());
  const copy = localDoc();
  assert.notEqual(copy.id, original.id);
  assert.notEqual(copy.tasks[0].id, original.tasks[0].id);
  assert.notEqual(copy.tasks[0].images[0].id, original.tasks[0].images[0].id);
  const { id: oldId, ...oldPhoto } = original.tasks[0].images[0];
  const { id: newId, ...newPhoto } = copy.tasks[0].images[0];
  assert.deepEqual(newPhoto, oldPhoto);
  assert.equal(ui.localStorage.getItem(PROGRESS_KEY), null);
  assert.ok(before.includes(original.tasks[0].images[0].data));
});

test('photo UI: duplicate image IDs are renewed and deletion needs explicit confirmation', async () => {
  await openExisting(documentWithImage());
  const originalPhoto = localDoc().tasks[0].images[0];
  await click('복제');
  const docs = localDoc();
  assert.equal(docs.tasks.length, 2);
  assert.notEqual(docs.tasks[1].images[0].id, originalPhoto.id);
  assert.equal(docs.tasks[1].images[0].data, originalPhoto.data);
  await click('사진 삭제');
  await click('취소', latestDialog());
  assert.equal(localDoc().tasks[1].images.length, 1);
  await click('사진 삭제');
  await click('확인', latestDialog());
  assert.equal(localDoc().tasks[1].images.length, 0);
  assert.deepEqual(localDoc().tasks[0].images[0], originalPhoto);
});

test('photo UI: reader thumbnail enlarges in a nested dialog and print includes image and caption', async () => {
  await openExisting(documentWithImage());
  await click('인수자 보기');
  await click(ui.document.querySelector('.map-task'));
  const parent = latestDialog();
  const thumbnail = parent.querySelector('.photo-thumb');
  assert.ok(thumbnail);
  await click(thumbnail);
  assert.equal(ui.document.querySelectorAll('dialog').length, 2);
  const enlarged = latestDialog();
  assert.match(enlarged.textContent, /가상 화면 확인 · 하는 방법/);
  assert.match(enlarged.querySelector('img').src, /^data:image\/png;base64,/);
  await click('닫기', enlarged.querySelector('.modal-actions'));
  assert.ok(parent.isConnected);
  assert.equal(ui.document.activeElement, thumbnail);
  await click('목록으로 돌아가기', parent.querySelector('.modal-actions'));
  await click('내보내기');
  await click('인쇄 보기');
  assert.equal(ui.document.querySelectorAll('.print-photos img').length, 1);
  assert.equal(ui.document.querySelector('.print-photos figcaption').textContent, '조회 버튼 위치');
});

test('photo UI: malformed, forbidden and oversized inputs are rejected before changing the document', async () => {
  await openExisting(createDocument({ tasks: [createTask({ title: '오류 검증' })] }));
  const before = ui.localStorage.getItem(DATA_KEY);
  for (const bad of [
    file(new TextEncoder().encode('<svg onload="alert(1)"/>'), 'image/svg+xml', 'unsafe.svg'),
    file(new TextEncoder().encode('<html>not a png</html>'), 'image/png', 'fake.png'),
    { name: 'large.png', type: 'image/png', size: IMAGE_LIMITS.inputBytes + 1, arrayBuffer: async () => { throw new Error('Oversize input must not be read'); } },
    file(png.slice(0, 30), 'image/png', 'truncated.png'),
  ]) {
    await chooseFile(photoArea('method').querySelector('input[type=file]'), bad);
    assert.equal(ui.document.querySelectorAll('dialog').length, 0);
    assert.ok(photoArea('method').querySelector('[role=alert]').textContent.length > 0);
    assert.equal(ui.localStorage.getItem(DATA_KEY), before);
  }
  const drop = new ui.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file(), file()] } });
  photoArea('method').dispatchEvent(drop); await settle();
  assert.match(photoArea('method').textContent, /한 번에 한 장/);
  assert.equal(ui.localStorage.getItem(DATA_KEY), before);
});

test('photo UI: failed autosave keeps the image in memory and explicit JSON backup still contains it', async () => {
  const doc = createDocument({ tasks: [createTask({ title: '저장 공간 검증' })] });
  let failWrites = false;
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id }, { failWrites: () => failWrites });
  await click('이어서 작성'); await click(ui.document.querySelector('.map-task'));
  const storedBefore = ui.localStorage.getItem(DATA_KEY);
  failWrites = true;
  await addPhoto('method', '임시저장 실패 시 파일 백업');
  assert.equal(ui.localStorage.getItem(DATA_KEY), storedBefore);
  assert.match(ui.document.querySelector('[data-save-status]').textContent, /임시저장 실패/);
  const failure = ui.document.querySelector('#save-failure-notice');
  assert.ok(failure && !failure.hidden);
  assert.match(failure.textContent, /현재 화면/);
  await click('파일로 저장');
  const received = downloads.findLast(item => item.name?.endsWith('.json'));
  const backedUp = parseImport(await received.blob.text()).document;
  assert.equal(backedUp.tasks[0].images[0].caption, '임시저장 실패 시 파일 백업');
  assert.equal(backedUp.tasks[0].images[0].data, Buffer.from(png).toString('base64'));
});

test('photo UI: a late earlier JSON file cannot replace the latest import preview or accepted content', async () => {
  await mount();
  const open = [...ui.document.querySelectorAll('.start-card')].find(n => n.querySelector('strong')?.textContent === '받은 인수인계서 보기');
  await click(open);
  const first = documentWithImage(); first.title = '이전 파일 — 지연된 읽기';
  const second = documentWithImage(); second.title = '현재 선택 파일 — 올바른 미리보기';
  const firstText = stringifyDocument(first), secondText = stringifyDocument(second);
  let release;
  const waiting = new Promise(resolve => release = resolve);
  const input = control('받은 파일 선택', latestDialog());
  await chooseFile(input, { name: 'earlier.json', size: Buffer.byteLength(firstText), text: () => waiting });
  await chooseFile(input, { name: 'latest.json', size: Buffer.byteLength(secondText), text: async () => secondText });
  assert.match(latestDialog().textContent, /현재 선택 파일 — 올바른 미리보기/);
  release(firstText); await settle();
  assert.match(latestDialog().textContent, /현재 선택 파일 — 올바른 미리보기/);
  assert.doesNotMatch(latestDialog().textContent, /이전 파일 — 지연된 읽기/);
  await click('이 인수인계서 보기', latestDialog());
  assert.equal(localDoc().title, second.title);
});

test('photo UI: a browser codec rejection blocks JSON import without modifying existing drafts', async () => {
  const existing = createDocument({ title: '기존에 저장한 문서' });
  await mount({ [DATA_KEY]: JSON.stringify([existing]), [CURRENT_KEY]: existing.id });
  const before = ui.localStorage.getItem(DATA_KEY);
  const open = [...ui.document.querySelectorAll('.start-card')].find(n => n.querySelector('strong')?.textContent === '받은 인수인계서 보기');
  await click(open);
  setGlobal('createImageBitmap', async () => { throw new Error('Synthetic codec rejection'); });
  const text = stringifyDocument(documentWithImage());
  await chooseFile(control('받은 파일 선택', latestDialog()), { name: 'codec-failure.json', size: Buffer.byteLength(text), text: async () => text });
  assert.match(latestDialog().querySelector('[role=alert]').textContent, /사진을 읽지 못했습니다/);
  await click('이 인수인계서 보기', latestDialog());
  assert.equal(ui.localStorage.getItem(DATA_KEY), before);
  assert.match(ui.document.querySelector('#notice').textContent, /먼저/);
});

test('photo UI: search indexes captions but excludes the image base64 payload', async () => {
  const document = documentWithImage();
  await openExisting(document);
  await click('인수자 보기');
  await fill('업무나 상황 찾기', '조회 버튼 위치');
  assert.match(ui.document.querySelector('#reader-results').textContent, /검색 결과 1개/);
  await fill('업무나 상황 찾기', document.tasks[0].images[0].data.slice(160, 220));
  assert.match(ui.document.querySelector('#reader-results').textContent, /검색 결과 0개/);
});

test('work overview UI: author jumps to the selected task, returns to its title, and reader opens details', async () => {
  const doc = documentWithImage();
  const group = { id: makeId(), title: '가상 정기 운영' };
  doc.groups.push(group);
  doc.tasks[0].ownerRole = '가상 운영 담당';
  doc.tasks[0].groupId = group.id;
  doc.tasks.push(createTask({ title: '미분류 가상 업무', method: '담당을 아직 정하지 않음' }));
  await openExisting(doc);
  const original = ui.localStorage.getItem(DATA_KEY);
  await click('내 업무 한눈에 보기');
  const overview = ui.document.querySelector('.work-overview');
  assert.ok(overview);
  assert.match(overview.textContent, /가상 운영 담당/);
  assert.match(overview.textContent, /가상 정기 운영/);
  assert.match(overview.textContent, /담당 미입력/);
  assert.match(overview.textContent, /아직 분류하지 않은 업무/);
  assert.equal(ui.localStorage.getItem(DATA_KEY), original, 'overview is only a projection');
  await click(overview.querySelector(`[data-task-id="${doc.tasks[0].id}"]`));
  assert.equal(control('업무명').value, doc.tasks[0].title);
  await fill('하는 방법', '업무표에서 찾아 수정한 설명');
  await click('업무표로 돌아가기');
  assert.equal(ui.document.activeElement.dataset.taskId, doc.tasks[0].id);
  assert.equal(localDoc().tasks[0].method, '업무표에서 찾아 수정한 설명');
  await click('작성 화면으로 돌아가기');
  await click('인수자 보기');
  await click('내 업무 한눈에 보기');
  const title = ui.document.querySelector(`.overview-task-link[data-task-id="${doc.tasks[0].id}"]`);
  await click(title);
  assert.match(latestDialog().textContent, /업무표에서 찾아 수정한 설명/);
  assert.equal(ui.document.querySelectorAll('.photo-gallery img').length, 1);
  await click('목록으로 돌아가기', latestDialog().querySelector('.modal-actions'));
  assert.equal(ui.document.activeElement, title);
  assert.ok(ui.document.querySelector('.overview-screen'));
});

test('photo UI: invalid caption controls preserve the saved caption and keep preview errors inside the dialog', async () => {
  await openExisting(documentWithImage());
  const validCaption = localDoc().tasks[0].images[0].caption;
  for (const invalid of ['금지된\uFEFF문자', '방향\u202E제어']) {
    const before = ui.localStorage.getItem(DATA_KEY);
    await fill('사진 설명 (선택)', invalid, photoArea('method'));
    assert.equal(localDoc().tasks[0].images[0].caption, validCaption);
    assert.equal(ui.localStorage.getItem(DATA_KEY), before);
    assert.match(photoArea('method').querySelector('[role=alert]').textContent, /이전 설명은 유지/);
    await click('인수자 보기');
    await click(ui.document.querySelector('.map-task'));
    assert.equal(latestDialog().querySelector('.photo-caption').textContent, validCaption);
    await click('목록으로 돌아가기', latestDialog().querySelector('.modal-actions'));
    await click('작성하기');
    assert.equal(control('사진 설명 (선택)', photoArea('method')).value, validCaption);
  }
  const before = ui.localStorage.getItem(DATA_KEY);
  await chooseFile(photoArea('method').querySelector('input[type=file]'), file());
  const preview = latestDialog();
  for (const invalid of ['잘못된\uFEFF설명', '방향\u202E문자']) {
    await fill('짧은 설명 (선택)', invalid, preview);
    await click('사진 추가', preview);
    assert.equal(latestDialog(), preview);
    assert.ok(preview.isConnected);
    assert.match(preview.querySelector('[role=alert]').textContent, /추가하지 않았습니다/);
    assert.equal(ui.localStorage.getItem(DATA_KEY), before);
  }
  const errors = [];
  ui.addEventListener('error', event => { errors.push(event.error || event.message); event.preventDefault(); });
  await click('사진을 크게 확인', preview);
  assert.deepEqual(errors, [], 'invalid caption must not escape through the enlarge action');
  if (latestDialog() !== preview) await click('닫기', latestDialog().querySelector('.modal-actions'));
  await fill('짧은 설명 (선택)', '수정한 정상 설명', preview);
  await click('사진 추가', preview);
  assert.equal(localDoc().tasks[0].images.length, 2);
  assert.equal(localDoc().tasks[0].images[1].caption, '수정한 정상 설명');
});

test('usage guide UI: header opens both lanes from home and returns to the unchanged current document', async () => {
  await mount();
  await click('사용방법', ui.document.querySelector('.header'));
  let guide = ui.document.querySelector('.usage-guide');
  assert.ok(guide);
  const sender = button('인계자 · 작성해서 전달할 사람', guide);
  const receiver = button('인수자 · 받아서 볼 사람', guide);
  assert.equal(sender.getAttribute('aria-pressed'), 'true');
  assert.equal(guide.querySelector('[aria-label="인계자 · 작성해서 전달할 사람"]').hidden, false);
  await click(receiver);
  assert.equal(receiver.getAttribute('aria-pressed'), 'true');
  assert.equal(sender.getAttribute('aria-pressed'), 'false');
  assert.equal(guide.querySelector('[aria-label="인수자 · 받아서 볼 사람"]').hidden, false);
  assert.equal(guide.querySelector('[aria-label="인계자 · 작성해서 전달할 사람"]').hidden, true);
  await click('설명서 닫기', guide);
  assert.ok(ui.document.querySelector('.home .start-grid'));

  await openExisting(documentWithImage());
  const before = ui.localStorage.getItem(DATA_KEY);
  const currentId = ui.localStorage.getItem(CURRENT_KEY);
  await click('사용방법', ui.document.querySelector('.header'));
  guide = ui.document.querySelector('.usage-guide');
  assert.match(guide.textContent, /사진/);
  await click('설명서 닫기', guide);
  assert.equal(ui.localStorage.getItem(DATA_KEY), before);
  assert.equal(ui.localStorage.getItem(CURRENT_KEY), currentId);
  assert.equal(control('업무명').value, '가상 화면 확인');
  assert.equal(photoArea('method').querySelectorAll('.photo-edit-item').length, 1);
});
