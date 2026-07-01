export function buildCitationGroups(citations = []) {
  const groups = [];
  const byKey = new Map();

  for (const citation of citations || []) {
    const key = citationGroupKey(citation);
    if (!byKey.has(key)) {
      const group = {
        id: key,
        sourceId: citation.sourceId || "",
        title: citation.title || "참조 문서",
        query: citation.query || "",
        citations: [],
        count: 0,
        numbers: [],
        maxScore: null
      };
      byKey.set(key, group);
      groups.push(group);
    }

    const group = byKey.get(key);
    group.citations.push(citation);
    group.count = group.citations.length;
    group.numbers = group.citations.map((c) => c.number).filter((n) => n !== undefined && n !== null);
    if (typeof citation.score === "number") {
      group.maxScore = group.maxScore === null ? citation.score : Math.max(group.maxScore, citation.score);
    }
  }

  return groups;
}

export function buildCitationPopupHtml(entry, allCitations = []) {
  const group = resolveCitationGroup(entry, allCitations);
  const title = `${group.title}${group.count > 1 ? `(${group.count})` : ""}`;
  const locators = unique(group.citations.map((citation) => formatLocatorKo(citation.locator)).filter(Boolean));
  const locatorStr = locators.slice(0, 4).join(" · ");
  const hiddenLocatorCount = Math.max(0, locators.length - 4);
  const citationsHtml = group.citations.map((citation, index) => citationCardHtml(citation, group.query, index)).join("");

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; color: #17211d; background: #f4f6f3; }
  .header { background: #007a68; color: white; padding: 20px 24px; }
  .header h1 { font-size: 1.05rem; font-weight: 700; line-height: 1.4; }
  .header .meta { margin-top: 5px; font-size: 0.82rem; opacity: 0.85; line-height: 1.45; }
  .body { padding: 22px 24px; }
  .summary { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; flex-wrap: wrap; }
  .pill { background: #e5f3ef; color: #005e52; padding: 3px 10px; border-radius: 999px; font-size: 0.78rem; font-weight: 700; }
  .pill.blue { background: #dde8ff; color: #2946a8; }
  .hl-note { color: #68736d; font-size: 0.76rem; }
  .chunk-card { background: white; border: 1px solid #d9e0dc; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .chunk-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border-bottom: 1px solid #edf1ef; background: #fafcfb; }
  .chunk-title { font-size: 0.82rem; font-weight: 800; color: #17211d; }
  .chunk-meta { color: #68736d; font-size: 0.76rem; }
  .excerpt { white-space: pre-wrap; line-height: 1.75; font-size: 0.93rem; padding: 15px 16px; }
  mark { background: #ffe08a; color: inherit; padding: 0 2px; border-radius: 2px; }
</style></head><body>
<div class="header"><h1>${escapeHtml(title)}</h1>${locatorStr ? `<div class="meta">${escapeHtml(locatorStr)}${hiddenLocatorCount ? ` 외 ${hiddenLocatorCount}곳` : ""}</div>` : ""}</div>
<div class="body">
  <div class="summary">
    <span class="pill blue">찾은 텍스트 ${group.count}개</span>
    ${group.maxScore !== null ? `<span class="pill">최고 유사도 ${group.maxScore.toFixed(3)}</span>` : ""}
    <span class="hl-note">노란 표시 = 질문어/검색어</span>
  </div>
  ${citationsHtml}
</div>
</body></html>`;
}

export function highlightTerms(escapedText, query) {
  const terms = buildHighlightTerms(query);
  if (!terms.length) return escapedText;
  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  try {
    return escapedText.replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
  } catch {
    return escapedText;
  }
}

function citationCardHtml(citation, groupQuery, index) {
  const number = citation.number ?? index + 1;
  const locator = formatLocatorKo(citation.locator);
  const query = citation.query || groupQuery || "";
  const body = highlightTerms(escapeHtml(citation.text || citation.excerpt || ""), query);
  const score = typeof citation.score === "number" ? citation.score.toFixed(3) : "-";

  return `<section class="chunk-card">
  <div class="chunk-head">
    <span class="pill blue">[${escapeHtml(String(number))}]</span>
    <span class="chunk-title">유사도 ${escapeHtml(score)}</span>
    ${locator ? `<span class="chunk-meta">${escapeHtml(locator)}</span>` : ""}
  </div>
  <div class="excerpt">${body}</div>
</section>`;
}

function resolveCitationGroup(entry, allCitations) {
  if (entry?.citations?.length) return normalizeGroup(entry);
  const key = citationGroupKey(entry || {});
  return buildCitationGroups(allCitations).find((group) => group.id === key) || normalizeGroup({
    id: key,
    sourceId: entry?.sourceId || "",
    title: entry?.title || "참조 문서",
    query: entry?.query || "",
    citations: entry ? [entry] : []
  });
}

function normalizeGroup(group) {
  const citations = group.citations || [];
  const maxScore = citations.reduce(
    (best, citation) => (typeof citation.score === "number" ? (best === null ? citation.score : Math.max(best, citation.score)) : best),
    null
  );
  return {
    id: group.id || citationGroupKey(citations[0] || group),
    sourceId: group.sourceId || citations[0]?.sourceId || "",
    title: group.title || citations[0]?.title || "참조 문서",
    query: group.query || citations[0]?.query || "",
    citations,
    count: group.count || citations.length,
    numbers: group.numbers || citations.map((c) => c.number).filter((n) => n !== undefined && n !== null),
    maxScore
  };
}

function buildHighlightTerms(query) {
  const terms = new Set();
  const normalized = String(query || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const token of normalized.split(" ").filter(Boolean)) {
    for (const term of termVariants(token)) {
      if (term.length >= 2) terms.add(term);
    }
  }

  return [...terms].sort((a, b) => b.length - a.length);
}

function termVariants(token) {
  const variants = new Set([token]);
  let base = token;
  const suffixes = [
    "으로서",
    "으로써",
    "에게서",
    "이라는",
    "라는",
    "에서",
    "에게",
    "부터",
    "까지",
    "처럼",
    "보다",
    "으로",
    "하고",
    "이며",
    "이고",
    "은",
    "는",
    "이",
    "가",
    "을",
    "를",
    "에",
    "의",
    "와",
    "과",
    "도",
    "만",
    "로"
  ];

  for (let i = 0; i < 2; i += 1) {
    const suffix = suffixes.find((candidate) => base.length > candidate.length + 1 && base.endsWith(candidate));
    if (!suffix) break;
    base = base.slice(0, -suffix.length);
    variants.add(base);
  }

  return variants;
}

function citationGroupKey(citation = {}) {
  return citation.sourceId || `${citation.title || "참조 문서"}:${citation.locator?.relativePath || ""}`;
}

function formatLocatorKo(locator = {}) {
  const parts = [];
  if (locator.relativePath) parts.push(locator.relativePath);
  if (locator.page) parts.push(`페이지 ${locator.page}`);
  if (locator.slide) parts.push(`슬라이드 ${locator.slide}`);
  if (locator.sheet) parts.push(`시트 ${locator.sheet}`);
  if (locator.rowRange) parts.push(`행 ${locator.rowRange}`);
  return parts.join(", ");
}

function unique(values) {
  return [...new Set(values)];
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
