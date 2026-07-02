// Structured writing rules: the deterministic half of guideline compliance.
// Rules are extracted (LLM draft → human review) into records, then `lintText`
// matches a draft sentence against forbidden terms / avoid-examples WITHOUT an
// embedding — exact, explainable, and paired with a recommended rewrite.

export const RULE_EXTRACTION_SYSTEM =
  "You extract UX writing rules from a Korean style guide into JSON. " +
  "Return ONLY a JSON array (no prose). Each element:\n" +
  '{ "section": string, "principle": string, "terms": string[], "prefer": string[], ' +
  '"pairs": [{ "avoid": string, "recommend": string }], "note": string }\n' +
  "- section: the heading it belongs to (e.g. 보이스앤톤).\n" +
  "- principle: the rule in one sentence.\n" +
  "- terms: words/phrases that must NOT be used (for exact filtering), e.g. [\"사용자\",\"사용자의\"].\n" +
  "- prefer: the recommended replacements for those terms, e.g. [\"나\",\"내\"].\n" +
  "- pairs: concrete avoid→recommend example sentences from tables.\n" +
  "- note: short rationale.\n" +
  "Only output rules actually supported by the text. Omit empty fields as [] or \"\".";

// Match a draft text against approved rules. Returns concrete, explainable
// violations with a suggested replacement — no LLM involved.
export function lintText(text, rules) {
  const hay = normalizeForMatch(text);
  const violations = [];
  const seen = new Set();
  for (const rule of rules || []) {
    const hits = [];
    for (const term of rule.terms || []) {
      if (term && hay.includes(normalizeForMatch(term))) {
        hits.push({ match: term, suggest: (rule.prefer || []).join(" / ") });
      }
    }
    for (const pair of rule.pairs || []) {
      if (pair?.avoid && hay.includes(normalizeForMatch(pair.avoid))) {
        hits.push({ match: pair.avoid, suggest: pair.recommend || "" });
      }
    }
    for (const hit of hits) {
      const key = `${rule.id}|${hit.match}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({
        ruleId: rule.id,
        section: rule.section || "",
        principle: rule.principle || "",
        match: hit.match,
        suggest: hit.suggest || "",
        note: rule.note || ""
      });
    }
  }
  return violations;
}

// Render violations + relevant rule principles as a labeled block that is
// prepended to the LLM context so compliance/recommend answers use the
// deterministic hits first.
export function buildRuleBlock(violations, rules) {
  const lines = [];
  if (violations.length) {
    lines.push("[규칙 기반 자동 감지 — 아래 위반을 우선 반영하라]");
    for (const v of violations) {
      const fix = v.suggest ? ` → 권장: ${v.suggest}` : "";
      const where = v.section ? ` (${v.section})` : "";
      lines.push(`- 금지 표현 '${v.match}' 발견${where}${fix}. 근거: ${v.principle || v.note || ""}`.trim());
    }
  }
  const principles = (rules || []).filter((r) => r.principle).slice(0, 12);
  if (principles.length) {
    lines.push(lines.length ? "\n[적용 규칙 원칙]" : "[적용 규칙 원칙]");
    for (const r of principles) lines.push(`- ${r.section ? `${r.section}: ` : ""}${r.principle}`);
  }
  return lines.join("\n");
}

// Parse the LLM extraction output (tolerant of code fences / surrounding text).
export function parseRuleRecords(raw) {
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
  return arr.map(normalizeRuleInput).filter((r) => r.principle || r.terms.length || r.pairs.length);
}

// Coerce arbitrary rule input (from LLM or the UI) into the stored shape.
export function normalizeRuleInput(raw = {}) {
  const strArray = (value) =>
    (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
  const pairs = (Array.isArray(raw.pairs) ? raw.pairs : [])
    .map((p) => ({ avoid: String(p?.avoid || "").trim(), recommend: String(p?.recommend || "").trim() }))
    .filter((p) => p.avoid || p.recommend);
  return {
    section: String(raw.section || "").trim(),
    principle: String(raw.principle || "").trim(),
    terms: strArray(raw.terms),
    prefer: strArray(raw.prefer),
    pairs,
    note: String(raw.note || "").trim()
  };
}

function normalizeForMatch(value) {
  return String(value || "").toLowerCase().normalize("NFKC");
}
