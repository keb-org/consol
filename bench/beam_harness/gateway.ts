// Gateway — owns every benchmark LLM call (memory agent + judge).
// Uses non-streaming OpenAI-compatible /v1/chat/completions.

export type GatewayConfig = {
  baseUrl: string;
  apiKey: string;
  answerModel: string;
  judgeModel: string;
};

export type TokenUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatResult = {
  content: string;
  message: ChatMessage;
  finishReason?: string;
  usage?: TokenUsage;
  raw?: any;
};

export function resolveGatewayConfig(): GatewayConfig {
  const baseUrl = process.env.BEAM_GATEWAY_URL || "https://agent.auranion.com/v1";
  const apiKey = process.env.BEAM_GATEWAY_KEY || process.env.AURANION_API_KEY || "";
  if (!apiKey) throw new Error("missing gateway key: set BEAM_GATEWAY_KEY or AURANION_API_KEY");
  const answerModel = process.env.BEAM_ANSWER_MODEL || "claude-haiku-4-6";
  const judgeModel = process.env.BEAM_JUDGE_MODEL || answerModel;
  return { baseUrl, apiKey, answerModel, judgeModel };
}

let gatewayLimit = 10;
let gatewayActive = 0;
const gatewayWaiters: (() => void)[] = [];

export function configureGatewayConcurrency(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error(`invalid gateway concurrency: ${limit}`);
  gatewayLimit = limit;
}

async function acquireGatewaySlot() {
  if (gatewayActive < gatewayLimit) {
    gatewayActive++;
    return;
  }
  await new Promise<void>((resolve) => gatewayWaiters.push(resolve));
}

function releaseGatewaySlot() {
  const next = gatewayWaiters.shift();
  if (next) next();
  else gatewayActive--;
}

async function withGatewaySlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireGatewaySlot();
  try { return await fn(); }
  finally { releaseGatewaySlot(); }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryable(msg: string) {
  return /HTTP 5\d\d|HTTP 429|timeout|524|ECONNRESET|ETIMEDOUT|rate.?limit|overloaded|temporarily/i.test(msg);
}

async function postChatOnce(
  cfg: GatewayConfig,
  model: string,
  body: Record<string, unknown>,
): Promise<ChatResult> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model, stream: false, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`gateway ${model} HTTP ${res.status}: ${text.slice(0, 800)}`);
  let json: any;
  try { json = JSON.parse(text); }
  catch { throw new Error(`gateway ${model} non-JSON: ${text.slice(0, 800)}`); }
  const choice = json?.choices?.[0];
  const rawMessage = choice?.message ?? {};
  const message: ChatMessage = {
    role: "assistant",
    content: rawMessage.content == null ? null : String(rawMessage.content),
    ...(Array.isArray(rawMessage.tool_calls) ? { tool_calls: rawMessage.tool_calls as ToolCall[] } : {}),
  };
  return {
    content: message.content ?? "",
    message,
    finishReason: choice?.finish_reason,
    usage: json?.usage as TokenUsage | undefined,
    raw: json,
  };
}

export async function chatCompletion(
  cfg: GatewayConfig,
  model: string,
  messages: ChatMessage[],
  opts: {
    maxTokens: number;
    temperature?: number;
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "none" | "required" | Record<string, unknown>;
    retries?: number;
    label?: string;
  },
): Promise<ChatResult> {
  const retries = opts.retries ?? 3;
  const body: Record<string, unknown> = {
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature ?? 0,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withGatewaySlot(() => postChatOnce(cfg, model, body));
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      if (!retryable(msg) || attempt === retries) throw error;
      const backoff = 1000 * 2 ** attempt + Math.random() * 400;
      console.warn(`[gateway] retry ${attempt + 1}/${retries} ${opts.label ?? model}: ${msg.slice(0, 180)} — backoff ${Math.round(backoff)}ms`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

export async function generateAnswer(cfg: GatewayConfig, prompt: string): Promise<ChatResult> {
  return chatCompletion(cfg, cfg.answerModel, [{ role: "user", content: prompt }], {
    maxTokens: 700,
    temperature: 0,
    label: "answer",
  });
}

export async function judgeOnce(
  cfg: GatewayConfig,
  prompt: string,
  retries = 2,
): Promise<{ score: number; reason: string; raw: string; usage?: TokenUsage }> {
  const res = await chatCompletion(cfg, cfg.judgeModel, [{ role: "user", content: prompt }], {
    maxTokens: 800,
    temperature: 0,
    retries,
    label: "judge",
  });
  const raw = res.content.trim();
  return { ...parseJudgeJson(raw), raw, usage: res.usage };
}

function parseJudgeJson(raw: string): { score: number; reason: string } {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    const json = JSON.parse(stripped);
    const score = Number(json.score);
    if (score === 0 || score === 0.5 || score === 1) return { score, reason: String(json.reason ?? "") };
  } catch {}
  const match = stripped.match(/"score"\s*:\s*(1(?:\.0)?|0\.5|0(?:\.0)?)/);
  if (match) return { score: Number(match[1]), reason: stripped.slice(0, 400) };
  throw new Error(`unparseable judge JSON: ${raw.slice(0, 800)}`);
}
