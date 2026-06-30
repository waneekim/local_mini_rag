#!/usr/bin/env python3
"""Sample skill: reformat the previous RAG answer into a UX review report.

Reads a JSON payload from stdin:
  { "query", "answer", "citations": [...], "messages": [...], "profileId", "agent" }

Writes the transformed result to stdout. Either plain text, or a JSON object
{ "output": "...", "format": "markdown" }.
"""
import json
import sys
from datetime import date


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    answer = (payload.get("answer") or "").strip()
    query = (payload.get("query") or "").strip()
    citations = payload.get("citations") or []

    if not answer:
        print(json.dumps({"output": "직전 답변이 없어 리포트를 만들 수 없습니다.", "format": "text"}, ensure_ascii=False))
        return

    lines = [
        "# UX 검토 리포트",
        "",
        f"- 작성일: {date.today().isoformat()}",
        f"- 원 질문: {query or '(없음)'}",
        f"- 참조 문서: {len(citations)}건",
        "",
        "## 핵심 내용",
        "",
        answer,
        "",
        "## 근거",
        "",
    ]
    if citations:
        for c in citations:
            num = c.get("number", "?")
            title = c.get("title", "")
            lines.append(f"- [{num}] {title}")
    else:
        lines.append("- (인용 없음)")

    lines += ["", "## 다음 액션", "", "- [ ] 위 내용 팀 리뷰", "- [ ] 가이드 반영 여부 확인"]

    print(json.dumps({"output": "\n".join(lines), "format": "markdown"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
