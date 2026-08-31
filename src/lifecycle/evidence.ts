import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export type EvidenceRecord = {
  id: string;
  at: string;
  agent: string;
  kind: string;
  data: Record<string, unknown>;
  refs: string[];
};

export async function reviewedIds(agentRoot: string): Promise<Set<string>> {
  const file = path.join(agentRoot, "evidence", "reviewed.jsonl");
  const text = await readFile(file, "utf8").catch(() => "");
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (typeof rec.evidenceId === "string") ids.add(rec.evidenceId);
    } catch {}
  }
  return ids;
}

export async function evidenceRecords(agentRoot: string): Promise<EvidenceRecord[]> {
  const evidenceDir = path.join(agentRoot, "evidence");
  if (!existsSync(evidenceDir)) return [];
  const years = (await readdir(evidenceDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name));
  const records: EvidenceRecord[] = [];
  for (const year of years) {
    const months = (await readdir(path.join(evidenceDir, year.name), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const month of months) {
      const text = await readFile(path.join(evidenceDir, year.name, month.name), "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const value = JSON.parse(line) as Partial<EvidenceRecord>;
          if (
            typeof value.id !== "string" ||
            typeof value.at !== "string" ||
            typeof value.agent !== "string" ||
            typeof value.kind !== "string" ||
            !value.data ||
            typeof value.data !== "object" ||
            Array.isArray(value.data)
          ) continue;
          records.push({
            id: value.id,
            at: value.at,
            agent: value.agent,
            kind: value.kind,
            data: value.data,
            refs: Array.isArray(value.refs)
              ? value.refs.filter((ref): ref is string => typeof ref === "string")
              : [],
          });
        } catch {}
      }
    }
  }
  return records;
}

export function independentSuccessRoots(records: EvidenceRecord[], targetId: string): Set<string> {
  const roots = new Set<string>();
  for (const record of records) {
    const applied = Array.isArray(record.data.appliedRefs)
      ? record.data.appliedRefs.filter((ref): ref is string => typeof ref === "string")
      : [];
    if (!applied.includes(targetId)) continue;
    if (record.data.outcome !== "success" || record.data.evaluator !== "pass") continue;
    const root = typeof record.data.rootSource === "string" && record.data.rootSource.trim()
      ? record.data.rootSource.trim()
      : record.refs.find((ref) => ref !== targetId);
    if (root) roots.add(root);
  }
  return roots;
}

export async function selectEvidence(agentRoot: string, limit = 12): Promise<EvidenceRecord[]> {
  const reviewed = await reviewedIds(agentRoot);
  const agent = path.basename(agentRoot);
  const byRoot = new Map<string, number>();
  for (const record of await evidenceRecords(agentRoot)) {
    const root = typeof record.data.rootSource === "string" ? record.data.rootSource.trim() : "";
    if (root) byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
  }
  const candidates: { record: EvidenceRecord; score: number }[] = [];
  for (const record of await evidenceRecords(agentRoot)) {
    if (record.agent !== agent || reviewed.has(record.id)) continue;
    const isFailure = record.data.outcome === "failure" || record.data.evaluator === "fail";
    const isSuccess = record.data.outcome === "success" && record.data.evaluator === "pass";
    const isCorrection = record.kind === "correction";
    const isReusableEvidence = Array.isArray(record.data.appliedRefs) && record.data.appliedRefs.length > 0;
    const root = typeof record.data.rootSource === "string" ? record.data.rootSource.trim() : "";
    const diversity = root ? Math.min(2, byRoot.get(root) ?? 1) : 0;
    if (isFailure || isCorrection || record.kind === "case" || record.kind === "outcome") {
      const reusableBonus = isReusableEvidence ? 1.5 : 0;
      const transferSignal = isSuccess && isReusableEvidence ? 2 : 0;
      candidates.push({
        record,
        score: (isFailure ? 3 : 0) + (isCorrection ? 2 : 0) + transferSignal + reusableBonus + diversity * 0.3 + 1,
      });
    }
  }
  candidates.sort((a, b) =>
    b.score - a.score ||
    b.record.at.localeCompare(a.record.at) ||
    a.record.id.localeCompare(b.record.id)
  );
  return candidates.slice(0, limit).map((candidate) => candidate.record);
}

export async function selectCases(agentRoot: string, limit = 12): Promise<string[]> {
  return (await selectEvidence(agentRoot, limit)).map((record) => record.id);
}

export function evidenceCue(records: EvidenceRecord[]): string {
  const text = records.flatMap((record) => [
    record.kind,
    ...Object.entries(record.data).flatMap(([key, value]) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [key, String(value)]
        : []
    ),
  ]).join(" ");
  return text.replace(/\s+/g, " ").trim().slice(0, 1000) || "recent learning";
}
