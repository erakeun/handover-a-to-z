import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { exportDocx, exportAIText } from '../src/exporters.js';

const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const now = '2026-10-20T09:00:00.000Z';

function task(id, title, timing = {}) {
  return {
    id, title,
    timing: {
      kind: 'regular', cadence: 'monthly', weekday: '', day: 10, month: '',
      date: '', trigger: '', anchorDate: '', offsetDays: '', startRule: '',
      ...timing,
    },
    method: '담당자가 신청 내역을 검토한 뒤 결재를 요청합니다.',
    purpose: '정확한 신청 처리',
    materials: `MATERIAL_SECRET_${id}`,
    steps: '  첫 줄의 공백을 보존\r\n둘째 줄\r\n\r\n열 하나\t열 둘 & <literal>\n마지막 줄  ',
    contacts: `CONTACT_SECRET_${id}`,
    ownerRole: `OWNER_ROLE_SECRET_${id}`,
    supportRole: `SUPPORT_ROLE_SECRET_${id}`,
    approval: '팀장 검토 후 승인',
    exceptions: '누락이 있으면 보완을 요청',
    doneWhen: '승인 및 통보가 끝남',
    evidence: `EVIDENCE_SECRET_${id}`,
    verifiedAt: '2026-10-20', accessChecked: true,
    sourceRefs: ['source-1'], firstDay: true, firstWeek: false,
  };
}

function fixture() {
  return {
    schemaVersion: 1, id: 'document-synthetic-export', title: '검증용 가상 한글 인수인계서',
    createdAt: now, updatedAt: now,
    onboarding: { dayOne: '첫날 계정을 확인합니다.\n권한 승인 상태도 확인합니다.', firstWeek: '첫 주에는 담당 업무를 함께 수행합니다.' },
    tasks: [task('task-1', '정기 보고서 작성'), task('task-2', '미선택 업무 고유 제목')],
    cases: [{
      id: 'case-1', title: '검증용 미처리 신청', status: 'waiting',
      nextAction: '첨부 누락 여부를 확인하고 다시 제출 요청',
      dueDate: '2026-10-25', waitingFor: 'WAITING_CONTACT_SECRET',
      notes: 'CASE_NOTES_PRIVATE 원문을 확인할 것', sourceRefs: ['source-1'],
    }, {
      id: 'case-2', title: '미선택 진행 건 고유 제목', status: 'todo',
      nextAction: '미선택 고유 다음 행동', dueDate: '', waitingFor: '', notes: '', sourceRefs: [],
    }],
    sourceFiles: [{
      id: 'source-1', name: '검증용 원문.docx', format: 'docx', importedAt: now,
      excerpt: 'SOURCE_PRIVATE_EXCERPT\n항목\t설명\n보고\t마지막 데이터',
      warnings: ['표 안의 병합 셀은 원본과 대조하세요.', '원문 연락처는 직접 확인하세요.'],
    }, {
      id: 'source-unused', name: '미연결 원본 파일.pdf', format: 'pdf', importedAt: now,
      excerpt: 'UNREFERENCED_SOURCE_SECRET', warnings: ['미연결 파일의 검토 경고'],
    }],
    provenance: { originDocumentId: '가상-이전-문서', importedAt: now, retainedNotes: 'PROVENANCE_PRIVATE_NOTE' },
  };
}

function parseXml(xml, filename) {
  const issues = [];
  const parsed = new DOMParser({
    onError: (level, message) => issues.push(`${level}: ${message}`),
  }).parseFromString(xml, 'application/xml');
  assert.deepEqual(issues, [], `${filename} must be well-formed XML`);
  assert.equal(parsed.getElementsByTagName('parsererror').length, 0);
  return parsed;
}

function visibleText(node) {
  if (node.nodeType === 1 && node.namespaceURI === NS) {
    if (node.localName === 't') return node.textContent;
    if (node.localName === 'br' || node.localName === 'cr') return '\n';
    if (node.localName === 'tab') return '\t';
  }
  return Array.from(node.childNodes ?? []).map(visibleText).join('');
}

async function reopen(document, options) {
  const bytes = await exportDocx(document, options);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const zip = unzipSync(bytes);
  for (const filename of [
    '[Content_Types].xml', '_rels/.rels', 'word/document.xml',
    'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml',
  ]) assert.ok(zip[filename], `${filename} exists`);
  for (const [filename, value] of Object.entries(zip)) {
    if (filename.endsWith('.xml') || filename.endsWith('.rels')) {
      parseXml(strFromU8(value), filename);
    }
  }
  const xml = strFromU8(zip['word/document.xml']);
  const dom = parseXml(xml, 'document.xml');
  const paragraphs = Array.from(dom.getElementsByTagNameNS(NS, 'p')).map(visibleText);
  return { bytes, zip, xml, dom, paragraphs, text: paragraphs.join('\n') };
}

test('DOCX reopens as OOXML with Korean headings, onboarding, summary, details and sources', async () => {
  const document = fixture();
  const output = await reopen(document);
  for (const text of [
    document.title, '문서 생성일:', '처음 시작하는 사람을 위한 안내', '업무 한눈에 보기',
    '업무 상세', '별도 인계할 진행 건', '출처와 확인 사항',
    document.onboarding.dayOne, document.onboarding.firstWeek,
    document.tasks[0].purpose, document.tasks[0].materials, document.tasks[0].contacts,
    document.tasks[0].ownerRole, document.tasks[0].supportRole,
    document.tasks[0].approval, document.tasks[0].exceptions, document.tasks[0].doneWhen,
    document.tasks[0].evidence, document.tasks[0].verifiedAt,
    document.cases[0].nextAction, document.cases[0].waitingFor, document.cases[0].notes,
    document.sourceFiles[0].excerpt, ...document.sourceFiles[0].warnings,
    document.sourceFiles[1].excerpt, '가상-이전-문서',
  ]) assert.ok(output.text.includes(text), `preserved: ${text}`);
  assert.ok(output.text.indexOf('업무 한눈에 보기') < output.text.indexOf('업무 상세'));
  assert.ok(output.text.indexOf('업무 상세') < output.text.indexOf('별도 인계할 진행 건'));
  assert.ok(output.text.includes('암호화되지 않은 평문'));
  assert.ok(output.text.includes('직접 확인'));
  assert.equal(output.dom.getElementsByTagNameNS(NS, 'tbl').length, 2, 'summary plus final work overview');
  assert.equal(output.dom.getElementsByTagNameNS(NS, 'tblHeader').length, 2);
  assert.equal(output.dom.getElementsByTagNameNS(NS, 'trHeight').length, 0);
  assert.equal(output.dom.getElementsByTagNameNS(NS, 'cantSplit').length, 0);
  const styles = strFromU8(output.zip['word/styles.xml']);
  assert.ok(styles.includes('맑은 고딕'));
  assert.ok(styles.includes('w:eastAsia='));
  assert.ok(strFromU8(output.zip['[Content_Types].xml']).includes('wordprocessingml.document.main+xml'));
  assert.ok(strFromU8(output.zip['_rels/.rels']).includes('word/document.xml'));
  assert.ok(strFromU8(output.zip['word/footer1.xml']).includes('PAGE'));
});

test('DOCX preserves complete long Korean text, empty lines, spaces, CRLF and tabs', async () => {
  const document = fixture();
  const original = document.tasks[0].steps;
  const longText = '긴 본문 한글과 숫자 123, 문장 부호. '.repeat(3000) + '\n끝부분도 생략 없이 보존';
  document.tasks[0].method = longText;
  document.tasks[0].timing.startRule = '선행 확인\n\n승인 후 시작\t추가 확인';
  const output = await reopen(document, { taskIds: ['task-1'], caseIds: [] });
  assert.ok(output.paragraphs.includes(original.replace(/\r\n?/g, '\n')));
  assert.ok(output.paragraphs.includes(longText));
  assert.ok(output.paragraphs.some(text => text.includes(document.tasks[0].timing.startRule)));
  assert.ok(output.dom.getElementsByTagNameNS(NS, 'br').length > 0);
  assert.ok(output.dom.getElementsByTagNameNS(NS, 'tab').length > 0);
});

test('35-task DOCX consolidates 245 missing fields without changing entered content or JSON', async () => {
  const document = fixture();
  const missingFields = [
    ['materials', '준비 자료·접근 경로'], ['steps', '수행 절차'],
    ['supportRole', '지원 역할'], ['contacts', '문의 역할'],
    ['approval', '검토·승인'], ['doneWhen', '완료 기준'], ['verifiedAt', '최종 확인일'],
  ];
  document.groups = Array.from({ length: 8 }, (_, i) => ({ id: `group-${i}`, title: `가상 큰 업무 ${i}` }));
  document.tasks = Array.from({ length: 35 }, (_, i) => {
    const item = task(`scale-task-${i}`, `가상 세부 업무 ${i}`);
    item.groupId = document.groups[i % document.groups.length].id;
    item.method = `원문 ${i}\n  한글 본문의 줄바꿈과 공백  \n항목\t설명\n` + '긴 본문 보존. '.repeat(100);
    item.timing.startRule = `시작 기준 ${i}\n둘째 줄도 보존`;
    item.purpose = i === 0 ? ' \t  ' : `입력한 목적 ${i}`;
    for (const [key] of missingFields) item[key] = '';
    return item;
  });
  document.cases = [];
  const originalJSON = JSON.stringify(document);
  const output = await reopen(document);
  assert.equal(JSON.stringify(document), originalJSON, 'DOCX export must not mutate the input document');
  const missingParagraphs = output.paragraphs.filter(text => text.startsWith('미입력 항목: '));
  assert.equal(missingParagraphs.length, 35);
  for (const text of missingParagraphs) {
    assert.equal(text, `미입력 항목: ${missingFields.map(([, label]) => label).join(', ')}`);
  }
  for (const item of document.tasks) {
    for (const key of ['method', 'purpose', 'ownerRole', 'exceptions', 'evidence']) {
      assert.ok(output.paragraphs.includes(item[key]), `entered ${key} remains a complete literal paragraph`);
    }
    assert.ok(output.paragraphs.some(text => text.includes(item.timing.startRule)));
  }
  for (const source of document.sourceFiles) {
    assert.ok(output.paragraphs.includes(source.excerpt));
    for (const warning of source.warnings) assert.ok(output.text.includes(warning));
  }
  const populated = structuredClone(document);
  for (const item of populated.tasks) {
    for (const [key] of missingFields) item[key] = key === 'verifiedAt' ? '2026-10-20' : `가상 입력 ${key}`;
  }
  const populatedOutput = await reopen(populated);
  assert.equal(populatedOutput.paragraphs.length - output.paragraphs.length, 245 * 2 - 35);
  assert.equal(output.dom.getElementsByTagNameNS(NS, 'tbl').length, 9, 'eight group summaries plus final work overview');
});

test('summary omits start rules while detailed DOCX and AI exports preserve them', async () => {
  const document = fixture();
  document.tasks[0].timing.startRule = '시작기준 고유내용\n두 번째 줄 <literal> & 보존';
  const before = JSON.stringify(document);
  const output = await reopen(document);
  const tableText = Array.from(output.dom.getElementsByTagNameNS(NS, 'tbl')).map(visibleText).join('\n');
  assert.ok(!tableText.includes('시작·산정 기준:'));
  assert.ok(!tableText.includes(document.tasks[0].timing.startRule));
  assert.ok(tableText.includes('정기 업무: 매월 10일'));
  assert.equal(output.paragraphs.filter(text => text.includes(document.tasks[0].timing.startRule)).length, 1);
  assert.ok(exportAIText(document).includes(document.tasks[0].timing.startRule));
  assert.equal(JSON.stringify(document), before);
});

test('DOCX selection applies to summary/detail and excludes source excerpts in partial exports', async () => {
  const document = fixture();
  const output = await reopen(document, { taskIds: ['task-1', 'task-1', 'unknown'], caseIds: ['case-1'] });
  assert.ok(output.text.includes(document.tasks[0].title));
  assert.ok(output.text.includes(document.cases[0].title));
  for (const excluded of [
    document.tasks[1].title, document.cases[1].title, document.cases[1].nextAction,
    'SOURCE_PRIVATE_EXCERPT', 'UNREFERENCED_SOURCE_SECRET', '미연결 원본 파일.pdf',
    'PROVENANCE_PRIVATE_NOTE',
  ]) assert.ok(!output.text.includes(excluded), `excluded: ${excluded}`);
  assert.ok(output.text.includes('검증용 원문.docx'));
  assert.ok(output.text.includes('선택하지 않은 내용이 섞일 수 있어 생략'));
  assert.equal(output.dom.getElementsByTagNameNS(NS, 'tr').length, 4, 'selected task appears in summary and final overview');

  const empty = await reopen(document, { taskIds: [], caseIds: [] });
  assert.equal(empty.dom.getElementsByTagNameNS(NS, 'tbl').length, 0);
  for (const item of [...document.tasks, ...document.cases]) assert.ok(!empty.text.includes(item.title));
  assert.ok(!empty.text.includes('SOURCE_PRIVATE_EXCERPT'));
});

test('undefined selections independently include the full corresponding category', async () => {
  const document = fixture();
  const noTasks = await reopen(document, { taskIds: [] });
  assert.ok(!noTasks.text.includes(document.tasks[0].title));
  assert.ok(noTasks.text.includes(document.cases[1].title));
  const noCases = await reopen(document, { caseIds: [] });
  assert.ok(noCases.text.includes(document.tasks[1].title));
  assert.ok(!noCases.text.includes(document.cases[0].title));
});

test('malicious-looking markup is literal text, never XML or external relationships', async () => {
  const document = fixture();
  const literal = '<script>alert("악성")</script> & </w:t><w:hyperlink r:id="evil">가짜</w:hyperlink>';
  document.tasks[0].steps = literal;
  document.tasks[0].title = '<img src=x onerror=alert(1)> 가상 업무';
  const output = await reopen(document);
  assert.ok(output.paragraphs.includes(literal));
  assert.equal(output.dom.getElementsByTagNameNS(NS, 'hyperlink').length, 0);
  assert.equal(output.dom.getElementsByTagName('script').length, 0);
  assert.ok(!strFromU8(output.zip['word/_rels/document.xml.rels']).includes('TargetMode="External"'));
  const ai = exportAIText(document);
  assert.ok(ai.includes(literal));
});

test('Korean scheduling covers each cadence, dates, events, relative days, and start rules', () => {
  const cadenceLabels = {
    daily: '매일', weekly: '매주 금요일', monthly: '매월',
    quarterly: '매 분기', halfyear: '반기마다', yearly: '매년', semester: '매 학기',
  };
  for (const [cadence, label] of Object.entries(cadenceLabels)) {
    const document = fixture();
    document.tasks[0].timing = {
      kind: 'regular', cadence, weekday: 5, day: 10, month: 3,
      date: '', trigger: '', anchorDate: '', offsetDays: '', startRule: '공휴일은 별도 확인',
    };
    const text = exportAIText(document);
    assert.ok(text.includes(label), cadence);
    assert.ok(text.includes('3월'));
    assert.ok(text.includes('10일'));
    assert.ok(text.includes('공휴일은 별도 확인'));
    if (cadence === 'daily') {
      assert.ok(text.includes('정기 업무: 매일\n시작·산정 기준:'));
      assert.ok(text.includes('저장된 보조 설정(현재 시점 유형의 일정 계산에는 사용하지 않음):'));
    }
    if (cadence === 'quarterly') assert.ok(text.includes('3월부터 3개월 간격, 10일'));
    if (cadence === 'halfyear') assert.ok(text.includes('3월부터 6개월 간격, 10일'));
    if (cadence === 'semester') assert.ok(text.includes('학사일정을 확인한 후 지정일로 확정'));
  }
  for (const [timing, expected] of [
    [{ kind: 'date', date: '2026-11-05' }, '지정일 업무: 2026-11-05'],
    [{ kind: 'event', trigger: '신규 신청 도착' }, '발생 조건: 신규 신청 도착'],
    [{ kind: 'relative', anchorDate: '2026-11-05', offsetDays: -3 }, '기준일 3일 전'],
    [{ kind: 'relative', anchorDate: '2026-11-05', offsetDays: 0 }, '기준일 당일'],
    [{ kind: 'relative', anchorDate: '2026-11-05', offsetDays: 2 }, '기준일 2일 후'],
  ]) {
    const document = fixture();
    document.tasks[0].timing = { ...document.tasks[0].timing, ...timing };
    assert.ok(exportAIText(document).includes(expected));
  }
});

test('AI text is local, inspectable, useful, and excludes sensitive fields by default', () => {
  const document = fixture();
  const text = exportAIText(document);
  for (const required of [
    document.title, document.tasks[0].title, document.tasks[0].method,
    document.tasks[0].steps, document.cases[0].nextAction,
    '직접 확인', '암호화되지 않은 평문', '전송하지 않습니다',
  ]) assert.ok(text.includes(required));
  for (const excluded of [
    'CONTACT_SECRET_', 'MATERIAL_SECRET_', 'EVIDENCE_SECRET_', 'WAITING_CONTACT_SECRET',
    'OWNER_ROLE_SECRET_', 'SUPPORT_ROLE_SECRET_',
    'SOURCE_PRIVATE_EXCERPT', 'UNREFERENCED_SOURCE_SECRET',
    'CASE_NOTES_PRIVATE', document.sourceFiles[0].name, document.onboarding.dayOne,
  ]) assert.ok(!text.includes(excluded), `excluded: ${excluded}`);
});

test('DOCX and AI exports retain big-work groups while selection omits other groups', async () => {
  const document = fixture();
  document.groups = [
    { id: 'group-1', title: '학생 지원 큰 업무' },
    { id: 'group-2', title: '예산 관리 큰 업무' },
    { id: 'group-empty', title: '등록 예정 큰 업무' },
  ];
  document.tasks[0].groupId = 'group-1';
  document.tasks[1].groupId = 'group-2';
  const full = await reopen(document);
  for (const group of document.groups) assert.ok(full.text.includes(`큰 업무: ${group.title}`));
  assert.equal(full.dom.getElementsByTagNameNS(NS, 'tbl').length, 3, 'two nonempty group summaries plus final work overview');
  assert.ok(full.text.indexOf('학생 지원 큰 업무') < full.text.indexOf(document.tasks[0].title));
  assert.ok(full.text.includes('등록된 세부 업무가 없습니다.'));
  const selected = await reopen(document, { taskIds: ['task-1'], caseIds: [] });
  assert.ok(selected.text.includes('학생 지원 큰 업무'));
  assert.ok(!selected.text.includes('예산 관리 큰 업무'));
  assert.ok(!selected.text.includes('등록 예정 큰 업무'));
  const ai = exportAIText(document, { taskIds: ['task-1'], caseIds: [] });
  assert.ok(ai.includes('큰 업무:\n학생 지원 큰 업무'));
  assert.ok(!ai.includes('예산 관리 큰 업무'));
});

test('month-end, tentative month-start and first-business-day rules are named without inventing dates', () => {
  const document = fixture();
  for (const [dayRule, expected] of [
    ['dayOfMonth', '정기 업무: 매월 10일'],
    ['monthEnd', '정기 업무: 매월 말일'],
    ['monthStartUnconfirmed', '정기 업무: 매월 초(정확한 날짜 확인 필요)'],
    ['firstBusinessDay', '정기 업무: 매월 첫 영업일(휴일·근무일 확인 필요)'],
  ]) {
    document.tasks[0].timing.dayRule = dayRule;
    const text = exportAIText(document, { taskIds: ['task-1'], caseIds: [] });
    assert.ok(text.includes(expected));
    if (dayRule !== 'dayOfMonth') {
      assert.ok(!text.includes('정기 업무: 매월 10일'));
      assert.ok(text.includes('일: 10일'), 'inactive stored day is retained as a clearly labelled auxiliary value');
    }
  }
});

test('AI opt-ins are independent, explicit, and still respect item selection', () => {
  const document = fixture();
  for (const [option, present, absent] of [
    ['includeContacts', ['CONTACT_SECRET_task-1', 'WAITING_CONTACT_SECRET', 'OWNER_ROLE_SECRET_task-1', 'SUPPORT_ROLE_SECRET_task-1'], ['MATERIAL_SECRET_', 'EVIDENCE_SECRET_']],
    ['includeMaterials', ['MATERIAL_SECRET_task-1'], ['CONTACT_SECRET_', 'EVIDENCE_SECRET_', 'WAITING_CONTACT_SECRET', 'OWNER_ROLE_SECRET_', 'SUPPORT_ROLE_SECRET_']],
    ['includeEvidence', ['EVIDENCE_SECRET_task-1'], ['CONTACT_SECRET_', 'MATERIAL_SECRET_', 'WAITING_CONTACT_SECRET', 'OWNER_ROLE_SECRET_', 'SUPPORT_ROLE_SECRET_']],
  ]) {
    const text = exportAIText(document, { [option]: true, taskIds: ['task-1'], caseIds: ['case-1'] });
    for (const value of present) assert.ok(text.includes(value));
    for (const value of absent) assert.ok(!text.includes(value));
    assert.ok(!text.includes(document.tasks[1].title));
    assert.ok(!text.includes('SECRET_task-2'));
    assert.ok(!text.includes(document.cases[1].title));
  }
  const empty = exportAIText(document, { taskIds: [], caseIds: [], includeContacts: true, includeEvidence: true, includeMaterials: true });
  for (const item of [...document.tasks, ...document.cases]) assert.ok(!empty.includes(item.title));
  assert.ok(!empty.includes('SECRET'));
});

test('both exports leave the source document unchanged', async () => {
  const document = fixture();
  const before = JSON.stringify(document);
  await exportDocx(document, { taskIds: ['task-1'], caseIds: [] });
  exportAIText(document, { taskIds: [], caseIds: ['case-1'] });
  assert.equal(JSON.stringify(document), before);
});

test('DOCX distinguishes access not applicable, confirmed, and unconfirmed while supporting legacy booleans', async () => {
  for (const [accessStatus, expected] of [
    ['notApplicable', '해당 없음'], ['confirmed', '확인함'], ['unconfirmed', '미확인'],
  ]) {
    const document = fixture();
    document.tasks[0].accessStatus = accessStatus;
    const output = await reopen(document, { taskIds: ['task-1'], caseIds: [] });
    assert.ok(output.text.includes(`접근 권한 확인\n${expected}`));
    assert.ok(output.text.includes('주담당 역할'));
    assert.ok(output.text.includes('지원 역할'));
    assert.ok(output.text.includes('문의 역할'));
  }
  const legacy = fixture();
  delete legacy.tasks[0].ownerRole;
  delete legacy.tasks[0].supportRole;
  legacy.tasks[0].accessChecked = false;
  const output = await reopen(legacy, { taskIds: ['task-1'], caseIds: [] });
  assert.ok(output.text.includes('접근 권한 확인\n미확인'));
});

test('invalid control characters, prototype keys and malformed export options are rejected', async () => {
  const document = fixture();
  document.tasks[0].steps = '금지\u0000문자';
  assert.throws(() => exportAIText(document), /내보낼 수 없습니다/);
  await assert.rejects(exportDocx(document), /내보낼 수 없습니다/);

  const prototype = fixture();
  prototype.provenance = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => exportAIText(prototype), /내보낼 수 없습니다/);
  await assert.rejects(exportDocx(prototype), /내보낼 수 없습니다/);

  const valid = fixture();
  assert.throws(() => exportAIText(valid, { taskIds: 'task-1' }), /문자열 ID 배열/);
  assert.throws(() => exportAIText(valid, { caseIds: [3] }), /문자열 ID 배열/);
  assert.throws(() => exportAIText(valid, { includeContacts: 'false' }), /참 또는 거짓/);
  await assert.rejects(exportDocx(valid, null), /옵션은 객체/);
});
