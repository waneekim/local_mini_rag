import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export class WorkerClient {
  constructor({ projectRoot, pythonCommand }) {
    this.projectRoot = projectRoot;
    const venvPython = join(projectRoot, ".venv", "bin", "python");
    this.pythonCommand = pythonCommand || process.env.PYTHON || (existsSync(venvPython) ? venvPython : "python3");
    this.scriptPath = join(projectRoot, "workers", "ingest.py");
  }

  async extract(source) {
    const payload = JSON.stringify({
      sourceId: source.id,
      kind: source.kind,
      title: source.title,
      fileName: source.file_name,
      relativePath: source.relative_path,
      mimeType: source.mime_type,
      filePath: source.file_path,
      text: source.pasted_text,
      ocrLanguages: process.env.RAG_OCR_LANGUAGES || "kor+eng"
    });

    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonCommand, [this.scriptPath], {
        cwd: this.projectRoot,
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Document worker timed out"));
      }, Number(process.env.RAG_WORKER_TIMEOUT_MS || 180_000));

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Document worker exited with code ${code}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`Invalid worker JSON: ${error.message}\n${stdout}\n${stderr}`));
        }
      });

      child.stdin.end(payload);
    });
  }
}
