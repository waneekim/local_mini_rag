export function sanitizeFileName(name) {
  const cleaned = String(name || "file")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9가-힣._ -]/g, "_").trim())
    .filter(Boolean)
    .join("/");
  return cleaned || "file";
}

export function basenameFromRelative(name) {
  return String(name || "file").replaceAll("\\", "/").split("/").filter(Boolean).pop() || "file";
}
