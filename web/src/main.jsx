import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileText,
  FolderUp,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  Upload
} from "lucide-react";
import "./styles.css";

const API = "";

function App() {
  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [sources, setSources] = useState([]);
  const [health, setHealth] = useState(null);
  const [job, setJob] = useState(null);
  const [status, setStatus] = useState("대기 중");
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState(null);
  const [chatResult, setChatResult] = useState(null);
  const [textTitle, setTextTitle] = useState("");
  const [textSource, setTextSource] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId),
    [profiles, activeProfileId]
  );

  useEffect(() => {
    boot();
  }, []);

  useEffect(() => {
    if (activeProfileId) loadSources(activeProfileId);
  }, [activeProfileId]);

  useEffect(() => {
    if (!job || ["completed", "completed_with_errors", "failed"].includes(job.status)) return undefined;
    const timer = setInterval(async () => {
      const next = await fetchJson(`/api/jobs/${job.id}`);
      setJob(next);
      setStatus(next.message || next.status);
      if (["completed", "completed_with_errors", "failed"].includes(next.status)) {
        await loadSources(activeProfileId);
      }
    }, 800);
    return () => clearInterval(timer);
  }, [job, activeProfileId]);

  async function boot() {
    const [healthPayload, profilePayload] = await Promise.all([fetchJson("/v1/health"), fetchJson("/api/profiles")]);
    setHealth(healthPayload);
    if (profilePayload.length) {
      setProfiles(profilePayload);
      setActiveProfileId(profilePayload[0].id);
    } else {
      const created = await fetchJson("/api/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Default Agent Profile" })
      });
      setProfiles([created]);
      setActiveProfileId(created.id);
    }
  }

  async function createProfile() {
    const name = window.prompt("Profile name", `Agent Profile ${profiles.length + 1}`);
    if (!name) return;
    const created = await fetchJson("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    });
    setProfiles((current) => [created, ...current]);
    setActiveProfileId(created.id);
  }

  async function loadSources(profileId) {
    const payload = await fetchJson(`/api/profiles/${profileId}/sources`);
    setSources(payload);
  }

  async function uploadFiles(files) {
    if (!files?.length || !activeProfileId) return;
    setBusy(true);
    setStatus("파일 저장 중");
    try {
      const form = new FormData();
      Array.from(files).forEach((file) => {
        form.append("files", file, file.webkitRelativePath || file.name);
      });
      await fetchJson(`/api/profiles/${activeProfileId}/sources/files`, {
        method: "POST",
        body: form
      });
      await loadSources(activeProfileId);
      setStatus(`${files.length}개 파일 추가됨`);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  }

  async function addTextSource() {
    if (!textSource.trim() || !activeProfileId) return;
    setBusy(true);
    try {
      await fetchJson(`/api/profiles/${activeProfileId}/sources/text`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: textTitle || "Pasted text",
          text: textSource
        })
      });
      setTextTitle("");
      setTextSource("");
      await loadSources(activeProfileId);
      setStatus("텍스트 소스 추가됨");
    } finally {
      setBusy(false);
    }
  }

  async function startIndex() {
    if (!activeProfileId) return;
    setBusy(true);
    setStatus("인덱싱 시작");
    try {
      const payload = await fetchJson(`/api/profiles/${activeProfileId}/index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      setJob(payload);
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!query.trim() || !activeProfileId) return;
    setBusy(true);
    setStatus("검색 중");
    try {
      const payload = await fetchJson(`/api/profiles/${activeProfileId}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, topK: 8 })
      });
      setSearchResult(payload);
      setStatus(`${payload.hits.length}개 근거 검색됨`);
    } finally {
      setBusy(false);
    }
  }

  async function runChat() {
    if (!query.trim() || !activeProfileId) return;
    setBusy(true);
    setStatus("답변 생성 중");
    try {
      const payload = await fetchJson(`/api/profiles/${activeProfileId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, topK: 8 })
      });
      setChatResult(payload);
      setStatus("답변 완료");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Database size={21} aria-hidden="true" />
          <div>
            <h1>Profile RAG</h1>
            <p>{health?.llmProvider?.provider || "checking"}</p>
          </div>
        </div>

        <div className="profile-row">
          <select value={activeProfileId} onChange={(event) => setActiveProfileId(event.target.value)} aria-label="Agent profile">
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <button className="icon-button" type="button" title="프로필 추가" onClick={createProfile}>
            <Plus size={18} />
          </button>
        </div>

        <div className="source-actions">
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => uploadFiles(event.target.files)} />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            hidden
            webkitdirectory=""
            directory=""
            onChange={(event) => uploadFiles(event.target.files)}
          />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Upload size={17} />
            파일 추가
          </button>
          <button type="button" onClick={() => folderInputRef.current?.click()} disabled={busy}>
            <FolderUp size={17} />
            폴더 추가
          </button>
          <button type="button" className="secondary" onClick={startIndex} disabled={busy || !sources.length}>
            <RefreshCw size={17} />
            인덱싱
          </button>
        </div>

        <section className="paste-panel">
          <input value={textTitle} onChange={(event) => setTextTitle(event.target.value)} placeholder="텍스트 제목" />
          <textarea value={textSource} onChange={(event) => setTextSource(event.target.value)} placeholder="텍스트 붙여넣기" />
          <button type="button" onClick={addTextSource} disabled={busy || !textSource.trim()}>
            <FileText size={17} />
            텍스트 추가
          </button>
        </section>

        <section className="source-list" aria-label="Sources">
          {sources.map((source) => (
            <article key={source.id} className="source-item">
              <div>
                <strong>{source.title}</strong>
                <span>{source.relative_path || source.kind}</span>
              </div>
              <StatusPill status={source.status} count={source.chunkCount} />
            </article>
          ))}
          {!sources.length && <p className="empty">소스 없음</p>}
        </section>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p>Agent profile</p>
            <h2>{activeProfile?.name || "Profile"}</h2>
          </div>
          <span className="status-line">{status}</span>
        </header>

        <section className="query-bar">
          <textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder="문서에 대해 질문하기" />
          <div className="query-actions">
            <button type="button" className="secondary" onClick={runSearch} disabled={busy || !query.trim()}>
              <Search size={17} />
              검색
            </button>
            <button type="button" onClick={runChat} disabled={busy || !query.trim()}>
              <Send size={17} />
              대화
            </button>
          </div>
        </section>

        <div className="result-grid">
          <section className="result-panel">
            <div className="panel-title">
              <Search size={18} />
              <h3>검색 근거</h3>
            </div>
            <ResultList hits={searchResult?.hits || chatResult?.citations || []} citationMode={Boolean(chatResult?.citations)} />
          </section>

          <section className="result-panel">
            <div className="panel-title">
              <MessageSquare size={18} />
              <h3>답변</h3>
            </div>
            {chatResult ? (
              <>
                <div className="answer">{chatResult.answer}</div>
                <div className="provider">{chatResult.provider.provider} · {chatResult.provider.model}</div>
              </>
            ) : (
              <p className="empty">질문 후 대화를 실행하세요.</p>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

function StatusPill({ status, count }) {
  const ok = status === "indexed";
  const failed = status === "failed_with_action";
  return (
    <span className={`pill ${ok ? "ok" : failed ? "fail" : ""}`}>
      {ok ? <CheckCircle2 size={14} /> : failed ? <AlertTriangle size={14} /> : <RefreshCw size={14} />}
      {status}
      {count ? ` · ${count}` : ""}
    </span>
  );
}

function ResultList({ hits, citationMode }) {
  if (!hits.length) return <p className="empty">검색 결과 없음</p>;
  return (
    <div className="hits">
      {hits.map((hit, index) => {
        const number = citationMode ? hit.number : index + 1;
        return (
          <article key={hit.id || hit.chunkId || `${hit.sourceId}-${number}`} className="hit">
            <div className="hit-top">
              <span>[{number}]</span>
              <strong>{hit.title}</strong>
              {"score" in hit && <em>{hit.score}</em>}
            </div>
            <p>{hit.excerpt || hit.text}</p>
          </article>
        );
      })}
    </div>
  );
}

async function fetchJson(url, options) {
  const response = await fetch(`${API}${url}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

createRoot(document.getElementById("root")).render(<App />);
