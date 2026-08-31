import { Database } from "bun:sqlite";
import type { Budgets } from "@/core/config";
import type { NumericLedgerSearchRow } from "@/storage/index/search";

export type RecallMode = "auto" | "facts" | "guidance" | "history";

export type PacketItem = {
  docId: string;
  kind: string;
  summary: string;
  section?: string;
  scope?: string;
  source_refs?: string;
  status?: string;
  owner: string;
  rrf: number;
  source: "exact" | "fused" | "ledger" | "link";
};

export type Packet = {
  id: string;
  mode: RecallMode;
  targetCandidates: 10 | 20 | 30;
  items: PacketItem[];
  attribution: {
    lexCapped: number;
    vecCapped: number;
    ledgerCapped: number;
    fused: number;
    linked: number;
    returned: number;
    packetBytes: number;
    packetTokensEstimate: number;
    vector: { available: boolean; indexed: number; reason?: string };
    filters: { owner: string | null; statuses: string[]; kinds: string[] | null };
  };
};

export type RetrievalUsageItem = Pick<PacketItem, "docId" | "kind" | "owner" | "source">;

export type ChunkRow = {
  chunk_id: number;
  doc_id: string;
  text: string;
  section: string;
  kind: string;
  scope: string;
  source_refs: string;
  status: string;
  hash: string;
  owner: string;
  updated: string;
};

export type Scored = ChunkRow & {
  rrf: number;
  rankLex?: number;
  rankVec?: number;
  rankLedger?: number;
  ledger?: NumericLedgerSearchRow;
  source: PacketItem["source"];
};

export function summaryOf(text: string, section = ""): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line) && line !== "---" && !/^[\w-]+:\s/.test(line));
  const excerpt = lines.find((line) => line.length >= 24) ?? lines[0] ?? text.trim();
  const clean = excerpt.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").slice(0, 220);
  const heading = section.replace(/#\d+$/, "").trim();
  return heading && !clean.toLowerCase().startsWith(heading.toLowerCase()) ? `${heading}: ${clean}`.slice(0, 240) : clean;
}

export function formatPacketText(items: PacketItem[]): string {
  return items.map((item) => `[${item.docId}] ${item.kind}\n${item.summary}`).join("\n");
}

export function toItem(row: Scored): PacketItem {
  return {
    docId: row.doc_id,
    kind: row.kind,
    summary: row.ledger
      ? `${row.ledger.value}${row.ledger.occurred_at ? ` (${row.ledger.occurred_at})` : ""}: ${row.ledger.statement}`.slice(0, 240)
      : summaryOf(row.text, row.section),
    ...(row.section ? { section: row.section } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.source_refs ? { source_refs: row.source_refs } : {}),
    ...((row.status && row.status !== "active") ? { status: row.status } : {}),
    owner: row.owner,
    rrf: Math.round(row.rrf * 1000) / 1000,
    source: row.source,
  } as PacketItem;
}

export type PacketDraft = Omit<Packet, "attribution"> & {
  attribution: Omit<Packet["attribution"], "returned" | "packetBytes" | "packetTokensEstimate">;
};

export function fitPacket(draft: PacketDraft, _budgets: Budgets): Packet {
  const text = formatPacketText(draft.items);
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    ...draft,
    attribution: {
      ...draft.attribution,
      returned: draft.items.length,
      packetBytes: bytes,
      packetTokensEstimate: Math.ceil(bytes / 4),
    },
  };
}

export function sliceUtf8(text: string, start: number, maxBytes: number) {
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.length, start + maxBytes);
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  const chunk = bytes.subarray(start, end).toString("utf8");
  return { text: chunk, nextOffset: end, totalBytes: bytes.length };
}

export function readChunk(db: Database, docId: string, budgets: Budgets, offset = 0) {
  const rows = db.query("SELECT text, doc_id, section, hash, owner, status FROM chunks WHERE doc_id=? ORDER BY chunk_id").all(docId) as any[];
  if (!rows.length) throw new Error(`unknown id: '${docId}' not found — category: not-found. Fix: recall for valid docId`);
  const fullText = rows.map((r) => r.text).join("\n\n");
  const first = rows[0];
  const page = sliceUtf8(fullText, offset, budgets.l2Bytes);
  if (offset > page.totalBytes) throw new Error(`offset past end: offset ${offset} > totalBytes ${page.totalBytes} — category: out-of-bounds. Fix: use offset <= totalBytes`);
  const done = page.nextOffset >= page.totalBytes;
  return {
    docId: first.doc_id,
    kind: first.kind,
    owner: first.owner,
    status: first.status,
    text: page.text,
    bytes: Buffer.byteLength(page.text, "utf8"),
    offset,
    totalBytes: page.totalBytes,
    done,
    nextOffset: done ? undefined : page.nextOffset,
  };
}
