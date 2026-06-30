import { createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { all, one, run } from "./db.js";
import { EmbeddingService } from "./embedding.js";
import { hashFile, hashText } from "./hash.js";
import { id, nowIso } from "./ids.js";
import { CHAT_MODES, LlmProvider } from "./llmProvider.js";
import { basenameFromRelative, normalizeUploadedFileName, sanitizeFileName } from "./sanitize.js";
import { chunkDocuments } from "./chunking.js";
import { cosineSimilarity, lexicalScore } from "./vectorMath.js";
import { WorkerClient } from "./workerClient.js";

const DEFAULT_TOP_K = 8;

export function createRagService(options) {
  return new RagService(options);
}

class RagService {
  constructor({ db, dataDir, projectRoot, logger, llmProvider, pythonCommand, settingsStore, modeStore }) {
    this.db = db;
    this.dataDir = dataDir;
    this.logger = logger;
    this._projectRoot = projectRoot;
    this._pythonCommand = pythonCommand;
    this.settingsStore = settingsStore;
    this.modeStore = modeStore;
    this.worker = new WorkerClient({ projectRoot, pythonCommand });

    if (llmProvider) {
      this.llm = llmProvider;
      this.embeddings = new EmbeddingService({ projectRoot, pythonCommand });
    } else {
      this._applySettings(settingsStore?.get() || {});
    }
  }

  _applySettings(settings) {
    const llm = settings.llm || {};
    this.llm = new LlmProvider({
      provider: llm.provider || undefined,
      baseUrl: llm.baseUrl || undefined,
      model: llm.model || undefined,
      apiKey: llm.apiKey || undefined
    });
    const emb = settings.embedding || {};
    this.embeddings = new EmbeddingService({
      projectRoot: this._projectRoot,
      pythonCommand: this._pythonCommand,
      backend: emb.backend || undefined,
      embeddingsUrl: emb.url || undefined,
      model: emb.model || undefined,
      dimensions: emb.dimensions || undefined,
      apiKey: emb.apiKey || undefined
    });
  }

  applySettings(patch) {
    if (!this.settingsStore) throw new Error("Settings store not configured");
    const settings = this.settingsStore.savePreset(patch.name, patch);
    this._applySettings(settings);
    return settings;
  }

  selectPreset(name) {
    if (!this.settingsStore) throw new Error("Settings store not configured");
    const settings = this.settingsStore.selectPreset(name);
    this._applySettings(settings);
    return settings;
  }

  deletePreset(name) {
    if (!this.settingsStore) throw new Error("Settings store not configured");
    const settings = this.settingsStore.deletePreset(name);
    this._applySettings(settings);
    return settings;
  }

  listProfiles() {
    return all(this.db, "SELECT * FROM profiles ORDER BY updated_at DESC");
  }

  async createProfile(input) {
    const at = nowIso();
    const profile = {
      id: id("profile"),
      name: nonEmpty(input.name, "New profile"),
      description: String(input.description || ""),
      created_at: at,
      updated_at: at
    };
    run(
      this.db,
      "INSERT INTO profiles (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      profile.id,
      profile.name,
      profile.description,
      profile.created_at,
      profile.updated_at
    );
    return profile;
  }

  getProfile(profileId) {
    return one(this.db, "SELECT * FROM profiles WHERE id = ?", profileId);
  }

  updateProfile(profileId, input) {
    this.ensureProfile(profileId);
    const name = nonEmpty(input.name, null);
    if (!name) throw Object.assign(new Error("Name is required"), { statusCode: 400 });
    run(this.db, "UPDATE profiles SET name = ?, updated_at = ? WHERE id = ?", name, nowIso(), profileId);
    return this.getProfile(profileId);
  }

  async deleteProfile(profileId) {
    this.ensureProfile(profileId);
    run(this.db, "DELETE FROM profiles WHERE id = ?", profileId);
    await rm(join(this.dataDir, "uploads", profileId), { recursive: true, force: true }).catch(() => {});
    return { ok: true };
  }

  ensureProfile(profileId) {
    const profile = this.getProfile(profileId);
    if (!profile) throw Object.assign(new Error("Profile not found"), { statusCode: 404 });
    return profile;
  }

  listSources(profileId) {
    this.ensureProfile(profileId);
    return all(this.db, "SELECT * FROM sources WHERE profile_id = ? ORDER BY created_at DESC", profileId).map((source) => ({
      ...source,
      chunkCount: one(this.db, "SELECT COUNT(*) AS count FROM chunks WHERE source_id = ?", source.id).count
    }));
  }

  async addTextSource(profileId, input) {
    this.ensureProfile(profileId);
    const text = String(input.text || "").trim();
    if (!text) throw Object.assign(new Error("Text is required"), { statusCode: 400 });
    const at = nowIso();
    const source = {
      id: id("source"),
      profile_id: profileId,
      kind: "text",
      title: nonEmpty(input.title, "Pasted text"),
      file_name: "",
      relative_path: "",
      mime_type: "text/plain",
      file_path: "",
      pasted_text: text,
      status: "pending",
      error: "",
      metadata_json: JSON.stringify({ input: "text" }),
      content_hash: hashText(text),
      created_at: at,
      updated_at: at,
      indexed_at: ""
    };
    insertSource(this.db, source);
    touchProfile(this.db, profileId);
    return source;
  }

  async addFileSources(profileId, parts) {
    this.ensureProfile(profileId);
    const created = [];

    for await (const part of parts) {
      if (part.type !== "file") continue;
      const sourceId = id("source");
      const relativePath = sanitizeFileName(normalizeUploadedFileName(part.filename));
      const fileName = basenameFromRelative(relativePath);
      const destination = join(this.dataDir, "uploads", profileId, sourceId, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await pipeline(part.file, createWriteStream(destination));

      const at = nowIso();
      const source = {
        id: sourceId,
        profile_id: profileId,
        kind: kindFromFileName(fileName),
        title: fileName,
        file_name: fileName,
        relative_path: relativePath,
        mime_type: part.mimetype || "",
        file_path: destination,
        pasted_text: "",
        status: "pending",
        error: "",
        metadata_json: JSON.stringify({ uploadField: part.fieldname }),
        content_hash: await hashFile(destination),
        created_at: at,
        updated_at: at,
        indexed_at: ""
      };
      insertSource(this.db, source);
      created.push(source);
    }

    if (!created.length) throw Object.assign(new Error("No files uploaded"), { statusCode: 400 });
    touchProfile(this.db, profileId);
    return created;
  }

  async addUrlSource(profileId, input) {
    this.ensureProfile(profileId);
    const url = String(input.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      throw Object.assign(new Error("유효한 http(s) URL이 필요합니다."), { statusCode: 400 });
    }

    let html;
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; local-mini-rag)" },
        redirect: "follow",
        signal: AbortSignal.timeout(Number(process.env.RAG_URL_TIMEOUT_MS || 20_000))
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      html = await response.text();
    } catch (error) {
      throw Object.assign(new Error(`URL을 가져오지 못했습니다: ${error.message}`), { statusCode: 502 });
    }

    const { title, text } = htmlToText(html);
    if (!text) throw Object.assign(new Error("페이지에서 텍스트를 추출하지 못했습니다."), { statusCode: 422 });

    const at = nowIso();
    const source = {
      id: id("source"),
      profile_id: profileId,
      kind: "url",
      title: nonEmpty(input.title, "") || title || url,
      file_name: "",
      relative_path: "",
      mime_type: "text/html",
      file_path: "",
      pasted_text: text,
      status: "pending",
      error: "",
      metadata_json: JSON.stringify({ input: "url", url }),
      content_hash: hashText(text),
      created_at: at,
      updated_at: at,
      indexed_at: ""
    };
    insertSource(this.db, source);
    touchProfile(this.db, profileId);
    return source;
  }

  async addPathSources(profileId, inputPath) {
    this.ensureProfile(profileId);
    const target = String(inputPath || "").trim();
    if (!target) throw Object.assign(new Error("Path is required"), { statusCode: 400 });
    if (!existsSync(target)) throw Object.assign(new Error(`Path not found: ${target}`), { statusCode: 400 });

    const stat = statSync(target);
    const files = [];
    if (stat.isDirectory()) {
      const rootName = basename(target.replace(/\/+$/, "")) || "folder";
      walkDir(target, rootName, files);
    } else {
      files.push({ abs: target, rel: basename(target) });
    }
    if (!files.length) throw Object.assign(new Error("No files found at path"), { statusCode: 400 });

    const created = [];
    for (const file of files) {
      const fileName = basename(file.abs);
      const at = nowIso();
      const source = {
        id: id("source"),
        profile_id: profileId,
        kind: kindFromFileName(fileName),
        title: fileName,
        file_name: fileName,
        relative_path: file.rel,
        mime_type: "",
        file_path: file.abs,
        pasted_text: "",
        status: "pending",
        error: "",
        metadata_json: JSON.stringify({ input: "path", origin: file.abs }),
        content_hash: await hashFile(file.abs),
        created_at: at,
        updated_at: at,
        indexed_at: ""
      };
      insertSource(this.db, source);
      created.push(source);
    }
    touchProfile(this.db, profileId);
    return created;
  }

  async copySource(targetProfileId, input) {
    this.ensureProfile(targetProfileId);
    const fromProfileId = String(input.fromProfileId || "");
    this.ensureProfile(fromProfileId);
    const source = one(this.db, "SELECT * FROM sources WHERE id = ? AND profile_id = ?", input.sourceId, fromProfileId);
    if (!source) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
    if (fromProfileId === targetProfileId) return source;

    const newId = id("source");
    // Copy uploaded files into the target profile so the copy is self-contained.
    // In-place path-referenced files (outside the data dir) are shared as-is.
    let newFilePath = source.file_path;
    if (source.file_path && isInside(this.dataDir, source.file_path)) {
      const rel = source.relative_path || basename(source.file_path);
      newFilePath = join(this.dataDir, "uploads", targetProfileId, newId, rel);
      await mkdir(dirname(newFilePath), { recursive: true });
      await copyFile(source.file_path, newFilePath);
    }

    const at = nowIso();
    const copy = { ...source, id: newId, profile_id: targetProfileId, file_path: newFilePath, created_at: at, updated_at: at };
    insertSource(this.db, copy);

    // Copy chunks with embeddings so the source is queryable immediately (same
    // global embedding model => same vector space, no re-embedding required).
    const chunks = all(this.db, "SELECT * FROM chunks WHERE source_id = ?", source.id);
    for (const chunk of chunks) {
      run(
        this.db,
        `INSERT INTO chunks (id, profile_id, source_id, chunk_index, text, locator_json, embedding_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id("chunk"),
        targetProfileId,
        newId,
        chunk.chunk_index,
        chunk.text,
        chunk.locator_json,
        chunk.embedding_json,
        chunk.created_at
      );
    }
    touchProfile(this.db, targetProfileId);
    return copy;
  }

  async deleteSource(profileId, sourceId) {
    this.ensureProfile(profileId);
    const source = one(this.db, "SELECT * FROM sources WHERE id = ? AND profile_id = ?", sourceId, profileId);
    if (!source) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
    run(this.db, "DELETE FROM sources WHERE id = ? AND profile_id = ?", sourceId, profileId);
    // Only remove files we copied into the data dir; never delete in-place path-referenced files.
    if (source.file_path && isInside(this.dataDir, source.file_path)) {
      await rm(source.file_path, { force: true }).catch(() => {});
    }
    touchProfile(this.db, profileId);
    return { ok: true };
  }

  async startIndexJob(profileId, input = {}) {
    this.ensureProfile(profileId);
    const at = nowIso();
    const job = {
      id: id("job"),
      profile_id: profileId,
      type: "index",
      status: "queued",
      message: "Queued",
      total_sources: 0,
      processed_sources: 0,
      failed_sources: 0,
      created_at: at,
      updated_at: at
    };
    run(
      this.db,
      `INSERT INTO jobs
       (id, profile_id, type, status, message, total_sources, processed_sources, failed_sources, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.id,
      job.profile_id,
      job.type,
      job.status,
      job.message,
      job.total_sources,
      job.processed_sources,
      job.failed_sources,
      job.created_at,
      job.updated_at
    );

    queueMicrotask(() => {
      this.runIndexJob(job.id, profileId, input).catch((error) => {
        this.logger?.error?.(error);
        updateJob(this.db, job.id, { status: "failed", message: error.message });
      });
    });

    return job;
  }

  getJob(jobId) {
    return one(this.db, "SELECT * FROM jobs WHERE id = ?", jobId);
  }

  async runIndexJob(jobId, profileId, input) {
    const onlySourceIds = Array.isArray(input.sourceIds) ? new Set(input.sourceIds) : null;
    const candidates = all(this.db, "SELECT * FROM sources WHERE profile_id = ? ORDER BY created_at ASC", profileId).filter(
      (source) => !onlySourceIds || onlySourceIds.has(source.id)
    );

    updateJob(this.db, jobId, {
      status: "running",
      message: "Indexing",
      total_sources: candidates.length,
      processed_sources: 0,
      failed_sources: 0
    });

    let processed = 0;
    let failed = 0;

    for (const source of candidates) {
      try {
        await this.indexSource(source);
        processed += 1;
        updateJob(this.db, jobId, {
          status: "running",
          message: `Indexed ${processed}/${candidates.length}`,
          processed_sources: processed,
          failed_sources: failed
        });
      } catch (error) {
        failed += 1;
        processed += 1;
        run(
          this.db,
          "UPDATE sources SET status = ?, error = ?, updated_at = ? WHERE id = ?",
          "failed_with_action",
          error.message,
          nowIso(),
          source.id
        );
        updateJob(this.db, jobId, {
          status: "running",
          message: `Indexed ${processed}/${candidates.length}`,
          processed_sources: processed,
          failed_sources: failed
        });
      }
    }

    updateJob(this.db, jobId, {
      status: failed ? "completed_with_errors" : "completed",
      message: failed ? `${failed} source(s) need action` : "Completed",
      processed_sources: processed,
      failed_sources: failed
    });
    touchProfile(this.db, profileId);
  }

  async indexSource(source) {
    run(this.db, "DELETE FROM chunks WHERE source_id = ?", source.id);
    run(this.db, "UPDATE sources SET status = ?, error = ?, updated_at = ? WHERE id = ?", "extracting", "", nowIso(), source.id);

    const extracted = await this.worker.extract(source);
    if (extracted.status !== "ok") {
      throw new Error(extracted.error || "Document extraction failed");
    }

    const chunks = chunkDocuments(extracted.documents || []);
    if (!chunks.length) throw new Error("No indexable text extracted");

    run(this.db, "UPDATE sources SET status = ?, updated_at = ? WHERE id = ?", "embedding", nowIso(), source.id);
    const vectors = await this.embeddings.embed(chunks.map((chunk) => chunk.text), { mode: "passage" });

    const at = nowIso();
    chunks.forEach((chunk, index) => {
      run(
        this.db,
        `INSERT INTO chunks (id, profile_id, source_id, chunk_index, text, locator_json, embedding_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id("chunk"),
        source.profile_id,
        source.id,
        index,
        chunk.text,
        JSON.stringify({ ...chunk.locator, metadata: chunk.metadata }),
        JSON.stringify(vectors[index]),
        at
      );
    });

    run(
      this.db,
      "UPDATE sources SET status = ?, error = ?, updated_at = ?, indexed_at = ?, metadata_json = ? WHERE id = ?",
      "indexed",
      "",
      at,
      at,
      JSON.stringify({
        ...safeJson(source.metadata_json),
        warnings: extracted.warnings || [],
        extractedUnits: extracted.documents?.length || 0,
        chunks: chunks.length
      }),
      source.id
    );
  }

  async search(profileId, input) {
    this.ensureProfile(profileId);
    const query = String(input.query || "").trim();
    if (!query) throw Object.assign(new Error("Query is required"), { statusCode: 400 });
    const topK = clamp(Number(input.topK || DEFAULT_TOP_K), 1, 30);
    const [queryVector] = await this.embeddings.embed([query], { mode: "query" });
    const chunks = all(
      this.db,
      `SELECT chunks.*, sources.title, sources.file_name, sources.relative_path, sources.kind
       FROM chunks
       JOIN sources ON sources.id = chunks.source_id
       WHERE chunks.profile_id = ?`,
      profileId
    );

    const scored = chunks
      .map((chunk) => {
        const vector = JSON.parse(chunk.embedding_json);
        const vectorScore = cosineSimilarity(queryVector, vector);
        const keywordScore = lexicalScore(query, chunk.text);
        return {
          id: chunk.id,
          sourceId: chunk.source_id,
          title: chunk.title,
          fileName: chunk.file_name,
          relativePath: chunk.relative_path,
          sourceKind: chunk.kind,
          text: chunk.text,
          locator: safeJson(chunk.locator_json),
          score: Number((vectorScore * 0.8 + keywordScore * 0.2).toFixed(6)),
          vectorScore: Number(vectorScore.toFixed(6)),
          keywordScore: Number(keywordScore.toFixed(6))
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);

    return {
      profileId,
      query,
      topK,
      hits: diversify(scored, topK)
    };
  }

  async buildContext(profileId, input) {
    const search = await this.search(profileId, input);
    const citations = search.hits.map((hit, index) => ({
      number: index + 1,
      chunkId: hit.id,
      sourceId: hit.sourceId,
      title: hit.title,
      locator: hit.locator,
      score: hit.score,
      excerpt: excerpt(hit.text),
      text: hit.text
    }));

    const contextText = search.hits
      .map((hit, index) => {
        const locator = formatLocator(hit.locator);
        return `[${index + 1}] ${hit.title}${locator ? ` (${locator})` : ""}\n${hit.text}`;
      })
      .join("\n\n");

    return {
      profileId,
      query: search.query,
      contextText,
      hits: search.hits,
      citations,
      sourceVersion: sourceVersion(this.db, profileId)
    };
  }

  async chat(profileId, input) {
    const query = String(input.query || "").trim();
    if (!query) throw Object.assign(new Error("Query is required"), { statusCode: 400 });
    const envelope = await this.buildContext(profileId, input);
    const mode =
      this.modeStore?.get(input.mode) ||
      this.modeStore?.get("general") ||
      this.modeStore?.list()[0] ||
      CHAT_MODES[CHAT_MODES[input.mode] ? input.mode : "general"];
    const result = await this.llm.generate({
      query,
      messages: input.messages || [],
      envelope,
      system: mode?.system
    });
    const at = nowIso();
    const runId = id("chat");
    run(
      this.db,
      `INSERT INTO chat_runs (id, profile_id, query, answer, citations_json, provider_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      runId,
      profileId,
      query,
      result.answer,
      JSON.stringify(envelope.citations),
      JSON.stringify(result.provider),
      at
    );
    return {
      id: runId,
      profileId,
      query,
      answer: result.answer,
      citations: envelope.citations,
      provider: result.provider,
      sourceVersion: envelope.sourceVersion,
      created_at: at
    };
  }
}

function insertSource(db, source) {
  run(
    db,
    `INSERT INTO sources
     (id, profile_id, kind, title, file_name, relative_path, mime_type, file_path, pasted_text, status, error,
      metadata_json, content_hash, created_at, updated_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    source.id,
    source.profile_id,
    source.kind,
    source.title,
    source.file_name,
    source.relative_path,
    source.mime_type,
    source.file_path,
    source.pasted_text,
    source.status,
    source.error,
    source.metadata_json,
    source.content_hash,
    source.created_at,
    source.updated_at,
    source.indexed_at
  );
}

function updateJob(db, jobId, patch) {
  const job = one(db, "SELECT * FROM jobs WHERE id = ?", jobId);
  if (!job) return;
  const next = { ...job, ...patch, updated_at: nowIso() };
  run(
    db,
    `UPDATE jobs
     SET status = ?, message = ?, total_sources = ?, processed_sources = ?, failed_sources = ?, updated_at = ?
     WHERE id = ?`,
    next.status,
    next.message,
    next.total_sources,
    next.processed_sources,
    next.failed_sources,
    next.updated_at,
    jobId
  );
}

function touchProfile(db, profileId) {
  run(db, "UPDATE profiles SET updated_at = ? WHERE id = ?", nowIso(), profileId);
}

const WALK_FILE_LIMIT = 2000;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", ".DS_Store", "dist"]);

function walkDir(dir, relPrefix, out) {
  if (out.length >= WALK_FILE_LIMIT) return;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= WALK_FILE_LIMIT) return;
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walkDir(abs, rel, out);
    } else if (entry.isFile()) {
      out.push({ abs, rel });
    }
  }
}

function htmlToText(html) {
  let s = String(html || "").replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ");
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: s };
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const num = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : match;
    }
    return named[code.toLowerCase()] ?? match;
  });
}

function isInside(parent, child) {
  const p = parent.endsWith("/") ? parent : `${parent}/`;
  return child === parent || child.startsWith(p);
}

function kindFromFileName(fileName) {
  const ext = extname(fileName).toLowerCase();
  if ([".txt", ".md", ".csv", ".json", ".html"].includes(ext)) return "text-file";
  if (ext === ".pdf") return "pdf";
  if ([".docx", ".doc"].includes(ext)) return "word";
  if ([".pptx", ".ppt"].includes(ext)) return "powerpoint";
  if ([".xlsx", ".xlsm", ".xls"].includes(ext)) return "excel";
  if ([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"].includes(ext)) return "image";
  return "file";
}

function safeJson(value) {
  try {
    return typeof value === "string" ? JSON.parse(value || "{}") : value || {};
  } catch {
    return {};
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function diversify(hits, topK) {
  const selected = [];
  const perSource = new Map();
  for (const hit of hits) {
    const count = perSource.get(hit.sourceId) || 0;
    if (count >= 3 && selected.length < Math.ceil(topK / 2)) continue;
    selected.push(hit);
    perSource.set(hit.sourceId, count + 1);
    if (selected.length >= topK) break;
  }
  return selected;
}

function excerpt(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 260);
}

function formatLocator(locator) {
  const parts = [];
  if (locator.relativePath) parts.push(locator.relativePath);
  if (locator.page) parts.push(`page ${locator.page}`);
  if (locator.slide) parts.push(`slide ${locator.slide}`);
  if (locator.sheet) parts.push(`sheet ${locator.sheet}`);
  if (locator.rowRange) parts.push(`rows ${locator.rowRange}`);
  return parts.join(", ");
}

function sourceVersion(db, profileId) {
  const row = one(
    db,
    "SELECT COUNT(*) AS count, COALESCE(MAX(indexed_at), '') AS indexedAt FROM sources WHERE profile_id = ?",
    profileId
  );
  return `${row.count}:${row.indexedAt}`;
}

function nonEmpty(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}
