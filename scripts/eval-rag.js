#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "../src/app.js";

const args = parseArgs(process.argv.slice(2));
const evalDir = resolve(process.cwd(), args.dir || "data/evals");
const files = listEvalFiles(evalDir);

if (!files.length) {
  console.log(`No RAG eval files found in ${evalDir}`);
  console.log("Create JSON files with { \"cases\": [{ \"agent\": \"Agent name\", \"mode\": \"search\", \"query\": \"...\" }] }.");
  process.exit(0);
}

const app = await createApp({ logger: false });

try {
  const profiles = await inject(app, "GET", "/api/profiles");
  const cases = files.flatMap((file) => readCases(file).map((testCase, index) => ({ ...testCase, file, index })));
  const results = [];

  for (const testCase of cases) {
    const result = await runCase(app, profiles, testCase, args);
    results.push(result);
    printCase(result);
  }

  const summary = summarize(results);
  if (args.json) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    console.log(
      `\nRAG eval: ${summary.passed}/${summary.total} passed · ` +
        `recall@k ${summary.avgRecall.toFixed(2)} · citation precision ${summary.avgPrecision.toFixed(2)}`
    );
  }
  if (summary.failed) process.exitCode = 1;
} finally {
  await app.close();
}

async function runCase(app, profiles, testCase, args) {
  const profile = resolveProfile(profiles, testCase);
  if (!profile) {
    return fail(testCase, `Profile not found: ${testCase.profileId || testCase.agent || testCase.profile || "(missing)"}`);
  }

  const searchOnly = args.searchOnly || testCase.searchOnly;
  const payload = {
    query: testCase.query,
    mode: testCase.mode || args.mode || "search",
    topK: Number(testCase.topK || args.topK || 8),
    ...(testCase.candidateK || args.candidateK ? { candidateK: Number(testCase.candidateK || args.candidateK) } : {}),
    ...(testCase.rerank !== undefined || args.rerank !== undefined
      ? { rerank: testCase.rerank ?? args.rerank }
      : {})
  };
  const endpoint = `/api/profiles/${profile.id}/${searchOnly ? "search" : "chat"}`;
  const response = await inject(app, "POST", endpoint, payload);
  const hits = response.hits || response.citations || [];
  const expectedSources = asArray(testCase.expectedSources);
  const sourceEval = evaluateSources(hits, expectedSources);
  const answerEval = searchOnly ? { passed: true, errors: [] } : evaluateAnswer(response.answer || "", testCase, response);
  const passed = sourceEval.passed && answerEval.passed;

  return {
    name: testCase.name || `${profile.name}: ${testCase.query}`,
    file: testCase.file,
    index: testCase.index,
    profileId: profile.id,
    agent: profile.name,
    mode: payload.mode,
    query: testCase.query,
    passed,
    recall: sourceEval.recall,
    precision: sourceEval.precision,
    expectedSources,
    actualSources: hits.map(sourceLabel),
    retrieval: response.retrieval || {},
    errors: [...sourceEval.errors, ...answerEval.errors]
  };
}

function evaluateSources(hits, expectedSources) {
  if (!expectedSources.length) return { passed: true, recall: 1, precision: 1, errors: [] };
  const matched = expectedSources.filter((expected) => hits.some((hit) => matchesSource(hit, expected)));
  const relevantHits = hits.filter((hit) => expectedSources.some((expected) => matchesSource(hit, expected)));
  const recall = matched.length / expectedSources.length;
  const precision = hits.length ? relevantHits.length / hits.length : 0;
  const errors = [];
  if (matched.length !== expectedSources.length) {
    const missing = expectedSources.filter((expected) => !matched.includes(expected));
    errors.push(`missing expected sources: ${missing.join(", ")}`);
  }
  return { passed: errors.length === 0, recall, precision, errors };
}

function fail(testCase, message) {
  return {
    name: testCase.name || testCase.query || `${testCase.file}:${testCase.index + 1}`,
    file: testCase.file,
    index: testCase.index,
    profileId: testCase.profileId || "",
    agent: testCase.agent || testCase.profile || "",
    mode: testCase.mode || "",
    query: testCase.query || "",
    passed: false,
    recall: 0,
    precision: 0,
    expectedSources: asArray(testCase.expectedSources),
    actualSources: [],
    retrieval: {},
    errors: [message]
  };
}

function evaluateAnswer(answer, testCase, response) {
  const errors = [];
  for (const text of asArray(testCase.mustInclude)) {
    if (!answer.includes(text)) errors.push(`answer missing: ${text}`);
  }
  for (const text of asArray(testCase.mustNotInclude)) {
    if (answer.includes(text)) errors.push(`answer should not include: ${text}`);
  }
  if (testCase.expectedBehavior === "insufficient" && !response.retrieval?.insufficientEvidence) {
    errors.push("expected insufficient evidence retrieval flag");
  }
  return { passed: errors.length === 0, errors };
}

function summarize(results) {
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const avgRecall = average(results.map((result) => result.recall));
  const avgPrecision = average(results.map((result) => result.precision));
  return { total, passed, failed: total - passed, avgRecall, avgPrecision };
}

function printCase(result) {
  const mark = result.passed ? "PASS" : "FAIL";
  const suffix = result.errors.length ? ` · ${result.errors.join("; ")}` : "";
  console.log(`${mark} ${result.name} · recall ${result.recall.toFixed(2)} · precision ${result.precision.toFixed(2)}${suffix}`);
}

function resolveProfile(profiles, testCase) {
  if (testCase.profileId) return profiles.find((profile) => profile.id === testCase.profileId);
  const name = String(testCase.agent || testCase.profile || "").toLowerCase();
  if (!name) return null;
  return profiles.find((profile) => profile.name.toLowerCase() === name) || null;
}

async function inject(app, method, url, payload) {
  const response = await app.inject({
    method,
    url,
    payload,
    headers: payload ? { "content-type": "application/json" } : {}
  });
  if (response.statusCode >= 300) {
    throw new Error(`${method} ${url} failed: ${response.statusCode} ${response.body}`);
  }
  return response.json();
}

function readCases(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.cases)) return parsed.cases;
  throw new Error(`Eval file must contain an array or { cases: [] }: ${file}`);
}

function listEvalFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => join(dir, file));
}

function matchesSource(hit, expected) {
  const needle = String(expected || "").toLowerCase();
  return [hit.sourceId, hit.id, hit.title, hit.fileName, hit.relativePath]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function sourceLabel(hit) {
  return hit.title || hit.fileName || hit.relativePath || hit.sourceId || hit.id || "";
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--search-only") out.searchOnly = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--rerank") out.rerank = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      out[key] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}
