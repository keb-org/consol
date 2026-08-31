import { makeConsolAdapter } from "./adapters/consol";

const chatJson = JSON.parse(await Bun.file(".research/BEAM/chats/1M/1/chat.json").text());
const adapter = makeConsolAdapter("smoke");
const t0 = Date.now();
const { agentRoot, db } = await adapter.ingestChat(chatJson, { vaultRoot: "", tmpDir: "", dataset: "1M", chatId: "1" });
const vaultRoot = (db as any).__vaultRoot || "";
try {
  console.log("ingest ms", Date.now() - t0);
  const n = (db as any).query("SELECT count(*) AS n FROM chunks").get();
  const v = (db as any).query("SELECT count(*) AS n FROM chunk_vectors").get();
  console.log("chunks", JSON.stringify(n), "vectors", JSON.stringify(v));

  const t1 = Date.now();
  const pkt = await adapter.recall("What versions of the frontend framework, backend runtime, and database did I say I was starting the project with?", { db, vaultRoot, agentRoot });
  console.log("recall ms", Date.now() - t1, "items", pkt.items.length, "vecStatus", JSON.stringify(pkt.attribution?.vector));
  console.log("top3:", pkt.items.slice(0,3).map((i:any)=>i.summary.slice(0,120)));

  if (pkt.items[0]) {
    const page = await adapter.readRef?.(pkt.items[0].ref, undefined, { db, vaultRoot, agentRoot }, 1500);
    console.log("read ok, chars:", page?.text.length, "preview:", page?.text.slice(0, 200));
  }
} finally {
  await adapter.close?.({ db, vaultRoot, agentRoot });
}
