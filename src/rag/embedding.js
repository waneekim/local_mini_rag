import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DIMENSIONS = 384;

export class EmbeddingService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    const venvPython = join(this.projectRoot, ".venv", "bin", "python");
    this.pythonCommand = options.pythonCommand || process.env.PYTHON || (existsSync(venvPython) ? venvPython : "python3");
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.embeddingsUrl = options.embeddingsUrl || process.env.EMBEDDINGS_URL || "";
    // dimensions only matters for local-ngram (vector length). For http it's display-only.
    this.configuredDimensions = options.dimensions ?? null;
    this.dimensions = Number(options.dimensions || process.env.RAG_EMBEDDING_DIMENSIONS || DEFAULT_DIMENSIONS);
    this.apiKey = options.apiKey || process.env.EMBEDDINGS_API_KEY || process.env.LLM_API_KEY || "";
    this.backend = options.backend || process.env.RAG_EMBEDDING_BACKEND || (this.embeddingsUrl ? "http" : "local-ngram");
    this.model = options.model || process.env.EMBEDDINGS_MODEL || process.env.RAG_EMBEDDING_MODEL || "intfloat/multilingual-e5-small";
    // Asymmetric retrieval prompts. Instruction-aware models (Qwen3-Embedding,
    // e5-instruct) expect an instruction on the QUERY only; documents stay raw.
    // e5/bge use fixed "query:"/"passage:" prefixes on both sides. Explicit env
    // wins; otherwise we pick a sensible default from the model name.
    const style = defaultPromptStyle(this.model);
    this.queryInstruction = firstDefined(options.queryInstruction, process.env.RAG_EMBED_QUERY_INSTRUCTION, style.queryInstruction);
    this.queryPrefix = firstDefined(options.queryPrefix, process.env.RAG_EMBED_QUERY_PREFIX, style.queryPrefix);
    this.passagePrefix = firstDefined(options.passagePrefix, process.env.RAG_EMBED_PASSAGE_PREFIX, style.passagePrefix);
  }

  // Apply the query/passage prompt for instruction-aware or prefix-based models.
  // Only used for the http backend; local-ngram and python-e5 handle mode themselves.
  formatForEmbedding(texts, mode) {
    if (mode === "query") {
      if (this.queryInstruction) return texts.map((t) => `Instruct: ${this.queryInstruction}\nQuery: ${t}`);
      if (this.queryPrefix) return texts.map((t) => `${this.queryPrefix}${t}`);
    } else if (this.passagePrefix) {
      return texts.map((t) => `${this.passagePrefix}${t}`);
    }
    return texts;
  }

  describe() {
    return {
      backend: this.backend,
      model: this.model,
      dimensions: this.backend === "http" ? this.configuredDimensions ?? "auto" : this.dimensions,
      queryPrompt: this.queryInstruction ? "instruction" : this.queryPrefix ? "prefix" : "none",
      url: this.embeddingsUrl ? redactUrl(this.embeddingsUrl) : "",
      note:
        this.backend === "local-ngram"
          ? "offline local n-gram embeddings; set EMBEDDINGS_URL or RAG_EMBEDDING_BACKEND=python-e5 to use another backend"
          : this.backend === "http"
            ? "OpenAI-compatible embeddings endpoint"
            : "external worker backend"
    };
  }

  async embed(texts, options = {}) {
    if (!Array.isArray(texts)) throw new Error("embed() expects an array");
    if (this.backend === "http") {
      return this.embedWithHttp(this.formatForEmbedding(texts, options.mode || "passage"));
    }
    if (this.backend === "python-e5") {
      return this.embedWithPython(texts, options.mode || "passage");
    }
    if (this.backend !== "local-ngram") throw new Error(`Unsupported embedding backend '${this.backend}'`);
    return texts.map((text) => localNgramEmbedding(text, this.dimensions));
  }

  async embedWithPython(texts, mode) {
    const payload = JSON.stringify({
      model: this.model,
      texts,
      mode
    });

    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonCommand, [join(this.projectRoot, "workers", "embed.py")], {
        cwd: this.projectRoot,
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Embedding worker timed out"));
      }, Number(process.env.RAG_EMBEDDING_TIMEOUT_MS || 240_000));

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Embedding worker exited with code ${code}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          if (result.status !== "ok") reject(new Error(result.error || "Embedding worker failed"));
          else resolve(result.embeddings);
        } catch (error) {
          reject(new Error(`Invalid embedding worker JSON: ${error.message}`));
        }
      });

      child.stdin.end(payload);
    });
  }

  async embedWithHttp(texts) {
    if (!this.embeddingsUrl) throw new Error("EMBEDDINGS_URL is required for http embedding backend");
    if (!this.fetchFn) throw new Error("fetch is not available in this Node runtime");

    const response = await this.fetchFn(this.embeddingsUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.model,
        input: texts
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || payload.error || `Embeddings HTTP ${response.status}`);
    }

    const embeddings = normalizeEmbeddingsPayload(payload);
    if (embeddings.length !== texts.length) {
      throw new Error(`Embeddings response count ${embeddings.length} did not match input count ${texts.length}`);
    }
    return embeddings;
  }
}

// Default query/passage prompting inferred from the embedding model name.
// Qwen3-Embedding & e5-instruct: instruction on the query only (documents raw),
// so this is backward compatible with passages already embedded without a prompt.
// Plain e5 / bge-style prefixes are left off by default to avoid invalidating
// existing document vectors; set RAG_EMBED_*_PREFIX explicitly + re-index to use them.
export function defaultPromptStyle(model) {
  const name = String(model || "").toLowerCase();
  const empty = { queryInstruction: "", queryPrefix: "", passagePrefix: "" };
  if (/qwen3.*emb|qwen3-embedding/.test(name)) {
    return { ...empty, queryInstruction: "Given a search query, retrieve relevant passages that answer the query" };
  }
  if (/e5.*instruct|instruct.*e5/.test(name)) {
    return { ...empty, queryInstruction: "Given a search query, retrieve relevant passages that answer the query" };
  }
  return empty;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return "";
}

export function localNgramEmbedding(text, dimensions = DEFAULT_DIMENSIONS) {
  const vector = new Array(dimensions).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const h = fnv1a(token);
    const index = h % dimensions;
    const sign = h & 1 ? 1 : -1;
    vector[index] += sign * weightForToken(token);
  }
  return normalize(vector);
}

export function tokenize(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  const words = normalized.split(" ").filter(Boolean);
  const grams = [];
  for (const word of words) {
    grams.push(word);
    const chars = [...word];
    for (let size = 2; size <= 4; size += 1) {
      if (chars.length < size) continue;
      for (let i = 0; i <= chars.length - size; i += 1) {
        grams.push(chars.slice(i, i + size).join(""));
      }
    }
  }
  return grams;
}

function weightForToken(token) {
  if (token.length <= 1) return 0.4;
  if (token.length === 2) return 0.7;
  return 1;
}

function normalize(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return vector.map((value) => Number((value / magnitude).toFixed(8)));
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeEmbeddingsPayload(payload) {
  if (Array.isArray(payload?.data)) {
    return payload.data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => item.embedding);
  }
  if (Array.isArray(payload?.embeddings)) return payload.embeddings;
  if (Array.isArray(payload?.embedding)) return [payload.embedding];
  throw new Error("Embeddings response must contain data[].embedding or embeddings");
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "configured";
  }
}
