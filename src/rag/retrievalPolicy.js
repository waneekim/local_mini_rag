export const DEFAULT_TOP_K = 8;

const POLICY_DEFS = {
  general: {
    name: "general",
    strictGrounding: false,
    defaultTopK: DEFAULT_TOP_K,
    candidateMultiplier: 3,
    candidateK: 24,
    vectorWeight: 0.75,
    lexicalWeight: 0.25,
    minScore: 0.01,
    rerankK: 18
  },
  search: {
    name: "search",
    strictGrounding: true,
    defaultTopK: DEFAULT_TOP_K,
    candidateMultiplier: 5,
    candidateK: 40,
    vectorWeight: 0.65,
    lexicalWeight: 0.35,
    minScore: 0.02,
    rerankK: 24
  },
  recommend: {
    name: "recommend",
    strictGrounding: true,
    defaultTopK: DEFAULT_TOP_K,
    candidateMultiplier: 4,
    candidateK: 32,
    vectorWeight: 0.7,
    lexicalWeight: 0.3,
    minScore: 0.02,
    rerankK: 20
  },
  figmaAudit: {
    name: "figmaAudit",
    strictGrounding: true,
    defaultTopK: 10,
    candidateMultiplier: 5,
    candidateK: 50,
    vectorWeight: 0.55,
    lexicalWeight: 0.45,
    minScore: 0.01,
    rerankK: 24
  },
  analyze: {
    name: "analyze",
    strictGrounding: false,
    defaultTopK: 12,
    candidateMultiplier: 4,
    candidateK: 48,
    vectorWeight: 0.75,
    lexicalWeight: 0.25,
    minScore: 0.01,
    rerankK: 24
  }
};

export function resolveRetrievalPolicy(input = {}, mode = null) {
  const key = normalizeModeKey(input.mode, mode);
  const base = POLICY_DEFS[key] || POLICY_DEFS.general;
  const topK = clamp(Number(input.topK || base.defaultTopK), 1, 30);
  const candidateK = clamp(
    Number(input.candidateK || Math.max(base.candidateK, topK * base.candidateMultiplier)),
    topK,
    100
  );
  const rerankRequested = booleanOption(input.rerank, envFlag("RAG_RERANK"));
  return {
    ...base,
    modeKey: mode?.key || key,
    modeLabel: mode?.label || base.name,
    topK,
    candidateK,
    rerank: rerankRequested,
    rerankK: clamp(Number(input.rerankK || base.rerankK), topK, candidateK)
  };
}

function normalizeModeKey(inputMode, mode) {
  const values = [
    inputMode,
    mode?.key,
    mode?.label,
    ...(Array.isArray(mode?.aliases) ? mode.aliases : [])
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  if (values.some((value) => ["검색", "search", "find"].includes(value))) return "search";
  if (values.some((value) => ["추천", "가이드", "recommend", "guide"].includes(value))) return "recommend";
  if (values.some((value) => ["분석", "analyze", "analysis"].includes(value))) return "analyze";
  if (
    values.some((value) =>
      ["규율", "규격", "검수", "피그마", "figma", "figma-audit", "figmaaudit", "문구검수", "용어검수"].includes(value)
    )
  ) {
    return "figmaAudit";
  }
  return "general";
}

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function envFlag(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
