import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { EmbeddingService, localNgramEmbedding } from "../src/rag/embedding.js";
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
