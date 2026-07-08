import { EventEmitter } from "node:events";
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
import { imageToDataUrl, structureFromImage, structureFromText } from "./preprocess.js";
import { captureUrlScreenshot, extractUrlTextFromBrowser } from "../browserCapture.js";
import { basenameFromRelative, normalizeUploadedFileName, sanitizeFileName } from "./sanitize.js";
import { chunkDocuments } from "./chunking.js";
import { bm25Scores, cosineSimilarity, lexicalScore } from "./vectorMath.js";
import { WorkerClient } from "./workerClient.js";
import { RerankService } from "./rerank.js";
import { RULE_EXTRACTION_SYSTEM, lintText, buildRuleBlock, parseRuleRecords, normalizeRuleInput } from "./rules.js";
import {
  GLOSSARY_EXTRACTION_SYSTEM,
  buildGlossaryBlock,
  checkText,
  normalizeGlossaryInput,
  normalizeTermKey,
  parseGlossaryRecords
} from "./glossary.js";
import {
  CONCEPT_CARD_SYSTEM,
  CONCEPT_EXTRACTION_SYSTEM,
  buildCardPrompt,
  buildConceptBlock,
  expandQuery,
  matchConcepts,
  normalizeConceptInput,
  parseConceptRecords
} from "./concepts.js";

const DEFAULT_TOP_K = 8;

export function createRagService(options) {
  return new RagService(options);
}

class RagService {
  constructor({ db, dataDir, projectRoot, logger, llmProvider, pythonCommand, settingsStore, modeStore, reranker }) {
    this.db = db;
    this.dataDir = dataDir;
    this.logger = logger;
    this._projectRoot = projectRoot;
    this._pythonCommand = pythonCommand;
    this.settingsStore = settingsStore;
    this.modeStore = modeStore;
    // Per-profile event bus for SSE (/events): live job/source progress so the
    // UI can update without polling. Bounded listener count for many open tabs.
    this.events = new EventEmitter();
    this.events.setMaxListeners(200);
    this.worker = new WorkerClient({ projectRoot, pythonCommand });
    this.reranker = reranker || new RerankService();

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
      visionModel: llm.visionModel || undefined,
      apiKey: llm.apiKey || undefined,
      // Gauss OpenAPI credentials (only set when the active preset uses gauss-openapi).
      gaussClientToken: llm.gaussClientToken || undefined,
      gaussOpenapiToken: llm.gaussOpenapiToken || undefined,
      gaussUserEmail: llm.gaussUserEmail || undefined
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

  // --- Central library (shared RAG) ---------------------------------------
  // The host marks profiles as `published` so remote viewers can browse them
  // read-only and copy them into their own local instance.

  setPublished(profileId, published) {
    this.ensureProfile(profileId);
    run(this.db, "UPDATE profiles SET published = ?, updated_at = ? WHERE id = ?", published ? 1 : 0, nowIso(), profileId);
    return this.getProfile(profileId);
  }

  // Identifies the vector space so an importer knows whether it can copy the
  // embeddings as-is or must re-embed the chunk text with its own model.
  embeddingFingerprint() {
    const d = this.embeddings.describe();
    return { backend: d.backend, model: d.model };
  }

  // Published profiles with chunk/source counts for the central library list.
  listCentral() {
    return all(this.db, "SELECT * FROM profiles WHERE published = 1 ORDER BY updated_at DESC").map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      updated_at: profile.updated_at,
      sourceCount: one(this.db, "SELECT COUNT(*) AS count FROM sources WHERE profile_id = ?", profile.id).count,
      chunkCount: one(this.db, "SELECT COUNT(*) AS count FROM chunks WHERE profile_id = ?", profile.id).count,
      embedding: this.embeddingFingerprint()
    }));
  }

  // Self-contained snapshot (sources + chunks with embeddings) of one published
  // profile, safe to hand to a remote instance. Host-local file paths are dropped.
  exportProfile(profileId) {
    const profile = this.ensureProfile(profileId);
    if (!profile.published) throw Object.assign(new Error("Profile is not published"), { statusCode: 403 });
    const sources = all(this.db, "SELECT * FROM sources WHERE profile_id = ? ORDER BY created_at ASC", profileId);
    const chunks = all(this.db, "SELECT * FROM chunks WHERE profile_id = ?", profileId);
    return {
      format: "ark-central-export/1",
      embedding: this.embeddingFingerprint(),
      profile: { name: profile.name, description: profile.description },
      sources: sources.map((s) => ({
        refId: s.id,
        kind: s.kind,
        title: s.title,
        file_name: s.file_name,
        relative_path: s.relative_path,
        mime_type: s.mime_type,
        pasted_text: s.pasted_text,
        status: s.status,
        error: s.error,
        metadata_json: s.metadata_json,
        content_hash: s.content_hash,
        indexed_at: s.indexed_at
      })),
      chunks: chunks.map((c) => ({
        sourceRefId: c.source_id,
        chunk_index: c.chunk_index,
        text: c.text,
        locator_json: c.locator_json,
        embedding_json: c.embedding_json
      }))
    };
  }

  // Pull a published profile from a remote host into a private local copy.
  // Reuses the remote embeddings when the vector space matches, otherwise
  // re-embeds every chunk with the local embedding model.
  async importFromRemote(input = {}) {
    const base = normalizeBaseUrl(input.remoteUrl);
    const remoteProfileId = String(input.profileId || "").trim();
    if (!remoteProfileId) throw Object.assign(new Error("profileId is required"), { statusCode: 400 });

    let payload;
    try {
      const response = await fetch(`${base}/api/central/profiles/${encodeURIComponent(remoteProfileId)}/export`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(Number(process.env.RAG_URL_TIMEOUT_MS || 20_000))
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
    } catch (error) {
      throw Object.assign(new Error(`중앙 서버에서 가져오지 못했습니다: ${error.message}`), { statusCode: 502 });
    }
    if (payload?.format !== "ark-central-export/1") {
      throw Object.assign(new Error("지원하지 않는 내보내기 형식입니다."), { statusCode: 422 });
    }

    const local = this.embeddingFingerprint();
    const compatible =
      payload.embedding?.backend === local.backend && payload.embedding?.model === local.model;

    const at = nowIso();
    const newProfileId = id("profile");
    const name = nonEmpty(input.newName, "") || `${nonEmpty(payload.profile?.name, "가져온 에이전트")} (중앙)`;
    run(
      this.db,
      "INSERT INTO profiles (id, name, description, created_at, updated_at, published) VALUES (?, ?, ?, ?, ?, 0)",
      newProfileId,
      name,
      String(payload.profile?.description || ""),
      at,
      at
    );

    // Map remote source ids -> new local ids and copy source rows (no files).
    const sourceIdMap = new Map();
    const sourceRelMap = new Map();
    for (const s of payload.sources || []) {
      const newSourceId = id("source");
      sourceIdMap.set(s.refId, newSourceId);
      sourceRelMap.set(s.refId, s.relative_path || "");
      insertSource(this.db, {
        id: newSourceId,
        profile_id: newProfileId,
        kind: s.kind || "text",
        title: s.title || "source",
        file_name: s.file_name || "",
        relative_path: s.relative_path || "",
        mime_type: s.mime_type || "",
        file_path: "",
        pasted_text: s.pasted_text || "",
        status: s.status || "indexed",
        error: s.error || "",
        metadata_json: s.metadata_json || "{}",
        content_hash: s.content_hash || "",
        created_at: at,
        updated_at: at,
        indexed_at: s.indexed_at || at
      });
    }

    const chunks = (payload.chunks || []).filter((c) => sourceIdMap.has(c.sourceRefId));
    let vectors = null;
    if (!compatible) {
      // Re-embed chunk text with the local model, batched to bound request size.
      vectors = [];
      const texts = chunks.map((c) => c.text);
      for (let i = 0; i < texts.length; i += 64) {
        const batch = await this.embeddings.embed(texts.slice(i, i + 64), { mode: "passage" });
        vectors.push(...batch);
      }
    }

    chunks.forEach((c, index) => {
      run(
        this.db,
        `INSERT INTO chunks (id, profile_id, source_id, chunk_index, text, locator_json, embedding_json, folder_path, heading_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id("chunk"),
        newProfileId,
        sourceIdMap.get(c.sourceRefId),
        c.chunk_index,
        c.text,
        c.locator_json || "{}",
        compatible ? c.embedding_json : JSON.stringify(vectors[index]),
        folderPathOf(sourceRelMap.get(c.sourceRefId)),
        headingPathOf(c.locator_json),
        at
      );
    });

    return { profile: this.getProfile(newProfileId), reembedded: !compatible, chunks: chunks.length };
  }

  // Proxy the remote host's central list so the browser avoids cross-origin calls.
  async browseRemote(remoteUrl) {
    const base = normalizeBaseUrl(remoteUrl);
    try {
      const response = await fetch(`${base}/api/central/profiles`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(Number(process.env.RAG_URL_TIMEOUT_MS || 20_000))
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const profiles = await response.json();
      return { remoteUrl: base, profiles: Array.isArray(profiles) ? profiles : [] };
    } catch (error) {
      throw Object.assign(new Error(`중앙 서버에 연결하지 못했습니다: ${error.message}`), { statusCode: 502 });
    }
  }

  ensureProfile(profileId) {
    const profile = this.getProfile(profileId);
    if (!profile) throw Object.assign(new Error("Profile not found"), { statusCode: 404 });
    return profile;
  }

  // --- Structured writing rules (deterministic guideline compliance) --------

  listRules(profileId, { status } = {}) {
    this.ensureProfile(profileId);
    const rows = status
      ? all(this.db, "SELECT * FROM rules WHERE profile_id = ? AND status = ? ORDER BY created_at ASC", profileId, status)
      : all(this.db, "SELECT * FROM rules WHERE profile_id = ? ORDER BY created_at ASC", profileId);
    return rows.map(hydrateRule);
  }

  upsertRule(profileId, input = {}) {
    this.ensureProfile(profileId);
    const at = nowIso();
    const existing = input.id ? one(this.db, "SELECT * FROM rules WHERE id = ? AND profile_id = ?", input.id, profileId) : null;
    // Merge provided keys over the existing rule so a partial PATCH (e.g. just
    // { status: "approved" }) never wipes the other fields.
    const base = existing ? hydrateRule(existing) : {};
    const fields = normalizeRuleInput({
      section: input.section ?? base.section,
      principle: input.principle ?? base.principle,
      terms: input.terms ?? base.terms,
      prefer: input.prefer ?? base.prefer,
      pairs: input.pairs ?? base.pairs,
      note: input.note ?? base.note
    });
    const status = input.status === "approved" || input.status === "draft" ? input.status : existing?.status || "draft";
    if (existing) {
      run(
        this.db,
        `UPDATE rules SET section = ?, principle = ?, terms_json = ?, prefer_json = ?, pairs_json = ?, note = ?, status = ?, updated_at = ?
         WHERE id = ? AND profile_id = ?`,
        fields.section, fields.principle, JSON.stringify(fields.terms), JSON.stringify(fields.prefer),
        JSON.stringify(fields.pairs), fields.note, status, at, input.id, profileId
      );
      return hydrateRule(one(this.db, "SELECT * FROM rules WHERE id = ?", input.id));
    }
    const ruleId = id("rule");
    run(
      this.db,
      `INSERT INTO rules (id, profile_id, source_id, section, principle, terms_json, prefer_json, pairs_json, note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ruleId, profileId, String(input.sourceId || ""), fields.section, fields.principle,
      JSON.stringify(fields.terms), JSON.stringify(fields.prefer), JSON.stringify(fields.pairs), fields.note, status, at, at
    );
    return hydrateRule(one(this.db, "SELECT * FROM rules WHERE id = ?", ruleId));
  }

  deleteRule(profileId, ruleId) {
    this.ensureProfile(profileId);
    run(this.db, "DELETE FROM rules WHERE id = ? AND profile_id = ?", ruleId, profileId);
    return { ok: true };
  }

  // LLM-assisted extraction: read a source's (table-preserved) text, ask the
  // LLM for rule records, store them as drafts for review.
  async extractRules(profileId, input = {}) {
    this.ensureProfile(profileId);
    const sourceIds = Array.isArray(input.sourceIds) && input.sourceIds.length
      ? input.sourceIds
      : all(this.db, "SELECT id FROM sources WHERE profile_id = ?", profileId).map((r) => r.id);
    if (typeof this.llm.complete !== "function") {
      throw Object.assign(new Error("현재 LLM 설정으로는 규칙 추출을 할 수 없습니다."), { statusCode: 400 });
    }

    const windows = [];
    for (const sourceId of sourceIds) {
      const text = this._sourceText(sourceId);
      for (let i = 0; i < text.length && windows.length < 12; i += 3500) {
        const slice = text.slice(i, i + 3500).trim();
        if (slice) windows.push({ sourceId, text: slice });
      }
    }

    const created = [];
    for (const window of windows) {
      let out = "";
      try {
        out = await this.llm.complete({ system: RULE_EXTRACTION_SYSTEM, user: window.text });
      } catch (error) {
        this.logger?.warn?.(`rule extraction failed: ${error.message}`);
        continue;
      }
      for (const record of parseRuleRecords(out)) {
        created.push(this.upsertRule(profileId, { ...record, sourceId: window.sourceId, status: "draft" }));
      }
    }
    return { created: created.length, rules: created };
  }

  _sourceText(sourceId) {
    const chunks = all(this.db, "SELECT text FROM chunks WHERE source_id = ? ORDER BY chunk_index ASC", sourceId);
    if (chunks.length) return chunks.map((c) => c.text).join("\n\n");
    const source = one(this.db, "SELECT pasted_text FROM sources WHERE id = ?", sourceId);
    return source?.pasted_text || "";
  }

  lint(profileId, text) {
    this.ensureProfile(profileId);
    const rules = this.listRules(profileId, { status: "approved" });
    return { violations: lintText(text, rules), ruleCount: rules.length };
  }

  // --- UX glossary (key-based term dictionary) -------------------------------
  // Terms are matched by exact normalized-key lookup (longest-match scan), so
  // "이 단어가 용어집에 있나 / 없나"를 결정론적으로 답한다. LLM 초안 추출은
  // rules와 같은 draft → confirm 검토 흐름을 따른다.

  listGlossary(profileId, { status, reviewStatus } = {}) {
    this.ensureProfile(profileId);
    let sql = "SELECT * FROM glossary_terms WHERE profile_id = ?";
    const params = [profileId];
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    if (reviewStatus) {
      sql += " AND review_status = ?";
      params.push(reviewStatus);
    }
    sql += " ORDER BY category ASC, term ASC";
    return all(this.db, sql, ...params).map(hydrateGlossaryTerm);
  }

  upsertGlossaryTerm(profileId, input = {}) {
    this.ensureProfile(profileId);
    const at = nowIso();
    const existing = input.id
      ? one(this.db, "SELECT * FROM glossary_terms WHERE id = ? AND profile_id = ?", input.id, profileId)
      : null;
    const base = existing ? hydrateGlossaryTerm(existing) : {};
    // Merge provided keys over the existing record so a partial PATCH (e.g.
    // { reviewStatus: "confirmed" }) never wipes the other fields.
    const fields = normalizeGlossaryInput({
      term: input.term ?? base.term,
      status: input.status ?? base.status,
      preferred: input.preferred ?? base.preferred,
      definition: input.definition ?? base.definition,
      category: input.category ?? base.category,
      aliases: input.aliases ?? base.aliases
    });
    if (!fields.term) throw Object.assign(new Error("term is required"), { statusCode: 400 });
    const reviewStatus =
      input.reviewStatus === "draft" || input.reviewStatus === "confirmed"
        ? input.reviewStatus
        : existing?.review_status || "confirmed";
    const normKey = normalizeTermKey(fields.term);

    if (existing) {
      run(
        this.db,
        `UPDATE glossary_terms SET term = ?, norm_key = ?, status = ?, preferred = ?, definition = ?, category = ?,
         aliases_json = ?, review_status = ?, updated_at = ? WHERE id = ? AND profile_id = ?`,
        fields.term, normKey, fields.status, fields.preferred, fields.definition, fields.category,
        JSON.stringify(fields.aliases), reviewStatus, at, input.id, profileId
      );
      return hydrateGlossaryTerm(one(this.db, "SELECT * FROM glossary_terms WHERE id = ?", input.id));
    }

    // New term: collapse duplicates onto the existing row for the same key.
    const dup = one(this.db, "SELECT * FROM glossary_terms WHERE profile_id = ? AND norm_key = ?", profileId, normKey);
    if (dup) return this.upsertGlossaryTerm(profileId, { ...input, id: dup.id });

    const termId = id("term");
    run(
      this.db,
      `INSERT INTO glossary_terms
       (id, profile_id, term, norm_key, status, preferred, definition, category, aliases_json, source_id, review_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      termId, profileId, fields.term, normKey, fields.status, fields.preferred, fields.definition,
      fields.category, JSON.stringify(fields.aliases), String(input.sourceId || ""), reviewStatus, at, at
    );
    return hydrateGlossaryTerm(one(this.db, "SELECT * FROM glossary_terms WHERE id = ?", termId));
  }

  deleteGlossaryTerm(profileId, termId) {
    this.ensureProfile(profileId);
    run(this.db, "DELETE FROM glossary_terms WHERE id = ? AND profile_id = ?", termId, profileId);
    return { ok: true };
  }

  // Deterministic word check: which glossary terms appear (and their verdicts),
  // and which Hangul content words are NOT in the glossary at all.
  checkGlossary(profileId, text) {
    this.ensureProfile(profileId);
    const terms = this.listGlossary(profileId, { reviewStatus: "confirmed" });
    return { ...checkText(text, terms), termCount: terms.length };
  }

  // LLM-assisted import: read glossary pages (one term per Confluence page),
  // ask the LLM for term records, store them as drafts for review.
  async extractGlossary(profileId, input = {}) {
    this.ensureProfile(profileId);
    const sourceIds = Array.isArray(input.sourceIds) && input.sourceIds.length
      ? input.sourceIds
      : all(this.db, "SELECT id FROM sources WHERE profile_id = ?", profileId).map((r) => r.id);
    if (typeof this.llm.complete !== "function") {
      throw Object.assign(new Error("현재 LLM 설정으로는 용어 추출을 할 수 없습니다."), { statusCode: 400 });
    }

    const windows = [];
    for (const sourceId of sourceIds) {
      const text = this._sourceText(sourceId);
      for (let i = 0; i < text.length && windows.length < 20; i += 3500) {
        const slice = text.slice(i, i + 3500).trim();
        if (slice) windows.push({ sourceId, text: slice });
      }
    }

    const created = [];
    for (const window of windows) {
      let out = "";
      try {
        out = await this.llm.complete({ system: GLOSSARY_EXTRACTION_SYSTEM, user: window.text });
      } catch (error) {
        this.logger?.warn?.(`glossary extraction failed: ${error.message}`);
        continue;
      }
      for (const record of parseGlossaryRecords(out)) {
        created.push(
          this.upsertGlossaryTerm(profileId, { ...record, sourceId: window.sourceId, reviewStatus: "draft" })
        );
      }
    }
    return { created: created.length, terms: created };
  }

  // --- Semantic concepts (의미·맥락 레이어) ---------------------------------
  // Canonical meaning + variant surface forms, linked to the chunks that
  // mention them. Retrieval interprets the query at the concept level first,
  // then reaches the original source through the links.

  listConcepts(profileId, { reviewStatus } = {}) {
    this.ensureProfile(profileId);
    const rows = reviewStatus
      ? all(this.db, "SELECT * FROM concepts WHERE profile_id = ? AND review_status = ? ORDER BY name ASC", profileId, reviewStatus)
      : all(this.db, "SELECT * FROM concepts WHERE profile_id = ? ORDER BY name ASC", profileId);
    return rows.map(hydrateConcept);
  }

  upsertConcept(profileId, input = {}, { skipRetag = false } = {}) {
    this.ensureProfile(profileId);
    const at = nowIso();
    const existing = input.id
      ? one(this.db, "SELECT * FROM concepts WHERE id = ? AND profile_id = ?", input.id, profileId)
      : null;
    const base = existing ? hydrateConcept(existing) : {};
    const fields = normalizeConceptInput({
      name: input.name ?? base.name,
      aliases: input.aliases ?? base.aliases,
      definition: input.definition ?? base.definition
    });
    if (!fields.name) throw Object.assign(new Error("name is required"), { statusCode: 400 });
    const reviewStatus =
      input.reviewStatus === "draft" || input.reviewStatus === "confirmed"
        ? input.reviewStatus
        : existing?.review_status || "confirmed";
    const normKey = normalizeTermKey(fields.name);

    let conceptId = existing?.id;
    if (existing) {
      run(
        this.db,
        "UPDATE concepts SET name = ?, norm_key = ?, aliases_json = ?, definition = ?, review_status = ?, updated_at = ? WHERE id = ? AND profile_id = ?",
        fields.name, normKey, JSON.stringify(fields.aliases), fields.definition, reviewStatus, at, existing.id, profileId
      );
    } else {
      // Same normalized name collapses onto the existing concept (merge aliases).
      const dup = one(this.db, "SELECT * FROM concepts WHERE profile_id = ? AND norm_key = ?", profileId, normKey);
      if (dup) {
        const merged = [...new Set([...hydrateConcept(dup).aliases, ...fields.aliases])];
        return this.upsertConcept(profileId, { ...input, id: dup.id, aliases: merged }, { skipRetag });
      }
      conceptId = id("concept");
      run(
        this.db,
        `INSERT INTO concepts (id, profile_id, name, norm_key, aliases_json, definition, source_id, review_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        conceptId, profileId, fields.name, normKey, JSON.stringify(fields.aliases), fields.definition,
        String(input.sourceId || ""), reviewStatus, at, at
      );
    }
    // Keep the chunk links in sync whenever a confirmed concept changes.
    // (Bulk callers pass skipRetag and run one retag at the end instead.)
    if (reviewStatus === "confirmed" && !skipRetag) this.retagConcepts(profileId);
    return hydrateConcept(one(this.db, "SELECT * FROM concepts WHERE id = ?", conceptId));
  }

  deleteConcept(profileId, conceptId) {
    this.ensureProfile(profileId);
    const row = one(this.db, "SELECT card_chunk_id FROM concepts WHERE id = ? AND profile_id = ?", conceptId, profileId);
    if (row?.card_chunk_id) run(this.db, "DELETE FROM chunks WHERE id = ?", row.card_chunk_id);
    run(this.db, "DELETE FROM concepts WHERE id = ? AND profile_id = ?", conceptId, profileId);
    return { ok: true };
  }

  // LLM-assisted extraction: find concepts (one meaning, many surface forms)
  // in the indexed sources. Default: drafts for review. autoConfirm skips the
  // review stop — extracted concepts are confirmed and linked in one pass.
  async extractConcepts(profileId, input = {}) {
    this.ensureProfile(profileId);
    const autoConfirm = Boolean(input.autoConfirm);
    const sourceIds = Array.isArray(input.sourceIds) && input.sourceIds.length
      ? input.sourceIds
      : all(this.db, "SELECT id FROM sources WHERE profile_id = ?", profileId).map((r) => r.id);
    if (typeof this.llm.complete !== "function") {
      throw Object.assign(new Error("현재 LLM 설정으로는 개념 추출을 할 수 없습니다."), { statusCode: 400 });
    }
    const windows = [];
    for (const sourceId of sourceIds) {
      const text = this._sourceText(sourceId);
      for (let i = 0; i < text.length && windows.length < 16; i += 3500) {
        const slice = text.slice(i, i + 3500).trim();
        if (slice) windows.push({ sourceId, text: slice });
      }
    }
    const created = [];
    for (const window of windows) {
      let out = "";
      try {
        out = await this.llm.complete({ system: CONCEPT_EXTRACTION_SYSTEM, user: window.text });
      } catch (error) {
        this.logger?.warn?.(`concept extraction failed: ${error.message}`);
        continue;
      }
      for (const record of parseConceptRecords(out)) {
        created.push(
          this.upsertConcept(
            profileId,
            { ...record, sourceId: window.sourceId, reviewStatus: autoConfirm ? "confirmed" : "draft" },
            { skipRetag: true } // one retag below instead of per-concept
          )
        );
      }
    }
    if (autoConfirm && created.length) this.retagConcepts(profileId);
    return { created: created.length, autoConfirmed: autoConfirm, concepts: created };
  }

  // Re-link every chunk in the profile to the confirmed concepts it mentions
  // (deterministic longest-match scan — no LLM). Called after concept changes
  // and after indexing, so the meaning layer always points at current sources.
  retagConcepts(profileId) {
    const concepts = this.listConcepts(profileId, { reviewStatus: "confirmed" });
    run(this.db, "DELETE FROM chunk_concepts WHERE profile_id = ?", profileId);
    if (!concepts.length) return { tagged: 0, concepts: 0 };
    const chunks = all(this.db, "SELECT id, text FROM chunks WHERE profile_id = ?", profileId);
    let tagged = 0;
    for (const chunk of chunks) {
      for (const { concept } of matchConcepts(chunk.text, concepts)) {
        run(
          this.db,
          "INSERT OR IGNORE INTO chunk_concepts (chunk_id, concept_id, profile_id) VALUES (?, ?, ?)",
          chunk.id, concept.id, profileId
        );
        tagged += 1;
      }
    }
    return { tagged, concepts: concepts.length };
  }

  // --- Concept cards (정리 레이어) -------------------------------------------
  // For one confirmed concept, gather its linked chunks ACROSS sources and ask
  // the LLM for a consolidated card: definition, conditions, triggers, phrasing
  // differences, and explicit source-vs-source conflicts. The card is stored on
  // the concept AND indexed as a retrievable chunk (linked back to the concept),
  // so questions hit the clean write-up first and drill down to the originals.

  async generateConceptCard(profileId, conceptId) {
    this.ensureProfile(profileId);
    const row = one(this.db, "SELECT * FROM concepts WHERE id = ? AND profile_id = ?", conceptId, profileId);
    if (!row) throw Object.assign(new Error("Concept not found"), { statusCode: 404 });
    const concept = hydrateConcept(row);
    if (concept.reviewStatus !== "confirmed") {
      throw Object.assign(new Error("확정된 개념만 카드를 만들 수 있습니다."), { statusCode: 400 });
    }
    if (typeof this.llm.complete !== "function") {
      throw Object.assign(new Error("현재 LLM 설정으로는 카드 생성을 할 수 없습니다."), { statusCode: 400 });
    }

    // Evidence = linked original chunks only (never other cards, never its own).
    const evidence = all(
      this.db,
      `SELECT chunks.id, chunks.text, sources.title
       FROM chunk_concepts
       JOIN chunks ON chunks.id = chunk_concepts.chunk_id
       JOIN sources ON sources.id = chunks.source_id
       WHERE chunk_concepts.concept_id = ? AND chunk_concepts.profile_id = ? AND sources.kind != 'concept-cards'
       ORDER BY sources.created_at ASC, chunks.chunk_index ASC
       LIMIT 12`,
      conceptId,
      profileId
    );
    if (!evidence.length) {
      throw Object.assign(new Error("이 개념과 링크된 원본 청크가 없습니다. 먼저 소스를 임베딩하세요."), { statusCode: 400 });
    }

    const cardMd = String(
      await this.llm.complete({ system: CONCEPT_CARD_SYSTEM, user: buildCardPrompt(concept, evidence) })
    ).trim();
    if (!cardMd) throw new Error("카드 생성 결과가 비어 있습니다.");

    // Re-index the card as a chunk under the per-profile system source.
    const cardSource = this._ensureCardSource(profileId);
    if (concept.cardChunkId) run(this.db, "DELETE FROM chunks WHERE id = ?", concept.cardChunkId);
    const [vector] = await this.embeddings.embed([`[개념 카드 · ${concept.name}]\n${cardMd}`], { mode: "passage" });
    const at = nowIso();
    const chunkId = id("chunk");
    run(
      this.db,
      `INSERT INTO chunks (id, profile_id, source_id, chunk_index, text, locator_json, embedding_json, folder_path, heading_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      chunkId, profileId, cardSource.id, 0, cardMd,
      JSON.stringify({ card: true, conceptId, concept: concept.name }),
      JSON.stringify(vector), "", `개념 카드 > ${concept.name}`, at
    );
    // Link the card chunk to its concept so the concept boost surfaces it first.
    run(this.db, "INSERT OR IGNORE INTO chunk_concepts (chunk_id, concept_id, profile_id) VALUES (?, ?, ?)", chunkId, conceptId, profileId);
    run(
      this.db,
      "UPDATE concepts SET card_md = ?, card_chunk_id = ?, card_updated_at = ?, updated_at = ? WHERE id = ?",
      cardMd, chunkId, at, at, conceptId
    );
    return hydrateConcept(one(this.db, "SELECT * FROM concepts WHERE id = ?", conceptId));
  }

  // Generate cards for all (or given) confirmed concepts as a background job —
  // one LLM call per concept, progress visible via the jobs API.
  async startCardJob(profileId, input = {}) {
    this.ensureProfile(profileId);
    const onlyIds = Array.isArray(input.conceptIds) && input.conceptIds.length ? new Set(input.conceptIds) : null;
    const targets = this.listConcepts(profileId, { reviewStatus: "confirmed" }).filter((c) => !onlyIds || onlyIds.has(c.id));
    const at = nowIso();
    const job = {
      id: id("job"), profile_id: profileId, type: "cards", status: "queued", message: "Queued",
      total_sources: targets.length, processed_sources: 0, failed_sources: 0, created_at: at, updated_at: at
    };
    run(
      this.db,
      `INSERT INTO jobs (id, profile_id, type, status, message, total_sources, processed_sources, failed_sources, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.id, job.profile_id, job.type, job.status, job.message,
      job.total_sources, job.processed_sources, job.failed_sources, job.created_at, job.updated_at
    );
    queueMicrotask(async () => {
      let processed = 0;
      let failed = 0;
      updateJob(this.db, job.id, { status: "running", message: "Building cards" });
      for (const concept of targets) {
        try {
          await this.generateConceptCard(profileId, concept.id);
        } catch (error) {
          this.logger?.warn?.(`card generation failed (${concept.name}): ${error.message}`);
          failed += 1;
        }
        processed += 1;
        updateJob(this.db, job.id, {
          status: "running", message: `Cards ${processed}/${targets.length}`,
          processed_sources: processed, failed_sources: failed
        });
      }
      updateJob(this.db, job.id, {
        status: failed ? "completed_with_errors" : "completed",
        message: failed ? `${failed} card(s) failed` : "Completed",
        processed_sources: processed, failed_sources: failed
      });
    });
    return job;
  }

  // One hidden-ish system source per profile that holds all concept cards, so
  // cards ride the normal chunk retrieval/citation machinery.
  _ensureCardSource(profileId) {
    const existing = one(this.db, "SELECT * FROM sources WHERE profile_id = ? AND kind = 'concept-cards'", profileId);
    if (existing) return existing;
    const at = nowIso();
    const source = {
      id: id("source"), profile_id: profileId, kind: "concept-cards", title: "🧠 개념 정리 카드",
      file_name: "", relative_path: "", mime_type: "text/markdown", file_path: "", pasted_text: "",
      status: "indexed", error: "", metadata_json: JSON.stringify({ system: "concept-cards" }),
      content_hash: "", created_at: at, updated_at: at, indexed_at: at
    };
    insertSource(this.db, source);
    return source;
  }

  // Integrated review: glossary word check + rule lint + style-guide retrieval,
  // all injected into one LLM pass that returns the corrected sentence.
  async review(profileId, input = {}) {
    const text = String(input.text || "").trim();
    if (!text) throw Object.assign(new Error("text is required"), { statusCode: 400 });

    const glossary = this.checkGlossary(profileId, text);
    const rules = this.listRules(profileId, { status: "approved" });
    const violations = rules.length ? lintText(text, rules) : [];

    // Style-guide grounding via the normal retrieval pipeline.
    const envelope = await this.buildContext(profileId, { ...input, query: text });
    const blocks = [buildGlossaryBlock(glossary), buildRuleBlock(violations, rules)].filter(Boolean);
    if (blocks.length) envelope.contextText = `${blocks.join("\n\n")}\n\n${envelope.contextText}`;

    const tGen = performance.now();
    const result = await this.llm.generate({
      query: text,
      envelope,
      system: REVIEW_SYSTEM
    });
    const answerMs = Math.round(performance.now() - tGen);

    return {
      profileId,
      text,
      answer: result.answer,
      terms: glossary.terms,
      missing: glossary.missing,
      violations,
      citations: envelope.citations,
      timings: { ...(envelope.timings || {}), answerMs },
      provider: result.provider
    };
  }

  // --- Feedback (self-improving memory) -------------------------------------
  // 👍/👎 on answers are stored with the query embedding, then recalled for
  // similar future questions and injected into the prompt. No model training.

  async addFeedback(profileId, input = {}) {
    this.ensureProfile(profileId);
    const query = String(input.query || "").trim();
    const rating = Number(input.rating) >= 0 ? 1 : -1;
    if (!query) throw Object.assign(new Error("query is required"), { statusCode: 400 });
    let embedding = [];
    try {
      [embedding] = await this.embeddings.embed([query], { mode: "query" });
    } catch (error) {
      this.logger?.warn?.(`feedback embed failed: ${error.message}`);
    }
    const at = nowIso();
    const row = {
      id: id("fb"),
      profile_id: profileId,
      chat_id: String(input.chatId || ""),
      rating,
      query,
      answer: String(input.answer || "").slice(0, 4000),
      note: String(input.note || "").slice(0, 2000),
      correction: String(input.correction || "").slice(0, 4000),
      mode: String(input.mode || ""),
      query_embedding_json: JSON.stringify(embedding || []),
      created_at: at
    };
    run(
      this.db,
      `INSERT INTO feedback (id, profile_id, chat_id, rating, query, answer, note, correction, mode, query_embedding_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.profile_id, row.chat_id, row.rating, row.query, row.answer, row.note, row.correction, row.mode,
      row.query_embedding_json, row.created_at
    );
    return hydrateFeedback(row);
  }

  listFeedback(profileId) {
    this.ensureProfile(profileId);
    return all(this.db, "SELECT * FROM feedback WHERE profile_id = ? ORDER BY created_at DESC", profileId).map(hydrateFeedback);
  }

  deleteFeedback(profileId, feedbackId) {
    this.ensureProfile(profileId);
    run(this.db, "DELETE FROM feedback WHERE id = ? AND profile_id = ?", feedbackId, profileId);
    return { ok: true };
  }

  // Find the most similar past feedback and render it as a guidance block.
  async recallFeedback(profileId, query) {
    if (process.env.RAG_FEEDBACK_MEMORY === "off") return { block: "", used: 0 };
    const rows = all(this.db, "SELECT * FROM feedback WHERE profile_id = ?", profileId);
    if (!rows.length) return { block: "", used: 0 };
    let queryVector;
    try {
      [queryVector] = await this.embeddings.embed([query], { mode: "query" });
    } catch {
      return { block: "", used: 0 };
    }
    const topK = Number(process.env.RAG_FEEDBACK_TOPK || 3);
    const minScore = Number(process.env.RAG_FEEDBACK_MIN_SCORE || 0.55);
    const scored = rows
      .map((row) => {
        const vector = safeJson(row.query_embedding_json);
        const score = Array.isArray(vector) && vector.length ? cosineSimilarity(queryVector, vector) : 0;
        return { row: hydrateFeedback(row), score };
      })
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    if (!scored.length) return { block: "", used: 0 };
    return { block: buildFeedbackBlock(scored.map((s) => s.row)), used: scored.length };
  }

  // Distinct indexed folder paths (with chunk counts) for drill-down/scoping UI.
  listFolders(profileId) {
    this.ensureProfile(profileId);
    return all(
      this.db,
      `SELECT folder_path AS path, COUNT(*) AS chunkCount
       FROM chunks
       WHERE profile_id = ? AND folder_path <> ''
       GROUP BY folder_path
       ORDER BY folder_path ASC`,
      profileId
    );
  }

  listSources(profileId) {
    this.ensureProfile(profileId);
    return all(this.db, "SELECT * FROM sources WHERE profile_id = ? ORDER BY created_at DESC", profileId).map((source) => this.sourceSnapshot(source));
  }

  // Row + live chunk count, as sent to the UI (list responses and SSE frames).
  sourceSnapshot(sourceOrId) {
    const source = typeof sourceOrId === "string"
      ? one(this.db, "SELECT * FROM sources WHERE id = ?", sourceOrId)
      : sourceOrId;
    if (!source) return null;
    return {
      ...source,
      chunkCount: one(this.db, "SELECT COUNT(*) AS count FROM chunks WHERE source_id = ?", source.id).count
    };
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
    let useTree = false;

    for await (const part of parts) {
      // A `useTree` form field toggles capturing the folder tree as a source.
      if (part.type === "field") {
        if (part.fieldname === "useTree") useTree = part.value === "true" || part.value === "1";
        continue;
      }
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
    if (useTree) {
      const tree = this._addTreeSource(profileId, created);
      if (tree) created.push(tree);
    }
    touchProfile(this.db, profileId);
    return created;
  }

  async addUrlSource(profileId, input) {
    this.ensureProfile(profileId);
    const url = String(input.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      throw Object.assign(new Error("유효한 http(s) URL이 필요합니다."), { statusCode: 400 });
    }

    // Fully automatic extraction: try progressively heavier methods and stop at
    // the first that yields usable text. No mid-flow choices for the user —
    // plain fetch → headless-browser render (for SSO/JS-only pages) → screenshot
    // + vision. Each failure is recorded so the final error can explain why.
    const minText = Number(process.env.RAG_URL_MIN_TEXT || 120);
    const reasons = [];
    let text = "";
    let title = "";
    let method = "";

    // 1) Plain fetch — fast path for static/public pages.
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; local-mini-rag)" },
        redirect: "follow",
        signal: AbortSignal.timeout(Number(process.env.RAG_URL_TIMEOUT_MS || 20_000))
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const extracted = htmlToText(await response.text());
      if (extracted.text && extracted.text.trim().length >= minText) {
        text = extracted.text;
        title = extracted.title;
        method = "fetch";
      } else {
        reasons.push(`일반 요청(fetch): 텍스트가 부족합니다 (${(extracted.text || "").trim().length}자) — 로그인/JS 렌더 페이지로 보입니다.`);
        if (!title) title = extracted.title;
      }
    } catch (error) {
      reasons.push(`일반 요청(fetch): ${error.message}`);
    }

    // 2) Headless-browser render — reaches SSO-gated / JS-rendered pages.
    if (text.trim().length < minText) {
      try {
        const browser = await extractUrlTextFromBrowser(url, { dataDir: this.dataDir });
        if (browser.text && browser.text.trim().length >= minText) {
          text = browser.text;
          title = browser.title || title;
          method = "browser";
        } else {
          reasons.push(`브라우저 렌더: 텍스트가 부족합니다 (${(browser.text || "").trim().length}자).`);
        }
      } catch (error) {
        reasons.push(`브라우저 렌더: ${error.message}`);
      }
    }

    // 3) Screenshot + vision — last resort for canvas/image-only pages. Only when
    // a vision model is configured; the model reconstructs text from the shot.
    const visionLlm = this.settingsStore?.get()?.llm || {};
    const hasVision = Boolean(visionLlm.visionModel || process.env.VISION_MODEL);
    if (text.trim().length < minText && hasVision) {
      try {
        const shot = await captureUrlScreenshot(url, { dataDir: this.dataDir });
        const md = await structureFromImage(shot.image, { llm: visionLlm });
        if (md && md.trim().length >= minText) {
          text = md;
          title = shot.title || title;
          method = "screenshot-vision";
        } else {
          reasons.push(`스크린샷+비전: 추출된 텍스트가 부족합니다 (${(md || "").trim().length}자).`);
        }
      } catch (error) {
        reasons.push(`스크린샷+비전: ${error.message}`);
      }
    } else if (text.trim().length < minText && !hasVision) {
      reasons.push("스크린샷+비전: 비전 모델이 설정되지 않아 건너뜀 (설정에서 비전 모델 지정 시 시도).");
    }

    if (text.trim().length < minText) {
      const err = new Error(
        `URL에서 내용을 자동으로 가져오지 못했습니다.\n\n시도한 방법:\n- ${reasons.join("\n- ")}\n\n` +
          `수동 방법: 브라우저에서 아래 링크를 직접 열어 본문을 복사한 뒤, "소스 추가 → 텍스트" 탭에 붙여넣으세요.\n${url}`
      );
      throw Object.assign(err, { statusCode: 502, reasons, url });
    }

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
      metadata_json: JSON.stringify({ input: "url", url, extractMethod: method }),
      content_hash: hashText(text),
      created_at: at,
      updated_at: at,
      indexed_at: ""
    };
    insertSource(this.db, source);
    touchProfile(this.db, profileId);
    return source;
  }

  async addPathSources(profileId, inputPath, { useTree = false } = {}) {
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
    if (useTree) {
      const tree = this._addTreeSource(profileId, created, stat.isDirectory() ? { rootPath: target } : {});
      if (tree) created.push(tree);
    }
    touchProfile(this.db, profileId);
    return created;
  }

  // Serialize a folder's tree into a Markdown source so the structure itself is
  // indexed and queryable ("어느 폴더에?", "구성 요약"). Skips flat (no-nesting)
  // uploads where a tree adds nothing.
  _addTreeSource(profileId, sources, options = {}) {
    const paths = sources.map((s) => s.relative_path).filter((p) => p && p.includes("/"));
    if (paths.length < 1) return null;
    const root = paths[0].split("/")[0] || "folder";
    const markdown = buildTreeMarkdown(root, paths);
    const at = nowIso();
    const source = {
      id: id("source"),
      profile_id: profileId,
      kind: "folder-tree",
      title: `📁 ${root} 구조`,
      file_name: "",
      relative_path: "",
      mime_type: "text/markdown",
      file_path: "",
      pasted_text: markdown,
      status: "pending",
      error: "",
      metadata_json: JSON.stringify({ input: "folder-tree", root, rootPath: options.rootPath || "", fileCount: paths.length }),
      content_hash: hashText(markdown),
      created_at: at,
      updated_at: at,
      indexed_at: ""
    };
    insertSource(this.db, source);
    return source;
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
        `INSERT INTO chunks (id, profile_id, source_id, chunk_index, text, locator_json, embedding_json, folder_path, heading_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id("chunk"),
        targetProfileId,
        newId,
        chunk.chunk_index,
        chunk.text,
        chunk.locator_json,
        chunk.embedding_json,
        chunk.folder_path || folderPathOf(copy.relative_path),
        chunk.heading_path || headingPathOf(chunk.locator_json),
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

  // --- Preprocessing agent (structure a source into reviewable Markdown) ----
  // Turns a messy/OCR'd source or a document screenshot into clean Markdown
  // BEFORE indexing. Runs as a background job like indexing; the result lands in
  // `sources.normalized_md` with status `review` for the user to check/edit.

  async startPreprocessJob(profileId, input = {}) {
    this.ensureProfile(profileId);
    const at = nowIso();
    const job = {
      id: id("job"),
      profile_id: profileId,
      type: "preprocess",
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
      job.id, job.profile_id, job.type, job.status, job.message,
      job.total_sources, job.processed_sources, job.failed_sources, job.created_at, job.updated_at
    );

    queueMicrotask(() => {
      this.runPreprocessJob(job.id, profileId, input).catch((error) => {
        this.logger?.error?.(error);
        updateJob(this.db, job.id, { status: "failed", message: error.message });
      });
    });
    return job;
  }

  async runPreprocessJob(jobId, profileId, input) {
    const onlySourceIds = Array.isArray(input.sourceIds) ? new Set(input.sourceIds) : null;
    const force = Boolean(input.force);
    // Auto-approve: index each source straight after structuring instead of
    // stopping at the `review` state (fully automatic mode).
    const autoIndex = Boolean(input.autoIndex);
    const candidates = all(this.db, "SELECT * FROM sources WHERE profile_id = ? ORDER BY created_at ASC", profileId).filter(
      (source) => !onlySourceIds || onlySourceIds.has(source.id)
    );

    updateJob(this.db, jobId, {
      status: "running",
      message: "Structuring",
      total_sources: candidates.length,
      processed_sources: 0,
      failed_sources: 0
    });

    let processed = 0;
    let failed = 0;
    for (const source of candidates) {
      try {
        const structured = await this.preprocessSource(source, { force });
        if (autoIndex && structured) await this.indexSource(structured);
        processed += 1;
      } catch (error) {
        failed += 1;
        processed += 1;
        run(
          this.db,
          "UPDATE sources SET status = ?, error = ?, updated_at = ? WHERE id = ?",
          "failed_with_action", error.message, nowIso(), source.id
        );
      }
      updateJob(this.db, jobId, {
        status: "running",
        message: `${autoIndex ? "Structured & indexed" : "Structured"} ${processed}/${candidates.length}`,
        processed_sources: processed,
        failed_sources: failed
      });
    }

    updateJob(this.db, jobId, {
      status: failed ? "completed_with_errors" : "completed",
      message: failed ? `${failed} source(s) need action` : "Completed",
      processed_sources: processed,
      failed_sources: failed
    });
    touchProfile(this.db, profileId);
  }

  async preprocessSource(source, { force = false } = {}) {
    // Skip untouched sources already structured for their current content.
    if (!force && String(source.normalized_md || "").trim() && source.preprocess_hash && source.preprocess_hash === source.content_hash) {
      return one(this.db, "SELECT * FROM sources WHERE id = ?", source.id);
    }

    run(this.db, "UPDATE sources SET status = ?, error = ?, updated_at = ? WHERE id = ?", "structuring", "", nowIso(), source.id);

    // Hybrid routing by source kind: images go to vision, PDFs go page-by-page
    // (vision for scanned pages, text for pages with a text layer), and
    // everything else has its extracted text restructured by the text LLM.
    const visionLlm = this.settingsStore?.get()?.llm || {};
    let markdown = "";
    if (source.kind === "image") {
      if (!source.file_path) throw new Error("이미지 파일 경로가 없습니다.");
      const dataUrl = await imageToDataUrl(source.file_path);
      markdown = await structureFromImage(dataUrl, { llm: visionLlm });
    } else if (source.kind === "pdf" && source.file_path) {
      markdown = await this._preprocessPdf(source, visionLlm);
    } else {
      // Text path: extract raw text (pasted or via the worker) then restructure.
      let text = String(source.pasted_text || "");
      if (!text.trim()) {
        const extracted = await this.worker.extract(source);
        if (extracted.status !== "ok") throw new Error(extracted.error || "Document extraction failed");
        text = (extracted.documents || []).map((doc) => doc.text).join("\n\n");
      }
      markdown = await structureFromText(text, { llm: this.llm });
    }

    if (!markdown.trim()) throw new Error("전처리 결과가 비어 있습니다.");
    const at = nowIso();
    run(
      this.db,
      "UPDATE sources SET normalized_md = ?, preprocessed_at = ?, preprocess_hash = ?, status = ?, error = ?, updated_at = ? WHERE id = ?",
      markdown, at, source.content_hash || "", "review", "", at, source.id
    );
    return one(this.db, "SELECT * FROM sources WHERE id = ?", source.id);
  }

  // Structure a PDF page-by-page: scanned pages are reconstructed from their
  // rendered image via vision; pages with a text layer are restructured as text.
  // Each page is prefixed with a heading so section context survives chunking.
  async _preprocessPdf(source, visionLlm) {
    const rendered = await this.worker.render(source);
    if (rendered.status !== "ok") throw new Error(rendered.error || "PDF 렌더링에 실패했습니다.");
    const parts = [];
    for (const page of rendered.pages || []) {
      let md = "";
      if (page.image) {
        md = await structureFromImage(page.image, { llm: visionLlm });
      } else if (String(page.text || "").trim()) {
        md = await structureFromText(page.text, { llm: this.llm });
      }
      if (md.trim()) parts.push(`<!-- page ${page.page} -->\n${md.trim()}`);
    }
    return parts.join("\n\n");
  }

  // Resolve a source to something openable: an on-disk file, an external URL, or
  // inline pasted text. Used by the "open original" (double-click) action.
  getSourceFile(profileId, sourceId) {
    this.ensureProfile(profileId);
    const source = one(this.db, "SELECT * FROM sources WHERE id = ? AND profile_id = ?", sourceId, profileId);
    if (!source) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
    const metadata = safeJson(source.metadata_json);
    const url = metadata?.url;
    if (source.kind === "url" && url) return { kind: "url", url };
    if (source.kind === "folder-tree" && metadata.rootPath && existsSync(metadata.rootPath)) {
      return { kind: "folder", folderPath: metadata.rootPath, text: source.pasted_text, fileName: `${source.title || "folder"}.md` };
    }
    if (source.file_path && existsSync(source.file_path)) {
      return {
        kind: "file",
        filePath: source.file_path,
        fileName: source.file_name || basename(source.file_path),
        mimeType: source.mime_type || mimeFromFileName(source.file_name || source.file_path)
      };
    }
    if (source.pasted_text) return { kind: "text", text: source.pasted_text, fileName: `${source.title || "source"}.txt` };
    throw Object.assign(new Error("열 수 있는 원본이 없습니다."), { statusCode: 404 });
  }

  // Readable content of a source for the double-click viewer: the reviewed
  // Markdown if present, else the indexed chunk text (covers xlsx/docx/pdf —
  // whatever the extractor produced), else the pasted text. Users see "what
  // this document actually says" without opening the original app.
  getSourceContent(profileId, sourceId) {
    this.ensureProfile(profileId);
    const source = one(this.db, "SELECT * FROM sources WHERE id = ? AND profile_id = ?", sourceId, profileId);
    if (!source) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
    let content = String(source.normalized_md || "").trim();
    let contentSource = content ? "normalized" : "";
    if (!content) {
      const chunks = all(this.db, "SELECT text FROM chunks WHERE source_id = ? ORDER BY chunk_index ASC", sourceId);
      if (chunks.length) {
        content = chunks.map((c) => c.text).join("\n\n");
        contentSource = "chunks";
      }
    }
    if (!content && source.pasted_text) {
      content = source.pasted_text;
      contentSource = "pasted";
    }
    return {
      id: source.id,
      title: source.title,
      kind: source.kind,
      relativePath: source.relative_path || "",
      status: source.status,
      content,
      contentSource: contentSource || "none",
      hasFile: Boolean(source.file_path && existsSync(source.file_path)),
      url: source.kind === "url" ? safeJson(source.metadata_json)?.url || "" : ""
    };
  }

  // Save a human-reviewed edit of a source's structured Markdown. Clearing it
  // (empty string) reverts the source to raw-extraction indexing.
  updateNormalized(profileId, sourceId, markdown) {
    this.ensureProfile(profileId);
    const source = one(this.db, "SELECT * FROM sources WHERE id = ? AND profile_id = ?", sourceId, profileId);
    if (!source) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
    const md = String(markdown ?? "");
    const at = nowIso();
    run(
      this.db,
      "UPDATE sources SET normalized_md = ?, preprocessed_at = ?, preprocess_hash = ?, status = ?, updated_at = ? WHERE id = ?",
      md, md.trim() ? at : "", md.trim() ? source.content_hash || "" : "", md.trim() ? "review" : "pending", at, sourceId
    );
    return one(this.db, "SELECT * FROM sources WHERE id = ?", sourceId);
  }

  // ── SSE event bus (live job/source progress) ──
  emitProfileEvent(profileId, payload) {
    this.events.emit(String(profileId), { profileId, ...payload, at: nowIso() });
  }

  // Per-source progress frame (phase: queued/extracting/embedding/indexed/failed)
  // so the source tree updates live during an index job without full reloads.
  emitSourceProgress(sourceId, extra = {}) {
    const source = this.sourceSnapshot(sourceId);
    if (!source) return;
    this.emitProfileEvent(source.profile_id, { type: "source", source, ...extra });
  }

  subscribeProfile(profileId, handler) {
    const key = String(profileId);
    this.events.on(key, handler);
    return () => this.events.off(key, handler);
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
    this.emitProfileEvent(profileId, {
      type: "job", jobId, jobType: "index", status: "running", message: "Indexing",
      totalSources: candidates.length, processedSources: 0, failedSources: 0
    });

    let processed = 0;
    let failed = 0;

    for (const source of candidates) {
      try {
        this.emitSourceProgress(source.id, { phase: "queued", jobId });
        await this.indexSource(source, { jobId });
        processed += 1;
        updateJob(this.db, jobId, {
          status: "running",
          message: `Indexed ${processed}/${candidates.length}`,
          processed_sources: processed,
          failed_sources: failed
        });
        this.emitProfileEvent(profileId, {
          type: "job", jobId, jobType: "index", status: "running",
          message: `Indexed ${processed}/${candidates.length}`,
          totalSources: candidates.length, processedSources: processed, failedSources: failed
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
        this.emitSourceProgress(source.id, { phase: "failed", jobId, error: error.message });
        updateJob(this.db, jobId, {
          status: "running",
          message: `Indexed ${processed}/${candidates.length}`,
          processed_sources: processed,
          failed_sources: failed
        });
        this.emitProfileEvent(profileId, {
          type: "job", jobId, jobType: "index", status: "running",
          message: `Indexed ${processed}/${candidates.length}`,
          totalSources: candidates.length, processedSources: processed, failedSources: failed
        });
      }
    }

    updateJob(this.db, jobId, {
      status: failed ? "completed_with_errors" : "completed",
      message: failed ? `${failed} source(s) need action` : "Completed",
      processed_sources: processed,
      failed_sources: failed
    });
    this.emitProfileEvent(profileId, {
      type: "job", jobId, jobType: "index",
      status: failed ? "completed_with_errors" : "completed",
      message: failed ? `${failed} source(s) need action` : "Completed",
      totalSources: candidates.length, processedSources: processed, failedSources: failed
    });
    touchProfile(this.db, profileId);
  }

  async indexSource(source, { jobId = "" } = {}) {
    run(this.db, "DELETE FROM chunks WHERE source_id = ?", source.id);
    run(this.db, "UPDATE sources SET status = ?, error = ?, updated_at = ? WHERE id = ?", "extracting", "", nowIso(), source.id);
    this.emitSourceProgress(source.id, { phase: "extracting", jobId });

    // Prefer the preprocessing agent's reviewed Markdown when present: skip the
    // raw extractor and chunk the clean, structure-preserving text instead.
    const normalized = String(source.normalized_md || "").trim();
    let documents;
    let warnings = [];
    if (normalized) {
      documents = [
        {
          text: normalized,
          locator: { relativePath: source.relative_path || "", format: "markdown" },
          metadata: { title: source.title || source.file_name || "source", sourceId: source.id, format: "markdown" }
        }
      ];
    } else {
      const extracted = await this.worker.extract(source);
      if (extracted.status !== "ok") {
        throw new Error(extracted.error || "Document extraction failed");
      }
      documents = extracted.documents || [];
      warnings = extracted.warnings || [];
    }

    const chunks = chunkDocuments(documents);
    if (!chunks.length) throw new Error("No indexable text extracted");

    run(this.db, "UPDATE sources SET status = ?, updated_at = ? WHERE id = ?", "embedding", nowIso(), source.id);
    this.emitSourceProgress(source.id, { phase: "embedding", jobId, chunkCount: chunks.length });
    // Contextual retrieval: embed each chunk together with a short header (source
    // title + locator/section) so short queries match the right document, but
    // store the original text so citations stay clean.
    const vectors = await this.embeddings.embed(
      chunks.map((chunk) => {
        const header = chunkHeader(source, chunk.locator);
        return header ? `[${header}]\n${chunk.text}` : chunk.text;
      }),
      { mode: "passage" }
    );

    const at = nowIso();
    const folderPath = folderPathOf(source.relative_path);
    // Confirmed concepts get linked to each new chunk they appear in, so the
    // meaning layer always points at the current source text.
    const confirmedConcepts = this.listConcepts(source.profile_id, { reviewStatus: "confirmed" });
    chunks.forEach((chunk, index) => {
      const chunkId = id("chunk");
      run(
        this.db,
        `INSERT INTO chunks (id, profile_id, source_id, chunk_index, text, locator_json, embedding_json, folder_path, heading_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        chunkId,
        source.profile_id,
        source.id,
        index,
        chunk.text,
        JSON.stringify({ ...chunk.locator, metadata: chunk.metadata }),
        JSON.stringify(vectors[index]),
        folderPath,
        typeof chunk.locator?.heading === "string" ? chunk.locator.heading : "",
        at
      );
      for (const { concept } of matchConcepts(chunk.text, confirmedConcepts)) {
        run(
          this.db,
          "INSERT OR IGNORE INTO chunk_concepts (chunk_id, concept_id, profile_id) VALUES (?, ?, ?)",
          chunkId, concept.id, source.profile_id
        );
      }
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
        warnings,
        preprocessed: Boolean(normalized),
        extractedUnits: documents.length,
        chunks: chunks.length
      }),
      source.id
    );
    this.emitSourceProgress(source.id, { phase: "indexed", jobId, chunkCount: chunks.length });
  }

  async search(profileId, input) {
    this.ensureProfile(profileId);
    let query = String(input.query || "").trim();
    if (!query) throw Object.assign(new Error("Query is required"), { statusCode: 400 });
    // Drill-down: an explicit `scope`, or a leading `folder:<path>` token in the
    // query, restricts retrieval to one folder subtree ("의미있게 찾아 들어가기").
    let scope = String(input.scope || "").trim().replace(/\/+$/, "");
    const scopeToken = /^\s*folder:("[^"]+"|\S+)\s+/i.exec(query);
    if (scopeToken) {
      scope = scopeToken[1].replace(/^"|"$/g, "").replace(/\/+$/, "");
      query = query.slice(scopeToken[0].length).trim();
    }
    if (!query) throw Object.assign(new Error("Query is required"), { statusCode: 400 });
    const topK = clamp(Number(input.topK || DEFAULT_TOP_K), 1, 30);
    // Relevance floor: below this combined score a hit is treated as noise and
    // dropped, so the LLM gets "no context" instead of unrelated chunks. 0 = off.
    const minScore = Number(input.minScore ?? process.env.RAG_MIN_SCORE ?? 0);

    // Meaning layer: interpret the query at the concept level, then (a) expand
    // the retrieval text with every variant surface form and (b) collect the
    // chunks linked to those concepts for a deterministic boost. This is what
    // lets "대기 중" reach a chunk that says "스탠바이".
    const confirmedConcepts = this.listConcepts(profileId, { reviewStatus: "confirmed" });
    const matchedConcepts = matchConcepts(query, confirmedConcepts);
    const retrievalQuery = expandQuery(query, matchedConcepts);
    const linkedCount = new Map();
    if (matchedConcepts.length) {
      const ids = matchedConcepts.map(({ concept }) => concept.id);
      const rows = all(
        this.db,
        `SELECT chunk_id, COUNT(*) AS n FROM chunk_concepts
         WHERE profile_id = ? AND concept_id IN (${ids.map(() => "?").join(",")})
         GROUP BY chunk_id`,
        profileId,
        ...ids
      );
      for (const row of rows) linkedCount.set(row.chunk_id, row.n);
    }

    const tEmbed = performance.now();
    const [queryVector] = await this.embeddings.embed([retrievalQuery], { mode: "query" });
    const embedMs = performance.now() - tEmbed;
    const tScore = performance.now();
    const chunks = all(
      this.db,
      `SELECT chunks.*, sources.title, sources.file_name, sources.relative_path, sources.kind
       FROM chunks
       JOIN sources ON sources.id = chunks.source_id
       WHERE chunks.profile_id = ?`,
      profileId
    );

    const inScope = (folder) => !scope || folder === scope || String(folder).startsWith(`${scope}/`);
    // Optional single/multi-source scoping (@Agent:source in the composer):
    // restrict retrieval to the given source ids. Absent → search all sources.
    const onlySources = Array.isArray(input.sourceIds) && input.sourceIds.length
      ? new Set(input.sourceIds.map(String))
      : null;

    const candidates = chunks.filter(
      (chunk) => inScope(chunk.folder_path || "") && (!onlySources || onlySources.has(String(chunk.source_id)))
    );
    // BM25 lexical scores over the in-scope candidate corpus (concept-expanded
    // query), normalized 0..1. This is a stronger keyword signal than a plain
    // token-presence ratio; it fills the same `keywordScore` slot in the blend
    // below, so concept/path/folder boosting is unchanged.
    const keywordScores = bm25Scores(retrievalQuery, candidates.map((chunk) => chunk.text));

    const scored = candidates
      .map((chunk, index) => {
        const vector = JSON.parse(chunk.embedding_json);
        const vectorScore = cosineSimilarity(queryVector, vector);
        // BM25 match against the concept-expanded query, so variant surface
        // forms in the chunk still count as keyword hits.
        const keywordScore = keywordScores[index] || 0;
        // Path boost: reward chunks whose folder/heading names echo the query,
        // so a well-categorised tree nudges the right section up. Empty paths
        // (plain text sources) contribute nothing, keeping legacy behaviour.
        const pathText = `${(chunk.folder_path || "").replace(/\//g, " ")} ${(chunk.heading_path || "").replace(/>/g, " ")}`.trim();
        const pathScore = pathText ? lexicalScore(query, pathText) : 0;
        // Concept boost: chunks linked to the concepts the query mentions.
        const conceptScore = matchedConcepts.length ? (linkedCount.get(chunk.id) || 0) / matchedConcepts.length : 0;
        const combined = vectorScore * 0.8 + keywordScore * 0.2 + pathScore * 0.15 + conceptScore * 0.25;
        return {
          id: chunk.id,
          sourceId: chunk.source_id,
          title: chunk.title,
          fileName: chunk.file_name,
          relativePath: chunk.relative_path,
          folderPath: chunk.folder_path || "",
          headingPath: chunk.heading_path || "",
          breadcrumb: breadcrumbOf(chunk),
          sourceKind: chunk.kind,
          text: chunk.text,
          locator: safeJson(chunk.locator_json),
          score: Number(combined.toFixed(6)),
          vectorScore: Number(vectorScore.toFixed(6)),
          keywordScore: Number(keywordScore.toFixed(6)),
          pathScore: Number(pathScore.toFixed(6)),
          conceptScore: Number(conceptScore.toFixed(6))
        };
      })
      .filter((hit) => hit.score > 0 && hit.score >= minScore)
      .sort((a, b) => b.score - a.score);
    const scoreMs = performance.now() - tScore;

    const rr = await this.maybeRerank(query, scored);
    const timings = {
      embedMs: Math.round(embedMs),
      scoreMs: Math.round(scoreMs),
      rerankMs: Math.round(rr.rerankMs),
      totalMs: Math.round(embedMs + scoreMs + rr.rerankMs),
      chunkCount: chunks.length,
      candidates: rr.candidates,
      reranker: rr.reranked ? this.reranker.backend : "none"
    };
    this.logger?.info?.({ msg: "retrieval", query: query.slice(0, 60), ...timings });

    return {
      profileId,
      query,
      scope: scope || "",
      topK,
      // Concept interpretation of the query (meaning layer), for the UI and
      // for the chat pass to inject as context.
      concepts: matchedConcepts.map(({ concept, surfaces }) => ({
        id: concept.id,
        name: concept.name,
        surfaces,
        aliases: concept.aliases,
        definition: concept.definition
      })),
      reranked: rr.reranked,
      timings,
      hits: diversify(rr.hits, topK)
    };
  }

  // Re-score the top embedding candidates with the precision reranker (if
  // configured). Falls back to the embedding order on any error so search
  // never fails because of the reranker. Returns { hits, reranked, rerankMs, candidates }.
  async maybeRerank(query, scored) {
    if (!this.reranker?.enabled || scored.length < 2) {
      return { hits: scored, reranked: false, rerankMs: 0, candidates: 0 };
    }
    const pool = scored.slice(0, this.reranker.candidates);
    const t0 = performance.now();
    try {
      const apiKey = this.settingsStore?.get()?.llm?.apiKey || process.env.LLM_API_KEY || "";
      const results = await this.reranker.rerank(query, pool.map((hit) => hit.text), { llm: this.llm, apiKey });
      const min = this.reranker.minScore;
      const rescored = results
        .filter((r) => pool[r.index])
        .map((r) => ({ ...pool[r.index], rerankScore: Number(r.score.toFixed(6)), score: Number(r.score.toFixed(6)) }))
        .filter((hit) => min == null || hit.score >= min)
        .sort((a, b) => b.score - a.score);
      const rerankMs = performance.now() - t0;
      // Keep embeddings if the reranker dropped everything (all below min) or
      // gave no signal at all (all zero — e.g. LLM returned an empty/garbled score).
      if (!rescored.length || rescored.every((hit) => hit.score === 0)) {
        return { hits: scored, reranked: false, rerankMs, candidates: pool.length };
      }
      return { hits: rescored, reranked: true, rerankMs, candidates: pool.length };
    } catch (error) {
      this.logger?.warn?.(`rerank failed, using embedding order: ${error.message}`);
      return { hits: scored, reranked: false, rerankMs: performance.now() - t0, candidates: pool.length };
    }
  }

  async buildContext(profileId, input) {
    const search = await this.search(profileId, input);
    const citations = search.hits.map((hit, index) => ({
      number: index + 1,
      chunkId: hit.id,
      sourceId: hit.sourceId,
      sourceKind: hit.sourceKind || "",
      title: hit.title,
      breadcrumb: hit.breadcrumb || "",
      folderPath: hit.folderPath || "",
      headingPath: hit.headingPath || "",
      locator: hit.locator,
      score: hit.score,
      excerpt: excerpt(hit.text),
      text: hit.text
    }));

    // Prefer the full breadcrumb (folder > document > section) as the citation
    // header so the LLM knows exactly where each passage sits in the hierarchy.
    const contextText = search.hits
      .map((hit, index) => {
        const label = hit.breadcrumb || `${hit.title}${formatLocator(hit.locator) ? ` (${formatLocator(hit.locator)})` : ""}`;
        return `[${index + 1}] ${label}\n${hit.text}`;
      })
      .join("\n\n");

    return {
      profileId,
      query: search.query,
      contextText,
      hits: search.hits,
      citations,
      concepts: search.concepts || [],
      timings: search.timings,
      sourceVersion: sourceVersion(this.db, profileId)
    };
  }

  async chat(profileId, input) {
    const query = String(input.query || "").trim();
    // Pasted images ride along as data URLs and are shown to the vision model
    // together with the prompt (not pre-OCR'd). A message may be image-only.
    const images = Array.isArray(input.images)
      ? input.images.filter((s) => typeof s === "string" && s.startsWith("data:"))
      : [];
    if (!query && !images.length) throw Object.assign(new Error("Query is required"), { statusCode: 400 });
    // Retrieval is driven by the text query; an image-only message skips it.
    const envelope = query
      ? await this.buildContext(profileId, input)
      : { profileId, query: "", contextText: "", hits: [], citations: [], timings: {}, sourceVersion: sourceVersion(this.db, profileId) };
    const mode =
      this.modeStore?.get(input.mode) ||
      this.modeStore?.get("general") ||
      this.modeStore?.list()[0] ||
      CHAT_MODES[CHAT_MODES[input.mode] ? input.mode : "general"];

    // Deterministic rule lint for guideline modes: prepend concrete violations
    // + rule principles to the context so the LLM grounds its ✅/⚠️ + rewrite.
    let violations = [];
    if (query && RULE_MODES.has(mode?.key)) {
      const rules = this.listRules(profileId, { status: "approved" });
      if (rules.length) {
        violations = lintText(query, rules);
        const block = buildRuleBlock(violations, rules);
        if (block) envelope.contextText = `${block}\n\n${envelope.contextText}`;
      }
    }

    // Meaning layer: tell the LLM what the user's words mean and which document
    // phrasings refer to the same concept, so it answers by meaning, not tokens.
    if (envelope.concepts?.length) {
      const block = buildConceptBlock(
        envelope.concepts.map((c) => ({ concept: c, surfaces: c.surfaces || [] }))
      );
      if (block) envelope.contextText = `${block}\n\n${envelope.contextText}`;
    }

    // Self-improving memory: prepend guidance recalled from similar past feedback.
    const memory = query ? await this.recallFeedback(profileId, query) : { block: "", used: 0 };
    if (memory.block) envelope.contextText = `${memory.block}\n\n${envelope.contextText}`;

    const tGen = performance.now();
    const result = await this.llm.generate({
      query,
      messages: input.messages || [],
      envelope,
      system: mode?.system,
      images
    });
    const answerMs = Math.round(performance.now() - tGen);
    const timings = { ...(envelope.timings || {}), answerMs };
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
      concepts: envelope.concepts || [],
      violations,
      usedFeedback: memory.used,
      timings,
      provider: result.provider,
      sourceVersion: envelope.sourceVersion,
      created_at: at
    };
  }
}

const RULE_MODES = new Set(["compliance", "recommend"]);

// System prompt for the integrated review pass (glossary + rules + style RAG).
const REVIEW_SYSTEM =
  "너는 삼성 가전 UX 라이팅 검수기다. 입력 문장을 컨텍스트의 스타일 가이드와 용어집 검수 결과에 따라 교정한다.\n" +
  "출력 형식:\n" +
  "1) 교정문: 한 줄로 완성된 최종 문장.\n" +
  "2) 이유: 적용한 가이드/용어 교체를 짧게 항목별로 (근거 번호 [n] 인용).\n" +
  "규칙: 비권장/금지 단어는 반드시 권장어로 교체하고, 미등록 후보는 승인어로 바꾸거나 등록 검토를 제안한다. 의미를 바꾸지 말고 창작하지 마라.";

function hydrateConcept(row) {
  if (!row) return null;
  let aliases = [];
  try {
    const parsed = JSON.parse(row.aliases_json || "[]");
    if (Array.isArray(parsed)) aliases = parsed;
  } catch {
    aliases = [];
  }
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    aliases,
    definition: row.definition,
    sourceId: row.source_id,
    reviewStatus: row.review_status,
    cardMd: row.card_md || "",
    cardChunkId: row.card_chunk_id || "",
    cardUpdatedAt: row.card_updated_at || "",
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function hydrateGlossaryTerm(row) {
  if (!row) return null;
  const aliases = (() => {
    try {
      const parsed = JSON.parse(row.aliases_json || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  return {
    id: row.id,
    profileId: row.profile_id,
    term: row.term,
    normKey: row.norm_key,
    status: row.status,
    preferred: row.preferred,
    definition: row.definition,
    category: row.category,
    aliases,
    sourceId: row.source_id,
    reviewStatus: row.review_status,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function hydrateFeedback(row) {
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    chatId: row.chat_id,
    rating: row.rating,
    query: row.query,
    answer: row.answer,
    note: row.note,
    correction: row.correction,
    mode: row.mode,
    created_at: row.created_at
  };
}

// Render recalled feedback as a guidance block prepended to the LLM context.
function buildFeedbackBlock(items) {
  const good = items.filter((f) => f.rating > 0);
  const bad = items.filter((f) => f.rating < 0);
  const lines = ["[사용자 피드백 학습 메모리 — 아래 교훈을 우선 반영하라]"];
  if (good.length) {
    lines.push("좋았던 답변(이 방향을 유지):");
    for (const f of good) {
      lines.push(`- 질문: ${clip(f.query, 120)}${f.note ? ` / 좋았던 점: ${clip(f.note, 160)}` : ""}`);
    }
  }
  if (bad.length) {
    lines.push("피해야 할 실수(반복하지 말 것):");
    for (const f of bad) {
      const fix = f.correction ? ` / 올바른 답: ${clip(f.correction, 240)}` : "";
      lines.push(`- 질문: ${clip(f.query, 120)}${f.note ? ` / 문제: ${clip(f.note, 160)}` : ""}${fix}`);
    }
  }
  return lines.join("\n");
}

function clip(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function hydrateRule(row) {
  if (!row) return null;
  const asArray = (value) => {
    const parsed = safeJson(value);
    return Array.isArray(parsed) ? parsed : [];
  };
  return {
    id: row.id,
    profileId: row.profile_id,
    sourceId: row.source_id,
    section: row.section,
    principle: row.principle,
    terms: asArray(row.terms_json),
    prefer: asArray(row.prefer_json),
    pairs: asArray(row.pairs_json),
    note: row.note,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
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

// Build an indented Markdown tree from a set of "root/dir/file" paths. Folders
// get a trailing slash; entries are sorted with directories before files.
export function buildTreeMarkdown(root, paths) {
  const tree = {};
  for (const path of paths) {
    let node = tree;
    for (const part of String(path).split("/")) {
      if (!part) continue;
      node[part] = node[part] || {};
      node = node[part];
    }
  }
  const lines = [`# 폴더 구조: ${root}`, ""];
  const walk = (node, depth) => {
    const names = Object.keys(node).sort((a, b) => {
      const aDir = Object.keys(node[a]).length > 0;
      const bDir = Object.keys(node[b]).length > 0;
      if (aDir !== bDir) return aDir ? -1 : 1; // directories first
      return a.localeCompare(b);
    });
    for (const name of names) {
      const isDir = Object.keys(node[name]).length > 0;
      lines.push(`${"  ".repeat(depth)}- ${name}${isDir ? "/" : ""}`);
      walk(node[name], depth + 1);
    }
  };
  walk(tree, 0);
  return lines.join("\n");
}

export function htmlToText(html) {
  let s = String(html || "").replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ");
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
  // Convert tables to labeled rows BEFORE stripping tags, so structured guides
  // (추천 ↔ 피해야 할 말 등) keep their column pairing in one line/chunk.
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (table) => `\n\n${tableToText(table)}\n\n`);
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

// Turn an HTML <table> into readable rows. With a header row (or short
// label-like first row) each cell becomes "헤더: 값", otherwise cells are
// joined with " · ". Keeps recommend/avoid pairs together for retrieval.
function tableToText(tableHtml) {
  const rows = [...String(tableHtml).matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    .map((match) => {
      const cells = [...match[0].matchAll(/<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => cleanCell(c[2]));
      return { cells, hasTh: /<th\b/i.test(match[0]) };
    })
    .filter((row) => row.cells.some(Boolean));
  if (!rows.length) return "";

  const first = rows[0];
  const useHeader = first.hasTh || (rows.length > 1 && first.cells.every((c) => c && c.length <= 12));
  const headers = useHeader ? first.cells : null;
  const body = headers ? rows.slice(1) : rows;

  const lines = body.map((row) => {
    if (headers) {
      return row.cells
        .map((cell, i) => (headers[i] ? `${headers[i]}: ${cell}` : cell))
        .filter(Boolean)
        .join(" · ");
    }
    return row.cells.filter(Boolean).join(" · ");
  });
  return lines.filter(Boolean).join("\n");
}

function cleanCell(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
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

const MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

function mimeFromFileName(fileName) {
  return MIME_BY_EXT[extname(String(fileName || "")).toLowerCase()] || "application/octet-stream";
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

// Human-readable location trail: folder segments > document > section headings,
// e.g. "계약서 > 2024 > 벤더계약.md > 해지 조항". Shown on citations.
function breadcrumbOf(chunk) {
  const crumbs = [];
  if (chunk.folder_path) crumbs.push(...String(chunk.folder_path).split("/"));
  const doc = chunk.file_name || chunk.title;
  if (doc) crumbs.push(doc);
  if (chunk.heading_path) crumbs.push(...String(chunk.heading_path).split(" > "));
  return crumbs.filter(Boolean).join(" > ");
}

// Directory portion of a source's relative path ("계약서/2024/파일.md" -> "계약서/2024").
function folderPathOf(relativePath) {
  const p = String(relativePath || "");
  const cut = p.lastIndexOf("/");
  return cut > 0 ? p.slice(0, cut) : "";
}

// Heading path stored on a chunk's locator JSON ("대제목 > 소제목"), or "".
function headingPathOf(locatorJson) {
  const loc = safeJson(locatorJson);
  return typeof loc.heading === "string" ? loc.heading : "";
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

// Short "source · location" header prepended to a chunk's embed text so that
// short queries retrieve from the right document/section (contextual chunking).
function chunkHeader(source, locator = {}) {
  const title = source.title || source.file_name || "";
  const parts = [];
  if (title) parts.push(title);
  if (locator.relativePath && locator.relativePath !== title) parts.push(locator.relativePath);
  if (locator.page) parts.push(`p.${locator.page}`);
  if (locator.slide) parts.push(`slide ${locator.slide}`);
  if (locator.sheet) parts.push(`sheet ${locator.sheet}`);
  if (locator.heading) parts.push(String(locator.heading));
  return parts.filter(Boolean).join(" · ");
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) {
    throw Object.assign(new Error("유효한 http(s) 서버 주소가 필요합니다."), { statusCode: 400 });
  }
  return raw.replace(/\/+$/, "");
}
