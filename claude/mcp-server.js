import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { executeMemory } from "../memory.js";
import { createLocalFacts } from "./local-facts.js";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_MESSAGE_BYTES = 128 * 1024;
const EMPTY = { type: "object", properties: {}, additionalProperties: false };
const QUERY = { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["query"], additionalProperties: false };
const CONTENT = { type: "object", properties: { content: { type: "string", minLength: 1, maxLength: 16384 } }, required: ["content"], additionalProperties: false };

const tools = [
  { name: "memory_status", description: "Inspect local Claude facts and the project graph without creating storage or installing dependencies.", inputSchema: EMPTY, annotations: { readOnlyHint: true } },
  { name: "memory_search", description: "Search saved project facts using bounded literal text matching.", inputSchema: QUERY, annotations: { readOnlyHint: true } },
  { name: "memory_save", description: "Persist a secret-free durable fact privately for this project.", inputSchema: CONTENT },
  { name: "graph_build", description: "Explicitly build this project's Graphify graph; may install pinned dependencies and scan workspace files.", inputSchema: EMPTY },
  { name: "graph_query", description: "Query the existing project graph; may load the pinned Graphify runtime.", inputSchema: QUERY },
];
const actions = new Map([
  ["memory_status", "status"], ["memory_search", "search"], ["memory_save", "save"],
  ["graph_build", "build"], ["graph_query", "query"],
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emit(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function failure(id, code, message) {
  emit({ id, error: { code, message } });
}

async function resolveHostContext() {
  const workspace = process.env.CLAUDE_PROJECT_DIR;
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (!workspace || !data || !path.isAbsolute(workspace) || !path.isAbsolute(data)) {
    throw new Error("Claude project root and persistent plugin data root are required.");
  }

  const [cwd, resolvedData] = await Promise.all([realpath(workspace), realpath(data)]);
  if (path.resolve(data) !== resolvedData) {
    throw new Error("Claude plugin data root must not contain symbolic links.");
  }
  const [workspaceEntry, dataEntry] = await Promise.all([lstat(cwd), lstat(resolvedData)]);
  if (!workspaceEntry.isDirectory() || !dataEntry.isDirectory()) {
    throw new Error("Claude project and plugin data roots must be directories.");
  }

  return { cwd, agentDir: resolvedData, memory: createLocalFacts({ cwd, agentDir: resolvedData }) };
}

const active = new Map();
let initialized = false;
let ready = false;
let context;
let parts = [];
let messageBytes = 0;
let discarding = false;

function requestKey(id) {
  return `${typeof id}:${id}`;
}

async function handle(message) {
  if (!record(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    failure(record(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null, -32600, "Invalid JSON-RPC request.");
    return;
  }

  const hasId = Object.hasOwn(message, "id");
  const id = message.id;
  if (hasId && (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id)))) {
    failure(null, -32600, "Invalid request identifier.");
    return;
  }

  if (!hasId) {
    if (message.method === "notifications/initialized" && initialized) ready = true;
    if (message.method === "notifications/cancelled" && record(message.params)) {
      const key = requestKey(message.params.requestId);
      active.get(key)?.abort();
    }
    return;
  }

  const key = requestKey(id);
  if (active.has(key)) {
    failure(id, -32600, "Duplicate active request identifier.");
    return;
  }

  if (message.method === "initialize") {
    if (initialized || !record(message.params) || typeof message.params.protocolVersion !== "string") {
      failure(id, -32602, "Invalid initialize request.");
      return;
    }
    initialized = true;
    emit({ id, result: {
      protocolVersion: message.params.protocolVersion === "2024-11-05" ? "2024-11-05" : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "useful-skills", version: "1.0.0" },
    } });
    return;
  }

  if (!ready) {
    failure(id, -32002, "Server initialization is incomplete.");
    return;
  }

  if (message.method === "ping") {
    emit({ id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    emit({ id, result: { tools } });
    return;
  }
  if (message.method !== "tools/call") {
    failure(id, -32601, "Method not found.");
    return;
  }

  const params = message.params;
  if (!record(params) || !actions.has(params.name) || (params.arguments !== undefined && !record(params.arguments)) || Object.hasOwn(params.arguments ?? {}, "action")) {
    failure(id, -32602, "Unknown tool or invalid tool parameters.");
    return;
  }

  const controller = new AbortController();
  active.set(key, controller);
  try {
    if (!context) context = await resolveHostContext();
    const args = { ...(params.arguments ?? {}), action: actions.get(params.name) };
    const result = controller.signal.aborted
      ? { ok: false, error: "Request cancelled." }
      : await executeMemory(args, { ...context, signal: controller.signal });
    emit({ id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: !result.ok } });
  } catch {
    // Never include exception text or tool input in protocol diagnostics or stderr.
    emit({ id, result: { content: [{ type: "text", text: "Memory operation failed; check host roots and private storage permissions." }], isError: true } });
  } finally {
    active.delete(key);
  }
}

function accept(line) {
  let message;
  try {
    message = JSON.parse(line.toString("utf8"));
  } catch {
    failure(null, -32700, "Malformed JSON.");
    return;
  }
  void handle(message).catch(() => failure(null, -32603, "Internal server error."));
}

process.stdin.on("data", chunk => {
  let cursor = 0;
  while (cursor < chunk.length) {
    const newline = chunk.indexOf(10, cursor);
    const end = newline < 0 ? chunk.length : newline;
    if (!discarding) {
      const segment = chunk.subarray(cursor, end);
      if (messageBytes + segment.length > MAX_MESSAGE_BYTES) {
        parts = [];
        messageBytes = 0;
        discarding = true;
      } else if (segment.length) {
        parts.push(segment);
        messageBytes += segment.length;
      }
    }
    if (newline < 0) break;
    if (discarding) failure(null, -32600, "Request exceeds message size limit.");
    else accept(Buffer.concat(parts, messageBytes));
    parts = [];
    messageBytes = 0;
    discarding = false;
    cursor = newline + 1;
  }
});

process.stdin.on("end", () => {
  for (const controller of active.values()) controller.abort();
});
process.stdout.on("error", () => { process.exitCode = 1; });
