import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { createDocument, createTask, makeId, parseImport, stringifyDocument, validateDocument, dateISO } from '../src/model.js';
import { DATA_KEY, CURRENT_KEY, PROGRESS_KEY, loadDocuments } from '../src/storage.js';
import { exportAIText, exportDocx } from '../src/exporters.js';
import { AUTHOR_PROMPT, parseAIDraft } from '../src/ai-draft.js';

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

async function click(name, root = ui.document, options) {
  const target = typeof name === 'string' ? button(name, root, options) : name;
  assert.ok(target);
  assert.equal(target.disabled, false, 'target must be enabled');
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
  const card = [...ui.document.querySelectorAll('.start-card')].find(node => node.querySelector('strong')?.textContent === '새로 작성');
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
  const card = [...ui.document.querySelectorAll('.start-card')].find(node => node.querySelector('strong')?.textContent === 'JSON 불러오기');
  await click(card);
  const input = control('인수인계 JSON 파일 선택');
  const transfer = new ui.DataTransfer();
  transfer.items.add(new ui.File([text], '가상-전달자료.json', { type: 'application/json' }));
  input.files = transfer.files;
  input.dispatchEvent(new ui.Event('change', { bubbles: true }));
  await settle();
  assert.equal(ui.document.querySelector('.import-preview .error'), null);
  assert.match(ui.document.querySelector('.import-preview').textContent, /기존 문서를 덮어쓰지 않습니다/);
  await click('새 사본으로 불러오기', ui.document.querySelector('dialog'));
  return savedDocument();
}

async function backupText() {
  await click('JSON 백업');
  const download = downloads.at(-1);
  assert.match(download.filename, /\.json$/);
  return download.blob.text();
}

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
  const checkbox = ui.document.querySelector('#reader-results input[type=checkbox]');
  assert.ok(checkbox);
  checkbox.checked = true;
  checkbox.dispatchEvent(new ui.Event('change', { bubbles: true }));
  await settle();
  assert.equal(ui.localStorage.getItem(DATA_KEY), before, 'reader checks must not mutate the original document');
  assert.ok(ui.localStorage.getItem(PROGRESS_KEY));
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
  assert.equal(ui.document.querySelectorAll('img, script, [onerror]').length, 0);
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
        await fill('AI의 구조화 결과', aiDraftRaw);
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
  assert.equal(ui.document.querySelector('.reader-nav [aria-pressed="true"]').textContent, '전체 업무');
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
  for (const card of ui.document.querySelectorAll('.start-card')) assert.equal(card.disabled, true);
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

test('review splits and merges editable drafts while preserving extracted source text',async()=>{
 await mount();await startNew();await click('메모 붙여넣기');await fill('붙여넣을 내용','원문 제목\n원래 메모');await click('초안 검토',ui.document.querySelector('dialog'));
 await fill('추출한 내용','업무 A\n설명 A\n\n업무 B\n설명 B',ui.document.querySelector('.draft-block'));
 await click('빈 줄로 나누기');assert.equal(ui.document.querySelectorAll('.draft-block').length,2);
 await click('다음 초안과 합치기',ui.document.querySelector('.draft-block'));assert.equal(ui.document.querySelectorAll('.draft-block').length,1);
 await click('현재 문서에 업무 추가',ui.document.querySelector('dialog'));
 const doc=savedDocument();assert.equal(doc.tasks.length,1);assert.match(doc.tasks[0].method,/업무 A[\s\S]*업무 B/);assert.match(doc.sourceFiles[0].excerpt,/원래 메모/);
});

test('starting a document import from home creates a new document instead of appending to the previously selected one',async()=>{
 await mount();await startNew();const originalId=savedDocument().id;await click(ui.document.querySelector('.brand-button'));
 const card=[...ui.document.querySelectorAll('.start-card')].find(n=>n.querySelector('strong')?.textContent==='기존 문서로 시작');await click(card);
 await click('직접 붙여넣기',ui.document.querySelector('dialog'));await fill('붙여넣을 내용','새 문서의 업무\n새 문서의 방법');await click('초안 검토',ui.document.querySelector('dialog'));
 await click('새 인수인계로 만들기',ui.document.querySelector('dialog'));
 const docs=loadDocuments(ui.localStorage);assert.equal(docs.length,2);assert.equal(docs.find(d=>d.id===originalId).tasks.length,0);assert.notEqual(savedDocument().id,originalId);assert.equal(savedDocument().tasks.length,1);
});
