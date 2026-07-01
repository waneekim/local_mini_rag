import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_MODES } from "./llmProvider.js";

export const MAX_MODES = 10;
const RETIRED_DEFAULT_KEYS = new Set(["compliance"]);

export class ModeStore {
  constructor(dataDir) {
    this.path = join(dataDir, "modes.json");
    this._modes = this._load();
  }

  _defaults() {
    return Object.entries(CHAT_MODES).map(([key, m]) => ({
      key,
      label: m.label,
      aliases: m.aliases,
      hint: m.hint,
      system: m.system
    }));
  }

  _load() {
    if (!existsSync(this.path)) return this._defaults();
    try {
      const arr = JSON.parse(readFileSync(this.path, "utf8"));
      const cleaned = Array.isArray(arr) ? arr.map(normalizeMode).filter(Boolean) : [];
      const defaults = this._defaults();
      const migrated = migrateModes(cleaned, defaults);
      return migrated.length ? mergeMissingDefaults(migrated, defaults) : defaults;
    } catch {
      return this._defaults();
    }
  }

  _persist() {
    writeFileSync(this.path, JSON.stringify(this._modes, null, 2), "utf8");
  }

  list() {
    return this._modes;
  }

  get(key) {
    const modeKey = String(key || "");
    const lookup = modeKey.toLowerCase();
    const saved = this._modes.find((m) => m.key === modeKey || (m.aliases || []).some((alias) => String(alias).toLowerCase() === lookup));
    if (saved) return saved;
    const fallback = CHAT_MODES[modeKey];
    if (!fallback) return null;
    return {
      key: modeKey,
      label: fallback.label,
      aliases: fallback.aliases,
      hint: fallback.hint,
      system: fallback.system
    };
  }

  upsert(input) {
    const mode = normalizeMode(input);
    if (!mode) throw Object.assign(new Error("이름(label)과 지시문(system)이 필요합니다."), { statusCode: 400 });
    const idx = this._modes.findIndex((m) => m.key === mode.key);
    if (idx === -1) {
      if (this._modes.length >= MAX_MODES) {
        throw Object.assign(new Error(`모드는 최대 ${MAX_MODES}개까지 만들 수 있습니다.`), { statusCode: 400 });
      }
      this._modes.push(mode);
    } else {
      this._modes[idx] = mode;
    }
    this._persist();
    return this._modes;
  }

  remove(key) {
    if (this._modes.length <= 1) {
      throw Object.assign(new Error("최소 1개의 모드가 필요합니다."), { statusCode: 400 });
    }
    this._modes = this._modes.filter((m) => m.key !== key);
    this._persist();
    return this._modes;
  }
}

function normalizeMode(input) {
  if (!input || typeof input !== "object") return null;
  const label = String(input.label || "").trim();
  const system = String(input.system || "").trim();
  if (!label || !system) return null;
  const key = String(input.key || "").trim() || slug(label);
  let aliases = input.aliases;
  if (typeof aliases === "string") aliases = aliases.split(",").map((a) => a.trim()).filter(Boolean);
  if (!Array.isArray(aliases)) aliases = [];
  if (!aliases.includes(label)) aliases = [label, ...aliases];
  return { key, label, aliases, hint: String(input.hint || "").trim(), system };
}

function mergeMissingDefaults(saved, defaults) {
  const keys = new Set(saved.map((mode) => mode.key));
  const aliases = new Set(saved.flatMap((mode) => mode.aliases || []).map((alias) => String(alias).toLowerCase()));
  const merged = [...saved];
  for (const mode of defaults) {
    if (keys.has(mode.key)) continue;
    if ((mode.aliases || []).some((alias) => aliases.has(String(alias).toLowerCase()))) continue;
    merged.push(mode);
    keys.add(mode.key);
    for (const alias of mode.aliases || []) aliases.add(String(alias).toLowerCase());
  }
  return merged;
}

function migrateModes(saved, defaults) {
  const figmaDefault = defaults.find((mode) => mode.key === "figmaAudit");
  return saved
    .filter((mode) => {
      if (RETIRED_DEFAULT_KEYS.has(mode.key)) return false;
      if (mode.key !== "figmaAudit" && mode.label === "규율") return false;
      return true;
    })
    .map((mode) => {
      if (mode.key !== "figmaAudit" || !figmaDefault) return mode;
      return {
        ...mode,
        label: figmaDefault.label,
        aliases: uniqueAliases([...(figmaDefault.aliases || []), ...(mode.aliases || [])]),
        hint: mode.hint || figmaDefault.hint
      };
    });
}

function uniqueAliases(aliases) {
  const seen = new Set();
  const out = [];
  for (const alias of aliases) {
    const value = String(alias || "").trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function slug(label) {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `mode-${Date.now().toString(36)}`;
}
