import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { RRF_K } from "../src/config";
import { ensureSchema, numericLedgerSearch } from "../src/index";

function rrf(rank: number) { return 1 / (RRF_K + rank); }

describe("retrieval", () => {
  test("RRF orders by fused rank", () => {
    const lex = [0, 1];
    const vec = [1, 0];
    const scores = new Map<number, number>();
    for (const [i, id] of lex.entries()) scores.set(id, (scores.get(id) ?? 0) + rrf(i));
    for (const [i, id] of vec.entries()) scores.set(id, (scores.get(id) ?? 0) + rrf(i));
    const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(ordered.length).toBe(2);
  });
  test("per-arm cap prevents crowding", () => {
    const cap = 2;
    const lex = [0, 1, 2, 3, 4].slice(0, cap);
    const vec = [5, 6, 7, 8, 9].slice(0, cap);
    expect(lex.length).toBe(cap);
    expect(vec.length).toBe(cap);
  });

  test("numeric coverage does not match digits inside other values", () => {
    const db = new Database(":memory:");
    ensureSchema(db);
    const insert = db.query("INSERT INTO numeric_ledger(chunk_id,value,value_kind,statement,occurred_at,position) VALUES(?,?,?,?,?,?)");
    const fts = db.query("INSERT INTO numeric_ledger_fts(rowid,value,statement) VALUES(?,?,?)");
    const add = (chunkId: number, value: string, statement: string, date: string) => {
      const row = insert.run(chunkId, value, "date", statement, date, 0) as any;
      fts.run(Number(row.lastInsertRowid), value, statement);
    };
    add(1, "February 15, 2024", "Sprint 1 deadline changed to February 15, 2024.", "2024-01-01");
    add(2, "September 10, 2024", "Sprint 7 deadline changed to September 10, 2024.", "2024-08-15");

    expect(numericLedgerSearch(db, "Sprint 1 deadline", 2).map((row) => row.chunk_id)).toEqual([1, 2]);
    db.close();
  });
});
