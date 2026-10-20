import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { buildWorkOverview, renderWorkOverview } from '../src/work-overview.js';

const task = (id, title, ownerRole = '', groupId = '') => ({ id, title, ownerRole, groupId });
function fixture() {
  return {
    groups: [{ id: 'group-a', title: '지원 업무' }, { id: 'group-b', title: '지원 업무' }],
    tasks: [
      task('t1', '첫 번째 원문 제목', '김담당 / 이담당', 'group-b'),
      task('t2', '두 번째 원문 제목', '박담당', 'group-a'),
      task('t3', '세 번째 원문 제목', '김담당 / 이담당', 'group-b'),
      task('t4', '네 번째 원문 제목', '김담당 / 이담당', 'group-a'),
      task('t5', '다섯 번째 원문 제목'),
      task('t6', '여섯 번째 원문 제목', '  '),
    ],
  };
}

test('work overview derives literal owners, distinct group IDs, and stable original order without mutating records', () => {
  const doc = fixture();
  const original = JSON.stringify(doc);
  assert.deepEqual(buildWorkOverview(doc), [
    {
      owner: '김담당 / 이담당',
      groups: [
        { id: 'group-b', title: '지원 업무', tasks: [{ id: 't1', title: '첫 번째 원문 제목' }, { id: 't3', title: '세 번째 원문 제목' }] },
        { id: 'group-a', title: '지원 업무', tasks: [{ id: 't4', title: '네 번째 원문 제목' }] },
      ],
    },
    { owner: '박담당', groups: [{ id: 'group-a', title: '지원 업무', tasks: [{ id: 't2', title: '두 번째 원문 제목' }] }] },
    {
      owner: '담당 미입력',
      groups: [{
        id: '', title: '아직 분류하지 않은 업무',
        tasks: [{ id: 't5', title: '다섯 번째 원문 제목' }, { id: 't6', title: '여섯 번째 원문 제목' }],
      }],
    },
  ]);
  assert.equal(JSON.stringify(doc), original);
});

test('work overview selection uses original order, excludes unselected work, and supports old documents without groups/roles', () => {
  assert.deepEqual(buildWorkOverview(fixture(), { taskIds: ['t4', 't1', 't1', 'missing'] }), [{
    owner: '김담당 / 이담당',
    groups: [
      { id: 'group-b', title: '지원 업무', tasks: [{ id: 't1', title: '첫 번째 원문 제목' }] },
      { id: 'group-a', title: '지원 업무', tasks: [{ id: 't4', title: '네 번째 원문 제목' }] },
    ],
  }]);
  assert.deepEqual(buildWorkOverview(fixture(), { taskIds: [] }), []);
  assert.deepEqual(buildWorkOverview({ tasks: [{ id: 'old', title: '이전 문서의 업무' }] }), [{
    owner: '담당 미입력', groups: [{ id: '', title: '아직 분류하지 않은 업무', tasks: [{ id: 'old', title: '이전 문서의 업무' }] }],
  }]);
  assert.throws(() => buildWorkOverview(fixture(), { taskIds: 't1' }), /문자열 배열/);
});

test('work overview keeps complete long titles and literal HTML-like user text', () => {
  const fullTitle = '긴 업무 제목의 마지막까지 보존합니다. '.repeat(15) + '마지막 확인';
  const owner = '<img src=x onerror=alert(1)>';
  const doc = { tasks: [task('t1', fullTitle, owner)], groups: [] };
  assert.equal(buildWorkOverview(doc)[0].owner, owner);
  assert.equal(buildWorkOverview(doc)[0].groups[0].tasks[0].title, fullTitle);
});

function dom(t) {
  const window = new Window({ url: 'https://overview-dom-test.invalid' });
  t.after(() => window.happyDOM.abort());
  const document = window.document;
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) node.append(child instanceof window.Node ? child : document.createTextNode(child));
    return node;
  }
  const button = (label, action, kind, attrs) => el('button', { type: 'button', class: `button ${kind}`, onclick: action, ...attrs }, label);
  return { window, document, el, button };
}

test('work overview DOM has real focusable task buttons, full text, hierarchy, and exact trigger callback', t => {
  const { document, el, button } = dom(t);
  const fullTitle = '업무명을 생략하지 않고 화면에 모두 보여 줍니다. '.repeat(8);
  const doc = { groups: [{ id: 'g1', title: '큰 업무' }], tasks: [task('t1', fullTitle, '담당 역할', 'g1')] };
  let selected;
  const view = renderWorkOverview({ doc, el, button, onSelect: (id, trigger) => { selected = { id, trigger }; } });
  document.body.append(view);
  assert.equal(view.querySelector('h2').textContent, '내 업무 한눈에 보기');
  assert.match(view.querySelector('h3').textContent, /^담당 역할/);
  assert.equal(view.querySelector('h4').textContent, '큰 업무');
  const trigger = view.querySelector('button');
  assert.equal(trigger.type, 'button');
  assert.equal(trigger.textContent, fullTitle);
  assert.equal(trigger.dataset.taskId, 't1');
  trigger.focus();
  assert.equal(document.activeElement, trigger);
  trigger.click();
  assert.equal(selected.id, 't1');
  assert.equal(selected.trigger, trigger);
});

test('work overview DOM renders unknown/empty labels and untrusted strings as text without executable markup', t => {
  const { el, button } = dom(t);
  const doc = { tasks: [task('t1', '<svg onload=alert(1)>', '<script>alert(1)</script>', 'unknown')] };
  const view = renderWorkOverview({ doc, el, button, onSelect: () => {} });
  assert.equal(view.querySelectorAll('script,svg,img').length, 0);
  assert.match(view.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(view.querySelector('h4').textContent, '이름 없는 영역');
  assert.equal(view.querySelector('button').textContent, '<svg onload=alert(1)>');
});

test('work overview static print projection omits buttons and empty overview explains its next step', t => {
  const { el, button } = dom(t);
  const printed = renderWorkOverview({ doc: fixture(), taskIds: ['t2'], el, button });
  assert.equal(printed.querySelectorAll('button').length, 0);
  assert.equal(printed.querySelectorAll('li').length, 1);
  assert.equal(printed.querySelector('[data-task-id]').textContent, '두 번째 원문 제목');
  const empty = renderWorkOverview({ doc: { tasks: [] }, el, button });
  assert.match(empty.textContent, /업무를 작성하면/);
  assert.equal(empty.querySelectorAll('li,button').length, 0);
});
