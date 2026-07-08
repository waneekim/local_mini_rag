import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_PORT = 9223;
const CDP_TIMEOUT_MS = 15_000;
let launchedProcess = null;
let browserStartPromise = null;

export async function openCaptureBrowser(url, options = {}) {
  const targetUrl = normalizeCaptureUrl(url);
  const port = await ensureBrowser({ ...options, initialUrl: targetUrl });
  let target = await findTargetForUrl(port, targetUrl);
  if (!target) target = await createTarget(port, targetUrl);

  await activateTarget(port, target.id).catch(() => {});
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable").catch(() => {});
    await client.send("Runtime.enable").catch(() => {});
    await client.send("Page.bringToFront").catch(() => {});
    await delay(Number(process.env.RAG_BROWSER_OPEN_SETTLE_MS || 1000));
    await activateTarget(port, target.id).catch(() => {});
    await client.send("Page.bringToFront").catch(() => {});
    const refreshed = await findTargetById(port, target.id).catch(() => null);
    return { ok: true, port, targetId: target.id, url: refreshed?.url || target.url || targetUrl };
  } finally {
    client.close();
  }
}

export async function captureUrlScreenshot(url, options = {}) {
  const targetUrl = normalizeCaptureUrl(url);
  const port = await ensureBrowser({ ...options, initialUrl: targetUrl });
  let target = await findTargetForUrl(port, targetUrl);
  let createdTarget = false;
  if (!target) {
    target = await createTarget(port, targetUrl);
    createdTarget = true;
  }
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {});
    if (createdTarget || shouldNavigateTarget(target.url, targetUrl)) {
      const load = client.waitForEvent("Page.loadEventFired", Number(process.env.RAG_BROWSER_LOAD_TIMEOUT_MS || 45_000)).catch(() => {});
      await client.send("Page.navigate", { url: targetUrl });
      await load;
    }
    await waitForPageText(client, Number(process.env.RAG_BROWSER_CAPTURE_TEXT_WAIT_MS || 10_000)).catch(() => {});
    await delay(Number(process.env.RAG_BROWSER_CAPTURE_WAIT_MS || 1000));

    await client.send("Page.bringToFront").catch(() => {});
    const pageInfo = await evaluatePageInfo(client);
    const metrics = await client.send("Page.getLayoutMetrics").catch(() => ({}));
    const content = metrics.cssContentSize || metrics.contentSize || {};
    const maxWidth = Number(process.env.RAG_BROWSER_CAPTURE_MAX_WIDTH || 2200);
    const maxHeight = Number(process.env.RAG_BROWSER_CAPTURE_MAX_HEIGHT || 30000);
    const width = Math.max(1, Math.ceil(Math.min(content.width || pageInfo.width || 1280, maxWidth)));
    const fullHeight = Math.max(1, Math.ceil(content.height || pageInfo.height || 900));
    const height = Math.max(1, Math.ceil(Math.min(fullHeight, maxHeight)));
    const format = String(process.env.RAG_BROWSER_CAPTURE_FORMAT || "jpeg").toLowerCase() === "png" ? "png" : "jpeg";
    const quality = Math.max(30, Math.min(100, Number(process.env.RAG_BROWSER_CAPTURE_QUALITY || 85)));

    await client.send("Emulation.setDeviceMetricsOverride", {
      mobile: false,
      width,
      height: Math.min(height, 2000),
      deviceScaleFactor: 1
    }).catch(() => {});

    const shot = await client.send("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality } : {}),
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    });

    const finalUrl = await client.send("Runtime.evaluate", { expression: "location.href", returnByValue: true })
      .then((r) => r.result?.value || targetUrl)
      .catch(() => targetUrl);
    const mime = format === "png" ? "image/png" : "image/jpeg";
    return {
      ok: true,
      url: finalUrl,
      title: pageInfo.title || targetUrl,
      width,
      height,
      truncated: fullHeight > height,
      image: `data:${mime};base64,${shot.data}`
    };
  } finally {
    client.close();
    if (createdTarget && String(process.env.RAG_BROWSER_CAPTURE_KEEP_TAB || "0") !== "1") {
      await closeTarget(port, target.id).catch(() => {});
    }
  }
}

export async function extractUrlTextFromBrowser(url, options = {}) {
  const targetUrl = normalizeCaptureUrl(url);
  const port = await ensureBrowser({ ...options, initialUrl: targetUrl });
  let target = await findTargetForUrl(port, targetUrl);
  let createdTarget = false;
  if (!target) {
    target = await createTarget(port, targetUrl);
    createdTarget = true;
  }

  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable").catch(() => {});
    await client.send("Runtime.enable");
    if (createdTarget || shouldNavigateTarget(target.url, targetUrl)) {
      const load = client.waitForEvent("Page.loadEventFired", Number(process.env.RAG_BROWSER_LOAD_TIMEOUT_MS || 45_000)).catch(() => {});
      await client.send("Page.navigate", { url: targetUrl });
      await load;
    }
    const info = await waitForPageText(client, Number(process.env.RAG_BROWSER_TEXT_WAIT_MS || 45_000));
    const extracted = String(info.text || "").trim();
    if (!extracted) {
      throw new Error("Browser page text was empty. The page may still be loading or may render content as images/canvas only.");
    }
    return {
      ok: true,
      url: info.url || target.url || targetUrl,
      title: info.title || target.title || targetUrl,
      text: extracted,
      textLength: extracted.length,
      selectedLength: info.selectedLength || 0,
      innerTextLength: info.innerTextLength || 0,
      readyState: info.readyState || "",
      source: info.source || "innerText"
    };
  } finally {
    client.close();
    if (createdTarget && String(process.env.RAG_BROWSER_TEXT_KEEP_TAB || "0") !== "1") {
      await closeTarget(port, target.id).catch(() => {});
    }
  }
}

async function ensureBrowser(options = {}) {
  const port = Number(process.env.RAG_BROWSER_DEBUG_PORT || DEFAULT_PORT);
  if (await cdpReady(port)) return port;
  if (browserStartPromise) return browserStartPromise;
  browserStartPromise = startBrowser(port, options).finally(() => {
    browserStartPromise = null;
  });
  return browserStartPromise;
}

async function startBrowser(port, options = {}) {
  if (await cdpReady(port)) return port;
  const baseDataDir = options.dataDir || process.cwd();
  const configuredProfileDir = process.env.RAG_BROWSER_USER_DATA_DIR || "";
  const primaryProfileDir = configuredProfileDir || join(baseDataDir, "browser-capture-profile");
  try {
    return await launchBrowser(port, primaryProfileDir, options.initialUrl);
  } catch (error) {
    if (configuredProfileDir) throw error;
    let lastError = error;
    const tempRecoveryBase = join(tmpdir(), "ark-browser-capture");
    const recoveryProfileDirs = [
      join(baseDataDir, "browser-capture-profile-recovery"),
      join(tempRecoveryBase, "browser-capture-profile-recovery"),
      join(tempRecoveryBase, `browser-capture-profile-recovery-${Date.now()}`)
    ];
    for (const recoveryProfileDir of recoveryProfileDirs) {
      try { launchedProcess?.kill?.(); } catch {}
      await delay(500);
      try {
        return await launchBrowser(port, recoveryProfileDir, options.initialUrl);
      } catch (recoveryError) {
        lastError = recoveryError;
      }
    }
    throw lastError;
  }
}

async function launchBrowser(port, profileDir, initialUrl = "") {
  if (await cdpReady(port)) return port;
  const exe = findBrowserExecutable();
  if (!exe) {
    throw new Error("Chrome/Edge executable was not found. Set RAG_BROWSER_PATH to enable automated capture.");
  }
  await mkdir(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--new-window",
    initialUrl && /^https?:\/\//i.test(initialUrl) ? initialUrl : "about:blank"
  ];
  launchedProcess = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
  launchedProcess.once("error", () => {});
  launchedProcess.unref();
  await waitForCdp(port, Number(process.env.RAG_BROWSER_START_TIMEOUT_MS || 15_000));
  return port;
}

function findBrowserExecutable() {
  const configured = process.env.RAG_BROWSER_PATH;
  if (configured && existsSync(configured)) return configured;
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        ]
      : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

async function cdpReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => ({}));
    return Boolean(payload.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpReady(port)) return;
    await delay(300);
  }
  throw new Error(`Browser DevTools endpoint did not start on port ${port}.`);
}

async function createTarget(port, url) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  let response = await fetch(endpoint, { method: "PUT", signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
  if (!response.ok) response = await fetch(endpoint, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Failed to create browser target: HTTP ${response.status}`);
  const target = await response.json();
  if (!target.webSocketDebuggerUrl) throw new Error("Browser target did not expose a DevTools websocket.");
  return target;
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Failed to list browser targets: HTTP ${response.status}`);
  const targets = await response.json();
  return Array.isArray(targets) ? targets : [];
}

async function findTargetById(port, targetId) {
  if (!targetId) return null;
  const targets = await listTargets(port).catch(() => []);
  return targets.find((target) => target?.id === targetId) || null;
}

async function findReusableBlankTarget(port) {
  const targets = await listTargets(port).catch(() => []);
  return targets.find((target) =>
    target?.type === "page" &&
    target.webSocketDebuggerUrl &&
    isBlankLikeTargetUrl(target.url)
  ) || null;
}

function isBlankLikeTargetUrl(url) {
  const value = String(url || "").toLowerCase();
  return !value || value === "about:blank" || value.startsWith("chrome://newtab") || value.startsWith("edge://newtab");
}

async function findTargetForUrl(port, targetUrl) {
  const targets = await listTargets(port).catch(() => []);
  const scored = targets
    .filter((target) => target?.type === "page" && target.webSocketDebuggerUrl)
    .map((target) => ({ target, score: scoreTargetUrl(target.url, targetUrl) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.target || null;
}

function scoreTargetUrl(candidateUrl, targetUrl) {
  const candidate = String(candidateUrl || "");
  if (!/^https?:\/\//i.test(candidate)) return 0;
  if (candidate === targetUrl) return 100;
  try {
    const wanted = new URL(targetUrl);
    const current = new URL(candidate);
    const wantedNoHash = `${wanted.origin}${wanted.pathname}${wanted.search}`;
    const currentNoHash = `${current.origin}${current.pathname}${current.search}`;
    if (wantedNoHash === currentNoHash) return 95;
    if (wanted.origin === current.origin && wanted.pathname === current.pathname) return 85;
    if (wanted.origin === current.origin && (current.pathname.startsWith(wanted.pathname) || wanted.pathname.startsWith(current.pathname))) return 70;
    if (wanted.hostname === current.hostname) return 45;
  } catch {
    return 0;
  }
  return 0;
}

function shouldNavigateTarget(candidateUrl, targetUrl) {
  const candidate = String(candidateUrl || "");
  if (!candidate || candidate === "about:blank") return true;
  return scoreTargetUrl(candidate, targetUrl) < 45;
}

async function activateTarget(port, targetId) {
  if (!targetId) return;
  await fetch(`http://127.0.0.1:${port}/json/activate/${encodeURIComponent(targetId)}`, {
    signal: AbortSignal.timeout(2000)
  });
}

async function closeTarget(port, targetId) {
  if (!targetId) return;
  await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`, {
    signal: AbortSignal.timeout(2000)
  });
}

async function evaluatePageInfo(client) {
  const expression = `(() => {
    const body = document.body || {};
    const doc = document.documentElement || {};
    const width = Math.max(body.scrollWidth || 0, doc.scrollWidth || 0, body.offsetWidth || 0, doc.offsetWidth || 0, doc.clientWidth || 0, innerWidth || 0);
    const height = Math.max(body.scrollHeight || 0, doc.scrollHeight || 0, body.offsetHeight || 0, doc.offsetHeight || 0, doc.clientHeight || 0, innerHeight || 0);
    return { title: document.title || "", width, height };
  })()`;
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true });
  return result.result?.value || {};
}

async function waitForPageText(client, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  const pollMs = Math.max(250, Number(process.env.RAG_BROWSER_TEXT_POLL_MS || 500));
  const minSettleMs = Math.max(0, Number(process.env.RAG_BROWSER_TEXT_MIN_SETTLE_MS || 2500));
  const finalReadDelayMs = Math.max(0, Number(process.env.RAG_BROWSER_TEXT_FINAL_READ_DELAY_MS || 500));
  const stableReadsNeeded = Math.max(1, Number(process.env.RAG_BROWSER_TEXT_STABLE_READS || 3));
  let firstTextAt = 0;
  let lastComparable = "";
  let stableReads = 0;
  let bestInfo = {};
  let lastInfo = {};
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const info = await evaluatePageText(client);
      lastInfo = info || {};
      const text = String(lastInfo.text || "").trim();
      if (text && text.length >= String(bestInfo.text || "").trim().length) bestInfo = lastInfo;

      if (text) {
        const now = Date.now();
        if (!firstTextAt) firstTextAt = now;
        const comparable = comparablePageText(text);
        stableReads = isStableText(lastComparable, comparable) ? stableReads + 1 : 1;
        lastComparable = comparable;

        const settledLongEnough = now - firstTextAt >= minSettleMs;
        const ready = lastInfo.readyState === "complete" || settledLongEnough;
        if (ready && settledLongEnough && stableReads >= stableReadsNeeded && !looksLikeLoadingShellText(text)) {
          if (finalReadDelayMs) await delay(finalReadDelayMs);
          const finalInfo = await evaluatePageText(client).catch(() => lastInfo);
          const finalText = String(finalInfo?.text || "").trim();
          if (finalText && !looksLikeLoadingShellText(finalText)) {
            return finalText.length >= text.length ? finalInfo : lastInfo;
          }
          return lastInfo;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await delay(pollMs);
  }
  if (lastError && !String(bestInfo.text || lastInfo.text || "").trim()) throw lastError;
  return bestInfo.text ? bestInfo : lastInfo;
}

function comparablePageText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isStableText(previous, current) {
  if (!previous || !current) return false;
  if (previous === current) return true;
  const diff = Math.abs(previous.length - current.length);
  const tolerance = Math.max(12, Math.floor(Math.max(previous.length, current.length) * 0.01));
  return diff <= tolerance && previous.slice(0, 200) === current.slice(0, 200);
}

function looksLikeLoadingShellText(text) {
  const value = comparablePageText(text).toLowerCase();
  if (!value) return false;
  const hasLoading = value.includes("loading");
  const shellHits = ["micom", "wifi", "lcd", "mobileapp", "server", "grid view", "word view"]
    .filter((token) => value.includes(token)).length;
  const contentMarkers = ["description", "pre-condition", "post-condition", "functional requirements", "basic flow", "3.1.", "1."];
  const hasContentMarkers = contentMarkers.some((token) => value.includes(token));
  return hasLoading && shellHits >= 4 && !hasContentMarkers;
}
async function evaluatePageText(client) {
  const expression = String.raw`(() => {
    const normalize = (value) => String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const collectText = (doc) => {
      const parts = [];
      try {
        const bodyText = doc.body?.innerText || doc.documentElement?.innerText || "";
        if (bodyText) parts.push(bodyText);
      } catch {}
      try {
        for (const frame of doc.querySelectorAll("iframe,frame")) {
          try {
            if (frame.contentDocument) parts.push(collectText(frame.contentDocument));
          } catch {}
        }
      } catch {}
      return parts.filter(Boolean).join("\n\n");
    };
    const root = document.body || document.documentElement;
    let selected = "";
    try {
      const selection = window.getSelection();
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(root);
      selection.addRange(range);
      selected = selection.toString();
    } catch {}
    const selectedText = normalize(selected);
    const innerText = normalize(collectText(document));
    const text = selectedText.length >= innerText.length ? selectedText : innerText;
    try { window.getSelection()?.removeAllRanges(); } catch {}
    return {
      title: document.title || "",
      url: location.href,
      readyState: document.readyState,
      selectedLength: selectedText.length,
      innerTextLength: innerText.length,
      source: selectedText.length >= innerText.length ? "selection" : "innerText",
      text
    };
  })()`;
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "page text evaluation failed";
    throw new Error(detail);
  }
  return result.result?.value || {};
}

function normalizeCaptureUrl(url) {
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value)) throw new Error("A valid http(s) URL is required.");
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  static connect(url) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket !== "function") {
        reject(new Error("This Node runtime does not provide WebSocket support for browser capture."));
        return;
      }
      const client = new CdpClient(url);
      const timer = setTimeout(() => reject(new Error("Timed out connecting to browser DevTools.")), CDP_TIMEOUT_MS);
      client.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(client);
      }, { once: true });
      client.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Failed to connect to browser DevTools."));
      }, { once: true });
    });
  }

  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.socket.addEventListener("message", (event) => this.handleMessage(event));
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("Browser DevTools connection closed."));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const message = { id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify(message));
    return promise;
  }

  waitForEvent(method, timeoutMs = CDP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(method) || [];
        this.waiters.set(method, list.filter((item) => item.resolve !== resolve));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const list = this.waiters.get(method) || [];
      list.push({ resolve, timer });
      this.waiters.set(method, list);
    });
  }

  handleMessage(event) {
    const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
    const message = JSON.parse(raw);
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method && this.waiters.has(message.method)) {
      const list = this.waiters.get(message.method) || [];
      const waiter = list.shift();
      if (!list.length) this.waiters.delete(message.method);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(message.params || {});
      }
    }
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}
