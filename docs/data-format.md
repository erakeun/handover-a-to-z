# 파일 형식과 보존 규칙

0.3.0은 `schemaVersion: 1`, `2`, `3`을 지원하며 새 문서는 **v3**으로 만듭니다. 정규 파서는 `src/model.js`의 `parseImport` / `validateDocument`입니다. JSON은 사진과 연결한 PDF 바이트까지 담는 단일 파일이며 암호화되지 않습니다. 실행 스크립트나 HTML을 저장·실행하는 형식이 아니며 마크업처럼 보이는 일반 문자열도 문자로 표시합니다.

## 버전 경계

| 버전 | 허용 범위 | JSON 한도 |
| --- | --- | --- |
| v1 | 기존 글 중심 문서. 사진과 v3 확장 필드 없음 | UTF-8 5 MiB |
| v2 | 기존 문서와 업무별 사진. v3 확장 필드 없음 | UTF-8 24 MiB |
| v3 | 사진, 첫 행동, 확인된 진행 상태·업무 연결, 날짜 미정 월말, PDF 근거 | UTF-8 24 MiB |

유효한 v1·v2의 읽기·검증·직렬화는 기존 버전과 누락된 선택 필드를 유지합니다. 새 사본 가져오기도 버전을 유지하되 사본용 ID와 참조를 함께 바꿉니다. 단순히 파일을 열었다는 이유로 v3가 되지 않습니다. **사용자가 내용을 편집할 때** 앱은 문서를 v3로 올립니다. 원본 파일은 바꾸지 않습니다.

v1·v2에 v3 전용 필드나 enum을 섞으면 거부합니다. 알 수 없는 필드를 버리거나 버전 숫자만 바꾸어 수용하지 않습니다. 미지원 버전은 최신 앱에서 열라는 안내와 함께 거부합니다. 0.2.0 이하 앱은 v3 파일을 읽을 수 없으며 자동 다운그레이드는 제공하지 않습니다.

## 문서와 업무

문서는 `schemaVersion,id,title,createdAt,updatedAt,tasks,cases,onboarding,sourceFiles`를 포함합니다. 선택 확장은 `groups:[{id,title}]`, `provenance`입니다. 업무는 `groupId`로 큰 영역과 연결됩니다. 알 수 없는 필드는 조용히 버리지 않고 오류로 알립니다.

업무의 기존 필드는 `id,title,timing,method,purpose,materials,steps,contacts,approval,exceptions,doneWhen,evidence,verifiedAt,accessChecked,sourceRefs,firstDay,firstWeek`입니다. 기존 선택 필드는 `groupId,ownerRole,supportRole,accessStatus`입니다. 자료 접근 상태는 `unconfirmed,confirmed,notApplicable`이며 이전 boolean은 호환용으로 보존합니다.

v3의 선택 필드 **`firstAction`**은 최대 2,000자의 시작 행동 안내입니다. 비워도 유효하며 원문에서 추정해 강제로 채우지 않습니다. `method`와 `steps`가 완전히 같으면 읽는 화면에서 중복을 줄일 수 있지만 JSON의 두 원문 필드는 유지합니다.

업무지도는 저장된 담당 역할·큰 업무·업무 제목으로 만든 파생 보기입니다. 담당이 없으면 `담당 미입력`으로 표시하고 추측하지 않습니다. 별도 지도 데이터를 JSON에 중복 저장하지 않습니다.

## 사진

v2·v3 업무의 선택 필드 `images`는 아래 항목의 배열입니다. v1에는 넣지 않습니다.

```text
{ id, section, caption, mime, width, height, data }
```

- `id`: 문서 안에서 다른 종류의 ID와도 중복되지 않는 ID.
- `section`: `method` 또는 `steps`. 설명 구역을 뜻하며 특정 번호 단계와의 자동 대응은 아닙니다.
- `caption`: 최대 400자의 선택 설명. 빈 문자열을 허용합니다.
- `mime`: `image/png` 또는 `image/jpeg`.
- `width,height`: 실제 이미지와 일치하는 양의 정수 픽셀 크기.
- `data`: 이미지 바이트의 표준 Base64. data URL·외부 URL·파일 경로가 아닙니다.

새 사진은 PNG·JPEG·정지 WebP를 받습니다. 입력 한도는 한 장 8 MiB, 한 변 8,192픽셀, 전체 1,600만 픽셀입니다. 브라우저에서 디코딩한 전체 크기 픽셀을 PNG로 다시 만들므로 원본 바이트·메타데이터를 그대로 보존하는 첨부 기능은 아닙니다. 저장 한도를 넘으면 축소·압축한 JPEG를 선택안으로 제시하고 확인 후 추가합니다. JPEG의 투명 영역은 흰색이 됩니다.

저장된 사진은 한 장 2 MiB, 업무당 20장, 문서 전체 100장·이미지 바이트 합계 16 MiB까지입니다. SVG·HTML·애니메이션, 형식과 실제 바이트 불일치, 손상 구조·잘못된 크기·과대한 파일은 거부합니다. JSON 가져오기는 구조 검사 후 브라우저 코덱으로 사진을 읽어 확인합니다. Base64 때문에 JSON 크기는 이미지 바이트 합계보다 커집니다.

## 일정과 진행 건

일정 `kind`는 `regular,date,event,relative`입니다. 월간 `dayRule`은 기존 `dayOfMonth,monthEnd,monthStartUnconfirmed,firstBusinessDay`와 v3 전용 **`monthEndUnconfirmed`**를 지원합니다.

- `monthStartUnconfirmed`: 월초이지만 정확한 날짜를 정하지 않음. 자동으로 1일이 되지 않습니다.
- `monthEndUnconfirmed`: 월말이지만 정확한 날짜를 정하지 않음. 자동으로 마지막 날이 되지 않습니다.
- `monthEnd`: 달력의 정확한 마지막 날짜.
- `firstBusinessDay`: 휴일 확인이 필요한 첫 영업일 규칙. 기관별 휴일을 자동 확정하지 않습니다.

명확한 달력 날짜만 계산합니다. `startRule`은 사람이 읽는 준비 시작 기준이며 자연어를 임의 해석하지 않습니다.

진행 건의 기존 필드는 `id,title,status,nextAction,dueDate,waitingFor,notes,sourceRefs`이고 기존 상태는 `todo,doing,waiting,done`입니다. v3는 다음을 추가합니다.

| 필드·값 | 의미 |
| --- | --- |
| `status: "unknown"` | 아직 모르는 상태 |
| `statusConfirmed` | 선택 boolean. `true`일 때 명시된 상태를 확인된 현재 상태로 표시 |
| `taskId` | 선택 문자열. 빈 값 또는 실제로 존재하는 업무 ID로 진행 건과 업무 설명을 연결 |

새 진행 건은 `unknown`·`statusConfirmed:false`로 시작합니다. 확인 표시가 없거나 `false`이면 읽는 화면은 **상태 미확인**으로 보여 줍니다. 기존 `status` 값은 삭제하거나 `unknown`으로 덮어쓰지 않고 이전 기록으로 남깁니다. 직접 상태를 선택하면 확인 여부와 상태를 함께 기록합니다. 업무 설명의 완료 체크와 진행 건 상태는 별개이며 새 개인 수행 체크는 만들지 않습니다.

## 출처와 PDF

출처의 기본 필드는 `id,name,format,importedAt,excerpt,warnings`입니다. `excerpt`는 추출된 글이며 원래 파일 전체가 아닙니다. DOCX·PPTX·HWPX의 그림·원본 바이너리는 여기에 들어가지 않습니다. 따로 넣은 사진은 업무의 `images`에 보관합니다.

v3에서 `format: "pdf"`인 출처는 선택 필드 **`pdf`**를 포함할 수 있습니다.

```text
sourceFiles[].pdf = { data: "표준 Base64로 인코딩한 PDF 전체 바이트", pageCount: 2 }
```

`data`는 URL이나 로컬 경로가 아닌 정규 Base64이며 PDF 한 파일은 **10 MiB 이하**, `pageCount`는 **1~200 정수**입니다. 전체 JSON의 24 MiB 제한도 함께 적용됩니다. 전달 가능한지 검토한 PDF를 연결하며, 선택한 페이지를 보고 있어도 **PDF 전체**가 JSON에 포함됩니다. 원본 파일을 바꾸거나 서버에 전송하지 않습니다.

PDF 페이지 보기와 텍스트 추출은 구분합니다. 스캔 OCR·암호화 PDF·표 구조 자동 복원은 지원하지 않습니다. 글꼴·페이지 구조에 따라 글이 누락되거나 읽는 순서가 달라질 수 있습니다. PDF의 표·사진·문맥은 원래 페이지를 열어 확인해야 하며 추출문을 자동으로 확정 절차로 만들지 않습니다. PDF와 사진 속 글은 업무 검색 대상이 아닙니다.

## 사본·출력·검증 한도

일반 JSON 왕복은 ID·한국어·줄바꿈·탭·본문·출처·메타데이터와 저장된 사진·PDF 바이트를 유지합니다. 새 사본 가져오기는 문서·그룹·업무·사진·진행 건·출처 ID를 새로 발급하고 `sourceRefs`, `groupId`, `taskId` 등의 참조를 함께 바꿉니다. `provenance`는 origin/copy 관계와 ID 대응을 보존합니다. 사본 이력 envelope의 `handover-a-to-z/v1` 식별자는 문서의 `schemaVersion`과 별개입니다.

DOCX·인쇄에는 업무지도·실행 안내·사진·캡션·진행 건을 넣습니다. PDF 자체, 전체 출처 발췌, 내부 복사 이력은 전달 JSON에 남습니다. DOCX를 외부에서 수정해도 JSON에는 자동 동기화되지 않습니다. 다시 가져오면 검토할 새 초안입니다.

문서 한도는 업무·진행 건 각 500개, 큰 업무 100개, 출처 200개, 긴 필드 200,000자, 출처 발췌 1,048,576자, 제목 400자, 역할 1,000자, JSON 깊이 32·노드 100,000입니다. UI는 일부 필드에 더 작은 입력 한도를 적용합니다.

잘못된 JSON, 중복 속성·ID, 존재하지 않는 참조, 미지원 버전, 프로토타입 오염 키, 위험 제어문자·단독 surrogate, 손실될 수 있는 숫자, 과도한 크기·깊이·항목을 거부합니다. ZIP은 입력 20 MiB·총 팽창 30 MiB·항목 1,024개, XML은 8 MiB·깊이 96·노드 150,000 제한을 적용합니다. CRC·경로·암호화·ZIP64를 검사하고 XML 외부 개체·DOCTYPE을 거부합니다.

## 자동 임시저장과 구버전 복구

자동 임시저장은 `src/document-store.js`가 관리합니다. IndexedDB 이름은 **`handover.az.documents`**, DB 버전은 `1`, object store는 `documents`이며 v3용 기록 키는 **`current-v3`**입니다. 이전 키 `current`와 localStorage **`handover.az.documents.v1`**의 원문은 검증 후 새 영역으로 복사하며 수정·삭제하지 않습니다. 처음 전환할 때 기존 IndexedDB 기록이 있으면 그 최신 원문을 복사합니다. 이 복사로 문서 버전·본문·ID를 바꾸지 않습니다.

IndexedDB 자체가 미지원일 때 쓰는 별도 localStorage 키는 **`handover.az.documents.v3`**입니다. 전환 시 원본 변경을 확인할 작은 SHA-256 기준 메타데이터는 `handover.az.migration.v3`에 둡니다. 현재 문서 선택 키는 `handover.az.current.v3`이며 이전 `handover.az.current.v1`과 분리합니다. 저장소 열기 실패·차단을 미지원으로 간주해 조용히 localStorage에 쓰지는 않습니다.

이전 창에서 구저장 원문이 바뀌거나, 다른 저장 경로·창에서 변경해 충돌이 감지되면 덮어쓰기를 멈추고 읽기 전용 상태와 원본 보관·복구를 안내합니다. 기준 메타데이터는 백업 파일이 아니며 여러 창의 변경을 자동 병합하지 않습니다.

현재 문서 목록은 최대 30개·직렬화된 UTF-8 합계 64 MiB이며 브라우저 실제 할당량은 더 작을 수 있습니다. 보존하는 이전 원문과 브라우저 내부 오버헤드는 문서 목록 크기와 별개입니다. 사진·PDF가 많은 문서는 JSON 파일도 따로 보관해야 합니다.

편집 중 메모리, 브라우저 임시저장, 직접 받은 JSON 파일은 서로 다른 상태입니다. IndexedDB 요청 성공만으로 저장 완료로 표시하지 않고 트랜잭션 완료를 기다립니다. 저장 실패 시 화면의 내용이 남아 있어도 기기에 보존됐다고 단정하지 않습니다.

구버전 앱으로 롤백하면 이전 원문은 남아 있지만 v3에서 새로 작성한 내용은 구버전 화면에 나타나지 않습니다. 새 내용은 v3 영역에 남으며 **데이터 다운그레이드나 구저장소와의 양방향 동기화를 하지 않습니다.** 최신 앱과 v3 JSON 백업을 사용해 복구해야 합니다. 브라우저 데이터 삭제·기기 분실에 대비한 파일 백업은 여전히 필요합니다.

이전 개인 수행 기록은 `handover.az.progress.v1`에 문서 ID별로 남습니다. 날짜 업무의 키는 `업무ID@YYYY-MM-DD`, 날짜 없는 기록은 `업무ID@manual`입니다. 내보낸 수행 JSON은 보관용이며 본문 가져오기 파일로 수용하지 않습니다. 현재 진행 건의 상태는 문서 JSON에 담깁니다.

자동 검사는 합성 자료·DOM 에뮬레이션·저장소 모형을 포함합니다. 실제 브라우저 다운로드는 확인했으나 실제 파일 선택창 재열기는 자동화 확장의 file-URL 권한 거절로 완료하지 못했습니다. 실제 인쇄창·초심자 수행 시험도 미검증입니다. 구체적인 관찰과 한계는 [0.3.0 릴리스 검토 기록](../REVIEW.md)에 남깁니다.
