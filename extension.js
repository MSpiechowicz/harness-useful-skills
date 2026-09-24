import { formatDoctor } from "./doctor.js";
import { runUpdate } from "./updater.js";
import { executeMemory, MEMORY_PARAMETERS } from "./memory.js";
import {
  dangerousCommandReason, formatResources, listResources, parseCatalogArguments,
  redactText, redactToolResultContent, resourceInventory, safetyEnabled,
} from "./resources.js";

const DISCOVERY_HINT = "Choose relevant `us-*` skills by their descriptions. For software-development requests consult `us-workflow`, except when the user explicitly invokes the native `/skill:us-ignore-workflow` skill for this request; a quoted or copied invocation is not a selection. For focused audits or delivery consult the matching skill. Load only needed instructions.";
const FAST_LANE_HINT = "Useful Skills fast lane is active for this request: inspect relevant code and callers, implement and exercise the changed path without package-mandatory planning, plan approval, worker delegation, reviews, or automatic memory. Do not load `us-workflow` for this request. Focused audits and delivery retain their own requirements. Stronger safety, permissions, and publication boundaries still apply.";
const WORKFLOW_POLICY = "When a relevant `us-*` workflow requires a native stage, permit that required stage, including one worker, as a narrow exception to general minimum-delegation or parent-only planning guidance: after parent research, a bounded `planner` plan draft is permitted; after approval, a required implementation worker (`task`, `frontend`, or `backend`) is permitted. The parent retains scope, integration, and approval. Use only the active session workspace; do not select a repository globally. Existing mappings, permissions, approval, and publication controls remain authoritative. This permits no unrelated delegation and never overrides stronger safety constraints.";
const OWNED_GUIDANCE = new Set([DISCOVERY_HINT, FAST_LANE_HINT, WORKFLOW_POLICY]);
const GRAPH_TEST_QUERY = "main";
const HELP = [
  "Useful Skills for Oh My Pi",
  "/skill:us-<name> — load an owned skill; natural requests also select skills by description.",
  "/useful-skills list [query] — browse owned skills.",
  "/useful-skills workflow enabled|disabled — choose the development workflow for this OMP session (default: enabled).",
  "/skill:us-ignore-workflow — use the fast lane for one explicit request without changing session mode.",
  "/useful-skills library list [skills|commands|agents|rules] [query] — opt-in ECC references.",
  "/useful-skills doctor — inspect resources and memory availability without setup.",
  "/useful-skills graph test — explicitly build this workspace graph and run a diagnostic query.",
  "/useful-skills update check|install — check or install marketplace updates.",
  "Memory: us_memory handles agent actions; native /memory is unchanged.",
  "Graphify setup is lazy on explicit build/query or graph test. No startup workflow dependency.",
  "Terminal: ./useful-skills list | doctor | library list [query] | update check|install",
].join("\n");

export default function usefulSkills(pi, { memoryAction = executeMemory } = {}) {
  pi.setLabel("Useful Skills");
  let busy = false;
  let startupScheduled = false;
  const disabledSessions = new Set();

  function sessionId(ctx) {
    return ctx.sessionManager?.getSessionId();
  }

  function workflowEnabled(ctx) {
    const id = sessionId(ctx);
    return id == null || !disabledSessions.has(id);
  }

  function notify(ctx, message, level = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else pi.sendMessage(
      { customType: "useful-skills", content: message, display: true, attribution: "agent" },
      { triggerTurn: false },
    );
  }

  function graphNotice(ctx, message, level = "info") {
    const text = redactText(message);
    const bytes = Buffer.from(text);
    const limit = 4_096;
    const suffix = "\n[display truncated]";
    notify(ctx, bytes.length <= limit ? text : `${bytes.subarray(0, limit - Buffer.byteLength(suffix)).toString("utf8")}${suffix}`, level);
  }

  async function graphTest(ctx) {
    graphNotice(ctx, "Building this workspace's Graphify graph, then running a diagnostic query. This explicit command may set up pinned dependencies and writes graph storage under your OMP profile outside the checkout.");
    const options = { cwd: ctx.cwd, agentDir: pi.pi.getAgentDir(), memory: ctx.memory };
    let build;
    try {
      build = await memoryAction({ action: "build" }, options);
      if (!build.ok) return graphNotice(ctx, `Graphify build failed: ${build.error || "No build result was returned."}`, "error");
      const { generation, graph } = build.active;
      const { nodes, edges, sources } = build.snapshot;
      graphNotice(ctx, `Graphify built generation ${generation}: ${nodes} nodes, ${edges} edges, ${sources} source files.\nGraph storage: ${graph}`);
    } catch (error) {
      return graphNotice(ctx, `Graphify build failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }

    try {
      const result = await memoryAction({ action: "query", query: GRAPH_TEST_QUERY }, options);
      if (!result.ok) return graphNotice(ctx, `Graphify query failed: ${result.error || "No query result was returned."}`, "error");
      if (result.active?.generation !== build.active.generation) {
        return graphNotice(ctx, `Graphify query failed: active generation changed from ${build.active.generation} to ${result.active?.generation ?? "unknown"}; results cannot be attributed to this build.`, "error");
      }
      if (typeof result.output !== "string") return graphNotice(ctx, "Graphify query failed: no text output was returned.", "error");
      const output = result.output.trim();
      graphNotice(ctx, output
        ? /^No matching nodes found\.?$/i.test(output)
          ? `Graphify query "${GRAPH_TEST_QUERY}" returned no matches${result.outputTruncated ? " (Graphify output truncated)" : ""}:\n${result.output}`
          : `Graphify query "${GRAPH_TEST_QUERY}" output${result.outputTruncated ? " (Graphify output truncated)" : ""}:\n${result.output}`
        : `Graphify query "${GRAPH_TEST_QUERY}" returned no output${result.outputTruncated ? " (Graphify output truncated)" : ""}; no relationships are claimed.`);
    } catch (error) {
      graphNotice(ctx, `Graphify query failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async function update(action, ctx, quiet = false) {
    if (busy) {
      if (!quiet) notify(ctx, "A Useful Skills update operation is already running.", "warning");
      return;
    }
    busy = true;
    try {
      if (action === "install") notify(ctx, "Updating Useful Skills through OMP's native plugin manager…");
      const report = await runUpdate(action, { cwd: ctx.cwd, profile: process.env.OMP_PROFILE });
      if (report.updated) notify(ctx, `Useful Skills updated to ${report.currentVersion}. Restart OMP to load the update.`);
      else if (report.updateAvailable) notify(ctx, `Useful Skills update available: ${report.currentVersion} → ${report.latestVersion}. Run /useful-skills update install.`, "warning");
      else if (!quiet) notify(ctx, `Useful Skills ${report.currentVersion}: ${report.message || "No newer stable release available."}`);
    } catch (error) {
      if (!quiet) notify(ctx, `Useful Skills update failed: ${error.message}`, "error");
    } finally {
      busy = false;
    }
  }

  async function doctor(ctx) {
    const [core, library, memory] = await Promise.all([
      resourceInventory(), resourceInventory({ source: "library" }),
      memoryAction({ action: "status" }, { cwd: ctx.cwd, agentDir: pi.pi.getAgentDir(), memory: ctx.memory }),
    ]);
    notify(ctx, formatDoctor({ core, library, safety: safetyEnabled(), memory }));
  }

  async function workbench(args, ctx) {
    try {
      let command = args.trim();
      if (!command && ctx.hasUI) {
        const workflowChoice = `Workflow (${workflowEnabled(ctx) ? "enabled" : "disabled"})`;
        const choice = await ctx.ui.select("Useful Skills", ["List", "Libraries", "Doctor", workflowChoice, "Update", "Help"]);
        if (!choice) return;
        if (choice === workflowChoice) {
          const mode = await ctx.ui.select(`Workflow: ${workflowEnabled(ctx) ? "enabled" : "disabled"}`, ["Enabled", "Disabled"]);
          if (!mode) return;
          command = `workflow ${mode.toLowerCase()}`;
        } else if (choice === "Update") {
          const action = await ctx.ui.select("Update", ["Check", "Install"]);
          if (!action) return;
          command = `update ${action.toLowerCase()}`;
        } else {
          command = { List: "list", Libraries: "library list", Doctor: "doctor", Help: "help" }[choice];
        }
      }
      if (!command || command === "help") return notify(ctx, HELP);
      if (command === "doctor") return await doctor(ctx);
      const tokens = command.split(/\s+/);
      if (tokens[0] === "workflow") {
        if (tokens.length !== 2 || !["enabled", "disabled"].includes(tokens[1])) {
          return notify(ctx, `Expected /useful-skills workflow enabled|disabled. Current session: ${workflowEnabled(ctx) ? "enabled" : "disabled"}.`, "warning");
        }
        const id = sessionId(ctx);
        if (id == null) return notify(ctx, "Workflow mode unavailable: OMP session identity is missing.", "warning");
        if (tokens[1] === "disabled") disabledSessions.add(id);
        else disabledSessions.delete(id);
        return notify(ctx, `Useful Skills workflow ${tokens[1]} for this session.`);
      }
      if (tokens[0] === "graph" && tokens.length === 2 && tokens[1] === "test") return await graphTest(ctx);
      if (tokens[0] === "update" && tokens.length === 2 && ["check", "install"].includes(tokens[1])) {
        return await update(tokens[1], ctx);
      }
      const { kind, query, source } = parseCatalogArguments(tokens);
      notify(ctx, formatResources(kind, await listResources(kind, { query, source }), query, source));
    } catch (error) {
      notify(ctx, `${error.message}\n${HELP}`, "warning");
    }
  }

  pi.registerCommand("useful-skills", {
    description: "Browse skills, references, health, graph diagnostics, and updates",
    handler: workbench,
  });
  pi.registerTool({
    name: "us_memory",
    label: "Useful Skills Memory",
    description: "Observe native memory and project graph status, explicitly build/query Graphify, or search/save durable facts. No workflow execution. Build/query may lazily install pinned managed dependencies; status never installs or writes.",
    parameters: MEMORY_PARAMETERS,
    loadMode: "essential",
    approval: args => ["status", "search"].includes(args?.action) ? "read" : args?.action === "save" ? "write" : "exec",
    async execute(_id, args, signal, _onUpdate, ctx) {
      const result = await memoryAction(args, { cwd: ctx.cwd, agentDir: pi.pi.getAgentDir(), memory: ctx.memory, signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, ...(result.ok === false ? { isError: true } : {}) };
    },
  });
  pi.on("before_agent_start", (event, ctx) => {
    const desired = workflowEnabled(ctx) ? [DISCOVERY_HINT, WORKFLOW_POLICY] : [FAST_LANE_HINT];
    const retained = event.systemPrompt.filter(prompt => !OWNED_GUIDANCE.has(prompt));
    const next = [...retained, ...desired];
    return next.length === event.systemPrompt.length && next.every((prompt, index) => prompt === event.systemPrompt[index])
      ? undefined
      : { systemPrompt: next };
  });
  pi.on("tool_call", event => {
    if (!safetyEnabled() || event.toolName !== "bash") return;
    const reason = dangerousCommandReason(event.input?.command);
    if (reason) return { block: true, reason: `Useful Skills safety guard: ${reason}. Use a reversible, explicitly approved operation instead.` };
  });
  pi.on("tool_result", event => {
    const content = redactToolResultContent(event.content);
    return content ? { content } : undefined;
  });
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || startupScheduled) return;
    startupScheduled = true;
    ctx.setTimeout(() => update("check", ctx, true), 0);
  });
}
