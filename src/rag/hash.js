import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function hashText(text) {
  return createHash("sha256").update(text || "", "utf8").digest("hex");
}

export async function hashFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
