import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DIMENSIONS = 384;

export class EmbeddingService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    const venvPython = join(this.projectRoot, ".venv", "bin", "python");
    this.pythonCommand = options.pythonCommand || process.env.PYTHON || (existsSync(venvPython) ? venvPython : "python3");
    this.dimensions = Number(process.env.RAG_EMBEDDING_DIMENSIONS || options.dimensions || DEFAULT_DIMENSIONS);
    this.backend = process.env.RAG_EMBEDDING_BACKEND || options.backend || "local-ngram";
    this.model = process.env.RAG_EMBEDDING_MODEL || options.model || "intfloat/multilingual-e5-small";
  }

  describe() {
    return {
      backend: this.backend,
      model: this.model,
      dimensions: this.dimensions,
      note:
        this.backend === "local-ngram"
          ? "offline local n-gram embeddings; set RAG_EMBEDDING_BACKEND=python-e5 to enforce a model worker"
          : "external worker backend"
    };
  }

  async embed(texts, options = {}) {
    if (!Array.isArray(texts)) throw new Error("embed() expects an array");
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
