import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createDocument, createTask, dateISO } from '../src/model.js';
import { renderCalendar } from '../src/calendar.js';

let window;
let previousDocument;
beforeEach(() => {
  previousDocument = globalThis.document;
  window = new Window();
  globalThis.document = window.document;
});
afterEach(() => {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
});

function fixture(tasks = []) {
  return createDocument({ id: 'synthetic-calendar-document', title: '가상 달력 검증 문서', tasks });
}

function task(id, timing, title = `가상 업무 ${id}`) {
  return createTask({ id, title, timing });
}

function render(options = {}) {
  const calendar = renderCalendar({ doc: fixture(), anchorDate: '2026-10-20', ...options });
  window.document.body.append(calendar);
  return calendar;
}

const dates = (calendar) => [...calendar.querySelectorAll('[data-calendar-date]')].map((node) => node.dataset.calendarDate);
const dateButton = (calendar, date) => calendar.querySelector(`[data-calendar-date="${date}"]`);
const action = (calendar, name) => calendar.querySelector(`[data-calendar-action="${name}"]`);

test('month view uses Monday columns and a minimum of 35 cells, including a four-week February', () => {
  const calendar = render({ anchorDate: '2021-02-17' });
  assert.equal(calendar.querySelectorAll('tbody tr').length, 5);
  assert.equal(calendar.querySelectorAll('tbody td').length, 35);
  assert.equal(dates(calendar)[0], '2021-02-01');
  assert.equal(dates(calendar).at(-1), '2021-03-07');
  assert.equal(calendar.dataset.periodStart, '2021-02-01');
  assert.equal(calendar.dataset.periodEnd, '2021-02-28');
  assert.equal(calendar.querySelectorAll('.is-outside').length, 7);
  assert.deepEqual([...calendar.querySelectorAll('th')].map((node) => node.textContent), ['월', '화', '수', '목', '금', '토', '일']);
});

test('a long month displays 42 aligned cells and dims both adjacent months', () => {
  const calendar = render({ anchorDate: '2026-08-15' });
  assert.equal(calendar.querySelectorAll('tbody td').length, 42);
  assert.equal(dates(calendar)[0], '2026-07-27');
  assert.equal(dates(calendar).at(-1), '2026-09-06');
  assert.equal(calendar.querySelectorAll('.is-outside').length, 11);
  assert.match(dateButton(calendar, '2026-07-31').getAttribute('aria-label'), /다른 달/);
});

test('February leap day is present only in a leap year and monthly end uses its actual last day', () => {
  const doc = fixture([task('month-end', { kind: 'regular', cadence: 'monthly', dayRule: 'monthEnd' }, '월말 마감')]);
  const leap = render({ doc, anchorDate: '2024-02-15', selectedDate: '2024-02-29' });
  assert.equal(leap.dataset.periodEnd, '2024-02-29');
  assert.match(dateButton(leap, '2024-02-29').getAttribute('aria-label'), /업무 1개/);
  assert.match(dateButton(leap, '2024-02-28').getAttribute('aria-label'), /업무 0개/);
  assert.equal(leap.querySelector('.calendar-day-tasks [data-task-id]').dataset.taskId, 'month-end');
  assert.equal(leap.querySelector('[data-unresolved-count]').dataset.unresolvedCount, '0');

  const ordinary = render({ doc, anchorDate: '2026-02-15', selectedDate: '2026-02-28' });
  assert.equal(ordinary.dataset.periodEnd, '2026-02-28');
  assert.equal(dateButton(ordinary, '2026-02-29'), null);
  assert.match(dateButton(ordinary, '2026-02-28').getAttribute('aria-label'), /업무 1개/);

  const april = render({ doc, anchorDate: '2026-04-15' });
  assert.match(dateButton(april, '2026-04-30').getAttribute('aria-label'), /업무 1개/);
});

test('a fixed monthly 31st is not reinterpreted as month-end in February', () => {
  const calendar = render({
    anchorDate: '2026-02-15',
    doc: fixture([task('day31', { kind: 'regular', cadence: 'monthly', day: 31 })]),
  });
  assert.match(dateButton(calendar, '2026-02-28').getAttribute('aria-label'), /업무 0개/);
  assert.equal(calendar.querySelector('.calendar-summary').textContent, '이 기간의 업무 0개 · 일정 0회');
});

test('week view is seven days Monday through Sunday across the year boundary', () => {
  const navigations = [];
  const calendar = render({ mode: 'week', anchorDate: '2026-12-30', onNavigate: (date) => navigations.push(date) });
  assert.equal(calendar.querySelectorAll('tbody td').length, 7);
  assert.deepEqual(dates(calendar), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  action(calendar, 'previous').click();
  action(calendar, 'next').click();
  assert.deepEqual(navigations, ['2026-12-21', '2027-01-04']);
});

test('month navigation crosses years and cannot overflow short months', () => {
  const calls = [];
  const december = render({ anchorDate: '2026-12-31', onNavigate: (date) => calls.push(date) });
  action(december, 'next').click();
  action(december, 'previous').click();
  const january = render({ anchorDate: '2027-01-31', onNavigate: (date) => calls.push(date) });
  action(january, 'next').click();
  action(january, 'previous').click();
  assert.deepEqual(calls, ['2027-01-01', '2026-11-01', '2027-02-01', '2026-12-01']);
});

test('today and mode controls report the documented callbacks', () => {
  const calls = [];
  const calendar = render({
    onNavigate: (date) => calls.push(['navigate', date]),
    onSelectDate: (date) => calls.push(['select', date]),
    onModeChange: (mode) => calls.push(['mode', mode]),
  });
  action(calendar, 'week').click();
  action(calendar, 'month').click();
  action(calendar, 'today').click();
  assert.deepEqual(calls, [['mode', 'week'], ['mode', 'month'], ['navigate', dateISO()], ['select', dateISO()]]);
  assert.equal(action(calendar, 'month').getAttribute('aria-pressed'), 'true');
  assert.equal(action(calendar, 'week').getAttribute('aria-pressed'), 'false');
});

test('date selection and every task action carry the corresponding date and stable task id', () => {
  const selections = [];
  const tasksOpened = [];
  const doc = fixture(Array.from({ length: 5 }, (_, index) => task(`date-task-${index}`, { kind: 'date', date: '2026-10-20' })));
  const before = JSON.stringify(doc);
  const calendar = render({
    doc,
    selectedDate: '2026-10-20',
    onSelectDate: (date) => selections.push(date),
    onSelectTask: (id, date) => tasksOpened.push([id, date]),
  });
  dateButton(calendar, '2026-10-21').click();
  calendar.querySelector('[data-calendar-more="2026-10-20"]').click();
  assert.deepEqual(selections, ['2026-10-21', '2026-10-20']);
  const cell = dateButton(calendar, '2026-10-20').closest('td');
  assert.equal(cell.querySelectorAll('.calendar-task-preview').length, 2);
  cell.querySelector('.calendar-task-preview').click();
  const selectedTasks = calendar.querySelectorAll('.calendar-day-tasks [data-task-id]');
  assert.equal(selectedTasks.length, 5, 'selected list must not truncate the two-item cell preview');
  selectedTasks[4].click();
  assert.deepEqual(tasksOpened, [['date-task-0', '2026-10-20'], ['date-task-4', '2026-10-20']]);
  assert.match(dateButton(calendar, '2026-10-20').getAttribute('aria-label'), /업무 5개/);
  assert.equal(JSON.stringify(doc), before, 'rendering and callbacks do not mutate source data');
});

test('selected outside-month dates remain usable while stale selections fall back to anchor', () => {
  const outside = render({ anchorDate: '2026-10-20', selectedDate: '2026-09-30' });
  assert.equal(outside.querySelector('[data-selected-date]').dataset.selectedDate, '2026-09-30');
  assert.equal(dateButton(outside, '2026-09-30').getAttribute('aria-pressed'), 'true');
  const stale = render({ anchorDate: '2026-10-20', selectedDate: '2025-01-01' });
  assert.equal(stale.querySelector('[data-selected-date]').dataset.selectedDate, '2026-10-20');
  const invalid = render({ anchorDate: '2026-10-20', selectedDate: '2026-02-30' });
  assert.equal(invalid.querySelector('[data-selected-date]').dataset.selectedDate, '2026-10-20');
});

test('conditional and unresolved schedules stay counted, explained, and linked without inferred dates', () => {
  const opened = [];
  const doc = fixture([
    task('event', { kind: 'event', trigger: '입사자가 확정될 때' }, '계정 만들기'),
    task('relative', { kind: 'relative', anchorDate: '', offsetDays: 3 }, '기준일 확인'),
    task('missing-day', { kind: 'regular', cadence: 'monthly' }, '일자 확인'),
    task('month-start', { kind: 'regular', cadence: 'monthly', dayRule: 'monthStartUnconfirmed' }, '월초 보고'),
    task('business-day', { kind: 'regular', cadence: 'monthly', dayRule: 'firstBusinessDay' }, '첫 영업일 보고'),
    task('outside', { kind: 'date', date: '2027-12-01' }, '다른 기간의 확정 업무'),
  ]);
  const calendar = render({ doc, onSelectTask: (id, date) => opened.push([id, date]) });
  const unresolved = calendar.querySelector('.calendar-unresolved');
  assert.equal(unresolved.dataset.unresolvedCount, '5');
  assert.match(unresolved.querySelector('summary').textContent, /5개/);
  assert.equal(unresolved.querySelectorAll('.calendar-unresolved-task').length, 5);
  assert.equal(unresolved.querySelectorAll('.calendar-unresolved-reason').length, 5);
  assert.match(unresolved.textContent, /입사자가 확정될 때/);
  assert.match(unresolved.textContent, /임의로 배치하지 않습니다/);
  assert.match(calendar.querySelector('.calendar-summary').textContent, /업무 0개 · 일정 0회/);
  assert.equal(calendar.querySelectorAll('.calendar-task-preview').length, 0);
  unresolved.querySelector('[data-task-id="event"]').click();
  assert.deepEqual(opened, [['event', '']]);
});

test('visible adjacent-month tasks do not inflate the current month summary', () => {
  const calendar = render({
    doc: fixture([
      task('daily', { kind: 'regular', cadence: 'daily' }),
      task('outside', { kind: 'date', date: '2026-09-30' }),
    ]),
    anchorDate: '2026-10-20',
  });
  assert.equal(calendar.querySelector('.calendar-summary').textContent, '이 기간의 업무 1개 · 일정 31회');
  assert.match(dateButton(calendar, '2026-09-30').getAttribute('aria-label'), /업무 2개/);
});

test('native controls have accessible names, selected/today states, and no nested buttons', () => {
  const calendar = render({
    anchorDate: dateISO(),
    doc: fixture([task('daily', { kind: 'regular', cadence: 'daily' })]),
  });
  assert.ok(calendar instanceof window.HTMLElement);
  assert.equal(calendar.querySelectorAll('button button').length, 0);
  assert.equal(calendar.querySelectorAll('[role="grid"], [tabindex]').length, 0);
  assert.equal(calendar.querySelectorAll('th[scope="col"]').length, 7);
  assert.equal(calendar.querySelectorAll('button[aria-pressed="true"]').length, 2, 'one mode and one date are selected');
  assert.equal(dateButton(calendar, dateISO()).getAttribute('aria-current'), 'date');
  for (const control of calendar.querySelectorAll('button')) {
    assert.equal(control.type, 'button');
    assert.ok(control.getAttribute('aria-label')?.trim());
  }
  for (const labelled of calendar.querySelectorAll('[aria-labelledby]')) {
    for (const id of labelled.getAttribute('aria-labelledby').split(/\s+/)) {
      assert.ok(window.document.getElementById(id), `label target ${id} exists`);
    }
  }
});

test('untrusted task names and conditions remain literal text without HTML nodes', () => {
  const name = '<img src=x onerror="alert(1)"> <script>unsafe()</script>';
  const trigger = '<a href="javascript:alert(1)">신청이 도착하면</a>';
  const calendar = render({
    doc: fixture([
      task('literal-date', { kind: 'date', date: '2026-10-20' }, name),
      task('literal-event', { kind: 'event', trigger }, name),
    ]),
  });
  assert.ok(calendar.textContent.includes(name));
  assert.ok(calendar.textContent.includes(trigger));
  assert.equal(calendar.querySelectorAll('img, script, a, [onerror], [onclick]').length, 0);
});

test('supported year boundaries never generate invalid dates or overflow navigation', () => {
  const early = render({ anchorDate: '0001-01-01' });
  assert.equal(dates(early)[0], '0001-01-01');
  assert.equal(early.querySelector('.calendar-title').textContent, '1년 1월');
  assert.equal(action(early, 'previous').disabled, true);
  const late = render({ anchorDate: '9999-12-31' });
  assert.equal(action(late, 'next').disabled, true);
  assert.equal(dates(late).at(-1), '9999-12-31');
  assert.ok(late.querySelectorAll('.is-unavailable').length > 0);
  assert.equal(late.querySelectorAll('tbody td').length, 35);
  assert.equal(late.querySelector('[data-unresolved-count]').dataset.unresolvedCount, '0');
});

test('invalid calendar inputs fail clearly and empty documents remain usable', () => {
  for (const invalid of ['2026-02-30', '2026-13-01', '0000-01-01', '2026-1-01', 'x']) {
    assert.throws(() => render({ anchorDate: invalid }), /달력 기준일/);
  }
  assert.throws(() => render({ mode: 'day' }), /달력 보기 종류/);
  const calendar = render({ doc: undefined });
  assert.equal(calendar.querySelector('.calendar-summary').textContent, '이 기간의 업무 0개 · 일정 0회');
  assert.match(calendar.querySelector('.calendar-selected-day').textContent, /예정된 업무가 없습니다/);
  assert.equal(calendar.querySelector('[data-unresolved-count]').dataset.unresolvedCount, '0');
});
