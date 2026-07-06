import "./env/loadEnv.js";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./rag/db.js";
import { createRagService } from "./rag/ragService.js";
import { ModeStore } from "./rag/modeStore.js";
import { SettingsStore } from "./rag/settingsStore.js";
import { SkillService } from "./rag/skills.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

export async function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.RAG_DATA_DIR || join(projectRoot, "data");
  await mkdir(dataDir, { recursive: true });

  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL || "info"
    },
    bodyLimit: 25 * 1024 * 1024
  });

  // CORS so external origins (e.g. a Figma plugin) can call the API.
  const corsOrigin = process.env.CORS_ORIGIN || "*";
  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", corsOrigin);
    reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "content-type,authorization,x-ark-admin");
    if (request.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  // When ARK_ADMIN_TOKEN is set the server runs as a shared "central" host:
  // reads (browse/search/chat) stay open to everyone, but every mutation
  // requires the admin token. Left unset (a personal local instance), nothing
  // is gated and behaviour matches single-user mode.
  const adminToken = process.env.ARK_ADMIN_TOKEN || "";
  if (adminToken) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.method === "OPTIONS") return;
      if (isPublicRequest(request)) return;
      if (extractAdminToken(request) !== adminToken) {
        return reply.code(401).send({ error: "관리자 인증이 필요합니다.", adminRequired: true });
      }
    });
  }

  app.get("/api/auth", async () => ({ adminRequired: Boolean(adminToken) }));

  app.post("/api/auth/verify", async (request) => ({
    ok: Boolean(adminToken) && extractAdminToken(request) === adminToken
  }));

  await app.register(multipart, {
    limits: {
      fileSize: Number(process.env.RAG_MAX_FILE_BYTES || 100 * 1024 * 1024),
      files: Number(process.env.RAG_MAX_FILES || 200)
    }
  });

  const db = createDatabase(join(dataDir, "rag.sqlite"));
  const settingsStore = new SettingsStore(dataDir);
  const modeStore = new ModeStore(dataDir);
  const skills = new SkillService({ projectRoot, dataDir });
  const rag = createRagService({
    db,
    dataDir,
    projectRoot,
    logger: app.log,
    llmProvider: options.llmProvider,
    pythonCommand: options.pythonCommand,
    settingsStore,
    modeStore,
    reranker: options.reranker
  });

  app.decorate("rag", rag);

  app.get("/v1/health", async () => ({
    ok: true,
    server: "local-agent-profile-rag",
    dataDir,
    llmProvider: rag.llm.describe(),
    embedding: rag.embeddings.describe(),
    reranker: rag.reranker.describe()
  }));

  app.get("/api/modes", async () => modeStore.list());

  app.put("/api/modes", async (request) => modeStore.upsert(request.body || {}));

  app.delete("/api/modes/:key", async (request) => modeStore.remove(decodeURIComponent(request.params.key)));

  app.get("/api/skills", async () => skills.list());

  app.get("/api/skills/config", async () => skills.getConfig());

  app.put("/api/skills/config", async (request) => skills.setConfig({ repo: request.body?.repo ?? "" }));

  app.post("/api/skills/sync", async () => skills.sync());

  app.get("/api/skills/available", async () => skills.available());

  app.post("/api/skills/install", async (request, reply) => {
    const result = skills.install(request.body?.name);
    return reply.code(201).send(result);
  });

  app.delete("/api/skills/:name", async (request) => skills.remove(decodeURIComponent(request.params.name)));

  app.post("/api/skills/:name/run", async (request) =>
    skills.run(decodeURIComponent(request.params.name), request.body || {})
  );

  app.get("/api/settings", async () => settingsStore.state());

  // Probe the configured OpenAI-compatible servers WITHOUT saving, so a
  // designer can see "연결됨 ✓ / 키 오류 ✗" immediately after typing an API key.
  app.post("/api/settings/test", async (request) => {
    const body = request.body || {};
    const llmKey = body.llm?.apiKey || "";
    const embUrl = String(body.embedding?.url || "");
    return {
      llm: await probeOpenAiServer(body.llm?.baseUrl || "", llmKey),
      embedding: embUrl
        ? await probeOpenAiServer(embUrl.replace(/\/embeddings\/?$/, ""), body.embedding?.apiKey || llmKey)
        : { ok: true, detail: "로컬 임베딩 사용 (별도 서버 불필요)" }
    };
  });

  app.put("/api/settings", async (request) => {
    rag.applySettings(request.body || {});
    return settingsStore.state();
  });

  app.post("/api/settings/select", async (request) => {
    rag.selectPreset(request.body?.name);
    return settingsStore.state();
  });

  app.delete("/api/settings/:name", async (request) => {
    rag.deletePreset(decodeURIComponent(request.params.name));
    return settingsStore.state();
  });

  app.get("/api/profiles", async () => rag.listProfiles());

  app.post("/api/profiles", async (request, reply) => {
    const profile = await rag.createProfile(request.body || {});
    return reply.code(201).send(profile);
  });

  app.patch("/api/profiles/:profileId", async (request) => {
    return rag.updateProfile(request.params.profileId, request.body || {});
  });

  app.delete("/api/profiles/:profileId", async (request) => {
    return rag.deleteProfile(request.params.profileId);
  });

  // Publish / unpublish a profile into the shared central library.
  app.post("/api/profiles/:profileId/publish", async (request) => {
    return rag.setPublished(request.params.profileId, request.body?.published !== false);
  });

  app.get("/api/profiles/:profileId/sources", async (request) => {
    return rag.listSources(request.params.profileId);
  });

  // Indexed folder paths for drill-down scoping.
  app.get("/api/profiles/:profileId/folders", async (request) => {
    return rag.listFolders(request.params.profileId);
  });

  app.post("/api/profiles/:profileId/sources/text", async (request, reply) => {
    const source = await rag.addTextSource(request.params.profileId, request.body || {});
    return reply.code(201).send(source);
  });

  app.post("/api/profiles/:profileId/sources/files", async (request, reply) => {
    const sources = await rag.addFileSources(request.params.profileId, request.parts());
    return reply.code(201).send({ sources });
  });

  app.post("/api/profiles/:profileId/sources/path", async (request, reply) => {
    const sources = await rag.addPathSources(request.params.profileId, request.body?.path || "", {
      useTree: request.body?.useTree === true || request.body?.useTree === "1"
    });
    return reply.code(201).send({ sources });
  });

  app.post("/api/profiles/:profileId/sources/url", async (request, reply) => {
    const source = await rag.addUrlSource(request.params.profileId, request.body || {});
    return reply.code(201).send(source);
  });

  app.post("/api/profiles/:profileId/sources/copy", async (request, reply) => {
    const source = await rag.copySource(request.params.profileId, request.body || {});
    return reply.code(201).send(source);
  });

  app.delete("/api/profiles/:profileId/sources/:sourceId", async (request) => {
    return rag.deleteSource(request.params.profileId, request.params.sourceId);
  });

  // Readable content for the in-app document viewer (double-click in the tree).
  app.get("/api/profiles/:profileId/sources/:sourceId/content", async (request) => {
    return rag.getSourceContent(request.params.profileId, request.params.sourceId);
  });

  // Open a source's original content: stream the uploaded file, redirect to
  // the external URL, or return the pasted text.
  app.get("/api/profiles/:profileId/sources/:sourceId/raw", async (request, reply) => {
    const target = rag.getSourceFile(request.params.profileId, request.params.sourceId);
    if (target.kind === "url") return reply.redirect(target.url);
    if (target.kind === "text") {
      return reply.type("text/plain; charset=utf-8").send(target.text);
    }
    reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(target.fileName)}`);
    return reply.type(target.mimeType).send(createReadStream(target.filePath));
  });

  // Preprocessing agent: structure sources into reviewable Markdown before indexing.
  app.post("/api/profiles/:profileId/preprocess", async (request, reply) => {
    const job = await rag.startPreprocessJob(request.params.profileId, request.body || {});
    return reply.code(202).send(job);
  });

  app.patch("/api/profiles/:profileId/sources/:sourceId/normalized", async (request) => {
    return rag.updateNormalized(request.params.profileId, request.params.sourceId, request.body?.markdown ?? "");
  });

  app.post("/api/profiles/:profileId/index", async (request, reply) => {
    const job = await rag.startIndexJob(request.params.profileId, request.body || {});
    return reply.code(202).send(job);
  });

  app.get("/api/jobs/:jobId", async (request, reply) => {
    const job = rag.getJob(request.params.jobId);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return job;
  });

  app.post("/api/profiles/:profileId/search", async (request) => {
    return rag.search(request.params.profileId, request.body || {});
  });

  app.post("/api/profiles/:profileId/context", async (request) => {
    return rag.buildContext(request.params.profileId, request.body || {});
  });

  app.post("/api/profiles/:profileId/chat", async (request) => {
    return rag.chat(request.params.profileId, request.body || {});
  });

  // Structured writing rules (guideline compliance).
  app.get("/api/profiles/:profileId/rules", async (request) => {
    return rag.listRules(request.params.profileId, { status: request.query?.status });
  });

  app.post("/api/profiles/:profileId/rules", async (request, reply) => {
    const rule = rag.upsertRule(request.params.profileId, request.body || {});
    return reply.code(201).send(rule);
  });

  app.patch("/api/profiles/:profileId/rules/:ruleId", async (request) => {
    return rag.upsertRule(request.params.profileId, { ...(request.body || {}), id: request.params.ruleId });
  });

  app.delete("/api/profiles/:profileId/rules/:ruleId", async (request) => {
    return rag.deleteRule(request.params.profileId, request.params.ruleId);
  });

  app.post("/api/profiles/:profileId/rules/extract", async (request, reply) => {
    const result = await rag.extractRules(request.params.profileId, request.body || {});
    return reply.code(201).send(result);
  });

  app.post("/api/profiles/:profileId/lint", async (request) => {
    return rag.lint(request.params.profileId, request.body?.text || "");
  });

  // UX glossary (key-based term dictionary).
  app.get("/api/profiles/:profileId/glossary", async (request) => {
    return rag.listGlossary(request.params.profileId, {
      status: request.query?.status,
      reviewStatus: request.query?.reviewStatus
    });
  });

  app.post("/api/profiles/:profileId/glossary", async (request, reply) => {
    const term = rag.upsertGlossaryTerm(request.params.profileId, request.body || {});
    return reply.code(201).send(term);
  });

  app.patch("/api/profiles/:profileId/glossary/:termId", async (request) => {
    return rag.upsertGlossaryTerm(request.params.profileId, { ...(request.body || {}), id: request.params.termId });
  });

  app.delete("/api/profiles/:profileId/glossary/:termId", async (request) => {
    return rag.deleteGlossaryTerm(request.params.profileId, request.params.termId);
  });

  app.post("/api/profiles/:profileId/glossary/extract", async (request, reply) => {
    const result = await rag.extractGlossary(request.params.profileId, request.body || {});
    return reply.code(201).send(result);
  });

  // Deterministic word check: glossary hits + words missing from the glossary.
  app.post("/api/profiles/:profileId/glossary/check", async (request) => {
    return rag.checkGlossary(request.params.profileId, request.body?.text || "");
  });

  // Integrated review: glossary + rules + style-guide RAG in one corrected answer.
  app.post("/api/profiles/:profileId/review", async (request) => {
    return rag.review(request.params.profileId, request.body || {});
  });

  // Semantic concepts (의미·맥락 레이어): canonical meaning + variant surface
  // forms, linked to source chunks and used to interpret queries.
  app.get("/api/profiles/:profileId/concepts", async (request) => {
    return rag.listConcepts(request.params.profileId, { reviewStatus: request.query?.reviewStatus });
  });

  app.post("/api/profiles/:profileId/concepts", async (request, reply) => {
    const concept = rag.upsertConcept(request.params.profileId, request.body || {});
    return reply.code(201).send(concept);
  });

  app.patch("/api/profiles/:profileId/concepts/:conceptId", async (request) => {
    return rag.upsertConcept(request.params.profileId, { ...(request.body || {}), id: request.params.conceptId });
  });

  app.delete("/api/profiles/:profileId/concepts/:conceptId", async (request) => {
    return rag.deleteConcept(request.params.profileId, request.params.conceptId);
  });

  app.post("/api/profiles/:profileId/concepts/extract", async (request, reply) => {
    const result = await rag.extractConcepts(request.params.profileId, request.body || {});
    return reply.code(201).send(result);
  });

  app.post("/api/profiles/:profileId/concepts/retag", async (request) => {
    return rag.retagConcepts(request.params.profileId);
  });

  // Consolidated cards: one clean cross-source write-up per confirmed concept.
  app.post("/api/profiles/:profileId/concepts/:conceptId/card", async (request, reply) => {
    const concept = await rag.generateConceptCard(request.params.profileId, request.params.conceptId);
    return reply.code(201).send(concept);
  });

  app.post("/api/profiles/:profileId/concepts/cards", async (request, reply) => {
    const job = await rag.startCardJob(request.params.profileId, request.body || {});
    return reply.code(202).send(job);
  });

  // Answer feedback (self-improving memory).
  app.get("/api/profiles/:profileId/feedback", async (request) => {
    return rag.listFeedback(request.params.profileId);
  });

  app.post("/api/profiles/:profileId/feedback", async (request, reply) => {
    const fb = await rag.addFeedback(request.params.profileId, request.body || {});
    return reply.code(201).send(fb);
  });

  app.delete("/api/profiles/:profileId/feedback/:feedbackId", async (request) => {
    return rag.deleteFeedback(request.params.profileId, request.params.feedbackId);
  });

  // Stable surface for external tools (Figma plugin): validate text against a
  // profile's guidelines. Defaults to compliance (규율) mode.
  app.post("/api/validate", async (request, reply) => {
    const body = request.body || {};
    if (!body.profileId) return reply.code(400).send({ error: "profileId is required" });
    return rag.chat(body.profileId, {
      query: String(body.text || ""),
      mode: body.mode || "compliance",
      topK: body.topK
    });
  });

  // Extract text from an image (screenshot crop) via the configured vision LLM.
  app.post("/api/vision/extract", async (request) => {
    const text = await rag.visionExtract(request.body?.image || "");
    return { text };
  });

  // --- Central library (shared RAG) ---------------------------------------
  // Read-only surface a remote host exposes to viewers, plus the browse/import
  // helpers a local instance uses to pull agents from a remote host.
  app.get("/api/central/profiles", async () => rag.listCentral());

  app.get("/api/central/profiles/:profileId/export", async (request) => {
    return rag.exportProfile(request.params.profileId);
  });

  app.post("/api/central/browse", async (request) => {
    return rag.browseRemote(request.body?.remoteUrl || "");
  });

  app.post("/api/central/import", async (request, reply) => {
    const result = await rag.importFromRemote(request.body || {});
    return reply.code(201).send(result);
  });

  const clientDir = join(projectRoot, "dist", "client");
  if (existsSync(clientDir)) {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: "/"
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not found" });
    });
  }

  app.addHook("onClose", async () => {
    db.close();
    if (options.cleanupDataDir) await rm(dataDir, { recursive: true, force: true });
  });

  return app;
}

// Reads that anyone may perform against a shared host without the admin token.
// Everything else under /api is treated as a mutation and gated.
function isPublicRequest(request) {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const path = (request.url || "").split("?")[0];
  if (!path.startsWith("/api/")) return true;
  if (path === "/api/auth/verify") return true;
  if (path === "/api/validate" || path === "/api/vision/extract") return true;
  if (path === "/api/central/browse") return true;
  // Viewers on a shared host may search/chat/lint/review and leave feedback.
  return (
    path.endsWith("/search") ||
    path.endsWith("/context") ||
    path.endsWith("/chat") ||
    path.endsWith("/lint") ||
    path.endsWith("/glossary/check") ||
    path.endsWith("/review") ||
    path.endsWith("/feedback")
  );
}

// GET {baseUrl}/models — the cheapest call every OpenAI-compatible server
// (LM Studio, vLLM, OpenAI, …) supports, and it validates the API key too.
async function probeOpenAiServer(baseUrl, apiKey) {
  const url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) return { ok: false, detail: "서버 URL이 설정되지 않았습니다." };
  try {
    const response = await fetch(`${url}/models`, {
      headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(Number(process.env.RAG_URL_TIMEOUT_MS || 8000))
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: "인증 실패 — API Key를 확인하세요." };
    }
    if (!response.ok) return { ok: false, detail: `서버 응답 오류 (HTTP ${response.status})` };
    const payload = await response.json().catch(() => ({}));
    const count = Array.isArray(payload?.data) ? payload.data.length : null;
    return { ok: true, detail: count != null ? `연결됨 · 모델 ${count}개` : "연결됨" };
  } catch (error) {
    return { ok: false, detail: `서버에 연결할 수 없습니다: ${error.message}` };
  }
}

function extractAdminToken(request) {
  const header = request.headers["x-ark-admin"];
  if (header) return String(header);
  const auth = request.headers["authorization"] || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1] : "";
}
