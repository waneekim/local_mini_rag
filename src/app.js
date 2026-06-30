import "./env/loadEnv.js";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./rag/db.js";
import { createRagService } from "./rag/ragService.js";
import { CHAT_MODES } from "./rag/llmProvider.js";
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

  await app.register(multipart, {
    limits: {
      fileSize: Number(process.env.RAG_MAX_FILE_BYTES || 100 * 1024 * 1024),
      files: Number(process.env.RAG_MAX_FILES || 200)
    }
  });

  const db = createDatabase(join(dataDir, "rag.sqlite"));
  const settingsStore = new SettingsStore(dataDir);
  const skills = new SkillService({ projectRoot, dataDir });
  const rag = createRagService({
    db,
    dataDir,
    projectRoot,
    logger: app.log,
    llmProvider: options.llmProvider,
    pythonCommand: options.pythonCommand,
    settingsStore
  });

  app.decorate("rag", rag);

  app.get("/v1/health", async () => ({
    ok: true,
    server: "local-agent-profile-rag",
    dataDir,
    llmProvider: rag.llm.describe(),
    embedding: rag.embeddings.describe()
  }));

  app.get("/api/modes", async () =>
    Object.entries(CHAT_MODES).map(([key, mode]) => ({
      key,
      label: mode.label,
      aliases: mode.aliases,
      hint: mode.hint
    }))
  );

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

  app.get("/api/profiles/:profileId/sources", async (request) => {
    return rag.listSources(request.params.profileId);
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
    const sources = await rag.addPathSources(request.params.profileId, request.body?.path || "");
    return reply.code(201).send({ sources });
  });

  app.post("/api/profiles/:profileId/sources/url", async (request, reply) => {
    const source = await rag.addUrlSource(request.params.profileId, request.body || {});
    return reply.code(201).send(source);
  });

  app.delete("/api/profiles/:profileId/sources/:sourceId", async (request) => {
    return rag.deleteSource(request.params.profileId, request.params.sourceId);
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
