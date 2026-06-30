export class LlmProvider {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.LLM_BASE_URL || "";
    this.apiKey = options.apiKey || process.env.LLM_API_KEY || "";
    this.model = options.model || process.env.LLM_MODEL || "";
    this.provider = options.provider || process.env.LLM_PROVIDER || (this.baseUrl ? "openai-compatible" : "mock");
  }

  describe() {
    return {
      provider: this.provider,
      model: this.model || "not-configured",
      baseUrl: this.baseUrl ? redactUrl(this.baseUrl) : ""
    };
  }

  async generate({ query, messages = [], envelope }) {
    if (this.provider === "mock") return this.mockGenerate({ query, envelope });
    if (this.provider !== "openai-compatible") throw new Error(`Unsupported LLM provider: ${this.provider}`);
    if (!this.baseUrl || !this.model) {
      throw new Error("LLM_BASE_URL and LLM_MODEL are required for openai-compatible provider");
    }

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You answer using only the provided local RAG context. If the context is insufficient, say you do not know. Cite sources with bracket numbers like [1]."
          },
          {
            role: "user",
            content: `Local RAG context:\n${envelope.contextText || "(no context)"}\n\nQuestion:\n${query}`
          },
          ...messages
        ]
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || payload.error || `LLM HTTP ${response.status}`);
    }

    return {
      answer: payload.choices?.[0]?.message?.content?.trim() || "",
      provider: this.describe(),
      raw: {
        id: payload.id,
        usage: payload.usage
      }
    };
  }

  mockGenerate({ query, envelope }) {
    const citations = envelope.citations || [];
    if (!citations.length) {
      return {
        answer: "검색된 근거가 없어 답변할 수 없습니다.",
        provider: this.describe(),
        raw: { mode: "mock", query }
      };
    }
    const preview = citations
      .slice(0, 3)
      .map((citation) => `[${citation.number}] ${citation.excerpt}`)
      .join("\n");
    return {
      answer: `LLM_BASE_URL이 설정되지 않아 로컬 mock 답변을 반환합니다.\n\n관련 근거:\n${preview}`,
      provider: this.describe(),
      raw: { mode: "mock", query }
    };
  }
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "configured";
  }
}
