// Glossary: the key-based dictionary half of guideline compliance.
// The UX glossary is hundreds-to-thousands of approved terms — membership
// ("이 단어가 용어집에 있나?") is a lookup problem, not a vector-search problem,
// so terms live in their own table and are matched deterministically:
// longest-match scanning for known terms, and a light Korean tokenizer
// (josa stripping) to surface candidate words the glossary does NOT cover.

export const GLOSSARY_EXTRACTION_SYSTEM =
  "You extract UX glossary entries from Korean documentation into JSON. " +
  "Each source page typically defines ONE term (title = term, body = definition). " +
  "Return ONLY a JSON array (no prose). Each element:\n" +
  '{ "term": string, "status": "approved"|"deprecated"|"forbidden", "preferred": string, ' +
  '"definition": string, "category": string, "aliases": string[] }\n' +
  "- term: the canonical word as written in the guide.\n" +
  "- status: approved = usable on screens; deprecated/forbidden = must be replaced.\n" +
  "- preferred: the replacement word when status is not approved, else \"\".\n" +
  "- definition: one-or-two sentence meaning from the text.\n" +
  "- category: the section/heading it belongs to (e.g. ㄱ, 가전, 브랜드).\n" +
  "- aliases: spelling variants seen in the text (e.g. [\"에어콘\"]).\n" +
  "Only output entries actually supported by the text.";

// Lookup key: NFKC + lowercase + no spaces, so "Smart Things"/"스마트 싱스"
// style variants land on the same key.
export function normalizeTermKey(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

// Build the exact-lookup index. Every alias points at the same canonical entry,
// so scanning "에어콘" resolves to the approved "에어컨" record.
export function buildTermIndex(terms) {
  const index = new Map();
  let maxLen = 1;
  for (const term of terms || []) {
    for (const key of [term.term, ...(term.aliases || [])]) {
      const norm = normalizeTermKey(key);
      if (!norm) continue;
      if (!index.has(norm)) index.set(norm, term);
      maxLen = Math.max(maxLen, norm.length);
    }
  }
  return { index, maxLen };
}

// Longest-match scan: at each position grow a normalized candidate character
// by character (spaces skipped, like the keys) and keep the longest glossary
// hit, so "셋팅하시겠습니까" still surfaces "셋팅", "자동 모드" matches its
// space-stripped key, and compound terms beat their prefixes. O(n · maxKeyLen).
export function scanTerms(text, { index, maxLen }) {
  const s = String(text || "");
  const found = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i += 1;
      continue;
    }
    let norm = "";
    let best = null;
    for (let j = i; j < s.length && norm.length < maxLen; j += 1) {
      if (/\s/.test(s[j])) continue; // keys are space-stripped; surface may span spaces
      norm += normalizeTermKey(s[j]);
      const entry = index.get(norm);
      // end = j+1 so the surface never carries trailing whitespace.
      if (entry) best = { surface: s.slice(i, j + 1), offset: i, length: j + 1 - i, entry };
    }
    if (best) {
      found.push(best);
      i += best.length;
    } else {
      i += 1;
    }
  }
  return found;
}

// Particles stripped (longest first) when normalizing a token to its base form,
// so "냉장고를"/"냉장고에서" both resolve to the dictionary key "냉장고".
const JOSA = [
  "에서는", "에서도", "으로는", "으로도", "까지는", "부터는",
  "에서", "에게", "한테", "께서", "으로", "이나", "이라", "라는", "처럼", "보다", "부터", "까지", "마다", "조차", "밖에",
  "은", "는", "이", "가", "을", "를", "에", "의", "와", "과", "도", "만", "로", "나", "요"
].sort((a, b) => b.length - a.length);

// Function words that should never be reported as "missing from the glossary".
const STOPWORDS = new Set([
  "그리고", "또는", "하지만", "그러나", "여기", "저기", "이것", "그것", "저것", "우리", "당신",
  "있는", "없는", "있습니다", "없습니다", "합니다", "됩니다", "위해", "통해", "대한", "경우",
  "다시", "함께", "모두", "매우", "가장", "너무", "바로", "지금", "이미", "아직"
]);

const HANGUL = /[가-힣]/;

// Strip one trailing particle if the remaining stem is still a word.
export function stripJosa(token) {
  for (const josa of JOSA) {
    if (token.length - josa.length >= 2 && token.endsWith(josa)) {
      return token.slice(0, token.length - josa.length);
    }
  }
  return token;
}

// Check a draft text against the glossary. Returns
//   terms:   every glossary hit with its verdict (approved / deprecated / forbidden)
//   missing: Hangul content words the glossary does not cover (candidates for
//            registration — absence is provable here because this is a lookup,
//            not a similarity search).
export function checkText(text, termRecords) {
  const built = buildTermIndex(termRecords);
  const hits = scanTerms(text, built);

  const covered = [];
  const terms = hits.map((hit) => {
    covered.push([hit.offset, hit.offset + hit.length]);
    return {
      surface: hit.surface,
      offset: hit.offset,
      term: hit.entry.term,
      termId: hit.entry.id || "",
      status: hit.entry.status || "approved",
      preferred: hit.entry.preferred || "",
      definition: hit.entry.definition || "",
      category: hit.entry.category || ""
    };
  });

  const missing = [];
  const seen = new Set();
  const tokenRe = /[^\s.,!?…·:;()\[\]{}"'“”‘’<>\/\\|+=~`@#$%^&*\-_0-9a-zA-Z]+/g;
  let match;
  while ((match = tokenRe.exec(String(text || ""))) !== null) {
    const token = match[0];
    if (!HANGUL.test(token) || token.length < 2) continue;
    const start = match.index;
    const end = start + token.length;
    // Skip tokens whose start overlaps a matched glossary span.
    if (covered.some(([a, b]) => start < b && end > a)) continue;
    const base = stripJosa(token.normalize("NFKC"));
    if (base.length < 2 || STOPWORDS.has(base) || STOPWORDS.has(token)) continue;
    const entry = built.index.get(normalizeTermKey(base));
    if (entry) {
      // The bare token missed but its particle-stripped stem is a known term.
      terms.push({
        surface: token,
        offset: start,
        term: entry.term,
        termId: entry.id || "",
        status: entry.status || "approved",
        preferred: entry.preferred || "",
        definition: entry.definition || "",
        category: entry.category || ""
      });
      continue;
    }
    if (seen.has(base)) continue;
    seen.add(base);
    missing.push({ surface: token, base, offset: start });
  }

  return { terms, missing };
}

// Render a glossary verdict as a labeled block prepended to the LLM context so
// the integrated review rewrites with approved vocabulary.
export function buildGlossaryBlock({ terms = [], missing = [] } = {}) {
  const replace = terms.filter((t) => t.status !== "approved");
  if (!replace.length && !missing.length) return "";
  const lines = ["[용어집 검수 — 아래 단어 교체/확인을 반영하라]"];
  for (const t of replace) {
    const label = t.status === "forbidden" ? "금지어" : "비권장어";
    lines.push(`- ${label} '${t.surface}'${t.preferred ? ` → 권장: ${t.preferred}` : ""}`);
  }
  if (missing.length) {
    lines.push(`- 용어집 미등록 후보: ${missing.map((m) => `'${m.base}'`).join(", ")} (승인어로 대체하거나 등록 검토)`);
  }
  return lines.join("\n");
}

// Parse the LLM extraction output (tolerant of code fences / surrounding text).
export function parseGlossaryRecords(raw) {
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
  return arr.map(normalizeGlossaryInput).filter((t) => t.term);
}

// Coerce arbitrary term input (from LLM or the UI) into the stored shape.
export function normalizeGlossaryInput(raw = {}) {
  const status = ["approved", "deprecated", "forbidden"].includes(raw.status) ? raw.status : "approved";
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : typeof raw.aliases === "string" ? raw.aliases.split(/[,\n]/) : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  return {
    term: String(raw.term || "").trim(),
    status,
    preferred: String(raw.preferred || "").trim(),
    definition: String(raw.definition || "").trim(),
    category: String(raw.category || "").trim(),
    aliases
  };
}
