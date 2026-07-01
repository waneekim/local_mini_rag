import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { EmbeddingService, localNgramEmbedding } from "../src/rag/embedding.js";
import { extractExactTextCandidates, extractFigmaTextCandidates, repairFigmaAuditAnswer } from "../src/rag/figmaAudit.js";
import { ModeStore } from "../src/rag/modeStore.js";
import { normalizeUploadedFileName, sanitizeFileName } from "../src/rag/sanitize.js";
import { cosineSimilarity } from "../src/rag/vectorMath.js";

test("local embeddings rank related text above unrelated text", () => {
  const query = localNgramEmbedding("환불 정책");
  const related = localNgramEmbedding("고객 환불 정책은 구매 후 7일 이내에 처리됩니다.");
  const unrelated = localNgramEmbedding("오늘 점심 메뉴는 김치찌개입니다.");
  assert.ok(cosineSimilarity(query, related) > cosineSimilarity(query, unrelated));
});

test("http embedding backend uses OpenAI-compatible embeddings endpoint", async () => {
  const calls = [];
  const service = new EmbeddingService({
    backend: "http",
    embeddingsUrl: "http://embedding.local/v1/embeddings",
    apiKey: "test-key",
    model: "company-embedding",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 1, embedding: [0, 1] }
          ]
        })
      };
    }
  });

  const embeddings = await service.embed(["hello", "world"]);
  assert.deepEqual(embeddings, [
    [1, 0],
    [0, 1]
  ]);
  assert.equal(calls[0].url, "http://embedding.local/v1/embeddings");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-key");
  assert.equal(JSON.parse(calls[0].options.body).model, "company-embedding");
});

test("uploaded Korean filenames survive multipart mojibake", () => {
  const original = "자료/한글파일 이름.xlsx";
  const mojibake = Buffer.from(original, "utf8").toString("latin1");
  assert.equal(normalizeUploadedFileName(mojibake), original);
  assert.equal(sanitizeFileName(normalizeUploadedFileName(mojibake)), original);
  assert.equal(normalizeUploadedFileName(original), original);
});

test("mode store merges new default presets into existing saved modes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-modes-"));
  await writeFile(
    join(dataDir, "modes.json"),
    JSON.stringify([
      {
        key: "general",
        label: "일반",
        aliases: ["일반"],
        hint: "기존 저장 모드",
        system: "saved general prompt"
      },
      {
        key: "compliance",
        label: "규율",
        aliases: ["규율", "규격", "검수"],
        hint: "기존 규율 모드",
        system: "old compliance prompt"
      }
    ]),
    "utf8"
  );

  const store = new ModeStore(dataDir);
  const modes = store.list();
  assert.equal(modes.some((mode) => mode.key === "figmaAudit"), true);
  assert.equal(modes.some((mode) => mode.key === "compliance"), false);
  assert.equal(store.get("규율").key, "figmaAudit");
  assert.equal(store.get("figmaAudit").label, "규율");
  assert.equal(store.get("general").system, "saved general prompt");
});

test("figma preset asks for corrected sentence and cited rationale", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-modes-figma-"));
  const store = new ModeStore(dataDir);
  const figma = store.get("figmaAudit");

  assert.equal(figma.label, "규율");
  assert.match(figma.hint, /문구·용어/);
  assert.match(figma.system, /올바른 문장:/);
  assert.match(figma.system, /근거:/);
  assert.match(figma.system, /\[n\]/);
});

test("figma exact candidates prefer the closest input match over citation order", () => {
  const candidates = extractExactTextCandidates("가는 말이 고와야 오는 말도 곱다", [
    {
      number: 1,
      title: "속담",
      text: "오는 말이 고와야 가는 말이 곱다\n오는 정이 있어야 가는 정이 있다"
    },
    {
      number: 2,
      title: "속담",
      text: "가는 말이 고와야 오는 말도 곱다"
    }
  ]);

  assert.equal(candidates[0].text, "가는 말이 고와야 오는 말도 곱다");
  assert.equal(candidates[0].number, 2);
  assert.equal(candidates[0].exact, true);
  assert.equal(candidates[0].confidence, 1);
  assert.equal(candidates[0].reason, "입력 문장과 원문이 일치합니다.");
});

test("figma similar candidates are exposed as recommendation candidates", () => {
  const { exactCandidates, suggestionCandidates } = extractFigmaTextCandidates("가는 말에 채찍을 때린다.", [
    {
      number: 1,
      title: "속담",
      text: "가는 말에 채찍질한다"
    }
  ]);

  assert.equal(exactCandidates.length, 0);
  assert.equal(suggestionCandidates[0].text, "가는 말에 채찍질한다");
  assert.equal(suggestionCandidates[0].number, 1);
  assert.equal(Math.round(suggestionCandidates[0].confidence * 100), 65);
  assert.match(suggestionCandidates[0].reason, /가는/);
});

test("figma answer repair replaces hallucinated corrected sentence with exact candidate", () => {
  const repaired = repairFigmaAuditAnswer(
    "올바른 문장: 가는 말이 고나오면 오는 말도 곱다\n근거: [1] 속담의 구조에 맞추어 '고나'로 수정합니다.\n추천 표현: 없음",
    [{ number: 1, text: "오는 말이 고와야 가는 말이 곱다" }]
  );

  assert.equal(repaired.repaired, true);
  assert.match(repaired.answer, /올바른 문장: 오는 말이 고와야 가는 말이 곱다/);
  assert.match(repaired.answer, /근거: 참조문서의 원문 표현입니다\. \[1\]/);
  assert.match(repaired.answer, /추천 표현:\n- 오는 말이 고와야 가는 말이 곱다 \[1\] · 유사도 100% · 입력 문장과 원문이 일치합니다\./);
});

test("figma answer repair uses the best matched exact candidate as the strict source of truth", () => {
  const candidates = extractExactTextCandidates("가는 말이 고와야 오는 말도 곱다", [
    {
      number: 1,
      title: "속담",
      text: "오는 말이 고와야 가는 말이 곱다"
    },
    {
      number: 2,
      title: "속담",
      text: "가는 말이 고와야 오는 말도 곱다"
    }
  ]);
  const repaired = repairFigmaAuditAnswer(
    "올바른 문장: 오는 말이 고와야 가는 말이 곱다\n근거: 관련 규칙 없음",
    candidates
  );

  assert.equal(repaired.repaired, true);
  assert.match(repaired.answer, /올바른 문장: 가는 말이 고와야 오는 말도 곱다/);
  assert.match(repaired.answer, /근거: 참조문서의 원문 표현입니다\. \[2\]/);
  assert.match(repaired.answer, /추천 표현:\n- 가는 말이 고와야 오는 말도 곱다 \[2\] · 유사도 100% · 입력 문장과 원문이 일치합니다\./);
});

test("figma answer repair fixes rationale citation when the corrected sentence is already right", () => {
  const candidates = extractExactTextCandidates("가는 말이 고와야 오는 말도 곱다", [
    {
      number: 1,
      title: "속담",
      text: "오는 말이 고와야 가는 말이 곱다"
    },
    {
      number: 2,
      title: "속담",
      text: "가는 말이 고와야 오는 말도 곱다"
    }
  ]);
  const repaired = repairFigmaAuditAnswer(
    "올바른 문장: 가는 말이 고와야 오는 말도 곱다\n근거: 관련 규칙 없음\n추천 표현: 없음",
    candidates
  );

  assert.equal(repaired.repaired, true);
  assert.match(repaired.answer, /올바른 문장: 가는 말이 고와야 오는 말도 곱다/);
  assert.match(repaired.answer, /근거: 참조문서의 원문 표현입니다\. \[2\]/);
  assert.match(repaired.answer, /추천 표현:\n- 가는 말이 고와야 오는 말도 곱다 \[2\] · 유사도 100% · 입력 문장과 원문이 일치합니다\./);
});

test("figma answer repair always shows recommendation expressions for similar candidates", () => {
  const { exactCandidates, suggestionCandidates } = extractFigmaTextCandidates("가는 말에 채찍을 때린다.", [
    {
      number: 1,
      title: "속담",
      text: "가는 말에 채찍질한다"
    }
  ]);
  const repaired = repairFigmaAuditAnswer(
    "올바른 문장: 원문 유지\n근거: 관련 규칙 없음",
    exactCandidates,
    suggestionCandidates
  );

  assert.equal(repaired.repaired, true);
  assert.match(repaired.answer, /올바른 문장: 판단 보류/);
  assert.match(repaired.answer, /근거: 정확히 일치하는 원문은 없지만 유사한 원문 후보가 있습니다\. \[1\]/);
  assert.match(repaired.answer, /추천 표현:\n- 가는 말에 채찍질한다 \[1\] · 유사도 65% · /);
});

test("figma answer repair keeps recommendation section even when no candidates match", () => {
  const repaired = repairFigmaAuditAnswer("올바른 문장: 원문 유지\n근거: 관련 규칙 없음", [], []);

  assert.equal(repaired.repaired, true);
  assert.match(repaired.answer, /올바른 문장: 판단 보류/);
  assert.match(repaired.answer, /추천 표현:\n- 추천 가능한 원문 후보 없음 · 유사도 기준 미달 · 참조문서에서 충분히 가까운 표현을 찾지 못했습니다\./);
});

test("profile text sources can be indexed, searched, and isolated", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-api-"));
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      generate: async ({ envelope }) => ({
        answer: `answer with ${envelope.citations.length} citations`,
        provider: { provider: "test", model: "mock" },
        raw: {}
      })
    }
  });

  try {
    const profileA = await post(app, "/api/profiles", { name: "A" });
    const profileB = await post(app, "/api/profiles", { name: "B" });

    await post(app, `/api/profiles/${profileA.id}/sources/text`, {
      title: "환불 정책",
      text: "고객 환불 정책은 구매 후 7일 이내에 처리됩니다. 영수증이 필요합니다."
    });
    await post(app, `/api/profiles/${profileB.id}/sources/text`, {
      title: "점심 메뉴",
      text: "오늘 점심 메뉴는 김치찌개와 계란말이입니다."
    });

    const job = await post(app, `/api/profiles/${profileA.id}/index`, {});
    await waitForJob(app, job.id);

    const search = await post(app, `/api/profiles/${profileA.id}/search`, { query: "환불은 언제 되나요?" });
    assert.equal(search.hits.length > 0, true);
    assert.equal(search.hits[0].title, "환불 정책");

    const isolated = await post(app, `/api/profiles/${profileB.id}/search`, { query: "환불은 언제 되나요?" });
    assert.equal(isolated.hits.length, 0);

    const chat = await post(app, `/api/profiles/${profileA.id}/chat`, { query: "환불은 언제 되나요?" });
    assert.equal(chat.answer, "answer with 1 citations");
    assert.equal(chat.citations.length, 1);
  } finally {
    await app.close();
  }
});

test("figma chat repairs hallucinated LLM output using exact source text", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-api-figma-repair-"));
  let seen = null;
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      generate: async (payload) => {
        seen = payload;
        return {
          answer:
            "올바른 문장: 가는 말이 고나오면 오는 말도 곱다\n근거: [1] 속담의 구조에 맞추어 '고나'로 수정합니다.\n추천 표현: 없음",
          provider: { provider: "test", model: "mock" },
          raw: {}
        };
      }
    }
  });

  try {
    const profile = await post(app, "/api/profiles", { name: "속담" });
    await post(app, `/api/profiles/${profile.id}/sources/text`, {
      title: "속담",
      text: "오는 말이 고와야 가는 말이 곱다\n가는 말이 고와야 오는 말도 곱다"
    });

    const job = await post(app, `/api/profiles/${profile.id}/index`, {});
    await waitForJob(app, job.id);

    const chat = await post(app, `/api/profiles/${profile.id}/chat`, {
      query: "가는 말이 고와야 오는 말도 곱다",
      mode: "figmaAudit",
      topK: 4
    });

    assert.match(seen.query, /정확 원문 후보:/);
    assert.match(seen.query, /\[1\] 가는 말이 고와야 오는 말도 곱다/);
    assert.equal(seen.temperature, 0);
    assert.match(chat.answer, /올바른 문장: 가는 말이 고와야 오는 말도 곱다/);
    assert.match(chat.answer, /추천 표현:\n- 가는 말이 고와야 오는 말도 곱다 \[1\] · 유사도 100% · 입력 문장과 원문이 일치합니다\./);
    assert.equal(chat.figmaGrounding.repaired, true);
    assert.equal(chat.figmaGrounding.exactCandidates[0].text, "가는 말이 고와야 오는 말도 곱다");
    assert.equal(chat.figmaGrounding.exactCandidates[0].number, 1);
    assert.equal(chat.figmaGrounding.suggestionCandidates[0].text, "오는 말이 고와야 가는 말이 곱다");
  } finally {
    await app.close();
  }
});

test("figma chat exposes similar source lines as recommendation candidates", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-api-figma-suggestion-"));
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      generate: async () => ({
        answer: "올바른 문장: 원문 유지\n근거: 관련 규칙 없음",
        provider: { provider: "test", model: "mock" },
        raw: {}
      })
    }
  });

  try {
    const profile = await post(app, "/api/profiles", { name: "속담" });
    await post(app, `/api/profiles/${profile.id}/sources/text`, {
      title: "속담",
      text: "가는 말에 채찍질한다"
    });

    const job = await post(app, `/api/profiles/${profile.id}/index`, {});
    await waitForJob(app, job.id);

    const chat = await post(app, `/api/profiles/${profile.id}/chat`, {
      query: "가는 말에 채찍을 때린다.",
      mode: "figmaAudit",
      topK: 4
    });

    assert.equal(chat.figmaGrounding.exactCandidates.length, 0);
    assert.equal(chat.figmaGrounding.suggestionCandidates[0].text, "가는 말에 채찍질한다");
    assert.match(chat.answer, /올바른 문장: 판단 보류/);
    assert.match(chat.answer, /가는 말에 채찍질한다 \[1\] · 유사도 65%/);
  } finally {
    await app.close();
  }
});

test("figma audit endpoint formats selected nodes for cited RAG review", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-api-figma-"));
  let seen = null;
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      generate: async (payload) => {
        seen = payload;
        return {
          answer: `figma review with ${payload.envelope.citations.length} citations`,
          provider: { provider: "test", model: "mock" },
          raw: {}
        };
      }
    }
  });

  try {
    const profile = await post(app, "/api/profiles", { name: "UX Guidelines" });
    await post(app, `/api/profiles/${profile.id}/sources/text`, {
      title: "버튼 문구 가이드",
      text: "버튼 문구는 사용자가 다음에 수행할 동작을 명확하게 설명해야 합니다. 모호한 확인 대신 가입하기처럼 동작을 드러내는 문장을 사용합니다."
    });

    const job = await post(app, `/api/profiles/${profile.id}/index`, {});
    await waitForJob(app, job.id);

    const audit = await post(app, "/api/figma/audit", {
      profileId: profile.id,
      focus: "버튼 CTA 문구",
      items: [
        {
          nodeId: "12:34",
          name: "Primary CTA",
          type: "TEXT",
          page: "Onboarding",
          frame: "Welcome",
          component: "Button/Primary",
          text: "확인",
          fontSize: 16
        }
      ]
    });

    assert.match(audit.answer, /올바른 문장: 판단 보류/);
    assert.match(audit.answer, /추천 표현:\n- 추천 가능한 원문 후보 없음/);
    assert.equal(audit.figma.items[0].nodeId, "12:34");
    assert.equal(audit.figma.items[0].text, "확인");
    assert.equal(audit.figma.truncated, false);
    assert.match(seen.system, /Figma UX writing/);
    assert.match(seen.system, /올바른 문장:/);
    assert.match(seen.query, /\[figma:1\]/);
    assert.match(seen.query, /올바른 문장:/);
    assert.match(seen.query, /Primary CTA/);
    assert.match(seen.query, /Visible text:\n확인/);
    assert.equal(seen.envelope.citations.length, 1);
  } finally {
    await app.close();
  }
});

async function post(app, url, body) {
  const response = await app.inject({
    method: "POST",
    url,
    payload: body,
    headers: { "content-type": "application/json" }
  });
  assert.equal(response.statusCode < 300, true, response.body);
  return response.json();
}

async function waitForJob(app, jobId) {
  for (let i = 0; i < 60; i += 1) {
    const response = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    assert.equal(response.statusCode, 200, response.body);
    const job = response.json();
    if (["completed", "completed_with_errors", "failed"].includes(job.status)) {
      assert.equal(job.status, "completed", job.message);
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("job timeout");
}
