# Local Agent Profile RAG

Local-first RAG for agent profiles. It accepts files, folder uploads, and pasted text, then indexes them into per-profile knowledge bases for search, context handoff, and chat.

## Quick Start

```bash
npm install
npm run dev
```

Open the Vite URL printed by `npm run dev`. The API runs on `http://127.0.0.1:8787`.

## LLM Provider

The default chat adapter uses an OpenAI-compatible HTTP API when these variables are set:

```bash
export LLM_BASE_URL="https://your-internal-llm.example/v1"
export LLM_API_KEY="..."
export LLM_MODEL="your-model"
```

If `LLM_BASE_URL` is not set, `/chat` uses a local mock answer assembled from retrieved citations. Retrieval and context endpoints work without an LLM.

## Document Worker

The Python worker can parse plain text without extra dependencies. Install optional document dependencies for PDF, Office, Excel, and image OCR:

```bash
npm run py:deps
```

OCR requires the `tesseract` binary. Legacy `.doc` and `.ppt` conversion requires LibreOffice `soffice`.
When `.venv/bin/python` exists, the API server uses it automatically for document extraction.

## Embeddings

The default backend is `local-ngram`, an offline local embedding fallback that works without model downloads. To use the planned multilingual E5 model:

```bash
npm run py:embedding-deps
export RAG_EMBEDDING_BACKEND=python-e5
export RAG_EMBEDDING_MODEL=intfloat/multilingual-e5-small
npm start
```

## API Contract

- `POST /api/profiles`
- `GET /api/profiles`
- `GET /api/profiles/:profileId/sources`
- `POST /api/profiles/:profileId/sources/files`
- `POST /api/profiles/:profileId/sources/text`
- `POST /api/profiles/:profileId/index`
- `GET /api/jobs/:jobId`
- `POST /api/profiles/:profileId/search`
- `POST /api/profiles/:profileId/context`
- `POST /api/profiles/:profileId/chat`

`/context` returns a `KnowledgeEnvelope` that can be injected into an agent profile runtime:

```json
{
  "profileId": "profile-id",
  "query": "question",
  "contextText": "[1] ...",
  "hits": [],
  "citations": [],
  "sourceVersion": "count:updatedAt"
}
```
