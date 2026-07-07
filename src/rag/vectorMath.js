import { tokenize } from "./embedding.js";

export function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let am = 0;
  let bm = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    am += a[i] * a[i];
    bm += b[i] * b[i];
  }
  if (!am || !bm) return 0;
  return dot / (Math.sqrt(am) * Math.sqrt(bm));
}

export function lexicalScore(query, text) {
  const queryTokens = [...new Set(tokenize(query).filter((token) => token.length >= 2))];
  if (!queryTokens.length) return 0;
  const haystack = String(text || "").toLowerCase().normalize("NFKC");
  const matches = queryTokens.filter((token) => haystack.includes(token)).length;
  return matches / queryTokens.length;
}

// BM25 lexical relevance over a candidate corpus, normalized to 0..1 by the
// top score so it can blend with the cosine vector score. A stronger keyword
// signal than lexicalScore's presence ratio: it weights rare query terms (idf)
// and dampens term-frequency/length. Returns one score per input text.
export function bm25Scores(query, texts) {
  const queryTokens = [...new Set(tokenize(query).filter((token) => token.length >= 2))];
  if (!queryTokens.length || !texts.length) return texts.map(() => 0);

  const docs = texts.map((text) => tokenize(text).filter((token) => token.length >= 2));
  const avgDocLength = docs.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, docs.length);
  const docFreq = new Map();

  for (const tokens of docs) {
    const unique = new Set(tokens);
    for (const token of queryTokens) {
      if (unique.has(token)) docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }

  const k1 = 1.2;
  const b = 0.75;
  const rawScores = docs.map((tokens) => {
    if (!tokens.length) return 0;
    const termFreq = new Map();
    for (const token of tokens) termFreq.set(token, (termFreq.get(token) || 0) + 1);
    return queryTokens.reduce((score, token) => {
      const freq = termFreq.get(token) || 0;
      if (!freq) return score;
      const df = docFreq.get(token) || 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      const denom = freq + k1 * (1 - b + b * (tokens.length / Math.max(1, avgDocLength)));
      return score + idf * ((freq * (k1 + 1)) / denom);
    }, 0);
  });

  const max = Math.max(...rawScores);
  if (max <= 0) return rawScores.map(() => 0);
  return rawScores.map((score) => Number((score / max).toFixed(6)));
}
