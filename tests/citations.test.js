import assert from "node:assert/strict";
import test from "node:test";
import { buildCitationGroups, buildCitationPopupHtml, highlightTerms } from "../web/src/citations.js";

test("citations are grouped by source document with counts", () => {
  const citations = [
    { number: 1, sourceId: "source-xi", title: "시진핑", score: 0.91, text: "첫 번째", query: "시진핑에 대해" },
    { number: 2, sourceId: "source-xi", title: "시진핑", score: 0.82, text: "두 번째", query: "시진핑에 대해" },
    { number: 3, sourceId: "source-other", title: "중국", score: 0.5, text: "세 번째", query: "시진핑에 대해" }
  ];

  const groups = buildCitationGroups(citations);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].title, "시진핑");
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].numbers, [1, 2]);
  assert.equal(groups[0].maxScore, 0.91);
});

test("citation popup shows every matched chunk and highlights Korean query roots", () => {
  const citations = [1, 2, 3, 4].map((number) => ({
    number,
    sourceId: "source-xi",
    title: "시진핑",
    score: 0.7 + number / 100,
    text: `검색 결과 ${number}: 시진핑은 중국의 정치인이다.`,
    query: "시진핑에 대해 알려줘"
  }));

  const [group] = buildCitationGroups(citations);
  const html = buildCitationPopupHtml(group, citations);

  assert.match(html, /시진핑\(4\)/);
  assert.match(html, /찾은 텍스트 4개/);
  assert.equal((html.match(/class="chunk-card"/g) || []).length, 4);
  assert.equal((html.match(/<mark>시진핑<\/mark>/g) || []).length, 4);
});

test("highlightTerms strips common Korean particles before marking", () => {
  assert.equal(highlightTerms("시진핑은 중국의 정치인이다.", "시진핑에 대해"), "<mark>시진핑</mark>은 중국의 정치인이다.");
});
