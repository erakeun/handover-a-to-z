# 파일 형식과 보존 규칙

JSON `schemaVersion: 1`이며 실행 가능한 스크립트나 HTML을 허용하는 형식이 아닙니다. 마크업처럼 보이는 일반 문자열은 문자로만 표시합니다. 정규 파서는 `src/model.js`의 `parseImport` / `validateDocument`입니다.

문서: `id,title,createdAt,updatedAt,tasks,cases,onboarding,sourceFiles`를 포함합니다. 선택 확장 `groups:[{id,title}]`, `provenance`를 지원합니다. 업무는 `groupId`로 큰 영역에 연결됩니다. 원래 버전 1의 선택 필드가 없는 문서도 수정 없이 받아들입니다. 알 수 없는 필드는 조용히 버리지 않고 오류로 알립니다.

업무: `id,title,timing,method,purpose,materials,steps,contacts,approval,exceptions,doneWhen,evidence,verifiedAt,accessChecked,sourceRefs,firstDay,firstWeek`. 선택 필드 `groupId,ownerRole,supportRole,accessStatus`. 자료 접근 상태는 `unconfirmed,confirmed,notApplicable`; 이전 boolean은 호환용입니다.

일정: `kind`는 `regular,date,event,relative`. 월간 `dayRule`은 `dayOfMonth,monthEnd,monthStartUnconfirmed,firstBusinessDay`. 명확한 달력 날짜만 계산합니다. `startRule`은 사람이 읽는 준비 시작 기준이며 자연어를 임의 해석하지 않습니다.

진행 건: `id,title,status,nextAction,dueDate,waitingFor,notes,sourceRefs`. 상태는 `todo,doing,waiting,done`.

출처: `id,name,format,importedAt,excerpt,warnings`. `excerpt`에는 추출된 글이 들어가며 이미지·원본 바이너리는 들어가지 않습니다.

일반 JSON 왕복은 ID·한국어·줄바꿈·탭·본문·출처·메타데이터를 유지합니다. 새 사본 가져오기는 문서·그룹·업무·진행 건·출처 ID를 새로 발급하고 참조를 함께 변경합니다. `provenance`에 origin/copy 관계와 전체 ID 대응을 보존합니다. 파일 자체는 수정하지 않습니다.

한도: JSON UTF-8 5 MiB, 문서 내 업무/진행 건 각 500개, 큰 업무 100개, 출처 200개, 긴 필드 200,000자, 출처 발췌 1,048,576자, 제목 400자, 역할 1,000자, JSON 깊이 32, 노드 100,000. UI는 일부 필드에서 더 작은 입력 한도를 사용합니다.

파일 방어: 잘못된 JSON, 중복 속성·ID, 존재하지 않는 참조, 미지원 버전, 프로토타입 오염 키, 위험 제어문자·단독 surrogate, 손실될 수 있는 숫자, 과도한 크기·깊이·항목을 거부합니다. ZIP은 입력 20 MiB, 총 팽창 30 MiB, 항목 1,024개, XML 8 MiB·깊이96·노드150,000 제한과 CRC/경로/암호화/ZIP64 검사, XML 외부 개체/DOCTYPE 거부를 적용합니다.

수행 기록은 `handover.az.progress.v1` 키에 문서 ID별로 저장되며 원본 문서에 섞이지 않습니다. 날짜 업무의 키는 `업무ID@YYYY-MM-DD`, 날짜 없는 기록은 `업무ID@manual`입니다. 내보낸 수행 JSON은 기록 보관용이며 본문 가져오기 파일로 수용하지 않습니다.
