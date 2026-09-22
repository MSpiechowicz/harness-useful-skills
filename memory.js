import { containsSecret } from "./resources.js";
import { buildGraph, graphStatus, queryGraph, workspaceMemoryPaths } from "./graphify.js";

const MAX_QUERY_CHARS = 4_096;
const MAX_SAVE_CHARS = 16_384;

// Keep root properties explicit: provider serializers do not preserve root-only unions.
// Nullable payloads remain expressible when providers require every schema property.
export const MEMORY_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["status", "build", "query", "search", "save"] },
    query: { type: ["string", "null"], minLength: 1, maxLength: MAX_QUERY_CHARS, description: "Required non-empty text for query/search. For other actions omit or pass null." },
    content: { type: ["string", "null"], minLength: 1, maxLength: MAX_SAVE_CHARS, description: "Required secret-free durable fact for save. For other actions omit or pass null." },
  },
};

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function validObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidArguments(paths, error) {
  return { ok: false, backend: "us_memory", paths, error };
}

function validateText(value, field, maximum) {
  if (typeof value !== "string" || !value.trim()) return `${field} must be a non-empty string.`;
  if (value.length > maximum) return `${field} exceeds ${maximum} characters.`;
  return undefined;
}

async function nativeStatus(memory, paths) {
  if (!memory?.status) {
    return {
      ok: false,
      backend: "native-memory",
      paths,
      error: "Native memory backend is unavailable; local notes are at the reported notes path.",
    };
  }
  try {
    const observation = await memory.status();
    const ok = validObject(observation) && observation.active === true && !observation.error;
    return {
      ok,
      backend: validObject(observation) && typeof observation.backend === "string" ? observation.backend : "native-memory",
      paths,
      observation,
      ...(!ok ? { error: observation?.error || observation?.message || "Native memory backend is inactive or unavailable." } : {}),
    };
  } catch (error) {
    return { ok: false, backend: "native-memory", paths, error: `Native memory status failed: ${errorMessage(error)}` };
  }
}
async function memoryStatus({ cwd, agentDir, memory, paths }) {
  const [native, graph] = await Promise.all([
    nativeStatus(memory, paths),
    graphStatus({ cwd, agentDir }),
  ]);
  return {
    ok: native.ok && graph.ok,
    backend: "us_memory",
    paths,
    native,
    graph,
    ...(native.ok && graph.ok ? {} : {
      error: [native.error, graph.error].filter(Boolean).join(" ") || "Memory status is incomplete.",
    }),
  };
}


async function nativeSearch(memory, query, paths) {
  if (!memory?.search) {
    return {
      ok: false,
      backend: "native-memory",
      paths,
      error: "Native memory backend is unavailable; local notes are at the reported notes path.",
    };
  }
  try {
    const observation = await memory.search(query, { limit: 8 });
    const ok = validObject(observation) && observation.backend !== "off" && Array.isArray(observation.items) && Number.isSafeInteger(observation.count) && observation.count >= 0;
    return {
      ok,
      backend: validObject(observation) && typeof observation.backend === "string" ? observation.backend : "native-memory",
      paths,
      query,
      observation,
      ...(!ok ? { error: observation?.message || "Native memory search is unavailable or returned an invalid result." } : {}),
    };
  } catch (error) {
    return { ok: false, backend: "native-memory", paths, query, error: `Native memory search failed: ${errorMessage(error)}` };
  }
}

async function nativeSave(memory, content, paths) {
  if (containsSecret(content)) {
    return {
      ok: false,
      backend: "native-memory",
      paths,
      error: "Refusing to save secret-shaped content. Resubmit a secret-free durable fact.",
    };
  }
  if (!memory?.save) {
    return {
      ok: false,
      backend: "native-memory",
      paths,
      error: "Native memory backend is unavailable; local notes are at the reported notes path.",
    };
  }
  try {
    const observation = await memory.save({ content });
    const ok = validObject(observation) && observation.backend !== "off" && Number.isSafeInteger(observation.stored) && observation.stored > 0;
    return {
      ok,
      backend: validObject(observation) && typeof observation.backend === "string" ? observation.backend : "native-memory",
      paths,
      observation,
      ...(!ok ? { error: observation?.queued ? "Native memory save is queued, not confirmed persisted." : observation?.message || "Native memory did not confirm storage." } : {}),
    };
  } catch (error) {
    return { ok: false, backend: "native-memory", paths, error: `Native memory save failed: ${errorMessage(error)}` };
  }
}

export async function executeMemory(args, { cwd, agentDir, memory, signal } = {}) {
  let paths;
  try {
    paths = await workspaceMemoryPaths({ cwd, agentDir });
  } catch (error) {
    return { ok: false, backend: "us_memory", paths: undefined, error: errorMessage(error) };
  }
  if (!validObject(args) || !Object.hasOwn(args, "action") || typeof args.action !== "string") {
    return invalidArguments(paths, "Memory arguments require one supported action.");
  }
  const payload = args.action === "query" || args.action === "search" ? "query" : args.action === "save" ? "content" : undefined;
  for (const key of Object.keys(args)) {
    if (key === "action") continue;
    if (key !== "query" && key !== "content") {
      return invalidArguments(paths, "Memory arguments contain an unknown field.");
    }
    if (key !== payload && args[key] != null) {
      return invalidArguments(paths, "Unused memory payload fields must be omitted or null.");
    }
  }
  if (payload) {
    const error = validateText(Object.hasOwn(args, payload) ? args[payload] : undefined, payload, payload === "query" ? MAX_QUERY_CHARS : MAX_SAVE_CHARS);
    if (error) return invalidArguments(paths, error);
  }
  switch (args.action) {
    case "status":
      return memoryStatus({ cwd, agentDir, memory, paths });
    case "build":
      return buildGraph({ cwd, agentDir, signal });
    case "query":
      return queryGraph({ cwd, agentDir, query: args.query, signal });
    case "search":
      return nativeSearch(memory, args.query, paths);
    case "save":
      return nativeSave(memory, args.content, paths);
    default:
      return invalidArguments(paths, `Unsupported memory action: ${args.action}.`);
  }
}

export { graphStatus };
