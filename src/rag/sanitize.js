const MOJIBAKE_MARKERS = /[\u0080-\u009f]|[ÃÂ][\u0080-\u00bf]?|[íìêë][\u0080-\u00bf]/;

export function normalizeUploadedFileName(name) {
  const value = String(name || "file");
  const percentDecoded = decodePercentEncodedName(value);
  // NFC composes macOS' decomposed (NFD) Hangul jamo back into 가-힣 syllables.
  return decodeMojibakeName(percentDecoded).normalize("NFC");
}

// Allow Hangul syllables plus conjoining/compatibility jamo so decomposed Korean
// filenames survive even if they weren't normalized upstream.
const NAME_ALLOWED = /[^a-zA-Z0-9가-힣ᄀ-ᇿ㄰-㆏._ -]/g;

export function sanitizeFileName(name) {
  const cleaned = String(name || "file")
    .normalize("NFC")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(NAME_ALLOWED, "_").trim())
    .filter(Boolean)
    .join("/");
  return cleaned || "file";
}

export function basenameFromRelative(name) {
  return String(name || "file").replaceAll("\\", "/").split("/").filter(Boolean).pop() || "file";
}

function decodePercentEncodedName(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeMojibakeName(value) {
  if (!MOJIBAKE_MARKERS.test(value)) return value;
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  if (decoded.includes("�")) return value;
  return filenameScore(decoded) > filenameScore(value) ? decoded : value;
}

function filenameScore(value) {
  const text = String(value || "");
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[a-zA-Z0-9._ -]/g) || []).length;
  const controls = (text.match(/[\u0000-\u001f\u007f-\u009f]/g) || []).length;
  const mojibake = (text.match(/[ÃÂíìêë]/g) || []).length;
  return hangul * 4 + latin - controls * 8 - mojibake * 2;
}
