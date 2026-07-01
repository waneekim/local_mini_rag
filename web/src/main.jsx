import React, { useEffect, useRef, useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  Camera,
  ChevronDown,
  ChevronRight,
  Database,
  File,
  FileText,
  Folder,
  FolderUp,
  Link,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Trash2,
  Upload,
  X,
  Zap
} from "lucide-react";
import "./styles.css";

const API = "";

const ACCEPTED_FILE_TYPES =
  ".pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xlsm,.xls,.txt,.md,.csv,.json,.html,.htm,.log,.png,.jpg,.jpeg,.tif,.tiff,.webp,.bmp";

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
  const [editingMode, setEditingMode] = useState(null); // mode being edited/created in settings
  const [crop, setCrop] = useState(null); // { src, w, h } captured screenshot to crop
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
  const [textDialog, setTextDialog] = useState(null);
  const [urlDialog, setUrlDialog] = useState(null);
  const [dlgTitle, setDlgTitle] = useState("");
  const [dlgText, setDlgText] = useState("");
  const [dlgUrl, setDlgUrl] = useState("");
  const [dropTarget, setDropTarget] = useState(null);
  const [chatDragOver, setChatDragOver] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsState, setSettingsState] = useState(null);
  const [presetName, setPresetName] = useState("");
  const [settingsForm, setSettingsForm] = useState(null);

  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem("rag.sidebarWidth")) || 320);
  const [citationsWidth, setCitationsWidth] = useState(() => Number(localStorage.getItem("rag.citationsWidth")) || 220);
  const [inputHeight, setInputHeight] = useState(() => Number(localStorage.getItem("rag.inputHeight")) || 64);

  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
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

  useEffect(() => {
    function onClick() { setMenu(null); }
    function onKey(e) { if (e.key === "Escape") { setMenu(null); setTextDialog(null); setUrlDialog(null); setCrop(null); setDragRect(null); } }
    // Paste a screenshot image anywhere in the app → extract text (native ⌃⌘⇧4 → ⌘V).
    function onPaste(e) {
      const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => extractFromImage(reader.result);
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
    const [healthPayload, profilePayload, modePayload, skillPayload] = await Promise.all([
      fetchJson("/v1/health"),
      fetchJson("/api/profiles"),
      fetchJson("/api/modes").catch(() => []),
      fetchJson("/api/skills").catch(() => [])
    ]);
    setHealth(healthPayload);
    setModes(modePayload);
    setSkills(skillPayload);
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
    }
  }

  async function addPath(path, pid) {
    setBusy(true);
    setStatus("경로에서 소스 추가 중");
    try {
      const res = await fetchJson(`/api/profiles/${pid}/sources/path`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path })
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

  // ── Screenshot → Vision LLM → prompt ──

  async function extractFromImage(dataUrl) {
    setBusy(true);
    setStatus("이미지에서 텍스트 추출 중… (수 초~수십 초)");
    try {
      const image = await downscaleImage(dataUrl);
      const { text } = await fetchJson("/api/vision/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image })
      });
      if (text) {
        setQuery((q) => (q ? `${q}\n${text}` : text));
        setStatus("텍스트 추출됨 · 검토 후 전송");
        setTimeout(() => inputRef.current?.focus(), 0);
      } else {
        setStatus("추출된 텍스트가 없습니다");
      }
    } catch (e) {
      window.alert(`텍스트 추출 오류: ${e.message}`);
      setStatus("추출 오류");
    } finally {
      setBusy(false);
    }
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
    await extractFromImage(c.toDataURL("image/png"));
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

  // ── Text dialog ──

  function openTextDialog(pid) {
    setDlgTitle("");
    setDlgText("");
    setTextDialog({ pid });
  }

  async function submitTextDialog() {
    if (!dlgText.trim()) return;
    const pid = textDialog.pid;
    setTextDialog(null);
    setBusy(true);
    try {
      await addText(dlgTitle.trim() || "Pasted text", dlgText, pid);
      setStatus("텍스트 소스 추가됨");
    } finally {
      setBusy(false);
    }
  }

  // ── URL dialog ──

  function openUrlDialog(pid) {
    setDlgTitle("");
    setDlgUrl("");
    setUrlDialog({ pid });
  }

  async function submitUrlDialog() {
    if (!dlgUrl.trim()) return;
    const pid = urlDialog.pid;
    setUrlDialog(null);
    try {
      await addUrl(dlgUrl.trim(), dlgTitle.trim(), pid);
    } catch (e) {
      setStatus(`URL 오류: ${e.message}`);
      window.alert(`URL을 추가하지 못했습니다: ${e.message}`);
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
    if (!text || busy) return;
    if (text.startsWith("/")) {
      setQuery("");
      setSuggest(null);
      await handleCommand(text);
      return;
    }
    const { profileId, agentName, cleanText } = parseMention(text);
    const targetId = profileId || activeProfileId;
    if (!targetId) return;
    setQuery("");
    setSuggest(null);
    await sendMessage(cleanText || text, chatMode, targetId, agentName);
  }

  async function sendMessage(text, mode, targetId = activeProfileId, agentName = "") {
    if (!targetId) return;
    const modeLabel = modes.find((m) => m.key === mode)?.label;
    const crossAgent = agentName && targetId !== activeProfileId ? agentName : "";
    const userMsg = { id: String(Date.now()), role: "user", content: text, mode, modeLabel, agentName: crossAgent };
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);
    setStatus("답변 생성 중");
    try {
      const payload = await fetchJson(`/api/profiles/${targetId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: text, topK: 4, mode })
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
          panelCitations: panelCites
        }
      ]);
      setActiveCitations(panelCites);
      setStatus("답변 완료");
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
    if (citation.locator?.relativePath) locatorParts.push(citation.locator.relativePath);
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
    if (!list.some((m) => m.key === chatMode)) setChatMode(list[0]?.key || "general");
    return list;
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
            title={`${source.relative_path || source.title} · ${statusLabel(source.status)} · 드래그해서 다른 Agent로 복사`}
            draggable
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

      {/* Context menu */}
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.kind === "agent" ? (
            <>
              <button onClick={() => { pickFiles(menu.pid); setMenu(null); }}><Upload size={14} />파일 추가</button>
              <button onClick={() => { pickFolder(menu.pid); setMenu(null); }}><FolderUp size={14} />폴더 추가</button>
              <button onClick={() => { openTextDialog(menu.pid); setMenu(null); }}><FileText size={14} />텍스트 추가</button>
              <button onClick={() => { openUrlDialog(menu.pid); setMenu(null); }}><Link size={14} />URL 추가</button>
            </>
          ) : (
            <>
              <button onClick={() => { embedSources([menu.source.id], menu.pid); setMenu(null); }}><Zap size={14} />임베딩</button>
              <button className="danger" onClick={() => { removeSource(menu.source); setMenu(null); }}><Trash2 size={14} />삭제</button>
            </>
          )}
        </div>
      )}

      {/* Text dialog */}
      {textDialog && (
        <div className="modal-overlay" onClick={() => setTextDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>텍스트 소스 추가</h2>
              <button className="icon-button" type="button" onClick={() => setTextDialog(null)}><X size={18} /></button>
            </div>
            <div className="settings-section">
              <div className="settings-grid">
                <label>제목<input value={dlgTitle} onChange={(e) => setDlgTitle(e.target.value)} placeholder="제목 (선택)" /></label>
                <label>내용<textarea value={dlgText} onChange={(e) => setDlgText(e.target.value)} placeholder="텍스트 붙여넣기" style={{ minHeight: 180 }} /></label>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary" onClick={() => setTextDialog(null)}>취소</button>
              <button type="button" onClick={submitTextDialog} disabled={!dlgText.trim()}>추가</button>
            </div>
          </div>
        </div>
      )}

      {/* URL dialog */}
      {urlDialog && (
        <div className="modal-overlay" onClick={() => setUrlDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>URL 소스 추가</h2>
              <button className="icon-button" type="button" onClick={() => setUrlDialog(null)}><X size={18} /></button>
            </div>
            <div className="settings-section">
              <div className="settings-grid">
                <label>
                  URL
                  <input
                    value={dlgUrl}
                    autoFocus
                    onChange={(e) => setDlgUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitUrlDialog(); } }}
                    placeholder="https://example.com/article"
                  />
                </label>
                <label>제목 <span className="optional">(선택 · 비우면 페이지 제목)</span><input value={dlgTitle} onChange={(e) => setDlgTitle(e.target.value)} placeholder="제목" /></label>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary" onClick={() => setUrlDialog(null)}>취소</button>
              <button type="button" onClick={submitUrlDialog} disabled={busy || !dlgUrl.trim()}>{busy ? "가져오는 중…" : "추가"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Settings modal */}
      {settingsOpen && settingsForm && settingsState && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>연결 설정</h2>
              <button className="icon-button" type="button" onClick={() => setSettingsOpen(false)}><X size={18} /></button>
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

            <div className="modal-footer">
              <button type="button" className="secondary" onClick={() => setSettingsOpen(false)}>취소</button>
              <button type="button" onClick={saveSettings} disabled={!presetName.trim()}>저장 · 적용</button>
            </div>
          </div>
        </div>
      )}

      {/* Sidebar: agents */}
      <aside className="sidebar">
        <div className="brand">
          <Database size={21} aria-hidden="true" />
          <div>
            <h1>Profile RAG</h1>
            <p>{health?.llmProvider?.model || health?.llmProvider?.provider || "checking"}</p>
          </div>
          <button className="icon-button" type="button" title="설정" onClick={openSettings} style={{ marginLeft: "auto" }}>
            <Settings size={18} />
          </button>
        </div>

        <div className="agent-toolbar">
          <span className="agent-toolbar-label">Agents</span>
          <button className="icon-button" type="button" title="Agent 추가" onClick={createProfile}><Plus size={18} /></button>
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
      </aside>

      <div
        className="resizer"
        role="separator"
        onMouseDown={(e) => startResize(e, { startWidth: sidebarWidth, sign: 1, min: 240, max: 560, set: setSidebarWidth, storageKey: "rag.sidebarWidth" })}
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
                      <p className="bubble-text">
                        {msg.role === "assistant" ? renderAnswerText(msg.content, msg.citations, openCitationPopup) : msg.content}
                      </p>
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
                    <button className="tool" type="button" title="파일 추가" onClick={() => pickFiles(activeProfileId)}><Upload size={16} /></button>
                    <button className="tool" type="button" title="폴더 추가" onClick={() => pickFolder(activeProfileId)}><FolderUp size={16} /></button>
                    <button className="tool" type="button" title="텍스트 추가" onClick={() => openTextDialog(activeProfileId)}><FileText size={16} /></button>
                    <button className="tool" type="button" title="URL 추가" onClick={() => openUrlDialog(activeProfileId)}><Link size={16} /></button>
                    <button className="tool" type="button" title="스크린샷 검증 · 클릭=화면 공유 후 영역선택 / 또는 ⌃⌘⇧4로 캡처 후 ⌘V 붙여넣기" onClick={captureScreenshot}><Camera size={16} /></button>
                    <span className="tool-sep" />
                    <button
                      className={`tool toggle ${autoIndex ? "on" : ""}`}
                      type="button"
                      title={`추가 시 자동 임베딩: ${autoIndex ? "켜짐" : "꺼짐"}`}
                      onClick={() => toggleAutoIndex()}
                    >
                      <Zap size={16} />
                    </button>
                  </div>
                  <button type="button" onClick={runChat} disabled={busy || !query.trim()} aria-label="전송" className="send-btn">
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
                    <button className="citation-link" type="button" onClick={() => openCitationPopup(c)}>
                      <span className="citation-num">[{c.number}]</span>
                      <span className="citation-title">{c.title}</span>
                      {c.locator?.page && <span className="citation-loc">p.{c.locator.page}</span>}
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
        return (
          <button key={i} className="citation-ref" type="button" onClick={() => onCitationClick(citation)}>
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

async function fetchJson(url, options) {
  const response = await fetch(`${API}${url}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  return payload;
}

createRoot(document.getElementById("root")).render(<App />);
