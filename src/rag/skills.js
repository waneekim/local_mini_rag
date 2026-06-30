import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_TIMEOUT_MS = Number(process.env.SKILL_TIMEOUT_MS || 120_000);

export class SkillService {
  constructor({ projectRoot, dataDir }) {
    this.projectRoot = projectRoot;
    this.dataDir = dataDir;
    this.skillsDir = join(projectRoot, "skills");
    this.repoCache = join(dataDir, ".skills-repo");
    this.configPath = join(dataDir, "skills.json");
    const venvPython = join(projectRoot, ".venv", "bin", "python");
    this.pythonCommand = process.env.PYTHON || (existsSync(venvPython) ? venvPython : "python3");
    mkdirSync(this.skillsDir, { recursive: true });
  }

  // ── config ──

  getConfig() {
    let repo = process.env.SKILLS_REPO || "";
    if (existsSync(this.configPath)) {
      try {
        repo = JSON.parse(readFileSync(this.configPath, "utf8")).repo ?? repo;
      } catch {
        /* ignore */
      }
    }
    return { repo };
  }

  setConfig(patch) {
    const current = this.getConfig();
    const next = { ...current, ...patch };
    writeFileSync(this.configPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  // ── registry ──

  readManifest(dir) {
    const manifestPath = join(dir, "skill.json");
    if (!existsSync(manifestPath)) return null;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!manifest.name || !manifest.entry) return null;
      return {
        name: String(manifest.name),
        description: String(manifest.description || ""),
        runtime: manifest.runtime === "node" ? "node" : "python",
        entry: String(manifest.entry),
        input: manifest.input === "conversation" ? "conversation" : "answer"
      };
    } catch {
      return null;
    }
  }

  scanDir(root) {
    if (!existsSync(root)) return [];
    const out = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const manifest = this.readManifest(join(root, entry.name));
      if (manifest) out.push({ ...manifest, dir: join(root, entry.name), folder: entry.name });
    }
    return out;
  }

  list() {
    return this.scanDir(this.skillsDir).map(({ dir, ...rest }) => rest);
  }

  getSkill(name) {
    return this.scanDir(this.skillsDir).find((s) => s.name === name || s.folder === name) || null;
  }

  // ── repo install ──

  sync() {
    const { repo } = this.getConfig();
    if (!repo) throw Object.assign(new Error("스킬 저장소(repo)가 설정되지 않았습니다."), { statusCode: 400 });
    const args = existsSync(join(this.repoCache, ".git"))
      ? ["-C", this.repoCache, "pull", "--ff-only"]
      : ["clone", "--depth", "1", repo, this.repoCache];
    const result = spawnSync("git", args, { encoding: "utf8", timeout: SKILL_TIMEOUT_MS });
    if (result.status !== 0) {
      throw Object.assign(new Error(`git ${args[0]} 실패: ${(result.stderr || "").trim()}`), { statusCode: 502 });
    }
    return this.available();
  }

  available() {
    return this.scanDir(this.repoCache).map(({ dir, ...rest }) => rest);
  }

  install(name) {
    const source = this.scanDir(this.repoCache).find((s) => s.name === name || s.folder === name);
    if (!source) throw Object.assign(new Error(`저장소에 '${name}' 스킬이 없습니다. 먼저 동기화하세요.`), { statusCode: 404 });
    const dest = join(this.skillsDir, source.folder);
    rmSync(dest, { recursive: true, force: true });
    cpSync(source.dir, dest, { recursive: true });
    return { ok: true, name: source.name };
  }

  remove(name) {
    const skill = this.getSkill(name);
    if (!skill) throw Object.assign(new Error("Skill not found"), { statusCode: 404 });
    rmSync(skill.dir, { recursive: true, force: true });
    return { ok: true };
  }

  // ── runner ──

  async run(name, payload) {
    const skill = this.getSkill(name);
    if (!skill) throw Object.assign(new Error(`설치된 스킬 '${name}'을 찾을 수 없습니다.`), { statusCode: 404 });
    const command = skill.runtime === "node" ? process.execPath : this.pythonCommand;
    const entryPath = join(skill.dir, skill.entry);
    if (!existsSync(entryPath)) throw new Error(`스킬 실행 파일이 없습니다: ${skill.entry}`);

    const input = JSON.stringify({
      query: payload.query || "",
      answer: payload.answer || "",
      citations: payload.citations || [],
      messages: payload.messages || [],
      profileId: payload.profileId || "",
      agent: payload.agent || ""
    });

    return new Promise((resolve, reject) => {
      const child = spawn(command, [entryPath], { cwd: skill.dir, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("스킬 실행 시간이 초과되었습니다."));
      }, SKILL_TIMEOUT_MS);

      child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `스킬이 코드 ${code}로 종료되었습니다.`));
          return;
        }
        const text = stdout.trim();
        let output = text;
        let format = "text";
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && "output" in parsed) {
            output = String(parsed.output);
            format = parsed.format || "markdown";
          }
        } catch {
          /* plain text output */
        }
        resolve({ name: skill.name, output, format });
      });

      child.stdin.end(input);
    });
  }
}
