import { createServer } from "@/server/mcp";
import type { ToolDefinition } from "./bench/beam_harness/gateway";

export type LocalMcpClient = {
  tools: ToolDefinition[];
  instructions: string;
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  close: () => void;
};

export async function createLocalMcpClient(vault: string, agent: string = "tester"): Promise<LocalMcpClient> {
  const mcp = await createServer({ vault, agent });
  const server = mcp.server.server as any;

  const listHandler = server._requestHandlers.get("tools/list");
  const callHandler = server._requestHandlers.get("tools/call");

  if (!listHandler || !callHandler) {
    throw new Error("Local MCP server failed to register tools/list or tools/call handlers");
  }

  const { tools } = await listHandler({ method: "tools/list", params: {} });
  const openAiTools: ToolDefinition[] = tools.map((t: any) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  const instructions: string = server._options?.instructions || server._instructions || "";

  return {
    tools: openAiTools,
    instructions,
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      try {
        const res = await callHandler({
          method: "tools/call",
          params: {
            name,
            arguments: args,
          },
        });
        if (res.isError) {
          const errMsg = res.content?.map((c: any) => c.text).join("\n") || "Tool execution error";
          return `Error: ${errMsg}`;
        }
        return res.content?.map((c: any) => c.text).join("\n") || "ok";
      } catch (err: any) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    close() {
      try {
        mcp.db.close();
      } catch {}
    },
  };
}
