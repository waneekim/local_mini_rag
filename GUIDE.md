# ARK Local RAG — 오프라인 설치 가이드

이 패키지는 **개인 PC에서 나만의 로컬 RAG**를 실행하기 위한 오프라인 배포본입니다.
중앙 서버에서 발행한 Agent를 "내 로컬로 복제"해서 쓰거나, 내 문서를 올려 개인 지식베이스를 만들 수 있습니다.

---

## 1. 필요 사전 프로그램 (딱 2개)

의존 라이브러리(node_modules · 파이썬 패키지)는 이미 패키지에 동봉되어 있어 인터넷이 필요 없습니다.
다만 아래 **런타임 2가지**는 PC에 설치돼 있어야 합니다. 사내 소프트웨어 센터에서 받으면 됩니다.

| 프로그램 | 버전 | 확인 명령 |
|---|---|---|
| Node.js | 20 이상 | `node -v` |
| Python | 3.12 | `python --version` |

> 문서 추출(PDF/Excel/PPT) 기능은 Python을, 서버 실행은 Node.js를 사용합니다.

---

## 2. 설치 (1회)

1. 받은 `ark-local-rag.zip`을 원하는 폴더에 **압축 해제**합니다.
   - 예: `C:\ark-local-rag\`
   - 경로에 한글/공백이 있어도 되지만, 짧은 경로(`C:\ark-local-rag`)를 권장합니다.
2. 압축 푼 폴더에서 **`setup.bat`을 더블클릭**합니다.
   - 파이썬 가상환경(`.venv`)을 만들고, 동봉된 휠(`vendor\wheels`)로 문서 추출 패키지를 **오프라인 설치**합니다.
   - "설치 완료" 메시지가 나오면 됩니다.

---

## 3. 연결 설정 (`.env`)

1. 폴더 안 `.env.example`을 복사해 **`.env`** 파일을 만듭니다.
2. 회사 LLM·임베딩 주소는 기본값이 들어 있습니다. 필요 시 값만 확인/수정하세요.

```
LLM_BASE_URL=http://10.250.122.177:9000
LLM_MODEL=llm-large
VISION_MODEL=llm-large
EMBEDDINGS_URL=http://10.250.122.177:47270/v1/embeddings
EMBEDDINGS_MODEL=qwen3-embedding-4b
# LLM_API_KEY=            # 토큰이 필요하면 여기에 입력
```

> **중요:** 개인 PC에서는 `ARK_ADMIN_TOKEN`을 **비워두세요**(개인 모드). 그래야 중앙에서 복제(가져오기)가 인증 없이 됩니다.

---

## 4. 실행

- **`run.bat`을 더블클릭**하면 서버가 뜹니다.
- 브라우저에서 접속: **http://localhost:8787**

---

## 5. 사용법

### (A) 내 문서로 개인 RAG 만들기
1. 왼쪽에서 Agent(프로필) 생성
2. 파일 업로드(PDF·Word·PPT·Excel·이미지·텍스트) 또는 텍스트 붙여넣기
3. **인덱싱(임베딩)** 실행 → 완료되면 채팅에서 질문

### (B) 중앙에서 Agent 복제해 쓰기
1. ⚙️ 설정 → **중앙에서 가져오기**에 중앙 서버 주소 입력 (예: `http://10.250.133.179:8787`)
2. 목록에서 원하는 Agent의 **복제** 클릭 → 내 로컬로 복사됨

---

## 6. 자주 나는 문제

| 증상 | 원인 / 해결 |
|---|---|
| `node -v` / `python --version` 오류 | 런타임 미설치. 1번 참고해 설치 |
| 인덱싱 시 "1 source(s) need action" | `setup.bat`을 다시 실행해 파이썬 패키지 설치를 확인 |
| 복제 시 "관리자 인증이 필요합니다" | 내 `.env`에 `ARK_ADMIN_TOKEN`이 들어 있음 → **비우고** 재시작 |
| 한글 파일명 인덱싱 실패 | 이 배포본은 UTF-8 처리가 적용돼 있습니다. 최신 패키지인지 확인 |
| 포트 충돌 | `.env`에 `PORT=8788` 등으로 변경 |

---

## 7. 폴더 구성 (참고)

```
ark-local-rag\
├─ setup.bat            # 최초 1회 설치
├─ run.bat             # 서버 실행
├─ .env.example        # 연결 설정 예시 (복사해 .env 로)
├─ GUIDE.md            # 이 문서
├─ src\                # 서버 소스
├─ workers\            # 문서 추출·임베딩 파이썬 워커
├─ dist\client\        # 빌드된 웹 화면
├─ node_modules\       # 동봉된 Node 의존성 (오프라인)
└─ vendor\wheels\      # 동봉된 파이썬 휠 (오프라인)
```


---

## Desktop / Packaging

- Web server: `npm run build` then `npm start` serves the built client and API.
- Electron desktop: `npm run desktop` starts the tray app with its own OS userData database.
- Desktop installer: `npm run desktop:dist:win` or `npm run desktop:dist:mac` builds an Electron installer.
- Existing offline zip distribution remains available through `npm run package` and `/api/download/*`.
- Local LM Studio-style setup can start from `.env.local-example`; the company/default server setup remains in `.env.example`.
