#!/bin/bash
# ARK 로컬 설치 (macOS) — 이 파일을 더블클릭하면 설치부터 실행까지 자동으로 진행합니다.
# 사전 준비: LM Studio(https://lmstudio.ai) 설치 → 채팅/임베딩 모델 로드 → Local Server 시작.
set -e
cd "$(dirname "$0")/.."

echo "── ARK 로컬 설치를 시작합니다 ─────────────────────────"

# 1) Node.js 확인 (없으면 안내 후 다운로드 페이지 열기)
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js가 설치되어 있지 않습니다."
  echo "   지금 여는 페이지에서 LTS 버전을 설치한 뒤, 이 파일을 다시 더블클릭하세요."
  open "https://nodejs.org/ko"
  read -r -p "엔터를 누르면 종료합니다..."
  exit 1
fi
echo "✅ Node.js $(node --version)"

# 2) 로컬 설정 파일 (.env) — 없을 때만 LM Studio 기본값으로 생성
if [ ! -f .env ]; then
  cp .env.local-example .env
  echo "✅ .env 생성 (LM Studio localhost 기본값)"
else
  echo "✅ 기존 .env 유지"
fi

# 3) 의존성 설치 + 웹 빌드
echo "── 패키지 설치 중 (수 분 소요) ..."
npm install
npm run build

# 4) 서버 실행 + 브라우저 열기
echo "── 서버를 시작합니다. 이 창을 닫으면 ARK도 종료됩니다."
( sleep 2 && open "http://localhost:8787" ) &
npm start
