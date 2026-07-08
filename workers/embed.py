#!/usr/bin/env python3
import json
import sys


def main():
    # Node pipes UTF-8 in/out; Windows defaults these to cp949, which corrupts
    # non-ASCII text (e.g. Korean chunks) on read and can crash on write.
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

    request = json.loads(sys.stdin.read() or "{}")
    model_name = request.get("model") or "intfloat/multilingual-e5-small"
    texts = request.get("texts") or []
    mode = request.get("mode") or "passage"

    try:
        from sentence_transformers import SentenceTransformer
    except Exception as exc:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "error": f"sentence-transformers is not installed: {exc}. Run `npm run py:embedding-deps`.",
                },
                ensure_ascii=False,
            )
        )
        return

    prefixed = [prefix_text(text, mode) for text in texts]
    model = SentenceTransformer(model_name)
    vectors = model.encode(prefixed, normalize_embeddings=True).tolist()
    print(json.dumps({"status": "ok", "embeddings": vectors}, ensure_ascii=False))


def prefix_text(text, mode):
    text = str(text or "")
    if mode == "query":
        return f"query: {text}"
    return f"passage: {text}"


if __name__ == "__main__":
    main()
