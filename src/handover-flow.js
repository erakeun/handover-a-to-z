// Presentation decisions shared by web and document output. Importing a legacy
// record never changes its stored state or treats an old default as evidence.
const CASE_LABELS = Object.freeze({ unknown: '상태 미확인', todo: '시작 전', doing: '진행 중', waiting: '회신 대기', done: '완료' });

export function caseState(item) {
  return item?.statusConfirmed === true && Object.hasOwn(CASE_LABELS, item.status) ? item.status : 'unknown';
}
export function caseStateLabel(item) { return CASE_LABELS[caseState(item)]; }
export function caseRecordedLabel(item) { return CASE_LABELS[item?.status] || '상태 미확인'; }
export function firstActionText(task) { return (task?.firstAction || '').trim(); }

// Only exact repetitions are
// omitted from the reading view. The JSON always retains both original fields.
export function distinctInstructions(task) {
  const method = String(task?.method || '');
  const steps = String(task?.steps || '');
  const same = method === steps;
  return [
    ...(method.trim() ? [{ key: 'method', label: '하는 방법', text: method }] : []),
    ...(steps.trim() && !same ? [{ key: 'steps', label: '진행 순서', text: steps }] : []),
  ];
}

export function taskReadiness(task) {
  if (firstActionText(task)) return '첫 행동 안내 있음';
  if (distinctInstructions(task).length) return '본문 안내 있음';
  return task?.sourceRefs?.length ? '원문으로 보기' : '읽기 확인 필요';
}
