// Reranker: takes the embedding-retrieved candidate pool and re-scores each
// (query, passage) pair with a precision model, then the caller keeps the best.
//
// Two backends:
//   http  — Cohere/Jina/vLLM/llama.cpp-compatible POST {model, query, documents} → results[].relevance_score
//           (RERANK_STYLE=tei switches the body to TEI's {query, texts} shape)
//   llm   — reuse the configured chat LLM to score candidates (no extra server)
// Off by default: set RERANK_URL (http) or RAG_RERANK=llm to enable.

const RATE_PROMPT =
  "You score how well each passage answers the user's query. " +
  'Return ONLY a JSON array like [{"i":0,"score":0.9}], score in 0..1, one entry per passage, no prose.';

export class RerankService {
  constructor(options = {}) {
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.url = options.url || process.env.RERANK_URL || "";
    this.model = options.model || process.env.RERANK_MODEL || "";
    this.apiKey = options.apiKey || process.env.RERANK_API_KEY || "";
    this.backend = options.backend || process.env.RAG_RERANK || (this.url ? "http" : "none");
    // Request body dialect: "cohere" (default — model/query/documents/top_n, used by
    // Cohere, Jina, vLLM, llama.cpp) or "tei" (HuggingFace TEI — query/texts).
    this.style = String(options.style || process.env.RERANK_STYLE || "cohere").toLowerCase();
    // How many top embedding candidates to rerank per query.
    this.candidates = Number(options.candidates || process.env.RAG_RERANK_CANDIDATES || 24);
    const envMin = process.env.RAG_RERANK_MIN_SCORE;
    this.minScore = options.minScore ?? (envMin !== undefined && envMin !== "" ? Number(envMin) : null);
  }

  get enabled() {
    return this.backend === "http" || this.backend === "llm";
  }

  describe() {
    return { backend: this.backend, model: this.model || "", candidates: this.candidates, style: this.style };
  }

  // docs: string[]. Returns [{ index, score }] for every input doc (unsorted).
  async rerank(query, docs, options = {}) {
    if (!Array.isArray(docs) || !docs.length) return [];
    if (this.backend === "http") return this._rerankHttp(query, docs, options);
    if (this.backend === "llm") return this._rerankLlm(query, docs, options);
    return docs.map((_, index) => ({ index, score: 0 }));
  }

  async _rerankHttp(query, docs, options) {
    if (!this.fetchFn) throw new Error("fetch is not available in this Node runtime");
    const apiKey = this.apiKey || options.apiKey || "";
    const response = await this.fetchFn(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(
        this.style === "tei"
          ? { query, texts: docs } // TEI: {query, texts} → top-level [{index, score}]
          : { model: this.model || undefined, query, documents: docs, top_n: docs.length }
      ),
      signal: AbortSignal.timeout(Number(process.env.RERANK_TIMEOUT_MS || 30_000))
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || payload.error || `Rerank HTTP ${response.status}`);
    }
    return normalizeRerankPayload(payload, docs.length);
  }

  async _rerankLlm(query, docs, options) {
    const llm = options.llm;
    if (!llm || typeof llm.complete !== "function") {
      // No usable LLM handle — leave order unchanged.
      return docs.map((_, index) => ({ index, score: 0 }));
    }
    const list = docs.map((doc, i) => `[${i}] ${String(doc).replace(/\s+/g, " ").slice(0, 500)}`).join("\n");
    const content = await llm.complete({
      system: RATE_PROMPT,
      user: `Query: ${query}\n\nPassages:\n${list}`
    });
    const scores = parseScores(content, docs.length);
    return docs.map((_, index) => ({ index, score: scores[index] ?? 0 }));
  }
}

function normalizeRerankPayload(payload, count) {
  // Accepted shapes: {results:[…]} (Cohere/vLLM/llama.cpp), {data:[…]} (some
  // OpenAI-style proxies), or a bare top-level array (HuggingFace TEI).
  const rows = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];
  if (!rows.length) return Array.from({ length: count }, (_, index) => ({ index, score: 0 }));
  return rows
    .map((row) => ({
      index: Number(row.index ?? row.i ?? 0),
      score: Number(row.relevance_score ?? row.score ?? row.relevanceScore ?? 0)
    }))
    .filter((row) => Number.isFinite(row.index) && row.index >= 0 && row.index < count);
}

function parseScores(text, count) {
  const scores = new Array(count).fill(0);
  const raw = String(text || "");
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      for (const item of arr) {
        const i = Number(item.i ?? item.index);
        const s = Number(item.score ?? item.relevance ?? 0);
        if (Number.isInteger(i) && i >= 0 && i < count) scores[i] = s;
      }
      return scores;
    } catch {
      // fall through to regex
    }
  }
  // Fallback: pull "i: score" pairs out of loose text.
  const re = /\[?(\d+)\]?[^0-9]{0,6}(0?\.\d+|1(?:\.0+)?)/g;
  let m;
  while ((m = re.exec(raw))) {
    const i = Number(m[1]);
    if (i >= 0 && i < count) scores[i] = Number(m[2]);
  }
  return scores;
}
