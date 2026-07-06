import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { chunkDocuments } from "../src/rag/chunking.js";
import { EmbeddingService, localNgramEmbedding } from "../src/rag/embedding.js";
import { LlmProvider, parseJsonObject } from "../src/rag/llmProvider.js";
import { RerankService } from "../src/rag/rerank.js";
import { buildTreeMarkdown, htmlToText } from "../src/rag/ragService.js";
import { checkText, normalizeTermKey, scanTerms, buildTermIndex, stripJosa } from "../src/rag/glossary.js";
import { buildConceptBlock, expandQuery, matchConcepts } from "../src/rag/concepts.js";
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

test("generate sends pasted images as image_url parts and picks the vision model", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ choices: [{ message: { content: "보입니다" } }] }) };
  };
  try {
    const provider = new LlmProvider({ baseUrl: "http://llm.local/v1", model: "text-model", visionModel: "vl-model" });
    const img = "data:image/png;base64,AAAA";
    const result = await provider.generate({ query: "이거 뭐야?", envelope: { contextText: "", citations: [] }, images: [img] });
    assert.equal(result.answer, "보입니다");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, "vl-model"); // vision model used when images present
    const content = body.messages[1].content;
    assert.equal(Array.isArray(content), true);
    assert.equal(content.some((p) => p.type === "image_url" && p.image_url.url === img), true);
    assert.equal(content.some((p) => p.type === "text"), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("chat accepts an image-only message and forwards the images to the model", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-img-"));
  let seen = null;
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      generate: async ({ query, images }) => {
        seen = { query, images };
        return { answer: "ok", provider: {}, raw: {} };
      }
    }
  });
  try {
    const p = await post(app, "/api/profiles", { name: "P" });
    const img = "data:image/png;base64,AAAA";
    const res = await post(app, `/api/profiles/${p.id}/chat`, { images: [img] }); // no text query
    assert.equal(res.answer, "ok");
    assert.deepEqual(seen.images, [img]);
    assert.equal(seen.query, "");
  } finally {
    await app.close();
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

test("tei-style reranker posts query+texts and normalizes a top-level array", async () => {
  const calls = [];
  const service = new RerankService({
    url: "http://tei.local/rerank",
    style: "tei",
    fetchFn: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      // TEI returns a bare array, not {results:[…]}.
      return { ok: true, json: async () => [{ index: 1, score: 0.87 }, { index: 0, score: 0.12 }] };
    }
  });
  const out = await service.rerank("환불 며칠?", ["점심 메뉴", "환불은 7일 이내"]);
  assert.deepEqual(calls[0].body, { query: "환불 며칠?", texts: ["점심 메뉴", "환불은 7일 이내"] });
  const byIndex = Object.fromEntries(out.map((r) => [r.index, r.score]));
  assert.equal(byIndex[1], 0.87);
  assert.equal(byIndex[0], 0.12);
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

test("markdown chunking splits on headings and keeps tables whole", () => {
  const md = [
    "# 보이스앤톤",
    "",
    "사용자는 '나'로 지칭한다.",
    "",
    "## 표현 대조표",
    "",
    "| 추천 | 피해야 할 말 |",
    "| --- | --- |",
    "| 내 폰 찾기 | 사용자 폰 찾기 |",
    "| 내 모습 등록 | 사용자 모습 등록 |"
  ].join("\n");

  const chunks = chunkDocuments([{ text: md, metadata: { format: "markdown" }, locator: {} }]);
  assert.equal(chunks.length >= 2, true);

  // The intro sits under the top heading.
  const intro = chunks.find((c) => c.text.includes("사용자는 '나'로 지칭한다."));
  assert.equal(intro.locator.heading, "보이스앤톤");

  // The table is never split mid-row: both data rows land in one chunk, tagged
  // with the full heading path.
  const table = chunks.find((c) => c.text.includes("| 추천"));
  assert.match(table.text, /내 폰 찾기/);
  assert.match(table.text, /내 모습 등록/);
  assert.equal(table.locator.heading, "보이스앤톤 > 표현 대조표");
});

test("preprocess agent: structure a source, review-edit it, then index the Markdown", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-pre-"));
  const generated =
    "# 보이스앤톤\n\n사용자는 '나'로 지칭한다.\n\n| 추천 | 피해야 할 말 |\n| --- | --- |\n| 내 폰 찾기 | 사용자 폰 찾기 |";
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      complete: async () => generated, // structuring agent returns clean Markdown
      generate: async ({ envelope }) => ({ answer: `ok ${envelope.citations.length}`, provider: {}, raw: {} })
    }
  });

  try {
    const p = await post(app, "/api/profiles", { name: "가이드" });
    await post(app, `/api/profiles/${p.id}/sources/text`, {
      title: "보이스앤톤",
      text: "사용자는 나로 지칭. 추천 내 폰 찾기 / 피해야 할 말 사용자 폰 찾기"
    });

    // Preprocess (not indexed yet): the reviewed Markdown lands on the source.
    const pjob = await post(app, `/api/profiles/${p.id}/preprocess`, {});
    await waitForJob(app, pjob.id);
    let sources = await get(app, `/api/profiles/${p.id}/sources`);
    assert.equal(sources[0].normalized_md, generated);
    assert.equal(sources[0].status, "review");
    assert.equal(sources[0].preprocessed_at.length > 0, true);

    // Human edit adds a row; the edit is what gets indexed.
    const edited = `${generated}\n| 내 모습 등록 | 사용자 모습 등록 |`;
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/profiles/${p.id}/sources/${sources[0].id}/normalized`,
      payload: { markdown: edited },
      headers: { "content-type": "application/json" }
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().normalized_md, edited);

    // Index uses the Markdown (not the raw pasted text) and chunks it structurally.
    const ijob = await post(app, `/api/profiles/${p.id}/index`, {});
    await waitForJob(app, ijob.id);
    sources = await get(app, `/api/profiles/${p.id}/sources`);
    assert.equal(sources[0].status, "indexed");
    assert.equal(sources[0].chunkCount > 0, true);

    const search = await post(app, `/api/profiles/${p.id}/search`, { query: "내 폰 찾기" });
    assert.equal(search.hits.length > 0, true);
    // The retrieved chunk carries its section heading from the Markdown structure.
    assert.equal(search.hits.some((h) => (h.locator?.heading || "").includes("보이스앤톤")), true);
    // The edited row survived into the indexed table chunk.
    assert.equal(search.hits.some((h) => h.text.includes("내 모습 등록")), true);
  } finally {
    await app.close();
  }
});

test("preprocess auto-approve structures and indexes in one pass (no review stop)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-auto-"));
  const generated = "# 환불 정책\n\n환불은 구매 후 7일 이내에 처리됩니다.";
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      complete: async () => generated,
      generate: async ({ envelope }) => ({ answer: `ok ${envelope.citations.length}`, provider: {}, raw: {} })
    }
  });

  try {
    const p = await post(app, "/api/profiles", { name: "P" });
    await post(app, `/api/profiles/${p.id}/sources/text`, { title: "환불", text: "환불 7일 이내" });

    // autoIndex=true: no separate index job, the source is indexed straight away.
    const job = await post(app, `/api/profiles/${p.id}/preprocess`, { autoIndex: true });
    await waitForJob(app, job.id);

    const sources = await get(app, `/api/profiles/${p.id}/sources`);
    assert.equal(sources[0].status, "indexed");
    assert.equal(sources[0].normalized_md, generated);
    assert.equal(sources[0].chunkCount > 0, true);

    const search = await post(app, `/api/profiles/${p.id}/search`, { query: "환불은 언제 되나요?" });
    assert.equal(search.hits.length > 0, true);
  } finally {
    await app.close();
  }
});

test("source raw endpoint returns the original pasted text", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-raw-"));
  const app = await createApp({ dataDir, logger: false, cleanupDataDir: true });
  try {
    const p = await post(app, "/api/profiles", { name: "P" });
    const src = await post(app, `/api/profiles/${p.id}/sources/text`, { title: "메모", text: "원본 텍스트 내용" });
    const res = await app.inject({ method: "GET", url: `/api/profiles/${p.id}/sources/${src.id}/raw` });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /text\/plain/);
    assert.equal(res.body, "원본 텍스트 내용");

    const missing = await app.inject({ method: "GET", url: `/api/profiles/${p.id}/sources/nope/raw` });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("buildTreeMarkdown renders a sorted, dir-first tree", () => {
  const md = buildTreeMarkdown("root", ["root/contracts/2024/vendor.md", "root/readme.md", "root/contracts/nda.md"]);
  assert.match(md, /# 폴더 구조: root/);
  // directories sort before files at each level
  assert.match(md, /- contracts\/[\s\S]*- readme\.md/);
  assert.match(md, /- vendor\.md/);
});

test("folder tree: useTree adds a queryable structure source, off by default", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-tree-"));
  const srcDir = await mkdtemp(join(tmpdir(), "tree-src-"));
  await mkdir(join(srcDir, "contracts", "2024"), { recursive: true });
  await writeFile(join(srcDir, "contracts", "2024", "vendor.md"), "벤더 계약은 2024년에 체결되었습니다.");
  await writeFile(join(srcDir, "readme.md"), "이 폴더는 계약 문서를 담습니다.");

  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: { describe: () => ({ provider: "test", model: "mock" }), generate: async () => ({ answer: "ok", provider: {}, raw: {} }) }
  });
  try {
    const p = await post(app, "/api/profiles", { name: "P" });

    // Off: no folder-tree source.
    const plain = await post(app, `/api/profiles/${p.id}/sources/path`, { path: srcDir });
    assert.equal(plain.sources.some((s) => s.kind === "folder-tree"), false);

    // On: a structure source is created and carries the tree.
    const withTree = await post(app, `/api/profiles/${p.id}/sources/path`, { path: srcDir, useTree: true });
    const tree = withTree.sources.find((s) => s.kind === "folder-tree");
    assert.ok(tree, "expected a folder-tree source");
    assert.match(tree.pasted_text, /contracts\//);
    assert.match(tree.pasted_text, /vendor\.md/);

    // It indexes and the structure becomes queryable.
    const job = await post(app, `/api/profiles/${p.id}/index`, { sourceIds: [tree.id] });
    await waitForJob(app, job.id);
    const search = await post(app, `/api/profiles/${p.id}/search`, { query: "폴더 구조 contracts" });
    assert.equal(search.hits.some((h) => h.sourceKind === "folder-tree"), true);
  } finally {
    await app.close();
  }
});

test("folder scoping: drill-down restricts retrieval and breadcrumbs the hit", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-scope-"));
  const srcDir = await mkdtemp(join(tmpdir(), "scope-src-"));
  await mkdir(join(srcDir, "contracts", "2024"), { recursive: true });
  await mkdir(join(srcDir, "contracts", "2023"), { recursive: true });
  await writeFile(join(srcDir, "contracts", "2024", "vendor.md"), "2024년 벤더 계약 해지 조건은 30일 전 통보입니다.");
  await writeFile(join(srcDir, "contracts", "2023", "vendor.md"), "2023년 벤더 계약 해지 조건은 60일 전 통보입니다.");

  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: { describe: () => ({ provider: "test", model: "mock" }), generate: async () => ({ answer: "ok", provider: {}, raw: {} }) }
  });
  try {
    const p = await post(app, "/api/profiles", { name: "P" });
    await post(app, `/api/profiles/${p.id}/sources/path`, { path: srcDir });
    const job = await post(app, `/api/profiles/${p.id}/index`, {});
    await waitForJob(app, job.id);

    // Folders are enumerable for the drill-down UI.
    const folders = await get(app, `/api/profiles/${p.id}/folders`);
    const rootName = srcDir.split("/").pop();
    assert.equal(folders.some((f) => f.path === `${rootName}/contracts/2024`), true);

    // Unscoped: both years are candidates.
    const wide = await post(app, `/api/profiles/${p.id}/search`, { query: "벤더 계약 해지 조건" });
    assert.equal(wide.hits.some((h) => h.folderPath.endsWith("2023")), true);
    assert.equal(wide.hits.some((h) => h.folderPath.endsWith("2024")), true);

    // Scoped via the folder: token: only the 2024 subtree survives, and the hit
    // carries a breadcrumb through folder > document > (section).
    const scoped = await post(app, `/api/profiles/${p.id}/search`, { query: `folder:${rootName}/contracts/2024 해지 조건` });
    assert.equal(scoped.scope, `${rootName}/contracts/2024`);
    assert.equal(scoped.hits.length > 0, true);
    assert.equal(scoped.hits.every((h) => h.folderPath === `${rootName}/contracts/2024`), true);
    assert.match(scoped.hits[0].breadcrumb, /contracts > 2024 > vendor\.md/);
  } finally {
    await app.close();
  }
});

test("glossary engine: longest-match scan, alias resolution, josa stripping, missing words", () => {
  const terms = [
    { id: "t1", term: "에어컨", status: "approved", aliases: ["에어콘"], definition: "표준 제품명" },
    { id: "t2", term: "설정", status: "approved", aliases: ["셋팅", "세팅"], preferred: "" },
    { id: "t3", term: "냉장고", status: "approved" },
    { id: "t4", term: "연동", status: "deprecated", preferred: "연결" },
    { id: "t5", term: "자동 모드", status: "approved" }
  ];

  assert.equal(normalizeTermKey(" Smart Things "), "smartthings");
  assert.equal(stripJosa("냉장고를"), "냉장고");
  assert.equal(stripJosa("에어컨에서는"), "에어컨");

  // Longest match wins: "자동 모드" beats a hypothetical shorter key.
  const built = buildTermIndex(terms);
  const hits = scanTerms("에어콘 자동 모드를 셋팅하시겠습니까?", built);
  const surfaces = hits.map((h) => `${h.surface}→${h.entry.term}`);
  assert.equal(surfaces.includes("에어콘→에어컨"), true); // alias → canonical
  assert.equal(surfaces.includes("셋팅→설정"), true); // matched inside a longer token
  assert.equal(surfaces.some((s) => s.startsWith("자동 모드")), true);

  // checkText: verdicts + provable absence.
  const out = checkText("유저가 냉장고를 연동해 주세요", terms);
  const byTerm = Object.fromEntries(out.terms.map((t) => [t.term, t]));
  assert.equal(byTerm["냉장고"].status, "approved"); // josa-stripped stem resolved
  assert.equal(byTerm["연동"].status, "deprecated");
  assert.equal(byTerm["연동"].preferred, "연결");
  assert.equal(out.missing.some((m) => m.base === "유저"), true); // not in glossary
  assert.equal(out.missing.some((m) => m.base === "냉장고"), false);
});

test("glossary API: upsert/check, drafts excluded until confirmed, dedupe by key", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-gl-"));
  const app = await createApp({ dataDir, logger: false, cleanupDataDir: true });
  try {
    const p = await post(app, "/api/profiles", { name: "용어집" });

    await post(app, `/api/profiles/${p.id}/glossary`, { term: "에어컨", status: "approved", aliases: ["에어콘"] });
    const dep = await post(app, `/api/profiles/${p.id}/glossary`, { term: "연동", status: "deprecated", preferred: "연결" });
    // Draft term is invisible to the checker until confirmed.
    const draft = await post(app, `/api/profiles/${p.id}/glossary`, { term: "셋팅", status: "forbidden", preferred: "설정", reviewStatus: "draft" });

    let check = await post(app, `/api/profiles/${p.id}/glossary/check`, { text: "에어콘 연동 셋팅" });
    assert.equal(check.terms.some((t) => t.term === "에어컨"), true);
    assert.equal(check.terms.find((t) => t.term === "연동").preferred, "연결");
    assert.equal(check.terms.some((t) => t.term === "셋팅"), false); // draft hidden
    assert.equal(check.missing.some((m) => m.base === "셋팅"), true);

    // Confirm the draft → now it participates with its verdict.
    await app.inject({
      method: "PATCH",
      url: `/api/profiles/${p.id}/glossary/${draft.id}`,
      payload: { reviewStatus: "confirmed" },
      headers: { "content-type": "application/json" }
    });
    check = await post(app, `/api/profiles/${p.id}/glossary/check`, { text: "셋팅을 확인" });
    assert.equal(check.terms.find((t) => t.term === "셋팅").status, "forbidden");

    // Same normalized key collapses onto one row instead of duplicating.
    const dup = await post(app, `/api/profiles/${p.id}/glossary`, { term: "연동", definition: "기술 문서 한정" });
    assert.equal(dup.id, dep.id);
    assert.equal(dup.preferred, "연결"); // merge kept the earlier fields
    assert.equal((await get(app, `/api/profiles/${p.id}/glossary`)).length, 3);
  } finally {
    await app.close();
  }
});

test("integrated review: glossary + rules + style RAG injected into one corrected pass", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-rev-"));
  let capturedContext = "";
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      complete: async () => "[]",
      generate: async ({ envelope }) => {
        capturedContext = envelope.contextText;
        return { answer: "교정문: 내 냉장고를 연결하세요", provider: {}, raw: {} };
      }
    }
  });
  try {
    const p = await post(app, "/api/profiles", { name: "검수" });
    // Style guide source for RAG grounding.
    await post(app, `/api/profiles/${p.id}/sources/text`, { title: "보이스앤톤", text: "사용자는 '나'로 지칭한다." });
    const job = await post(app, `/api/profiles/${p.id}/index`, {});
    await waitForJob(app, job.id);
    // A rule (approved) and glossary terms.
    await post(app, `/api/profiles/${p.id}/rules`, { principle: "사용자는 '나'로 지칭", terms: ["사용자"], prefer: ["나", "내"], status: "approved" });
    await post(app, `/api/profiles/${p.id}/glossary`, { term: "연동", status: "deprecated", preferred: "연결" });
    await post(app, `/api/profiles/${p.id}/glossary`, { term: "냉장고", status: "approved" });

    const review = await post(app, `/api/profiles/${p.id}/review`, { text: "사용자의 냉장고를 연동해 주세요" });

    // Deterministic layers surfaced in the response…
    assert.equal(review.violations.some((v) => v.match === "사용자"), true);
    assert.equal(review.terms.find((t) => t.term === "연동").preferred, "연결");
    assert.equal(review.answer.includes("교정문"), true);
    // …and injected into the LLM context alongside the style guide.
    assert.match(capturedContext, /용어집 검수/);
    assert.match(capturedContext, /비권장어 '연동' → 권장: 연결/);
    assert.match(capturedContext, /규칙 기반 자동 감지/);
    assert.match(capturedContext, /사용자는 '나'로 지칭한다/); // RAG hit
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

test("concept layer: query interpretation, expansion, and the LLM block", () => {
  const concepts = [
    { id: "c1", name: "동작 대기", aliases: ["대기 중", "스탠바이"], definition: "켜져 있지만 동작하지 않는 상태" }
  ];
  const matched = matchConcepts("대기 중일 때 전력 소모가 궁금해", concepts);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].concept.name, "동작 대기");
  assert.deepEqual(matched[0].surfaces, ["대기 중"]);

  const expanded = expandQuery("대기 중 전력", matched);
  assert.match(expanded, /동작 대기/);
  assert.match(expanded, /스탠바이/); // variants ride along for retrieval

  const block = buildConceptBlock(matched);
  assert.match(block, /의미 해석/);
  assert.match(block, /'대기 중' = 개념 '동작 대기'/);
  assert.match(block, /스탠바이/);
});

test("concept layer bridges variant phrasing from query to source chunks", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-con-"));
  let capturedContext = "";
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      complete: async () => "[]",
      generate: async ({ envelope }) => {
        capturedContext = envelope.contextText;
        return { answer: "ok", provider: {}, raw: {} };
      }
    }
  });
  try {
    const p = await post(app, "/api/profiles", { name: "P" });
    // The source only says "스탠바이" — never the query's words "대기 중".
    await post(app, `/api/profiles/${p.id}/sources/text`, { title: "전력 가이드", text: "스탠바이에서는 소비 전력이 크게 감소합니다." });
    await post(app, `/api/profiles/${p.id}/sources/text`, { title: "배송", text: "배송은 보통 2~3일 걸립니다." });
    const job = await post(app, `/api/profiles/${p.id}/index`, {});
    await waitForJob(app, job.id);

    // Draft concept: not used yet.
    const draft = await post(app, `/api/profiles/${p.id}/concepts`, {
      name: "동작 대기", aliases: ["대기 중", "스탠바이"], definition: "켜져 있지만 동작하지 않는 상태", reviewStatus: "draft"
    });
    let search = await post(app, `/api/profiles/${p.id}/search`, { query: "대기 중 전력 소모" });
    assert.equal(search.concepts.length, 0);

    // Confirm → retag links the 스탠바이 chunk → interpretation + boost kick in.
    await app.inject({
      method: "PATCH",
      url: `/api/profiles/${p.id}/concepts/${draft.id}`,
      payload: { reviewStatus: "confirmed" },
      headers: { "content-type": "application/json" }
    });
    search = await post(app, `/api/profiles/${p.id}/search`, { query: "대기 중 전력 소모" });
    assert.equal(search.concepts[0].name, "동작 대기");
    assert.deepEqual(search.concepts[0].surfaces, ["대기 중"]);
    assert.equal(search.hits[0].title, "전력 가이드");
    assert.equal(search.hits[0].conceptScore > 0, true); // linked-chunk boost applied

    // Chat injects the interpretation so the LLM answers by meaning.
    const chat = await post(app, `/api/profiles/${p.id}/chat`, { query: "대기 중 전력 소모 알려줘" });
    assert.equal(chat.concepts[0].name, "동작 대기");
    assert.match(capturedContext, /의미 해석/);
    assert.match(capturedContext, /동작 대기/);
  } finally {
    await app.close();
  }
});

test("concept cards: consolidated cross-source write-up, indexed and re-generable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-card-"));
  const cardMd = "# 동작 대기\n## 정의\n켜져 있지만 동작하지 않는 상태 [1]\n## ⚠️ 소스 간 불일치\n[1]은 50% 감소, [2]는 30% 감소로 기술";
  const app = await createApp({
    dataDir,
    logger: false,
    cleanupDataDir: true,
    llmProvider: {
      describe: () => ({ provider: "test", model: "mock" }),
      complete: async () => cardMd, // card synthesis
      generate: async () => ({ answer: "ok", provider: {}, raw: {} })
    }
  });
  try {
    const p = await post(app, "/api/profiles", { name: "P" });
    // Two sources describing the same thing with different wording/numbers.
    await post(app, `/api/profiles/${p.id}/sources/text`, { title: "사양서A", text: "스탠바이에서는 소비 전력이 50% 감소합니다." });
    await post(app, `/api/profiles/${p.id}/sources/text`, { title: "사양서B", text: "대기 중에는 전력 소모가 30% 줄어듭니다." });
    const job = await post(app, `/api/profiles/${p.id}/index`, {});
    await waitForJob(app, job.id);

    const concept = await post(app, `/api/profiles/${p.id}/concepts`, {
      name: "동작 대기", aliases: ["대기 중", "스탠바이"], definition: "켜져 있지만 동작하지 않는 상태"
    });

    // Generate the card: stored on the concept AND indexed under the system source.
    const withCard = await post(app, `/api/profiles/${p.id}/concepts/${concept.id}/card`, {});
    assert.equal(withCard.cardMd, cardMd);
    assert.equal(withCard.cardChunkId.length > 0, true);

    let sources = await get(app, `/api/profiles/${p.id}/sources`);
    const cardSource = sources.find((s) => s.kind === "concept-cards");
    assert.ok(cardSource, "expected the 🧠 card source");
    assert.equal(cardSource.chunkCount, 1);

    // The card is retrievable and rides the concept boost.
    const search = await post(app, `/api/profiles/${p.id}/search`, { query: "대기 중 전력" });
    const cardHit = search.hits.find((h) => h.sourceKind === "concept-cards");
    assert.ok(cardHit, "card chunk should be retrieved");
    assert.match(cardHit.text, /소스 간 불일치/);
    assert.equal(cardHit.conceptScore > 0, true);

    // Regeneration replaces the old card chunk instead of accumulating.
    await post(app, `/api/profiles/${p.id}/concepts/${concept.id}/card`, {});
    sources = await get(app, `/api/profiles/${p.id}/sources`);
    assert.equal(sources.find((s) => s.kind === "concept-cards").chunkCount, 1);

    // Bulk job covers all confirmed concepts.
    const cardsJob = await post(app, `/api/profiles/${p.id}/concepts/cards`, {});
    const done = await waitForJob(app, cardsJob.id);
    assert.equal(done.processed_sources, 1);
    assert.equal(done.failed_sources, 0);

    // Deleting the concept removes its card chunk too.
    await app.inject({ method: "DELETE", url: `/api/profiles/${p.id}/concepts/${concept.id}` });
    sources = await get(app, `/api/profiles/${p.id}/sources`);
    assert.equal(sources.find((s) => s.kind === "concept-cards").chunkCount, 0);
  } finally {
    await app.close();
  }
});

test("settings test endpoint reports per-server connection status", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rag-conn-"));
  process.env.RAG_URL_TIMEOUT_MS = "400"; // fail fast on the unreachable probe
  const app = await createApp({ dataDir, logger: false, cleanupDataDir: true });
  try {
    // No LLM URL yet + no embedding server → clear guidance, local embeddings OK.
    let res = await post(app, "/api/settings/test", { llm: { baseUrl: "" }, embedding: {} });
    assert.equal(res.llm.ok, false);
    assert.match(res.llm.detail, /URL/);
    assert.equal(res.embedding.ok, true);

    // Unreachable server → ok:false with a readable message (never a throw).
    res = await post(app, "/api/settings/test", {
      llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
      embedding: { url: "http://127.0.0.1:1/v1/embeddings" }
    });
    assert.equal(res.llm.ok, false);
    assert.equal(res.embedding.ok, false);
  } finally {
    delete process.env.RAG_URL_TIMEOUT_MS;
    await app.close();
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
