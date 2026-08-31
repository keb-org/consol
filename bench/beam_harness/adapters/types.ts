// Adapter contract — adapters may ONLY export recall()/readRef().
// They never see questions' rubric/ideal_response, never call LLM, never score.

export type AdapterPacket = {
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
  name: string;
  ingestChat: (chatJson: any, ctx: { vaultRoot: string; tmpDir: string; dataset: "1M" | "10M"; chatId: string; sourceHash?: string }) => Promise<{ agentRoot: string; db: any }>;
  recall: (question: string, ctx: { db: any; vaultRoot: string; agentRoot: string }) => Promise<AdapterPacket>;
  readRef?: (ref: string, cursor: string | undefined, ctx: { db: any; vaultRoot: string; agentRoot: string }, maxBytes: number) => Promise<AdapterRead>;
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
