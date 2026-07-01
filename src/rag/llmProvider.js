const LANG_NOTE = "Answer in the same language as the user (Korean if the user writes Korean).";

export const CHAT_MODES = {
  general: {
    label: "일반",
    aliases: ["일반", "표준", "general", "chat"],
    hint: "자유롭게 대화합니다. 관련 문서가 있으면 근거로 활용합니다.",
    system:
      "You are a helpful assistant. Converse naturally and helpfully with the user. " +
      "If the provided local context is relevant, use it and cite sources with bracket numbers like [1]; " +
      "otherwise answer from your general knowledge without forcing citations. " +
      LANG_NOTE
  },
  search: {
    label: "검색",
    aliases: ["검색", "search", "find"],
    hint: "문서에서 관련 내용을 찾아 근거와 함께 답합니다.",
    system:
      "You are a retrieval assistant working over the user's local RAG context. " +
      "Answer the question using ONLY the provided context, and cite every claim with bracket numbers like [1]. " +
      "If the context is insufficient, say so plainly instead of guessing. " +
      LANG_NOTE
  },
  recommend: {
    label: "추천",
    aliases: ["추천", "가이드", "recommend", "guide"],
    hint: "가이드에 근거해 적절한 UI/UX 패턴이나 문구를 추천합니다.",
    system:
      "You are a UX/UI guidance advisor. Based ONLY on the guideline context provided, recommend the most appropriate " +
      "UI pattern, component, or copy for the user's situation. Give concrete, actionable recommendations with a short rationale, " +
      "and cite the supporting guideline with [n]. Offer 1-3 options when reasonable. " +
      "If the guidelines do not cover it, say so. " +
      LANG_NOTE
  },
  figmaAudit: {
    label: "규율",
    aliases: ["규율", "규격", "검수", "피그마", "figma", "figma-audit", "figmaAudit", "화면검수", "문구검수", "용어검수"],
    hint: "Figma 화면의 문구·용어가 규격에 맞는지 확인하고 올바른 단어와 문장을 추천합니다.",
    system:
      "You are a Figma UX writing and product-language reviewer. The user provides selected Figma nodes, visible text, " +
      "and optional design metadata. Check whether each word or sentence follows the terminology and writing rules in " +
      "the provided local RAG context. Use ONLY the provided context as rule evidence. " +
      "For a single input sentence, answer in this exact concise Korean format:\n" +
      "올바른 문장: <corrected full sentence>\n" +
      "근거: <why the original should change, citing the relevant guideline with [n]>\n" +
      "추천 표현:\n- <candidate sentence> [n] · 유사도 <NN%> · <brief reason>\n" +
      "For multiple Figma text items, repeat the same fields under '항목: <node name or text>'. " +
      "Always rewrite the whole sentence, not only the changed word. If the original is already compliant, write " +
      "the original full sentence and cite the supporting rule if available. If no relevant guideline exists, say " +
      "'근거: 관련 규칙 없음' and do not invent a rule. Always include 추천 표현, even when there is no good candidate. " +
      LANG_NOTE
  },
  analyze: {
    label: "분석",
    aliases: ["분석", "analyze", "analysis"],
    hint: "제공된 자료를 구조적으로 분석해 강점·문제·개선점을 정리합니다.",
    system:
      "You are a UX analyst. Analyze the user's material/question in depth using the provided context. " +
      "Structure your answer into sections: 요약, 강점, 문제점/리스크, 개선 제안. Cite evidence from the context with [n]. " +
      LANG_NOTE
  }
};

const DEFAULT_SYSTEM = CHAT_MODES.general.system;

export class LlmProvider {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.LLM_BASE_URL || "";
    this.apiKey = options.apiKey || process.env.LLM_API_KEY || "";
    this.model = options.model || process.env.LLM_MODEL || "";
    this.provider = options.provider || process.env.LLM_PROVIDER || (this.baseUrl ? "openai-compatible" : "mock");
    // Cap output length to bound worst-case latency. 0 = unlimited.
    this.maxTokens = Number(options.maxTokens ?? process.env.LLM_MAX_TOKENS ?? 1024);
  }

  describe() {
    return {
      provider: this.provider,
      model: this.model || "not-configured",
      baseUrl: this.baseUrl ? redactUrl(this.baseUrl) : ""
    };
  }

  async generate({ query, messages = [], envelope, system, temperature = 0.2 }) {
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
        temperature,
        ...(this.maxTokens > 0 ? { max_tokens: this.maxTokens } : {}),
        messages: [
          {
            role: "system",
            content: system || DEFAULT_SYSTEM
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
