// Semantic middle layer: canonical concepts + variant surface forms, linked to
// the source chunks that mention them. This bridges the gap the user hits when
// documents phrase one meaning many ways ("동작 대기 중" / "대기 중" / "스탠바이"):
//   query → concept interpretation → expanded retrieval + linked-chunk boost
//   → the LLM also receives the interpretation so it answers by meaning.
import { buildTermIndex, scanTerms } from "./glossary.js";

export const CONCEPT_EXTRACTION_SYSTEM =
  "You extract SEMANTIC CONCEPTS from Korean product/UX documentation into JSON. " +
  "A concept is one meaning that appears under several surface forms (synonyms, " +
  "abbreviations, spelling variants) — e.g. 동작 대기 = 대기 중 = 스탠바이. " +
  "Return ONLY a JSON array (no prose). Each element:\n" +
  '{ "name": string, "aliases": string[], "definition": string }\n' +
  "- name: the canonical Korean name for the concept.\n" +
  "- aliases: OTHER expressions in the text that mean the same thing (variants, " +
  "synonyms, English/loanword forms). Do not repeat the name.\n" +
  "- definition: one sentence capturing the meaning/context from the text.\n" +
  "Only output concepts that genuinely appear in multiple forms or whose meaning " +
  "needs context. 3~10 concepts per input. Do not invent anything.";

// Adapt concept records ({name, aliases}) to the glossary scanner's shape.
export function buildConceptIndex(concepts) {
  return buildTermIndex((concepts || []).map((c) => ({ ...c, term: c.name })));
}

// Find which concepts a text mentions (by canonical name OR any alias),
// deduplicated by concept. Returns [{ concept, surfaces: [매칭된 표기…] }].
export function matchConcepts(text, concepts) {
  if (!concepts?.length) return [];
  const hits = scanTerms(text, buildConceptIndex(concepts));
  const byId = new Map();
  for (const hit of hits) {
    const key = hit.entry.id || hit.entry.name;
    const item = byId.get(key) || { concept: hit.entry, surfaces: [] };
    if (!item.surfaces.includes(hit.surface)) item.surfaces.push(hit.surface);
    byId.set(key, item);
  }
  return [...byId.values()];
}

// Append canonical names + all variants to the query so both the embedding and
// the lexical scorer can reach chunks phrased with a different surface form.
export function expandQuery(query, matched) {
  if (!matched?.length) return query;
  const extra = matched
    .map(({ concept }) => [concept.name, ...(concept.aliases || [])].join(" "))
    .join(" ");
  return `${query}\n${extra}`;
}

// Interpretation block prepended to the LLM context: tells the model what the
// user's words MEAN and which document phrasings refer to the same thing.
export function buildConceptBlock(matched) {
  if (!matched?.length) return "";
  const lines = ["[의미 해석 — 질문의 표현과 문서의 표기가 다를 수 있음]"];
  for (const { concept, surfaces } of matched) {
    const variants = [concept.name, ...(concept.aliases || [])].filter((v) => !surfaces.includes(v));
    const parts = [`질문의 '${surfaces.join("', '")}' = 개념 '${concept.name}'`];
    if (variants.length) parts.push(`문서 표기: ${variants.join(", ")}`);
    if (concept.definition) parts.push(`뜻: ${concept.definition}`);
    lines.push(`- ${parts.join(" · ")}`);
  }
  return lines.join("\n");
}

// Parse the LLM extraction output (tolerant of code fences / surrounding text).
export function parseConceptRecords(raw) {
  const text = String(raw || "");
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let arr;
  try {
    arr = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeConceptInput).filter((c) => c.name);
}

// Coerce arbitrary concept input (from LLM or the UI) into the stored shape.
export function normalizeConceptInput(raw = {}) {
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : typeof raw.aliases === "string" ? raw.aliases.split(/[,\n]/) : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const name = String(raw.name || "").trim();
  return {
    name,
    aliases: aliases.filter((a) => a !== name),
    definition: String(raw.definition || "").trim()
  };
}
