@echo off
chcp 65001 >nul
rem ARK 로컬 설치 (Windows) — 이 파일을 더블클릭하면 설치부터 실행까지 자동으로 진행합니다.
rem 사전 준비: LM Studio(https://lmstudio.ai) 설치 → 채팅/임베딩 모델 로드 → Local Server 시작.
cd /d "%~dp0.."

echo ── ARK 로컬 설치를 시작합니다 ─────────────────────────

rem 1) Node.js 확인
where node >nul 2>nul
if errorlevel 1 (
  echo ❌ Node.js가 설치되어 있지 않습니다.
  echo    지금 여는 페이지에서 LTS 버전을 설치한 뒤, 이 파일을 다시 더블클릭하세요.
  start https://nodejs.org/ko
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo ✅ Node.js %%v

rem 2) 로컬 설정 파일 (.env) — 없을 때만 LM Studio 기본값으로 생성
if not exist .env (
  copy /y .env.local-example .env >nul
  echo ✅ .env 생성 ^(LM Studio localhost 기본값^)
) else (
  echo ✅ 기존 .env 유지
)

rem 3) 의존성 설치 + 웹 빌드
echo ── 패키지 설치 중 ^(수 분 소요^) ...
call npm install
if errorlevel 1 ( echo ❌ npm install 실패 & pause & exit /b 1 )
call npm run build
if errorlevel 1 ( echo ❌ 빌드 실패 & pause & exit /b 1 )

rem 4) 서버 실행 + 브라우저 열기
echo ── 서버를 시작합니다. 이 창을 닫으면 ARK도 종료됩니다.
start "" "http://localhost:8787"
call npm start
pause
