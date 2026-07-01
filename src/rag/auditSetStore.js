import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { id } from "./ids.js";

export class AuditSetStore {
  constructor(dataDir) {
    this.path = join(dataDir, "auditSets.json");
    this._data = this._load();
  }

  _load() {
    if (!existsSync(this.path)) return { activeAuditSet: "", auditSets: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      const auditSets = Array.isArray(parsed.auditSets) ? parsed.auditSets.map(normalizeAuditSet).filter(Boolean) : [];
      return {
        activeAuditSet: String(parsed.activeAuditSet || auditSets[0]?.id || ""),
        auditSets
      };
    } catch {
      return { activeAuditSet: "", auditSets: [] };
    }
  }

  _persist() {
    writeFileSync(this.path, JSON.stringify(this._data, null, 2), "utf8");
  }

  state() {
    return this._data;
  }

  list() {
    return this._data.auditSets;
  }

  active() {
    return this.get(this._data.activeAuditSet) || this._data.auditSets[0] || null;
  }

  get(auditSetId) {
    const target = String(auditSetId || "").trim();
    if (!target) return null;
    return this._data.auditSets.find((set) => set.id === target) || null;
  }

  upsert(input = {}) {
    const current = this.get(input.id) || {};
    const next = normalizeAuditSet({
      ...current,
      ...input,
      id: input.id || current.id || id("auditset")
    });
    if (!next) throw Object.assign(new Error("검수 세트 이름과 두 Agent가 필요합니다."), { statusCode: 400 });

    const idx = this._data.auditSets.findIndex((set) => set.id === next.id);
    if (idx === -1) this._data.auditSets.push(next);
    else this._data.auditSets[idx] = next;
    if (input.active !== false) this._data.activeAuditSet = next.id;
    this._persist();
    return this.state();
  }
}

function normalizeAuditSet(input) {
  if (!input || typeof input !== "object") return null;
  const name = String(input.name || "").trim();
  const phraseGuideProfileId = String(input.phraseGuideProfileId || "").trim();
  const glossaryProfileId = String(input.glossaryProfileId || "").trim();
  if (!name || !phraseGuideProfileId || !glossaryProfileId) return null;
  return {
    id: String(input.id || "").trim() || id("auditset"),
    name,
    phraseGuideProfileId,
    glossaryProfileId,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}
