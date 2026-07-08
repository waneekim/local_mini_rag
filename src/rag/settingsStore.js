import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PRESET = "기본";

export class SettingsStore {
  constructor(dataDir) {
    this.path = join(dataDir, "settings.json");
    this._data = this._migrate(this._load());
  }

  _load() {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return {};
    }
  }

  // Accept both the new preset shape and the old flat { llm, embedding } shape.
  _migrate(raw) {
    if (raw && raw.presets && typeof raw.presets === "object") {
      return { activePreset: raw.activePreset || "", presets: raw.presets };
    }
    if (raw && (raw.llm || raw.embedding)) {
      return {
        activePreset: DEFAULT_PRESET,
        presets: { [DEFAULT_PRESET]: { llm: raw.llm || {}, embedding: raw.embedding || {} } }
      };
    }
    return { activePreset: "", presets: {} };
  }

  _persist() {
    writeFileSync(this.path, JSON.stringify(this._data, null, 2), "utf8");
  }

  _activeName() {
    if (this._data.activePreset && this._data.presets[this._data.activePreset]) return this._data.activePreset;
    return Object.keys(this._data.presets)[0] || "";
  }

  // Merge a stored preset with env-derived defaults. Empty values fall back.
  _effective(stored = {}) {
    const llm = stored.llm || {};
    const emb = stored.embedding || {};
    // Gauss (Samsung internal OpenAPI) is a chat-only provider with its own
    // base URL / model env vars and token credentials; every other provider
    // uses the standard OpenAI-compatible vars.
    const provider = llm.provider ?? process.env.LLM_PROVIDER ?? "openai-compatible";
    const isGauss = provider === "gauss-openapi";
    const embUrl = emb.url ?? process.env.EMBEDDINGS_URL ?? "";
    return {
      llm: {
        provider,
        baseUrl: llm.baseUrl ?? (isGauss ? process.env.GAUSS_BASE_URL : process.env.LLM_BASE_URL) ?? "",
        model: llm.model ?? (isGauss ? process.env.GAUSS_MODEL_ID : process.env.LLM_MODEL) ?? "",
        visionModel: llm.visionModel ?? process.env.VISION_MODEL ?? "",
        apiKey: llm.apiKey ?? process.env.LLM_API_KEY ?? "",
        gaussClientToken: llm.gaussClientToken ?? process.env.GAUSS_CLIENT_TOKEN ?? "",
        gaussOpenapiToken: llm.gaussOpenapiToken ?? process.env.GAUSS_OPENAPI_TOKEN ?? "",
        gaussUserEmail: llm.gaussUserEmail ?? process.env.GAUSS_USER_EMAIL ?? ""
      },
      embedding: {
        backend: emb.backend ?? process.env.RAG_EMBEDDING_BACKEND ?? (embUrl ? "http" : "local-ngram"),
        url: embUrl,
        model:
          emb.model ?? process.env.EMBEDDINGS_MODEL ?? process.env.RAG_EMBEDDING_MODEL ?? "intfloat/multilingual-e5-small",
        // dimensions is optional; an explicitly stored value (including null = "auto") wins,
        // env default only applies when the preset never set it.
        dimensions: "dimensions" in emb ? emb.dimensions : Number(process.env.RAG_EMBEDDING_DIMENSIONS) || null,
        apiKey: emb.apiKey ?? process.env.EMBEDDINGS_API_KEY ?? process.env.LLM_API_KEY ?? ""
      }
    };
  }

  // Effective config of the active preset — consumed by RagService.
  get() {
    return this._effective(this._data.presets[this._activeName()]);
  }

  // Full state for the settings UI (all presets resolved, plus which is active).
  state() {
    const names = Object.keys(this._data.presets);
    if (!names.length) {
      return { activePreset: DEFAULT_PRESET, presets: { [DEFAULT_PRESET]: this._effective({}) } };
    }
    const presets = {};
    for (const name of names) presets[name] = this._effective(this._data.presets[name]);
    return { activePreset: this._activeName(), presets };
  }

  savePreset(name, patch = {}) {
    const key = String(name || "").trim() || DEFAULT_PRESET;
    const current = this._data.presets[key] || {};
    this._data.presets[key] = {
      llm: { ...(current.llm || {}), ...(patch.llm || {}) },
      embedding: { ...(current.embedding || {}), ...(patch.embedding || {}) }
    };
    this._data.activePreset = key;
    this._persist();
    return this.get();
  }

  selectPreset(name) {
    if (this._data.presets[name]) {
      this._data.activePreset = name;
      this._persist();
    }
    return this.get();
  }

  deletePreset(name) {
    delete this._data.presets[name];
    if (this._data.activePreset === name) {
      this._data.activePreset = Object.keys(this._data.presets)[0] || "";
    }
    this._persist();
    return this.get();
  }
}
