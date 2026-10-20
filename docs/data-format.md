# 파일 형식과 보존 규칙

`schemaVersion: 1`과 사진을 담는 `schemaVersion: 2`를 지원합니다. 새 빈 문서는 v1으로 시작하고 사진을 처음 추가할 때 v2로 올립니다. v1의 선택 필드가 없는 기존 문서도 받아들이며 임의로 필드를 채우거나 원문을 바꾸지 않습니다. 이전 v1 앱은 v2 문서를 읽을 수 없습니다.

두 버전 모두 실행 가능한 스크립트나 HTML을 허용하는 형식이 아닙니다. 마크업처럼 보이는 일반 문자열은 문자로만 표시합니다. 정규 파서는 `src/model.js`의 `parseImport` / `validateDocument`입니다. 사진 바이트까지 **단일 JSON**에 포함하므로 별도 이미지 폴더·ZIP·서버 저장이 필요하지 않습니다. 파일은 암호화되지 않습니다.

문서: `schemaVersion,id,title,createdAt,updatedAt,tasks,cases,onboarding,sourceFiles`를 포함합니다. 선택 확장 `groups:[{id,title}]`, `provenance`를 지원합니다. 업무는 `groupId`로 큰 영역에 연결됩니다. 알 수 없는 필드는 조용히 버리지 않고 오류로 알립니다.

업무: `id,title,timing,method,purpose,materials,steps,contacts,approval,exceptions,doneWhen,evidence,verifiedAt,accessChecked,sourceRefs,firstDay,firstWeek`. 선택 필드 `groupId,ownerRole,supportRole,accessStatus`. 자료 접근 상태는 `unconfirmed,confirmed,notApplicable`; 이전 boolean은 호환용입니다.

v2 업무의 선택 필드 `images`는 다음 항목의 배열입니다. v1에는 `images`를 넣지 않습니다.

```text
{ id, section, caption, mime, width, height, data }
```

- `id`: 문서 안에서 고유한 안정적 ID. 업무 ID 등 다른 종류의 ID와도 중복될 수 없습니다.
- `section`: `method` 또는 `steps`. 사진이 놓인 설명 구역이며 특정 번호의 단계와 자동 대응한다는 뜻은 아닙니다.
- `caption`: 최대 400자의 선택 설명 문자열. 빈 문자열을 허용합니다.
- `mime`: `image/png` 또는 `image/jpeg`. 저장 파일에는 WebP를 직접 넣지 않습니다.
- `width,height`: 실제 이미지와 일치하는 양의 정수 픽셀 크기.
- `data`: 이미지 바이트의 표준 Base64 문자열. data URL·외부 URL·파일 경로가 아닙니다.

새 사진 입력은 PNG·JPEG·정지 WebP를 받습니다. 원본은 8 MiB, 한 변 8,192픽셀, 전체 1,600만 픽셀 이하입니다. 브라우저에서 디코딩한 전체 크기 픽셀을 PNG로 다시 만들며 입력 파일의 메타데이터를 그대로 복사하지 않습니다. 이 결과가 저장 한도를 넘으면 축소·압축한 JPEG를 선택안으로 제시하고 확인 후 추가합니다. JPEG에서는 투명 영역이 흰색이 됩니다. 원본 파일의 바이트나 메타데이터를 그대로 보존하는 첨부 기능은 아닙니다.

저장된 사진은 한 장 2 MiB, 업무당 20장, 문서 전체 100장·이미지 바이트 합계 16 MiB까지입니다. SVG·HTML·애니메이션, 형식과 실제 바이트가 다른 파일, 손상 구조·잘못된 크기·과대한 파일을 거부합니다. JSON 가져오기 화면은 구조 검사 후 브라우저 코덱으로도 사진을 읽어 확인합니다. Base64 때문에 사진이 포함된 JSON은 이미지 바이트 합계보다 커집니다.

일정: `kind`는 `regular,date,event,relative`. 월간 `dayRule`은 `dayOfMonth,monthEnd,monthStartUnconfirmed,firstBusinessDay`. 명확한 달력 날짜만 계산합니다. `startRule`은 사람이 읽는 준비 시작 기준이며 자연어를 임의 해석하지 않습니다.

진행 건: `id,title,status,nextAction,dueDate,waitingFor,notes,sourceRefs`. 상태는 `todo,doing,waiting,done`.

출처: `id,name,format,importedAt,excerpt,warnings`. `excerpt`에는 추출된 글이 들어가며 기존 문서의 이미지·원본 바이너리는 들어가지 않습니다. 사용자가 따로 첨부한 사진은 해당 업무의 `images`에 보관합니다.

일반 JSON 왕복은 ID·한국어·줄바꿈·탭·본문·출처·메타데이터와 저장된 사진 바이트·캡션을 유지합니다. 새 사본 가져오기는 문서·그룹·업무·사진·진행 건·출처 ID를 새로 발급하고 참조를 함께 변경합니다. `provenance`에 origin/copy 관계와 전체 ID 대응을 보존합니다. 선택한 원본 파일 자체는 수정하지 않습니다.

한도: JSON UTF-8 기준 **v1 5 MiB / v2 24 MiB**, 문서 내 업무/진행 건 각 500개, 큰 업무 100개, 출처 200개, 긴 필드 200,000자, 출처 발췌 1,048,576자, 제목 400자, 역할 1,000자, JSON 깊이 32, 노드 100,000. UI는 일부 필드에서 더 작은 입력 한도를 사용합니다.

파일 방어: 잘못된 JSON, 중복 속성·ID, 존재하지 않는 참조, 미지원 버전, 프로토타입 오염 키, 위험 제어문자·단독 surrogate, 손실될 수 있는 숫자, 과도한 크기·깊이·항목을 거부합니다. ZIP은 입력 20 MiB, 총 팽창 30 MiB, 항목 1,024개, XML 8 MiB·깊이96·노드150,000 제한과 CRC/경로/암호화/ZIP64 검사, XML 외부 개체/DOCTYPE 거부를 적용합니다.

PDF 가져오기는 텍스트 레이어만 페이지별로 읽습니다. 사진·화면 캡처를 추출하거나 업무·단계에 자동 연결하지 않으며, 표 구조와 이미지 안의 글자는 보존되지 않을 수 있습니다. 쪽번호만 읽힌 페이지에는 별도 확인 경고를 붙입니다. 제목 후보에서 쪽번호·명확한 기준일을 건너뛰고 반복 페이지·슬라이드 제목에 다음 짧은 줄을 붙일 수 있지만, 원문 블록은 그대로 유지합니다. 제목·업무 단위는 검토 화면에서 사람이 확인합니다.

업무 개요는 저장된 `ownerRole` → `groupId` → 업무 제목을 표시하는 파생 보기입니다. 담당을 적지 않았으면 `담당 미입력`으로 표시하고 담당자·분류를 추측하지 않습니다. 별도 개요 데이터를 JSON에 중복 저장하지 않습니다. 화면의 업무 제목에서 상세로 이동해 개요로 돌아올 수 있고, DOCX·인쇄 끝에는 선택 범위에 맞는 개요가 포함됩니다. DOCX에 들어간 사진·캡션을 외부에서 고쳐도 JSON에는 자동 동기화되지 않습니다.

자동 임시저장은 `src/document-store.js`가 관리하는 IndexedDB `handover.az.documents`의 `documents` 저장소를 사용합니다. 현재 문서 목록은 최대 30개, 직렬화된 UTF-8 합계 64 MiB까지이며 브라우저의 실제 할당량은 더 작을 수 있습니다. 마이그레이션 보존 원문과 브라우저 내부 저장 오버헤드는 이 문서 목록 크기와 별개입니다.

이전 `handover.az.documents.v1` localStorage 원문을 검사한 뒤 옮기되 삭제하지 않습니다. 옛 창에서 원문이 바뀌거나 저장 충돌·실패·차단을 감지하면 덮어쓰기를 멈추고 복구·백업 안내를 표시합니다. IndexedDB 자체가 미지원일 때만 안내 후 기존 localStorage 방식을 사용합니다.

편집 중 메모리의 내용, 기기의 자동 임시저장, 사용자가 직접 받는 JSON 파일은 서로 다른 상태입니다. IndexedDB의 저장 요청 성공만으로 저장 완료를 표시하지 않고 트랜잭션 완료를 기다립니다. 저장 중·실패 상태에서는 창을 닫기 전에 JSON 백업과 저장 상태를 확인해야 합니다. 자동저장이 성공해도 브라우저 데이터 삭제나 기기 분실에 대비한 파일 백업을 대신하지 않습니다.

수행 기록은 `handover.az.progress.v1` 키에 문서 ID별로 저장되며 원본 문서에 섞이지 않습니다. 날짜 업무의 키는 `업무ID@YYYY-MM-DD`, 날짜 없는 기록은 `업무ID@manual`입니다. 내보낸 수행 JSON은 기록 보관용이며 본문 가져오기 파일로 수용하지 않습니다.

자동 검증은 합성 이미지·문서, DOM 에뮬레이션, IndexedDB 모형을 사용합니다. 공개 Chrome의 가상 문서에서 사진·캡션·별도 수행 체크가 새로고침과 검사 탭 종료 후 재열기에도 복원되는 것을 확인했습니다. 기존 문서 6개의 목록·항목 수도 유지됐습니다. 파일 선택·이미지 클립보드·드롭·다운로드·인쇄창·브라우저 강제 종료는 미검증이며, 이번 관찰과 저장소 모형 통과가 모든 브라우저에서의 영구 보존을 보장하지 않습니다.
