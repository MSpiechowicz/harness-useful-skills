/**
 * The explicit `/useful-skills graph test` diagnostic shared by the OMP and OpenCode adapters: build this
 * workspace's Graphify graph, then run one query against the generation that build produced.
 */
export const GRAPH_TEST_QUERY = "main";

const DISPLAY_TRUNCATED = "\n[display truncated]";

/** Text cut to at most `limit` UTF-8 bytes, marked when cut; a split multi-byte sequence decodes as U+FFFD. */
export function boundedDisplay(text, limit) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) {
    return text;
  }

  return `${bytes.subarray(0, limit - Buffer.byteLength(DISPLAY_TRUNCATED)).toString("utf8")}${DISPLAY_TRUNCATED}`;
}

function failureMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Why a query result cannot be reported for the build of `generation`, or undefined when it can. */
function queryFailure(result, generation) {
  if (!result.ok) {
    return result.error || "No query result was returned.";
  }

  if (result.active?.generation !== generation) {
    return `active generation changed from ${generation} to ${result.active?.generation ?? "unknown"}; results cannot be attributed to this build.`;
  }

  if (typeof result.output !== "string") {
    return "no text output was returned.";
  }

  return undefined;
}

function queryReport(result) {
  const truncated = result.outputTruncated ? " (Graphify output truncated)" : "";
  const output = result.output.trim();
  if (!output) {
    return `Graphify query "${GRAPH_TEST_QUERY}" returned no output${truncated}; no relationships are claimed.`;
  }

  if (/^No matching nodes found\.?$/i.test(output)) {
    return `Graphify query "${GRAPH_TEST_QUERY}" returned no matches${truncated}:\n${result.output}`;
  }

  return `Graphify query "${GRAPH_TEST_QUERY}" output${truncated}:\n${result.output}`;
}

/**
 * Run the graph test, calling `report(message, level)` for each step as it happens (level "error" for the
 * failing step, otherwise omitted). `memoryAction(args, options)` is memory.js executeMemory or a test double;
 * `storage` completes "writes graph storage under …" in the opening notice. Resolves to true only when the
 * query output is reported; never rejects for a build or query failure.
 */
export async function runGraphTest({ memoryAction, options, storage, report }) {
  report(`Building this workspace's Graphify graph, then running a diagnostic query. This explicit command may set up pinned dependencies and writes graph storage under ${storage} outside the checkout.`);

  let build;
  try {
    build = await memoryAction({ action: "build" }, options);
    if (!build.ok) {
      report(`Graphify build failed: ${build.error || "No build result was returned."}`, "error");
      return false;
    }

    const { generation, graph } = build.active;
    const { nodes, edges, sources } = build.snapshot;
    report(`Graphify built generation ${generation}: ${nodes} nodes, ${edges} edges, ${sources} source files.\nGraph storage: ${graph}`);
  } catch (error) {
    report(`Graphify build failed: ${failureMessage(error)}`, "error");
    return false;
  }

  try {
    const result = await memoryAction({ action: "query", query: GRAPH_TEST_QUERY }, options);
    const failure = queryFailure(result, build.active.generation);
    if (failure) {
      report(`Graphify query failed: ${failure}`, "error");
      return false;
    }

    report(queryReport(result));
    return true;
  } catch (error) {
    report(`Graphify query failed: ${failureMessage(error)}`, "error");
    return false;
  }
}
