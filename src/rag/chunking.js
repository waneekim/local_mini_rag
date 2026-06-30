const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_OVERLAP = 150;

export function chunkDocuments(documents, options = {}) {
  const chunkSize = Number(options.chunkSize || process.env.RAG_CHUNK_SIZE || DEFAULT_CHUNK_SIZE);
  const overlap = Number(options.overlap || process.env.RAG_CHUNK_OVERLAP || DEFAULT_OVERLAP);
  const chunks = [];

  for (const document of documents || []) {
    const text = normalizeText(document.text);
    if (!text) continue;
    const pieces = splitText(text, chunkSize, overlap);
    for (const piece of pieces) {
      chunks.push({
        text: piece.text,
        locator: {
          ...(document.locator || {}),
          offsetStart: piece.start,
          offsetEnd: piece.end
        },
        metadata: document.metadata || {}
      });
    }
  }

  return chunks;
}

function splitText(text, chunkSize, overlap) {
  if (text.length <= chunkSize) return [{ text, start: 0, end: text.length }];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    if (end < text.length) {
      const boundary = findBoundary(text, start, end);
      if (boundary > start + chunkSize * 0.55) end = boundary;
    }
    chunks.push({ text: text.slice(start, end).trim(), start, end });
    if (end >= text.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks.filter((chunk) => chunk.text);
}

function findBoundary(text, start, end) {
  const window = text.slice(start, end);
  const candidates = ["\n\n", "\n", ". ", "? ", "! ", "。", "다. "];
  let best = -1;
  for (const candidate of candidates) {
    const index = window.lastIndexOf(candidate);
    if (index > best) best = index + candidate.length;
  }
  return best === -1 ? end : start + best;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00a0]{2,}/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}
