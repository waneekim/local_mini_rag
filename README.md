# Local Agent Profile RAG

Local-first RAG for agent profiles. It accepts files, folder uploads, and pasted text, then indexes them into per-profile knowledge bases for search, context handoff, and chat.

## Quick Start

```bash
npm install
npm run dev
```

Open the Vite URL printed by `npm run dev`. The API runs on `http://127.0.0.1:8787`.

## LLM Provider

Create a local `.env` file for LLM and embeddings. The server loads `.env` automatically on startup.

```env
LLM_BASE_URL=https://your-internal-llm.example/v1
LLM_API_KEY=...
LLM_MODEL=your-chat-model

EMBEDDINGS_URL=http://ip:port/v1/embeddings
EMBEDDINGS_MODEL=your-embedding-model
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

When `EMBEDDINGS_URL` is set, indexing and search call that OpenAI-compatible embeddings endpoint. The expected request shape is:

```json
{ "model": "your-embedding-model", "input": ["text one", "text two"] }
```

The expected response is OpenAI-compatible `data[].embedding`.

If `EMBEDDINGS_URL` is not set, the default backend is `local-ngram`, an offline local embedding fallback that works without model downloads. To use a local Python E5 worker instead:

```bash
npm run py:embedding-deps
export RAG_EMBEDDING_BACKEND=python-e5
export RAG_EMBEDDING_MODEL=intfloat/multilingual-e5-small
npm start
```

The UI source badge `indexed · 6` means the source was split into 6 searchable chunks.

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
