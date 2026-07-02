# Local Agent Profile RAG

로컬 문서를 빠르게 RAG로 구성해 **대화·검색·검수·분석**하는 웹앱입니다. Agent(프로필)별로
파일·폴더·텍스트·로컬 경로·URL을 넣어 임베딩하고, 목적별 모드 챗봇으로 활용합니다. LLM과
임베딩은 OpenAI 호환 엔드포인트(LM Studio, 사내 서버 등)에 연결합니다.

## 빠른 시작

```bash
npm install
npm run dev          # API(127.0.0.1:8787) + 웹(Vite) 동시 실행
npm run py:deps      # PDF/Word/Excel/PPT 추출용 Python 워커 의존성 (.venv)
```

`npm run dev`가 출력하는 Vite URL을 브라우저로 엽니다. 설정은 모두 `data/`에 저장되며 git에
추적되지 않으므로, 집/회사 PC마다 독립적으로 유지됩니다.

---

## 다른 사람과 함께 쓰기 — 중앙 공유 RAG + 개인 로컬 RAG

두 가지 방식을 **동시에** 지원합니다.

1. **중앙 공유 RAG (호스트)** — 내 PC에서 서버를 띄우고, 내가 만든 에이전트를 **발행**하면
   다른 디자이너가 내 IP로 접속해 **열람·대화**하거나 자기 PC로 **복제**할 수 있습니다.
   중앙 에이전트의 수정·발행은 **관리자 암호(`ARK_ADMIN_TOKEN`)를 아는 나만** 할 수 있습니다.
2. **개인 로컬 RAG** — 디자이너가 자기 PC에 이 앱을 설치·실행하면, 자기가 넣은 에이전트·소스는
   **자기 로컬 `data/`(SQLite)에만** 저장됩니다. 중앙 서버로 나가지 않습니다.

### A. 호스트(중앙 서버) 띄우기 — 내 자리

```bash
npm install
npm run build                       # 웹 UI를 dist/client로 빌드 (API와 같은 포트에서 서빙)
ARK_ADMIN_TOKEN=원하는암호 npm start   # http://0.0.0.0:8787 (같은 포트에서 UI+API)
```

- 접속 주소는 `http://<내-IP>:8787` 입니다. (같은 사내망/LAN에서 접근. 방화벽에서 **8787 포트 인바운드 허용**)
- 내 IP 확인: macOS/Linux `ipconfig getifaddr en0` 또는 `hostname -I`.
- `ARK_ADMIN_TOKEN`을 **설정하면** 읽기(열람·검색·대화·중앙 조회)는 누구나 가능하지만,
  **모든 수정(에이전트/소스 추가·삭제·발행·설정 변경)은 관리자 암호가 있어야** 합니다.
  설정하지 않으면 기존처럼 잠금 없이 동작합니다(개인 로컬용).
- 에이전트를 공유하려면 UI ⚙️ → **중앙 라이브러리 → 발행**에서 **발행** 버튼을 누릅니다.
  (관리자 암호를 넣어야 발행 버튼이 활성화됩니다: ⚙️ → 중앙 라이브러리 → 관리자 암호 → 인증)

### B. 접속한 디자이너 — 두 가지 사용법

**① 내 서버에 바로 접속해서 미리 만든 에이전트 쓰기**
- 브라우저로 `http://<사장님-IP>:8787` 접속 → 발행된 중앙 에이전트를 **열람·대화**.
- 수정은 막혀 있고(관리자 전용), 그대로 대화만 하거나 아래 ②로 복제해서 씁니다.

**② 자기 PC에서 자기 에이전트를 만들어 로컬 저장**
- 디자이너도 이 저장소를 받아 `npm install && npm run build && npm start` (암호 없이 실행 → 완전 개인용).
- 자기 에이전트·소스는 자기 `data/`에만 저장됩니다.
- 필요하면 ⚙️ → **중앙 라이브러리 → 중앙에서 가져오기**에 `http://<사장님-IP>:8787`을 넣고
  **불러오기** → 원하는 중앙 에이전트 옆 **복제** 를 누르면, 임베딩까지 통째로 **내 로컬로 복제**됩니다.
  (내 임베딩 모델이 중앙과 다르면 청크 텍스트로 **자동 재임베딩**하여 검색이 깨지지 않습니다.)

> 임베딩 정합성: 중앙과 로컬의 임베딩 백엔드·모델이 같으면 벡터를 그대로 복사(빠름), 다르면
> 로컬 임베딩 모델로 재임베딩합니다. 팀에서 같은 임베딩 프리셋을 쓰면 가장 매끄럽습니다.

---

## RAG 데이터 설계 가이드 — "질문 먼저" 원칙

RAG 품질의 8할은 **넣기 전 자료 설계**에서 갈립니다. 검색 엔진은 아래 기법을 이미 적용해
두었으니(질문 instruction 자동 적용, 청크 맥락 헤더, 관련성 최저선), **자료를 이 원칙대로
정리**하면 체감이 크게 달라집니다.

**1) 질문을 먼저 적고, 그 질문이 답해지도록 자료를 구성한다.**
   - Agent를 만들기 전에 "이 Agent에 사람들이 뭘 물어볼까?"를 10~20개 적으세요.
   - 각 질문에 답이 되는 문단이 자료 안에 **명시적으로** 있어야 합니다. 표·이미지에만 있는
     정보는 검색이 어렵습니다 → 핵심은 문장으로도 적어두세요.

**2) Agent는 "주제/목적" 단위로 좁게 나눈다.** (두루뭉실 금지)
   - ❌ `디자인팀` 하나에 전부 → ⭕ `버튼·인터랙션 가이드`, `보이스앤톤`, `접근성 체크리스트`처럼
     **한 Agent = 한 주제**. 좁을수록 검색이 정확합니다.
   - 서로 다른 주제를 한 Agent에 섞으면 임베딩 공간에서 신호가 흐려집니다.

**3) 원천 자료를 "청크가 잘 잘리게" 정리한다.**
   - 문서를 **짧은 섹션 + 명확한 제목**으로 구성. 제목이 청크 헤더로 함께 임베딩됩니다.
   - 한 규칙 = 한 문단. "언제/무엇을/왜"가 한 곳에 모이게. 여러 페이지에 흩어진 규칙은 붙이세요.
   - 표는 "항목: 값" 문장으로 풀거나, 표 위에 요약 문단을 답니다.
   - 규정·체크리스트처럼 조밀한 문서는 `RAG_CHUNK_SIZE=800` 정도로 줄이면 더 정확합니다.

**4) 넣은 뒤 반드시 검증한다.**
   - **검색 모드**로 1)에서 적은 질문을 던져 보고, 우측 **참조 문서**에 맞는 근거가 뜨는지 확인.
   - 안 뜨면: 그 질문의 답 문단을 더 명확히 쓰거나 제목을 붙여 **재임베딩**(⚡).
   - 엉뚱한 근거가 섞이면 `RAG_MIN_SCORE`(예 0.3)를 올려 잡음을 걷어냅니다.

**5) 모드를 목적에 맞게 쓴다.** 자유 대화는 **일반**, 근거만 인용해 답하게 하려면 **검색**,
   가이드 위반 검수는 **규율**. 근거만 원하면 검색 모드가 환각을 크게 줄입니다.

**6) 정확도를 더 올리려면 — 리랭커.** 임베딩은 후보를 넓게 회수하고, **리랭커**가 (질문, 문단)
   쌍을 정밀 재정렬합니다. `qwen3-reranker`를 배포했다면 `RERANK_URL`+`RERANK_MODEL`(http),
   없으면 `RAG_RERANK=llm`으로 기존 `llm-large`를 재정렬에 씁니다. 실패해도 임베딩 순서로 안전하게
   폴백합니다. 애매한 근거가 섞이는 Agent에서 체감이 가장 큽니다.

> 재임베딩 안내: 위 검색 엔진 개선(청크 맥락 헤더 등)은 **다시 임베딩한 자료부터** 적용됩니다.
> 기존 Agent는 ⚙️/⚡ **전체 임베딩**으로 한 번 다시 돌리면 품질이 올라갑니다.
> (리랭커는 재임베딩 없이 즉시 적용됩니다 — 검색 시점에만 동작.)

### 구조화 규칙 — 금지어 필터 & 교정 (Agent 우클릭 → 규칙)

"사용하면 안 되는 단어·문장"은 임베딩 검색으로는 잘 안 걸립니다(추천/회피 예시가 의미상 둘 다
비슷하기 때문). 그래서 **결정론적 규칙**으로 따로 관리합니다.

1. **추출**: Agent 우클릭 → **규칙(가이드)** → *가이드에서 규칙 추출*. LLM이 문서를 읽어
   `{ 섹션, 원칙, 금지어[], 권장어[], 추천↔회피 예시 }` **초안**을 만듭니다.
2. **검토·승인**: 초안을 확인/수정하고 **승인**합니다. **승인된 규칙만** 검사·답변에 쓰입니다.
3. **검사(lint)**: 모달의 문장 검사창 또는 **규율/추천 모드** 대화에서, 입력 문장의 금지 표현을
   **정확 매칭**으로 즉시 감지해 `⚠️ '사용자' → 권장 '나/내'`처럼 표시하고, 그 근거를 LLM 답변에
   함께 주입해 **교정문**을 생성합니다.
4. **루프**: 문장 몇 개로 검사 → 놓치거나 오탐이면 규칙의 금지어/예시를 고치고 다시 → 반복.

> 표는 인덱싱 시 `추천: … · 피해야 할 말: …` 형태로 보존되므로, 추출 전에 가이드 Agent를 한 번
> **재임베딩**하면 규칙 추출 품질이 올라갑니다.

---

## 1. 연결 설정 — LM Studio & 프리셋

좌측 상단 ⚙️ → **연결 설정**. LLM과 임베딩 서버를 따로 지정하고, **이름 붙은 프리셋**으로
환경(집/회사 등)을 전환합니다.

### LM Studio 로컬 세팅 (집)
1. LM Studio에서 **채팅 모델**과 **임베딩 모델**을 각각 로드 (둘 다 동시 로드 가능)
   - 예) 채팅 `qwen2.5-7b-instruct`, 임베딩 `text-embedding-bge-m3` (1024차원, 한국어 강함)
2. **Local Server → Start** (기본 포트 1234)
3. ⚙️ 프리셋에 입력
   - LLM: `http://localhost:1234/v1` / 모델명
   - 임베딩: `http://localhost:1234/v1/embeddings` / 모델명 / 차원수(선택, 비우면 자동)

> 속도 팁: 혼자 쓰는 RAG라면 LM Studio 모델 로드 설정의 **Parallel을 1**로 두면 단일 요청에
> 자원을 몰아줘 빨라집니다. 응답이 길어 느리면 `LLM_MAX_TOKENS`(기본 1024)로 출력 길이를 제한하세요.

### 프리셋
- 드롭다운에서 프리셋 선택 시 **즉시 그 연결로 전환**됩니다 (`· 사용 중` 표시).
- `+ 새 프리셋…`으로 추가하고, 이름·URL·모델만 채우면 됩니다. 회사에선 사내 서버 URL만 넣으면 끝.
- **차원수는 선택값**입니다. http 백엔드에선 서버가 차원을 정하므로 비워도 동작합니다(`auto`).

### Claude(UX 환경) 연결 참고
이 앱은 OpenAI 호환 `/chat/completions`를 사용합니다. Anthropic Claude API는 형식이 달라
(`/v1/messages`) **OpenAI 호환 게이트웨이**를 거치거나 별도 프로바이더 구현이 필요합니다.
임베딩은 Anthropic이 제공하지 않으므로 임베딩은 로컬/사내 서버를 함께 씁니다(프리셋에서 LLM과
임베딩을 따로 지정 가능).

---

## 2. 소스 추가 — 5가지 방법

입력창 하단 아이콘, Agent 우클릭 메뉴, 드래그앤드롭, 슬래시 명령으로 추가할 수 있습니다.

| 방법 | UI | 명령 |
|------|----|------|
| 파일 업로드 | 📤 파일 추가 | (드래그앤드롭) |
| 폴더 업로드 | 📁 폴더 추가 | (드래그앤드롭) |
| 텍스트 붙여넣기 | 📄 텍스트 추가 | `/add <텍스트>` |
| 로컬 경로(파일/폴더) | Agent 우클릭 | `/add @<경로>` |
| 웹페이지(URL) | 🔗 URL 추가 | `/add <URL>` |

### 임베딩 가능한 형식 (`/types`)
- **문서**: PDF, Word(.docx), PowerPoint(.pptx), Excel(.xlsx/.xlsm)
- **텍스트**: .txt .md .csv .json .html .log
- **이미지(OCR)**: .png .jpg .jpeg .tif .webp — `tesseract` 설치 필요
- **레거시 Office**(.doc/.ppt/.xls) — LibreOffice `soffice` 설치 필요
- 그 밖에: 붙여넣은 텍스트, URL, 로컬 폴더/파일 경로
- 제한: **100MB/파일 · 한 번에 200개** (`RAG_MAX_FILE_BYTES`, `RAG_MAX_FILES`로 조정)

> PDF/Office 추출은 `npm run py:deps`로 워커 의존성을 설치해야 동작합니다(텍스트·URL은 불필요).

### 자동 임베딩
입력창 도구의 **⚡ 토글**(켜면 강조) 또는 `/autoindex on|off`. 켜두면 소스를 추가하는 즉시
임베딩까지 자동으로 수행합니다. 설정은 브라우저에 저장됩니다.

---

## 3. 임베딩 & 상태 표시

좌측 Agent를 펼치면 소스가 **파일 트리**로 보입니다.

- **전체 임베딩** 버튼 / `새 항목 N`(임베딩 안 된 것만) / 파일별 ⚡ 버튼
- 상태 점: 🟢 임베딩됨 · ⚪ 대기 · 🟡 처리중 · 🔴 실패
- Agent 배지 `임베딩됨/전체` (예 `3/5`, 전부 되면 초록)
- 명령: `/embed @<소스>` · `/embed @all` · `/embed @except` · `/list` · `/embed-list` · `/no-embed-list`

각 소스 행은 호버 시 ⚡(임베딩)·🗑(삭제), Agent 행은 ⚡(전체 임베딩)·✏️(이름)·🗑(삭제) 아이콘을 보여줍니다.

---

## 4. 대화 모드

입력창 위 칩으로 전환하거나 `/<모드명>`으로 전환합니다. **일반**이 기본입니다.

| 모드 | 용도 |
|------|------|
| **일반** | 자유 대화, 관련 문서가 있으면 근거로 활용 |
| **검색** | 문서에서만 찾아 근거 인용 |
| **규율** | 입력한 UX 문구가 가이드 규격에 맞는지 검수 → ✅/⚠️ + 규칙 인용 + 수정안 |
| **추천** | 가이드에 근거해 적절한 UI/UX 패턴·문구 추천 |
| **분석** | 요약·강점·문제점·개선제안으로 구조화 분석 |

### 모드 편집 (최대 10개)
⚙️ → **대화 모드**에서 이름·설명·별칭·**지시문(시스템 프롬프트)**을 편집하고, 추가/삭제할 수 있습니다.
지시문이 그 모드에서 LLM이 따르는 규칙입니다. 기본 5개가 시드되어 있습니다.

---

## 5. Agent 활용

- **@Agent 멘션**: 입력창에 `@`를 치면 Agent 자동완성이 뜹니다. `@다른Agent 질문`으로 현재 Agent를
  바꾸지 않고 **그 Agent의 임베딩 기반**으로 답을 받습니다.
- **Agent 검색**: 좌측 검색창에 입력하면 Agent 이름 또는 그 안의 소스 이름으로 필터됩니다.
- **다른 Agent로 복사**: 소스를 다른 Agent 위로 **드래그앤드롭**하면 임베딩까지 함께 복사되어
  바로 사용 가능합니다(전역 임베딩 모델이 같아 RAG가 깨지지 않음).
- **이름 편집/삭제**: Agent 행 호버 시 ✏️/🗑.

---

## 6. 참조 문서 (인용)

- 채팅 우측 **참조 문서** 패널은 답변이 실제로 인용한 `[n]`만 표시합니다(없으면 검색된 문서 표시).
- 답변 속 `[1]` 또는 패널 항목을 클릭하면 **새 팝업 창**으로 원문이 열리고, **질문 키워드가
  노란색으로 하이라이트**됩니다. 팝업은 브라우저 밖으로 빼서 나란히 볼 수 있습니다.

---

## 7. 스킬 (답변 후처리)

⚠️ 스킬은 **다운로드한 실행 코드(Python/JS)를 서브프로세스로 실행**합니다. 신뢰된 사내 저장소 1개만 쓰세요.

- ⚙️ → **스킬**에 사내 GitHub 저장소 URL 입력 → **동기화** → 목록에서 **설치**
- 로컬 `skills/<이름>/`에 직접 넣어도 인식됩니다. 매니페스트 `skill.json`:
  ```json
  { "name": "ux-report", "description": "...", "runtime": "python", "entry": "run.py", "input": "answer" }
  ```
- 실행: 채팅에서 `/<스킬이름>` → **직전 답변**(+인용·대화)을 stdin(JSON)으로 받아 가공한 결과를
  채팅에 출력합니다. `/skills`로 목록 확인. 번들 예시 `skills/ux-report`.

---

## 8. 슬래시 명령 / 자동완성

입력창에 `/`를 치면 **추천 명령 목록**이 위로 뜹니다(↑/↓ 이동, Enter/Tab 선택). `@`는 Agent 자동완성.

| 명령 | 동작 |
|------|------|
| `/<모드>` | 모드 전환 (일반/검색/규율/추천/분석/사용자정의) |
| `/add <텍스트>` · `/add @<경로>` · `/add <URL>` | 소스 추가 |
| `/del @<소스>` | 소스 삭제 |
| `/embed @<소스>` · `@all` · `@except` | 임베딩 |
| `/list` · `/embed-list` · `/no-embed-list` | 소스 목록 |
| `/types` | 지원 파일 형식 |
| `/autoindex on\|off` | 추가 시 자동 임베딩 |
| `/<스킬>` · `/skills` | 스킬 실행 / 목록 |
| `/help` | 전체 도움말 |

---

## 9. 화면 구성

- 좌: Agent 목록(+검색) / 중앙: 채팅(상단 답변, 하단 입력) / 우: 참조 문서
- 패널 사이 경계와 입력창 위를 드래그하면 너비/높이를 조절할 수 있고, 값은 브라우저에 저장됩니다.

---

## 설정·데이터 저장 위치 (`data/`, gitignore)

| 파일 | 내용 |
|------|------|
| `data/rag.sqlite` | 프로필·소스·청크(임베딩)·잡·대화 |
| `data/settings.json` | 연결 프리셋(LLM·임베딩) |
| `data/modes.json` | 대화 모드(편집 시 생성) |
| `data/skills.json`, `data/.skills-repo/` | 스킬 저장소 설정·캐시 |
| `data/uploads/` | 업로드된 원본 파일 |
| `.venv/` | 문서 추출 워커 의존성 |

---

## API

프로필·소스
- `GET/POST /api/profiles` · `PATCH/DELETE /api/profiles/:id`
- `GET /api/profiles/:id/sources`
- `POST /api/profiles/:id/sources/files` · `/text` · `/path` · `/url` · `/copy`
- `DELETE /api/profiles/:id/sources/:sourceId`
- `POST /api/profiles/:id/index` · `GET /api/jobs/:jobId`

대화·검색
- `POST /api/profiles/:id/search` · `/context` · `/chat`  (`chat` 본문에 `mode` 지정; 규율/추천 모드는 응답에 `violations` 포함)

구조화 규칙(가이드 컴플라이언스)
- `GET /api/profiles/:id/rules` · `POST /api/profiles/:id/rules` · `PATCH`/`DELETE /api/profiles/:id/rules/:ruleId`
- `POST /api/profiles/:id/rules/extract` (LLM 초안 추출) · `POST /api/profiles/:id/lint` (`{ text }` → 위반 목록)

중앙 라이브러리(공유 RAG)·인증
- `GET /api/auth` (관리자 필요 여부) · `POST /api/auth/verify`
- `POST /api/profiles/:id/publish` (`{ published }`, 관리자)
- `GET /api/central/profiles` (발행된 목록) · `GET /api/central/profiles/:id/export`
- `POST /api/central/browse` (`{ remoteUrl }`) · `POST /api/central/import` (`{ remoteUrl, profileId, newName? }`)

설정·모드·스킬
- `GET/PUT /api/settings` · `POST /api/settings/select` · `DELETE /api/settings/:name`
- `GET/PUT /api/modes` · `DELETE /api/modes/:key`
- `GET /api/skills` · `GET /api/skills/available` · `POST /api/skills/sync` · `/install`
- `DELETE /api/skills/:name` · `POST /api/skills/:name/run` · `GET/PUT /api/skills/config`
- `GET /v1/health`

`/context`는 에이전트 런타임에 주입할 수 있는 `KnowledgeEnvelope`를 반환합니다:

```json
{ "profileId": "...", "query": "...", "contextText": "[1] ...", "hits": [], "citations": [], "sourceVersion": "count:updatedAt" }
```

---

## 환경 변수 (`.env`, 선택)

프리셋(`data/settings.json`)이 우선이며, 없을 때 `.env` 기본값이 쓰입니다. 여기 값들은
⚙️ 연결 설정의 **"기본" 프리셋으로 자동 등록**됩니다. 회사 서버 설정은 **`.env.example`에
바로 쓸 수 있게 준비**되어 있으니 `cp .env.example .env` 후 사용하세요(API Key는 커밋되지
않도록 브라우저에서 입력).

```env
# 채팅은 {LLM_BASE_URL}/chat/completions 로 호출 → base URL에 /v1 까지 포함해야 함(누락 시 404)
LLM_BASE_URL=http://localhost:1234/v1
LLM_MODEL=qwen2.5-7b-instruct
VISION_MODEL=            # 비전(스크린샷) 분석용 모델 id · LLM이 비전 겸용이면 LLM_MODEL과 동일
LLM_MAX_TOKENS=1024
# 요청 최상위로 병합되는 추가 필드(openai extra_body 상당). vLLM thinking 끄기 예:
# LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}
EMBEDDINGS_URL=http://localhost:1234/v1/embeddings
EMBEDDINGS_MODEL=text-embedding-bge-m3
RAG_EMBEDDING_DIMENSIONS=1024
# 검색 품질: instruction-aware 모델(qwen3-embedding 등)은 질문 instruction 자동 적용
# RAG_EMBED_QUERY_INSTRUCTION=..., RAG_EMBED_QUERY_PREFIX=..., RAG_EMBED_PASSAGE_PREFIX=...
# RAG_MIN_SCORE=0.3            # 이 점수 미만 근거는 버림(0=끔) · RAG_CHUNK_SIZE / RAG_CHUNK_OVERLAP
# 리랭커(정밀 재정렬): RERANK_URL(+RERANK_MODEL) 로 http 리랭커, 또는 RAG_RERANK=llm 으로 기존 LLM 사용
# RAG_RERANK_CANDIDATES=24, RAG_RERANK_MIN_SCORE=0.3
# API Key는 .env에 두지 말고 브라우저 ⚙️ 연결 설정에서 입력 권장 (LLM_API_KEY / EMBEDDINGS_API_KEY)
# 중앙 공유 서버로 쓸 때: 설정하면 읽기는 공개, 모든 수정은 이 암호 필요 (개인 로컬이면 비워둠)
# ARK_ADMIN_TOKEN=원하는암호
# HOST, PORT (기본 0.0.0.0:8787), CORS_ORIGIN
# RAG_MAX_FILE_BYTES, RAG_MAX_FILES, SKILLS_REPO, SKILL_TIMEOUT_MS, RAG_URL_TIMEOUT_MS
```
