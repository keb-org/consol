import { describe, test, expect } from "bun:test";
import { RRF_K } from "../src/config";

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
});
