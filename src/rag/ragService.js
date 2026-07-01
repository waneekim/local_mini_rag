import { createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { all, one, run } from "./db.js";
import { EmbeddingService } from "./embedding.js";
import { hashFile, hashText } from "./hash.js";
import { id, nowIso } from "./ids.js";
import { CHAT_MODES, LlmProvider } from "./llmProvider.js";
import { extractTextFromImage } from "./vision.js";
import {
  addExactCandidatesToQuery,
  buildFigmaAuditPrompt,
  extractFigmaTextCandidates,
  repairFigmaAuditAnswer
} from "./figmaAudit.js";
import { basenameFromRelative, normalizeUploadedFileName, sanitizeFileName } from "./sanitize.js";
import { chunkDocuments } from "./chunking.js";
import { bm25Scores, cosineSimilarity, lexicalScore } from "./vectorMath.js";
import { WorkerClient } from "./workerClient.js";
import { resolveRetrievalPolicy } from "./retrievalPolicy.js";

const MAX_FIGMA_SUPPLEMENTAL_CITATIONS = 4;

export function createRagService(options) {
  return new RagService(options);
}

class RagService {
  constructor({ db, dataDir, projectRoot, logger, llmProvider, pythonCommand, settingsStore, modeStore, auditSetStore }) {
    this.db = db;
    this.dataDir = dataDir;
    this.logger = logger;
    this._projectRoot = projectRoot;
    this._pythonCommand = pythonCommand;
    this.settingsStore = settingsStore;
    this.modeStore = modeStore;
    this.auditSetStore = auditSetStore;
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

  async visionExtract(image) {
    const llm = this.settingsStore?.get()?.llm || {};
    return extractTextFromImage(image, { llm });
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
    const profile = this.ensureProfile(profileId);
    const name = input.name === undefined ? profile.name : nonEmpty(input.name, null);
    if (!name) throw Object.assign(new Error("Name is required"), { statusCode: 400 });
    const description = input.description === undefined ? profile.description : String(input.description || "");
    run(
      this.db,
      "UPDATE profiles SET name = ?, description = ?, updated_at = ? WHERE id = ?",
      name,
      description,
      nowIso(),
      profileId
    );
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
    run(this.db, "DELETE FROM glossary_entries WHERE source_id = ?", source.id);
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
    const glossaryResult = await this.indexGlossaryEntries(source);

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
        chunks: chunks.length,
        glossaryEntries: glossaryResult.count,
        ...(glossaryResult.error ? { glossaryError: glossaryResult.error } : {})
      }),
      source.id
    );
  }

  async indexGlossaryEntries(source) {
    const suffix = extname(source.file_path || source.relative_path || source.title || "").toLowerCase();
    if (![".csv", ".xlsx", ".xlsm"].includes(suffix)) return { count: 0, error: "" };
    try {
      const extracted = await this.worker.extractGlossaryRows(source);
      if (extracted.status !== "ok") return { count: 0, error: extracted.error || "Glossary extraction failed" };
      const entries = normalizeGlossaryRows(extracted.rows || [], source);
      const at = nowIso();
      for (const entry of entries) {
        run(
          this.db,
          `INSERT INTO glossary_entries
           (id, profile_id, source_id, approved_term, disallowed_terms_json, synonyms_json, product_category,
            market, risk_level, note, locator_json, raw_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id("glossary"),
          source.profile_id,
          source.id,
          entry.approvedTerm,
          JSON.stringify(entry.disallowedTerms),
          JSON.stringify(entry.synonyms),
          entry.productCategory,
          entry.market,
          entry.riskLevel,
          entry.note,
          JSON.stringify(entry.locator),
          JSON.stringify(entry.raw),
          at
        );
      }
      return { count: entries.length, error: "" };
    } catch (error) {
      this.logger?.warn?.({ err: error, sourceId: source.id }, "Glossary structured extraction failed");
      return { count: 0, error: error.message };
    }
  }

  resolveMode(inputMode) {
    const requested = inputMode || "general";
    return (
      this.modeStore?.get(requested) ||
      this.modeStore?.get("general") ||
      this.modeStore?.list()[0] ||
      CHAT_MODES.general
    );
  }

  async search(profileId, input) {
    const profile = this.ensureProfile(profileId);
    const query = String(input.query || "").trim();
    if (!query) throw Object.assign(new Error("Query is required"), { statusCode: 400 });
    const mode = this.resolveMode(input.mode);
    const policy = resolveRetrievalPolicy(input, mode);
    const [queryVector] = await this.embeddings.embed([query], { mode: "query" });
    const chunks = all(
      this.db,
      `SELECT chunks.*, sources.title, sources.file_name, sources.relative_path, sources.kind
       FROM chunks
       JOIN sources ON sources.id = chunks.source_id
       WHERE chunks.profile_id = ?`,
      profileId
    );
    const lexicalScores = bm25Scores(
      query,
      chunks.map((chunk) => chunk.text)
    );

    const scored = chunks
      .map((chunk, index) => {
        const vector = JSON.parse(chunk.embedding_json);
        const vectorScore = cosineSimilarity(queryVector, vector);
        const keywordScore = lexicalScores[index] || 0;
        const exactScore = lexicalScore(query, chunk.text);
        return {
          id: chunk.id,
          sourceId: chunk.source_id,
          title: chunk.title,
          fileName: chunk.file_name,
          relativePath: chunk.relative_path,
          sourceKind: chunk.kind,
          text: chunk.text,
          locator: safeJson(chunk.locator_json),
          score: Number((vectorScore * policy.vectorWeight + keywordScore * policy.lexicalWeight).toFixed(6)),
          vectorScore: Number(vectorScore.toFixed(6)),
          keywordScore: Number(keywordScore.toFixed(6)),
          lexicalScore: Number(exactScore.toFixed(6))
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
    const candidates = diversify(scored, policy.candidateK);
    const rerank = await this.rerankCandidates(query, candidates, policy, profile);
    const hits = diversify(rerank.hits, policy.topK);
    const bestScore = hits[0]?.hybridScore ?? hits[0]?.score ?? 0;
    const insufficientEvidence = policy.strictGrounding && (!hits.length || bestScore < policy.minScore);

    return {
      profileId,
      profileName: profile.name,
      agentPurpose: profile.description,
      query,
      topK: policy.topK,
      hits,
      retrieval: {
        mode: policy.modeKey,
        modeLabel: policy.modeLabel,
        policyName: policy.name,
        topK: policy.topK,
        candidateK: policy.candidateK,
        candidateCount: candidates.length,
        finalCount: hits.length,
        reranked: rerank.reranked,
        rerankError: rerank.error || "",
        insufficientEvidence,
        strictGrounding: policy.strictGrounding,
        minScore: policy.minScore,
        profilePurpose: Boolean(profile.description)
      }
    };
  }

  async rerankCandidates(query, candidates, policy, profile) {
    if (!policy.rerank || candidates.length <= 1 || typeof this.llm?.rerank !== "function") {
      return { hits: candidates, reranked: false, error: "" };
    }
    try {
      const result = await this.llm.rerank({
        query,
        hits: candidates.slice(0, policy.rerankK),
        purpose: profile.description || "",
        mode: policy.name,
        maxResults: policy.topK
      });
      const hits = applyRerank(candidates, result?.ranking || []);
      if (!hits) return { hits: candidates, reranked: false, error: "empty rerank result" };
      return { hits, reranked: true, error: "" };
    } catch (error) {
      this.logger?.warn?.({ err: error }, "RAG rerank failed; falling back to hybrid score");
      return { hits: candidates, reranked: false, error: error.message };
    }
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
      agentPurpose: search.agentPurpose,
      retrieval: search.retrieval,
      sourceVersion: sourceVersion(this.db, profileId)
    };
  }

  async chat(profileId, input) {
    const query = String(input.query || "").trim();
    if (!query) throw Object.assign(new Error("Query is required"), { statusCode: 400 });
    let envelope = await this.buildContext(profileId, input);
    const mode = this.resolveMode(input.mode);
    const isFigmaAudit = isFigmaAuditMode(input.mode, mode);
    const reviewTexts = input.figmaAudit?.reviewTexts?.length ? input.figmaAudit.reviewTexts : [query];
    if (isFigmaAudit) {
      envelope = this.extendFigmaCandidateContext(profileId, envelope, reviewTexts);
    }
    const figmaCandidates = isFigmaAudit
      ? extractFigmaTextCandidates(reviewTexts, envelope.citations)
      : { exactCandidates: [], suggestionCandidates: [] };
    const { exactCandidates, suggestionCandidates } = figmaCandidates;
    const effectiveQuery = isFigmaAudit ? addExactCandidatesToQuery(query, exactCandidates, suggestionCandidates) : query;
    const result = await this.llm.generate({
      query: effectiveQuery,
      messages: input.messages || [],
      envelope,
      system: mode?.system,
      temperature: isFigmaAudit ? 0 : 0.2
    });
    const repair = isFigmaAudit
      ? repairFigmaAuditAnswer(result.answer, exactCandidates, suggestionCandidates)
      : { answer: result.answer, repaired: false };
    const at = nowIso();
    const runId = id("chat");
    run(
      this.db,
      `INSERT INTO chat_runs (id, profile_id, query, answer, citations_json, provider_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      runId,
      profileId,
      query,
      repair.answer,
      JSON.stringify(envelope.citations),
      JSON.stringify(result.provider),
      at
    );
    return {
      id: runId,
      profileId,
      query,
      answer: repair.answer,
      citations: envelope.citations,
      provider: result.provider,
      retrieval: envelope.retrieval,
      ...(isFigmaAudit
        ? {
            figmaGrounding: {
              exactCandidates,
              suggestionCandidates,
              repaired: repair.repaired
            }
          }
        : {}),
      sourceVersion: envelope.sourceVersion,
      created_at: at
    };
  }

  async figmaAudit(profileId, input = {}) {
    if (input.auditSetId) return this.auditSetReview(input.auditSetId, input);
    const audit = buildFigmaAuditPrompt(input);
    const result = await this.chat(profileId, {
      ...input,
      query: audit.query,
      mode: input.mode || "figmaAudit",
      topK: input.topK || 10,
      figmaAudit: audit
    });
    return {
      ...result,
      figma: {
        items: audit.items,
        focus: audit.focus,
        truncated: audit.truncated
      }
    };
  }

  async auditSetReview(auditSetId, input = {}) {
    const auditSet = this.auditSetStore?.get(auditSetId) || this.auditSetStore?.active();
    if (!auditSet) throw Object.assign(new Error("검수 세트가 설정되지 않았습니다."), { statusCode: 400 });
    this.ensureProfile(auditSet.phraseGuideProfileId);
    this.ensureProfile(auditSet.glossaryProfileId);

    const audit = buildFigmaAuditPrompt({ ...input, text: input.text ?? input.query ?? input.copy ?? "" });
    const reviewTexts = audit.reviewTexts?.length ? audit.reviewTexts : [String(input.query || input.text || "")];
    const plainText = reviewTexts.join("\n").trim();
    if (!plainText) throw Object.assign(new Error("검수할 텍스트가 필요합니다."), { statusCode: 400 });

    let guideEnvelope = await this.buildContext(auditSet.phraseGuideProfileId, {
      query: plainText,
      mode: input.mode || "figmaAudit",
      topK: input.topK || 8,
      rerank: input.rerank
    });
    guideEnvelope = this.extendFigmaCandidateContext(auditSet.phraseGuideProfileId, guideEnvelope, reviewTexts);
    const guideCandidates = extractFigmaTextCandidates(reviewTexts, guideEnvelope.citations);
    const glossaryReview = this.reviewGlossary(auditSet.glossaryProfileId, plainText);

    const combinedCitations = renumberCitations([
      ...guideEnvelope.citations,
      ...glossaryReview.citations
    ]);
    const renumberedGuide = renumberCandidateNumbers(guideCandidates, combinedCitations);
    const answer = buildAuditSetAnswer({
      originalText: plainText,
      guideCandidates: renumberedGuide,
      glossaryReview: remapGlossaryReviewNumbers(glossaryReview, combinedCitations)
    });
    const at = nowIso();
    const runId = id("chat");
    run(
      this.db,
      `INSERT INTO chat_runs (id, profile_id, query, answer, citations_json, provider_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      runId,
      auditSet.phraseGuideProfileId,
      plainText,
      answer,
      JSON.stringify(combinedCitations),
      JSON.stringify({ provider: "audit-set", model: "deterministic" }),
      at
    );
    return {
      id: runId,
      auditSet,
      profileId: auditSet.phraseGuideProfileId,
      query: plainText,
      answer,
      citations: combinedCitations,
      provider: { provider: "audit-set", model: "deterministic" },
      retrieval: {
        mode: "figmaAudit",
        policyName: "auditSet",
        phraseGuideProfileId: auditSet.phraseGuideProfileId,
        glossaryProfileId: auditSet.glossaryProfileId,
        glossaryExactMatches: glossaryReview.exactMatches.length,
        glossarySuggestionCount: glossaryReview.suggestions.length,
        guideCandidateCount: guideCandidates.exactCandidates.length + guideCandidates.suggestionCandidates.length
      },
      figmaGrounding: {
        exactCandidates: renumberedGuide.exactCandidates,
        suggestionCandidates: renumberedGuide.suggestionCandidates,
        glossary: {
          exactMatches: glossaryReview.exactMatches,
          suggestions: glossaryReview.suggestions
        },
        repaired: true
      },
      figma: {
        items: audit.items,
        focus: audit.focus,
        truncated: audit.truncated
      },
      sourceVersion: `${sourceVersion(this.db, auditSet.phraseGuideProfileId)}:${sourceVersion(this.db, auditSet.glossaryProfileId)}`,
      created_at: at
    };
  }

  listGlossaryEntries(profileId) {
    this.ensureProfile(profileId);
    return all(
      this.db,
      `SELECT glossary_entries.*, sources.title AS source_title, sources.relative_path AS source_path
       FROM glossary_entries
       JOIN sources ON sources.id = glossary_entries.source_id
       WHERE glossary_entries.profile_id = ?
       ORDER BY glossary_entries.created_at DESC`,
      profileId
    ).map(rowToGlossaryEntry);
  }

  reviewGlossary(profileId, text) {
    const entries = this.listGlossaryEntries(profileId);
    const exactMatches = [];
    const suggestions = [];
    const seenCitations = new Set();
    const citations = [];

    for (const entry of entries) {
      const match = exactGlossaryMatch(entry, text);
      if (match) {
        exactMatches.push(match);
        if (!seenCitations.has(entry.id)) {
          citations.push(glossaryCitation(entry, 1, match.confidence));
          seenCitations.add(entry.id);
        }
        continue;
      }
      const score = lexicalScore(text, glossaryEntrySearchText(entry));
      if (score >= 0.08) {
        const suggestion = {
          entry,
          inputTerm: "",
          matchedTerm: "",
          status: "similar",
          approvedTerm: entry.approvedTerm,
          confidence: Number(Math.min(0.79, Math.max(0.5, score)).toFixed(6)),
          reason: "단어장 설명 또는 유사어와 질문이 유사합니다.",
          riskLevel: normalizeRisk(entry.riskLevel)
        };
        suggestions.push(suggestion);
        if (!seenCitations.has(entry.id)) {
          citations.push(glossaryCitation(entry, 1, suggestion.confidence));
          seenCitations.add(entry.id);
        }
      }
    }

    suggestions.sort((a, b) => b.confidence - a.confidence);
    return {
      exactMatches: exactMatches.slice(0, 8),
      suggestions: suggestions.slice(0, 5),
      citations
    };
  }

  extendFigmaCandidateContext(profileId, envelope, reviewTexts) {
    const existing = new Set((envelope.citations || []).map((citation) => citation.chunkId));
    const chunks = all(
      this.db,
      `SELECT chunks.*, sources.title, sources.file_name, sources.relative_path, sources.kind
       FROM chunks
       JOIN sources ON sources.id = chunks.source_id
       WHERE chunks.profile_id = ?`,
      profileId
    );
    const supplemental = [];
    for (const chunk of chunks) {
      if (existing.has(chunk.id)) continue;
      const citation = citationFromChunk(chunk, 1);
      const candidates = extractFigmaTextCandidates(reviewTexts, [citation]);
      const best = candidates.exactCandidates[0] || candidates.suggestionCandidates[0];
      if (!best) continue;
      supplemental.push({ citation, confidence: best.confidence || 0 });
    }
    if (!supplemental.length) return envelope;

    const extraCitations = supplemental
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_FIGMA_SUPPLEMENTAL_CITATIONS)
      .map((entry) => entry.citation);
    const citations = [...envelope.citations, ...extraCitations].map((citation, index) => ({
      ...citation,
      number: index + 1
    }));
    return {
      ...envelope,
      citations,
      contextText: contextTextFromCitations(citations),
      retrieval: {
        ...(envelope.retrieval || {}),
        finalCount: citations.length,
        supplementalCitations: extraCitations.length
      }
    };
  }
}

const GLOSSARY_COLUMNS = {
  approved: ["승인어", "표준어", "권장어", "사용어", "올바른단어", "올바른 단어", "올바른표현", "올바른 표현", "정확한단어", "정확한 단어", "정확한표현", "정확한 표현", "approved", "standard", "preferred", "term"],
  disallowed: ["금지어", "비권장어", "오용어", "잘못된단어", "잘못된 단어", "잘못된표현", "잘못된 표현", "사용금지", "사용 금지", "forbidden", "deprecated", "wrong"],
  synonyms: ["동의어", "유사어", "대체어", "관련어", "synonym", "synonyms", "alias", "aliases"],
  productCategory: ["제품군", "카테고리", "제품", "종류", "product", "category"],
  market: ["국가", "시장", "지역", "마켓", "country", "market", "region"],
  riskLevel: ["위험도", "리스크", "risk", "risklevel", "risk level"],
  note: ["근거", "설명", "가이드", "비고", "사유", "note", "description", "rationale"]
};

function normalizeGlossaryRows(rows, source) {
  return (rows || [])
    .map((row) => {
      const cells = row.cells || {};
      const approvedTerms = splitTerms(firstCell(cells, GLOSSARY_COLUMNS.approved));
      const disallowedTerms = splitTerms(firstCell(cells, GLOSSARY_COLUMNS.disallowed));
      const synonyms = splitTerms(firstCell(cells, GLOSSARY_COLUMNS.synonyms));
      const approvedTerm = approvedTerms[0] || "";
      if (!approvedTerm) return null;
      const locator = {
        ...(row.locator || {}),
        ...(source.relative_path ? { relativePath: source.relative_path } : {})
      };
      return {
        approvedTerm,
        disallowedTerms: uniqueStrings(disallowedTerms.filter((term) => term !== approvedTerm)),
        synonyms: uniqueStrings(synonyms.filter((term) => term !== approvedTerm)),
        productCategory: firstCell(cells, GLOSSARY_COLUMNS.productCategory),
        market: firstCell(cells, GLOSSARY_COLUMNS.market),
        riskLevel: firstCell(cells, GLOSSARY_COLUMNS.riskLevel),
        note: firstCell(cells, GLOSSARY_COLUMNS.note),
        locator,
        raw: cells
      };
    })
    .filter(Boolean);
}

function rowToGlossaryEntry(row) {
  return {
    id: row.id,
    profileId: row.profile_id,
    sourceId: row.source_id,
    sourceTitle: row.source_title || "단어장",
    sourcePath: row.source_path || "",
    approvedTerm: row.approved_term || "",
    disallowedTerms: safeJson(row.disallowed_terms_json, []),
    synonyms: safeJson(row.synonyms_json, []),
    productCategory: row.product_category || "",
    market: row.market || "",
    riskLevel: row.risk_level || "",
    note: row.note || "",
    locator: safeJson(row.locator_json),
    raw: safeJson(row.raw_json)
  };
}

function firstCell(cells, aliases) {
  const normalized = new Map();
  for (const [key, value] of Object.entries(cells || {})) {
    normalized.set(normalizeHeader(key), String(value || "").trim());
  }
  for (const alias of aliases) {
    const value = normalized.get(normalizeHeader(alias));
    if (value) return value;
  }
  return "";
}

function normalizeHeader(value) {
  return String(value || "").toLowerCase().replace(/[\s_\-./()]/g, "");
}

function splitTerms(value) {
  return uniqueStrings(
    String(value || "")
      .split(/[,;|\n\r、，]+/g)
      .map((term) => term.trim())
      .filter(Boolean)
  );
}

function exactGlossaryMatch(entry, text) {
  const checks = [
    ...entry.disallowedTerms.map((term) => ({ term, status: "forbidden", confidence: 1 })),
    ...entry.synonyms.map((term) => ({ term, status: "synonym", confidence: 0.95 })),
    { term: entry.approvedTerm, status: "approved", confidence: 1 }
  ].filter((item) => item.term);
  for (const check of checks) {
    if (!containsTerm(text, check.term)) continue;
    return {
      entry,
      inputTerm: check.term,
      matchedTerm: check.term,
      status: check.status,
      approvedTerm: entry.approvedTerm,
      confidence: check.confidence,
      riskLevel: normalizeRisk(entry.riskLevel || (check.status === "forbidden" ? "높음" : "")),
      reason:
        check.status === "approved"
          ? "단어장에 승인어로 등록되어 있습니다."
          : check.status === "synonym"
            ? "단어장에 유사어/대체어로 등록되어 있어 승인어 확인이 필요합니다."
            : "단어장에 금지어 또는 비권장어로 등록되어 있습니다."
    };
  }
  return null;
}

function glossaryEntrySearchText(entry) {
  return [entry.approvedTerm, ...entry.disallowedTerms, ...entry.synonyms, entry.productCategory, entry.market, entry.note]
    .filter(Boolean)
    .join(" ");
}

function containsTerm(text, term) {
  const normalizedText = normalizeForTermMatch(text);
  const normalizedTerm = normalizeForTermMatch(term);
  return Boolean(normalizedTerm && normalizedText.includes(normalizedTerm));
}

function normalizeForTermMatch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, "");
}

function glossaryCitation(entry, number, score) {
  const text = [
    `승인어: ${entry.approvedTerm}`,
    entry.disallowedTerms.length ? `금지/비권장어: ${entry.disallowedTerms.join(", ")}` : "",
    entry.synonyms.length ? `동의어/유사어: ${entry.synonyms.join(", ")}` : "",
    entry.productCategory ? `제품군: ${entry.productCategory}` : "",
    entry.market ? `국가/시장: ${entry.market}` : "",
    entry.riskLevel ? `위험도: ${entry.riskLevel}` : "",
    entry.note ? `근거: ${entry.note}` : ""
  ].filter(Boolean).join("\n");
  return {
    number,
    chunkId: `glossary:${entry.id}`,
    glossaryEntryId: entry.id,
    sourceId: entry.sourceId,
    title: entry.sourceTitle || "단어장",
    locator: entry.locator || {},
    score,
    excerpt: excerpt(text),
    text,
    sourceType: "glossary"
  };
}

function renumberCitations(citations) {
  return (citations || []).map((citation, index) => ({
    ...citation,
    originalNumber: citation.number,
    number: index + 1
  }));
}

function renumberCandidateNumbers(candidates, combinedCitations) {
  const byOriginal = new Map();
  for (const citation of combinedCitations) {
    if (citation.sourceType === "glossary") continue;
    if (!byOriginal.has(citation.originalNumber)) byOriginal.set(citation.originalNumber, citation.number);
  }
  const update = (candidate) => ({
    ...candidate,
    number: byOriginal.get(candidate.number) || candidate.number
  });
  return {
    exactCandidates: (candidates.exactCandidates || []).map(update),
    suggestionCandidates: (candidates.suggestionCandidates || []).map(update)
  };
}

function remapGlossaryReviewNumbers(review, combinedCitations) {
  const byEntry = new Map(combinedCitations.filter((citation) => citation.glossaryEntryId).map((citation) => [citation.glossaryEntryId, citation.number]));
  const withNumber = (item) => ({
    ...item,
    number: byEntry.get(item.entry.id) || 0
  });
  return {
    exactMatches: review.exactMatches.map(withNumber),
    suggestions: review.suggestions.map(withNumber),
    citations: review.citations
  };
}

function buildAuditSetAnswer({ originalText, guideCandidates, glossaryReview }) {
  const corrected = correctedSentence(originalText, guideCandidates, glossaryReview);
  const basis = basisLine(guideCandidates, glossaryReview);
  const wordLines = glossaryReview.exactMatches.length
    ? glossaryReview.exactMatches.map((match) => {
        const status = match.status === "approved" ? "적합" : match.status === "synonym" ? "확인 필요" : "수정 필요";
        return `- ${match.inputTerm}: ${status} → ${match.approvedTerm} [${match.number}] · 위험도 ${match.riskLevel} · ${match.reason}`;
      })
    : ["- 정확히 일치하는 단어장 항목 없음"];
  const recommendationLines = recommendationLinesForAudit(guideCandidates, glossaryReview);

  return [
    `올바른 문장: ${corrected}`,
    `근거: ${basis}`,
    "단어 검수:",
    ...wordLines,
    "추천 표현:",
    ...recommendationLines
  ].join("\n");
}

function correctedSentence(originalText, guideCandidates, glossaryReview) {
  let corrected = String(originalText || "").trim();
  let changed = false;
  for (const match of glossaryReview.exactMatches) {
    if (match.status === "approved") continue;
    const next = replaceTerm(corrected, match.inputTerm, match.approvedTerm);
    if (next !== corrected) {
      corrected = next;
      changed = true;
    }
  }
  if (changed) return corrected;
  const exact = guideCandidates.exactCandidates?.[0];
  if (exact) return exact.text;
  return "판단 보류";
}

function replaceTerm(text, from, to) {
  if (!from || !to) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(text || "").replace(new RegExp(escaped, "g"), to);
}

function basisLine(guideCandidates, glossaryReview) {
  const glossary = glossaryReview.exactMatches[0] || glossaryReview.suggestions[0];
  if (glossary?.number) {
    return `${glossary.reason || "단어장 근거가 있습니다."} [${glossary.number}]`;
  }
  const guide = guideCandidates.exactCandidates?.[0] || guideCandidates.suggestionCandidates?.[0];
  if (guide?.number) return `${guide.reason || "문장 가이드 후보가 있습니다."} [${guide.number}]`;
  return "관련 규칙 없음";
}

function recommendationLinesForAudit(guideCandidates, glossaryReview) {
  const out = [];
  const seen = new Set();
  const push = (text, number, confidence, risk, reason) => {
    const key = normalizeForTermMatch(text);
    if (!text || seen.has(key)) return;
    seen.add(key);
    out.push(`- ${text}${number ? ` [${number}]` : ""} · 유사도 ${formatPercent(confidence)} · 위험도 ${risk} · ${reason}`);
  };

  for (const match of glossaryReview.exactMatches) {
    push(match.approvedTerm, match.number, match.confidence, match.riskLevel, match.reason);
  }
  for (const candidate of guideCandidates.exactCandidates || []) {
    push(candidate.text, candidate.number, candidate.confidence, "낮음", candidate.reason || "문장 가이드의 원문 후보입니다.");
  }
  for (const candidate of guideCandidates.suggestionCandidates || []) {
    push(candidate.text, candidate.number, candidate.confidence, "낮음", candidate.reason || "문장 가이드의 유사 원문 후보입니다.");
  }
  for (const suggestion of glossaryReview.suggestions) {
    push(suggestion.approvedTerm, suggestion.number, suggestion.confidence, suggestion.riskLevel, suggestion.reason);
  }
  return out.length ? out : ["- 추천 가능한 원문 후보 없음 · 유사도 기준 미달 · 참조문서에서 충분히 가까운 표현을 찾지 못했습니다."];
}

function normalizeRisk(value) {
  const text = String(value || "").trim();
  if (!text) return "중간";
  if (/high|높|상|critical|위험/i.test(text)) return "높음";
  if (/low|낮|하/i.test(text)) return "낮음";
  return text;
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
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

function safeJson(value, fallback = {}) {
  try {
    return typeof value === "string" ? JSON.parse(value || JSON.stringify(fallback)) : value || fallback;
  } catch {
    return fallback;
  }
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

function applyRerank(candidates, ranking) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected = [];
  const seen = new Set();
  const validRanking = (ranking || []).filter((item) => byId.has(String(item.id || "")));
  if (!validRanking.length) return null;

  validRanking.forEach((item, index) => {
    const id = String(item.id || "");
    if (seen.has(id)) return;
    const hit = byId.get(id);
    const score = Number(item.score);
    const fallbackScore = 1 - index / Math.max(1, validRanking.length);
    const rerankScore = Number((Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : fallbackScore).toFixed(6));
    selected.push({
      ...hit,
      hybridScore: hit.score,
      rerankScore,
      score: Number((hit.score * 0.35 + rerankScore * 0.65).toFixed(6))
    });
    seen.add(id);
  });

  for (const candidate of candidates) {
    if (!seen.has(candidate.id)) selected.push(candidate);
  }
  return selected;
}

function excerpt(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 260);
}

function citationFromChunk(chunk, number) {
  return {
    number,
    chunkId: chunk.id,
    sourceId: chunk.source_id,
    title: chunk.title,
    locator: safeJson(chunk.locator_json),
    score: 0,
    excerpt: excerpt(chunk.text),
    text: chunk.text
  };
}

function contextTextFromCitations(citations) {
  return (citations || [])
    .map((citation) => {
      const locator = formatLocator(citation.locator || {});
      return `[${citation.number}] ${citation.title}${locator ? ` (${locator})` : ""}\n${citation.text}`;
    })
    .join("\n\n");
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

function isFigmaAuditMode(inputMode, mode) {
  const key = String(inputMode || mode?.key || "").toLowerCase();
  if (key === "figmaaudit" || key === "figma-audit" || key === "figma" || key === "피그마" || key === "규율") return true;
  return (mode?.aliases || []).some((alias) => {
    const value = String(alias || "").toLowerCase();
    return value === "figmaaudit" || value === "figma-audit" || value === "figma" || value === "피그마" || value === "규율";
  });
}

function nonEmpty(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}
