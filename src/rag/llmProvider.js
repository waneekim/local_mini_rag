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
  compliance: {
    label: "규율",
    aliases: ["규율", "규격", "검수", "compliance", "check"],
    hint: "입력한 UX 문구·UI가 가이드 규격에 맞는지 검수하고 위반 항목을 짚어줍니다.",
    system:
      "You are a UX writing and UI compliance reviewer. The user gives you UX copy or a UI description to check. " +
      "Compare it against the guideline rules found in the provided context. " +
      "Respond as a checklist: for each point output '✅ 준수' or '⚠️ 위반', quote the exact rule and cite it with [n], " +
      "then briefly explain the gap and suggest a compliant rewrite. " +
      "If a relevant rule is not present in the context, state that explicitly rather than inventing one. " +
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
    this.provider =
      options.provider ||
      process.env.LLM_PROVIDER ||
      (options.baseUrl || process.env.LLM_BASE_URL ? "openai-compatible" : "mock");
    // Gauss (Samsung internal OpenAPI) is a chat-only provider with its own base
    // URL / model env vars; every other provider uses the standard OpenAI vars.
    const isGauss = this.provider === "gauss-openapi";
    this.baseUrl = options.baseUrl || (isGauss ? process.env.GAUSS_BASE_URL : process.env.LLM_BASE_URL) || "";
    this.apiKey = options.apiKey || process.env.LLM_API_KEY || "";
    this.model = options.model || (isGauss ? process.env.GAUSS_MODEL_ID : process.env.LLM_MODEL) || "";
    // Vision-capable model id, used when a chat message carries images.
    this.visionModel = options.visionModel || process.env.VISION_MODEL || "";
    this.fetchFn = options.fetchFn || globalThis.fetch;
    // Cap output length to bound worst-case latency. 0 = unlimited.
    const defaultMaxTokens = isGauss
      ? (process.env.GAUSS_MAX_TOKENS ?? process.env.LLM_MAX_TOKENS ?? 512)
      : (process.env.LLM_MAX_TOKENS ?? 1024);
    this.maxTokens = Number(options.maxTokens ?? defaultMaxTokens);
    // Extra top-level fields merged into the chat request body — mirrors the
    // OpenAI client's `extra_body`. e.g. vLLM's {"chat_template_kwargs":{"enable_thinking":false}}.
    this.extraBody = parseJsonObject(options.extraBody ?? process.env.LLM_EXTRA_BODY);
    // Gauss OpenAPI credentials + latency guardrails. Gauss has tight input
    // limits, so system/context/history/content are clipped by char count.
    this.gaussClientToken = options.gaussClientToken || process.env.GAUSS_CLIENT_TOKEN || "";
    this.gaussOpenapiToken = options.gaussOpenapiToken || process.env.GAUSS_OPENAPI_TOKEN || "";
    this.gaussUserEmail = options.gaussUserEmail || process.env.GAUSS_USER_EMAIL || "";
    this.gaussLlmConfig = parseJsonObject(options.gaussLlmConfig ?? process.env.GAUSS_LLM_CONFIG);
    this.gaussStream = parseBoolean(options.gaussStream ?? process.env.GAUSS_STREAM, true);
    this.gaussUseSystemPrompt = parseBoolean(options.gaussUseSystemPrompt ?? process.env.GAUSS_USE_SYSTEM_PROMPT, false);
    this.gaussSystemMaxChars = positiveNumber(options.gaussSystemMaxChars ?? process.env.GAUSS_SYSTEM_MAX_CHARS, 6000);
    this.gaussContextMaxChars = positiveNumber(options.gaussContextMaxChars ?? process.env.GAUSS_CONTEXT_MAX_CHARS, 9000);
    this.gaussHistoryMaxChars = positiveNumber(options.gaussHistoryMaxChars ?? process.env.GAUSS_HISTORY_MAX_CHARS, 4000);
    this.gaussContentMaxChars = positiveNumber(options.gaussContentMaxChars ?? process.env.GAUSS_CONTENT_MAX_CHARS, 18000);
  }

  describe() {
    return {
      provider: this.provider,
      model: this.model || "not-configured",
      baseUrl: this.baseUrl ? redactUrl(this.baseUrl) : ""
    };
  }

  // Plain system+user completion (no RAG envelope). Used by the LLM reranker.
  // Returns the assistant text, or "" for the mock/unconfigured provider.
  async complete({ system, user, temperature = 0, maxTokens = 0, extraBody, timeoutMs } = {}) {
    if (this.provider === "gauss-openapi") {
      return this._gaussChat({
        systemPrompt: clipEndText(system || "", this.gaussSystemMaxChars, "\n\n[...system instructions truncated for Gauss...]\n"),
        contents: [clipMiddleText(String(user || ""), this.gaussContentMaxChars, "\n\n[...content truncated for Gauss...]\n")],
        temperature,
        maxTokens: Number(maxTokens || this.maxTokens || 0),
        timeoutMs
      });
    }
    if (this.provider !== "openai-compatible" || !this.baseUrl || !this.model) return "";
    // Optional per-call output budget / timeout / extra body — used by the
    // preprocessing agent to scale token budget with document length. Omitted
    // (0/undefined) reproduces the previous behaviour, so the reranker is unaffected.
    const tokenLimit = Number(maxTokens || 0);
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.model,
        temperature,
        ...(tokenLimit > 0 ? { max_tokens: tokenLimit } : {}),
        ...this.extraBody,
        ...(extraBody !== undefined ? parseJsonObject(extraBody) : {}),
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: user }
        ]
      }),
      ...(Number(timeoutMs) > 0 ? { signal: AbortSignal.timeout(Number(timeoutMs)) } : {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || payload.error || `LLM HTTP ${response.status}`);
    return payload.choices?.[0]?.message?.content?.trim() || "";
  }

  async generate({ query, messages = [], envelope, system, images = [] }) {
    if (this.provider === "mock") return this.mockGenerate({ query, envelope });
    if (this.provider === "gauss-openapi") {
      if (Array.isArray(images) && images.length > 0) {
        throw new Error("Gauss OpenAPI provider is chat-only; image and vision requests are not supported.");
      }
      const originalSystem = String(system || DEFAULT_SYSTEM);
      const originalContext = String(envelope?.contextText || "");
      const contextText = clipEndText(originalContext || "(no context)", this.gaussContextMaxChars, "\n\n[...local context truncated for Gauss...]\n");
      const history = gaussHistoryContents(messages)
        .map((item) => clipMiddleText(item, this.gaussHistoryMaxChars, "\n\n[...chat history truncated for Gauss...]\n"))
        .filter(Boolean);
      const userText = "Local RAG context:\n" + contextText + "\n\nQuestion:\n" + (query || "");
      const answer = await this._gaussChat({
        systemPrompt: clipEndText(originalSystem, this.gaussSystemMaxChars, "\n\n[...system instructions truncated for Gauss...]\n"),
        contents: [...history, userText],
        temperature: 0.2,
        maxTokens: this.maxTokens
      });
      return {
        answer,
        provider: this.describe(),
        raw: {
          mode: "gauss-openapi",
          inputStats: { systemChars: originalSystem.length, contextChars: originalContext.length, historyItems: history.length }
        }
      };
    }
    if (this.provider !== "openai-compatible") throw new Error(`Unsupported LLM provider: ${this.provider}`);
    if (!this.baseUrl || !this.model) {
      throw new Error("LLM_BASE_URL and LLM_MODEL are required for openai-compatible provider");
    }

    // When the message carries pasted images, send them as image_url parts so a
    // vision model sees them alongside the prompt (no pre-OCR), and prefer the
    // configured vision model id if one is set.
    const hasImages = Array.isArray(images) && images.length > 0;
    const userText = `Local RAG context:\n${envelope.contextText || "(no context)"}\n\nQuestion:\n${query || "(첨부한 이미지를 보고 답하세요)"}`;
    const userContent = hasImages
      ? [{ type: "text", text: userText }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))]
      : userText;
    const model = hasImages && this.visionModel ? this.visionModel : this.model;

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        ...(this.maxTokens > 0 ? { max_tokens: this.maxTokens } : {}),
        ...this.extraBody,
        messages: [
          {
            role: "system",
            content: system || DEFAULT_SYSTEM
          },
          {
            role: "user",
            content: userContent
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

  // Gauss OpenAPI chat call. Streams (SSE) when gaussStream is on and collects
  // the chunks into a single answer string. Applies char-count clipping so the
  // request stays under Gauss's input limits, and times out defensively.
  async _gaussChat({ systemPrompt = "", contents = [], temperature = 0.2, maxTokens = 0, timeoutMs } = {}) {
    this._assertGaussConfig();
    if (!this.fetchFn) throw new Error("fetch is not available in this Node runtime");

    const safeSystemPrompt = clipEndText(systemPrompt, this.gaussSystemMaxChars, "\n\n[...system instructions truncated for Gauss...]\n");
    const normalizedContents = contents
      .map((value) => clipMiddleText(String(value || "").trim(), this.gaussContentMaxChars, "\n\n[...content truncated for Gauss...]\n"))
      .filter(Boolean);
    if (!normalizedContents.length) normalizedContents.push("");
    const requestContents = this.gaussUseSystemPrompt || !safeSystemPrompt
      ? normalizedContents
      : ["Instruction:\n" + safeSystemPrompt + "\n\n" + normalizedContents[0], ...normalizedContents.slice(1)];
    const finalContents = requestContents.map((value) => clipMiddleText(value, this.gaussContentMaxChars, "\n\n[...content truncated for Gauss...]\n"));

    const timeoutValue = Number(timeoutMs || process.env.GAUSS_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || 240_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutValue);

    try {
      const response = await this.fetchFn(gaussMessagesUrl(this.baseUrl), {
        method: "POST",
        headers: { ...gaussHeaders(this), "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          modelIds: [this.model],
          contents: finalContents,
          isStream: this.gaussStream,
          llmConfig: gaussLlmConfig({ base: this.gaussLlmConfig, temperature, maxTokens }),
          ...(this.gaussUseSystemPrompt && safeSystemPrompt ? { systemPrompt: safeSystemPrompt } : {})
        })
      });

      const bodyText = await readResponseText(response);
      const payload = parseMaybeJson(bodyText);
      if (!response.ok) {
        throw new Error(gaussErrorMessage(payload ?? bodyText, "Gauss HTTP " + response.status));
      }
      return extractGaussAnswer(payload ?? bodyText).trim();
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Gauss request timed out after " + timeoutValue + "ms");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  _assertGaussConfig() {
    const missing = [];
    if (!this.baseUrl) missing.push("baseUrl");
    if (!this.model) missing.push("model");
    if (!this.gaussClientToken) missing.push("gaussClientToken");
    if (!this.gaussOpenapiToken) missing.push("gaussOpenapiToken");
    if (!this.gaussUserEmail) missing.push("gaussUserEmail");
    if (missing.length) {
      throw new Error("Missing Gauss OpenAPI setting(s): " + missing.join(", "));
    }
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

// Parse a JSON object from config; ignore anything that isn't a plain object.
export function parseJsonObject(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ── Gauss OpenAPI helpers (ported from the company build; used only by the
// gauss-openapi provider branch above and by /api/settings/gauss/models) ──

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clipEndText(value, maxChars, marker = "\n\n[...truncated...]\n") {
  const text = String(value || "");
  const limit = Number(maxChars || 0);
  if (!limit || text.length <= limit) return text;
  if (limit <= marker.length) return text.slice(0, limit);
  return text.slice(0, limit - marker.length) + marker;
}

function clipMiddleText(value, maxChars, marker = "\n\n[...truncated...]\n") {
  const text = String(value || "");
  const limit = Number(maxChars || 0);
  if (!limit || text.length <= limit) return text;
  if (limit <= marker.length) return text.slice(0, limit);
  const keep = limit - marker.length;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

function gaussHistoryContents(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const role = String(message?.role || "user").toLowerCase() === "assistant" ? "Assistant" : "User";
      const content = String(message?.content || "").trim();
      return content ? role + ": " + content : "";
    })
    .filter(Boolean);
}

function gaussLlmConfig({ base = {}, temperature = 0.2, maxTokens = 0 } = {}) {
  const config = {
    max_new_tokens: Number(maxTokens) > 0 ? Number(maxTokens) : undefined,
    seed: null,
    top_k: 5,
    top_p: 0.94,
    temperature,
    repetition_penalty: 1.04,
    ...parseJsonObject(base)
  };
  if (Number(maxTokens) > 0) config.max_new_tokens = Number(maxTokens);
  if (temperature !== undefined && temperature !== null) config.temperature = temperature;
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

export function gaussMessagesUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/openapi\/chat\/v1\/messages$/i.test(trimmed)) return trimmed;
  if (/\/openapi\/chat\/v1$/i.test(trimmed)) return trimmed + "/messages";
  return trimmed + "/openapi/chat/v1/messages";
}

export function gaussModelsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/openapi\/chat\/v1\/models$/i.test(trimmed)) return trimmed;
  if (/\/openapi\/chat\/v1$/i.test(trimmed)) return trimmed + "/models";
  return trimmed + "/openapi/chat/v1/models";
}

export function gaussHeaders(config = {}) {
  const headers = { accept: "application/json" };
  if (config.gaussClientToken) headers["x-generative-ai-client"] = config.gaussClientToken;
  if (config.gaussOpenapiToken) headers["x-openapi-token"] = normalizeBearer(config.gaussOpenapiToken);
  if (config.gaussUserEmail) headers["x-generative-ai-user-email"] = config.gaussUserEmail;
  return headers;
}

export function extractGaussModels(payload) {
  const list = firstArray(payload, ["data", "models", "items", "result", "results"]) || (Array.isArray(payload) ? payload : []);
  return list.map(normalizeGaussModel).filter((item) => item?.id);
}

export function extractGaussModelIds(payload) {
  return extractGaussModels(payload).map((model) => model.id);
}

function normalizeGaussModel(item) {
  if (typeof item === "string" || typeof item === "number") {
    const id = cleanModelText(item);
    return id ? { id, name: "" } : null;
  }
  if (!item || typeof item !== "object") return null;

  const idKeys = ["id", "modelId", "model_id", "uuid", "key", "code"];
  const nameKeys = ["name", "label", "displayName", "display_name", "modelName", "model_name", "title"];
  const idCandidates = collectStringsByKeys(item, idKeys);
  const allCandidates = collectStrings(item);
  const id = pickModelId(idCandidates) || pickModelId(allCandidates);
  if (!id) return null;

  const nameCandidates = collectStringsByKeys(item, nameKeys)
    .filter((value) => value !== id && !looksLikeUuid(value) && !looksLikeLocaleCode(value));
  const fallbackNames = allCandidates
    .filter((value) => value !== id && !looksLikeUuid(value) && !looksLikeLocaleCode(value) && !idCandidates.includes(value));
  const name = cleanModelText(nameCandidates[0] || fallbackNames[0] || "");
  return { id, name };
}

function collectStringsByKeys(value, keys) {
  if (!value || typeof value !== "object") return [];
  const out = [];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectStrings(value[key], out);
  }
  return uniqueStrings(out);
}

function collectStrings(value, out = []) {
  const cleaned = cleanModelText(value);
  if (cleaned) {
    out.push(cleaned);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) collectStrings(nested, out);
  }
  return out;
}

function pickModelId(values = []) {
  const list = uniqueStrings(values);
  return list.find(looksLikeUuid) || list[0] || "";
}

function cleanModelText(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value || "").trim();
  if (!text || /^\[object Object\](,\[object Object\])*$/i.test(text)) return "";
  return text;
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.map(cleanModelText).filter(Boolean)));
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function looksLikeLocaleCode(value) {
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(String(value || ""));
}

function firstArray(payload, keys) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return null;
}

function normalizeBearer(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  return /^Bearer\s+/i.test(token) ? token : "Bearer " + token;
}

async function readResponseText(response) {
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += typeof value === "string" ? value : decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      if (text) return text;
      throw error;
    }
  }
  if (typeof response?.text === "function") return response.text();
  if (typeof response?.json === "function") return JSON.stringify(await response.json());
  return "";
}

function parseMaybeJson(text) {
  const value = String(text || "").trim();
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractGaussAnswer(value) {
  if (typeof value === "string") {
    const sse = extractGaussAnswerFromSse(value);
    return sse || value;
  }
  return extractGaussAnswerFromObject(value);
}

function extractGaussAnswerFromSse(text) {
  let chunks = "";
  let full = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const payload = parseMaybeJson(data);
    if (!payload) {
      chunks += data;
      continue;
    }
    const chunk = gaussChunkContent(payload);
    if (chunk) chunks += chunk;
    const extracted = extractGaussAnswerFromObject(payload);
    if (extracted) full = extracted;
  }
  return chunks || full;
}

function gaussChunkContent(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (payload.event_status === "CHUNK" || payload.status === "CHUNK") {
    return String(payload.content || payload.answer || payload.text || "");
  }
  return "";
}

function extractGaussAnswerFromObject(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) return payload.map(extractGaussAnswerFromObject).filter(Boolean).join("");
  if (typeof payload !== "object") return "";

  const directKeys = ["content", "answer", "text", "output", "response"];
  for (const key of directKeys) {
    if (typeof payload[key] === "string" && payload[key]) return payload[key];
  }

  if (payload.message) {
    if (typeof payload.message === "string") return payload.message;
    const message = extractGaussAnswerFromObject(payload.message);
    if (message) return message;
  }
  if (Array.isArray(payload.actions)) {
    const actions = payload.actions.map(extractGaussAnswerFromObject).filter(Boolean).join("");
    if (actions) return actions;
  }
  if (payload.data) {
    const data = extractGaussAnswerFromObject(payload.data);
    if (data) return data;
  }
  if (payload.result) {
    const result = extractGaussAnswerFromObject(payload.result);
    if (result) return result;
  }
  return "";
}

function gaussErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") return String(payload || fallback);
  return payload.error?.message || payload.message || payload.error || payload.detail || fallback;
}
