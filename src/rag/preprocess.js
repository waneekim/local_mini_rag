import { readFile } from "node:fs/promises";
import { parseJsonObject } from "./llmProvider.js";

// Structuring agent: turn a messy/OCR'd source — or a document screenshot — into
// clean Markdown that faithfully reproduces the document's structure (headings,
// lists, tables) BEFORE it is chunked. Restructuring only: the model must never
// invent, summarize, translate, or drop content, because this text becomes the
// grounding evidence for retrieval. The output is held for human review.
const STRUCTURE_SYSTEM =
  "You are a document structuring engine. Convert the given document into clean " +
  "GitHub-Flavored Markdown that faithfully reproduces its structure:\n" +
  "- Use #, ##, ### for the title and section/subsection headings.\n" +
  "- Use - or 1. for lists, and | ... | tables (with a |---| separator row) for tabular data.\n" +
  "- Keep every recommend/avoid or label/value pair together in the same table row.\n" +
  "RULES: Preserve ALL text exactly as written. Do NOT translate, summarize, omit, " +
  "reorder meaning, or invent anything. If a part has no structure, keep it as plain " +
  "paragraphs. Output ONLY the Markdown — no code fences, no commentary.";

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff"
};

// Restructure a document screenshot into Markdown via an OpenAI-compatible
// vision chat endpoint. Reuses the active preset's LLM base URL / API key and
// the configured vision model id.
export async function structureFromImage(dataUrl, { llm } = {}) {
  const image = String(dataUrl || "").trim();
  if (!image) throw Object.assign(new Error("이미지가 없습니다."), { statusCode: 400 });
  const baseUrl = llm?.baseUrl || process.env.LLM_BASE_URL || "";
  const apiKey = llm?.apiKey || process.env.LLM_API_KEY || "";
  const model = llm?.visionModel || process.env.VISION_MODEL || "";
  if (!baseUrl) throw Object.assign(new Error("LLM 서버 URL이 설정되지 않았습니다."), { statusCode: 400 });
  if (!model) {
    throw Object.assign(
      new Error("비전 모델이 설정되지 않았습니다. 설정에서 비전 모델을 입력하고 VL 모델을 로드하세요."),
      { statusCode: 400 }
    );
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      ...(preprocessImageMaxTokens() > 0 ? { max_tokens: preprocessImageMaxTokens() } : {}),
      ...preprocessExtraBody(llm),
      messages: [
        { role: "system", content: STRUCTURE_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "이 문서 이미지를 구조 그대로 마크다운으로 변환해줘." },
            { type: "image_url", image_url: { url: image } }
          ]
        }
      ]
    }),
    signal: AbortSignal.timeout(preprocessTimeoutMs(process.env.VISION_TIMEOUT_MS || 120_000))
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error?.message || payload.error || `Vision HTTP ${response.status}`), {
      statusCode: 502
    });
  }
  return stripFences((payload.choices?.[0]?.message?.content || "").trim());
}

// Restructure already-extracted text into Markdown via the configured text LLM.
export async function structureFromText(text, { llm } = {}) {
  const body = String(text || "").trim();
  if (!body) return "";
  if (typeof llm?.complete !== "function") {
    throw Object.assign(new Error("현재 LLM 설정으로는 전처리를 할 수 없습니다."), { statusCode: 400 });
  }
  const out = await llm.complete({
    system: STRUCTURE_SYSTEM,
    user: body,
    temperature: 0,
    maxTokens: preprocessMaxTokens(body),
    timeoutMs: preprocessTimeoutMsForText(body),
    extraBody: preprocessExtraBody(llm)
  });
  return stripFences(String(out || "").trim());
}

// Read an on-disk image into a base64 data URL for the vision endpoint.
export async function imageToDataUrl(filePath) {
  const buffer = await readFile(filePath);
  const ext = (filePath.match(/\.[a-z0-9]+$/i)?.[0] || "").toLowerCase();
  const mime = IMAGE_MIME[ext] || "image/png";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

// Models sometimes wrap the whole answer in a ```markdown fence despite the
// instruction; unwrap a single outer fence so the stored Markdown stays clean.
function stripFences(text) {
  const match = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text.trim());
  return match ? match[1].trim() : text;
}

// ── Dynamic token / timeout tuning (ported from the company build) ──
// The structuring agent must reproduce the whole document, so a long input needs
// a proportionally larger output budget (and more time) than a short one. These
// scale max_tokens with the estimated input size, bounded by env-configurable
// floor/cap, so short docs stay fast and long docs don't get truncated.

function preprocessMaxTokens(text = "") {
  const base = numberEnv("RAG_PREPROCESS_MAX_TOKENS", 2048);
  if (base <= 0) return 0;
  const body = String(text || "");
  if (!body.trim()) return base;
  const cap = Math.max(base, numberEnv("RAG_PREPROCESS_MAX_TOKENS_CAP", 16384));
  const ratio = numberEnv("RAG_PREPROCESS_OUTPUT_TOKEN_RATIO", 1.35);
  const estimated = Math.ceil(estimateTextTokens(body) * ratio + 512);
  return clamp(estimated, base, cap);
}

function preprocessImageMaxTokens() {
  return numberEnv("RAG_PREPROCESS_IMAGE_MAX_TOKENS", numberEnv("RAG_PREPROCESS_MAX_TOKENS_CAP", preprocessMaxTokens()));
}

function preprocessTimeoutMs(fallback = 60_000) {
  return numberEnv("RAG_PREPROCESS_TIMEOUT_MS", Number(fallback) || 60_000);
}

function preprocessTimeoutMsForText(text) {
  const base = preprocessTimeoutMs();
  const baseTokens = preprocessMaxTokens();
  const targetTokens = preprocessMaxTokens(text);
  if (targetTokens <= 0 || targetTokens <= baseTokens) return base;
  const cap = Math.max(base, numberEnv("RAG_PREPROCESS_TIMEOUT_MS_CAP", 240_000));
  const perThousand = numberEnv("RAG_PREPROCESS_TIMEOUT_MS_PER_1K_TOKENS", 5000);
  const extra = Math.ceil((targetTokens - baseTokens) / 1000) * perThousand;
  return clamp(base + extra, base, cap);
}

// Rough token estimate: ASCII ~4 chars/token, CJK ~1.25 chars/token, plus line
// overhead. Good enough to size the output budget without a real tokenizer.
function estimateTextTokens(text) {
  const value = String(text || "");
  if (!value) return 0;
  const ascii = (value.match(/[\x00-\x7F]/g) || []).length;
  const nonAscii = value.length - ascii;
  const lines = (value.match(/\n/g) || []).length + 1;
  return Math.ceil(ascii / 4 + nonAscii * 0.8 + lines * 4);
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Preprocessing request body extras: inherit LLM_EXTRA_BODY, and by default add
// enable_thinking:false so structuring doesn't waste the budget on reasoning
// tokens. RAG_PREPROCESS_EXTRA_BODY overrides; RAG_PREPROCESS_DISABLE_THINKING=0 opts out.
function preprocessExtraBody(llm) {
  const inherited = parseJsonObject(llm?.extraBody ?? process.env.LLM_EXTRA_BODY);
  const configured = process.env.RAG_PREPROCESS_EXTRA_BODY;
  const override = configured !== undefined ? parseJsonObject(configured) : defaultPreprocessExtraBody(inherited);
  return deepMerge(inherited, override);
}

function defaultPreprocessExtraBody(inherited) {
  if (String(process.env.RAG_PREPROCESS_DISABLE_THINKING || "1") === "0") return {};
  return {
    chat_template_kwargs: {
      ...parseJsonObject(inherited.chat_template_kwargs),
      enable_thinking: false
    }
  };
}

function deepMerge(left, right) {
  const out = { ...left };
  for (const [key, value] of Object.entries(right || {})) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
