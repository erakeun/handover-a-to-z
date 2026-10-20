import { dateISO, dueInRange } from './model.js';

const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
let calendarSequence = 0;

// Noon UTC keeps civil-date arithmetic independent of daylight saving time.
// setUTCFullYear also preserves years 0001–0099 without Date's 1900 offset.
function civilDate(year, month, day) {
  const value = new Date(0);
  value.setUTCHours(12, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, day);
  return value;
}

function isoDate(value) {
  const year = value.getUTCFullYear();
  if (year < 1 || year > 9999) return '';
  return `${String(year).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = civilDate(Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8)));
  return isoDate(date) === value ? date : null;
}

function shifted(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function mondayOffset(date) {
  return (date.getUTCDay() + 6) % 7;
}

function readableDate(value, withWeekday = true) {
  const date = parseDate(value);
  const label = `${date.getUTCFullYear()}년 ${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일`;
  return withWeekday ? `${label} ${WEEKDAYS[mondayOffset(date)]}요일` : label;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function button(text, className, action, label = text) {
  const node = element('button', className, text);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  node.addEventListener('click', action);
  return node;
}

function taskName(task) {
  return typeof task.title === 'string' && task.title.trim() ? task.title : '이름 없는 업무';
}

/**
 * A controlled, native-DOM calendar. Callbacks update state in the owning UI.
 * Month navigation returns the destination month's first day; week navigation
 * returns Monday. "Today" invokes both navigation and date selection.
 * A stale/out-of-range selectedDate falls back to the current anchorDate.
 */
export function renderCalendar({
  doc,
  anchorDate = dateISO(),
  mode = 'month',
  selectedDate = '',
  onNavigate = () => {},
  onModeChange = () => {},
  onSelectDate = () => {},
  onSelectTask = () => {},
} = {}) {
  const anchor = parseDate(anchorDate);
  if (!anchor) throw new RangeError('달력 기준일은 실제로 존재하는 YYYY-MM-DD 날짜여야 합니다.');
  if (!['month', 'week'].includes(mode)) throw new TypeError('달력 보기 종류는 month 또는 week여야 합니다.');
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks : [];
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + 1;
  const monthStart = civilDate(year, month, 1);
  const monthEnd = civilDate(year, month + 1, 0);
  const visibleStart = mode === 'month'
    ? shifted(monthStart, -mondayOffset(monthStart))
    : shifted(anchor, -mondayOffset(anchor));
  const cellCount = mode === 'month'
    ? Math.max(35, Math.ceil((mondayOffset(monthStart) + monthEnd.getUTCDate()) / 7) * 7)
    : 7;
  const dates = Array.from({ length: cellCount }, (_, index) => isoDate(shifted(visibleStart, index)));
  // At year 9999, trailing cells are placeholders instead of unsupported dates.
  const validDates = dates.filter(Boolean);
  const first = validDates[0];
  const last = validDates.at(-1);
  const periodStart = mode === 'month' ? isoDate(monthStart) : first;
  const periodEnd = mode === 'month' ? isoDate(monthEnd) : last;
  const activeDate = parseDate(selectedDate) && validDates.includes(selectedDate) ? selectedDate : anchorDate;
  const today = dateISO();
  const byDate = new Map(validDates.map((date) => [date, []]));
  const unresolved = [];
  const scheduledTasks = new Set();
  let occurrences = 0;
  for (const task of tasks) {
    const result = dueInRange(task, first, last);
    if (result.unresolved) unresolved.push({ task, reason: result.reason });
    for (const date of result.dates) {
      byDate.get(date)?.push(task);
      if (date >= periodStart && date <= periodEnd) {
        scheduledTasks.add(task.id);
        occurrences++;
      }
    }
  }

  const id = `calendar-${++calendarSequence}`;
  const root = element('section', `calendar-panel calendar-${mode}`);
  root.setAttribute('aria-labelledby', `${id}-title`);
  root.dataset.mode = mode;
  root.dataset.periodStart = periodStart;
  root.dataset.periodEnd = periodEnd;

  const toolbar = element('div', 'calendar-toolbar');
  const title = element('h3', 'calendar-title', mode === 'month'
    ? `${year}년 ${month}월`
    : `${readableDate(first, false)} – ${readableDate(last, false)}`);
  title.id = `${id}-title`;
  title.setAttribute('aria-live', 'polite');
  toolbar.append(title);

  const modes = element('div', 'calendar-modes');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', '달력 보기');
  for (const [value, label] of [['month', '월'], ['week', '주']]) {
    const control = button(label, `calendar-mode${mode === value ? ' is-active' : ''}`, () => onModeChange(value), `${label} 단위로 보기`);
    control.setAttribute('aria-pressed', String(mode === value));
    control.dataset.calendarAction = value;
    modes.append(control);
  }
  toolbar.append(modes);

  const navigation = element('div', 'calendar-navigation');
  navigation.setAttribute('role', 'group');
  navigation.setAttribute('aria-label', '달력 기간 이동');
  const navigate = (direction) => isoDate(mode === 'month'
    ? civilDate(year, month + direction, 1)
    : shifted(visibleStart, direction * 7));
  for (const [direction, text, action] of [[-1, '이전', 'previous'], [1, '다음', 'next']]) {
    const destination = navigate(direction);
    const control = button(text, 'calendar-nav-button', () => onNavigate(destination), `${text} ${mode === 'month' ? '달' : '주'}`);
    control.dataset.calendarAction = action;
    control.disabled = !destination;
    navigation.append(control);
  }
  const todayControl = button('오늘', 'calendar-today-button', () => {
    onNavigate(today);
    onSelectDate(today);
  }, `오늘 ${readableDate(today)}로 이동`);
  todayControl.dataset.calendarAction = 'today';
  navigation.append(todayControl);
  toolbar.append(navigation);
  root.append(toolbar);

  const summary = element('p', 'calendar-summary', `이 기간의 업무 ${scheduledTasks.size}개 · 일정 ${occurrences}회`);
  summary.setAttribute('role', 'status');
  root.append(summary);

  // Native table semantics keep ordinary Tab/Enter/Space behavior. A grid role
  // would promise arrow-key navigation and is intentionally not used.
  const table = element('table', 'calendar-table');
  table.setAttribute('aria-labelledby', `${id}-title`);
  const caption = element('caption', 'calendar-caption', '날짜를 선택하면 아래에서 해당 업무를 모두 볼 수 있습니다.');
  table.append(caption);
  const head = element('thead');
  const weekdays = element('tr');
  WEEKDAYS.forEach((weekday) => {
    const heading = element('th', 'calendar-weekday', weekday);
    heading.scope = 'col';
    heading.setAttribute('aria-label', `${weekday}요일`);
    weekdays.append(heading);
  });
  head.append(weekdays);
  table.append(head);
  const body = element('tbody');
  for (let index = 0; index < dates.length; index += 7) {
    const row = element('tr', 'calendar-week-row');
    for (const date of dates.slice(index, index + 7)) {
      const cell = element('td', 'calendar-cell');
      if (!date) {
        cell.classList.add('is-unavailable');
        cell.setAttribute('aria-label', '지원하는 날짜 범위 밖');
        row.append(cell);
        continue;
      }
      const entries = byDate.get(date);
      const outside = mode === 'month' && date.slice(0, 7) !== anchorDate.slice(0, 7);
      cell.dataset.date = date;
      cell.classList.toggle('is-outside', outside);
      cell.classList.toggle('is-selected', date === activeDate);
      cell.classList.toggle('is-today', date === today);
      const dateControl = button('', 'calendar-date-button', () => onSelectDate(date), `${readableDate(date)}, 업무 ${entries.length}개${outside ? ', 다른 달' : ''}`);
      dateControl.dataset.calendarDate = date;
      dateControl.setAttribute('aria-pressed', String(date === activeDate));
      if (date === today) dateControl.setAttribute('aria-current', 'date');
      dateControl.append(element('span', 'calendar-date-number', String(Number(date.slice(8)))));
      if (entries.length) dateControl.append(element('span', 'calendar-date-count', `${entries.length}개`));
      cell.append(dateControl);
      // A compact preview helps scanning; the selected-day list never truncates.
      if (entries.length) {
        const previews = element('ul', 'calendar-task-previews');
        for (const task of entries.slice(0, 2)) {
          const item = element('li');
          const preview = button(taskName(task), 'calendar-task-preview', () => onSelectTask(task.id, date), `${taskName(task)}, ${readableDate(date)}, 업무 열기`);
          preview.dataset.taskId = task.id;
          preview.dataset.taskDate = date;
          item.append(preview);
          previews.append(item);
        }
        cell.append(previews);
        if (entries.length > 2) {
          const more = button(`+${entries.length - 2}개 더`, 'calendar-more-button', () => onSelectDate(date), `${readableDate(date)} 업무 ${entries.length}개 모두 보기`);
          more.dataset.calendarMore = date;
          cell.append(more);
        }
      }
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
  root.append(table);

  const selected = element('section', 'calendar-selected-day');
  selected.setAttribute('aria-labelledby', `${id}-selected-title`);
  selected.dataset.selectedDate = activeDate;
  const entries = byDate.get(activeDate) || [];
  const selectedTitle = element('h4', 'calendar-selected-title', `${readableDate(activeDate)} · 업무 ${entries.length}개`);
  selectedTitle.id = `${id}-selected-title`;
  selected.append(selectedTitle);
  if (!entries.length) {
    selected.append(element('p', 'calendar-empty', '이 날짜에 예정된 업무가 없습니다.'));
  } else {
    const list = element('ul', 'calendar-day-tasks');
    for (const task of entries) {
      const item = element('li', 'calendar-day-task');
      const action = button('', 'calendar-task-action', () => onSelectTask(task.id, activeDate), `${taskName(task)}, 업무 열기`);
      action.dataset.taskId = task.id;
      action.dataset.taskDate = activeDate;
      action.append(element('span', 'calendar-task-name', taskName(task)), element('span', 'calendar-task-link', '업무 열기'));
      item.append(action);
      list.append(item);
    }
    selected.append(list);
  }
  root.append(selected);

  const pending = element('details', 'calendar-unresolved');
  pending.dataset.unresolvedCount = String(unresolved.length);
  pending.append(element('summary', 'calendar-unresolved-summary', `상황 발생·일정 미확정 업무 ${unresolved.length}개`));
  pending.append(element('p', 'calendar-unresolved-help', '상황이 생겨야 하거나 날짜 기준을 확인해야 하는 업무입니다. 날짜가 정해질 때까지 달력에 임의로 배치하지 않습니다.'));
  if (unresolved.length) {
    const list = element('ul', 'calendar-unresolved-tasks');
    for (const { task, reason } of unresolved) {
      const item = element('li', 'calendar-unresolved-task');
      const action = button(taskName(task), 'calendar-task-action', () => onSelectTask(task.id, ''), `${taskName(task)}, 일정 확인을 위해 업무 열기`);
      action.dataset.taskId = task.id;
      action.dataset.taskDate = '';
      item.append(action);
      if (task.timing?.kind === 'event' && task.timing.trigger?.trim()) {
        item.append(element('p', 'calendar-trigger', `발생 조건: ${task.timing.trigger}`));
      }
      item.append(element('p', 'calendar-unresolved-reason', reason || '일정 기준을 확인해 주세요.'));
      list.append(item);
    }
    pending.append(list);
  } else {
    pending.append(element('p', 'calendar-empty', '날짜 확인이 필요한 업무가 없습니다.'));
  }
  root.append(pending);
  root.append(element('p', 'calendar-footnote', '확정된 일정 규칙으로 계산합니다. 주말·공휴일은 자동 조정하지 않습니다.'));
  return root;
}
