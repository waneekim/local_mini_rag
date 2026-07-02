import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { EmbeddingService, localNgramEmbedding } from "../src/rag/embedding.js";
import { LlmProvider, parseJsonObject } from "../src/rag/llmProvider.js";
import { RerankService } from "../src/rag/rerank.js";
import { htmlToText } from "../src/rag/ragService.js";
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

test("chat posts to {baseUrl}/chat/completions and merges extra_body at top level", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
  };
  try {
    const provider = new LlmProvider({
      baseUrl: "http://llm.local:9000/v1",
      model: "llm-large",
      extraBody: { chat_template_kwargs: { enable_thinking: false } }
    });
    const result = await provider.generate({ query: "Hello", envelope: { contextText: "", citations: [] } });
    assert.equal(result.answer, "hi");
    assert.equal(calls[0].url, "http://llm.local:9000/v1/chat/completions");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, "llm-large");
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.messages[0].role, "system");
  } finally {
    globalThis.fetch = original;
  }
});

test("parseJsonObject accepts objects/JSON and rejects junk", () => {
  assert.deepEqual(parseJsonObject({ a: 1 }), { a: 1 });
  assert.deepEqual(parseJsonObject('{"chat_template_kwargs":{"enable_thinking":false}}'), {
    chat_template_kwargs: { enable_thinking: false }
  });
  assert.deepEqual(parseJsonObject(""), {});
  assert.deepEqual(parseJsonObject("[1,2]"), {});
  assert.deepEqual(parseJsonObject("not json"), {});
});

test("qwen3 embedding instructs the query but leaves passages raw", async () => {
  const bodies = [];
  const make = () =>
    new EmbeddingService({
      backend: "http",
      embeddingsUrl: "http://embed.local/v1/embeddings",
      model: "qwen3-embedding-4b",
      fetchFn: async (url, options) => {
        bodies.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) };
      }
    });

  await make().embed(["환불 규정 알려줘"], { mode: "query" });
  await make().embed(["환불은 7일 이내 처리됩니다."], { mode: "passage" });

  assert.match(bodies[0].input[0], /^Instruct: .+\nQuery: 환불 규정 알려줘$/);
  assert.equal(bodies[1].input[0], "환불은 7일 이내 처리됩니다."); // passage stays raw
});

test("non-instruct embedding models leave query text unchanged", async () => {
  const bodies = [];
  const service = new EmbeddingService({
    backend: "http",
    embeddingsUrl: "http://embed.local/v1/embeddings",
    model: "bge-m3",
    fetchFn: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) };
    }
  });
  await service.embed(["hello"], { mode: "query" });
  assert.equal(bodies[0].input[0], "hello");
});

test("http reranker posts query+documents and normalizes relevance_score", async () => {
  const calls = [];
  const service = new RerankService({
    url: "http://rerank.local/v1/rerank",
    model: "qwen3-reranker",
    fetchFn: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] })
      };
    }
  });
  assert.equal(service.enabled, true);
  const out = await service.rerank("환불 며칠?", ["점심 메뉴", "환불은 7일 이내"]);
  assert.equal(calls[0].url, "http://rerank.local/v1/rerank");
  assert.deepEqual(calls[0].body.documents, ["점심 메뉴", "환불은 7일 이내"]);
  const byIndex = Object.fromEntries(out.map((r) => [r.index, r.score]));
  assert.equal(byIndex[1], 0.9);
  assert.equal(byIndex[0], 0.1);
});

test("search applies the reranker order over embedding order", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-rerank-"));
  // Fake reranker: always ranks the SECOND candidate first.
  const reranker = {
    enabled: true,
    candidates: 24,
    minScore: null,
    rerank: async (query, docs) => docs.map((_, index) => ({ index, score: index === 1 ? 1 : 0.01 }))
  };
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    reranker,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      generate: async ({ envelope }) => ({ answer: "ok", provider: {}, raw: {} })
    }
  });
  try {
    const p = await post(app, "/api/profiles", { name: "P" });
    await post(app, `/api/profiles/${p.id}/sources/text`, { title: "환불 정책", text: "고객 환불은 구매 후 7일 이내에 처리됩니다. 영수증이 필요합니다." });
    await post(app, `/api/profiles/${p.id}/sources/text`, { title: "배송 안내", text: "배송은 보통 2~3일 소요되며 도서산간은 추가됩니다." });
    const job = await post(app, `/api/profiles/${p.id}/index`, {});
    await waitForJob(app, job.id);

    const search = await post(app, `/api/profiles/${p.id}/search`, { query: "환불 규정" });
    assert.equal(search.reranked, true);
    assert.equal(search.hits.length >= 2, true);
    // The fake reranker forces the 2nd embedding candidate to the top.
    assert.equal(search.hits[0].score, 1);
  } finally {
    await app.close();
  }
});

test("search falls back to embedding order when the reranker gives no signal", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-rr0-"));
  const reranker = {
    enabled: true,
    candidates: 24,
    minScore: null,
    rerank: async (query, docs) => docs.map((_, index) => ({ index, score: 0 })) // all zero
  };
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    reranker,
    llmProvider: { describe: () => ({ provider: "test", model: "mock" }), generate: async () => ({ answer: "ok", provider: {}, raw: {} }) }
  });
  try {
    const p = await post(app, "/api/profiles", { name: "P" });
    await post(app, `/api/profiles/${p.id}/sources/text`, { title: "환불 정책", text: "고객 환불은 구매 후 7일 이내에 처리됩니다." });
    const job = await post(app, `/api/profiles/${p.id}/index`, {});
    await waitForJob(app, job.id);
    const search = await post(app, `/api/profiles/${p.id}/search`, { query: "환불 규정" });
    assert.equal(search.reranked, false); // no-signal rerank ignored
    assert.equal(search.hits[0].score > 0, true); // embedding score preserved, not overwritten to 0
  } finally {
    await app.close();
  }
});

test("html extraction keeps recommend/avoid table pairs on one line", () => {
  const html = `<html><body>
    <h2>보이스앤톤</h2>
    <p>사용자는 '나'로 지칭한다.</p>
    <table>
      <tr><th>추천</th><th>피해야 할 말</th></tr>
      <tr><td>내 폰 찾기</td><td>사용자 폰 찾기</td></tr>
      <tr><td>내 모습을 추가로 등록하세요</td><td>사용자의 모습을 추가로 등록하세요</td></tr>
    </table>
  </body></html>`;
  const { text } = htmlToText(html);
  assert.match(text, /추천: 내 폰 찾기 · 피해야 할 말: 사용자 폰 찾기/);
  assert.match(text, /추천: 내 모습을 추가로 등록하세요 · 피해야 할 말: 사용자의 모습을 추가로 등록하세요/);
  assert.match(text, /사용자는 '나'로 지칭한다\./);
});

test("uploaded Korean filenames survive multipart mojibake", () => {
  const original = "자료/한글파일 이름.xlsx";
  const mojibake = Buffer.from(original, "utf8").toString("latin1");
  assert.equal(normalizeUploadedFileName(mojibake), original);
  assert.equal(sanitizeFileName(normalizeUploadedFileName(mojibake)), original);
  assert.equal(normalizeUploadedFileName(original), original);
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

test("central library: publish, export, and import into a second instance", async () => {
  const hostDir = await mkdtemp(join(tmpdir(), "rag-host-"));
  const localDir = await mkdtemp(join(tmpdir(), "rag-local-"));
  const mockLlm = {
    describe: () => ({ provider: "test", model: "mock" }),
    generate: async ({ envelope }) => ({
      answer: `answer with ${envelope.citations.length} citations`,
      provider: { provider: "test", model: "mock" },
      raw: {}
    })
  };
  const host = await createApp({ dataDir: hostDir, logger: false, cleanupDataDir: true, llmProvider: mockLlm });
  const local = await createApp({ dataDir: localDir, logger: false, cleanupDataDir: true, llmProvider: mockLlm });

  try {
    const hostBase = await host.listen({ host: "127.0.0.1", port: 0 });

    const shared = await post(host, "/api/profiles", { name: "가이드" });
    await post(host, `/api/profiles/${shared.id}/sources/text`, {
      title: "환불 정책",
      text: "고객 환불 정책은 구매 후 7일 이내에 처리됩니다. 영수증이 필요합니다."
    });
    const job = await post(host, `/api/profiles/${shared.id}/index`, {});
    await waitForJob(host, job.id);

    // Not published yet -> absent from the central list and export is refused.
    assert.equal((await get(host, "/api/central/profiles")).length, 0);

    await post(host, `/api/profiles/${shared.id}/publish`, { published: true });
    const central = await get(host, "/api/central/profiles");
    assert.equal(central.length, 1);
    assert.equal(central[0].name, "가이드");
    assert.equal(central[0].chunkCount > 0, true);

    // Local instance browses + imports the published agent from the host.
    const browsed = await post(local, "/api/central/browse", { remoteUrl: hostBase });
    assert.equal(browsed.profiles[0].id, shared.id);

    const imported = await post(local, "/api/central/import", { remoteUrl: hostBase, profileId: shared.id });
    assert.equal(imported.reembedded, false); // same local-ngram vector space
    assert.equal(imported.chunks > 0, true);

    const localProfiles = await get(local, "/api/profiles");
    assert.equal(localProfiles.length, 1);

    const search = await post(local, `/api/profiles/${imported.profile.id}/search`, { query: "환불은 언제 되나요?" });
    assert.equal(search.hits.length > 0, true);
    assert.equal(search.hits[0].title, "환불 정책");
  } finally {
    await host.close();
    await local.close();
  }
});

test("admin token gates mutations but leaves reads open", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-admin-"));
  process.env.ARK_ADMIN_TOKEN = "s3cret";
  try {
    const app = await createApp({ dataDir, logger: false, cleanupDataDir: true });
    try {
      const open = await app.inject({ method: "GET", url: "/api/profiles" });
      assert.equal(open.statusCode, 200);

      const blocked = await app.inject({
        method: "POST",
        url: "/api/profiles",
        payload: { name: "nope" },
        headers: { "content-type": "application/json" }
      });
      assert.equal(blocked.statusCode, 401);

      const allowed = await app.inject({
        method: "POST",
        url: "/api/profiles",
        payload: { name: "ok" },
        headers: { "content-type": "application/json", "x-ark-admin": "s3cret" }
      });
      assert.equal(allowed.statusCode, 201);
    } finally {
      await app.close();
    }
  } finally {
    delete process.env.ARK_ADMIN_TOKEN;
  }
});

test("rules: extract drafts, approve, lint, and inject violations into compliance chat", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-rules-"));
  const ruleJson = JSON.stringify([
    {
      section: "보이스앤톤",
      principle: "사용자는 '나'로 지칭한다.",
      terms: ["사용자"],
      prefer: ["나", "내"],
      pairs: [{ avoid: "사용자 폰 찾기", recommend: "내 폰 찾기" }],
      note: "사용자 시각에서 작성"
    }
  ]);
  let capturedContext = "";
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      complete: async () => ruleJson, // extraction returns the rule JSON
      generate: async ({ envelope }) => {
        capturedContext = envelope.contextText;
        return { answer: "⚠️ 위반", provider: {}, raw: {} };
      }
    }
  });
  try {
    const p = await post(app, "/api/profiles", { name: "가이드" });
    await post(app, `/api/profiles/${p.id}/sources/text`, { title: "보이스앤톤", text: "사용자는 '나'로 지칭한다. 추천: 내 폰 찾기 · 피해야 할 말: 사용자 폰 찾기" });
    const job = await post(app, `/api/profiles/${p.id}/index`, {});
    await waitForJob(app, job.id);

    // Extract → drafts (not yet used by lint).
    const extracted = await post(app, `/api/profiles/${p.id}/rules/extract`, {});
    assert.equal(extracted.created >= 1, true);
    const draft = extracted.rules[0];
    assert.equal(draft.status, "draft");
    assert.deepEqual(draft.terms, ["사용자"]);

    // Draft doesn't lint yet.
    const before = await post(app, `/api/profiles/${p.id}/lint`, { text: "사용자 폰 찾기" });
    assert.equal(before.violations.length, 0);

    // Approve → lint now flags the forbidden term with a suggestion.
    await app.inject({
      method: "PATCH",
      url: `/api/profiles/${p.id}/rules/${draft.id}`,
      payload: { status: "approved" },
      headers: { "content-type": "application/json" }
    });
    const after = await post(app, `/api/profiles/${p.id}/lint`, { text: "사용자 폰 찾기" });
    assert.equal(after.violations.length >= 1, true);
    assert.equal(after.violations[0].match, "사용자");
    assert.match(after.violations[0].suggest, /나|내/);

    // Compliance chat injects the deterministic violations into the LLM context.
    const chat = await post(app, `/api/profiles/${p.id}/chat`, { query: "사용자 폰 찾기", mode: "compliance" });
    assert.equal(chat.violations.length >= 1, true);
    assert.match(capturedContext, /규칙 기반 자동 감지/);
    assert.match(capturedContext, /금지 표현 '사용자'/);
  } finally {
    await app.close();
  }
});

test("feedback memory: a 👎 correction is recalled into a later similar chat", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-fb-"));
  process.env.RAG_FEEDBACK_MIN_SCORE = "0"; // recall regardless of n-gram similarity
  let capturedContext = "";
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      generate: async ({ envelope }) => {
        capturedContext = envelope.contextText;
        return { answer: "ok", provider: {}, raw: {} };
      }
    }
  });
  try {
    const p = await post(app, "/api/profiles", { name: "P" });
    await post(app, `/api/profiles/${p.id}/sources/text`, { title: "환불", text: "환불은 구매 후 7일 이내에 처리됩니다." });
    const job = await post(app, `/api/profiles/${p.id}/index`, {});
    await waitForJob(app, job.id);

    // Leave negative feedback with a correction.
    const fb = await post(app, `/api/profiles/${p.id}/feedback`, {
      rating: -1,
      query: "환불 며칠 이내에 되나요?",
      answer: "잘 모르겠습니다.",
      note: "정확한 기간을 답하지 않음",
      correction: "환불은 7일 이내입니다."
    });
    assert.equal(fb.rating, -1);
    assert.equal((await get(app, `/api/profiles/${p.id}/feedback`)).length, 1);

    // A later chat recalls it and injects the guidance into the LLM context.
    const chat = await post(app, `/api/profiles/${p.id}/chat`, { query: "환불 기간이 어떻게 되나요?" });
    assert.equal(chat.usedFeedback >= 1, true);
    assert.match(capturedContext, /피드백 학습 메모리/);
    assert.match(capturedContext, /환불은 7일 이내입니다/);
  } finally {
    delete process.env.RAG_FEEDBACK_MIN_SCORE;
    await app.close();
  }
});

async function get(app, url) {
  const response = await app.inject({ method: "GET", url });
  assert.equal(response.statusCode < 300, true, response.body);
  return response.json();
}

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
