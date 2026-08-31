import { Database } from "bun:sqlite";
import type { Budgets } from "../core/config";
import type { NumericLedgerSearchRow } from "../storage/index/search";

export type RecallMode = "auto" | "facts" | "guidance" | "history";

export type PacketItem = {
  ref: string;
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
  l1?: { ref: string; overview: string; section: string }[];
  next: string;
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

export type RetrievalUsageItem = Pick<PacketItem, "ref" | "docId" | "kind" | "owner" | "source">;

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

export function encodeRef(chunkId: number, docId: string, hash: string, owner: string, packetId: string): string {
  return Buffer.from(JSON.stringify({ c: chunkId, d: docId, h: hash.slice(0, 8), o: owner, p: packetId })).toString("base64url");
}

export function decodeRef(ref: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid ref: not base64url JSON — category: type error. Fix: pass unchanged ref from recall");
  }
  const r = decoded as Record<string, unknown>;
  if (
    !Number.isSafeInteger(r.c) ||
    typeof r.d !== "string" ||
    typeof r.h !== "string" ||
    typeof r.o !== "string" ||
    (r.p !== undefined && typeof r.p !== "string")
  ) {
    throw new Error("invalid ref: shape mismatch — category: type error. Fix: use verbatim ref from recall");
  }
  return r as { c: number; d: string; h: string; o: string; p?: string };
}

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

export function packetCeilingBytes(budgets: Budgets): number {
  return Math.min(budgets.packetTokens, budgets.packetCeiling) * 4;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function toItem(row: Scored, packetId: string): PacketItem {
  return {
    ref: encodeRef(row.chunk_id, row.doc_id, row.hash, row.owner, packetId),
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

export type PacketDraft = Omit<Packet, "l1" | "attribution"> & {
  attribution: Omit<Packet["attribution"], "returned" | "packetBytes" | "packetTokensEstimate">;
};

function materializePacket(draft: PacketDraft, items: PacketItem[], l1Count: number): Packet {
  const l1 = items.slice(0, l1Count).map((item) => ({
    ref: item.ref,
    overview: item.summary,
    section: item.section ?? "",
  }));
  const packet: Packet = {
    ...draft,
    items,
    l1: l1.length ? l1 : undefined,
    attribution: {
      ...draft.attribution,
      returned: items.length,
      packetBytes: 0,
      packetTokensEstimate: 0,
    },
  };
  for (let i = 0; i < 4; i++) {
    const bytes = serializedBytes(packet);
    packet.attribution.packetBytes = bytes;
    packet.attribution.packetTokensEstimate = Math.ceil(bytes / 4);
  }
  return packet;
}

export function fitPacket(draft: PacketDraft, budgets: Budgets): Packet {
  const ceiling = packetCeilingBytes(budgets);
  let items = draft.items.slice();
  let l1Count = 0; // compact: l1 duplicates items[].summary — drop to save ~15%
  while (true) {
    const packet = materializePacket(draft, items, l1Count);
    if (packet.attribution.packetBytes <= ceiling) return packet;
    if (l1Count > 0) {
      l1Count--;
      continue;
    }
    if (items.length) {
      items = items.slice(0, -1);
      continue;
    }
    throw new Error(`packet metadata exceeds ${ceiling}-byte ceiling — category: out-of-bounds. Fix: raise packetCeiling or lower perArmCap/targetCandidates`);
  }
}

export function sliceUtf8(text: string, start: number, maxBytes: number) {
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.length, start + maxBytes);
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  const chunk = bytes.subarray(start, end).toString("utf8");
  return { text: chunk, nextOffset: end, totalBytes: bytes.length };
}

export function encodeCursor(ref: string, offset: number): string {
  return Buffer.from(JSON.stringify({ r: ref, b: offset })).toString("base64url");
}

export function decodeCursor(cursor: string, ref: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed.r !== ref || !Number.isSafeInteger(parsed.b) || parsed.b < 0) throw new Error("cursor validation failed");
    return parsed.b as number;
  } catch {
    throw new Error("invalid cursor — category: out-of-bounds. Fix: omit cursor or use valid cursor from prior read");
  }
}

export function readChunk(db: Database, ref: string, budgets: Budgets, cursor?: string) {
  const { c, d, h, o } = decodeRef(ref);
  const row = db.query("SELECT text, doc_id, section, hash, owner, status FROM chunks WHERE chunk_id=?").get(c) as any;
  if (!row) throw new Error("unknown ref: chunk not found — category: stale. Fix: recall again for fresh ref");
  if (row.doc_id !== d) throw new Error("ref document mismatch — category: stale. Fix: recall again for fresh ref");
  if (row.owner !== o) throw new Error("ref owner mismatch — category: unauthorized. Fix: attach team or set agent");
  if (!row.hash.startsWith(h)) throw new Error("stale ref: content hash changed — category: stale. Fix: recall again for fresh ref");
  const offset = cursor ? decodeCursor(cursor, ref) : 0;
  const page = sliceUtf8(row.text, offset, budgets.l2Bytes);
  if (offset > page.totalBytes) throw new Error(`cursor past end: offset ${offset} > totalBytes ${page.totalBytes} — category: out-of-bounds. Fix: use offset <= totalBytes or omit cursor`);
  const done = page.nextOffset >= page.totalBytes;
  return {
    docId: row.doc_id,
    section: row.section,
    hash: row.hash,
    owner: row.owner,
    status: row.status,
    text: page.text,
    bytes: Buffer.byteLength(page.text, "utf8"),
    offset,
    totalBytes: page.totalBytes,
    done,
    cursor: done ? undefined : encodeCursor(ref, page.nextOffset),
  };
}
