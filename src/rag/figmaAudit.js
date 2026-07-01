const MAX_FIGMA_ITEMS = 80;
const MAX_TEXT_CHARS = 1200;
const MAX_META_CHARS = 700;
const MAX_EXACT_CANDIDATES = 5;
const MAX_RECOMMENDATION_CANDIDATES = 3;
const EXACT_CONFIDENCE = 0.82;
const SUGGESTION_CONFIDENCE = 0.5;

export function buildFigmaAuditPrompt(input = {}) {
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const items = rawItems.slice(0, MAX_FIGMA_ITEMS).map(normalizeFigmaItem).filter(isUsefulItem);
  const looseText = trimTo(String(input.text || input.characters || input.copy || "").trim(), MAX_TEXT_CHARS * 4);
  const focus = String(input.focus || "").trim();

  if (!items.length && !looseText) {
    throw Object.assign(new Error("검수할 Figma 텍스트나 items 배열이 필요합니다."), { statusCode: 400 });
  }

  const lines = [
    "Figma 화면의 문구와 용어가 제품 언어/UX writing 가이드에 맞는지 검수해줘.",
    "로컬 RAG context에 있는 규칙만 근거로 사용하고, 근거가 없으면 '관련 규칙 없음'이라고 말해.",
    "틀린 단어만 바꾸지 말고 전체 문장을 올바른 문장으로 다시 써줘.",
    "출력은 한국어로 간결하게 작성해.",
    "",
    "출력 형식:",
    "항목: <노드 이름 또는 현재 문구>",
    "올바른 문장: <수정된 전체 문장 또는 판단 보류>",
    "근거: <왜 바꿔야 하는지. 반드시 [n] 인용 포함. 근거가 없으면 관련 규칙 없음>",
    "추천 표현: <항상 표시. 후보 문장 [n] · 유사도 NN% · 추천 근거>",
    ""
  ];

  if (focus) {
    lines.push(`검수 초점: ${focus}`, "");
  }

  if (items.length) {
    lines.push("Figma selected nodes:");
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      lines.push(`[figma:${index + 1}]`);
      lines.push(`ID: ${item.nodeId || item.id || `item-${index + 1}`}`);
      if (item.name) lines.push(`Name: ${item.name}`);
      if (item.type) lines.push(`Type: ${item.type}`);
      if (item.page || item.frame || item.section) {
        lines.push(`Location: ${[item.page, item.section, item.frame].filter(Boolean).join(" / ")}`);
      }
      if (item.component || item.variant) {
        lines.push(`Component: ${[item.component, item.variant].filter(Boolean).join(" / ")}`);
      }
      if (item.text) lines.push(`Visible text:\n${item.text}`);
      if (item.designNotes) lines.push(`Design notes: ${item.designNotes}`);
      lines.push("");
    }
  }

  if (looseText) {
    lines.push("Additional copied text:", looseText, "");
  }

  return {
    items,
    focus,
    reviewTexts: buildReviewTexts(items, looseText),
    truncated: rawItems.length > MAX_FIGMA_ITEMS,
    query: lines.join("\n").trim()
  };
}

export function extractExactTextCandidates(reviewTexts, citations = []) {
  return extractFigmaTextCandidates(reviewTexts, citations).exactCandidates;
}

export function extractFigmaTextCandidates(reviewTexts, citations = []) {
  const needles = normalizeReviewTexts(reviewTexts);
  if (!needles.length) return { exactCandidates: [], suggestionCandidates: [] };

  const out = [];
  const seen = new Set();
  for (const [citationIndex, citation] of (citations || []).entries()) {
    const number = citation.number ?? out.length + 1;
    const lines = candidateLines(citation.text || citation.excerpt || "");
    for (const [lineIndex, line] of lines.entries()) {
      const bestScore = bestCandidateScore(needles, line);
      if (bestScore.confidence < SUGGESTION_CONFIDENCE) continue;
      const key = normalizeForExactCompare(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        text: line,
        number,
        sourceId: citation.sourceId || "",
        title: citation.title || "",
        score: Number(bestScore.confidence.toFixed(6)),
        confidence: Number(bestScore.confidence.toFixed(6)),
        overlap: Number(bestScore.overlap.toFixed(6)),
        similarity: Number(bestScore.similarity.toFixed(6)),
        exact: bestScore.exact,
        reason: bestScore.reason,
        citationIndex,
        lineIndex,
        key
      });
    }
  }
  const ranked = out.sort(compareCandidates);
  const exactCandidates = ranked
    .filter((candidate) => candidate.exact || candidate.confidence >= EXACT_CONFIDENCE)
    .slice(0, MAX_EXACT_CANDIDATES)
    .map(stripInternalCandidateFields);
  const exactKeys = new Set(exactCandidates.map((candidate) => normalizeForExactCompare(candidate.text)));
  const suggestionCandidates = ranked
    .filter((candidate) => !exactKeys.has(candidate.key) && candidate.confidence >= SUGGESTION_CONFIDENCE && candidate.confidence < EXACT_CONFIDENCE)
    .slice(0, MAX_RECOMMENDATION_CANDIDATES)
    .map(stripInternalCandidateFields);
  return { exactCandidates, suggestionCandidates };
}

export function addExactCandidatesToQuery(query, candidates = [], suggestionCandidates = []) {
  if (!candidates.length && !suggestionCandidates.length) return query;
  const lines = [
    String(query || "").trim(),
    ""
  ];
  if (candidates.length) {
    lines.push("정확 원문 후보:", ...candidates.map((candidate) => `[${candidate.number}] ${candidate.text}`), "");
  }
  if (suggestionCandidates.length) {
    lines.push(
      "유사 원문 후보:",
      ...suggestionCandidates.map(
        (candidate) =>
          `[${candidate.number}] ${candidate.text} · 유사도 ${formatConfidencePercent(candidate.confidence)} · ${candidate.reason || buildCandidateReason(candidate)}`
      ),
      ""
    );
  }
  lines.push(
    "정확 원문 후보가 있으면 올바른 문장은 후보 문장을 그대로 복사해. 후보 문장의 단어, 조사, 어순을 절대 바꾸지 마.",
    "유사 원문 후보만 있으면 올바른 문장으로 확정하지 말고 추천 표현에 후보, [n] 링크, 유사도, 짧은 근거를 표시해.",
    "추천 표현은 항상 표시해."
  );
  return lines.join("\n").trim();
}

export function repairFigmaAuditAnswer(answer, candidates = [], suggestionCandidates = []) {
  const exactCandidates = normalizeCandidates(candidates, true);
  const similarCandidates = normalizeCandidates(suggestionCandidates, false);
  const best = exactCandidates[0] || null;
  const text = String(answer || "").trim();
  const recommendationBlock = formatRecommendationBlock([...exactCandidates, ...similarCandidates]);

  if (!text) {
    return {
      answer: buildFallbackAnswer(best, similarCandidates, recommendationBlock),
      repaired: true,
      candidate: best
    };
  }

  let found = false;
  let sentenceRepaired = false;
  let currentCorrected = "";
  const next = text.split("\n").map((line) => {
    const match = line.match(/^(\s*올바른\s*문장\s*:\s*)(.*)$/);
    if (!match) return line;
    found = true;
    const current = match[2].trim();
    currentCorrected = current;
    if (best) {
      if (isTopCandidateSentence(current, best)) return line;
      sentenceRepaired = true;
      return `${match[1]}${best.text}`;
    }
    sentenceRepaired = current !== "판단 보류";
    return `${match[1]}판단 보류`;
  });

  if (!found) {
    return {
      answer: buildFallbackAnswer(best, similarCandidates, recommendationBlock),
      repaired: true,
      candidate: best
    };
  }

  let output = next.join("\n");
  let rationaleRepaired = false;
  const rationale = best
    ? `참조문서의 원문 표현입니다. [${best.number}]`
    : similarCandidates.length
      ? `정확히 일치하는 원문은 없지만 유사한 원문 후보가 있습니다. [${similarCandidates[0].number}]`
      : "관련 규칙 없음";
  if (sentenceRepaired || !hasGroundedRationale(output, best || similarCandidates[0] || null)) {
    rationaleRepaired = true;
    output = output.replace(/^\s*근거\s*:.*$/m, `근거: ${rationale}`);
    if (!/^\s*근거\s*:/m.test(output)) {
      output += `\n근거: ${rationale}`;
    }
  }
  const recommendationRepaired = !hasExpectedRecommendationBlock(output, recommendationBlock);
  output = replaceRecommendationBlock(output, recommendationBlock);
  return {
    answer: output,
    repaired: sentenceRepaired || rationaleRepaired || recommendationRepaired || (currentCorrected === "원문 유지" && !best),
    candidate: best
  };
}

function normalizeFigmaItem(item = {}) {
  const text = String(item.text ?? item.characters ?? item.value ?? "").trim();
  const designNotes = compactMeta({
    style: item.style,
    styles: item.styles,
    fontName: item.fontName,
    fontSize: item.fontSize,
    fills: item.fills,
    effects: item.effects,
    constraints: item.constraints,
    bounds: item.bounds || item.absoluteBoundingBox,
    design: item.design,
    notes: item.notes
  });

  return {
    id: stringOrEmpty(item.id),
    nodeId: stringOrEmpty(item.nodeId || item.node_id),
    name: stringOrEmpty(item.name),
    type: stringOrEmpty(item.type),
    page: stringOrEmpty(item.page || item.pageName),
    section: stringOrEmpty(item.section || item.sectionName),
    frame: stringOrEmpty(item.frame || item.frameName),
    component: stringOrEmpty(item.component || item.componentName),
    variant: stringOrEmpty(item.variant || item.variantName),
    text: trimTo(text, MAX_TEXT_CHARS),
    designNotes
  };
}

function buildReviewTexts(items, looseText) {
  const texts = [];
  for (const item of items) {
    if (item.text) texts.push(item.text);
  }
  if (looseText) texts.push(...looseText.split(/\n+/).map((line) => line.trim()).filter(Boolean));
  return texts;
}

function normalizeReviewTexts(reviewTexts) {
  const raw = Array.isArray(reviewTexts) ? reviewTexts : [reviewTexts];
  return raw
    .flatMap((text) => String(text || "").split(/\n+/))
    .map((text) => text.trim())
    .filter((text) => text.length >= 2 && meaningfulTokens(text).length >= 3);
}

function candidateLines(text) {
  const rawLines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 2 && line.length <= 160);
  const out = [];
  for (const line of rawLines) {
    out.push(...line.split(/\s{2,}|(?<=[.!?。])\s+/).map((part) => part.trim()).filter(Boolean));
  }
  return out;
}

function overlapScore(queryText, candidateText) {
  const queryTokens = meaningfulTokens(queryText);
  if (!queryTokens.length) return 0;
  const candidateTokens = new Set(meaningfulTokens(candidateText));
  if (!candidateTokens.size) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) matches += 1;
  }
  return matches / queryTokens.length;
}

function bestCandidateScore(reviewTexts, candidateText) {
  let best = { confidence: 0, overlap: 0, similarity: 0, exact: false, reason: "" };
  for (const reviewText of reviewTexts) {
    const overlap = overlapScore(reviewText, candidateText);
    const similarity = editSimilarity(normalizeForExactCompare(reviewText), normalizeForExactCompare(candidateText));
    const exact = normalizeForExactCompare(reviewText) === normalizeForExactCompare(candidateText);
    const confidence = exact ? 1 : similarity * 0.75 + overlap * 0.25;
    if (confidence > best.confidence) {
      best = {
        confidence,
        overlap,
        similarity,
        exact,
        reason: buildReasonForPair(reviewText, candidateText, { exact, overlap, similarity, confidence })
      };
    }
  }
  return best;
}

function compareCandidates(a, b) {
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  if (b.similarity !== a.similarity) return b.similarity - a.similarity;
  if (b.overlap !== a.overlap) return b.overlap - a.overlap;
  if (a.citationIndex !== b.citationIndex) return a.citationIndex - b.citationIndex;
  return a.lineIndex - b.lineIndex;
}

function stripInternalCandidateFields({ citationIndex, lineIndex, key, ...candidate }) {
  return candidate;
}

function normalizeCandidates(candidates, exactList) {
  return (candidates || []).map((candidate) => {
    const confidence = Number(
      candidate.confidence ?? (candidate.exact || exactList ? 1 : candidate.score ?? 0)
    );
    return {
      ...candidate,
      confidence,
      score: Number((candidate.score ?? confidence).toFixed ? candidate.score ?? confidence : confidence),
      similarity: Number(candidate.similarity ?? confidence),
      overlap: Number(candidate.overlap ?? confidence),
      exact: Boolean(candidate.exact || exactList),
      reason: candidate.reason || buildCandidateReason({ ...candidate, confidence, exact: Boolean(candidate.exact || exactList) })
    };
  });
}

function buildFallbackAnswer(best, suggestionCandidates, recommendationBlock) {
  if (best) {
    return `올바른 문장: ${best.text}\n근거: 참조문서의 원문 표현입니다. [${best.number}]\n${recommendationBlock}`;
  }
  if (suggestionCandidates.length) {
    return `올바른 문장: 판단 보류\n근거: 정확히 일치하는 원문은 없지만 유사한 원문 후보가 있습니다. [${suggestionCandidates[0].number}]\n${recommendationBlock}`;
  }
  return `올바른 문장: 판단 보류\n근거: 관련 규칙 없음\n${recommendationBlock}`;
}

function formatRecommendationBlock(candidates) {
  const unique = [];
  const seen = new Set();
  for (const candidate of normalizeCandidates(candidates, false)) {
    const key = normalizeForExactCompare(candidate.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= MAX_RECOMMENDATION_CANDIDATES) break;
  }
  if (!unique.length) {
    return "추천 표현:\n- 추천 가능한 원문 후보 없음 · 유사도 기준 미달 · 참조문서에서 충분히 가까운 표현을 찾지 못했습니다.";
  }
  return [
    "추천 표현:",
    ...unique.map(
      (candidate) =>
        `- ${candidate.text} [${candidate.number}] · 유사도 ${formatConfidencePercent(candidate.confidence)} · ${candidate.reason || buildCandidateReason(candidate)}`
    )
  ].join("\n");
}

function hasExpectedRecommendationBlock(answer, recommendationBlock) {
  return String(answer || "").includes(recommendationBlock);
}

function replaceRecommendationBlock(answer, recommendationBlock) {
  const text = String(answer || "").trim();
  if (/^\s*추천\s*표현\s*:/m.test(text)) {
    return text.replace(/^\s*추천\s*표현\s*:[\s\S]*$/m, recommendationBlock);
  }
  return `${text}\n${recommendationBlock}`;
}

function formatConfidencePercent(confidence) {
  const value = Math.max(0, Math.min(1, Number(confidence) || 0));
  return `${Math.round(value * 100)}%`;
}

function buildCandidateReason(candidate) {
  if (candidate.exact || Number(candidate.confidence) >= 0.99) return "입력 문장과 원문이 일치합니다.";
  if (Number(candidate.similarity) >= 0.65 && Number(candidate.overlap) >= 0.5) {
    return "입력 문장과 원문의 표현 일부가 겹치고 문장 형태가 유사합니다.";
  }
  if (Number(candidate.similarity) >= 0.65) return "입력 문장과 원문의 글자 배열이 유사합니다.";
  return "입력 문장과 일부 핵심 표현이 겹칩니다.";
}

function buildReasonForPair(reviewText, candidateText, score) {
  if (score.exact || score.confidence >= 0.99) return "입력 문장과 원문이 일치합니다.";
  const matched = fuzzyMatchedTokens(reviewText, candidateText).slice(0, 3);
  if (matched.length >= 2) {
    return `입력의 '${matched.join("', '")}' 표현이 원문과 겹치고 문장 형태가 유사합니다.`;
  }
  if (score.similarity >= 0.65) return "입력 문장과 원문의 글자 배열이 유사합니다.";
  if (matched.length === 1) return `입력의 '${matched[0]}' 표현이 원문과 겹칩니다.`;
  return "입력 문장과 일부 표현이 유사합니다.";
}

function fuzzyMatchedTokens(queryText, candidateText) {
  const queryTokens = meaningfulTokens(queryText);
  const candidateTokens = meaningfulTokens(candidateText);
  const out = [];
  for (const queryToken of queryTokens) {
    const matched = candidateTokens.some((candidateToken) => {
      if (queryToken === candidateToken) return true;
      if (queryToken.length < 2 || candidateToken.length < 2) return false;
      return queryToken.includes(candidateToken) || candidateToken.includes(queryToken);
    });
    if (matched) out.push(queryToken);
  }
  return [...new Set(out)];
}

function editSimilarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const distance = levenshteinDistance(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshteinDistance(a, b) {
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

function meaningfulTokens(text) {
  const words = String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  return [...new Set(words.map(stripKoreanParticle).filter((word) => word.length >= 1))];
}

function stripKoreanParticle(word) {
  const suffixes = ["으로서", "으로써", "에게서", "이라는", "라는", "에서", "에게", "부터", "까지", "처럼", "보다", "으로", "하고", "이며", "이고", "은", "는", "이", "가", "을", "를", "에", "의", "와", "과", "도", "만", "로"];
  let base = String(word || "");
  for (let i = 0; i < 2; i += 1) {
    const suffix = suffixes.find((candidate) => base.length > candidate.length + 1 && base.endsWith(candidate));
    if (!suffix) break;
    base = base.slice(0, -suffix.length);
  }
  return base;
}

function isTopCandidateSentence(text, candidate) {
  const normalized = normalizeForExactCompare(text);
  return normalizeForExactCompare(candidate.text) === normalized;
}

function hasGroundedRationale(answer, candidate) {
  const rationale = String(answer || "").match(/^\s*근거\s*:\s*(.*)$/m)?.[1] || "";
  if (!rationale.trim()) return false;
  if (!candidate) return !/관련\s*규칙\s*없음/.test(rationale);
  if (/관련\s*규칙\s*없음/.test(rationale)) return false;
  return rationale.includes(`[${candidate.number}]`);
}

function normalizeForExactCompare(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function isUsefulItem(item) {
  return Boolean(
    item.text ||
      item.name ||
      item.type ||
      item.page ||
      item.frame ||
      item.component ||
      item.variant ||
      item.designNotes
  );
}

function compactMeta(meta) {
  const clean = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === "") continue;
    clean[key] = value;
  }
  if (!Object.keys(clean).length) return "";
  try {
    return trimTo(JSON.stringify(clean), MAX_META_CHARS);
  } catch {
    return "";
  }
}

function stringOrEmpty(value) {
  return String(value || "").trim();
}

function trimTo(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
