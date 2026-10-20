const UNASSIGNED_OWNER = '담당 미입력';
const UNGROUPED = '아직 분류하지 않은 업무';

/**
 * Project existing records only. A role such as "김담당 / 이담당" is kept as one
 * literal value; this view never infers people, ownership, or missing groups.
 * Owners and groups follow first appearance in the original task list, and
 * tasks retain their original order within each owner/group.
 */
export function buildWorkOverview(doc, { taskIds } = {}) {
  if (!doc || !Array.isArray(doc.tasks)) throw new TypeError('업무 목록이 있는 인수인계 문서가 필요합니다.');
  if (taskIds !== undefined && (!Array.isArray(taskIds) || taskIds.some(id => typeof id !== 'string'))) {
    throw new TypeError('선택한 업무 ID는 문자열 배열이어야 합니다.');
  }
  const selected = taskIds === undefined ? null : new Set(taskIds);
  const groups = new Map((doc.groups || []).map(group => [group.id, group]));
  const owners = new Map();
  const groupMaps = new Map();
  for (const task of doc.tasks) {
    if (selected && !selected.has(task.id)) continue;
    const ownerKey = typeof task.ownerRole === 'string' && task.ownerRole.trim() ? task.ownerRole : null;
    if (!owners.has(ownerKey)) {
      owners.set(ownerKey, { owner: ownerKey === null ? UNASSIGNED_OWNER : ownerKey, groups: [] });
      groupMaps.set(ownerKey, new Map());
    }
    const owner = owners.get(ownerKey);
    const ownerGroups = groupMaps.get(ownerKey);
    const groupId = typeof task.groupId === 'string' ? task.groupId : '';
    if (!ownerGroups.has(groupId)) {
      const group = {
        id: groupId,
        title: groupId === '' ? UNGROUPED : (groups.get(groupId)?.title?.trim() ? groups.get(groupId).title : '이름 없는 영역'),
        tasks: [],
      };
      ownerGroups.set(groupId, group);
      owner.groups.push(group);
    }
    ownerGroups.get(groupId).tasks.push({
      id: task.id,
      title: typeof task.title === 'string' && task.title.trim() ? task.title : '이름 없는 업무',
    });
  }
  return [...owners.values()];
}

/**
 * Pass the app's safe element/button factories. The selection callback receives
 * the task ID and the actual trigger element so the owner can restore focus and
 * scroll after returning from the task. Omit onSelect for a static print view.
 */
export function renderWorkOverview({ doc, taskIds, onSelect, el, button } = {}) {
  if (typeof el !== 'function') throw new TypeError('화면 요소를 만드는 함수가 필요합니다.');
  const owners = buildWorkOverview(doc, { taskIds });
  const root = el('section', { class: 'work-overview', 'aria-label': '내 업무 한눈에 보기' },
    el('h2', {}, '내 업무 한눈에 보기'),
    el('p', { class: 'helper' }, '입력한 담당·큰 업무별로 모았습니다. 담당을 적지 않은 업무도 함께 표시합니다.'),
  );
  if (!owners.length) {
    root.append(el('div', { class: 'empty overview-empty' },
      el('h3', {}, '아직 정리할 업무가 없어요'),
      el('p', {}, '업무를 작성하면 담당과 큰 업무별 목록이 자동으로 나타납니다.'),
    ));
    return root;
  }
  const interactive = typeof onSelect === 'function';
  for (const owner of owners) {
    const count = owner.groups.reduce((sum, group) => sum + group.tasks.length, 0);
    const ownerNode = el('section', { class: 'overview-owner' },
      el('h3', { class: 'overview-owner-title' }, owner.owner,
        el('span', { class: 'overview-count' }, ` · ${count}개 업무`)),
    );
    for (const group of owner.groups) {
      const list = el('ul', { class: 'overview-task-list' });
      for (const task of group.tasks) {
        const attrs = { class: 'overview-task-link', 'data-task-id': task.id };
        const activate = event => onSelect(task.id, event.currentTarget);
        const title = interactive
          ? typeof button === 'function'
            ? button(task.title, activate, 'quiet', attrs)
            : el('button', { type: 'button', ...attrs, onclick: activate }, task.title)
          : el('span', { class: 'overview-task-title', 'data-task-id': task.id }, task.title);
        list.append(el('li', {}, title));
      }
      ownerNode.append(el('section', { class: 'overview-group', 'data-group-id': group.id },
        el('h4', { class: 'overview-group-title' }, group.title), list));
    }
    root.append(ownerNode);
  }
  return root;
}
