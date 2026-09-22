import { containsSecret } from "./resources.js";
import { buildGraph, graphStatus, queryGraph, workspaceMemoryPaths } from "./graphify.js";

const MAX_QUERY_CHARS = 4_096;
const MAX_SAVE_CHARS = 16_384;

// Keep root properties explicit: provider serializers do not preserve root-only unions.
// executeMemory enforces the exact action variants at the runtime boundary.
export const MEMORY_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["status", "build", "query", "search", "save"] },
    query: { type: "string", minLength: 1, maxLength: MAX_QUERY_CHARS, description: "Required only for query or search; omit for other actions." },
    content: { type: "string", minLength: 1, maxLength: MAX_SAVE_CHARS, description: "Required only for save; omit for other actions. Secret-free durable fact." },
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
  if (!validObject(args) || typeof args.action !== "string") {
    return invalidArguments(paths, "Memory arguments require one supported action.");
  }
  switch (args.action) {
    case "status":
      if (Object.keys(args).length !== 1) return invalidArguments(paths, "status accepts no additional arguments.");
      return memoryStatus({ cwd, agentDir, memory, paths });
    case "build":
      if (Object.keys(args).length !== 1) return invalidArguments(paths, "build accepts no additional arguments.");
      return buildGraph({ cwd, agentDir, signal });
    case "query": {
      if (Object.keys(args).length !== 2) return invalidArguments(paths, "query accepts only action and query.");
      const error = validateText(args.query, "query", MAX_QUERY_CHARS);
      return error ? invalidArguments(paths, error) : queryGraph({ cwd, agentDir, query: args.query, signal });
    }
    case "search": {
      if (Object.keys(args).length !== 2) return invalidArguments(paths, "search accepts only action and query.");
      const error = validateText(args.query, "query", MAX_QUERY_CHARS);
      return error ? invalidArguments(paths, error) : nativeSearch(memory, args.query, paths);
    }
    case "save": {
      if (Object.keys(args).length !== 2) return invalidArguments(paths, "save accepts only action and content.");
      const error = validateText(args.content, "content", MAX_SAVE_CHARS);
      return error ? invalidArguments(paths, error) : nativeSave(memory, args.content, paths);
    }
    default:
      return invalidArguments(paths, `Unsupported memory action: ${args.action}.`);
  }
}

export { graphStatus };
