// Adapter contract — adapters may ONLY export recall()/readRef().
// They never see questions' rubric/ideal_response, never call LLM, never score.

export type AdapterPacket = {
  // opaque packet from recall — harness decides how to render it to context
  items: { ref: string; summary: string; section?: string }[];
  attribution?: any;
  raw?: any;
};

export type AdapterRead = {
  text: string;
  docId: string;
  section?: string;
  done: boolean;
  cursor?: string;
} | null;

export type BeamAdapter = {
  name: string; // e.g. "consol-main"
  // Called once per chat to (re)build the vault/index for that chat.
  // The adapter receives ONLY raw chat turns (no probing questions).
  ingestChat: (chatJson: any, ctx: { vaultRoot: string; tmpDir: string; dataset: "1M" | "10M"; chatId: string; sourceHash?: string }) => Promise<{ agentRoot: string; db: any }>;
  // Called per probing question. Must not touch the question's rubric/ideal_response — question string only.
  // Return compact packet; harness renders it.
  recall: (question: string, ctx: { db: any; vaultRoot: string; agentRoot: string }) => Promise<AdapterPacket>;
  // Optional L2 read — the multi-tool agent loop calls this on refs returned by recall.
  // Byte-bounded page (same primitive as the product's `read` tool). Null if ref is stale/invalid.
  readRef?: (ref: string, cursor: string | undefined, ctx: { db: any; vaultRoot: string; agentRoot: string }, maxBytes: number) => Promise<AdapterRead>;
  // Optional cleanup per chat
  close?: (ctx: { db: any; vaultRoot: string; agentRoot: string }) => Promise<void> | void;
};

export type QuestionRecord = {
  question: string;
  rubric: string[];
  category: string;
  ideal_response?: string;
};

export type ChatBundle = {
  dataset: "1M" | "10M";
  chatId: string;
  chatJson: any;
  questions: QuestionRecord[]; // flattened across categories
};
