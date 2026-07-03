const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_OVERLAP = 150;

export function chunkDocuments(documents, options = {}) {
  const chunkSize = Number(options.chunkSize || process.env.RAG_CHUNK_SIZE || DEFAULT_CHUNK_SIZE);
  const overlap = Number(options.overlap || process.env.RAG_CHUNK_OVERLAP || DEFAULT_OVERLAP);
  const chunks = [];

  for (const document of documents || []) {
    const text = normalizeText(document.text);
    if (!text) continue;
    // Structure-aware path: a document produced by the preprocessing agent is
    // clean Markdown, so we split on headings and keep tables whole instead of
    // using the blind character window.
    const isMarkdown = document.metadata?.format === "markdown" || document.locator?.format === "markdown";
    const pieces = isMarkdown ? splitMarkdown(text, chunkSize) : splitText(text, chunkSize, overlap);
    for (const piece of pieces) {
      chunks.push({
        text: piece.text,
        locator: {
          ...(document.locator || {}),
          ...(piece.heading ? { heading: piece.heading } : {}),
          offsetStart: piece.start,
          offsetEnd: piece.end
        },
        metadata: document.metadata || {}
      });
    }
  }

  return chunks;
}

// Split clean Markdown into structure-aligned chunks: each chunk starts at a
// heading, tables are never broken mid-row, and the active heading path is
// carried on every chunk so short queries retrieve the right section.
export function splitMarkdown(text, chunkSize = DEFAULT_CHUNK_SIZE) {
  const blocks = markdownBlocks(text);
  const chunks = [];
  let buffer = [];
  let bufferLen = 0;
  let heading = "";
  let cursor = 0;
  let start = 0;

  const flush = () => {
    if (!buffer.length) return;
    const body = buffer.join("\n\n").trim();
    if (body) chunks.push({ text: body, start, end: cursor, heading });
    buffer = [];
    bufferLen = 0;
    start = cursor;
  };

  for (const block of blocks) {
    cursor += block.raw.length;
    if (block.type === "heading") {
      // Start a fresh chunk at each heading and track the section path.
      flush();
      heading = headingPath(heading, block.level, block.text);
      buffer.push(block.raw.trim());
      bufferLen += block.raw.length;
      continue;
    }
    // A table is atomic — flush first if it would overflow, then keep it whole
    // even when it alone exceeds the target size.
    if (block.type === "table") {
      if (bufferLen && bufferLen + block.raw.length > chunkSize) flush();
      buffer.push(block.raw.trim());
      bufferLen += block.raw.length;
      continue;
    }
    // Paragraph: split it on sentence boundaries if it is larger than a chunk,
    // otherwise pack it and roll over when the buffer would overflow.
    if (block.raw.length > chunkSize) {
      flush();
      for (const piece of splitText(block.raw.trim(), chunkSize, 0)) {
        chunks.push({ text: piece.text, start, end: cursor, heading });
      }
      start = cursor;
      continue;
    }
    if (bufferLen && bufferLen + block.raw.length > chunkSize) flush();
    buffer.push(block.raw.trim());
    bufferLen += block.raw.length;
  }
  flush();
  return chunks.filter((chunk) => chunk.text);
}

// Segment Markdown into heading / table / paragraph blocks. Consecutive table
// rows (lines containing a pipe) are grouped so a table is one atomic block.
function markdownBlocks(text) {
  const lines = String(text).split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2].trim(), raw: line });
      i += 1;
      continue;
    }
    if (isTableRow(line)) {
      const rows = [];
      while (i < lines.length && (isTableRow(lines[i]) || isTableSeparator(lines[i]))) {
        rows.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "table", raw: rows.join("\n") });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s+/.test(lines[i].trim()) && !isTableRow(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "paragraph", raw: para.join("\n") });
  }
  return blocks;
}

function isTableRow(line) {
  const t = String(line).trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(String(line)) && line.includes("-");
}

// Build a " > "-joined heading path, replacing any same-or-deeper level.
function headingPath(current, level, title) {
  const parts = current ? current.split(" > ") : [];
  const next = parts.slice(0, level - 1);
  next[level - 1] = title;
  return next.filter(Boolean).join(" > ");
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
