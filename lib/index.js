// @saadpie/agentry-tool
// Registers a native DSH tool that consults agentry when the harness
// hits a capability wall.
//
// The harness LLM sees `agentry_reason` and `agentry_status` alongside
// its built-in tools. When it hits a wall, it calls them natively —
// no curl, no bash, no markdown instructions.

import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "tool-agentry";
export const inject = ["tools"];

const AGENTRY_URL = process.env.AGENTRY_MCP_URL || "http://127.0.0.1:7863/mcp";

// ---- tiny JSON-RPC MCP client ----
let _rpcId = 1;
async function mcpCall(method, params = {}, timeoutMs = 30000) {
  const id = _rpcId++;
  const body = { jsonrpc: "2.0", id, method, params };
  const res = await fetch(AGENTRY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agentry MCP HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`agentry MCP error: ${data.error.message}`);
  return data.result;
}

async function agentryCallTool(toolName, args, timeoutMs = 30000) {
  const result = await mcpCall("tools/call", { name: toolName, arguments: args }, timeoutMs);
  // MCP tools/call returns { content: [{ type: "text", text: "..." }], isError? }
  const text = Array.isArray(result?.content)
    ? result.content.map(b => b.type === "text" ? b.text : JSON.stringify(b)).join("\n")
    : JSON.stringify(result);
  if (result?.isError) throw new Error(text);
  return text;
}

// ---- plugin apply ----
export function apply(ctx, _config) {
  ctx.tools.register(defineTool({
    name: "agentry_reason",
    description:
      "Consult agentry — a capability broker running locally — when you cannot complete a task " +
      "because you lack a tool, ability, or access. Call this when: a task requires a browser, " +
      "mobile device, or desktop control; a task requires an API or tool you don't have; you have " +
      "tried 2-3 approaches and all failed. Agentry analyzes the failure, records the missing " +
      "capability, and starts growing it in the background. Returns a JSON analysis with fields: " +
      "analysis, missing, immediate_action, suggestions, gap_recorded. " +
      "Do NOT call this for simple questions, retryable errors, or tasks you can complete with " +
      "your existing tools. Tell the user: \"I've asked agentry to source a fix for this.\"",
    parameters: {
      failure: {
        type: "string",
        required: true,
        description: "One-line description of what went wrong (the error, blocker, or limitation).",
      },
      intent: {
        type: "string",
        required: false,
        description: "What the user originally asked for, in their words.",
      },
      attempted: {
        type: "array",
        required: false,
        description: "Short strings describing strategies you already tried.",
        items: { type: "string" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          analysis: { type: "string" },
          immediate_action: { type: "string" },
          gap_recorded: { type: "string" },
        },
      },
    },
  }, async (args) => {
    const text = await agentryCallTool("reason", args, 30000);
    // The agentry MCP server returns structured JSON as the text block.
    try {
      return JSON.parse(text);
    } catch {
      return { analysis: text, immediate_action: null, gap_recorded: null };
    }
  }));

  ctx.tools.register(defineTool({
    name: "agentry_status",
    description:
      "Return agentry's current state: number of capabilities, recent gaps it's tracking, " +
      "active watches. Cheap. Use this when you want to know what agentry can help with right now.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
    },
  }, async () => {
    const text = await agentryCallTool("status", {}, 10000);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }));
}
