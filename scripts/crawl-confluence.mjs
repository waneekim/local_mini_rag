#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const DEFAULT_URL =
  "https://confluence.sec.samsung.net/spaces/CWGUIDE/pages/791488443/%EC%82%AC%EC%9A%A9%EC%9E%90+%EC%8B%9C%EA%B0%81%EC%97%90%EC%84%9C";
const DEFAULT_BASE = "https://confluence.sec.samsung.net";
const DEFAULT_OUTPUT = "crawled_confluence";

const args = parseArgs(process.argv.slice(2));
const startUrl = args.url || args._[0] || DEFAULT_URL;
const pageId = args.pageId || extractPageId(startUrl);
const baseUrl = args.base || new URL(startUrl).origin || DEFAULT_BASE;
const recursive = Boolean(args.recursive);
const outputDir = path.resolve(projectRoot, args.output || DEFAULT_OUTPUT);
const outputFile = args.file ? path.resolve(projectRoot, args.file) : "";
const cookieFile = args.cookieFile ? path.resolve(projectRoot, args.cookieFile) : "";
const chromePath = args.browser || findChrome();
const port = Number(args.port || 9222);
const keepBrowser = Boolean(args.keepBrowser);
const profileDir = args.profileDir
  ? path.resolve(projectRoot, args.profileDir)
  : fs.mkdtempSync(path.join(os.tmpdir(), "ark-confluence-profile-"));

if (!pageId) {
  fail(`Cannot determine page id from URL. Pass --page-id=791488443 or --url=${DEFAULT_URL}`);
}

async function main() {
  console.log("Confluence crawler");
  console.log(`- URL: ${startUrl}`);
  console.log(`- pageId: ${pageId}`);
  console.log(`- recursive: ${recursive ? "yes" : "no"}`);
  console.log(`- output: ${outputFile || outputDir}`);
  console.log("");

  fs.mkdirSync(outputFile ? path.dirname(outputFile) : outputDir, { recursive: true });

  if (cookieFile) {
    const cookie = fs.readFileSync(cookieFile, "utf8").trim().replace(/^cookie:\s*/i, "");
    await crawlWithNodeFetch(pageId, cookie);
    return;
  }

  if (!chromePath) {
    fail("Chrome was not found. Pass --browser=\"C:\\Path\\To\\chrome.exe\" or use --cookie-file=... .");
  }

  const chrome = launchChrome(chromePath, port, profileDir, startUrl);
  try {
    await waitForDevTools(port);
    console.log("Chrome opened. Complete SSO in that browser window.");
    console.log("The script will continue automatically when the Confluence API is reachable.");

    const client = await connectToPage(port, pageId);
    try {
      await waitForAuthenticatedPage(client, pageId);
      await crawlWithBrowserFetch(client, pageId);
    } finally {
      client.close();
    }
  } finally {
    if (!keepBrowser) chrome.kill();
  }
}

async function crawlWithBrowserFetch(client, rootPageId) {
  const seen = new Set();
  const queue = [{ id: rootPageId, depth: 0 }];
  let saved = 0;

  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);

    const page = await browserFetchJson(client, contentUrl(current.id));
    saved += await savePage(page, current.depth, saved === 0 && outputFile ? outputFile : "");

    if (recursive) {
      const children = await browserFetchJson(client, childUrl(current.id));
      for (const child of children.results || []) queue.push({ id: child.id, depth: current.depth + 1 });
    }
  }

  console.log(`Done. Saved ${saved} markdown file(s).`);
}

async function crawlWithNodeFetch(rootPageId, cookie) {
  const seen = new Set();
  const queue = [{ id: rootPageId, depth: 0 }];
  let saved = 0;

  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);

    const page = await nodeFetchJson(contentUrl(current.id), cookie);
    saved += await savePage(page, current.depth, saved === 0 && outputFile ? outputFile : "");

    if (recursive) {
      const children = await nodeFetchJson(childUrl(current.id), cookie);
      for (const child of children.results || []) queue.push({ id: child.id, depth: current.depth + 1 });
    }
  }

  console.log(`Done. Saved ${saved} markdown file(s).`);
}

async function savePage(page, depth, exactFile = "") {
  if (!page?.id) return 0;
  const html = page.body?.view?.value || page.body?.storage?.value || "";
  const markdown = await htmlToMarkdown(html);
  const title = page.title || `confluence-${page.id}`;
  const filename = exactFile || path.join(outputDir, `${"_".repeat(depth)}${sanitizeFilename(title)}.md`);
  const sourceUrl = `${baseUrl}/spaces/${page.space?.key || ""}/pages/${page.id}`;
  const meta = [
    `# ${title}`,
    "",
    `> Source: ${sourceUrl}`,
    `> Page ID: ${page.id}`,
    `> Version: ${page.version?.number || "N/A"}`,
    `> Crawled: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(filename, meta + markdown.trim() + "\n", "utf8");
  console.log(`Saved: ${path.relative(projectRoot, filename)} (${markdown.length.toLocaleString()} chars)`);
  return 1;
}

async function htmlToMarkdown(html) {
  if (!html) return "";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, "$1 | ")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\n\`\`\`\n${stripTags(code).trim()}\n\`\`\`\n\n`)
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `[${stripTags(label).trim()}](${href})`)
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "![image]($1)")
    .replace(/<[^>]+>/g, "");

  return decodeHtml(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, "");
}

function decodeHtml(value) {
  const named = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
    ["nbsp", " "],
    ["hellip", "..."],
    ["mdash", "-"],
    ["ndash", "-"],
    ["middot", "*"],
  ]);
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, code) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return named.get(code.toLowerCase()) ?? match;
  });
}

async function browserFetchJson(client, url) {
  const payload = await client.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(url)}, { credentials: "include", headers: { accept: "application/json" } });
    return { ok: response.ok, status: response.status, url: response.url, body: await response.text() };
  })()`);
  if (!payload.ok) throw new Error(`Confluence request failed: HTTP ${payload.status} ${payload.url}`);
  return JSON.parse(payload.body);
}

async function nodeFetchJson(url, cookie) {
  const response = await fetch(url, {
    headers: { accept: "application/json", cookie, "user-agent": "Mozilla/5.0" },
    redirect: "manual",
  });
  if (response.status === 301 || response.status === 302 || response.status === 401 || response.status === 403) {
    throw new Error("Authentication failed. Refresh SSO and retry, or use the interactive browser mode without --cookie-file.");
  }
  if (!response.ok) throw new Error(`Confluence request failed: HTTP ${response.status} ${url}`);
  return response.json();
}

function contentUrl(id) {
  return `${baseUrl}/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,body.view,space,version,ancestors`;
}

function childUrl(id) {
  return `${baseUrl}/rest/api/content/${encodeURIComponent(id)}/child/page?limit=100`;
}

function launchChrome(exe, debugPort, userDataDir, url) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const child = spawn(
    exe,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, "--new-window", url],
    { detached: false, stdio: "ignore" }
  );
  child.on("error", (error) => fail(`Failed to launch Chrome: ${error.message}`));
  return child;
}

async function waitForDevTools(debugPort) {
  const url = `http://127.0.0.1:${debugPort}/json/version`;
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await delay(500);
  }
  throw new Error(`Chrome DevTools did not open on port ${debugPort}`);
}

async function connectToPage(debugPort, id) {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const target =
    targets.find((t) => t.type === "page" && String(t.url || "").includes(id)) ||
    targets.find((t) => t.type === "page") ||
    targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error("No debuggable Chrome page found");
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  return client;
}

async function waitForAuthenticatedPage(client, id) {
  const maxAttempts = Number(args.authTimeoutSeconds || 600) * 2;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const href = await client.evaluate("location.href").catch(() => "");
    const onConfluence = String(href || "").startsWith(baseUrl);
    if (onConfluence) {
      try {
        await browserFetchJson(client, contentUrl(id));
        console.log("SSO session detected.");
        return;
      } catch {
        // Keep waiting; the page may still be finalizing login redirects.
      }
    }
    if (attempt % 10 === 0) console.log("Waiting for SSO/login to complete...");
    await delay(500);
  }
  throw new Error("Timed out waiting for SSO. Re-run with --auth-timeout-seconds=1200 if needed.");
}
class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event));
  }

  async open() {
    await this.opened;
  }

  close() {
    this.ws.close();
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(message);
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return response.result?.value;
  }

  onMessage(event) {
    const data = JSON.parse(String(event.data));
    if (!data.id || !this.pending.has(data.id)) return;
    const pending = this.pending.get(data.id);
    this.pending.delete(data.id);
    if (data.error) pending.reject(new Error(data.error.message));
    else pending.resolve(data.result);
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function sanitizeFilename(name) {
  return String(name || "untitled")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "untitled";
}

function extractPageId(value) {
  const text = String(value || "");
  return text.match(/\/pages\/(\d+)/)?.[1] || text.match(/[?&]pageId=(\d+)/)?.[1] || "";
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq === -1) parsed[toCamel(arg.slice(2))] = true;
    else parsed[toCamel(arg.slice(2, eq))] = arg.slice(eq + 1);
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
