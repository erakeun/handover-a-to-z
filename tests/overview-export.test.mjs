import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { unzipSync, strFromU8 } from 'fflate';
import { createDocument, createTask } from '../src/model.js';
import { exportDocx } from '../src/exporters.js';

const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const textOf = node => node.nodeType === 1 && node.namespaceURI === NS && node.localName === 't'
  ? node.textContent : Array.from(node.childNodes ?? []).map(textOf).join('');

async function overview(document, options) {
  const zip = unzipSync(await exportDocx(document, options));
  const errors = [];
  const dom = new DOMParser({ onError: (level, message) => errors.push(`${level}: ${message}`) })
    .parseFromString(strFromU8(zip['word/document.xml']), 'application/xml');
  assert.deepEqual(errors, []);
  const body = dom.getElementsByTagNameNS(NS, 'body')[0];
  const children = Array.from(body.childNodes).filter(node => node.nodeType === 1);
  const titleIndex = children.findIndex(node => node.localName === 'p' && textOf(node) === '내 업무 한눈에 보기');
  assert.ok(titleIndex >= 0);
  assert.ok(children.slice(0, titleIndex).some(node => textOf(node) === '문서 기록'), 'overview follows document records');
  const appendix = children.slice(titleIndex).filter(node => node.localName !== 'sectPr');
  const table = appendix.find(node => node.localName === 'tbl');
  return { dom, body, appendix, text: appendix.map(textOf).join('\n'), table };
}

test('DOCX ends with owner, large-work and complete small-task titles, including missing-owner labels', async () => {
  const document = createDocument({
    groups: [{ id: 'g-one', title: '장학 업무' }, { id: 'g-two', title: '예산 업무' }],
    tasks: [
      createTask({ id: 't-one', title: '신청 접수 확인', groupId: 'g-one', ownerRole: '김담당 / 이담당' }),
      createTask({ id: 't-two', title: '결과 통보', groupId: 'g-one', ownerRole: '김담당 / 이담당' }),
      createTask({ id: 't-three', title: '월별 집행 확인', groupId: 'g-two', ownerRole: '' }),
    ],
  });
  const original = JSON.stringify(document);
  const result = await overview(document);
  assert.equal(result.appendix.at(-1).localName, 'tbl', 'overview table is the final document content');
  assert.ok(result.text.includes('전체 업무 표시 · 3개'));
  for (const label of ['담당 역할', '큰 업무', '세부 업무명', '김담당 / 이담당', '담당 미입력', '장학 업무', '예산 업무']) {
    assert.ok(result.text.includes(label), label);
  }
  assert.equal(result.table.getElementsByTagNameNS(NS, 'tr').length, 4);
  assert.equal(result.table.getElementsByTagNameNS(NS, 'tblHeader').length, 1);
  for (const task of document.tasks) assert.ok(result.text.includes(task.title));
  assert.equal(JSON.stringify(document), original);
});

test('final overview respects selected tasks and does not include other owners or task titles', async () => {
  const document = createDocument({ tasks: [
    createTask({ id: 'selected', title: '선택한 고유 업무', ownerRole: '선택 담당' }),
    createTask({ id: 'omitted', title: '제외한 고유 업무', ownerRole: '제외 담당' }),
  ] });
  const selected = await overview(document, { taskIds: ['selected'], caseIds: [] });
  assert.ok(selected.text.includes('선택한 업무만 표시 · 1개'));
  assert.ok(selected.text.includes('선택한 고유 업무'));
  assert.ok(selected.text.includes('선택 담당'));
  assert.ok(!selected.text.includes('제외한 고유 업무'));
  assert.ok(!selected.text.includes('제외 담당'));
  const empty = await overview(document, { taskIds: [], caseIds: [] });
  assert.equal(empty.table, undefined);
  assert.ok(empty.text.includes('표시할 업무가 없습니다.'));
});

test('many long Korean titles remain complete in an overview that may flow across pages', async () => {
  const tasks = Array.from({ length: 80 }, (_, index) => createTask({
    id: `long-task-${index}`,
    title: `업무 ${String(index).padStart(2, '0')}: ` + '조건과 결과를 빠짐없이 확인하는 긴 업무명입니다. '.repeat(8) + `끝표시${index}`,
    groupId: `g-${index % 4}`,
    ownerRole: `실제 입력된 담당 역할 ${index % 3}`,
  }));
  const document = createDocument({
    groups: Array.from({ length: 4 }, (_, index) => ({ id: `g-${index}`, title: `큰 업무 영역 ${index}` })),
    tasks,
  });
  const result = await overview(document);
  const cells = Array.from(result.table.getElementsByTagNameNS(NS, 'tc')).map(textOf);
  for (const task of tasks) assert.ok(cells.includes(task.title), `complete title: ${task.id}`);
  assert.equal(result.table.getElementsByTagNameNS(NS, 'tr').length, 81);
  assert.equal(result.table.getElementsByTagNameNS(NS, 'trHeight').length, 0);
  assert.equal(result.table.getElementsByTagNameNS(NS, 'cantSplit').length, 0);
  assert.equal(result.table.getElementsByTagNameNS(NS, 'vMerge').length, 0);
  assert.equal(result.table.getElementsByTagNameNS(NS, 'tblHeader').length, 1);
});
