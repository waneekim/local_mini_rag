const EXTRACT_PROMPT =
  "You are an OCR engine for UI screenshots. Output ONLY the exact text visible in the image, " +
  "preserving line breaks and order. Do not translate, summarize, describe, or add anything. " +
  "If there is no text, output nothing.";

// Extract text from an image using an OpenAI-compatible vision chat endpoint.
// Reuses the active preset's LLM base URL / API key; the vision model id comes
// from the preset (llm.visionModel) or the VISION_MODEL env var.
export async function extractTextFromImage(image, { llm } = {}) {
  const dataUrl = String(image || "").trim();
  if (!dataUrl) throw Object.assign(new Error("이미지가 없습니다."), { statusCode: 400 });

  const baseUrl = llm?.baseUrl || process.env.LLM_BASE_URL || "";
  const apiKey = llm?.apiKey || process.env.LLM_API_KEY || "";
  const model = llm?.visionModel || process.env.VISION_MODEL || "";
  if (!baseUrl) throw Object.assign(new Error("LLM 서버 URL이 설정되지 않았습니다."), { statusCode: 400 });
  if (!model) {
    throw Object.assign(
      new Error("비전 모델이 설정되지 않았습니다. 설정에서 비전 모델을 입력하고 LM Studio에 VL 모델을 로드하세요."),
      { statusCode: 400 }
    );
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: EXTRACT_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "이 이미지에 보이는 텍스트를 그대로 출력해줘." },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    }),
    signal: AbortSignal.timeout(Number(process.env.VISION_TIMEOUT_MS || 60_000))
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error?.message || payload.error || `Vision HTTP ${response.status}`), {
      statusCode: 502
    });
  }
  return (payload.choices?.[0]?.message?.content || "").trim();
}
