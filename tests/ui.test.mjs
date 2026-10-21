import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { unzipSync, strFromU8 } from 'fflate';
import { CURRENT_SCHEMA_VERSION, createDocument, createTask, createCase, makeId, parseImport, stringifyDocument, validateDocument, dateISO } from '../src/model.js';
import { DATA_KEY, CURRENT_KEY, PROGRESS_KEY, loadDocuments } from '../src/storage.js';
import { exportAIText, exportDocx } from '../src/exporters.js';
import { AUTHOR_PROMPT, parseAIDraft } from '../src/ai-draft.js';
import { reviewExampleDocument } from '../src/review-example.js';

// These tests execute the real app module against a DOM emulator. They do not
// launch a browser, navigate to localhost, or claim layout/visual verification.
const originalGlobals = new Map();
const windows = [];
const timers = [];
const originalSetTimeout = globalThis.setTimeout;
const originalCreateURL = URL.createObjectURL;
const originalRevokeURL = URL.revokeObjectURL;
let ui;
let importNumber = 0;
let downloads = [];
let networkAttempts = [];

function globalValue(name, value) {
  if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

async function settle() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
}

async function mount(snapshot = {}) {
  ui = new Window({ url: 'https://handover-dom-test.invalid/' });
  windows.push(ui);
  ui.document.body.innerHTML = '<a class="skip-link" href="#main">본문으로 바로 가기</a><div id="app"></div><div id="notice" role="status" aria-live="polite" hidden></div><div id="modal-root"></div>';
  for (const [key, value] of Object.entries(snapshot)) ui.localStorage.setItem(key, value);
  for (const key of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'Event', 'KeyboardEvent']) {
    globalValue(key, key === 'window' ? ui : key === 'document' ? ui.document : ui[key]);
  }
  globalValue('setTimeout', (...args) => {
    const timer = originalSetTimeout(...args);
    timer.unref?.();
    timers.push(timer);
    return timer;
  });
  const rejectNetwork = (...args) => {
    networkAttempts.push(String(args[0]));
    throw new Error('Network is forbidden in DOM-only UI checks');
  };
  globalValue('fetch', rejectNetwork);
  ui.fetch = rejectNetwork;
  ui.HTMLAnchorElement.prototype.click = function () {
    // Record a browser download request without navigating a virtual page.
    const pending = downloads.findLast(item => item.url === this.href);
    if (pending) pending.filename = this.download;
  };
  URL.createObjectURL = blob => {
    const url = `blob:handover-dom-${downloads.length}`;
    downloads.push({ url, blob });
    return url;
  };
  URL.revokeObjectURL = () => {};
  await import(`../src/app.js?dom-check=${++importNumber}`);
  await settle();
  return ui;
}

afterEach(async () => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  for (const window of windows.splice(0)) await window.happyDOM.close();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  originalGlobals.clear();
  URL.createObjectURL = originalCreateURL;
  URL.revokeObjectURL = originalRevokeURL;
  downloads = [];
  networkAttempts = [];
});

function button(name, root = ui.document, { includes = false } = {}) {
  const matches = [...root.querySelectorAll('button')].filter(node =>
    includes ? node.textContent.includes(name) : node.textContent.trim() === name);
  assert.equal(matches.length, 1, `one button for "${name}", found ${matches.length}`);
  return matches[0];
}

async function reveal(node) {
  const ancestors=[];for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')ancestors.push(parent);
  for(const details of ancestors.reverse())if(!details.open){details.open=true;details.dispatchEvent(new ui.Event('toggle'));}
  await settle();
}

async function click(name, root = ui.document, options) {
  const target = typeof name === 'string' ? button(name, root, options) : name;
  assert.ok(target);
  assert.notEqual(target.disabled, true, 'target must be enabled');
  await reveal(target);
  target.focus();
  target.click();
  await settle();
}

function control(label, root = ui.document) {
  const labels = [...root.querySelectorAll('label')].filter(node => node.textContent.trim() === label);
  assert.equal(labels.length, 1, `one field label for "${label}"`);
  const node = labels[0].htmlFor ? ui.document.getElementById(labels[0].htmlFor) : labels[0].querySelector('input,select,textarea');
  assert.ok(node, `control for "${label}" exists`);
  return node;
}

async function fill(label, value, root = ui.document) {
  const input = control(label, root);
  await reveal(input);
  input.focus();
  input.value = value;
  input.dispatchEvent(new ui.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  await settle();
}

function snapshot() {
  return Object.fromEntries(Array.from({ length: ui.localStorage.length }, (_, index) => {
    const key = ui.localStorage.key(index);
    return [key, ui.localStorage.getItem(key)];
  }));
}

function savedDocument() {
  const docs = loadDocuments(ui.localStorage);
  const doc = docs.find(item => item.id === ui.localStorage.getItem(CURRENT_KEY));
  assert.ok(doc, 'real backing store contains the selected document');
  assert.equal(validateDocument(doc).ok, true);
  return doc;
}

async function startNew() {
  const card = [...ui.document.querySelectorAll('.start-card')].find(node => node.querySelector('strong')?.textContent === '인수인계서 만들기');
  await click(card);
}

async function addGroup(title) {
  await click('＋ 큰 업무 영역');
  await fill('큰 업무 이름', title);
  await click('영역 만들기', ui.document.querySelector('dialog'));
}

function groupCard(title) {
  const card = [...ui.document.querySelectorAll('.group-card')].find(node => node.querySelector('h3')?.textContent === title);
  assert.ok(card, `group "${title}" is present`);
  return card;
}

async function addTask(groupTitle, title, method, timing = 'event') {
  await click('＋ 세부 업무', groupCard(groupTitle));
  assert.equal(ui.document.activeElement, control('업무명'), 'new subtask moves focus to its name');
  await fill('업무명', title);
  await fill('하는 방법', method);
  if (timing === 'monthEnd') {
    await fill('수행 시점', 'regular');
    await fill('반복 주기', 'monthly');
    await fill('월 안에서 언제 하나요?', 'monthEnd');
  } else if (timing === 'daily') {
    await fill('수행 시점', 'regular');
    await fill('반복 주기', 'daily');
  } else {
    await fill('어떤 상황인가요?', '검증용 요청이 접수되면');
  }
}

async function createThreeGroups() {
  await startNew();
  for (const title of ['검증용 정기 운영', '검증용 행사 지원', '검증용 자료 관리']) await addGroup(title);
  await addTask('검증용 정기 운영', '검증용 월말 보고', '원장을 대조합니다.\n합계를 확인합니다.\n\n항목\t값', 'monthEnd');
  await addTask('검증용 행사 지원', '검증용 매일 접수 확인', '접수함을 확인하고 다음 행동을 기록합니다.', 'daily');
  await addTask('검증용 자료 관리', '검증용 비정기 자료 안내', '요청한 자료의 위치를 안내합니다.');
  return savedDocument();
}

async function importJsonThroughUI(text) {
  const card = [...ui.document.querySelectorAll('.start-card')].find(node => node.querySelector('strong')?.textContent === '받은 인수인계서 보기');
  await click(card);
  const input = control('받은 파일 선택');
  const transfer = new ui.DataTransfer();
  transfer.items.add(new ui.File([text], '가상-전달자료.json', { type: 'application/json' }));
  input.files = transfer.files;
  input.dispatchEvent(new ui.Event('change', { bubbles: true }));
  await settle();
  assert.equal(ui.document.querySelector('.import-preview .error'), null);
  assert.match(ui.document.querySelector('.import-preview').textContent, /기존 문서를 덮어쓰지 않습니다/);
  await click('이 인수인계서 보기', ui.document.querySelector('dialog'));
  return savedDocument();
}

async function backupText() {
  await click('파일로 저장');
  const download = downloads.at(-1);
  assert.match(download.filename, /\.json$/);
  return download.blob.text();
}

test('unsupported or damaged transfer files leave current documents and selection untouched', async () => {
  const existing = createDocument({ title: '보존할 가상 문서', tasks: [createTask({ title: '기존 업무', method: '원래 설명' })] });
  await mount({ [DATA_KEY]: JSON.stringify([existing]), [CURRENT_KEY]: existing.id });
  const before = snapshot();
  const future = { ...structuredClone(existing), schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
  const mislabeled = { ...structuredClone(existing), schemaVersion: 2 };
  for (const text of [JSON.stringify(future), JSON.stringify(mislabeled), '{broken']) {
    await click([...ui.document.querySelectorAll('.start-card')].find(node => node.querySelector('strong')?.textContent === '받은 인수인계서 보기'));
    const transfer = new ui.DataTransfer();
    transfer.items.add(new ui.File([text], '가상-미지원.json', { type: 'application/json' }));
    const input = control('받은 파일 선택');
    input.files = transfer.files;
    input.dispatchEvent(new ui.Event('change', { bubbles: true }));
    await settle();
    assert.ok(ui.document.querySelector('.import-preview .error'));
    if (text === JSON.stringify(future)) assert.match(ui.document.querySelector('.import-preview .error').textContent, /최신 인수인계 A to Z/);
    await click('이 인수인계서 보기', ui.document.querySelector('dialog'));
    assert.deepEqual(snapshot(), before, 'a failed import must not replace or save existing content');
    await click('취소', ui.document.querySelector('dialog'));
  }
  assert.deepEqual(savedDocument(), existing);
});

test('opening legacy JSON preserves its format; an intentional edit upgrades without losing legacy fields', async () => {
  const task = createTask({ title: '구 형식 가상 업무', method: '첫 줄\n원래 설명' });
  delete task.firstAction;
  const legacy = createDocument({ schemaVersion: 2, title: '구 형식 가상 자료', tasks: [task] });
  await mount();
  const opened = await importJsonThroughUI(JSON.stringify(legacy));
  assert.equal(opened.schemaVersion, 2);
  assert.equal(Object.hasOwn(opened.tasks[0], 'firstAction'), false);
  assert.equal(opened.tasks[0].method, legacy.tasks[0].method);
  await click('작성하기');
  await fill('첫 행동 한 줄', '접수 내용을 확인하세요.');
  const edited = savedDocument();
  assert.equal(edited.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(edited.tasks[0].method, legacy.tasks[0].method);
  assert.equal(edited.tasks[0].firstAction, '접수 내용을 확인하세요.');
  assert.deepEqual(parseImport(await backupText()).document, edited);
});

test('MACH main link uses a local logo and leaves the app home action independent', async () => {
  await mount();
  const link = ui.document.querySelector('.header a.mach-home-link');
  assert.ok(link);
  assert.equal(link.href, 'https://erakeun.github.io/ERICAAI/');
  assert.equal(link.getAttribute('aria-label'), 'MACH 메인으로 이동');
  assert.equal(link.querySelector('img').getAttribute('src'), './assets/mach-selected-A.svg');
  assert.equal(link.closest('button'), null);
  assert.equal(link.querySelector('button'), null);
  link.focus();
  assert.equal(ui.document.activeElement, link);

  await startNew();
  const before = ui.localStorage.getItem(DATA_KEY);
  await click(ui.document.querySelector('.brand-button'));
  assert.ok(ui.document.querySelector('.start-grid'));
  assert.equal(ui.localStorage.getItem(DATA_KEY), before);
  assert.ok(ui.document.querySelector('.header a.mach-home-link'));
  assert.equal(networkAttempts.length, 0);
});

test('export renders selectable controls and preserves one-item scope through print, return and real DOCX download', async () => {
  const chosen = createTask({ title: '선택한 업무 고유 제목', method: '선택한 방법만 전달합니다.' });
  const omitted = createTask({ title: '제외한 업무 고유 제목', method: '제외한 방법 고유 내용' });
  const omittedCase = createCase({ title: '제외한 진행 건 고유 제목', nextAction: '제외한 다음 행동' });
  const doc = createDocument({ title: '출력 범위 검증', tasks: [chosen, omitted], cases: [omittedCase] });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('이어서 작성', ui.document.querySelector('.document-card'));
  await click('내보내기', ui.document.querySelector('.top-nav'));
  const list = ui.document.querySelector('.export-selection');
  assert.equal(list.querySelectorAll('input[type=checkbox]').length, 3);
  for (const item of [...doc.tasks, ...doc.cases]) assert.equal(control(item.title, list).checked, true);
  const documentBefore = ui.localStorage.getItem(DATA_KEY);

  await click('선택 해제');
  assert.match(ui.document.querySelector('[data-export-selection-count]').textContent, /업무 0\/2개 · 진행 건 0\/1개/);
  const chosenBox = control(chosen.title, list);
  chosenBox.checked = true;
  chosenBox.dispatchEvent(new ui.Event('change', { bubbles: true }));
  await settle();
  assert.match(ui.document.querySelector('[data-export-selection-count]').textContent, /업무 1\/2개 · 진행 건 0\/1개/);
  await click('인쇄 보기');
  assert.deepEqual([...ui.document.querySelectorAll('.print-item h3')].map(node => node.textContent), [`1. ${chosen.title}`]);
  await click('내보내기로 돌아가기');
  assert.equal(control(chosen.title, ui.document.querySelector('.export-selection')).checked, true);
  assert.equal(control(omitted.title, ui.document.querySelector('.export-selection')).checked, false);
  assert.equal(control(omittedCase.title, ui.document.querySelector('.export-selection')).checked, false);
  assert.match(ui.document.querySelector('[data-export-selection-count]').textContent, /업무 1\/2개 · 진행 건 0\/1개/);

  const previousDownloads = downloads.length;
  await click('선택한 업무만 문서로 받기');
  for (let attempt = 0; attempt < 100 && downloads.length === previousDownloads; attempt++) {
    await new Promise(resolve => originalSetTimeout(resolve, 10));
  }
  assert.equal(downloads.length, previousDownloads + 1, 'real DOCX generation requests a download');
  const output = downloads.at(-1);
  assert.match(output.filename, /\.docx$/);
  const files = unzipSync(new Uint8Array(await output.blob.arrayBuffer()));
  const documentXml = strFromU8(files['word/document.xml']);
  assert.ok(documentXml.includes(chosen.title));
  for (const text of [omitted.title, omitted.method, omittedCase.title, omittedCase.nextAction]) {
    assert.ok(!documentXml.includes(text), `${text} stays outside the exported scope`);
  }
  assert.equal(ui.localStorage.getItem(DATA_KEY), documentBefore, 'output choices do not alter the document');
  assert.equal(networkAttempts.length, 0);
});

test('each document keeps its own export selection when switching away and back', async () => {
  const first = createDocument({ title: '첫 번째 범위 검증', tasks: [createTask({ title: '첫 문서 업무' })] });
  const second = createDocument({ title: '두 번째 범위 검증', tasks: [createTask({ title: '두 번째 문서 업무' })] });
  await mount({ [DATA_KEY]: JSON.stringify([first, second]), [CURRENT_KEY]: first.id });
  const openDocument = async doc => {
    const card = [...ui.document.querySelectorAll('.document-card')].find(node => node.querySelector('h3')?.textContent === doc.title);
    await click('이어서 작성', card);
    await click('내보내기', ui.document.querySelector('.top-nav'));
  };
  await openDocument(first);
  await click('선택 해제');
  await click(ui.document.querySelector('.brand-button'));
  await openDocument(second);
  assert.equal(control(second.tasks[0].title, ui.document.querySelector('.export-selection')).checked, true);
  await click(ui.document.querySelector('.brand-button'));
  await openDocument(first);
  assert.equal(control(first.tasks[0].title, ui.document.querySelector('.export-selection')).checked, false);
  await click('모두 선택');
  assert.equal(control(first.tasks[0].title, ui.document.querySelector('.export-selection')).checked, true);
  assert.match(ui.document.querySelector('[data-export-selection-count]').textContent, /업무 1\/1개/);
});

test('an established export scope removes deleted tasks and does not silently select newly added tasks', async () => {
  const doc = createDocument({ tasks: [createTask({ title: '삭제할 출력 업무' })] });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('이어서 작성', ui.document.querySelector('.document-card'));
  await click('내보내기', ui.document.querySelector('.top-nav'));
  assert.match(ui.document.querySelector('[data-export-selection-count]').textContent, /업무 1\/1개/);
  await click('작성하기', ui.document.querySelector('.top-nav'));
  await click(ui.document.querySelector('.map-task'));
  await click('삭제', ui.document.querySelector('.selected-editor'));
  await click('확인', ui.document.querySelector('dialog'));
  await addGroup('새 출력 업무 영역');
  await addTask('새 출력 업무 영역', '나중에 추가한 출력 업무', '별도 선택할 방법');
  await click('내보내기', ui.document.querySelector('.top-nav'));
  const list = ui.document.querySelector('.export-selection');
  assert.equal(list.querySelectorAll('input[type=checkbox]').length, 1);
  assert.equal(control('나중에 추가한 출력 업무', list).checked, false);
  assert.match(ui.document.querySelector('[data-export-selection-count]').textContent, /업무 0\/1개/);
  await click('모두 선택');
  assert.equal(control('나중에 추가한 출력 업무', list).checked, true);
});

test('JSON import preview renders validation warnings as actual warning nodes', async () => {
  await mount();
  const doc = createDocument({ tasks: [createTask({ title: '', method: '이름을 아직 정하지 않은 방법' })] });
  const card = [...ui.document.querySelectorAll('.start-card')].find(node => node.querySelector('strong')?.textContent === '받은 인수인계서 보기');
  await click(card);
  const input = control('받은 파일 선택');
  const transfer = new ui.DataTransfer();
  transfer.items.add(new ui.File([stringifyDocument(doc)], '검증-경고.json', { type: 'application/json' }));
  input.files = transfer.files;
  input.dispatchEvent(new ui.Event('change', { bubbles: true }));
  await settle();
  const warnings = [...ui.document.querySelectorAll('.import-preview .warning-text')];
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].textContent, /제목을 작성해 주세요/);
  assert.equal(ui.document.querySelector('.import-preview .error'), null);
});

test('real UI clicks create three groups and subtasks, persist month-end and reopen through JSON/file import', async () => {
  await mount();
  const authored = await createThreeGroups();
  assert.equal(authored.groups.length, 3);
  assert.equal(authored.tasks.length, 3);
  assert.equal(authored.tasks[0].timing.dayRule, 'monthEnd');
  assert.equal(authored.tasks[0].timing.cadence, 'monthly');
  assert.equal(authored.tasks[0].method, '원장을 대조합니다.\n합계를 확인합니다.\n\n항목\t값');
  const json = await backupText();
  assert.deepEqual(parseImport(json).document, authored);

  const persisted = snapshot();
  await mount(persisted);
  await click('이어서 작성', ui.document.querySelector('.document-card'));
  assert.equal(ui.document.querySelectorAll('.group-card').length, 3);
  assert.deepEqual(savedDocument(), authored);
  assert.match(groupCard('검증용 정기 운영').textContent, /검증용 월말 보고.*매월 말일/s);

  await mount();
  const received = await importJsonThroughUI(json);
  assert.notEqual(received.id, authored.id);
  assert.equal(received.groups.length, 3);
  assert.deepEqual(received.tasks.map(task => task.title), authored.tasks.map(task => task.title));
  assert.deepEqual(received.tasks.map(task => task.method), authored.tasks.map(task => task.method));
  assert.equal(received.tasks[0].timing.dayRule, 'monthEnd');
  assert.equal(ui.document.querySelectorAll('.group-card').length, 3);
  assert.equal(ui.localStorage.getItem(PROGRESS_KEY), null);
  assert.equal(networkAttempts.length, 0);
});

test('reader can find all groups, this-week work and situation text without modifying the handed-over document', async () => {
  await mount();
  await createThreeGroups();
  await click('인수자 보기', ui.document.querySelector('.top-nav'));
  assert.equal(ui.document.activeElement.id, 'main');
  assert.equal(ui.document.querySelectorAll('#reader-results .group-card').length, 3);
  assert.ok(ui.document.querySelector('#reader-results').textContent.includes('검증용 비정기 자료 안내'));
  const before = ui.localStorage.getItem(DATA_KEY);
  await click('이번 주', ui.document.querySelector('.reader-nav'));
  assert.ok(ui.document.querySelector('#reader-results').textContent.includes('검증용 매일 접수 확인'));
  await fill('업무나 상황 찾기', '요청한 자료');
  assert.ok(ui.document.querySelector('#reader-results').textContent.includes('검증용 비정기 자료 안내'));
  assert.ok(!ui.document.querySelector('#reader-results').textContent.includes('검증용 월말 보고'));
  assert.equal(ui.document.querySelector('#reader-results input[type=checkbox]'), null, 'reading a procedure does not offer a permanent completion check');
  assert.equal(ui.localStorage.getItem(DATA_KEY), before, 'reading must not mutate the handed-over document');
  assert.equal(ui.localStorage.getItem(PROGRESS_KEY), null);
  assert.equal(networkAttempts.length, 0);
});

test('pasted markup remains literal in import review and committed tasks; unselected text survives only in source', async () => {
  await mount();
  await startNew();
  const malicious = '<img src=x onerror="globalThis.pwned=1"> 검증 업무\n<script>globalThis.pwned=2</script>\n문자 그대로 남길 절차';
  const omitted = '선택하지 않은 검증 업무\n원문에서만 보존할 내용';
  await click('메모 붙여넣기');
  await fill('붙여넣을 내용', `${malicious}\n\n${omitted}`);
  await click('초안 검토', ui.document.querySelector('dialog'));
  assert.equal(savedDocument().tasks.length, 0, 'preview must not silently commit');
  const drafts = [...ui.document.querySelectorAll('.draft-block')];
  assert.equal(drafts.length, 2);
  assert.equal(control('추출한 내용', drafts[0]).value, malicious);
  assert.equal(ui.document.querySelectorAll('#modal-root img, #modal-root script, #modal-root [onerror]').length, 0);
  const omittedCheck = control('초안 2 선택', drafts[1]);
  omittedCheck.checked = false;
  omittedCheck.dispatchEvent(new ui.Event('change', { bubbles: true }));
  await click('현재 문서에 업무 추가', ui.document.querySelector('dialog'));
  const doc = savedDocument();
  assert.equal(doc.tasks.length, 1);
  assert.equal(doc.tasks[0].method, malicious);
  assert.ok(doc.sourceFiles[0].excerpt.includes(malicious));
  assert.ok(doc.sourceFiles[0].excerpt.includes(omitted));
  assert.deepEqual([...ui.document.querySelectorAll('img')], [ui.document.querySelector('.header .mach-logo')]);
  assert.equal(ui.document.querySelectorAll('script, [onerror]').length, 0);
  await click('인수자 보기', ui.document.querySelector('.top-nav'));
  assert.ok(ui.document.querySelector('.work-map').textContent.includes('<img src=x'));
  await click(ui.document.querySelector('.work-map [data-task-id]'));
  assert.ok(ui.document.querySelector('dialog').textContent.includes('<script>globalThis.pwned=2</script>'));
  assert.equal(globalThis.pwned, undefined);
  assert.equal(networkAttempts.length, 0);
});

const aiDraftRaw = JSON.stringify({
  kind: 'handover-ai-draft',
  groups: [{ title: '가상 AI 정리 영역', tasks: [{
    title: '가상 AI 구조화 업무', when: '매월 초 · 정확한 날짜는 미확정',
    method: '원문 메모의 항목을 확인합니다.\n담당 역할에게 확인 후 진행합니다.',
  }] }],
});

for (const authorUsesAI of [false, true]) {
  for (const readerUsesAI of [false, true]) {
    test(`${authorUsesAI ? 'AI author' : 'manual author'} → JSON handoff → ${readerUsesAI ? 'AI-assisted reader' : 'reader without AI'} executes locally`, async () => {
      await mount();
      await startNew();
      if (authorUsesAI) {
        await click('AI로 초안 만들기');
        assert.equal(ui.document.querySelector('[aria-label="인계자 AI 초안 프롬프트"]').value, AUTHOR_PROMPT);
        await fill('AI의 답글', aiDraftRaw);
        await click('가져오기 전 검토', ui.document.querySelector('dialog'));
        assert.match(ui.document.querySelector('dialog').textContent, /1개 큰 업무 · 1개 세부 업무/);
        assert.equal(savedDocument().tasks.length, 0);
        assert.equal(parseAIDraft(aiDraftRaw)[0].tasks.length, 1);
        await click('검토한 초안 추가', ui.document.querySelector('dialog'));
      } else {
        await addGroup('가상 수기 작성 영역');
        await addTask('가상 수기 작성 영역', '가상 수기 작성 업무', '자료를 읽고 다음 행동을 작성합니다.\n확인이 필요하면 담당 역할에 문의합니다.');
      }
      const authored = savedDocument();
      if (authorUsesAI) {
        assert.equal(authored.sourceFiles[0].excerpt, aiDraftRaw);
        assert.equal(authored.tasks[0].timing.kind, 'event', 'AI prose must not silently become a calendar date');
        assert.ok(authored.tasks[0].timing.trigger.includes('정확한 날짜는 미확정'));
      }
      const json = await backupText();
      await mount();
      const receiver = await importJsonThroughUI(json);
      assert.equal(receiver.tasks[0].method, authored.tasks[0].method);
      assert.equal(receiver.groups[0].title, authored.groups[0].title);
      await click(ui.document.querySelector('.work-map [data-task-id]'));
      assert.ok(ui.document.querySelector('dialog').textContent.includes(authored.tasks[0].method));
      if (readerUsesAI) {
        await click('이 업무를 AI에 질문', ui.document.querySelector('dialog'));
        const preview = ui.document.querySelector('textarea.ai-preview');
        assert.ok(preview);
        assert.ok(preview.value.includes(authored.tasks[0].title));
        assert.ok(preview.value.includes(authored.tasks[0].method));
        assert.ok(preview.value.includes('큰 업무:'));
        assert.match(preview.value, /암호화되지 않은 평문/);
        assert.match(preview.value, /전송하지 않습니다/);
        assert.ok(exportAIText(receiver).includes(authored.tasks[0].method));
      } else {
        assert.equal(ui.document.querySelector('textarea.ai-preview'), null);
        const docx = await exportDocx(receiver);
        assert.ok(docx instanceof Uint8Array && docx.length > 1000);
        assert.equal(docx[0], 0x50);
        assert.equal(docx[1], 0x4b);
      }
      assert.equal(networkAttempts.length, 0);
    });
  }
}

test('AI reader shortcut defaults to excluding contacts, evidence and materials', async () => {
  const task = createTask({
    title: '가상 민감정보 제외 검증', method: '일반 수행 방법',
    contacts: 'PRIVATE_CONTACT_SENTINEL', ownerRole: 'PRIVATE_OWNER_SENTINEL',
    supportRole: 'PRIVATE_SUPPORT_SENTINEL', evidence: 'PRIVATE_EVIDENCE_SENTINEL',
    materials: 'PRIVATE_MATERIAL_SENTINEL',
  });
  const doc = createDocument({ title: '가상 제외 검증 문서', tasks: [task] });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('인수자 보기', ui.document.querySelector('.document-card'));
  await click(ui.document.querySelector('.work-map [data-task-id]'));
  await click('이 업무를 AI에 질문', ui.document.querySelector('dialog'));
  assert.ok(!ui.document.querySelector('textarea.ai-preview').value.includes('PRIVATE_'));
  assert.equal(networkAttempts.length, 0);
});

test('controls have labels and valid pressed state; navigation, editor, modal close and save shortcut retain keyboard support', async () => {
  await mount();
  await startNew();
  const trigger = button('＋ 큰 업무 영역');
  await click(trigger);
  assert.ok(ui.document.querySelector('dialog[open]'));
  await click('취소', ui.document.querySelector('dialog'));
  assert.equal(ui.document.querySelector('dialog'), null);
  assert.equal(ui.document.activeElement, trigger);
  await addGroup('가상 키보드 검증 영역');
  await addTask('가상 키보드 검증 영역', '가상 키보드 검증 업무', '접근성을 확인합니다.', 'monthEnd');

  for (const field of ui.document.querySelectorAll('input,select,textarea')) {
    assert.ok(field.getAttribute('aria-label')?.trim() || field.labels?.length > 0, `named control: ${field.outerHTML}`);
  }
  for (const target of ui.document.querySelectorAll('[aria-labelledby],[aria-describedby]')) {
    for (const attr of ['aria-labelledby', 'aria-describedby']) {
      for (const id of (target.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) {
        assert.ok(ui.document.getElementById(id), `accessible reference ${id} exists`);
      }
    }
  }
  for (const node of ui.document.querySelectorAll('[aria-pressed]')) {
    assert.ok(['true', 'false'].includes(node.getAttribute('aria-pressed')), `valid aria-pressed: ${node.outerHTML}`);
  }
  assert.equal(ui.document.querySelectorAll('button button').length, 0);
  const ids = [...ui.document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length, 'active DOM IDs are unique');
  const before = downloads.length;
  const save = new ui.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  ui.dispatchEvent(save);
  await settle();
  assert.equal(save.defaultPrevented, true);
  assert.equal(downloads.length, before + 1);
  assert.equal(validateDocument(parseImport(await downloads.at(-1).blob.text()).document).ok, true);
  await click('인수자 보기', ui.document.querySelector('.top-nav'));
  assert.equal(ui.document.activeElement.id, 'main');
  assert.equal(ui.document.querySelector('.reader-nav [aria-pressed="true"]').textContent, '업무 전체');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion\s*:\s*reduce/);
  assert.match(css, /@media\s*\(max-width:760px\)/);
});

test('corrupt local storage is surfaced without replacing the stored original', async () => {
  const raw = '{"broken":';
  await mount({ [DATA_KEY]: raw });
  assert.ok(ui.document.querySelector('[role=alert]'));
  assert.match(ui.document.body.textContent, /저장 원본/);
  assert.equal(ui.localStorage.getItem(DATA_KEY), raw);
  for (const card of ui.document.querySelectorAll('.start-card, .home-secondary button')) assert.equal(card.disabled, true);
});

test('the explicitly labelled owner-role filter works consistently in map and week views', async () => {
  const groupId = makeId();
  const doc = createDocument({
    title: '가상 역할 필터 검증',
    groups: [{ id: groupId, title: '가상 역할 영역' }],
    tasks: [
      createTask({ title: '가상 주담당 업무', groupId, ownerRole: '기획 담당', supportRole: '지원 담당', timing: { kind: 'regular', cadence: 'daily' }, method: '주담당으로 처리' }),
      createTask({ title: '가상 지원 업무', groupId, ownerRole: '운영 담당', supportRole: '기획 담당', timing: { kind: 'date', date: dateISO() }, method: '지원 역할로 처리' }),
      createTask({ title: '가상 다른 역할 업무', groupId, ownerRole: '다른 담당', timing: { kind: 'regular', cadence: 'daily' }, method: '다른 역할이 처리' }),
    ],
  });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('인수자 보기', ui.document.querySelector('.document-card'));
  const roleSelect = ui.document.querySelector('.role-filter select');
  assert.ok(roleSelect, 'reader role filter is available');
  assert.equal(control('주담당 역할로 업무 보기'), roleSelect);
  const option = [...roleSelect.options].find(item => item.textContent.includes('기획 담당'));
  assert.ok(option);
  roleSelect.value = option.value;
  roleSelect.dispatchEvent(new ui.Event('change', { bubbles: true }));
  await settle();
  assert.ok(ui.document.querySelector('#reader-results').textContent.includes('가상 주담당 업무'));
  assert.ok(!ui.document.querySelector('#reader-results').textContent.includes('가상 지원 업무'));
  assert.ok(!ui.document.querySelector('#reader-results').textContent.includes('가상 다른 역할 업무'));
  await click('이번 주', ui.document.querySelector('.reader-nav'));
  assert.ok(ui.document.querySelector('#reader-results').textContent.includes('가상 주담당 업무'));
  assert.ok(!ui.document.querySelector('#reader-results').textContent.includes('가상 지원 업무'));
  assert.ok(!ui.document.querySelector('#reader-results').textContent.includes('가상 다른 역할 업무'));
  await fill('주담당 역할로 업무 보기', '');
  await fill('업무나 상황 찾기', '가상 지원 업무');
  assert.ok(ui.document.querySelector('#reader-results').textContent.includes('지원 역할'));
  assert.ok(ui.document.querySelector('#reader-results').textContent.includes('기획 담당'));
});

test('copy, reorder and move a subtask retain its method and use a new stable ID', async()=>{
 await mount();await startNew();await addGroup('복제 검증 영역');await addGroup('이동 대상 영역');
 await addTask('복제 검증 영역','원래 업무','보존할 방법\n두 번째 줄');
 const original=savedDocument().tasks[0];await click('복제');
 let doc=savedDocument();assert.equal(doc.tasks.length,2);assert.notEqual(doc.tasks[1].id,original.id);assert.equal(doc.tasks[1].method,original.method);
 const copyId=doc.tasks[1].id;await click('위로');doc=savedDocument();assert.equal(doc.tasks[0].id,copyId);
 await fill('큰 업무 영역',doc.groups[1].id);doc=savedDocument();assert.equal(doc.tasks[0].groupId,doc.groups[1].id);assert.equal(groupCard('이동 대상 영역').querySelectorAll('.map-task').length,1);
});

for (const sourceKind of ['paste', 'docx']) {
  test(`${sourceKind} review assigns only selected drafts to one existing group and retains source through JSON and DOCX`, async () => {
    const chosenGroup = { id: makeId(), title: '가져올 업무 영역' };
    const otherGroup = { id: makeId(), title: '기존 업무 영역' };
    const existingTask = createTask({ title: '이미 있던 업무', method: '기존 방법', groupId: otherGroup.id, ownerRole: '기존 주담당' });
    delete existingTask.firstAction;
    const legacyCase = createCase({ title: '유지할 진행 건', status: 'waiting' });
    delete legacyCase.statusConfirmed; delete legacyCase.taskId;
    const doc = createDocument({
      schemaVersion: sourceKind === 'paste' ? 1 : 2,
      groups: [chosenGroup, otherGroup], tasks: [existingTask],
      cases: [legacyCase],
      onboarding: { dayOne: '유지할 첫날 안내', firstWeek: '유지할 첫 주 안내' },
    });
    await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
    await click('이어서 작성', ui.document.querySelector('.document-card'));
    if (sourceKind === 'paste') {
      await click('메모 붙여넣기');
      await fill('붙여넣을 내용', '선택한 초안 하나\n첫 번째 원문 방법\n\n선택한 초안 둘\n두 번째 원문 방법\n\n선택하지 않은 초안\n원문에만 보관할 내용');
      await click('초안 검토', ui.document.querySelector('dialog'));
    } else {
      await click('문서 불러오기');
      const input = control('기존 문서 선택');
      const bytes = await readFile(new URL('../fixtures/import/synthetic-body-table.docx', import.meta.url));
      const transfer = new ui.DataTransfer();
      transfer.items.add(new ui.File([bytes], 'synthetic-body-table.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
      input.files = transfer.files;
      input.dispatchEvent(new ui.Event('change', { bubbles: true }));
      for (let attempt = 0; attempt < 100 && !ui.document.querySelector('.draft-block'); attempt++) {
        await new Promise(resolve => originalSetTimeout(resolve, 10));
      }
    }
    const review = ui.document.querySelector('dialog');
    const target = control('추가할 큰 업무 영역 (선택)', review);
    assert.equal(target.value, '', 'review starts with unclassified, even when groups already exist');
    await fill('추가할 큰 업무 영역 (선택)', chosenGroup.id, review);
    if (sourceKind === 'paste') {
      const firstDraft = review.querySelector('.draft-block');
      await fill('추출한 내용', control('추출한 내용', firstDraft).value.replace('\n', '\n\n'), firstDraft);
      await click('빈 줄로 나누기', firstDraft);
      await click('다음 초안과 합치기', review.querySelector('.draft-block'));
      assert.equal(control('추가할 큰 업무 영역 (선택)', review).value, chosenGroup.id, 'splitting and merging keeps the chosen destination');
    }
    const draftNodes = [...review.querySelectorAll('.draft-block')];
    assert.ok(draftNodes.length >= 3);
    const omittedNode = draftNodes.at(-1);
    const omittedText = control('추출한 내용', omittedNode).value;
    const omittedCheck = omittedNode.querySelector('input[type=checkbox]');
    omittedCheck.checked = false;
    omittedCheck.dispatchEvent(new ui.Event('change', { bubbles: true }));
    const expected = draftNodes.slice(0, -1).map(node => ({
      title: control('업무명', node).value, method: control('추출한 내용', node).value,
    }));
    assert.equal(savedDocument().tasks.length, 1, 'review choices are not committed until confirmed');
    await click('현재 문서에 업무 추가', review);
    const result = savedDocument();
    const added = result.tasks.slice(1);
    assert.equal(result.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(result.tasks[0], existingTask);
    assert.deepEqual(result.groups, doc.groups);
    assert.deepEqual(result.cases, doc.cases);
    assert.deepEqual(result.onboarding, doc.onboarding);
    assert.deepEqual(added.map(task => ({ title: task.title, method: task.method })), expected);
    assert.ok(added.every(task => task.groupId === chosenGroup.id));
    assert.ok(added.every(task => task.timing.kind === 'event' && task.timing.trigger === '' && task.timing.date === '' && task.ownerRole === ''));
    assert.equal(result.sourceFiles.length, 1);
    assert.ok(result.sourceFiles[0].excerpt.includes(omittedText), 'unselected text remains in the source only');
    for (const task of added) assert.deepEqual(task.sourceRefs, [result.sourceFiles[0].id]);
    assert.equal(groupCard(chosenGroup.title).querySelectorAll('.map-task').length, added.length);
    assert.equal(groupCard(otherGroup.title).querySelectorAll('.map-task').length, 1);
    const roundTrip = parseImport(await backupText()).document;
    assert.deepEqual(roundTrip, result);
    const docx = await exportDocx(roundTrip, { taskIds: added.map(task => task.id), caseIds: [] });
    const documentXml = strFromU8(unzipSync(docx)['word/document.xml']);
    assert.ok(documentXml.includes(`큰 업무: ${chosenGroup.title}`));
    assert.ok(!documentXml.includes(otherGroup.title));
    assert.ok(!documentXml.includes(existingTask.title));
    assert.ok(!documentXml.includes(omittedText));
    await click('인수자 보기', ui.document.querySelector('.top-nav'));
    assert.equal(groupCard(chosenGroup.title).querySelectorAll('.map-task').length, added.length);
    await fill('업무나 상황 찾기', added[0].title);
    assert.ok(ui.document.querySelector('#reader-results').textContent.includes(added[0].method));
    assert.equal(networkAttempts.length, 0);
  });
}

test('review splits and merges editable drafts while preserving extracted source text',async()=>{
 await mount();await startNew();await addGroup('선택하지 않을 기존 영역');await click('메모 붙여넣기');await fill('붙여넣을 내용','원문 제목\n원래 메모');await click('초안 검토',ui.document.querySelector('dialog'));
 assert.equal(control('추가할 큰 업무 영역 (선택)').value,'');
 await fill('추출한 내용','업무 A\n설명 A\n\n업무 B\n설명 B',ui.document.querySelector('.draft-block'));
 await click('빈 줄로 나누기');assert.equal(ui.document.querySelectorAll('.draft-block').length,2);
 await click('다음 초안과 합치기',ui.document.querySelector('.draft-block'));assert.equal(ui.document.querySelectorAll('.draft-block').length,1);
 await click('현재 문서에 업무 추가',ui.document.querySelector('dialog'));
 const doc=savedDocument();assert.equal(doc.tasks.length,1);assert.equal(doc.tasks[0].groupId,'');assert.match(doc.tasks[0].method,/업무 A[\s\S]*업무 B/);assert.match(doc.sourceFiles[0].excerpt,/원래 메모/);
});

test('starting a document import from home creates a new document instead of appending to the previously selected one',async()=>{
 await mount();await startNew();await addGroup('다른 문서에 노출하지 않을 영역');const originalId=savedDocument().id;await click(ui.document.querySelector('.brand-button'));
 await click('기존 문서로 시작');
 await click('직접 붙여넣기',ui.document.querySelector('dialog'));await fill('붙여넣을 내용','새 문서의 업무\n새 문서의 방법');await click('초안 검토',ui.document.querySelector('dialog'));
 assert.ok(!ui.document.querySelector('dialog').textContent.includes('추가할 큰 업무 영역'));
 await click('새 인수인계로 만들기',ui.document.querySelector('dialog'));
 const docs=loadDocuments(ui.localStorage);assert.equal(docs.length,2);assert.equal(docs.find(d=>d.id===originalId).tasks.length,0);assert.notEqual(savedDocument().id,originalId);assert.equal(savedDocument().tasks.length,1);
});

test('72 synthetic drafts stay compact and retain hidden selections, edits and full source during filtered bulk selection', async () => {
  await mount();
  await startNew();
  await addGroup('합성 검토 영역');
  const groupId = savedDocument().groups[0].id;
  const blocks = Array.from({ length: 72 }, (_, index) => `반복 분류 제목\n${index < 8 ? '검토대상' : '기타'} 합성 업무 ${index + 1}\n각 업무의 원문 방법 ${index + 1}\n반복 푸터`);
  await click('메모 붙여넣기');
  await fill('붙여넣을 내용', blocks.join('\n\n'));
  await click('초안 검토', ui.document.querySelector('dialog'));
  const review = ui.document.querySelector('dialog');
  assert.equal(review.querySelectorAll('.draft-block').length, 72);
  assert.equal(review.querySelectorAll('.draft-detail[open]').length, 0, 'full bodies start collapsed');
  assert.ok(review.querySelector('.draft-summary-preview').textContent.includes('합성 업무 1'));
  assert.match(review.querySelector('[data-draft-count]').textContent, /전체 72개 · 검색 결과 72개 · 선택 72개 \(검색 밖 선택 0개\)/);
  await fill('추가할 큰 업무 영역 (선택)', groupId, review);

  const first = review.querySelector('.draft-block');
  first.querySelector('details').open = true;
  first.querySelector('details').dispatchEvent(new ui.Event('toggle'));
  await fill('업무명', '직접 고친 합성 업무명', first);
  await fill('추출한 내용', `${blocks[0]}\n사용자가 검토한 추가 메모`, first);
  assert.equal(first.querySelector('summary strong').textContent, '직접 고친 합성 업무명');
  assert.ok(first.querySelector('.draft-summary-preview').textContent.includes('사용자가 검토한 추가 메모'));
  const searchInput = control('초안에서 찾기', review);
  await fill('초안에서 찾기', '검토대상', review);
  assert.equal(control('초안에서 찾기', review), searchInput, 'filtering does not replace the typing control');
  assert.equal(ui.document.activeElement, searchInput);
  assert.equal(review.querySelectorAll('.draft-block').length, 8);
  assert.match(review.querySelector('[data-draft-count]').textContent, /선택 72개 \(검색 밖 선택 64개\)/);
  await click('검색 결과 선택 해제', review);
  assert.match(review.querySelector('[data-draft-count]').textContent, /선택 64개 \(검색 밖 선택 64개\)/);
  await click('초안 검색 지우기', review);
  assert.equal(review.querySelectorAll('.draft-block input[type=checkbox]:checked').length, 64);
  assert.equal(control('업무명', review.querySelector('.draft-block')).value, '직접 고친 합성 업무명');
  assert.equal(control('추가할 큰 업무 영역 (선택)', review).value, groupId);
  await click('검색 결과 선택 해제', review);
  await fill('초안에서 찾기', '검토대상', review);
  await click('검색 결과 모두 선택', review);
  await fill('초안에서 찾기', '일치하지않는검색어', review);
  assert.equal(review.querySelectorAll('.draft-block').length, 0);
  assert.equal(button('검색 결과 모두 선택', review).disabled, true);
  assert.equal(button('검색 결과 선택 해제', review).disabled, true);
  assert.match(review.querySelector('[data-draft-count]').textContent, /선택 8개 \(검색 밖 선택 8개\)/);
  assert.match(review.textContent, /검색 밖에서 선택한 초안도 함께 추가/);
  assert.equal(savedDocument().tasks.length, 0);
  await click('현재 문서에 업무 추가', review);
  const result = savedDocument();
  assert.equal(result.tasks.length, 8);
  assert.ok(result.tasks.every(task => task.groupId === groupId));
  assert.equal(result.tasks[0].title, '직접 고친 합성 업무명');
  assert.ok(result.tasks[0].method.includes('사용자가 검토한 추가 메모'));
  for (const block of blocks) assert.ok(result.sourceFiles[0].excerpt.includes(block), 'every original draft remains in source');
  assert.ok(!result.sourceFiles[0].excerpt.includes('사용자가 검토한 추가 메모'), 'editing a draft does not rewrite its original source');
  assert.ok(result.tasks.every(task => task.timing.kind === 'event' && task.timing.trigger === '' && task.ownerRole === ''));
  assert.equal(networkAttempts.length, 0);
});

test('filtered draft review cannot merge across a hidden adjacent source block', async () => {
  await mount();
  await startNew();
  await click('메모 붙여넣기');
  await fill('붙여넣을 내용', '표시 A\n첫 원문\n\n숨김 B\n중간 원문\n\n표시 C\n마지막 원문');
  await click('초안 검토', ui.document.querySelector('dialog'));
  const review = ui.document.querySelector('dialog');
  await fill('초안에서 찾기', '표시', review);
  assert.equal(review.querySelectorAll('.draft-block').length, 2);
  let first = review.querySelector('.draft-block');
  first.querySelector('details').open = true;
  first.querySelector('details').dispatchEvent(new ui.Event('toggle'));
  assert.equal(button('다음 초안과 합치기', first).disabled, true);
  assert.match(first.textContent, /원문 순서의 다음 초안이 검색 밖/);
  await click('초안 검색 지우기', review);
  first = review.querySelector('.draft-block');
  assert.equal(first.querySelector('details').open, true);
  await click('다음 초안과 합치기', first);
  assert.equal(review.querySelectorAll('.draft-block').length, 2);
  first = review.querySelector('.draft-block');
  assert.match(control('추출한 내용', first).value, /표시 A[\s\S]*숨김 B/);
  assert.ok(!control('추출한 내용', first).value.includes('표시 C'));
  await click('현재 문서에 업무 추가', review);
  const result = savedDocument();
  assert.equal(result.tasks.length, 2);
  assert.match(result.tasks[0].method, /첫 원문[\s\S]*중간 원문/);
  assert.equal(result.tasks[1].title, '표시 C');
  assert.match(result.sourceFiles[0].excerpt, /표시 A[\s\S]*숨김 B[\s\S]*표시 C/);
});

test('40-task author map search keeps the selected editor, source document, order and full calendar unchanged', async () => {
  const groups = ['구역가', '구역나', '구역다', '구역라'].map(name => ({ id: makeId(), title: `합성 큰 업무 ${name}` }));
  const tasks = Array.from({ length: 40 }, (_, index) => createTask({
    title: `합성 업무 ${String(index + 1).padStart(2, '0')}`,
    method: index === 27 ? '고유 절차 키워드로 찾을 방법' : `반복 업무의 방법 ${index + 1}`,
    ownerRole: index < 10 ? '합성담당가' : '합성담당나',
    groupId: groups[Math.floor(index / 10)].id,
    timing: { kind: 'date', date: dateISO() },
  }));
  const doc = createDocument({ groups, tasks });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('이어서 작성', ui.document.querySelector('.document-card'));
  const allIds = () => [...ui.document.querySelectorAll('.map-task')].map(node => node.dataset.taskId);
  const visibleIds = () => [...ui.document.querySelectorAll('.map-task')].filter(node => !node.closest('li').hidden && !node.closest('.group-card').hidden).map(node => node.dataset.taskId);
  const sourceBefore = ui.localStorage.getItem(DATA_KEY);
  await click(ui.document.querySelector(`.map-task[data-task-id="${tasks[27].id}"]`));
  const calendarNode = ui.document.querySelector('.map-calendar');
  const calendarBefore = calendarNode.innerHTML;
  const editorBefore = ui.document.querySelector('.selected-editor');
  const inputBefore = control('업무 지도에서 찾기');
  await fill('업무 지도에서 찾기', '고유 절차');
  assert.equal(control('업무 지도에서 찾기'), inputBefore);
  assert.equal(ui.document.activeElement, inputBefore);
  assert.deepEqual(visibleIds(), [tasks[27].id]);
  assert.equal(ui.document.querySelector('.selected-editor'), editorBefore);
  assert.equal(control('업무명', editorBefore).value, tasks[27].title);
  assert.match(ui.document.querySelector('[data-author-map-count]').textContent, /1\/40개/);
  await fill('업무 지도에서 찾기', '합성 큰 업무 구역나');
  assert.deepEqual(visibleIds(), tasks.slice(10, 20).map(task => task.id));
  await fill('업무 지도에서 찾기', '합성담당가');
  assert.deepEqual(visibleIds(), tasks.slice(0, 10).map(task => task.id));
  await fill('업무 지도에서 찾기', '결과없는합성어');
  assert.deepEqual(visibleIds(), []);
  assert.match(ui.document.querySelector('.work-map').textContent, /일치하는 업무가 없어요/);
  await click('지도 검색 지우기');
  assert.deepEqual(visibleIds(), tasks.map(task => task.id));
  assert.deepEqual(allIds(), tasks.map(task => task.id));
  assert.equal(ui.document.querySelector('.map-calendar'), calendarNode);
  assert.equal(ui.document.querySelector('.map-calendar').innerHTML, calendarBefore);
  assert.equal(ui.localStorage.getItem(DATA_KEY), sourceBefore);
  await fill('업무 지도에서 찾기', tasks[27].title);
  assert.deepEqual(visibleIds(), [tasks[27].id]);
  await fill('업무명', '직접 수정한 업무명', editorBefore);
  assert.deepEqual(visibleIds(), [], 'editing a searchable field immediately updates the map results');
  assert.match(ui.document.querySelector('[data-author-map-count]').textContent, /0\/40개/);
  assert.equal(ui.document.querySelector('.selected-editor'), editorBefore);
  await addGroup('검색 중 새로 만든 영역');
  assert.equal(control('업무 지도에서 찾기').value, '');
  assert.equal(groupCard('검색 중 새로 만든 영역').hidden, false);
  assert.deepEqual(visibleIds(), tasks.map(task => task.id));
  assert.equal(networkAttempts.length, 0);
});

test('deleting a selected task during author search raises no window error and updates the remaining count', async () => {
  const group = { id: makeId(), title: '합성 삭제 검증 영역' };
  const removed = createTask({ title: '검색공통 삭제할 업무', groupId: group.id, method: '삭제 대상의 방법' });
  const remaining = createTask({ title: '검색공통 남길 업무', groupId: group.id, method: '유지할 방법' });
  const outside = createTask({ title: '무관한 보관 업무', groupId: group.id, method: '검색 밖에서 유지할 방법' });
  const doc = createDocument({ groups: [group], tasks: [removed, remaining, outside] });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  const windowErrors = [];
  ui.addEventListener('error', event => windowErrors.push(event.message));
  await click('이어서 작성', ui.document.querySelector('.document-card'));
  await fill('업무 지도에서 찾기', '검색공통');
  await click(ui.document.querySelector(`.map-task[data-task-id="${removed.id}"]`));
  assert.match(ui.document.querySelector('[data-author-map-count]').textContent, /2\/3개/);
  await click('삭제', ui.document.querySelector('.selected-editor'));
  await click('확인', ui.document.querySelector('dialog'));
  assert.deepEqual(windowErrors, [], 'refreshing stale DOM rows after deletion must not throw');
  assert.deepEqual(savedDocument().tasks, [remaining, outside]);
  assert.equal(control('업무 지도에서 찾기').value, '검색공통');
  assert.match(ui.document.querySelector('[data-author-map-count]').textContent, /1\/2개/);
  assert.equal(ui.document.querySelector('.selected-editor .editor'), null);
  const visible = [...ui.document.querySelectorAll('.map-task')].filter(node => !node.closest('li').hidden && !node.closest('.group-card').hidden);
  assert.deepEqual(visible.map(node => node.dataset.taskId), [remaining.id]);
  await click('지도 검색 지우기');
  assert.match(ui.document.querySelector('[data-author-map-count]').textContent, /2\/2개/);
  assert.equal(networkAttempts.length, 0);
});

test('home presents two purpose-based starts and does not expose a saved document navigation before choosing it', async () => {
  const doc = createDocument({ tasks: [createTask({ title: '보관된 합성 업무', method: '보관된 방법' })] });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  const before = ui.localStorage.getItem(DATA_KEY);
  assert.deepEqual([...ui.document.querySelectorAll('.start-card strong')].map(node => node.textContent), ['인수인계서 만들기', '받은 인수인계서 보기']);
  assert.equal(ui.document.querySelector('.top-nav'), null);
  assert.equal(ui.document.querySelector('.hero-preview'), null);
  await click('받은 인수인계서 보기', ui.document.querySelector('.start-grid'), { includes: true });
  assert.match(ui.document.querySelector('dialog').textContent, /이 앱에서 전달받은 .json 파일/);
  assert.match(ui.document.querySelector('dialog').textContent, /암호화되지/);
  assert.equal(ui.localStorage.getItem(DATA_KEY), before);
});

test('first task needs only name and method, saves once without replacing composing inputs, and retains the same data on handoff', async () => {
  await mount();
  await startNew();
  const editor = ui.document.querySelector('.first-task-editor');
  const name = control('업무명');
  const method = control('하는 방법');
  assert.deepEqual([...editor.querySelectorAll('input:not([hidden]),textarea,select')], [name, method]);
  assert.equal(savedDocument().tasks.length, 0, 'opening the editor creates no empty task');
  await fill('업무명', ' ');
  assert.equal(savedDocument().tasks.length, 0, 'whitespace is not a new task');
  name.focus();
  name.dispatchEvent(new ui.Event('compositionstart', { bubbles: true }));
  for (const value of ['ㅎ', '한', '한글로 적는 업무']) {
    name.value=value;
    name.dispatchEvent(new ui.Event('input', { bubbles: true }));
    await settle();
    assert.equal(control('업무명'), name, 'composition retains the actual input node');
    assert.equal(ui.document.activeElement, name);
    assert.equal(ui.document.querySelector('.first-task-editor'), editor);
    assert.equal(savedDocument().tasks.length, 1);
  }
  name.dispatchEvent(new ui.Event('compositionend', { bubbles: true }));
  const taskId = savedDocument().tasks[0].id;
  await fill('하는 방법', '무엇을 하는지 기록합니다.\n방법은 원문 그대로\t보존합니다.');
  assert.equal(control('하는 방법'), method);
  const doc = savedDocument();
  assert.equal(doc.tasks[0].id, taskId);
  assert.equal(doc.groups.length, 0);
  assert.equal(doc.tasks[0].timing.kind, 'event');
  assert.equal(doc.tasks[0].timing.trigger, '');
  assert.equal(doc.tasks[0].ownerRole, '');
  assert.equal(ui.document.querySelector('.map-task').dataset.taskId, taskId);
  assert.equal(ui.document.querySelector('.map-calendar').closest('details').open, false);
  assert.match(ui.document.querySelector('[data-save-status]').textContent, /임시저장됨/);
  const json = await backupText();
  assert.deepEqual(parseImport(json).document.tasks, doc.tasks);
  await click('받는 사람 화면 확인');
  await click(ui.document.querySelector('.map-task'));
  assert.ok(ui.document.querySelector('dialog').textContent.includes(doc.tasks[0].method));
  assert.equal(savedDocument().tasks[0].id, taskId);
  assert.equal(networkAttempts.length, 0);
});

test('selected task keeps the overview alongside two initial inputs and retains optional timing after each change', async () => {
  const task = createTask({ title: '합성 선택 업무', method: '간단한 방법' });
  const doc = createDocument({ tasks: [task] });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('이어서 작성');
  await click(ui.document.querySelector('.map-task'));
  const workspace = ui.document.querySelector('.author-workspace');
  assert.ok(workspace.querySelector(':scope > .map-workspace'));
  assert.ok(workspace.querySelector(':scope > .selected-editor'));
  const editor = ui.document.querySelector('.selected-editor .editor');
  const initiallyShown = [...editor.querySelectorAll('input,select,textarea')].filter(node => !node.hidden&&!node.closest('details:not([open])'));
  assert.deepEqual(initiallyShown.map(node => node.labels[0].textContent), ['업무명', '하는 방법']);
  assert.equal(ui.document.querySelector('.map-calendar').closest('details').open, false);
  await fill('주담당 역할', '검증 담당');
  await fill('수행 시점', 'regular');
  assert.equal(control('주담당 역할').closest('details').open, true);
  assert.equal(control('수행 시점').closest('details').open, true);
  await fill('반복 주기', 'monthly');
  assert.equal(control('반복 주기').closest('details').open, true);
  await fill('월 안에서 언제 하나요?', 'monthEnd');
  assert.equal(control('월 안에서 언제 하나요?').closest('details').open, true);
  assert.equal(savedDocument().tasks[0].timing.dayRule, 'monthEnd');
  assert.equal(savedDocument().tasks[0].method, task.method);
  assert.equal(savedDocument().tasks[0].id, task.id);
});

test('reader starts with every undated task and keeps an active optional role filter visible without changing the handoff data', async () => {
  const tasks = [createTask({ title: '날짜 없이도 보이는 업무', method: '필요한 때 찾아볼 설명', ownerRole: '담당 A' }), createTask({ title: '다른 역할의 업무', method: '다른 설명', ownerRole: '담당 B' })];
  const doc = createDocument({ tasks });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('인수자 보기', ui.document.querySelector('.document-card'));
  const before = ui.localStorage.getItem(DATA_KEY);
  assert.deepEqual([...ui.document.querySelectorAll('.reader-nav > button')].map(node => node.textContent), ['업무 전체', '언제 하는 일', '지금 이어받을 건']);
  assert.equal(ui.document.querySelectorAll('.work-map .map-task').length, 2);
  assert.equal(control('주담당 역할로 업무 보기').closest('details').open, false);
  await fill('주담당 역할로 업무 보기', '담당 A');
  assert.equal(control('주담당 역할로 업무 보기').closest('details').open, true);
  assert.equal(ui.document.querySelectorAll('.work-map .map-task').length, 1);
  await click('이번 주', ui.document.querySelector('.reader-nav'));
  assert.equal(control('주담당 역할로 업무 보기').closest('details').open, true);
  await fill('업무나 상황 찾기', '날짜 없이도');
  assert.match(ui.document.querySelector('#reader-results').textContent, /기간과 관계없이 선택한 주담당 역할/);
  assert.ok(ui.document.querySelector('#reader-results').textContent.includes(tasks[0].title));
  await click('상황별', ui.document.querySelector('.reader-nav'));
  assert.equal(button('상황별', ui.document.querySelector('.reader-nav')).closest('details').open, true);
  assert.equal(ui.document.querySelector('.read-card').open, false);
  assert.match(ui.document.querySelector('.read-card summary').textContent, /업무 설명 보기/);
  assert.equal(ui.document.querySelector('.read-card input[type=checkbox]'), null);
  assert.equal(ui.localStorage.getItem(PROGRESS_KEY), null);
  assert.equal(ui.localStorage.getItem(DATA_KEY), before);
  assert.equal(networkAttempts.length, 0);
});

test('full document download stays complete after a partial choice while advanced export tools start closed', async () => {
  const tasks = [createTask({ title: '선택한 전체출력 업무', method: '남길 방법' }), createTask({ title: '선택하지 않은 전체출력 업무', method: '전체 문서에는 포함될 방법' })];
  const item = createCase({ title: '전체출력 진행 건', nextAction: '전체에 포함될 다음 행동' });
  const doc = createDocument({ tasks, cases: [item] });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('이어서 작성');
  await click('내보내기', ui.document.querySelector('.top-nav'));
  assert.equal(ui.document.querySelector('.export-selection').closest('details').open, false);
  assert.equal(button('AI용 내용 미리보기').closest('details').open, false);
  assert.equal(button('업무 안내 전체 받기 (.docx)').closest('details'), null);
  assert.match(button('전달·백업 파일 받기 (.json)').closest('.callout').textContent, /출처 원문[\s\S]*암호화되지/);
  await click('선택 해제');
  const selected=control(tasks[0].title, ui.document.querySelector('.export-selection'));
  selected.checked=true;selected.dispatchEvent(new ui.Event('change', { bubbles: true }));
  await settle();
  await click('업무 안내 전체 받기 (.docx)');
  for(let attempt=0;attempt<100&&!downloads.length;attempt++)await new Promise(resolve=>originalSetTimeout(resolve,10));
  assert.equal(downloads.length,1);
  const bytes=new Uint8Array(await downloads.at(-1).blob.arrayBuffer());
  const xml=strFromU8(unzipSync(bytes)['word/document.xml']);
  assert.ok(xml.includes(tasks[0].title));
  assert.ok(xml.includes(tasks[1].title));
  assert.ok(xml.includes(item.title));
  assert.match(ui.document.querySelector('[data-export-selection-count]').textContent, /업무 1\/2개 · 진행 건 0\/1개/);
  assert.equal(control('연락할 역할·회신 대기 포함').checked, false);
  assert.equal(control('준비자료 포함').checked, false);
  assert.equal(control('근거 포함').checked, false);
  assert.equal(networkAttempts.length, 0);
});

async function selectOutputItems(items) {
  await click('선택 해제');
  const list = ui.document.querySelector('.export-selection');
  for (const item of items) {
    const checkbox = control(item.title, list);
    checkbox.checked = true;
    checkbox.dispatchEvent(new ui.Event('change', { bubbles: true }));
  }
  await settle();
}

test('DOM PDF output asks for each selected item, and blank, invalid or cancelled choices leave legacy JSON untouched', async () => {
  const doc = reviewExampleDocument();
  const task = doc.tasks[0], item = doc.cases[0];
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('이어서 작성');
  await click('내보내기', ui.document.querySelector('.top-nav'));
  await selectOutputItems([task, item]);
  const before = snapshot();
  await click('선택한 업무만 문서로 받기');
  const dialog = ui.document.querySelector('dialog');
  assert.match(dialog.querySelector('h2').textContent, /함께 전달할 근거 쪽/);
  assert.equal(dialog.querySelectorAll('.output-source').length, 1, 'one shared source is shown once');
  assert.equal(dialog.querySelectorAll('.output-source input').length, 2, 'a task and its case need independent page relationships');
  assert.equal(control(`${task.title} · 근거 쪽`, dialog).value, '');
  assert.equal(control(`${item.title} · 근거 쪽`, dialog).value, '');
  for (const omitted of [...doc.tasks.slice(1), doc.cases[1]]) assert.ok(!dialog.textContent.includes(omitted.title));
  assert.deepEqual(snapshot(), before, 'opening the preflight does not upgrade or edit v3');
  await click('연결을 기억하고 함께 만들기', dialog);
  assert.match(dialog.querySelector('[role=alert]').textContent, /근거 쪽을 선택/);
  assert.deepEqual(snapshot(), before);
  await fill(`${task.title} · 근거 쪽`, '1', dialog);
  await fill(`${item.title} · 근거 쪽`, '3', dialog);
  await click('연결을 기억하고 함께 만들기', dialog);
  assert.match(dialog.querySelector('[role=alert]').textContent, /1~2쪽 사이/);
  assert.deepEqual(snapshot(), before, 'a valid first choice is not committed before a later invalid choice fails');
  assert.equal(downloads.length, 0);
  await fill(`${item.title} · 근거 쪽`, '2', dialog);
  await click('취소', dialog);
  assert.equal(ui.document.querySelector('dialog'), null);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(savedDocument(), doc);
  assert.equal(savedDocument().schemaVersion, 3);
  assert.ok([...savedDocument().tasks, ...savedDocument().cases].every(record => !Object.hasOwn(record, 'sourcePages')));
  assert.equal(downloads.length, 0);
  assert.equal(networkAttempts.length, 0);
});

test('DOM PDF preflight reuses one item’s confirmed pages without assigning them to other selected items', async () => {
  const doc = reviewExampleDocument();
  doc.schemaVersion = CURRENT_SCHEMA_VERSION;
  const sourceId = doc.sourceFiles[0].id;
  const confirmed = doc.tasks[0], pending = doc.tasks[1];
  confirmed.sourcePages = [{ sourceId, pages: [1] }];
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('이어서 작성');
  await click('내보내기', ui.document.querySelector('.top-nav'));
  await selectOutputItems([confirmed, pending]);
  const before = snapshot();
  await click('인쇄 보기');
  let dialog = ui.document.querySelector('dialog');
  assert.equal(dialog.querySelectorAll('.output-source input').length, 1);
  assert.equal(control(`${pending.title} · 근거 쪽`, dialog).value, '');
  assert.ok(![...dialog.querySelectorAll('label')].some(label => label.textContent === `${confirmed.title} · 근거 쪽`));
  await click('취소', dialog);
  assert.equal(ui.document.querySelector('.print-sheet'), null, 'cancelling does not open a print view with missing evidence');
  assert.deepEqual(snapshot(), before);
  await click('근거 쪽 연결 확인·바꾸기');
  dialog = ui.document.querySelector('dialog');
  assert.equal(control(`${confirmed.title} · 근거 쪽`, dialog).value, '1', 'the stored choice can be explicitly reviewed');
  assert.equal(control(`${pending.title} · 근거 쪽`, dialog).value, '');
  await fill(`${confirmed.title} · 근거 쪽`, '2', dialog);
  await click('취소', dialog);
  assert.deepEqual(snapshot(), before, 'cancelled review leaves the previous confirmed relationship unchanged');
  assert.deepEqual(savedDocument().tasks[0].sourcePages, [{ sourceId, pages: [1] }]);
  assert.equal(Object.hasOwn(savedDocument().tasks[1], 'sourcePages'), false);
  assert.equal(downloads.length, 0);
});

test('DOM output reuses a complete saved page choice, but canvas failure produces no download or document mutation', async () => {
  const doc = reviewExampleDocument();
  doc.schemaVersion = CURRENT_SCHEMA_VERSION;
  const task = doc.tasks[0];
  task.sourcePages = [{ sourceId: doc.sourceFiles[0].id, pages: [1] }];
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('이어서 작성');
  await click('내보내기', ui.document.querySelector('.top-nav'));
  await selectOutputItems([task]);
  const before = snapshot();
  const prototype = ui.HTMLCanvasElement.prototype;
  const originalContext = prototype.getContext;
  prototype.getContext = () => { throw new Error('가상 캔버스 실패'); };
  try {
    await click('선택한 업무만 문서로 받기');
    assert.equal(ui.document.querySelector('dialog'), null, 'a complete saved relationship is reused without a repeated page prompt');
    for (let attempt = 0; attempt < 100 && !ui.document.querySelector('#notice').textContent.includes('실패'); attempt++) {
      await new Promise(resolve => originalSetTimeout(resolve, 10));
    }
    assert.match(ui.document.querySelector('#notice').textContent, /문서 생성 실패/);
    assert.equal(downloads.length, 0, 'failure cannot silently download an output without the required page');
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(savedDocument(), doc);
  } finally { prototype.getContext = originalContext; }
});

test('DOM newly confirmed page input is not persisted or upgraded when the page cannot render', async () => {
  const doc = reviewExampleDocument();
  const task = doc.tasks[0];
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('이어서 작성');
  await click('내보내기', ui.document.querySelector('.top-nav'));
  await selectOutputItems([task]);
  const before = snapshot();
  await click('선택한 업무만 문서로 받기');
  const dialog = ui.document.querySelector('dialog');
  await fill(`${task.title} · 근거 쪽`, '1', dialog);
  const prototype = ui.HTMLCanvasElement.prototype;
  const originalContext = prototype.getContext;
  prototype.getContext = () => { throw new Error('가상 캔버스 실패'); };
  try {
    await click('연결을 기억하고 함께 만들기', dialog);
    for (let attempt = 0; attempt < 100 && !dialog.querySelector('[role=alert]'); attempt++) {
      await new Promise(resolve => originalSetTimeout(resolve, 10));
    }
    assert.match(dialog.querySelector('[role=alert]').textContent, /출력을 완료하지 못했습니다/);
    assert.equal(downloads.length, 0);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(savedDocument(), doc);
    assert.equal(savedDocument().schemaVersion, 3);
    assert.equal(Object.hasOwn(savedDocument().tasks[0], 'sourcePages'), false);
    assert.equal(button('연결을 기억하고 함께 만들기', dialog).disabled, false);
    await click('취소', dialog);
    assert.deepEqual(snapshot(), before);
  } finally { prototype.getContext = originalContext; }
});

test('counted UI paths take 3 actions for an ungrouped first draft and 13 for the same three-groups-first workflow', async () => {
  const run=async groupFirst=>{
    await mount();
    let actions=0;
    const press=async(name,root)=>{actions++;await click(name,root);};
    const enter=async(label,value)=>{actions++;await fill(label,value);};
    await press([...ui.document.querySelectorAll('.start-card')].find(node=>node.querySelector('strong')?.textContent==='인수인계서 만들기'));
    if(groupFirst){
      for(const title of ['정기 운영','행사 지원','자료 관리']){
        await press('＋ 큰 업무 영역');
        await enter('큰 업무 이름',title);
        await press('영역 만들기',ui.document.querySelector('dialog'));
      }
      await press('＋ 세부 업무',groupCard('정기 운영'));
    }
    await enter('업무명','합성 행동수 확인 업무');
    await enter('하는 방법','아는 업무의 방법을 먼저 적습니다.');
    const doc=savedDocument();
    assert.equal(doc.tasks.length,1);
    assert.equal(doc.tasks[0].title,'합성 행동수 확인 업무');
    assert.equal(doc.tasks[0].method,'아는 업무의 방법을 먼저 적습니다.');
    assert.equal(doc.groups.length,groupFirst?3:0);
    assert.equal(doc.tasks[0].groupId,groupFirst?doc.groups[0].id:'');
    assert.equal(doc.tasks[0].timing.trigger,'');
    return actions;
  };
  const firstDraft=await run(false);
  const threeGroupsFirst=await run(true);
  assert.equal(firstDraft,3);
  assert.equal(threeGroupsFirst,13);
  console.info(`DOM action count (one click or one whole-field fill): first draft=${firstDraft}, three groups then one task=${threeGroupsFirst}; grouping outcomes differ.`);
});

test('legacy status is not certified; explicit case completion is portable and never completes its task', async()=>{
  const task=createTask({title:'가상 연결 업무',method:'원문 그대로 보존',firstAction:'확인 요청을 연다.'});
  const record=createCase({title:'가상 상태 확인 기록',taskId:task.id,status:'done',nextAction:'현재 상태를 다시 확인'});
  delete record.statusConfirmed;
  const doc=createDocument({tasks:[task],cases:[record]});
  await mount({[DATA_KEY]:JSON.stringify([doc]),[CURRENT_KEY]:doc.id});
  await click('인수자 보기',ui.document.querySelector('.document-card'));
  await click('지금 이어받을 건');
  assert.match(ui.document.querySelector('.case-card').textContent,/상태 미확인/);
  assert.match(ui.document.querySelector('#reader-results').textContent,/상태를 확인할 기록 1개/);
  assert.equal(savedDocument().cases[0].status,'done');
  assert.equal(savedDocument().cases[0].statusConfirmed,undefined);
  assert.equal(control('이 건의 현재 상태').value,'unknown');
  await fill('이 건의 현재 상태','done');
  assert.equal(savedDocument().cases[0].statusConfirmed,true);
  assert.match(ui.document.querySelector('.reader-count').textContent,/이어받을 건 0개 · 상태 확인할 기록 0개/);
  assert.deepEqual(savedDocument().tasks[0],task);
  const json=await backupText();
  await mount();
  const copy=await importJsonThroughUI(json);
  assert.equal(copy.cases[0].status,'done');
  assert.equal(copy.cases[0].statusConfirmed,true);
  assert.equal(copy.cases[0].taskId,copy.tasks[0].id);
  assert.equal(ui.localStorage.getItem(PROGRESS_KEY),null);
});

test('search title opens a full task and returns to the same query, result, focus and scroll',async()=>{
  const task=createTask({title:'가상 반환 업무',method:'공개 가상 방법',firstAction:'요청 목록을 연다.'});
  const doc=createDocument({tasks:[task]});
  await mount({[DATA_KEY]:JSON.stringify([doc]),[CURRENT_KEY]:doc.id});
  await click('인수자 보기',ui.document.querySelector('.document-card'));
  await fill('업무나 상황 찾기','반환');
  const summary=ui.document.querySelector('.task-result > summary');
  Object.defineProperty(ui,'scrollY',{value:314,writable:true,configurable:true});
  ui.scrollTo=(_x,y)=>{ui.scrollY=y;};
  await click(summary);
  assert.match(ui.document.querySelector('dialog .first-action').textContent,/요청 목록을 연다/);
  assert.doesNotMatch(ui.document.querySelector('dialog').textContent,/null|undefined/);
  ui.scrollY=0;
  await click('목록으로 돌아가기',ui.document.querySelector('dialog'));
  assert.equal(control('업무나 상황 찾기').value,'반환');
  assert.equal(ui.document.querySelector('.task-result > summary'),summary);
  assert.equal(ui.document.activeElement,summary);
  assert.equal(ui.scrollY,314);
  assert.equal(ui.document.querySelector('dialog'),null);
});

for (const [variant, method, steps, label] of [
  ['basic body', '1. 예약 명단에서 이름을 확인합니다.\n2. 이름이 없으면 담당 역할에게 묻습니다.', '', '하는 방법'],
  ['legacy steps only', '', '1. 요청 목록을 엽니다.\n2. 빠진 내용을 표시합니다.', '진행 순서'],
  ['blank body and meaningful steps', '   ', '1. 보관된 요청을 엽니다.\n2. 조건을 확인합니다.', '진행 순서'],
]) {
  test(`DOM reader uses ${variant} without requiring a duplicate first-action entry or changing stored text`, async () => {
    const task = createTask({ title: '가상 시작 안내 확인', method, steps, firstAction: '' });
    const doc = createDocument({ tasks: [task] });
    await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
    await click('인수자 보기', ui.document.querySelector('.document-card'));
    const before = snapshot();
    await fill('업무나 상황 찾기', '시작 안내');
    const result = ui.document.querySelector('.task-result');
    assert.match(result.querySelector('summary').textContent, /본문 안내 있음/);
    await click(result.querySelector('summary'));
    const detail = ui.document.querySelector('dialog .task-detail');
    const instruction = [...detail.querySelectorAll('.read-block')].find(node => node.querySelector('h4')?.textContent === label);
    assert.ok(instruction, 'the authored execution block is directly present in the opened detail');
    assert.equal(instruction.querySelector('p').textContent, steps || method);
    assert.equal(instruction.closest('details'), null, 'the existing instructions do not require expanding background details');
    assert.equal(detail.querySelector('.first-action'), null, 'no new first action is invented from the body');
    assert.doesNotMatch(detail.textContent, /첫 행동이 별도로|먼저 할 일이 아직|실행 안내가 아직 없습니다/);
    await click('목록으로 돌아가기', ui.document.querySelector('dialog'));
    assert.equal(control('업무나 상황 찾기').value, '시작 안내');
    assert.deepEqual(savedDocument().tasks[0], task);
    assert.deepEqual(snapshot(), before, 'reading must not fill or normalize any authored field');
    assert.equal(networkAttempts.length, 0);
  });
}

test('DOM reader keeps truly missing execution text visible and preserves an explicitly written first action', async () => {
  const empty = createTask({ title: '가상 실행 내용 없음', method: '   ', steps: '', firstAction: '' });
  const explicit = createTask({ title: '가상 별도 시작 안내', method: '본문의 나머지 방법입니다.', firstAction: '인계자에게 현재 조건을 먼저 확인합니다.' });
  const doc = createDocument({ tasks: [empty, explicit] });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('인수자 보기', ui.document.querySelector('.document-card'));
  const before = snapshot();
  await click(ui.document.querySelector(`[data-task-id="${empty.id}"]`));
  assert.match(ui.document.querySelector('dialog .task-detail').textContent, /실행 안내가 아직 없습니다/);
  assert.equal(ui.document.querySelector('dialog .first-action'), null);
  await click('목록으로 돌아가기', ui.document.querySelector('dialog'));
  await click(ui.document.querySelector(`[data-task-id="${explicit.id}"]`));
  assert.equal(ui.document.querySelector('dialog .first-action').textContent, explicit.firstAction);
  assert.ok(ui.document.querySelector('dialog').textContent.includes(explicit.method));
  assert.deepEqual(snapshot(), before);
});

test('DOM search switches to a filtered calendar and case view, returns without retyping, and preserves unknown states and reading context', async () => {
  const monthly = createTask({ title: '촬영 월말 점검', method: '접수한 조건을 점검합니다.', timing: { kind: 'regular', cadence: 'monthly', dayRule: 'monthEnd' } });
  const unresolved = createTask({ title: '촬영 월초 확인', method: '정확한 날짜는 아직 모릅니다.', timing: { kind: 'regular', cadence: 'monthly', dayRule: 'monthStartUnconfirmed' } });
  const outside = createTask({ title: '무관한 재고 점검', method: '재고를 확인합니다.', timing: { kind: 'regular', cadence: 'monthly', dayRule: 'monthEnd' } });
  const waiting = createCase({ title: '회신 기록 A', taskId: monthly.id, status: 'waiting', statusConfirmed: true, nextAction: '응답을 확인합니다.' });
  const unknown = createCase({ title: '촬영 상태 미확인', status: 'unknown', statusConfirmed: false, nextAction: '현재 상태를 확인합니다.' });
  const legacy = createCase({ title: '촬영 이전 기록', status: 'done', nextAction: '옛 기록의 현재 상태를 확인합니다.' });
  delete legacy.statusConfirmed;
  const omitted = createCase({ title: '무관한 재고 기록', taskId: outside.id, status: 'waiting', statusConfirmed: true });
  const doc = createDocument({ tasks: [monthly, unresolved, outside], cases: [waiting, unknown, legacy, omitted] });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('인수자 보기', ui.document.querySelector('.document-card'));
  const before = snapshot();
  await fill('업무나 상황 찾기', '촬영');
  const resultTitles = () => [...ui.document.querySelectorAll('#reader-results .read-title h3')].map(node => node.textContent);
  const originalResults = resultTitles();
  assert.deepEqual(originalResults, [monthly.title, unresolved.title, unknown.title, legacy.title]);
  Object.defineProperty(ui, 'scrollY', { value: 314, writable: true, configurable: true });
  ui.scrollTo = (_x, y) => { ui.scrollY = y; };
  await click('언제 하는 일', ui.document.querySelector('.reader-nav'));
  assert.equal(control('업무나 상황 찾기').value, '촬영');
  assert.ok(ui.document.querySelector('#reader-results .calendar-table'), 'calendar must actually render, not the old global search list');
  assert.equal(ui.document.querySelector('#reader-results .task-result'), null);
  assert.match(ui.document.querySelector('.calendar-summary').textContent, /업무 1개/);
  assert.ok(ui.document.querySelector('.calendar-unresolved').textContent.includes(unresolved.title));
  assert.ok(!ui.document.querySelector('.calendar-table').textContent.includes(unresolved.title), 'unknown month-start date must not become day one');
  assert.ok(!ui.document.querySelector('#reader-results').textContent.includes(outside.title));
  await click(ui.document.querySelector('[data-calendar-action="next"]'));
  const calendarTitle = ui.document.querySelector('.calendar-title').textContent;
  ui.scrollY = 210;
  await click('지금 이어받을 건', ui.document.querySelector('.reader-nav'));
  assert.equal(control('업무나 상황 찾기').value, '촬영');
  assert.equal(ui.document.querySelector('#reader-results .calendar-table'), null);
  assert.match(ui.document.querySelector('#reader-results').textContent, /상태를 확인할 기록 2개/);
  assert.match(ui.document.querySelector('#reader-results').textContent, /진행 중인 건 1개/);
  const cards = [...ui.document.querySelectorAll('#reader-results .case-card')];
  assert.equal(cards.length, 3);
  assert.ok(cards.some(card => card.textContent.includes(waiting.title)), 'a case linked to a matched task remains findable even without the query in its own text');
  assert.ok(!cards.some(card => card.textContent.includes(omitted.title)));
  for (const record of [unknown, legacy]) {
    const card = cards.find(node => node.textContent.includes(record.title));
    assert.equal(control('이 건의 현재 상태', card).value, 'unknown');
    assert.match(card.querySelector('summary').textContent, /상태 미확인/);
  }
  await click('업무 전체', ui.document.querySelector('.reader-nav'));
  assert.equal(control('업무나 상황 찾기').value, '촬영');
  assert.deepEqual(resultTitles(), originalResults);
  assert.equal(ui.scrollY, 314, 'the prior result-list position is restored');
  await click('언제 하는 일', ui.document.querySelector('.reader-nav'));
  assert.equal(ui.document.querySelector('.calendar-title').textContent, calendarTitle, 'calendar period survives a view round trip');
  assert.equal(ui.scrollY, 210, 'the calendar has its own return position');
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(savedDocument(), doc, 'viewing must neither certify nor reset any case status');
  assert.equal(networkAttempts.length, 0);
});

test('DOM empty filtered views state the retained query and offer a return without retyping or silent clearing', async () => {
  const task = createTask({ title: '촬영 설명만 있는 업무', method: '예외 조건을 읽습니다.', timing: { kind: 'event', trigger: '요청이 들어오면' } });
  const doc = createDocument({ tasks: [task] });
  await mount({ [DATA_KEY]: JSON.stringify([doc]), [CURRENT_KEY]: doc.id });
  await click('인수자 보기', ui.document.querySelector('.document-card'));
  const before = snapshot();
  await fill('업무나 상황 찾기', '촬영');
  await click('지금 이어받을 건', ui.document.querySelector('.reader-nav'));
  assert.equal(control('업무나 상황 찾기').value, '촬영');
  assert.match(ui.document.querySelector('#reader-results').textContent, /‘촬영’에 맞는 진행 건이 없습니다/);
  await click('업무 전체 검색으로 돌아가기', ui.document.querySelector('#reader-results'));
  assert.equal(control('업무나 상황 찾기').value, '촬영');
  assert.equal(ui.document.querySelector('.task-result h3').textContent, task.title);
  await fill('업무나 상황 찾기', '존재하지않는가상단어');
  await click('언제 하는 일', ui.document.querySelector('.reader-nav'));
  assert.equal(control('업무나 상황 찾기').value, '존재하지않는가상단어');
  assert.ok(ui.document.querySelector('.calendar-table'));
  assert.match(ui.document.querySelector('#reader-results').textContent, /‘존재하지않는가상단어’에 맞는 업무 일정이 없습니다/);
  await click('업무 전체 검색으로 돌아가기', ui.document.querySelector('#reader-results'));
  assert.equal(control('업무나 상황 찾기').value, '존재하지않는가상단어');
  assert.match(ui.document.querySelector('#reader-results').textContent, /검색 결과 0개/);
  await click('언제 하는 일', ui.document.querySelector('.reader-nav'));
  await click('검색 지우기', ui.document.querySelector('#reader-results'));
  assert.equal(control('업무나 상황 찾기').value, '', 'clearing occurs only after the explicit clear action');
  assert.ok(ui.document.querySelector('.calendar-unresolved').textContent.includes(task.title));
  assert.deepEqual(snapshot(), before);
});

test('an AI plain-text reply upgrades a legacy document without requiring JSON repair',async()=>{
  const legacy=createDocument({schemaVersion:2,title:'구 형식 AI 가상 자료'});
  await mount({[DATA_KEY]:JSON.stringify([legacy]),[CURRENT_KEY]:legacy.id});await click('이어서 작성');await click('AI로 초안 만들기');
  const raw='가상 업무 답글\n요청 내용을 확인한다. 형식 { 가 완성되지 않아도 메모를 남긴다.';
  await fill('AI의 답글',raw);
  await click('일반 글로 추가',ui.document.querySelector('dialog'));
  assert.equal(savedDocument().tasks.length,1);
  assert.equal(savedDocument().tasks[0].method,raw);
  assert.equal(savedDocument().schemaVersion,CURRENT_SCHEMA_VERSION);
  assert.equal(legacy.tasks.length,0);
  assert.equal(savedDocument().tasks[0].firstAction,'');
  assert.equal(networkAttempts.length,0);
});


test('a PDF opened directly from a case has a return history entry and search states its limits',async()=>{
  const {reviewExampleDocument}=await import('../src/review-example.js');
  const doc=reviewExampleDocument();
  await mount({[DATA_KEY]:JSON.stringify([doc]),[CURRENT_KEY]:doc.id});
  await click('인수자 보기',ui.document.querySelector('.document-card'));
  assert.match(ui.document.querySelector('.search-box').textContent,/PDF·사진 속 글은 검색되지/);
  await click('지금 이어받을 건');
  const card=[...ui.document.querySelectorAll('.case-card')].find(n=>n.textContent.includes('PDF 원문 보기'));
  const priorLength=ui.history.length;
  await click('PDF 원문 보기 · 2쪽',card);
  assert.ok(ui.document.querySelector('dialog').dataset.navigationId);
  assert.equal(ui.history.length,priorLength+1);
  assert.ok(ui.history.state.handoverDialog);
  await click('업무로 돌아가기',ui.document.querySelector('dialog'));
  assert.equal(ui.document.querySelector('dialog'),null);
  assert.ok(ui.document.querySelector('.case-card'));
});
