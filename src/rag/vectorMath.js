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
