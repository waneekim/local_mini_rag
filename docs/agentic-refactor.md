# 에이전트화 리팩토링 설계 (Agentic Refactor)

> 상태: **설계(design) 단계 — 구현 없음.** 이 문서는 현재 선형 RAG 파이프라인을
> "오케스트레이터 + 전문 에이전트" 구조로 리팩토링하기 위한 합의용 설계서입니다.
> 1차 목표는 **검색·답변 품질(Phase 1)** 이며, 재임베딩 없이 런타임 경로만 바꿉니다.

---

## 1. 배경 — 현재 구조 (as-is)

`RagService.chat()`(`src/rag/ragService.js:1010`)이 **고정된 선형 시퀀스**로 동작합니다.

```
소스 수집 → 추출(py 워커) → 청킹(고정 크기, chunking.js) → 임베딩(맥락 헤더 부착)
   → 저장(SQLite) → 검색(코사인 0.8 + 렉시컬 0.2) → 리랭크(옵션)
   → 컨텍스트 조립 → 규칙 lint 주입 → 피드백 메모리 주입 → LLM 생성
```

이미 LLM이 쓰이는 지점(4곳):

| 기능 | 위치 | 성격 |
|------|------|------|
| 답변 생성 | `LlmProvider.generate` (`llmProvider.js:106`) | 모드별 시스템 프롬프트 |
| 규칙 추출 | `RagService.extractRules` (`ragService.js:372`) | 윈도우별 1회 추출 |
| LLM 리랭크 | `RerankService._rerankLlm` (`rerank.js:66`) | (질의, 청크) 쌍 채점 |
| 비전 OCR | `RagService.visionExtract` (`ragService.js:89`) | 이미지 → 텍스트 |

아직 결정론·휴리스틱이라 개선 여지가 큰 지점:

- **청킹**: 고정 크기 슬라이딩 윈도우(`chunking.js`) — 구조·의미 무시.
- **검색**: 사용자 쿼리를 **그대로 1회** 임베딩(`search` `ragService.js:882`). 재작성·확장·분해 없음.
- **모드 선택**: 수동(사용자가 칩/슬래시로 지정).
- **답변 검증**: 없음. `[n]` 인용이 실제 근거를 뒷받침하는지 확인하지 않음.

### 반드시 계승할 코드 DNA — "항상 안전하게 폴백"

이 코드베이스는 부가 기능이 실패하면 **조용히 기본 동작으로 되돌아갑니다.**

- 리랭커 실패 → 임베딩 순서 유지 (`maybeRerank` `ragService.js:973`)
- 피드백 임베딩 실패 → 빈 블록 (`recallFeedback` `ragService.js:477`)
- 리랭커가 전부 0점/미달 → 임베딩 순서 유지 (`ragService.js:969`)

에이전트화도 **이 폴백 철학 위에** 얹습니다. 어떤 에이전트도 기본 경로를 깨뜨리지 않습니다.

---

## 2. 설계 원칙

### 2.1 선형 파이프라인 → 오케스트레이터 + 에이전트

`chat()`의 고정 시퀀스를 **plan → retrieve → generate → verify** 루프로 바꾸고,
각 단계를 **단일 책임 + 자체 폴백을 가진 에이전트**로 분리합니다.

### 2.2 공통 Agent 계약

모든 에이전트는 동일한 형태를 따릅니다. (새 프레임워크 없이 순수 함수/클래스로 구현)

```js
// 개념적 계약 — 구현은 Phase별로
interface Agent {
  name: string;
  enabled(ctx): boolean;           // env 플래그 + 런타임 조건
  async run(ctx): AgentResult;     // 실패해도 throw 금지 — 폴백 결과 반환
}

// 모든 에이전트가 공유하는 실행 컨텍스트
ctx = {
  profileId, query, mode,
  envelope,        // 지금의 KnowledgeEnvelope (contextText, hits, citations)
  llm, embeddings, reranker,       // 기존 핸들 재사용 (새 프로바이더 없음)
  logger, budget   // { maxLlmCalls, deadlineMs }
}

AgentResult = {
  ...payload,
  meta: { name, usedLlm: bool, llmCalls: n, ms, fallback: bool }
}
```

핵심 규칙:

1. **폴백 필수** — `run()`은 예외를 던지지 않는다. 실패 시 `fallback:true` + 기본값.
2. **단일 LLM 핸들 재사용** — `ctx.llm.complete()` / `generate()`. 새 프로바이더·SDK 없음.
3. **예산(budget) 준수** — `maxLlmCalls`·`deadlineMs`를 넘기면 남은 에이전트는 스킵.
4. **텔레메트리 누적** — 각 `meta.ms`를 기존 `timings`(`ragService.js:927`)에 합류.

### 2.3 env 플래그 — 기본 off, 옵트인

기존 `RAG_RERANK`, `RAG_FEEDBACK_MEMORY` 패턴을 그대로 따릅니다.

| 플래그 | 기본 | 대상 |
|--------|------|------|
| `RAG_AGENT_PLANNER` | `off` | 질의계획·라우터 (#1) |
| `RAG_AGENT_VERIFY` | `off` | 답변·근거검증 (#5) |
| `RAG_AGENT_RETRIEVE` | `off` | 적응형 검색 (#2, Phase 2) |
| `RAG_AGENT_BUDGET_CALLS` | `4` | 요청당 추가 LLM 호출 상한 |
| `RAG_AGENT_DEADLINE_MS` | `20000` | 에이전트 루프 전체 마감 |

> **전부 off면 지금과 100% 동일한 동작·속도.** 저사양 LM Studio 사용자는 그대로,
> 여유 있는 사용자만 켭니다.

### 2.4 API 계약 유지

엔드포인트·요청·응답 스키마는 그대로. 응답의 `timings`에 에이전트 단계가 추가되고,
`meta.agents[]`(선택)로 어떤 에이전트가 무엇을 했는지 관측만 늘어납니다.

---

## 3. Phase 1 — 검색·답변 품질 (상세)

재임베딩 불필요. `chat()` 런타임 경로만 바꿉니다. 세 조각: **오케스트레이터(#6) +
질의계획(#1) + 근거검증(#5)**.

### 3.1 오케스트레이터 (#6) — 뼈대

현재 `chat()` 본문(`ragService.js:1010-1072`)의 선형 흐름을 조율 루프로 대체.
**모든 에이전트 off면 아래 루프는 지금의 `chat()`과 바이트 단위로 동일한 경로**를 탑니다.

```
async chat(profileId, input):
  query = normalize(input.query)
  ctx   = buildAgentContext(profileId, query, input)   # llm, embeddings, budget 포함

  # 1) PLAN — 질의계획·라우터 (#1)
  plan = await planner.run(ctx)          # off → { mode: input.mode, queries: [query] }
  ctx.mode = plan.mode

  # 2) RETRIEVE — 지금의 buildContext, 멀티쿼리면 융합
  envelope = await retrieve(ctx, plan.queries)   # Phase1: 기존 search + RRF 융합만
  ctx.envelope = envelope

  # 3) 기존 주입 단계 유지 (규칙 lint, 피드백 메모리)
  applyRuleLint(ctx); await applyFeedbackMemory(ctx)

  # 4) GENERATE — 기존 llm.generate
  draft = await llm.generate({ query, envelope, system: mode.system })

  # 5) VERIFY — 답변·근거검증 (#5)
  final = await verifier.run({ ...ctx, draft })  # off → draft 그대로

  persistChatRun(...); return { answer: final.answer, citations, timings, meta }
```

파일별 변경 지점:

- `ragService.js` — `chat()`를 위 루프로 리팩토링. `buildContext`/`search`/`recallFeedback`는
  **그대로 재사용**(에이전트가 이들을 호출). 새 파일 `src/rag/agents/` 디렉터리 신설.
- `src/rag/agents/orchestrator.js` (신규) — 루프 + budget/deadline 관리.
- 응답 `timings`에 `planMs`, `verifyMs` 추가.

### 3.2 질의계획·라우터 에이전트 (#1)

**위치**: retrieve 이전. **LLM**: 1회(경량, temperature 0).

**역할**
1. **모드 자동판별** — 사용자가 모드를 명시 안 했을 때만. "이 문구 규격 맞아?" → `compliance`,
   "어떤 패턴 써야 해?" → `recommend` 등. 명시했으면 건드리지 않음.
2. **쿼리 재작성/확장** — 짧고 모호한 질문을 2~3개 패러프레이즈로 확장(멀티쿼리).
   선택적으로 HyDE(가상 답변) 1개를 회수용으로 생성.
3. **복합 질문 분해** — "A와 B의 차이는?" → `[A, B]` 서브쿼리.

**입출력**

```js
in:  { query, mode?(사용자 명시), profileId }
out: { mode, queries: string[], rationale?, meta }
```

**폴백**: LLM 실패·off → `{ mode: input.mode || "general", queries: [query] }` (현재 동작).

**효과**: README가 지목한 "짧은 질문은 검색이 어렵다" 약점을 회수 단계에서 직접 완화.
멀티쿼리 결과는 **RRF(Reciprocal Rank Fusion)** 로 융합 후 기존 리랭커에 전달.

**프롬프트 스케치**
```
system: 당신은 RAG 질의 계획기다. 사용자 질문을 분석해 (1) 대화 모드,
        (2) 검색에 쓸 1~3개의 재작성 질의, (3) 필요하면 서브질문으로 분해한다.
        JSON만 출력: {"mode": "...", "queries": ["..."]}.
```

### 3.3 답변·근거검증 에이전트 (#5) — 최대 신뢰도 레버

**위치**: `llm.generate` 직후. **LLM**: 1회(검증), 미근거 시 최대 1회 추가(수정).

**역할**
1. 초안 답변의 각 `[n]` 주장이 **인용된 청크로 실제 뒷받침되는지** 검증.
2. 미근거 주장 발견 시:
   - `검색` 모드: 해당 주장 제거 또는 "근거 없음" 표기 → 1회 재작성.
   - `일반` 모드: 경고 메타만 부착(자유 대화이므로 강제 안 함).
3. 인용 번호가 실제 citations 범위를 벗어나면 정리.

**입출력**

```js
in:  { draft.answer, envelope.citations, mode }
out: { answer, groundedness: 0..1, unsupported: string[], meta }
```

**폴백**: LLM 실패·off → 초안 그대로 반환(현재 동작). 검증은 **부가 안전장치**이지
차단막이 아니다.

**효과**: 특히 `검색`·`규율` 모드에서 환각을 줄여 "근거만 인용" 약속을 강제.
응답에 `groundedness` 점수를 실어 UI 상태줄(현재 timings 표시 옆)에 노출 가능.

**프롬프트 스케치**
```
system: 당신은 사실 검증기다. 답변의 각 문장이 제공된 근거 [n]으로 뒷받침되는지
        확인하라. 뒷받침 안 되는 주장을 나열하고, 요청 시 근거에만 기반해 답을
        재작성하라. 근거를 넘어서 추측하지 말 것.
```

### 3.4 Phase 1 완료 기준

- [ ] `src/rag/agents/{orchestrator,planner,verifier}.js` + 공통 `agent.js` 계약.
- [ ] 모든 플래그 off일 때 기존 `tests/rag.test.js` 그린 + 동작 동일성 확인.
- [ ] 플래그 on일 때 `timings.planMs`/`verifyMs`·`meta.agents` 노출.
- [ ] 각 에이전트 단위 테스트(폴백 경로 포함).

---

## 4. Phase 2 — 인덱싱·회수 강화 (개요)

재임베딩·색인 비용이 있어 Phase 1 이후.

### 4.1 인덱싱·구조화 에이전트 (#3)
`indexSource()`(`ragService.js:824`)의 임베딩 직전에서, LLM이:
- **구조 기반 청킹** — 고정 크기 대신 섹션·의미 경계로 분할.
- **청크별 맥락 요약** — Anthropic Contextual Retrieval 방식의 1줄 컨텍스트를 임베딩 텍스트에 부착
  (현재 `chunkHeader`의 확장).
- **가설 질문 생성** — "이 청크가 답하는 질문" N개를 함께 색인 → README "질문 먼저" 원칙 자동화.

플래그 `RAG_AGENT_INGEST`. 색인은 지연 허용이라 배치 처리. 폴백 → 현재 `chunkDocuments`.

### 4.2 적응형 검색 에이전트 (#2)
`search`/`maybeRerank`를 감싸: 멀티쿼리 회수 → RRF 융합 → 리랭크 →
"근거 충분?" 자가판단(LLM 1회) → 부족하면 `minScore` 낮춰 1회 확대 재검색.
플래그 `RAG_AGENT_RETRIEVE`. 폴백 → 현재 단발 검색.

---

## 5. Phase 3 — 자동화·자기개선 (개요)

### 5.1 규칙 추출 에이전트 (#4)
`extractRules()`를 자가검토형으로: 추출 → **윈도우 간 중복 병합** → 자기비평 → 초안.
현재는 윈도우별 1회라 중복이 다발. 폴백 → 현재 1회 추출.

### 5.2 피드백 증류 에이전트 (#7)
축적된 👍/👎·교정을 주기적으로 **승인 규칙·가이드 스니펫으로 증류**(오프라인 배치).
현재는 쿼리별 임베딩 recall만 있음. 지속 학습 루프 완성.

---

## 6. 롤아웃·리스크

| 항목 | 방침 |
|------|------|
| 하위호환 | 모든 플래그 off = 현재와 동일. 엔드포인트 스키마 불변. |
| 성능 | 추가 LLM 호출은 `RAG_AGENT_BUDGET_CALLS`·`RAG_AGENT_DEADLINE_MS`로 상한. |
| 저사양 환경 | 기본 off. 각 에이전트 개별 토글. |
| 관측성 | `timings` 확장 + `meta.agents[]`. UI 상태줄에 groundedness 노출 가능. |
| 테스트 | 에이전트별 단위 테스트 + off 동작 동일성 회귀 테스트. |
| 롤백 | 에이전트는 순수 부가 계층 — 플래그 끄면 즉시 원복. |

## 7. 디렉터리 구조 (제안)

```
src/rag/
  agents/
    agent.js          # 공통 계약 · budget · 텔레메트리 헬퍼
    orchestrator.js   # plan→retrieve→generate→verify 루프
    planner.js        # #1 질의계획·라우터
    verifier.js       # #5 답변·근거검증
    retriever.js      # #2 (Phase 2)
    ingestor.js       # #3 (Phase 2)
  ragService.js       # chat()가 orchestrator를 호출하도록 리팩토링
```
