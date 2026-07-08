import React, { useEffect, useRef, useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  Bot,
  Camera,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Database,
  Download,
  File,
  FileText,
  Folder,
  FolderTree,
  FolderUp,
  Globe,
  Link,
  Lock,
  Maximize2,
  MessageSquare,
  Minimize2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  SpellCheck,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Unlock,
  Upload,
  X,
  Zap
} from "lucide-react";
import "./styles.css";

const API = "";

const ACCEPTED_FILE_TYPES =
  ".pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xlsm,.xls,.txt,.md,.csv,.json,.html,.htm,.log,.png,.jpg,.jpeg,.tif,.tiff,.webp,.bmp";

// One-click persona templates for the simple settings view. Keys must not
// collide with the built-in modes (general/compliance/recommend).
const PERSONA_TEMPLATES = [
  {
    key: "summary",
    label: "문서 요약",
    hint: "근거 문서를 핵심만 요약",
    aliases: "요약, summary",
    system:
      "너는 문서 요약 전문가다. 컨텍스트의 근거만 사용해 핵심을 3~5개 불릿으로 요약하고, 각 불릿 끝에 근거 번호 [n]을 붙여라. 근거에 없는 내용은 추가하지 마라. 한국어로 답하라."
  },
  {
    key: "ux-writing",
    label: "UX 문구 제안",
    hint: "스타일 가이드 반영 문구 후보 제안",
    aliases: "문구, copy",
    system:
      "너는 삼성 가전 UX 라이터다. 요청한 화면 문구에 대해 컨텍스트의 스타일 가이드를 반영한 후보 3개를 제안하고, 각 후보에 선택 이유를 한 줄로 붙여라. 근거 번호 [n]을 인용하라. 한국어로 답하라."
  },
  {
    key: "glossary-chat",
    label: "용어 설명",
    hint: "용어집 기준으로 단어 뜻·용법 답변",
    aliases: "용어, term",
    system:
      "너는 UX 용어집 안내자다. 질문한 단어의 정의·용법·주의사항을 컨텍스트의 용어집 근거로만 답하고, 근거 번호 [n]을 인용하라. 용어집에 없는 단어면 '용어집에 등재되지 않은 단어'라고 명시하고 가장 가까운 승인어를 제안하라. 한국어로 답하라."
  },
  {
    key: "translate-en",
    label: "영문 변환",
    hint: "한국어 UX 문구를 영문 스타일로",
    aliases: "번역, translate",
    system:
      "너는 UX 문구 번역가다. 입력한 한국어 화면 문구를 간결한 영어 UX 문구로 바꿔라. 컨텍스트에 영문 스타일 가이드가 있으면 반영하고 근거 번호 [n]을 인용하라. 후보 2개와 추천 1개를 제시하라."
  }
];

const SUPPORTED_TYPES_TEXT = [
  "임베딩 가능한 입력:",
  "• 문서: PDF, Word(.docx), PowerPoint(.pptx), Excel(.xlsx/.xlsm)",
  "• 텍스트: .txt .md .csv .json .html .log",
  "• 이미지(OCR): .png .jpg .jpeg .tif .webp  ← Tesseract 설치 필요",
  "• 레거시 Office(.doc/.ppt/.xls)  ← LibreOffice 설치 필요",
  "• 그 밖에: 붙여넣은 텍스트, URL, 로컬 폴더/파일 경로",
  "최대 100MB/파일 · 한 번에 200개까지"
].join("\n");

function App() {
  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [sourcesByProfile, setSourcesByProfile] = useState({});
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [collapsedDirs, setCollapsedDirs] = useState(() => new Set());
  const [health, setHealth] = useState(null);
  const [job, setJob] = useState(null);
  const [status, setStatus] = useState("대기 중");
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState([]);
  const [activeCitations, setActiveCitations] = useState([]);
  const [busy, setBusy] = useState(false);
  const [modes, setModes] = useState([]);
  const [chatMode, setChatMode] = useState("general");
  const [skills, setSkills] = useState([]);
  const [skillRepo, setSkillRepo] = useState("");
  const [availableSkills, setAvailableSkills] = useState([]);
  const [skillBusy, setSkillBusy] = useState(false);
  const [agentFilter, setAgentFilter] = useState("");
  const [suggest, setSuggest] = useState(null); // { type:"mention"|"command", items, index }
  const [autoIndex, setAutoIndex] = useState(() => localStorage.getItem("rag.autoIndex") === "1");
  // Preprocess auto-approve: structure straight into indexing, skipping review.
  const [autoApprove, setAutoApprove] = useState(() => localStorage.getItem("rag.autoApprove") === "1");
  // Folder tree: when adding a folder, also index its structure as a source.
  const [folderTree, setFolderTree] = useState(() => localStorage.getItem("rag.folderTree") === "1");
  const [editingMode, setEditingMode] = useState(null); // mode being edited/created in settings
  const [crop, setCrop] = useState(null); // { src, w, h } captured screenshot to crop
  const [attachments, setAttachments] = useState([]); // pasted/captured image data URLs sent with the next prompt
  const [dragRect, setDragRect] = useState(null); // selection rect in client coords
  const [manualCompact, setManualCompact] = useState(() => {
    const p = new URLSearchParams(window.location.search).get("compact");
    if (p === "1") return true;
    if (p === "0") return false;
    return localStorage.getItem("rag.compact") === "1";
  });
  const [narrow, setNarrow] = useState(() => window.innerWidth < 900);
  const compact = manualCompact || narrow; // a narrow window auto-compacts

  function toggleCompact() {
    setManualCompact((v) => {
      const next = !v;
      localStorage.setItem("rag.compact", next ? "1" : "0");
      const url = new URL(window.location.href);
      if (next) url.searchParams.set("compact", "1");
      else url.searchParams.delete("compact");
      window.history.replaceState({}, "", url);
      return next;
    });
  }

  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");
  const [menu, setMenu] = useState(null);
  // Unified source-add modal: one entry point, one dialog with tabs for
  // file / folder / url / text / image. { pid, tab }.
  const [sourceModal, setSourceModal] = useState(null);
  const [dlgTitle, setDlgTitle] = useState("");
  const [dlgText, setDlgText] = useState("");
  const [dlgUrl, setDlgUrl] = useState("");
  const [dropTarget, setDropTarget] = useState(null);
  const [chatDragOver, setChatDragOver] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsState, setSettingsState] = useState(null);
  const [presetName, setPresetName] = useState("");
  const [settingsForm, setSettingsForm] = useState(null);
  // Simple-first settings: designers see one API-key field; the full form is
  // behind "고급 설정". Default persona survives reloads via localStorage.
  const [advancedSettings, setAdvancedSettings] = useState(false);
  const [quickKey, setQuickKey] = useState("");
  const [connTest, setConnTest] = useState(null); // null | {busy:true} | {llm:{ok,detail}, embedding:{ok,detail}}
  const [defaultMode, setDefaultMode] = useState(() => localStorage.getItem("rag.defaultMode") || "");
  // "내 PC에 설치" guide: full local package (LM Studio + ARK), no API key needed.
  const [installOpen, setInstallOpen] = useState(false);
  // In-app document viewer (double-click a source): shows what the document says.
  const [viewer, setViewer] = useState(null); // { pid, loading, data }

  // Central library (shared RAG) + admin gating for a host instance.
  const [adminRequired, setAdminRequired] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminInput, setAdminInput] = useState("");
  const [centralUrl, setCentralUrl] = useState(() => localStorage.getItem("ark.centralUrl") || "");
  const [centralList, setCentralList] = useState(null); // null=not browsed, []=browsed empty
  const [centralBusy, setCentralBusy] = useState(false);

  // Guideline rules (structured compliance) per agent.
  const [rulesModal, setRulesModal] = useState(null); // { profileId }
  const [rules, setRules] = useState([]);
  // Preprocessing agent: review/edit a source's structured Markdown before indexing.
  const [structureModal, setStructureModal] = useState(null); // { pid, source, md, busy }
  // Semantic concepts (의미·맥락 레이어).
  const [conceptModal, setConceptModal] = useState(null); // { profileId }
  const [concepts, setConcepts] = useState([]);
  const [conceptBusy, setConceptBusy] = useState(false);
  const [conceptForm, setConceptForm] = useState({ name: "", aliases: "", definition: "" });
  // Skip the draft-review stop: extracted concepts are confirmed immediately.
  const [autoConfirmConcepts, setAutoConfirmConcepts] = useState(() => localStorage.getItem("rag.autoConfirmConcepts") === "1");
  // UX glossary (word dictionary) + integrated sentence review.
  const [glossaryModal, setGlossaryModal] = useState(null); // { profileId }
  const [glossaryTerms, setGlossaryTerms] = useState([]);
  const [glossaryBusy, setGlossaryBusy] = useState(false);
  const [termForm, setTermForm] = useState({ term: "", status: "approved", preferred: "" });
  // Review workspace (검수): the designer's daily task — one text in, one
  // integrated correction report out (style rewrite + word verdicts).
  const [reviewModal, setReviewModal] = useState(null); // { profileId }
  const [reviewInput, setReviewInput] = useState("");
  const [reviewResult, setReviewResult] = useState(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [lintInput, setLintInput] = useState("");
  const [lintResult, setLintResult] = useState(null);

  // Answer feedback (self-improving memory).
  const [fbForm, setFbForm] = useState(null); // { msgId, note, correction } while giving 👎
  const [fbModal, setFbModal] = useState(null); // { profileId } review list
  const [feedbackList, setFeedbackList] = useState([]);

  const [sidebarWidth, setSidebarWidth] = useState(() => Math.max(288, Number(localStorage.getItem("rag.sidebarWidth")) || 320));
  const [citationsWidth, setCitationsWidth] = useState(() => Number(localStorage.getItem("rag.citationsWidth")) || 220);
  const [inputHeight, setInputHeight] = useState(() => Number(localStorage.getItem("rag.inputHeight")) || 64);

  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const uploadTargetRef = useRef("");
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const highlightRef = useRef(null);
  const cropImgRef = useRef(null);
  const dragStartRef = useRef(null);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId),
    [profiles, activeProfileId]
  );

  const modeAliasMap = useMemo(() => {
    const map = {};
    for (const m of modes) {
      map[m.key] = m.key;
      for (const a of m.aliases || []) map[a.toLowerCase()] = m.key;
    }
    return map;
  }, [modes]);

  const activeMode = useMemo(() => modes.find((m) => m.key === chatMode) || null, [modes, chatMode]);

  const commandList = useMemo(() => {
    const modeCmds = modes.map((m) => ({ cmd: m.label, desc: `모드 · ${m.hint}` }));
    const base = [
      { cmd: "add", desc: "텍스트 / @경로 / URL을 소스로 추가" },
      { cmd: "del", desc: "소스 삭제 (@소스명)" },
      { cmd: "embed", desc: "임베딩 (@소스 / @all / @except)" },
      { cmd: "list", desc: "전체 소스 목록" },
      { cmd: "embed-list", desc: "임베딩된(대화재료) 소스" },
      { cmd: "no-embed-list", desc: "임베딩 안 된 소스" },
      { cmd: "types", desc: "임베딩 가능한 파일 형식" },
      { cmd: "autoindex", desc: "추가 시 자동 임베딩 켜기/끄기" },
      { cmd: "autoapprove", desc: "전처리 자동 승인(검토 없이 색인) 켜기/끄기" },
      { cmd: "foldertree", desc: "폴더 추가 시 폴더 구조를 소스로 색인 켜기/끄기" },
      { cmd: "skills", desc: "설치된 스킬 목록" },
      { cmd: "help", desc: "도움말" }
    ];
    const skillCmds = skills.map((s) => ({ cmd: s.name, desc: `스킬 · ${s.description || ""}` }));
    return [...modeCmds, ...base, ...skillCmds];
  }, [modes, skills]);

  useEffect(() => { boot(); }, []);

  useEffect(() => {
    function onResize() { setNarrow(window.innerWidth < 900); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Keep the shown model name current (e.g. after a preset/model change) on refocus.
  useEffect(() => {
    function refresh() {
      if (!document.hidden) fetchJson("/v1/health").then(setHealth).catch(() => {});
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // When searching, lazy-load every agent's sources so source-name matching works.
  useEffect(() => {
    if (!agentFilter.trim()) return;
    for (const p of profiles) {
      if (!sourcesByProfile[p.id]) loadSources(p.id);
    }
  }, [agentFilter, profiles]);

  // Live progress via SSE: subscribe to the active agent's event stream and
  // refresh its source tree as indexing jobs advance (no polling needed). The
  // stream is best-effort — if it drops, the existing job polling still works.
  useEffect(() => {
    if (!activeProfileId) return;
    let es;
    try {
      es = new EventSource(`${API}/api/profiles/${activeProfileId}/events`);
    } catch {
      return;
    }
    const onJob = () => loadSources(activeProfileId);
    es.addEventListener("job", onJob);
    es.addEventListener("source", onJob);
    es.onerror = () => { /* browser auto-reconnects; ignore transient drops */ };
    return () => { es.close(); };
  }, [activeProfileId]);

  useEffect(() => {
    function onClick() { setMenu(null); }
    function onKey(e) { if (e.key === "Escape") { setMenu(null); setSourceModal(null); setCrop(null); setDragRect(null); } }
    // Paste a screenshot image anywhere in the app → extract text (native ⌃⌘⇧4 → ⌘V).
    function onPaste(e) {
      const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => attachImage(reader.result);
      reader.readAsDataURL(file);
    }
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, []);

  useEffect(() => {
    if (!job || ["completed", "completed_with_errors", "failed"].includes(job.status)) return;
    const timer = setInterval(async () => {
      const next = await fetchJson(`/api/jobs/${job.id}`);
      setJob(next);
      setStatus(next.message || next.status);
      if (["completed", "completed_with_errors", "failed"].includes(next.status)) {
        if (job.profile_id) loadSources(job.profile_id);
      }
    }, 800);
    return () => clearInterval(timer);
  }, [job]);

  async function boot() {
    const [healthPayload, profilePayload, modePayload, skillPayload, authPayload] = await Promise.all([
      fetchJson("/v1/health"),
      fetchJson("/api/profiles"),
      fetchJson("/api/modes").catch(() => []),
      fetchJson("/api/skills").catch(() => []),
      fetchJson("/api/auth").catch(() => ({ adminRequired: false }))
    ]);
    setHealth(healthPayload);
    setModes(modePayload);
    setSkills(skillPayload);
    setAdminRequired(Boolean(authPayload.adminRequired));
    if (authPayload.adminRequired && localStorage.getItem("ark.adminToken")) {
      fetchJson("/api/auth/verify", { method: "POST" })
        .then((r) => setIsAdmin(Boolean(r.ok)))
        .catch(() => {});
    }
    let list = profilePayload;
    if (!list.length) {
      const created = await fetchJson("/api/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Default Agent Profile" })
      });
      list = [created];
    }
    setProfiles(list);
    const first = list[0].id;
    setActiveProfileId(first);
    setExpandedIds(new Set([first]));
    loadSources(first);
  }

  async function createProfile() {
    const name = window.prompt("Agent 이름", `Agent ${profiles.length + 1}`);
    if (!name) return;
    const created = await fetchJson("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    });
    setProfiles((prev) => [created, ...prev]);
    selectAgent(created.id);
  }

  function startRename(p, e) {
    e.stopPropagation();
    setEditingId(p.id);
    setEditingName(p.name);
  }

  async function commitRename() {
    const id = editingId;
    const name = editingName.trim();
    setEditingId("");
    const profile = profiles.find((p) => p.id === id);
    if (!id || !name || (profile && profile.name === name)) return;
    const updated = await fetchJson(`/api/profiles/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    });
    setProfiles((prev) => prev.map((p) => (p.id === id ? updated : p)));
  }

  async function deleteProfile(p, e) {
    e.stopPropagation();
    if (!window.confirm(`'${p.name}' Agent와 모든 소스를 삭제할까요?`)) return;
    await fetchJson(`/api/profiles/${p.id}`, { method: "DELETE" });
    const next = profiles.filter((x) => x.id !== p.id);
    setProfiles(next);
    setSourcesByProfile((prev) => {
      const copy = { ...prev };
      delete copy[p.id];
      return copy;
    });
    if (p.id === activeProfileId) {
      const fallback = next[0]?.id || "";
      setActiveProfileId(fallback);
      setMessages([]);
      setActiveCitations([]);
      if (fallback) {
        setExpandedIds(new Set([fallback]));
        loadSources(fallback);
      }
    }
    setStatus(`삭제됨: ${p.name}`);
  }

  async function unlockAdmin() {
    const token = adminInput.trim();
    if (!token) return;
    localStorage.setItem("ark.adminToken", token);
    try {
      const r = await fetchJson("/api/auth/verify", { method: "POST" });
      if (r.ok) {
        setIsAdmin(true);
        setAdminInput("");
        setStatus("관리자 인증됨 · 중앙 편집 가능");
      } else {
        localStorage.removeItem("ark.adminToken");
        setIsAdmin(false);
        setStatus("관리자 암호가 올바르지 않습니다.");
      }
    } catch (error) {
      setStatus(`인증 실패: ${error.message}`);
    }
  }

  function lockAdmin() {
    localStorage.removeItem("ark.adminToken");
    setIsAdmin(false);
    setStatus("관리자 로그아웃");
  }

  async function togglePublish(p, e) {
    e?.stopPropagation();
    const next = !p.published;
    try {
      const updated = await fetchJson(`/api/profiles/${p.id}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ published: next })
      });
      setProfiles((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
      setStatus(next ? `중앙에 발행됨: ${p.name}` : `발행 취소됨: ${p.name}`);
    } catch (error) {
      setStatus(`발행 변경 실패: ${error.message}`);
    }
  }

  async function browseCentral() {
    const url = centralUrl.trim();
    if (!url) return;
    setCentralBusy(true);
    setStatus("중앙 서버 조회 중…");
    try {
      const r = await fetchJson("/api/central/browse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remoteUrl: url })
      });
      localStorage.setItem("ark.centralUrl", r.remoteUrl || url);
      setCentralUrl(r.remoteUrl || url);
      setCentralList(r.profiles || []);
      setStatus(`중앙 에이전트 ${r.profiles?.length || 0}개`);
    } catch (error) {
      setCentralList([]);
      setStatus(`조회 실패: ${error.message}`);
    } finally {
      setCentralBusy(false);
    }
  }

  async function importCentral(remote) {
    setCentralBusy(true);
    setStatus(`'${remote.name}' 복제 중…`);
    try {
      const r = await fetchJson("/api/central/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remoteUrl: centralUrl.trim(), profileId: remote.id })
      });
      setProfiles((prev) => [r.profile, ...prev]);
      selectAgent(r.profile.id);
      setStatus(r.reembedded ? `복제 완료(로컬 재임베딩): ${r.profile.name}` : `복제 완료: ${r.profile.name}`);
    } catch (error) {
      setStatus(`복제 실패: ${error.message}`);
    } finally {
      setCentralBusy(false);
    }
  }

  async function openRules(pid) {
    setRulesModal({ profileId: pid });
    setLintInput("");
    setLintResult(null);
    setRules([]);
    try {
      setRules(await fetchJson(`/api/profiles/${pid}/rules`));
    } catch (error) {
      setStatus(`규칙 로드 실패: ${error.message}`);
    }
  }

  async function extractRules() {
    const pid = rulesModal?.profileId;
    if (!pid) return;
    setRuleBusy(true);
    setStatus("가이드에서 규칙 추출 중… (문서가 길면 걸립니다)");
    try {
      const r = await fetchJson(`/api/profiles/${pid}/rules/extract`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      setRules(await fetchJson(`/api/profiles/${pid}/rules`));
      setStatus(`규칙 ${r.created}개 초안 생성됨 — 검토 후 승인하세요`);
    } catch (error) {
      setStatus(`규칙 추출 실패: ${error.message}`);
    } finally {
      setRuleBusy(false);
    }
  }

  async function patchRule(ruleId, patch) {
    const pid = rulesModal?.profileId;
    const updated = await fetchJson(`/api/profiles/${pid}/rules/${ruleId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    setRules((prev) => prev.map((r) => (r.id === ruleId ? updated : r)));
  }

  async function deleteRule(ruleId) {
    const pid = rulesModal?.profileId;
    await fetchJson(`/api/profiles/${pid}/rules/${ruleId}`, { method: "DELETE" });
    setRules((prev) => prev.filter((r) => r.id !== ruleId));
  }

  async function runLint() {
    const pid = rulesModal?.profileId;
    if (!pid || !lintInput.trim()) return;
    try {
      setLintResult(await fetchJson(`/api/profiles/${pid}/lint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: lintInput }) }));
    } catch (error) {
      setStatus(`검사 실패: ${error.message}`);
    }
  }

  // ── Semantic concepts (의미·맥락 레이어) ──

  async function openConcepts(pid) {
    setConceptModal({ profileId: pid });
    setConceptForm({ name: "", aliases: "", definition: "" });
    setConcepts([]);
    try {
      setConcepts(await fetchJson(`/api/profiles/${pid}/concepts`));
    } catch (error) {
      setStatus(`개념 로드 실패: ${error.message}`);
    }
  }

  async function addConcept() {
    const pid = conceptModal?.profileId;
    if (!pid || !conceptForm.name.trim()) return;
    try {
      await fetchJson(`/api/profiles/${pid}/concepts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(conceptForm)
      });
      setConcepts(await fetchJson(`/api/profiles/${pid}/concepts`));
      setConceptForm({ name: "", aliases: "", definition: "" });
      setStatus("개념 저장됨 — 소스 연결까지 자동 갱신");
    } catch (error) {
      setStatus(`개념 저장 실패: ${error.message}`);
    }
  }

  async function patchConcept(conceptId, patch) {
    const pid = conceptModal?.profileId;
    const updated = await fetchJson(`/api/profiles/${pid}/concepts/${conceptId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    setConcepts((prev) => prev.map((c) => (c.id === conceptId ? updated : c)));
  }

  async function deleteConcept(conceptId) {
    const pid = conceptModal?.profileId;
    await fetchJson(`/api/profiles/${pid}/concepts/${conceptId}`, { method: "DELETE" });
    setConcepts((prev) => prev.filter((c) => c.id !== conceptId));
  }

  function toggleAutoConfirmConcepts(value) {
    const next = typeof value === "boolean" ? value : !autoConfirmConcepts;
    setAutoConfirmConcepts(next);
    localStorage.setItem("rag.autoConfirmConcepts", next ? "1" : "0");
  }

  async function extractConcepts() {
    const pid = conceptModal?.profileId;
    if (!pid) return;
    setConceptBusy(true);
    setStatus("소스에서 개념(동의어·변형 표기) 추출 중… (문서가 길면 걸립니다)");
    try {
      const r = await fetchJson(`/api/profiles/${pid}/concepts/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoConfirm: autoConfirmConcepts })
      });
      setConcepts(await fetchJson(`/api/profiles/${pid}/concepts`));
      setStatus(
        r.autoConfirmed
          ? `개념 ${r.created}개 추출·자동 확정됨 — 검색에 바로 반영`
          : `개념 ${r.created}개 초안 생성됨 — 검토 후 확정하세요`
      );
    } catch (error) {
      setStatus(`개념 추출 실패: ${error.message}`);
    } finally {
      setConceptBusy(false);
    }
  }

  // Consolidated card for one concept (cross-source summary + conflicts).
  async function generateCard(conceptId) {
    const pid = conceptModal?.profileId;
    if (!pid) return;
    setConceptBusy(true);
    setStatus("정리 카드 생성 중… (여러 소스 종합)");
    try {
      const updated = await fetchJson(`/api/profiles/${pid}/concepts/${conceptId}/card`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      setConcepts((prev) => prev.map((c) => (c.id === conceptId ? updated : c)));
      setStatus("정리 카드 생성됨 — 검색에도 반영됩니다");
    } catch (error) {
      setStatus(`카드 생성 실패: ${error.message}`);
    } finally {
      setConceptBusy(false);
    }
  }

  async function generateAllCards() {
    const pid = conceptModal?.profileId;
    if (!pid) return;
    try {
      const job = await fetchJson(`/api/profiles/${pid}/concepts/cards`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      setJob(job);
      setStatus(`확정 개념 ${job.total_sources}개 카드 생성 시작`);
    } catch (error) {
      setStatus(`카드 잡 시작 실패: ${error.message}`);
    }
  }

  // ── UX glossary + integrated review ──

  async function openGlossary(pid) {
    setGlossaryModal({ profileId: pid });
    setTermForm({ term: "", status: "approved", preferred: "" });
    setReviewInput("");
    setReviewResult(null);
    setGlossaryTerms([]);
    try {
      setGlossaryTerms(await fetchJson(`/api/profiles/${pid}/glossary`));
    } catch (error) {
      setStatus(`용어집 로드 실패: ${error.message}`);
    }
  }

  async function addGlossaryTerm() {
    const pid = glossaryModal?.profileId;
    if (!pid || !termForm.term.trim()) return;
    try {
      await fetchJson(`/api/profiles/${pid}/glossary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(termForm)
      });
      setGlossaryTerms(await fetchJson(`/api/profiles/${pid}/glossary`));
      setTermForm({ term: "", status: "approved", preferred: "" });
    } catch (error) {
      setStatus(`용어 추가 실패: ${error.message}`);
    }
  }

  async function patchGlossaryTerm(termId, patch) {
    const pid = glossaryModal?.profileId;
    const updated = await fetchJson(`/api/profiles/${pid}/glossary/${termId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    setGlossaryTerms((prev) => prev.map((t) => (t.id === termId ? updated : t)));
  }

  async function deleteGlossaryTerm(termId) {
    const pid = glossaryModal?.profileId;
    await fetchJson(`/api/profiles/${pid}/glossary/${termId}`, { method: "DELETE" });
    setGlossaryTerms((prev) => prev.filter((t) => t.id !== termId));
  }

  async function extractGlossary() {
    const pid = glossaryModal?.profileId;
    if (!pid) return;
    setGlossaryBusy(true);
    setStatus("용어집 페이지에서 단어 추출 중… (문서가 길면 걸립니다)");
    try {
      const r = await fetchJson(`/api/profiles/${pid}/glossary/extract`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      setGlossaryTerms(await fetchJson(`/api/profiles/${pid}/glossary`));
      setStatus(`용어 ${r.created}개 초안 생성됨 — 검토 후 확정하세요`);
    } catch (error) {
      setStatus(`용어 추출 실패: ${error.message}`);
    } finally {
      setGlossaryBusy(false);
    }
  }

  function openReview(pid) {
    setReviewModal({ profileId: pid });
    setReviewInput("");
    setReviewResult(null);
  }

  // Integrated review: glossary word verdicts + style-guide rewrite in one pass.
  async function runReview() {
    const pid = reviewModal?.profileId;
    if (!pid || !reviewInput.trim() || reviewBusy) return;
    setReviewBusy(true);
    setReviewResult(null);
    try {
      setReviewResult(await fetchJson(`/api/profiles/${pid}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: reviewInput, topK: 4 })
      }));
    } catch (error) {
      setStatus(`검수 실패: ${error.message}`);
    } finally {
      setReviewBusy(false);
    }
  }

  // Pull just the corrected sentence out of the LLM's "교정문: … / 이유: …" answer.
  function extractRewrite(answer) {
    const match = /교정문[:：]?\s*(.+)/.exec(String(answer || ""));
    return (match ? match[1] : String(answer || "")).trim().replace(/^["'「]|["'」]$/g, "");
  }

  // Split the original text into plain/marked segments from the review's term
  // and missing-word offsets, so issues underline in place (mockup anatomy).
  function markSegments(text, result) {
    const marks = [
      ...(result.terms || []).filter((t) => t.status !== "approved").map((t) => ({
        offset: t.offset, length: t.surface.length, sev: t.status === "forbidden" ? "crit" : "warn",
        tip: `${t.status === "forbidden" ? "금지어" : "비권장어"}${t.preferred ? ` → ${t.preferred}` : ""}`
      })),
      ...(result.missing || []).map((m) => ({
        offset: m.offset, length: m.surface.length, sev: "crit", tip: `용어집에 없음: ${m.base}`
      }))
    ]
      .filter((m) => Number.isInteger(m.offset) && m.offset >= 0)
      .sort((a, b) => a.offset - b.offset);
    const segments = [];
    let cursor = 0;
    for (const mark of marks) {
      if (mark.offset < cursor) continue; // skip overlaps
      if (mark.offset > cursor) segments.push({ text: text.slice(cursor, mark.offset) });
      segments.push({ text: text.slice(mark.offset, mark.offset + mark.length), sev: mark.sev, tip: mark.tip });
      cursor = mark.offset + mark.length;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor) });
    return segments;
  }

  async function rateMessage(msg, rating) {
    if (rating < 0) {
      setFbForm({ msgId: msg.id, note: "", correction: "" });
      return;
    }
    await submitFeedback(msg, 1, "", "");
  }

  async function submitFeedback(msg, rating, note, correction) {
    const pid = msg.profileId || activeProfileId;
    if (!pid) return;
    try {
      await fetchJson(`/api/profiles/${pid}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: msg.id, rating, query: msg.query || "", answer: msg.content, mode: msg.mode, note, correction })
      });
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, feedback: rating } : m)));
      setFbForm(null);
      setStatus(rating > 0 ? "좋은 답변으로 기록됨 · 학습 메모리에 반영" : "개선점으로 기록됨 · 다음 비슷한 질문에 반영");
    } catch (error) {
      setStatus(`피드백 저장 실패: ${error.message}`);
    }
  }

  async function openFeedback(pid) {
    setFbModal({ profileId: pid });
    setFeedbackList([]);
    try {
      setFeedbackList(await fetchJson(`/api/profiles/${pid}/feedback`));
    } catch (error) {
      setStatus(`피드백 로드 실패: ${error.message}`);
    }
  }

  async function removeFeedback(fbId) {
    const pid = fbModal?.profileId;
    await fetchJson(`/api/profiles/${pid}/feedback/${fbId}`, { method: "DELETE" });
    setFeedbackList((prev) => prev.filter((f) => f.id !== fbId));
  }

  async function loadSources(pid) {
    const payload = await fetchJson(`/api/profiles/${pid}/sources`);
    setSourcesByProfile((prev) => ({ ...prev, [pid]: payload }));
    return payload;
  }

  function selectAgent(pid) {
    if (pid !== activeProfileId) {
      setActiveProfileId(pid);
      setMessages([]);
      setActiveCitations([]);
    }
    if (!expandedIds.has(pid)) {
      const next = new Set(expandedIds);
      next.add(pid);
      setExpandedIds(next);
      loadSources(pid);
    }
  }

  function toggleExpand(pid) {
    const next = new Set(expandedIds);
    if (next.has(pid)) {
      next.delete(pid);
    } else {
      next.add(pid);
      loadSources(pid);
    }
    setExpandedIds(next);
  }

  function toggleDir(path) {
    const next = new Set(collapsedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsedDirs(next);
  }

  // ── Source operations ──

  async function uploadEntries(entries, pid) {
    if (!entries.length || !pid) return;
    setBusy(true);
    setStatus("파일 저장 중");
    try {
      const form = new FormData();
      for (const { file, name } of entries) form.append("files", file, name);
      form.append("useTree", folderTree ? "1" : "0");
      const res = await fetchJson(`/api/profiles/${pid}/sources/files`, { method: "POST", body: form });
      await loadSources(pid);
      setStatus(`${res.sources.length}개 파일 추가됨`);
      await maybeAutoIndex(res.sources.map((s) => s.id), pid);
    } catch (e) {
      pushSystem(`오류: ${e.message}`);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  }

  async function addPath(path, pid) {
    setBusy(true);
    setStatus("경로에서 소스 추가 중");
    try {
      const res = await fetchJson(`/api/profiles/${pid}/sources/path`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, useTree: folderTree })
      });
      await loadSources(pid);
      setStatus(`${res.sources.length}개 소스 추가됨`);
      await maybeAutoIndex(res.sources.map((s) => s.id), pid);
      return res.sources.length;
    } finally {
      setBusy(false);
    }
  }

  async function addText(title, text, pid) {
    const source = await fetchJson(`/api/profiles/${pid}/sources/text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, text })
    });
    await loadSources(pid);
    await maybeAutoIndex([source.id], pid);
    return source;
  }

  async function addUrl(url, title, pid) {
    setBusy(true);
    setStatus("URL 가져오는 중");
    try {
      const source = await fetchJson(`/api/profiles/${pid}/sources/url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, title })
      });
      await loadSources(pid);
      setStatus(`URL 소스 추가됨: ${source.title}`);
      await maybeAutoIndex([source.id], pid);
      return source;
    } finally {
      setBusy(false);
    }
  }

  // ── Pasted / captured image → attach to the next prompt ──
  // The image rides along with the message and is shown to the vision model
  // together with the text (no pre-OCR). Displayed as a chip above the composer.

  async function attachImage(dataUrl) {
    try {
      const image = await downscaleImage(dataUrl);
      setAttachments((prev) => [...prev, image]);
      setStatus("이미지 첨부됨 · 프롬프트와 함께 전송됩니다");
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (e) {
      setStatus(`이미지 첨부 오류: ${e.message}`);
    }
  }

  function removeAttachment(index) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  async function captureScreenshot() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      window.alert("이 브라우저는 화면 캡처를 지원하지 않습니다. 대신 스크린샷을 복사해 붙여넣으세요(⌘V).");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch {
      return; // user cancelled
    }
    const video = document.createElement("video");
    video.srcObject = stream;
    await video.play();
    const w = video.videoWidth;
    const h = video.videoHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);
    stream.getTracks().forEach((t) => t.stop());
    setCrop({ src: canvas.toDataURL("image/png"), w, h });
  }

  function onCropDown(e) {
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    setDragRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  }

  function onCropMove(e) {
    const s = dragStartRef.current;
    if (!s) return;
    setDragRect({ x: Math.min(s.x, e.clientX), y: Math.min(s.y, e.clientY), w: Math.abs(e.clientX - s.x), h: Math.abs(e.clientY - s.y) });
  }

  async function onCropUp() {
    const rect = dragRect;
    dragStartRef.current = null;
    if (!rect || rect.w < 5 || rect.h < 5 || !cropImgRef.current) {
      setDragRect(null);
      return;
    }
    const b = cropImgRef.current.getBoundingClientRect();
    const scaleX = crop.w / b.width;
    const scaleY = crop.h / b.height;
    const sx = Math.max(0, (rect.x - b.left) * scaleX);
    const sy = Math.max(0, (rect.y - b.top) * scaleY);
    const sw = Math.min(crop.w - sx, rect.w * scaleX);
    const sh = Math.min(crop.h - sy, rect.h * scaleY);
    const src = crop.src;
    setDragRect(null);
    setCrop(null);
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = Math.round(sw);
    c.height = Math.round(sh);
    c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    await attachImage(c.toDataURL("image/png"));
  }


  function toggleAutoIndex(value) {
    const next = typeof value === "boolean" ? value : !autoIndex;
    setAutoIndex(next);
    localStorage.setItem("rag.autoIndex", next ? "1" : "0");
    return next;
  }

  async function maybeAutoIndex(sourceIds, pid) {
    if (!autoIndex || !sourceIds?.length) return;
    await embedSources(sourceIds, pid);
  }

  async function removeSource(source) {
    await fetchJson(`/api/profiles/${source.profile_id}/sources/${source.id}`, { method: "DELETE" });
    await loadSources(source.profile_id);
    setStatus(`삭제됨: ${source.title}`);
  }

  async function embedSources(sourceIds, pid) {
    if (!sourceIds.length) return;
    const payload = await fetchJson(`/api/profiles/${pid}/index`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceIds })
    });
    setJob(payload);
    setStatus(`임베딩 중 (${sourceIds.length}개)`);
  }

  // Run the structuring (preprocessing) agent over sources: extract meaning and
  // rebuild them as clean Markdown for review before indexing. Reuses the shared
  // job poller, which reloads sources when the job finishes.
  async function structureSources(sourceIds, pid, { autoIndex: forceAuto } = {}) {
    if (!sourceIds.length) return;
    const auto = forceAuto ?? autoApprove;
    const payload = await fetchJson(`/api/profiles/${pid}/preprocess`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceIds, autoIndex: auto })
    });
    setJob(payload);
    setStatus(`구조화(전처리)${auto ? " · 자동 색인" : ""} 중 (${sourceIds.length}개)`);
  }

  function toggleAutoApprove(value) {
    const next = typeof value === "boolean" ? value : !autoApprove;
    setAutoApprove(next);
    localStorage.setItem("rag.autoApprove", next ? "1" : "0");
  }

  function toggleFolderTree(value) {
    const next = typeof value === "boolean" ? value : !folderTree;
    setFolderTree(next);
    localStorage.setItem("rag.folderTree", next ? "1" : "0");
  }

  // Open a source's original content in a new tab.
  function openSourceRaw(source) {
    window.open(`/api/profiles/${source.profile_id}/sources/${source.id}/raw`, "_blank", "noopener");
  }

  // Double-click a source → in-app viewer with the document's readable content
  // (reviewed Markdown / extracted text — works for xlsx·docx·pdf too).
  async function openSourceViewer(source) {
    setViewer({ pid: source.profile_id, loading: true, data: { title: source.title } });
    try {
      const data = await fetchJson(`/api/profiles/${source.profile_id}/sources/${source.id}/content`);
      setViewer({ pid: source.profile_id, loading: false, data });
    } catch (e) {
      setViewer(null);
      setStatus(`문서 열기 실패: ${e.message}`);
    }
  }

  // Open the review editor with the source's current structured Markdown.
  async function openStructure(pid, sourceId) {
    const list = sourcesByProfile[pid] || (await loadSources(pid));
    const source = list.find((s) => s.id === sourceId);
    if (!source) return;
    setStructureModal({ pid, source, md: source.normalized_md || "", busy: false });
  }

  async function saveStructure() {
    if (!structureModal) return;
    setStructureModal((m) => ({ ...m, busy: true }));
    try {
      await fetchJson(`/api/profiles/${structureModal.pid}/sources/${structureModal.source.id}/normalized`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: structureModal.md })
      });
      await loadSources(structureModal.pid);
      setStatus("구조화 저장됨 — 이제 임베딩하면 이 마크다운으로 색인됩니다");
      setStructureModal(null);
    } catch (e) {
      setStatus(`구조화 저장 오류: ${e.message}`);
      setStructureModal((m) => ({ ...m, busy: false }));
    }
  }

  async function embedAll(pid, onlyPending = false) {
    let list = sourcesByProfile[pid];
    if (!list) list = await loadSources(pid);
    const targets = onlyPending ? list.filter((s) => s.status !== "indexed") : list;
    if (!targets.length) {
      setStatus(onlyPending ? "임베딩할 새 소스가 없습니다" : "임베딩할 소스가 없습니다");
      return;
    }
    await embedSources(targets.map((s) => s.id), pid);
  }

  function pickFiles(pid) {
    uploadTargetRef.current = pid;
    fileInputRef.current?.click();
  }

  function pickFolder(pid) {
    uploadTargetRef.current = pid;
    folderInputRef.current?.click();
  }

  // ── Drag & drop ──

  async function onDropFiles(e, pid) {
    e.preventDefault();
    setDropTarget(null);
    setChatDragOver(false);
    const entries = await collectEntries(e.dataTransfer);
    if (entries.length) await uploadEntries(entries, pid);
  }

  async function copySourceTo(sourceId, fromProfileId, targetPid) {
    if (!sourceId || !targetPid || fromProfileId === targetPid) return;
    setBusy(true);
    setStatus("소스 복사 중");
    try {
      const copy = await fetchJson(`/api/profiles/${targetPid}/sources/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId, fromProfileId })
      });
      await loadSources(targetPid);
      setStatus(`소스 복사됨: ${copy.title}`);
    } catch (e) {
      pushSystem(`복사 오류: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  // Chat-area drop: a screenshot image → vision-validate; other files → add as source.
  async function onChatDrop(e) {
    const files = [...(e.dataTransfer?.files || [])];
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length && images.length === files.length) {
      e.preventDefault();
      setChatDragOver(false);
      const reader = new FileReader();
      reader.onload = () => extractFromImage(reader.result);
      reader.readAsDataURL(images[0]);
      return;
    }
    await onDropFiles(e, activeProfileId);
  }

  // Agent drop: a source drag copies the source; otherwise treat as file upload.
  async function onAgentDrop(e, targetPid) {
    const raw = e.dataTransfer.getData("application/x-rag-source");
    if (raw) {
      e.preventDefault();
      setDropTarget(null);
      try {
        const { sourceId, fromProfileId } = JSON.parse(raw);
        await copySourceTo(sourceId, fromProfileId, targetPid);
      } catch {
        /* ignore malformed drag */
      }
      return;
    }
    await onDropFiles(e, targetPid);
  }

  // ── Context menu ──

  function openMenu(e, payload) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, ...payload });
  }

  // ── Unified source-add modal (file / folder / url / text / image) ──

  function openSourceModal(pid, tab = "file") {
    if (!pid) return;
    setDlgTitle("");
    setDlgText("");
    setDlgUrl("");
    setSourceModal({ pid, tab });
  }

  // Image sources reuse the file-upload endpoint: the backend already ingests
  // images (OCR via tesseract / vision structuring) as an "image" kind, so no
  // new pipeline is needed — the picker is just filtered to image/*.
  function pickImages(pid) {
    uploadTargetRef.current = pid;
    imageInputRef.current?.click();
  }

  async function submitSourceText() {
    if (!dlgText.trim() || !sourceModal) return;
    const pid = sourceModal.pid;
    setSourceModal(null);
    setBusy(true);
    try {
      await addText(dlgTitle.trim() || "Pasted text", dlgText, pid);
      setStatus("텍스트 소스 추가됨");
    } finally {
      setBusy(false);
    }
  }

  async function submitSourceUrl() {
    if (!dlgUrl.trim() || !sourceModal) return;
    const pid = sourceModal.pid;
    setSourceModal(null);
    try {
      await addUrl(dlgUrl.trim(), dlgTitle.trim(), pid);
    } catch (e) {
      // The server auto-tries fetch → browser → screenshot and, on total
      // failure, returns one guide (reasons + link + manual copy-paste steps).
      // Surface it as a single system message — no button maze.
      setStatus("URL 추출 실패");
      pushSystem(`⚠️ ${e.message}`);
    }
  }

  // ── Chat & commands ──

  function pushSystem(content) {
    setMessages((prev) => [...prev, { id: `sys-${Date.now()}-${Math.random()}`, role: "system", content }]);
  }

  function resolveSources(token, pid) {
    const sources = sourcesByProfile[pid] || [];
    const lower = token.toLowerCase();
    const exact = sources.filter((s) => s.title === token || s.relative_path === token);
    if (exact.length) return exact;
    return sources.filter(
      (s) => s.title.toLowerCase().includes(lower) || (s.relative_path || "").toLowerCase().includes(lower)
    );
  }

  function formatSourceList(label, list) {
    if (!list.length) return `${label}: 없음`;
    const lines = list.map((s) => {
      const path = s.relative_path && s.relative_path !== s.title ? ` (${s.relative_path})` : "";
      const chunks = s.chunkCount ? ` · ${s.chunkCount} chunks` : "";
      return `• ${s.title}${path} — ${s.status}${chunks}`;
    });
    return `${label} (${list.length}):\n${lines.join("\n")}`;
  }

  async function handleCommand(text) {
    const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (!m) return;
    const cmd = m[1].toLowerCase();
    const rest = m[2].trim();

    // Mode switch commands: /검색 /규율 /추천 /분석 (and aliases)
    const modeKey = modeAliasMap[cmd];
    if (modeKey) {
      setChatMode(modeKey);
      const mode = modes.find((x) => x.key === modeKey);
      if (rest) {
        await sendMessage(rest, modeKey);
      } else {
        pushSystem(`${mode.label} 모드로 전환했습니다. ${mode.hint}`);
      }
      return;
    }

    // Skill commands: /<skillname> runs on the last answer; /skills lists installed
    if (cmd === "skills") {
      pushSystem(
        skills.length
          ? "설치된 스킬:\n" + skills.map((s) => `/${s.name} — ${s.description || ""}`).join("\n")
          : "설치된 스킬이 없습니다. 설정(⚙️) > 스킬에서 추가하세요."
      );
      return;
    }
    const skill = skills.find((s) => s.name.toLowerCase() === cmd || s.folder?.toLowerCase() === cmd);
    if (skill) {
      await runSkill(skill);
      return;
    }

    if (cmd === "autoindex" || cmd === "auto-embed") {
      const on = /^(on|true|1|켜|켜기)$/i.test(rest) ? true : /^(off|false|0|꺼|끄기)$/i.test(rest) ? false : !autoIndex;
      toggleAutoIndex(on);
      pushSystem(`소스 추가 시 자동 임베딩: ${on ? "켜짐 ✅" : "꺼짐"}`);
      return;
    }

    if (cmd === "autoapprove" || cmd === "auto-approve") {
      const on = /^(on|true|1|켜|켜기)$/i.test(rest) ? true : /^(off|false|0|꺼|끄기)$/i.test(rest) ? false : !autoApprove;
      toggleAutoApprove(on);
      pushSystem(`전처리 자동 승인(검토 없이 바로 색인): ${on ? "켜짐 ✅" : "꺼짐"}`);
      return;
    }

    if (cmd === "foldertree" || cmd === "folder-tree") {
      const on = /^(on|true|1|켜|켜기)$/i.test(rest) ? true : /^(off|false|0|꺼|끄기)$/i.test(rest) ? false : !folderTree;
      toggleFolderTree(on);
      pushSystem(`폴더 추가 시 폴더 구조를 소스로 색인: ${on ? "켜짐 ✅" : "꺼짐"}`);
      return;
    }

    const pid = activeProfileId;
    if (!pid) { pushSystem("활성 Agent가 없습니다."); return; }

    setBusy(true);
    try {
      const sources = sourcesByProfile[pid] || (await loadSources(pid));
      switch (cmd) {
        case "add": {
          if (/^https?:\/\//i.test(rest)) {
            const src = await addUrl(rest, "", pid);
            pushSystem(`URL 소스 추가됨: ${src.title}`);
          } else if (rest.startsWith("@")) {
            const path = rest.slice(1).trim();
            if (!path) { pushSystem("사용법: /add @<폴더 또는 파일 경로>"); break; }
            const n = await addPath(path, pid);
            pushSystem(`경로에서 ${n}개 소스 추가됨: ${path}`);
          } else if (rest) {
            await addText("명령으로 추가한 텍스트", rest, pid);
            pushSystem(`텍스트 소스 추가됨 (${rest.length}자)`);
          } else {
            pushSystem("사용법: /add <텍스트> | /add @<경로> | /add <URL>");
          }
          break;
        }
        case "del":
        case "delete": {
          const token = rest.replace(/^@/, "").trim();
          if (!token) { pushSystem("사용법: /del @<소스명>"); break; }
          const matches = resolveSources(token, pid);
          if (!matches.length) { pushSystem(`일치하는 소스 없음: ${token}`); break; }
          for (const s of matches) await removeSource(s);
          pushSystem(`삭제됨 (${matches.length}): ${matches.map((s) => s.title).join(", ")}`);
          break;
        }
        case "embed": {
          const token = rest.replace(/^@/, "").trim();
          let targets = [];
          if (token === "all") targets = sources;
          else if (token === "except") targets = sources.filter((s) => s.status !== "indexed");
          else if (token) targets = resolveSources(token, pid);
          else { pushSystem("사용법: /embed @<소스명> | @all | @except"); break; }
          if (!targets.length) { pushSystem("임베딩할 소스가 없습니다."); break; }
          await embedSources(targets.map((s) => s.id), pid);
          pushSystem(`임베딩 시작 (${targets.length}): ${targets.map((s) => s.title).join(", ")}`);
          break;
        }
        case "embed-list": {
          pushSystem(formatSourceList("임베딩된 소스 (대화 재료)", sources.filter((s) => s.status === "indexed")));
          break;
        }
        case "no-embed-list": {
          pushSystem(formatSourceList("임베딩되지 않은 소스", sources.filter((s) => s.status !== "indexed")));
          break;
        }
        case "list": {
          pushSystem(formatSourceList("전체 소스", sources));
          break;
        }
        case "types": {
          pushSystem(SUPPORTED_TYPES_TEXT);
          break;
        }
        case "help": {
          const modeLines = modes.map((mo) => `/${mo.label}${" ".repeat(Math.max(1, 14 - mo.label.length))}${mo.hint}`);
          pushSystem(
            [
              "■ 모드 전환 (입력 뒤에도 계속 적용)",
              ...modeLines,
              "  · 예) /규율 \"확인\" 버튼 문구 괜찮아?",
              "",
              "■ 소스 관리",
              "/add <텍스트>        텍스트를 소스로 추가",
              "/add @<경로>         로컬 파일/폴더를 소스로 추가",
              "/add <URL>           웹페이지를 소스로 추가",
              "/del @<소스명>       소스 삭제",
              "/embed @<소스명>     해당 소스만 임베딩",
              "/embed @all          전체 소스 임베딩",
              "/embed @except       임베딩 안 된 소스만 임베딩",
              "/list                전체 소스 목록",
              "/embed-list          임베딩된(대화재료) 소스 목록",
              "/no-embed-list       임베딩 안 된 소스 목록",
              "/types               임베딩 가능한 파일 형식",
              "/autoindex on|off    소스 추가 시 자동 임베딩",
              "",
              "■ 스킬 (직전 답변을 가공)",
              ...(skills.length ? skills.map((s) => `/${s.name}  ${s.description || ""}`) : ["  (설치된 스킬 없음 — 설정 > 스킬)"]),
              "/skills              설치된 스킬 목록",
              "",
              "■ 기타",
              "@<Agent>             해당 Agent의 임베딩으로 답변 (예: @Movie Agent 추천해줘)",
              "왼쪽 검색창          Agent·소스 이름으로 필터"
            ].join("\n")
          );
          break;
        }
        default:
          pushSystem(`알 수 없는 명령: /${cmd} — /help 참고`);
      }
    } catch (e) {
      pushSystem(`오류: ${e.message}`);
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  async function runSkill(skill) {
    const lastAnswer = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAnswer) {
      pushSystem(`스킬 '${skill.name}'을 적용할 직전 답변이 없습니다. 먼저 대화하세요.`);
      return;
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    setBusy(true);
    setStatus(`스킬 실행: ${skill.name}`);
    try {
      const payload = await fetchJson(`/api/skills/${encodeURIComponent(skill.name)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profileId: activeProfileId,
          agent: activeProfile?.name || "",
          query: lastUser?.content || "",
          answer: lastAnswer.content,
          citations: lastAnswer.citations || [],
          messages: messages.slice(-8).map((m) => ({ role: m.role, content: m.content }))
        })
      });
      setMessages((prev) => [...prev, { id: `skill-${Date.now()}`, role: "skill", skill: skill.name, content: payload.output }]);
      setStatus("스킬 완료");
    } catch (e) {
      pushSystem(`스킬 오류: ${e.message}`);
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  function parseMention(text) {
    for (const p of profiles) {
      const tag = `@${p.name}`;
      const idx = text.toLowerCase().indexOf(tag.toLowerCase());
      if (idx !== -1) {
        const cleanText = (text.slice(0, idx) + text.slice(idx + tag.length)).replace(/\s+/g, " ").trim();
        return { profileId: p.id, agentName: p.name, cleanText };
      }
    }
    return { profileId: "", agentName: "", cleanText: text };
  }

  async function runChat() {
    const text = query.trim();
    if ((!text && !attachments.length) || busy) return;
    if (text.startsWith("/")) {
      setQuery("");
      setSuggest(null);
      await handleCommand(text);
      return;
    }
    const { profileId, agentName, cleanText } = parseMention(text);
    const targetId = profileId || activeProfileId;
    if (!targetId) return;
    const images = attachments;
    setQuery("");
    setAttachments([]);
    setSuggest(null);
    await sendMessage(cleanText || text, chatMode, targetId, agentName, images);
  }

  async function sendMessage(text, mode, targetId = activeProfileId, agentName = "", images = []) {
    if (!targetId) return;
    const modeLabel = modes.find((m) => m.key === mode)?.label;
    const crossAgent = agentName && targetId !== activeProfileId ? agentName : "";
    const userMsg = { id: String(Date.now()), role: "user", content: text, mode, modeLabel, agentName: crossAgent, images };
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);
    setStatus("답변 생성 중");
    try {
      const payload = await fetchJson(`/api/profiles/${targetId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: text, topK: 4, mode, images })
      });
      const cites = (payload.citations || []).map((c) => ({ ...c, query: text }));
      const used = new Set([...String(payload.answer).matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
      const panelCites = used.size ? cites.filter((c) => used.has(c.number)) : cites;
      setMessages((prev) => [
        ...prev,
        {
          id: payload.id || String(Date.now() + 1),
          role: "assistant",
          content: payload.answer,
          citations: cites,
          panelCitations: panelCites,
          concepts: payload.concepts || [],
          violations: payload.violations || [],
          profileId: targetId,
          query: text,
          mode
        }
      ]);
      setActiveCitations(panelCites);
      const t = payload.timings;
      setStatus(
        t
          ? `답변 완료 · 검색 ${t.totalMs}ms${t.reranker && t.reranker !== "none" ? ` (리랭크 ${t.rerankMs}ms/${t.reranker})` : ""} · 생성 ${t.answerMs}ms`
          : "답변 완료"
      );
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: String(Date.now() + 1), role: "assistant", content: `오류: ${err.message}`, citations: [] }
      ]);
      setStatus("오류 발생");
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  function onQueryChange(e) {
    const val = e.target.value;
    setQuery(val);
    const at = val.match(/@([^\s@]*)$/);
    if (at) {
      const q = at[1].toLowerCase();
      const items = profiles.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6);
      setSuggest(items.length ? { type: "mention", items, index: 0 } : null);
      return;
    }
    const slash = val.match(/^\/([^\s]*)$/);
    if (slash) {
      const q = slash[1].toLowerCase();
      const items = commandList.filter((c) => c.cmd.toLowerCase().includes(q)).slice(0, 8);
      setSuggest(items.length ? { type: "command", items, index: 0 } : null);
      return;
    }
    setSuggest(null);
  }

  function pickSuggest(item) {
    if (suggest?.type === "mention") {
      setQuery((val) => val.replace(/@([^\s@]*)$/, `@${item.name} `));
    } else {
      setQuery(`/${item.cmd} `);
    }
    setSuggest(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleKeyDown(e) {
    if (suggest) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSuggest((s) => ({ ...s, index: (s.index + 1) % s.items.length })); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSuggest((s) => ({ ...s, index: (s.index - 1 + s.items.length) % s.items.length })); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSuggest(suggest.items[suggest.index]); return; }
      if (e.key === "Escape") { e.preventDefault(); setSuggest(null); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runChat();
    }
  }

  function openCitationPopup(citation) {
    const locatorParts = [];
    if (citation.sourceKind === "concept-cards") locatorParts.push("🧠 개념 정리 카드 — 여러 소스를 종합한 문서");
    else if (citation.breadcrumb) locatorParts.push(citation.breadcrumb);
    else if (citation.locator?.relativePath) locatorParts.push(citation.locator.relativePath);
    if (citation.locator?.page) locatorParts.push(`페이지 ${citation.locator.page}`);
    if (citation.locator?.slide) locatorParts.push(`슬라이드 ${citation.locator.slide}`);
    if (citation.locator?.sheet) locatorParts.push(`시트 ${citation.locator.sheet}`);
    const locatorStr = locatorParts.join(" · ");

    const popup = window.open("", `source-${citation.sourceId}-${citation.number}`, "width=700,height=800,resizable=yes,scrollbars=yes");
    if (!popup) return;
    const body = highlightTerms(escapeHtml(citation.text || citation.excerpt || ""), citation.query || "");
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>[${citation.number}] ${escapeHtml(citation.title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; color: #17211d; background: #f4f6f3; }
  .header { background: #007a68; color: white; padding: 20px 24px; }
  .header h1 { font-size: 1.05rem; font-weight: 700; line-height: 1.4; }
  .header .meta { margin-top: 5px; font-size: 0.82rem; opacity: 0.85; }
  .body { padding: 22px 24px; }
  .score-row { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; flex-wrap: wrap; }
  .score { background: #e5f3ef; color: #005e52; padding: 3px 10px; border-radius: 999px; font-size: 0.78rem; font-weight: 700; }
  .num { background: #dde8ff; color: #2946a8; padding: 3px 10px; border-radius: 999px; font-size: 0.78rem; font-weight: 700; }
  .hl-note { color: #68736d; font-size: 0.76rem; }
  .excerpt { white-space: pre-wrap; line-height: 1.75; font-size: 0.93rem; background: white; border: 1px solid #d9e0dc; border-radius: 8px; padding: 18px; }
  mark { background: #ffe08a; color: inherit; padding: 0 2px; border-radius: 2px; }
</style></head><body>
<div class="header"><h1>${escapeHtml(citation.title)}</h1>${locatorStr ? `<div class="meta">${escapeHtml(locatorStr)}</div>` : ""}</div>
<div class="body"><div class="score-row"><span class="num">[${citation.number}]</span><span class="score">유사도 ${typeof citation.score === "number" ? citation.score.toFixed(3) : "-"}</span>${citation.query ? '<span class="hl-note">노란 표시 = 질문 키워드</span>' : ""}</div>
<div class="excerpt">${body}</div></div>
</body></html>`;
    popup.document.write(html);
    popup.document.close();
  }

  // ── Settings ──

  function loadPresetIntoForm(state, name) {
    const target = state.presets[name] || Object.values(state.presets)[0] || { llm: {}, embedding: {} };
    setPresetName(name);
    setSettingsForm({ llm: { ...target.llm }, embedding: { ...target.embedding } });
  }

  async function openSettings() {
    const [state, skillCfg] = await Promise.all([
      fetchJson("/api/settings"),
      fetchJson("/api/skills/config").catch(() => ({ repo: "" }))
    ]);
    setSettingsState(state);
    loadPresetIntoForm(state, state.activePreset);
    // Simple view first: seed the one-field key input from the active preset.
    const active = state.presets[state.activePreset] || Object.values(state.presets)[0] || {};
    setQuickKey(active.llm?.apiKey || "");
    setConnTest(null);
    setAdvancedSettings(false);
    setSkillRepo(skillCfg.repo || "");
    setAvailableSkills([]);
    setEditingMode(null);
    loadSkills();
    setSettingsOpen(true);
  }

  async function loadSkills() {
    setSkills(await fetchJson("/api/skills").catch(() => []));
  }

  async function loadModes() {
    const list = await fetchJson("/api/modes");
    setModes(list);
    // Default persona (★) survives reloads: restore it whenever it still exists.
    const stored = localStorage.getItem("rag.defaultMode");
    if (stored && list.some((m) => m.key === stored)) {
      setChatMode(stored);
    } else if (!list.some((m) => m.key === chatMode)) {
      setChatMode(list[0]?.key || "general");
    }
    return list;
  }

  // ── Simple settings: one-key connect + persona quick manager ──

  async function quickConnect() {
    const key = quickKey.trim();
    // One key powers both LLM and embeddings unless embeddings already has its own.
    const form = {
      ...settingsForm,
      llm: { ...settingsForm.llm, apiKey: key },
      embedding: { ...settingsForm.embedding, apiKey: settingsForm.embedding.apiKey || key }
    };
    setSettingsForm(form);
    setConnTest({ busy: true });
    try {
      const state = await fetchJson("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: presetName || settingsState.activePreset || "기본", ...form })
      });
      setSettingsState(state);
      const result = await fetchJson("/api/settings/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form)
      });
      setConnTest(result);
      const ok = result.llm?.ok && result.embedding?.ok;
      setStatus(ok ? "연결 완료 — 바로 대화를 시작할 수 있습니다" : "연결 확인 실패 — 메시지를 확인하세요");
      if (ok) boot(); // refresh health/model badge
    } catch (e) {
      setConnTest({ llm: { ok: false, detail: e.message }, embedding: { ok: false, detail: "" } });
    }
  }

  async function addPersona(template) {
    try {
      await fetchJson("/api/modes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(template)
      });
      await loadModes();
      setStatus(`페르소나 추가됨: ${template.label}`);
    } catch (e) {
      window.alert(`페르소나 추가 오류: ${e.message}`);
    }
  }

  function copyText(text) {
    navigator.clipboard?.writeText(text).then(
      () => setStatus("복사됨 — 터미널/탐색기에 붙여넣으세요"),
      () => setStatus("복사 실패 — 직접 선택해서 복사하세요")
    );
  }

  function toggleDefaultPersona(key) {
    const next = defaultMode === key ? "" : key;
    setDefaultMode(next);
    if (next) {
      localStorage.setItem("rag.defaultMode", next);
      setChatMode(next);
    } else {
      localStorage.removeItem("rag.defaultMode");
    }
  }

  function startEditMode(m) {
    setEditingMode({
      key: m.key,
      label: m.label,
      hint: m.hint || "",
      aliases: (m.aliases || []).filter((a) => a !== m.label).join(", "),
      system: m.system || ""
    });
  }

  function startNewMode() {
    if (modes.length >= 10) { window.alert("모드는 최대 10개까지 만들 수 있습니다."); return; }
    setEditingMode({ key: "", label: "", hint: "", aliases: "", system: "" });
  }

  function setModeField(key, value) {
    setEditingMode((m) => ({ ...m, [key]: value }));
  }

  async function saveMode() {
    if (!editingMode.label.trim() || !editingMode.system.trim()) {
      window.alert("이름과 지시문(시스템 프롬프트)을 입력하세요.");
      return;
    }
    try {
      await fetchJson("/api/modes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editingMode)
      });
      setEditingMode(null);
      await loadModes();
      setStatus("모드 저장됨");
    } catch (e) {
      window.alert(`모드 저장 오류: ${e.message}`);
    }
  }

  async function deleteMode(key) {
    if (!window.confirm("이 모드를 삭제할까요?")) return;
    try {
      await fetchJson(`/api/modes/${encodeURIComponent(key)}`, { method: "DELETE" });
      await loadModes();
    } catch (e) {
      window.alert(`삭제 오류: ${e.message}`);
    }
  }

  async function syncSkills() {
    setSkillBusy(true);
    try {
      await fetchJson("/api/skills/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: skillRepo })
      });
      const available = await fetchJson("/api/skills/sync", { method: "POST" });
      setAvailableSkills(available);
      setStatus(`스킬 저장소 동기화: ${available.length}개 발견`);
    } catch (e) {
      setStatus(`스킬 동기화 오류: ${e.message}`);
      window.alert(`스킬 동기화 오류: ${e.message}`);
    } finally {
      setSkillBusy(false);
    }
  }

  async function installSkill(name) {
    setSkillBusy(true);
    try {
      await fetchJson("/api/skills/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name })
      });
      await loadSkills();
      setStatus(`스킬 설치됨: ${name}`);
    } catch (e) {
      window.alert(`설치 오류: ${e.message}`);
    } finally {
      setSkillBusy(false);
    }
  }

  async function removeSkill(name) {
    if (!window.confirm(`스킬 '${name}'을 삭제할까요?`)) return;
    await fetchJson(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
    await loadSkills();
  }

  async function switchPreset(name) {
    if (name === "__new__") {
      const newName = window.prompt("새 프리셋 이름", "회사");
      if (!newName?.trim()) return;
      // start an empty form under the new name without persisting yet
      setPresetName(newName.trim());
      setSettingsForm({
        llm: { provider: "openai-compatible", baseUrl: "", model: "", apiKey: "" },
        embedding: { backend: "http", url: "", model: "", dimensions: null, apiKey: "" }
      });
      return;
    }
    const state = await fetchJson("/api/settings/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    });
    setSettingsState(state);
    loadPresetIntoForm(state, name);
    setHealth(await fetchJson("/v1/health"));
    setStatus(`프리셋 전환: ${name}`);
  }

  async function saveSettings() {
    const state = await fetchJson("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: presetName, ...settingsForm })
    });
    setSettingsState(state);
    setSettingsOpen(false);
    setHealth(await fetchJson("/v1/health"));
    setStatus(`설정 저장됨: ${presetName}`);
  }

  async function deletePreset() {
    if (!window.confirm(`프리셋 '${presetName}'을 삭제할까요?`)) return;
    const state = await fetchJson(`/api/settings/${encodeURIComponent(presetName)}`, { method: "DELETE" });
    setSettingsState(state);
    loadPresetIntoForm(state, state.activePreset);
    setHealth(await fetchJson("/v1/health"));
    setStatus("프리셋 삭제됨");
  }

  const setLlmField = (key, value) => setSettingsForm((f) => ({ ...f, llm: { ...f.llm, [key]: value } }));
  const setEmbField = (key, value) => setSettingsForm((f) => ({ ...f, embedding: { ...f.embedding, [key]: value } }));

  // ── Resizers ──

  function startResize(e, opts) {
    e.preventDefault();
    const axis = opts.axis || "x";
    const start = axis === "y" ? e.clientY : e.clientX;
    const startSize = opts.startWidth;
    let latest = startSize;
    function onMove(ev) {
      const pos = axis === "y" ? ev.clientY : ev.clientX;
      latest = Math.min(opts.max, Math.max(opts.min, startSize + (pos - start) * opts.sign));
      opts.set(latest);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(opts.storageKey, String(latest));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = axis === "y" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
  }

  // ── Tree rendering ──

  function renderTree(node, prefix, pid) {
    return (
      <>
        {[...node.dirs.entries()].map(([name, child]) => {
          const full = `${prefix}/${name}`;
          const open = !collapsedDirs.has(full);
          return (
            <div key={full} className="tree-dir">
              <div className="tree-row dir" onClick={() => toggleDir(full)}>
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Folder size={13} />
                <span className="tree-name">{name}</span>
              </div>
              {open && <div className="tree-children">{renderTree(child, full, pid)}</div>}
            </div>
          );
        })}
        {node.files.map(({ source, name }) => (
          <div
            key={source.id}
            className={`tree-row file status-${source.status}`}
            title={`${source.relative_path || source.title} · ${statusLabel(source.status)} · 더블클릭: 문서 보기 · 드래그해서 다른 Agent로 복사`}
            draggable
            onDoubleClick={() => openSourceViewer(source)}
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.setData("application/x-rag-source", JSON.stringify({ sourceId: source.id, fromProfileId: pid }));
              e.dataTransfer.effectAllowed = "copy";
            }}
            onContextMenu={(e) => openMenu(e, { kind: "source", pid, source })}
          >
            {source.kind === "url" ? <Link size={13} /> : <File size={13} />}
            <span className="tree-name">{name}</span>
            <span className={`src-dot ${source.status}`} title={statusLabel(source.status)} />
            <span className="tree-actions">
              <button className="mini" title={source.status === "indexed" ? "재임베딩" : "임베딩"} onClick={() => embedSources([source.id], pid)}>
                <Zap size={12} />
              </button>
              <button className="mini danger" title="삭제" onClick={() => removeSource(source)}>
                <Trash2 size={12} />
              </button>
            </span>
          </div>
        ))}
      </>
    );
  }

  return (
    <main className={`shell ${compact ? "compact" : ""}`} style={{ "--sidebar-w": `${sidebarWidth}px`, "--citations-w": `${citationsWidth}px` }}>
      {/* Screenshot crop overlay */}
      {crop && (
        <div className="crop-overlay" onMouseDown={onCropDown} onMouseMove={onCropMove} onMouseUp={onCropUp}>
          <img ref={cropImgRef} src={crop.src} className="crop-img" draggable={false} alt="screenshot" />
          {dragRect && (
            <div className="crop-sel" style={{ left: dragRect.x, top: dragRect.y, width: dragRect.w, height: dragRect.h }} />
          )}
          <div className="crop-hint">드래그해서 검증할 영역을 선택하세요 · Esc 취소</div>
        </div>
      )}

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" multiple hidden accept={ACCEPTED_FILE_TYPES} onChange={(e) => uploadEntries(fileListToEntries(e.target.files), uploadTargetRef.current)} />
      <input ref={folderInputRef} type="file" multiple hidden webkitdirectory="" directory="" onChange={(e) => uploadEntries(fileListToEntries(e.target.files), uploadTargetRef.current)} />
      <input ref={imageInputRef} type="file" multiple hidden accept="image/*" onChange={(e) => uploadEntries(fileListToEntries(e.target.files), uploadTargetRef.current)} />

      {/* Context menu */}
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.kind === "agent" ? (
            <>
              <button onClick={() => { openSourceModal(menu.pid); setMenu(null); }}><Plus size={14} />소스 추가</button>
              <button onClick={() => { openRules(menu.pid); setMenu(null); }}><ClipboardCheck size={14} />규칙(가이드)</button>
              <button onClick={() => { openReview(menu.pid); setMenu(null); }}><SpellCheck size={14} />검수(문장 교정)</button>
              <button onClick={() => { openGlossary(menu.pid); setMenu(null); }}><BookOpen size={14} />용어집(단어 사전)</button>
              <button onClick={() => { openConcepts(menu.pid); setMenu(null); }}><Network size={14} />의미 사전(동의어·맥락)</button>
              <button onClick={() => { openFeedback(menu.pid); setMenu(null); }}><ThumbsUp size={14} />피드백 학습</button>
            </>
          ) : (
            <>
              <button onClick={() => { structureSources([menu.source.id], menu.pid); setMenu(null); }}><Sparkles size={14} />구조화(전처리)</button>
              <button onClick={() => { openStructure(menu.pid, menu.source.id); setMenu(null); }}><FileText size={14} />구조화 검토·편집</button>
              <button onClick={() => { embedSources([menu.source.id], menu.pid); setMenu(null); }}><Zap size={14} />임베딩</button>
              <button className="danger" onClick={() => { removeSource(menu.source); setMenu(null); }}><Trash2 size={14} />삭제</button>
            </>
          )}
        </div>
      )}

      {/* Preprocessing review: edit the structured Markdown before indexing */}
      {structureModal && (
        <div className="modal-overlay" onClick={() => setStructureModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>구조화 검토 — {structureModal.source.title}</h2>
              <button className="icon-button" type="button" onClick={() => setStructureModal(null)}><X size={18} /></button>
            </div>
            <div className="settings-section">
              <p className="skill-group-label">
                전처리 에이전트가 만든 <strong>마크다운</strong>을 검토·수정하세요. 저장 후 임베딩하면 원문 대신 이 마크다운이
                구조(제목·표) 기준으로 청킹·색인됩니다. 비우면 원문 추출 방식으로 되돌아갑니다.
              </p>
              <textarea
                className="structure-editor"
                rows={18}
                value={structureModal.md}
                onChange={(e) => setStructureModal((m) => ({ ...m, md: e.target.value }))}
                placeholder={"# 대제목\n\n## 소제목\n\n| 추천 | 피해야 할 말 |\n| --- | --- |\n| … | … |"}
              />
              <div className="skill-repo-row">
                <button type="button" className="secondary" onClick={() => structureSources([structureModal.source.id], structureModal.pid)}>
                  <Sparkles size={15} />전처리 다시 실행
                </button>
                <button type="button" onClick={saveStructure} disabled={structureModal.busy}>
                  {structureModal.busy ? "저장 중…" : "저장"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Semantic concepts (의미·맥락 레이어) modal */}
      {conceptModal && (
        <div className="modal-overlay" onClick={() => setConceptModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>의미 사전 — {profiles.find((p) => p.id === conceptModal.profileId)?.name || "Agent"}</h2>
              <button className="icon-button" type="button" onClick={() => setConceptModal(null)}><X size={18} /></button>
            </div>

            <div className="settings-section">
              <p className="skill-group-label">
                같은 의미가 여러 표기로 쓰일 때(<b>동작 대기 = 대기 중 = 스탠바이</b>) 하나의 <strong>개념</strong>으로
                묶습니다. 질문이 어느 표기로 들어와도 개념으로 해석해 <strong>원본 소스까지 연결</strong>되고,
                답변 LLM에도 해석이 전달됩니다.
              </p>
              <div className="install-actions">
                <button type="button" className="secondary" onClick={extractConcepts} disabled={conceptBusy}>
                  <Sparkles size={15} />{conceptBusy ? "작업 중…" : autoConfirmConcepts ? "소스에서 개념 추출 (자동 확정)" : "소스에서 개념 추출 (초안)"}
                </button>
                <button type="button" className="secondary" onClick={generateAllCards} disabled={conceptBusy || !concepts.some((c) => c.reviewStatus === "confirmed")}>
                  <FileText size={15} />전체 정리 카드 생성
                </button>
              </div>
              <label className="auto-confirm-row">
                <input type="checkbox" checked={autoConfirmConcepts} onChange={() => toggleAutoConfirmConcepts()} />
                추출 후 <b>자동 확정</b> — 검토 없이 바로 검색에 반영 (문서가 많을 때 편리)
              </label>
              <p className="skill-group-label optional">
                <b>정리 카드</b>: 개념마다 여러 소스에 흩어진 기술을 하나로 종합(중복 병합 · ⚠️ 소스 간 불일치 표시)해
                검색 가능한 문서로 색인합니다. 근거 번호 [n]으로 원본과 연결됩니다.
              </p>
            </div>

            <div className="settings-section">
              <p className="skill-group-label">개념 {concepts.length}개 <span className="optional">(확정 {concepts.filter((c) => c.reviewStatus === "confirmed").length} · 확정된 개념만 검색에 사용)</span></p>
              <div className="skill-repo-row term-add">
                <input value={conceptForm.name} onChange={(e) => setConceptForm((f) => ({ ...f, name: e.target.value }))} placeholder="대표 이름 (예: 동작 대기)" />
                <input value={conceptForm.aliases} onChange={(e) => setConceptForm((f) => ({ ...f, aliases: e.target.value }))} placeholder="변형 표기 (쉼표: 대기 중, 스탠바이)" />
                <button type="button" className="secondary" onClick={addConcept} disabled={!conceptForm.name.trim()}><Plus size={14} /></button>
              </div>
              <input
                value={conceptForm.definition}
                onChange={(e) => setConceptForm((f) => ({ ...f, definition: e.target.value }))}
                placeholder="뜻/맥락 한 줄 (선택)"
                style={{ marginTop: 6 }}
              />
              {concepts.length ? concepts.map((c) => (
                <div key={c.id} className={`rule-row ${c.reviewStatus === "confirmed" ? "approved" : "draft"}`}>
                  <div className="rule-main">
                    <div className="rule-head">
                      <strong>{c.name}</strong>
                      {c.aliases?.length ? <span className="optional">= {c.aliases.join(" · ")}</span> : null}
                      {c.reviewStatus !== "confirmed" && <span className="rule-badge draft">초안</span>}
                      {c.cardMd && <span className="rule-badge approved">카드</span>}
                    </div>
                    {c.definition ? <p className="term-def">{c.definition}</p> : null}
                    {c.cardMd ? (
                      <details className="card-preview">
                        <summary>정리 카드 보기</summary>
                        <pre>{c.cardMd}</pre>
                      </details>
                    ) : null}
                  </div>
                  <div className="rule-actions">
                    {c.reviewStatus !== "confirmed" ? (
                      <button type="button" className="mini" title="확정 (검색에 반영)" onClick={() => patchConcept(c.id, { reviewStatus: "confirmed" })}>✓</button>
                    ) : (
                      <button type="button" className="mini" title={c.cardMd ? "정리 카드 재생성" : "정리 카드 생성"} disabled={conceptBusy} onClick={() => generateCard(c.id)}>
                        <FileText size={12} />
                      </button>
                    )}
                    <button type="button" className="mini danger" title="삭제" onClick={() => deleteConcept(c.id)}><Trash2 size={12} /></button>
                  </div>
                </div>
              )) : (
                <p className="empty tiny">아직 개념이 없습니다. 직접 추가하거나 소스에서 추출하세요.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Review workspace — the designer's daily task: text in, correction report out */}
      {reviewModal && (
        <div className="modal-overlay" onClick={() => setReviewModal(null)}>
          <div className="modal review-workspace" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>검수 — {profiles.find((p) => p.id === reviewModal.profileId)?.name || "Agent"}</h2>
              <button className="icon-button" type="button" onClick={() => setReviewModal(null)}><X size={18} /></button>
            </div>

            <div className="settings-section">
              <p className="skill-group-label">
                화면 텍스트를 넣으면 <strong>스타일 가이드 + 용어집 + 규칙</strong>을 한 번에 검수합니다.
              </p>
              <textarea
                className="review-input"
                rows={3}
                value={reviewInput}
                onChange={(e) => setReviewInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runReview(); } }}
                placeholder={"예: 사용자의 냉장고 설정을 확인하려면 여기를 눌러주세요"}
                autoFocus
              />
              <button type="button" className="review-run" onClick={runReview} disabled={reviewBusy || !reviewInput.trim()}>
                {reviewBusy ? "검수 중…" : "검수하기"}
              </button>
            </div>

            {reviewResult && (
              <>
                {/* 원문 — 문제 단어 인라인 마킹 */}
                <div className="settings-section report-block">
                  <h3>원문</h3>
                  <p className="review-original">
                    {markSegments(reviewResult.text, reviewResult).map((seg, i) =>
                      seg.sev ? <mark key={i} className={seg.sev} title={seg.tip}>{seg.text}</mark> : <span key={i}>{seg.text}</span>
                    )}
                  </p>
                  <div className="rewrite-block">
                    <div className="rewrite-label">✍️ 교정 추천</div>
                    <div className="rewrite-text">{extractRewrite(reviewResult.answer)}</div>
                    <div className="rewrite-actions">
                      <button type="button" className="mini-btn" onClick={() => copyText(extractRewrite(reviewResult.answer))}>교정문 복사</button>
                      <details className="rewrite-why">
                        <summary>이유 보기</summary>
                        <pre>{reviewResult.answer}</pre>
                      </details>
                    </div>
                  </div>
                </div>

                {/* 단어 검수 — 용어집 판정 */}
                <div className="settings-section report-block">
                  <h3>📖 단어 검수 <span className="optional">
                    ({(reviewResult.terms || []).filter((t) => t.status !== "approved").length + (reviewResult.missing || []).length}건 조치
                    · 승인어 {(reviewResult.terms || []).filter((t) => t.status === "approved").length})
                  </span></h3>
                  <div className="word-rows">
                    {(reviewResult.terms || []).filter((t) => t.status !== "approved").map((t, i) => (
                      <details key={`t${i}`} className="word-row">
                        <summary>
                          <span className={`sev-dot ${t.status === "forbidden" ? "crit" : "warn"}`} />
                          <b>{t.surface}</b>
                          <span className={`word-tag ${t.status === "forbidden" ? "crit" : "warn"}`}>
                            {t.status === "forbidden" ? "금지어" : "대체 추천"}
                          </span>
                        </summary>
                        <div className="word-body">
                          {t.preferred && <div>권장: <b>{t.preferred}</b></div>}
                          {t.definition && <div className="optional">{t.definition}</div>}
                          {t.category && <div className="optional">분류: {t.category}</div>}
                        </div>
                      </details>
                    ))}
                    {(reviewResult.missing || []).map((m, i) => (
                      <details key={`m${i}`} className="word-row">
                        <summary>
                          <span className="sev-dot crit" />
                          <b>{m.base}</b>
                          <span className="word-tag crit">용어집에 없음</span>
                        </summary>
                        <div className="word-body">
                          <div className="optional">등재되지 않은 단어입니다 — 승인어로 대체하거나 용어집 등록을 검토하세요.</div>
                          <button type="button" className="mini-btn" onClick={() => { setReviewModal(null); openGlossary(reviewModal.profileId); setTermForm({ term: m.base, status: "approved", preferred: "" }); }}>
                            용어집에 등록하러 가기
                          </button>
                        </div>
                      </details>
                    ))}
                    {(reviewResult.terms || []).filter((t) => t.status === "approved").map((t, i) => (
                      <details key={`a${i}`} className="word-row ok">
                        <summary>
                          <span className="sev-dot ok" />
                          <b>{t.surface}</b>
                          <span className="word-tag ok">승인어</span>
                        </summary>
                        <div className="word-body">{t.definition ? <div className="optional">{t.definition}</div> : <div className="optional">용어집 등재 단어</div>}</div>
                      </details>
                    ))}
                    {!(reviewResult.terms || []).length && !(reviewResult.missing || []).length && (
                      <p className="empty tiny">검출된 용어가 없습니다.</p>
                    )}
                  </div>
                </div>

                {/* 스타일 규칙 위반 */}
                {(reviewResult.violations || []).length > 0 && (
                  <div className="settings-section report-block">
                    <h3>✍️ 스타일 규칙</h3>
                    {(reviewResult.violations || []).map((v, i) => (
                      <div key={i} className="meta-row warn">
                        <span className="meta-ico">⚠️</span>
                        <span>
                          금지 표현 <b>'{v.match}'</b>{v.suggest ? <> → 권장 <b>{v.suggest}</b></> : null}
                          {v.principle ? <span className="optional"> · {v.principle}</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* UX glossary + integrated review modal */}
      {glossaryModal && (
        <div className="modal-overlay" onClick={() => setGlossaryModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>용어집 — {profiles.find((p) => p.id === glossaryModal.profileId)?.name || "Agent"}</h2>
              <button className="icon-button" type="button" onClick={() => setGlossaryModal(null)}><X size={18} /></button>
            </div>

            <div className="settings-section">
              <p className="skill-group-label">
                단어 사전을 관리합니다. 문장 교정은 <strong>검수 워크스페이스</strong>에서 하세요.
              </p>
              <button type="button" className="secondary" onClick={() => { setGlossaryModal(null); openReview(glossaryModal.profileId); }}>
                <SpellCheck size={15} />검수 워크스페이스 열기
              </button>
            </div>

            <div className="settings-section">
              <p className="skill-group-label">용어 가져오기 <span className="optional">(용어집 페이지 소스에서 LLM 초안 추출)</span></p>
              <button type="button" className="secondary" onClick={extractGlossary} disabled={glossaryBusy}>
                <Sparkles size={15} />{glossaryBusy ? "추출 중…" : "소스에서 용어 추출 (초안)"}
              </button>
            </div>

            <div className="settings-section">
              <p className="skill-group-label">용어 {glossaryTerms.length}개 <span className="optional">(확정 {glossaryTerms.filter((t) => t.reviewStatus === "confirmed").length})</span></p>
              <div className="skill-repo-row term-add">
                <input value={termForm.term} onChange={(e) => setTermForm((f) => ({ ...f, term: e.target.value }))} placeholder="단어 (예: 에어컨)" />
                <select value={termForm.status} onChange={(e) => setTermForm((f) => ({ ...f, status: e.target.value }))}>
                  <option value="approved">승인</option>
                  <option value="deprecated">비권장</option>
                  <option value="forbidden">금지</option>
                </select>
                <input value={termForm.preferred} onChange={(e) => setTermForm((f) => ({ ...f, preferred: e.target.value }))} placeholder="권장 대체어" />
                <button type="button" className="secondary" onClick={addGlossaryTerm} disabled={!termForm.term.trim()}><Plus size={14} /></button>
              </div>
              {glossaryTerms.length ? glossaryTerms.map((t) => (
                <div key={t.id} className={`rule-row ${t.reviewStatus === "confirmed" ? "approved" : "draft"}`}>
                  <div className="rule-main">
                    <div className="rule-head">
                      <span className={`term-badge ${t.status}`}>{t.status === "approved" ? "승인어" : t.status === "deprecated" ? "비권장" : "금지"}</span>
                      <strong>{t.term}</strong>
                      {t.preferred ? <span className="optional">→ {t.preferred}</span> : null}
                      {t.category ? <span className="optional"> · {t.category}</span> : null}
                      {t.reviewStatus !== "confirmed" && <span className="rule-badge draft">초안</span>}
                    </div>
                    {t.definition ? <p className="term-def">{t.definition}</p> : null}
                  </div>
                  <div className="rule-actions">
                    {t.reviewStatus !== "confirmed" && (
                      <button type="button" className="mini" title="확정" onClick={() => patchGlossaryTerm(t.id, { reviewStatus: "confirmed" })}>✓</button>
                    )}
                    <button type="button" className="mini danger" title="삭제" onClick={() => deleteGlossaryTerm(t.id)}><Trash2 size={12} /></button>
                  </div>
                </div>
              )) : (
                <p className="empty tiny">아직 용어가 없습니다. 직접 추가하거나 소스에서 추출하세요.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Rules (guideline compliance) modal */}
      {rulesModal && (
        <div className="modal-overlay" onClick={() => setRulesModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>규칙 — {profiles.find((p) => p.id === rulesModal.profileId)?.name || "Agent"}</h2>
              <button className="icon-button" type="button" onClick={() => setRulesModal(null)}><X size={18} /></button>
            </div>

            <div className="settings-section">
              <p className="skill-group-label">
                추천↔피해야 할 말·금지어를 <strong>구조화 규칙</strong>으로 관리합니다. 승인된 규칙만 검사·답변에 사용됩니다.
              </p>
              <button type="button" className="secondary" onClick={extractRules} disabled={ruleBusy}>
                <Sparkles size={15} />{ruleBusy ? "추출 중…" : "가이드에서 규칙 추출 (LLM 초안)"}
              </button>
            </div>

            <div className="settings-section">
              <p className="skill-group-label">문장 검사 <span className="optional">(금지 표현 즉시 감지)</span></p>
              <div className="skill-repo-row">
                <input value={lintInput} onChange={(e) => setLintInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") runLint(); }} placeholder="예: 얼굴 인식이 더 잘되도록 사용자의 모습을 추가로 등록하세요" />
                <button type="button" className="secondary" onClick={runLint} disabled={!lintInput.trim()}>검사</button>
              </div>
              {lintResult && (
                lintResult.violations.length ? (
                  <div className="lint-hits">
                    {lintResult.violations.map((v, i) => (
                      <div key={i} className="lint-hit">
                        ⚠️ 금지 표현 <b>'{v.match}'</b>{v.suggest ? <> → 권장 <b>{v.suggest}</b></> : null}
                        {v.section ? <span className="optional"> · {v.section}</span> : null}
                        {v.principle ? <div className="lint-rule">{v.principle}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty tiny">감지된 금지 표현 없음 {lintResult.ruleCount ? "" : "(승인된 규칙이 아직 없습니다)"}</p>
                )
              )}
            </div>

            <div className="settings-section">
              <p className="skill-group-label">규칙 {rules.length}개 <span className="optional">(승인 {rules.filter((r) => r.status === "approved").length})</span></p>
              {rules.length ? rules.map((r) => (
                <div key={r.id} className={`rule-row ${r.status}`}>
                  <div className="rule-main">
                    <div className="rule-head">
                      <span className={`rule-badge ${r.status}`}>{r.status === "approved" ? "승인" : "초안"}</span>
                      {r.section ? <strong>{r.section}</strong> : null}
                    </div>
                    <input className="rule-principle" value={r.principle} onChange={(e) => setRules((prev) => prev.map((x) => x.id === r.id ? { ...x, principle: e.target.value } : x))} placeholder="원칙(한 문장)" />
                    <label className="rule-field">금지어<input value={(r.terms || []).join(", ")} onChange={(e) => setRules((prev) => prev.map((x) => x.id === r.id ? { ...x, terms: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x))} placeholder="사용자, 사용자의" /></label>
                    <label className="rule-field">권장어<input value={(r.prefer || []).join(", ")} onChange={(e) => setRules((prev) => prev.map((x) => x.id === r.id ? { ...x, prefer: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x))} placeholder="나, 내" /></label>
                    {(r.pairs || []).length ? (
                      <div className="rule-pairs">{r.pairs.map((p, i) => <div key={i} className="rule-pair"><span className="bad">{p.avoid}</span> → <span className="good">{p.recommend}</span></div>)}</div>
                    ) : null}
                  </div>
                  <div className="rule-actions">
                    <button type="button" className="mini" title="저장" onClick={() => patchRule(r.id, { principle: r.principle, terms: r.terms, prefer: r.prefer })}>저장</button>
                    <button type="button" className={r.status === "approved" ? "mini" : "mini primary"} onClick={() => patchRule(r.id, { status: r.status === "approved" ? "draft" : "approved" })}>{r.status === "approved" ? "초안으로" : "승인"}</button>
                    <button type="button" className="mini danger" title="삭제" onClick={() => deleteRule(r.id)}><Trash2 size={13} /></button>
                  </div>
                </div>
              )) : <p className="empty tiny">규칙이 없습니다. 위 <b>규칙 추출</b>로 가이드에서 초안을 만들어 검토하세요.</p>}
            </div>

            <div className="modal-footer">
              <button type="button" onClick={() => setRulesModal(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* Feedback review modal */}
      {fbModal && (
        <div className="modal-overlay" onClick={() => setFbModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>피드백 학습 — {profiles.find((p) => p.id === fbModal.profileId)?.name || "Agent"}</h2>
              <button className="icon-button" type="button" onClick={() => setFbModal(null)}><X size={18} /></button>
            </div>
            <div className="settings-section">
              <p className="skill-group-label">
                👍/👎 {feedbackList.length}건 <span className="optional">(비슷한 질문이 오면 자동으로 프롬프트에 반영됩니다)</span>
              </p>
              {feedbackList.length ? feedbackList.map((f) => (
                <div key={f.id} className={`rule-row ${f.rating > 0 ? "approved" : ""}`}>
                  <div className="rule-main">
                    <div className="rule-head">
                      <span className="rule-badge">{f.rating > 0 ? "👍 좋음" : "👎 개선"}</span>
                      <strong>{f.query}</strong>
                    </div>
                    {f.note ? <div className="optional">문제/이유: {f.note}</div> : null}
                    {f.correction ? <div className="rule-pair"><span className="good">올바른 답: {f.correction}</span></div> : null}
                  </div>
                  <div className="rule-actions">
                    <button type="button" className="mini danger" title="삭제" onClick={() => removeFeedback(f.id)}><Trash2 size={13} /></button>
                  </div>
                </div>
              )) : <p className="empty tiny">아직 피드백이 없습니다. 답변 아래 👍/👎로 남기면 여기에 쌓입니다.</p>}
            </div>
            <div className="modal-footer">
              <button type="button" onClick={() => setFbModal(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* Unified source-add modal: file / folder / url / text / image */}
      {sourceModal && (
        <div className="modal-overlay" onClick={() => setSourceModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>소스 추가</h2>
              <button className="icon-button" type="button" onClick={() => setSourceModal(null)}><X size={18} /></button>
            </div>
            <div className="source-tabs">
              {[
                { key: "file", label: "파일", icon: <Upload size={14} /> },
                { key: "folder", label: "폴더", icon: <FolderUp size={14} /> },
                { key: "url", label: "URL", icon: <Link size={14} /> },
                { key: "text", label: "텍스트", icon: <FileText size={14} /> },
                { key: "image", label: "이미지", icon: <Camera size={14} /> }
              ].map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`source-tab ${sourceModal.tab === t.key ? "on" : ""}`}
                  onClick={() => setSourceModal((m) => ({ ...m, tab: t.key }))}
                >
                  {t.icon}{t.label}
                </button>
              ))}
            </div>
            <div className="settings-section">
              {sourceModal.tab === "file" && (
                <div className="source-pick">
                  <p className="source-hint">PDF · Word · PowerPoint · Excel · 텍스트(.txt/.md/.csv/.json/.html) 파일을 선택합니다. 여러 개 선택 가능.</p>
                  <button type="button" onClick={() => { const pid = sourceModal.pid; setSourceModal(null); pickFiles(pid); }}><Upload size={15} /> 파일 선택</button>
                </div>
              )}
              {sourceModal.tab === "folder" && (
                <div className="source-pick">
                  <p className="source-hint">폴더를 통째로 추가합니다. 🗂 토글이 켜져 있으면 폴더 트리 구조도 소스로 함께 색인됩니다.</p>
                  <button type="button" onClick={() => { const pid = sourceModal.pid; setSourceModal(null); pickFolder(pid); }}><FolderUp size={15} /> 폴더 선택</button>
                </div>
              )}
              {sourceModal.tab === "url" && (
                <div className="settings-grid">
                  <label>
                    URL
                    <input
                      value={dlgUrl}
                      autoFocus
                      onChange={(e) => setDlgUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitSourceUrl(); } }}
                      placeholder="https://example.com/article"
                    />
                  </label>
                  <label>제목 <span className="optional">(선택 · 비우면 페이지 제목)</span><input value={dlgTitle} onChange={(e) => setDlgTitle(e.target.value)} placeholder="제목" /></label>
                </div>
              )}
              {sourceModal.tab === "text" && (
                <div className="settings-grid">
                  <label>제목<input value={dlgTitle} onChange={(e) => setDlgTitle(e.target.value)} placeholder="제목 (선택)" /></label>
                  <label>내용<textarea value={dlgText} onChange={(e) => setDlgText(e.target.value)} placeholder="텍스트 붙여넣기" style={{ minHeight: 180 }} /></label>
                </div>
              )}
              {sourceModal.tab === "image" && (
                <div className="source-pick">
                  <p className="source-hint">이미지를 소스로 추가합니다 — OCR·비전으로 텍스트를 추출해 임베딩합니다 (png · jpg · webp · tif 등). 스크린샷을 <b>대화에 첨부</b>하려면 입력창의 📷를 쓰세요.</p>
                  <button type="button" onClick={() => { const pid = sourceModal.pid; setSourceModal(null); pickImages(pid); }}><Camera size={15} /> 이미지 선택</button>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary" onClick={() => setSourceModal(null)}>닫기</button>
              {sourceModal.tab === "url" && (
                <button type="button" onClick={submitSourceUrl} disabled={busy || !dlgUrl.trim()}>{busy ? "가져오는 중…" : "추가"}</button>
              )}
              {sourceModal.tab === "text" && (
                <button type="button" onClick={submitSourceText} disabled={!dlgText.trim()}>추가</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings modal */}
      {/* Document viewer — double-click a source to read it in place */}
      {viewer && (
        <div className="modal-overlay" onClick={() => setViewer(null)}>
          <div className="modal viewer-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{viewer.data?.title || "문서"}</h2>
              <button className="icon-button" type="button" onClick={() => setViewer(null)}><X size={18} /></button>
            </div>
            {viewer.loading ? (
              <p className="empty">불러오는 중…</p>
            ) : (
              <>
                {viewer.data.relativePath && viewer.data.relativePath !== viewer.data.title && (
                  <p className="viewer-path">{viewer.data.relativePath}</p>
                )}
                {viewer.data.content ? (
                  <pre className="viewer-body">{viewer.data.content}</pre>
                ) : (
                  <p className="empty">
                    아직 읽을 수 있는 내용이 없습니다 — 임베딩(⚡)하면 추출된 내용이 여기에 표시됩니다.
                  </p>
                )}
                <div className="install-actions viewer-actions">
                  {viewer.data.url ? (
                    <a className="link-btn" href={viewer.data.url} target="_blank" rel="noreferrer">원본 페이지 열기 ↗</a>
                  ) : viewer.data.hasFile ? (
                    <a className="link-btn" href={`/api/profiles/${viewer.pid}/sources/${viewer.data.id}/raw`} target="_blank" rel="noreferrer">
                      원본 파일 열기 ↗
                    </a>
                  ) : null}
                  {viewer.data.contentSource === "normalized" && <span className="optional">구조화(전처리)된 마크다운 기준</span>}
                  {viewer.data.contentSource === "chunks" && <span className="optional">임베딩 시 추출된 내용 기준</span>}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* "내 PC에 설치" — complete local package guide (LM Studio + ARK) */}
      {installOpen && (
        <div className="modal-overlay" onClick={() => setInstallOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>내 PC에 설치 — 완전 로컬 패키지</h2>
              <button className="icon-button" type="button" onClick={() => setInstallOpen(false)}><X size={18} /></button>
            </div>

            <div className="settings-section">
              <p className="skill-group-label">
                회사 API Key 없이 <strong>내 컴퓨터에서 전부 도는</strong> 프로그램입니다. 두 가지만 하면 됩니다.
              </p>
              <div className="install-big">
                <a className="link-btn big" href="https://github.com/waneekim/local_mini_rag/archive/refs/heads/main.zip" target="_blank" rel="noreferrer">
                  <Download size={17} /> ARK 다운로드 (ZIP)
                </a>
                <a className="link-btn big secondary-link" href="https://lmstudio.ai" target="_blank" rel="noreferrer">
                  LM Studio 다운로드 ↗
                </a>
              </div>
              <ol className="install-list big">
                <li><b>LM Studio</b> 설치 → 앱에서 모델 받고 <b>Local Server Start</b></li>
                <li><b>ARK ZIP</b> 압축 풀고 → <code>scripts</code> 폴더의 설치 파일 <b>더블클릭</b> (끝)</li>
              </ol>
              <p className="skill-group-label optional">
                설치가 끝나면 트레이 앱이 실행됩니다 — <b>Ctrl+Shift+Space</b>로 채팅창을 열고,
                파일을 끌어다 놓고 바로 대화하세요.
              </p>
            </div>

            <details className="settings-section install-details">
              <summary>자세한 안내가 필요하면 (모델 추천 · 문제 해결)</summary>
              <ul className="install-list">
                <li>LM Studio 모델: 채팅 <code>qwen2.5-7b-instruct</code> · 임베딩 <code>bge-m3</code> 추천 (둘 다 로드 후 Server Start)</li>
                <li>설치 파일: macOS <code>scripts/setup-mac.command</code> · Windows <code>scripts/setup-windows.bat</code></li>
                <li>Node.js가 없으면 설치 페이지가 자동으로 열립니다 — LTS 설치 후 다시 더블클릭</li>
                <li>git이 편하면: <button type="button" className="secondary mini-btn" onClick={() => copyText("git clone https://github.com/waneekim/local_mini_rag.git")}>git clone 명령 복사</button></li>
                <li>연결이 안 되면: LM Studio Local Server(포트 1234)가 켜져 있는지, ⚙️ 빠른 연결에서 [연결하기]로 상태를 확인하세요</li>
              </ul>
            </details>
          </div>
        </div>
      )}

      {settingsOpen && settingsForm && settingsState && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>연결 설정</h2>
              <button className="icon-button" type="button" onClick={() => setSettingsOpen(false)}><X size={18} /></button>
            </div>

            {/* Simple view: API key → connect. Everything else stays behind 고급 설정. */}
            {!advancedSettings && (
              <>
                <div className="settings-section">
                  <h3>빠른 연결</h3>
                  <p className="skill-group-label">
                    서버 주소·모델은 미리 설정되어 있습니다. <strong>API Key만 입력하고 연결</strong>하면 바로 사용할 수 있어요.
                  </p>
                  <div className="quick-server">
                    <span className="quick-server-name">{presetName || settingsState.activePreset}</span>
                    <span className="optional">{settingsForm.llm.model || "모델 미지정"} · {settingsForm.llm.baseUrl || "서버 미지정"}</span>
                  </div>
                  <div className="skill-repo-row">
                    <input
                      type="password"
                      value={quickKey}
                      onChange={(e) => setQuickKey(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") quickConnect(); }}
                      placeholder="API Key 붙여넣기 (없는 서버면 비워두고 연결)"
                      autoFocus
                    />
                    <button type="button" onClick={quickConnect} disabled={connTest?.busy}>
                      {connTest?.busy ? "확인 중…" : "연결하기"}
                    </button>
                  </div>
                  {connTest && !connTest.busy && (
                    <div className="conn-results">
                      <div className={`conn-row ${connTest.llm?.ok ? "ok" : "bad"}`}>
                        {connTest.llm?.ok ? "✅" : "❌"} 대화 모델 — {connTest.llm?.detail}
                      </div>
                      <div className={`conn-row ${connTest.embedding?.ok ? "ok" : "bad"}`}>
                        {connTest.embedding?.ok ? "✅" : "❌"} 문서 검색(임베딩) — {connTest.embedding?.detail}
                      </div>
                    </div>
                  )}
                </div>

                <div className="settings-section">
                  <h3>페르소나 <span className="optional">(대화 모드 · ★=기본)</span></h3>
                  <p className="skill-group-label">
                    ★를 누르면 <strong>기본 페르소나</strong>로 저장되어 다음 접속에도 선택되어 있습니다.
                  </p>
                  {modes.map((m) => (
                    <div key={m.key} className="skill-row">
                      <button
                        type="button"
                        className={`mini star ${defaultMode === m.key ? "on" : ""}`}
                        title={defaultMode === m.key ? "기본 페르소나 해제" : "기본 페르소나로 지정"}
                        onClick={() => toggleDefaultPersona(m.key)}
                      >
                        {defaultMode === m.key ? "★" : "☆"}
                      </button>
                      <div className="skill-meta"><strong>{m.label}</strong><span>{m.hint}</span></div>
                      <button className="mini danger" type="button" title="삭제" onClick={() => deleteMode(m.key)} disabled={modes.length <= 1}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  {PERSONA_TEMPLATES.some((t) => !modes.some((m) => m.key === t.key)) && (
                    <>
                      <p className="skill-group-label" style={{ marginTop: 10 }}>추가할 수 있는 페르소나</p>
                      <div className="examples">
                        {PERSONA_TEMPLATES.filter((t) => !modes.some((m) => m.key === t.key)).map((t) => (
                          <button key={t.key} type="button" className="chip" title={t.hint} onClick={() => addPersona(t)} disabled={modes.length >= 10}>
                            + {t.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <div className="settings-section">
                  <button type="button" className="secondary" onClick={() => setAdvancedSettings(true)}>
                    <Settings size={14} /> 고급 설정 (서버 주소·프리셋·스킬…)
                  </button>
                </div>
              </>
            )}

            {advancedSettings && (
              <>
            <div className="settings-section">
              <button type="button" className="secondary mini-btn" onClick={() => setAdvancedSettings(false)}>← 간단 설정으로</button>
            </div>
            <div className="settings-section">
              <h3>프리셋 <span className="optional">(집 / 회사 등 환경별 저장)</span></h3>
              <div className="preset-row">
                <select
                  value={settingsState.presets[presetName] ? presetName : "__new__"}
                  onChange={(e) => switchPreset(e.target.value)}
                >
                  {Object.keys(settingsState.presets).map((name) => (
                    <option key={name} value={name}>
                      {name}{name === settingsState.activePreset ? " · 사용 중" : ""}
                    </option>
                  ))}
                  {!settingsState.presets[presetName] && <option value={presetName}>{presetName} (새 프리셋)</option>}
                  <option value="__new__">+ 새 프리셋…</option>
                </select>
                <button
                  type="button"
                  className="mini danger preset-del"
                  title="프리셋 삭제"
                  onClick={deletePreset}
                  disabled={Object.keys(settingsState.presets).length <= 1 && settingsState.presets[presetName]}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <label className="preset-name-label">
                프리셋 이름
                <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="집 / 회사" />
              </label>
            </div>

            <div className="settings-section">
              <h3>LLM</h3>
              <div className="settings-grid">
                <label>서버 URL<input value={settingsForm.llm.baseUrl || ""} onChange={(e) => setLlmField("baseUrl", e.target.value)} placeholder="http://localhost:1234/v1" /></label>
                <label>모델명<input value={settingsForm.llm.model || ""} onChange={(e) => setLlmField("model", e.target.value)} placeholder="qwen2.5-14b-instruct" /></label>
                <label>비전 모델 <span className="optional">(스크린샷 검증용 · 선택)</span><input value={settingsForm.llm.visionModel || ""} onChange={(e) => setLlmField("visionModel", e.target.value)} placeholder="qwen2-vl-7b-instruct" /></label>
                <label>API Key <span className="optional">(선택)</span><input type="password" value={settingsForm.llm.apiKey || ""} onChange={(e) => setLlmField("apiKey", e.target.value)} placeholder="없으면 비워두세요" /></label>
              </div>
            </div>

            <div className="settings-section">
              <h3>임베딩</h3>
              <div className="settings-grid">
                <label>서버 URL<input value={settingsForm.embedding.url || ""} onChange={(e) => setEmbField("url", e.target.value)} placeholder="http://localhost:1234/v1/embeddings" /></label>
                <label>모델명<input value={settingsForm.embedding.model || ""} onChange={(e) => setEmbField("model", e.target.value)} placeholder="bge-m3" /></label>
                <label>
                  차원수 <span className="optional">(선택 · 비우면 자동)</span>
                  <input
                    type="number"
                    value={settingsForm.embedding.dimensions ?? ""}
                    onChange={(e) => setEmbField("dimensions", e.target.value === "" ? null : Number(e.target.value))}
                    placeholder="자동 (서버 기준)"
                  />
                </label>
                <label>API Key <span className="optional">(선택)</span><input type="password" value={settingsForm.embedding.apiKey || ""} onChange={(e) => setEmbField("apiKey", e.target.value)} placeholder="없으면 비워두세요" /></label>
              </div>
            </div>

            <div className="settings-section">
              <h3><Globe size={15} style={{ verticalAlign: "-2px", marginRight: 4 }} />중앙 라이브러리 <span className="optional">(공유 RAG · 발행 / 가져오기)</span></h3>

              {adminRequired && (
                <div className="central-admin">
                  {isAdmin ? (
                    <div className="central-admin-on">
                      <span><Unlock size={14} /> 관리자 인증됨 — 중앙 에이전트 편집·발행 가능</span>
                      <button type="button" className="secondary mini-btn" onClick={lockAdmin}>로그아웃</button>
                    </div>
                  ) : (
                    <label>
                      <Lock size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />관리자 암호 <span className="optional">(중앙 서버 수정용)</span>
                      <div className="skill-repo-row">
                        <input
                          type="password"
                          value={adminInput}
                          onChange={(e) => setAdminInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") unlockAdmin(); }}
                          placeholder="사장님이 발급한 암호"
                        />
                        <button type="button" className="secondary" onClick={unlockAdmin} disabled={!adminInput.trim()}>인증</button>
                      </div>
                    </label>
                  )}
                </div>
              )}

              <p className="skill-group-label">발행 <span className="optional">(이 PC를 중앙 서버로 쓸 때 · 다른 사람이 열람·복제)</span></p>
              {profiles.length ? (
                profiles.map((p) => (
                  <div key={p.id} className="skill-row">
                    <div className="skill-meta">
                      <strong>{p.name}</strong>
                      <span>{p.published ? "🟢 중앙에 발행됨" : "⚪ 비공개"}</span>
                    </div>
                    <button
                      type="button"
                      className={p.published ? "mini danger" : "secondary mini-btn"}
                      onClick={(e) => togglePublish(p, e)}
                      disabled={adminRequired && !isAdmin}
                      title={adminRequired && !isAdmin ? "관리자 인증 필요" : ""}
                    >
                      {p.published ? "발행 취소" : "발행"}
                    </button>
                  </div>
                ))
              ) : (
                <p className="empty tiny">발행할 Agent가 없습니다.</p>
              )}

              <p className="skill-group-label" style={{ marginTop: 14 }}>중앙에서 가져오기 <span className="optional">(사장님 서버 주소로 접속해 내 로컬로 복제)</span></p>
              <div className="skill-repo-row">
                <input
                  value={centralUrl}
                  onChange={(e) => setCentralUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") browseCentral(); }}
                  placeholder="http://192.168.0.10:8787"
                />
                <button type="button" className="secondary" onClick={browseCentral} disabled={centralBusy || !centralUrl.trim()}>
                  <RefreshCw size={15} />불러오기
                </button>
              </div>
              {centralList !== null && (
                centralList.length ? (
                  <div className="skill-group">
                    {centralList.map((c) => (
                      <div key={c.id} className="skill-row">
                        <div className="skill-meta">
                          <strong>{c.name}</strong>
                          <span>{c.description || `소스 ${c.sourceCount} · 청크 ${c.chunkCount}`}</span>
                        </div>
                        <button type="button" className="secondary mini-btn" disabled={centralBusy} onClick={() => importCentral(c)}>
                          <Download size={14} />복제
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty tiny">발행된 중앙 에이전트가 없습니다.</p>
                )
              )}
            </div>

            <div className="settings-section">
              <h3>대화 모드 <span className="optional">({modes.length}/10 · 프롬프트 위 칩)</span></h3>
              {!editingMode ? (
                <>
                  {modes.map((m) => (
                    <div key={m.key} className="skill-row">
                      <div className="skill-meta"><strong>{m.label}</strong><span>{m.hint}</span></div>
                      <button className="mini" type="button" title="편집" onClick={() => startEditMode(m)}><Pencil size={13} /></button>
                      <button className="mini danger" type="button" title="삭제" onClick={() => deleteMode(m.key)} disabled={modes.length <= 1}><Trash2 size={13} /></button>
                    </div>
                  ))}
                  <button type="button" className="secondary mini-btn" style={{ marginTop: 10 }} onClick={startNewMode} disabled={modes.length >= 10}>+ 모드 추가</button>
                </>
              ) : (
                <div className="settings-grid">
                  <label>이름<input value={editingMode.label} onChange={(e) => setModeField("label", e.target.value)} placeholder="예: 요약" /></label>
                  <label>설명(힌트)<input value={editingMode.hint} onChange={(e) => setModeField("hint", e.target.value)} placeholder="이 모드가 하는 일" /></label>
                  <label>별칭 <span className="optional">(쉼표로 구분, 선택)</span><input value={editingMode.aliases} onChange={(e) => setModeField("aliases", e.target.value)} placeholder="summary, 요약" /></label>
                  <label>지시문 (시스템 프롬프트)<textarea value={editingMode.system} onChange={(e) => setModeField("system", e.target.value)} style={{ minHeight: 130 }} placeholder="이 모드에서 LLM이 따를 지시. 답변은 한국어로 등." /></label>
                  <div className="mode-edit-actions">
                    <button type="button" className="secondary" onClick={() => setEditingMode(null)}>취소</button>
                    <button type="button" onClick={saveMode} disabled={!editingMode.label.trim() || !editingMode.system.trim()}>저장</button>
                  </div>
                </div>
              )}
            </div>

            <div className="settings-section">
              <h3>스킬 <span className="optional">(⚠️ 다운로드한 코드를 실행합니다)</span></h3>
              <div className="settings-grid">
                <label>
                  사내 스킬 GitHub 저장소
                  <div className="skill-repo-row">
                    <input value={skillRepo} onChange={(e) => setSkillRepo(e.target.value)} placeholder="https://github.com/회사/skills.git" />
                    <button type="button" className="secondary" onClick={syncSkills} disabled={skillBusy || !skillRepo.trim()}>
                      <RefreshCw size={15} />동기화
                    </button>
                  </div>
                </label>
              </div>

              {availableSkills.length > 0 && (
                <div className="skill-group">
                  <p className="skill-group-label">저장소 스킬</p>
                  {availableSkills.map((s) => {
                    const installed = skills.some((x) => x.name === s.name);
                    return (
                      <div key={s.name} className="skill-row">
                        <div className="skill-meta"><strong>{s.name}</strong><span>{s.description}</span></div>
                        <button type="button" className="secondary mini-btn" disabled={skillBusy || installed} onClick={() => installSkill(s.name)}>
                          {installed ? "설치됨" : "설치"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="skill-group">
                <p className="skill-group-label">설치된 스킬 — 채팅에서 <code>/스킬이름</code></p>
                {skills.length ? (
                  skills.map((s) => (
                    <div key={s.name} className="skill-row">
                      <div className="skill-meta"><strong>/{s.name}</strong><span>{s.description}</span></div>
                      <button type="button" className="mini danger" title="삭제" onClick={() => removeSkill(s.name)}><Trash2 size={13} /></button>
                    </div>
                  ))
                ) : (
                  <p className="empty tiny">설치된 스킬 없음 · 저장소 동기화 후 설치하거나 skills/ 폴더에 넣으세요</p>
                )}
              </div>
            </div>
              </>
            )}

            <div className="modal-footer">
              <button type="button" className="secondary" onClick={() => setSettingsOpen(false)}>{advancedSettings ? "취소" : "닫기"}</button>
              {advancedSettings && (
                <button type="button" onClick={saveSettings} disabled={!presetName.trim()}>저장 · 적용</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sidebar: agents */}
      <aside className="sidebar">
        <div className="brand">
          <Database size={21} aria-hidden="true" />
          <div className="brand-text">
            <h1 title="Agent RAG Knowledge">ARK</h1>
            <p className="brand-full">Agent RAG Knowledge</p>
            <p className="brand-model">{health?.llmProvider?.model || health?.llmProvider?.provider || "checking"}</p>
          </div>
          {/* Minimal background-work signal: a pulsing dot, details on hover only. */}
          {(busy || (job && !["completed", "completed_with_errors", "failed"].includes(job.status))) && (
            <span className="working-dot" title={status || "작업 진행 중"} aria-label="작업 진행 중" style={{ marginLeft: "auto" }} />
          )}
          <button
            className="icon-button"
            type="button"
            title="설정"
            onClick={openSettings}
            style={busy || (job && !["completed", "completed_with_errors", "failed"].includes(job.status)) ? undefined : { marginLeft: "auto" }}
          >
            <Settings size={18} />
          </button>
        </div>

        <div className="agent-toolbar">
          <span className="agent-toolbar-label">Agents</span>
          <button className="icon-button" type="button" title="Agent 추가" onClick={createProfile}><Plus size={18} /></button>
        </div>

        {/* Source-add tools: they act on the selected Agent's knowledge, so they
            live next to the sources — not under the chat prompt. */}
        <div className="source-tools">
          <button className="tool source-add-btn" type="button" title="소스 추가 · 파일·폴더·URL·텍스트·이미지" onClick={() => openSourceModal(activeProfileId)} disabled={!activeProfileId}><Plus size={15} />소스 추가</button>
          <span className="tool-sep" />
          <button className={`tool toggle ${autoIndex ? "on" : ""}`} type="button" title={`추가 시 자동 임베딩: ${autoIndex ? "켜짐" : "꺼짐"}`} onClick={() => toggleAutoIndex()}>
            <Zap size={15} />
          </button>
          <button className={`tool toggle ${autoApprove ? "on" : ""}`} type="button" title={`전처리 자동 승인(검토 없이 바로 색인): ${autoApprove ? "켜짐" : "꺼짐"}`} onClick={() => toggleAutoApprove()}>
            <Sparkles size={15} />
          </button>
          <button className={`tool toggle ${folderTree ? "on" : ""}`} type="button" title={`폴더 추가 시 폴더 구조를 소스로 색인: ${folderTree ? "켜짐" : "꺼짐"}`} onClick={() => toggleFolderTree()}>
            <FolderTree size={15} />
          </button>
        </div>

        <div className="agent-search">
          <Search size={14} />
          <input value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} placeholder="Agent·소스 검색" />
          {agentFilter && (
            <button className="icon-button" type="button" title="지우기" onClick={() => setAgentFilter("")}><X size={14} /></button>
          )}
        </div>

        <section className="agent-list" aria-label="Agents">
          {(() => {
            const f = agentFilter.trim().toLowerCase();
            const matchSrc = (s) => s.title.toLowerCase().includes(f) || (s.relative_path || "").toLowerCase().includes(f);
            const visible = !f
              ? profiles
              : profiles.filter((p) => p.name.toLowerCase().includes(f) || (sourcesByProfile[p.id] || []).some(matchSrc));
            if (f && !visible.length) return <p className="empty tiny">검색 결과 없음</p>;
            return visible.map((p) => {
              const list = sourcesByProfile[p.id] || [];
              const nameMatch = !f || p.name.toLowerCase().includes(f);
              const shownSources = !f || nameMatch ? list : list.filter(matchSrc);
              const open = f ? true : expandedIds.has(p.id);
              const isActive = p.id === activeProfileId;
              const embedded = list.filter((s) => s.status === "indexed").length;
              const pending = list.length - embedded;
              const tree = buildTree(shownSources);
              return (
              <div key={p.id} className={`agent ${isActive ? "active" : ""} ${dropTarget === p.id ? "drop" : ""}`}>
                <div
                  className="agent-row"
                  onClick={() => selectAgent(p.id)}
                  onContextMenu={(e) => openMenu(e, { kind: "agent", pid: p.id })}
                  onDragOver={(e) => { e.preventDefault(); setDropTarget(p.id); }}
                  onDragLeave={() => setDropTarget((t) => (t === p.id ? null : t))}
                  onDrop={(e) => onAgentDrop(e, p.id)}
                >
                  <button className="agent-toggle" type="button" onClick={(e) => { e.stopPropagation(); toggleExpand(p.id); }}>
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <Bot size={15} />
                  {editingId === p.id ? (
                    <input
                      className="agent-edit"
                      value={editingName}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                        else if (e.key === "Escape") { e.preventDefault(); setEditingId(""); }
                      }}
                    />
                  ) : (
                    <>
                      <span className="agent-name">{p.name}</span>
                      {sourcesByProfile[p.id] && list.length > 0 && (
                        <span className={`agent-count ${pending === 0 ? "done" : ""}`} title={`임베딩 ${embedded}/${list.length}`}>
                          {embedded}/{list.length}
                        </span>
                      )}
                      <span className="agent-actions">
                        <button className="mini accent" type="button" title="전체 임베딩" onClick={(e) => { e.stopPropagation(); embedAll(p.id); }}>
                          <Zap size={11} />
                        </button>
                        <button className="mini" type="button" title="이름 수정" onClick={(e) => startRename(p, e)}>
                          <Pencil size={11} />
                        </button>
                        <button className="mini danger" type="button" title="Agent 삭제" onClick={(e) => deleteProfile(p, e)}>
                          <Trash2 size={11} />
                        </button>
                      </span>
                    </>
                  )}
                </div>
                {open && (
                  <div className="agent-sources">
                    {list.length ? (
                      <>
                        <div className="sources-toolbar">
                          <button className="embed-all" type="button" onClick={() => embedAll(p.id)} disabled={busy}>
                            <Zap size={12} />전체 임베딩
                          </button>
                          {pending > 0 && (
                            <button className="embed-rest" type="button" title="임베딩 안 된 소스만" onClick={() => embedAll(p.id, true)} disabled={busy}>
                              새 항목 {pending}
                            </button>
                          )}
                          <span className={`embed-summary ${pending === 0 ? "done" : ""}`}>{embedded}/{list.length} 임베딩됨</span>
                        </div>
                        {renderTree(tree, p.id, p.id)}
                      </>
                    ) : (
                      <p className="empty tiny">소스 없음 · 끌어다 놓거나 우클릭</p>
                    )}
                  </div>
                )}
              </div>
              );
            });
          })()}
        </section>

        <div className="sidebar-footer">
          <button type="button" className="footer-link" onClick={() => setInstallOpen(true)}>
            <Download size={14} /> 내 PC에 설치
          </button>
        </div>
      </aside>

      <div
        className="resizer"
        role="separator"
        onMouseDown={(e) => startResize(e, { startWidth: sidebarWidth, sign: 1, min: 288, max: 560, set: setSidebarWidth, storageKey: "rag.sidebarWidth" })}
      />

      {/* Workspace */}
      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p>Agent</p>
            <h2>{activeProfile?.name || "Profile"}</h2>
          </div>
          <div className="workspace-header-right">
            <span className="status-line">{status}</span>
            {compact && (
              <button className="icon-button" type="button" title="설정" onClick={openSettings}><Settings size={16} /></button>
            )}
            {!narrow && (
              <button className="icon-button" type="button" title={compact ? "확장 모드" : "컴팩트 모드"} onClick={toggleCompact}>
                {compact ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
              </button>
            )}
          </div>
        </header>

        <div className="chat-layout">
          <div
            className={`chat-main ${chatDragOver ? "drag" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setChatDragOver(true); }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setChatDragOver(false); }}
            onDrop={onChatDrop}
          >
            {chatDragOver && <div className="drop-overlay">이미지=텍스트 검증 · 파일=소스로 추가</div>}

            <div className="chat-messages">
              {messages.length === 0 && (
                <div className="chat-empty">
                  <MessageSquare size={36} />
                  <p>문서를 추가·임베딩한 뒤 질문하세요.</p>
                  <p className="hint">/help 로 명령어를 확인하세요</p>
                </div>
              )}
              {messages.map((msg) =>
                msg.role === "system" || msg.role === "skill" ? (
                  <div key={msg.id} className={`chat-system ${msg.role === "skill" ? "skill" : ""}`}>
                    {msg.role === "skill" && <div className="skill-tag">스킬: {msg.skill}</div>}
                    <pre>{msg.content}</pre>
                  </div>
                ) : (
                  <div key={msg.id} className={`chat-bubble-row ${msg.role}`}>
                    <div className="chat-bubble">
                      {msg.role === "user" && msg.agentName && <span className="bubble-mention">@{msg.agentName}</span>}
                      {msg.role === "user" && msg.modeLabel && msg.mode !== "general" && (
                        <span className="bubble-mode">{msg.modeLabel}</span>
                      )}
                      {msg.role === "user" && msg.images?.length ? (
                        <div className="bubble-images">
                          {msg.images.map((src, i) => (
                            <img key={i} src={src} alt={`첨부 ${i + 1}`} />
                          ))}
                        </div>
                      ) : null}
                      {(msg.content || msg.role === "assistant") && (
                        <p className="bubble-text">
                          {msg.role === "assistant" ? renderAnswerText(msg.content, msg.citations, openCitationPopup) : msg.content}
                        </p>
                      )}
                      {/* Answer meta: interpretation + rule hits in one consistent block */}
                      {msg.role === "assistant" && (msg.concepts?.length || msg.violations?.length) ? (
                        <div className="answer-meta">
                          {msg.concepts?.length ? (
                            <div className="meta-row concept">
                              <span className="meta-ico">🧭</span>
                              <span>{msg.concepts.map((c) => `${(c.surfaces || []).join("/") || c.name} → ${c.name}`).join(" · ")}</span>
                            </div>
                          ) : null}
                          {(msg.violations || []).map((v, i) => (
                            <div key={i} className="meta-row warn">
                              <span className="meta-ico">⚠️</span>
                              <span>
                                금지 표현 <b>'{v.match}'</b>{v.suggest ? <> → 권장 <b>{v.suggest}</b></> : null}
                                {v.section ? <span className="optional"> · {v.section}</span> : null}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {/* Answer footer: evidence summary (click → citations panel) + feedback */}
                      {msg.role === "assistant" && msg.query ? (
                        <>
                          <div className="answer-footer">
                            <div className="evidence-chips">
                              {(() => {
                                const cites = msg.panelCitations || msg.citations || [];
                                const cards = cites.filter((c) => c.sourceKind === "concept-cards").length;
                                const docs = cites.length - cards;
                                if (!cites.length) return <span className="evidence-none">근거 없음</span>;
                                return (
                                  <button type="button" className="evidence-btn" title="참조 문서 패널에 표시" onClick={() => setActiveCitations(cites)}>
                                    {docs > 0 && <span>근거 {docs}</span>}
                                    {cards > 0 && <span className="chip-card">🧠 카드 {cards}</span>}
                                  </button>
                                );
                              })()}
                            </div>
                            <div className="msg-feedback">
                              {msg.feedback ? (
                                <span className="fb-done">{msg.feedback > 0 ? "👍 기록됨" : "👎 기록됨"}</span>
                              ) : (
                                <>
                                  <button type="button" title="좋은 답변" onClick={() => rateMessage(msg, 1)}><ThumbsUp size={14} /></button>
                                  <button type="button" title="개선 필요" onClick={() => rateMessage(msg, -1)}><ThumbsDown size={14} /></button>
                                </>
                              )}
                            </div>
                          </div>
                          {fbForm?.msgId === msg.id && (
                            <div className="fb-form">
                              <input value={fbForm.note} onChange={(e) => setFbForm((f) => ({ ...f, note: e.target.value }))} placeholder="무엇이 문제였나요? (선택)" />
                              <input value={fbForm.correction} onChange={(e) => setFbForm((f) => ({ ...f, correction: e.target.value }))} placeholder="올바른 답/방향 (선택)" />
                              <div className="fb-form-actions">
                                <button type="button" className="secondary mini-btn" onClick={() => setFbForm(null)}>취소</button>
                                <button type="button" className="mini-btn" onClick={() => submitFeedback(msg, -1, fbForm.note, fbForm.correction)}>저장</button>
                              </div>
                            </div>
                          )}
                        </>
                      ) : null}
                    </div>
                  </div>
                )
              )}
              {busy && (
                <div className="chat-bubble-row assistant">
                  <div className="chat-bubble typing"><span /><span /><span /></div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div
              className="resizer-h"
              role="separator"
              onMouseDown={(e) => startResize(e, { axis: "y", startWidth: inputHeight, sign: -1, min: 44, max: 360, set: setInputHeight, storageKey: "rag.inputHeight" })}
            />

            <div className="chat-input-bar">
              {modes.length > 0 && (
                <div className="mode-bar" role="tablist" aria-label="모드">
                  {modes.map((mo) => (
                    <button
                      key={mo.key}
                      type="button"
                      role="tab"
                      aria-selected={mo.key === chatMode}
                      className={`mode-chip ${mo.key === chatMode ? "active" : ""}`}
                      title={mo.hint}
                      onClick={() => setChatMode(mo.key)}
                    >
                      {mo.label}
                    </button>
                  ))}
                  {activeMode && <span className="mode-hint">{activeMode.hint}</span>}
                </div>
              )}
              <div className="composer">
                {suggest && (
                  <div className="mention-pop">
                    {suggest.items.map((item, i) => (
                      <button
                        key={suggest.type === "mention" ? item.id : item.cmd}
                        type="button"
                        className={`mention-item ${i === suggest.index ? "active" : ""}`}
                        onMouseEnter={() => setSuggest((s) => (s ? { ...s, index: i } : s))}
                        onMouseDown={(e) => { e.preventDefault(); pickSuggest(item); }}
                      >
                        {suggest.type === "mention" ? (
                          <><Bot size={13} />{item.name}</>
                        ) : (
                          <><span className="sug-cmd">/{item.cmd}</span><span className="sug-desc">{item.desc}</span></>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {attachments.length > 0 && (
                  <div className="attach-row">
                    {attachments.map((src, i) => (
                      <div key={i} className="attach-chip">
                        <img src={src} alt={`첨부 ${i + 1}`} />
                        <button type="button" className="attach-x" title="첨부 제거" onClick={() => removeAttachment(i)}>
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="ta-wrap" style={{ height: inputHeight }}>
                  <div className="ta-highlight" ref={highlightRef} aria-hidden="true">
                    {renderInputHighlight(query, profiles)}
                  </div>
                  <textarea
                    ref={inputRef}
                    className="ta-input"
                    value={query}
                    onChange={onQueryChange}
                    onKeyDown={handleKeyDown}
                    onScroll={(e) => { if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop; }}
                    placeholder={
                      activeMode && chatMode !== "general"
                        ? `[${activeMode.label}] ${activeMode.hint}`
                        : "메시지 / @Agent / 명령 입력… (Enter 전송 · Shift+Enter 줄바꿈)"
                    }
                    disabled={busy}
                    style={{ height: inputHeight }}
                  />
                </div>
                <div className="composer-bar">
                  <div className="input-tools">
                    {/* Chat-only tool: attach an image to the prompt. Source-add
                        tools live in the left panel next to the sources. */}
                    <button className="tool" type="button" title="이미지 첨부 · 클릭=화면 공유 후 영역선택 / 또는 스크린샷 복사 후 ⌘V 붙여넣기 → 프롬프트와 함께 비전 모델로 전송" onClick={captureScreenshot}><Camera size={16} /></button>
                  </div>
                  <button type="button" onClick={runChat} disabled={busy || (!query.trim() && !attachments.length)} aria-label="전송" className="send-btn">
                    <Send size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div
            className="resizer"
            role="separator"
            onMouseDown={(e) => startResize(e, { startWidth: citationsWidth, sign: -1, min: 160, max: 480, set: setCitationsWidth, storageKey: "rag.citationsWidth" })}
          />

          <aside className="citations-panel">
            <div className="citations-header"><Search size={14} />참조 문서</div>
            {activeCitations.length > 0 ? (
              <ul className="citations-list">
                {activeCitations.map((c) => (
                  <li key={c.number}>
                    <button className={`citation-link ${c.sourceKind === "concept-cards" ? "card" : ""}`} type="button" onClick={() => openCitationPopup(c)}>
                      <span className="citation-num">[{c.number}]</span>
                      <span className="citation-title">{c.sourceKind === "concept-cards" ? (c.locator?.concept || c.title) : c.title}</span>
                      {c.sourceKind === "concept-cards" && <span className="citation-kind">🧠 정리 카드</span>}
                      {c.locator?.page && <span className="citation-loc">p.{c.locator.page}</span>}
                      {c.sourceKind !== "concept-cards" && c.breadcrumb && <span className="citation-crumb">{c.breadcrumb}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty" style={{ padding: "12px 14px" }}>없음</p>
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}

// ── Helpers ──

function statusLabel(status) {
  if (status === "indexed") return "임베딩됨";
  if (status === "failed_with_action") return "임베딩 실패";
  if (status === "embedding" || status === "extracting") return "처리 중";
  return "임베딩 대기";
}

function buildTree(sources) {
  const root = { dirs: new Map(), files: [] };
  for (const s of sources) {
    const rel = s.relative_path || "";
    if (!rel) {
      root.files.push({ source: s, name: s.title });
      continue;
    }
    const parts = rel.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ source: s, name: parts[parts.length - 1] || s.title });
  }
  return root;
}

function fileListToEntries(fileList) {
  return Array.from(fileList || []).map((f) => ({ file: f, name: f.webkitRelativePath || f.name }));
}

async function collectEntries(dataTransfer) {
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const fsEntries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (fsEntries.length) {
    const out = [];
    for (const entry of fsEntries) await traverseEntry(entry, "", out);
    if (out.length) return out;
  }
  return fileListToEntries(dataTransfer.files);
}

function traverseEntry(entry, path, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => { out.push({ file, name: path + file.name }); resolve(); },
        () => resolve()
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(
          async (batch) => {
            if (!batch.length) { resolve(); return; }
            for (const e of batch) await traverseEntry(e, `${path}${entry.name}/`, out);
            readBatch();
          },
          () => resolve()
        );
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

function renderAnswerText(text, citations, onCitationClick) {
  if (!citations?.length) return text;
  const parts = String(text).split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (match) {
      const citation = citations.find((c) => c.number === parseInt(match[1], 10));
      if (citation) {
        const isCard = citation.sourceKind === "concept-cards";
        return (
          <button
            key={i}
            className={`citation-ref ${isCard ? "card" : ""}`}
            type="button"
            title={isCard ? `🧠 정리 카드: ${citation.locator?.concept || citation.title}` : citation.breadcrumb || citation.title}
            onClick={() => onCitationClick(citation)}
          >
            {part}
          </button>
        );
      }
    }
    return part;
  });
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Downscale large screenshots before sending to the vision model — big images
// blow up the vision-token count and time out. Longest side capped, JPEG output.
async function downscaleImage(dataUrl, maxDim = 1400) {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return dataUrl;
  }
}

// Render the composer text with a leading /command and @Agent mentions shown as
// banner pills. Pills use box-shadow (not padding) so character widths — and thus
// the textarea caret — stay perfectly aligned with this overlay.
function renderInputHighlight(text, profiles) {
  if (!text) return null;
  const nodes = [];
  let rest = text;
  let k = 0;
  const cmd = rest.match(/^\/[^\s]*/);
  if (cmd) {
    nodes.push(<span key={`c${k++}`} className="cmd-pill">{cmd[0]}</span>);
    rest = rest.slice(cmd[0].length);
  }
  const names = (profiles || []).map((p) => p.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (names.length) {
    const pattern = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(`@(?:${pattern})`, "g");
    let last = 0;
    let m;
    while ((m = re.exec(rest)) !== null) {
      if (m.index > last) nodes.push(rest.slice(last, m.index));
      nodes.push(<span key={`m${k++}`} className="mention-pill">{m[0]}</span>);
      last = m.index + m[0].length;
      if (re.lastIndex === m.index) re.lastIndex += 1;
    }
    nodes.push(rest.slice(last));
  } else {
    nodes.push(rest);
  }
  return nodes;
}

// Wrap query keywords (length >= 2) in <mark> within already-escaped text.
function highlightTerms(escapedText, query) {
  const terms = String(query || "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return escapedText;
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  try {
    return escapedText.replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
  } catch {
    return escapedText;
  }
}

async function fetchJson(url, options = {}) {
  const token = localStorage.getItem("ark.adminToken");
  const headers = { ...(options.headers || {}) };
  // Central-host instances gate mutations on the admin token; a personal
  // local instance ignores the header, so sending it always is harmless.
  if (token) headers["x-ark-admin"] = token;
  const response = await fetch(`${API}${url}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  return payload;
}

createRoot(document.getElementById("root")).render(<App />);
