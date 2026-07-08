// Builds the offline distributable of the local RAG program that remote PCs
// download from the central server. It assembles a staging folder with the
// server source, the prebuilt web client, bundled Node dependencies, offline
// Python wheels, the setup/run scripts and the guide, then zips it into
// dist/download/ark-local-rag.zip (served by GET /api/download/local-rag).
//
// Run on the central/dev PC (needs internet only for the Python wheel download):
//   npm run package
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  statSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(projectRoot, "build", "ark-local-rag");
const outDir = join(projectRoot, "dist", "download");
const outZip = join(outDir, "ark-local-rag.zip");
const pythonCmd = process.env.PYTHON || "python";

// Files/folders copied verbatim into the bundle. node_modules is bundled so the
// target needs no `npm install`; dist/client is prebuilt so no web build either.
const INCLUDE = [
  "src",
  "workers",
  "dist/client",
  "node_modules",
  "package.json",
  "package-lock.json",
  "requirements-worker.txt",
  ".env.example",
  ".env.local-example",
  "GUIDE.md"
];

function log(msg) {
  console.log(`[package] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status})`);
  }
}

function main() {
  log("preparing staging directory…");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // 1. Ensure the web client is built (needed for the UI to work offline).
  if (!existsSync(join(projectRoot, "dist", "client", "index.html"))) {
    log("dist/client missing — running vite build…");
    run("npm", ["run", "build"], { cwd: projectRoot, shell: true });
  }

  // 2. Copy the runtime files.
  for (const rel of INCLUDE) {
    const from = join(projectRoot, rel);
    if (!existsSync(from)) {
      log(`skip (missing): ${rel}`);
      continue;
    }
    const to = join(staging, rel);
    mkdirSync(dirname(to), { recursive: true });
    log(`copy ${rel}`);
    cpSync(from, to, { recursive: true });
  }

  // 3. Download the Python wheels for offline install on the target PC.
  const wheelDir = join(staging, "vendor", "wheels");
  mkdirSync(wheelDir, { recursive: true });
  log("downloading Python wheels (needs internet)…");
  run(pythonCmd, [
    "-m",
    "pip",
    "download",
    "-r",
    join(projectRoot, "requirements-worker.txt"),
    "-d",
    wheelDir
  ]);

  // 4. Write the target-side setup/run scripts.
  writeFileSync(join(staging, "setup.bat"), SETUP_BAT.replace(/\n/g, "\r\n"));
  writeFileSync(join(staging, "run.bat"), RUN_BAT.replace(/\n/g, "\r\n"));

  // 5. Zip via the Windows system tar (bsdtar), which writes real .zip archives.
  mkdirSync(outDir, { recursive: true });
  rmSync(outZip, { force: true });
  const sysTar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  const tarCmd = existsSync(sysTar) ? sysTar : "tar";
  log("zipping…");
  run(tarCmd, ["-a", "-c", "-f", outZip, "-C", join(projectRoot, "build"), "ark-local-rag"]);

  const mb = (statSync(outZip).size / (1024 * 1024)).toFixed(1);
  log(`done → ${outZip} (${mb} MB)`);
  log("served at GET /api/download/local-rag");
}

const SETUP_BAT = `@echo off
setlocal
cd /d "%~dp0"
echo === ARK Local RAG - setup ===

where node >nul 2>nul || (echo [ERROR] Node.js가 설치되어 있지 않습니다. Node 20 이상을 설치하세요. & pause & exit /b 1)
where python >nul 2>nul || (echo [ERROR] Python이 설치되어 있지 않습니다. Python 3.12를 설치하세요. & pause & exit /b 1)

echo [1/2] 파이썬 가상환경 생성…
python -m venv .venv || (echo [ERROR] venv 생성 실패 & pause & exit /b 1)

echo [2/2] 문서 추출 패키지 오프라인 설치…
".venv\\Scripts\\python.exe" -m pip install --no-index --find-links "vendor\\wheels" -r requirements-worker.txt || (echo [ERROR] 패키지 설치 실패 & pause & exit /b 1)

echo.
echo === 설치 완료! run.bat 으로 실행하세요. ===
echo (.env.example 을 복사해 .env 를 먼저 만드세요)
pause
`;

const RUN_BAT = `@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  echo [안내] .env 파일이 없습니다. .env.example 을 복사해 .env 를 만드세요.
  echo        지금은 기본값으로 실행을 시도합니다.
)
echo 서버 시작: http://localhost:8787
node src\\server.js
pause
`;

main();
