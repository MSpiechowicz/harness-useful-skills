/**
 * Host-neutral OpenCode session state and hook decisions. Plugin-API entries (see v1.js) only map host
 * shapes onto these handlers. Heavy I/O runs in `node` subprocesses; in-process work is limited to the
 * bash guard, result redaction, and cached context.
 */
import path from "node:path";
import { commandGuardDenial, redactValue } from "../tool-safety.js";
import { effectiveWorkflow } from "../workflow-policy.js";
import { workflowContext } from "./context.js";
import { NodeUnavailable, runNode } from "./node-runner.js";

const CONTEXT_TIMEOUT_MS = 10_000;
const PARENT_LOOKUP_TIMEOUT_MS = 2_000;
const BACKGROUND_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 60_000;
const LONG_COMMAND_TIMEOUT_MS = 600_000;

// Subcommands that can run for minutes, with the notice shown first: hooks have no progress UI.
const LONG_COMMAND_NOTICES = new Map([
  ["doctor", "Useful Skills: running doctor; first setup can take minutes."],
  ["graph test", "Useful Skills: running the graph test; it can take minutes."],
  ["update install", "Useful Skills: installing the update; it can take minutes."],
]);

const COMMAND = "useful-skills";
const IGNORE_COMMAND = "us-ignore-workflow";
const NO_OUTPUT = "(no output)";
const NODE_REQUIRED = "Node.js 22 or newer must be on PATH for Useful Skills in OpenCode. Install it, make sure `node` is on the PATH OpenCode starts with, then restart OpenCode.";
const NODE_MISSING_NOTICE = "Useful Skills needs Node.js 22+ on PATH; workflow guidance is limited until then.";

// Bash results carry text in title/output/metadata; MCP results are raw `content` and `structuredContent`.
// Attachments and `_meta` are not text results and stay untouched.
const REDACTED_FIELDS = ["title", "output", "metadata", "content", "structuredContent"];

function isSessionID(value) {
  return typeof value === "string" && value.length > 0;
}

function resultText(exitCode, text) {
  return `Useful Skills \`/useful-skills\` result (exit ${exitCode}). Show it to the user verbatim; take no other action:\n\n${text}`;
}

function notRunText(reason) {
  return `Useful Skills \`/useful-skills\` did not run. Show this to the user verbatim; take no other action:\n\n${reason}`;
}

/** Context for a prompt whose settings could not be read: no stage may run automatically. */
function unknownSettingsContext() {
  return workflowContext(effectiveWorkflow(undefined));
}

/** Resolve with `promise`, or reject once `timeoutMs` passes first. */
function withTimeout(promise, timeoutMs) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out.")), timeoutMs);
  });

  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * One OpenCode plugin instance for `directory`. `run(script, args, options)` defaults to runNode;
 * `toast(text)` shows a host notice. `sessionParent(sessionID)` resolves a session's parent ID (none for
 * a main session) and rejects when the host cannot tell; it is only called from prompt hooks.
 * Session state is bounded to the `maxSessions` most recently used sessions.
 */
export function createSession({ directory, runtimeRoot, run = runNode, toast, sessionParent, maxSessions = 256 }) {
  const sessions = new Map();
  let routingNote;
  let nodeMissingShown = false;

  function script(name) {
    return path.join(runtimeRoot, "opencode", name);
  }

  /** Show a notice without waiting for it; a missing or failing host toast is not an error. */
  function notify(text) {
    try {
      Promise.resolve(toast?.(text)).catch(() => {});
    } catch {
      // The host UI is optional.
    }
  }

  /**
   * The `text` field of one `hook-cli.js` JSON line, or undefined for a failed run or malformed output.
   * Rejects when the subprocess cannot run at all.
   */
  async function runHook(args, timeoutMs) {
    const { exitCode, stdout } = await run(script("hook-cli.js"), args, { cwd: directory, timeoutMs });
    if (exitCode !== 0) {
      return undefined;
    }

    try {
      const { text } = JSON.parse(stdout);
      return typeof text === "string" ? text : undefined;
    } catch {
      return undefined;
    }
  }

  /** Like runHook, but any failure is undefined. */
  async function hookText(args, timeoutMs) {
    try {
      return await runHook(args, timeoutMs);
    } catch {
      return undefined;
    }
  }

  /** The workflow context for one prompt; tells the user once when Node.js is missing. */
  async function contextText(optOut) {
    try {
      return await runHook(optOut ? ["context", "--opt-out"] : ["context"], CONTEXT_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof NodeUnavailable && !nodeMissingShown) {
        nodeMissingShown = true;
        notify(NODE_MISSING_NOTICE);
      }
      return undefined;
    }
  }

  /** The state of a known session, marked as most recently used. */
  function existingState(sessionID) {
    const state = sessions.get(sessionID);
    if (state) {
      // Maps iterate in insertion order, so re-inserting moves the session to the most recent end.
      sessions.delete(sessionID);
      sessions.set(sessionID, state);
    }
    return state;
  }

  function sessionState(sessionID) {
    const existing = existingState(sessionID);
    if (existing) {
      return existing;
    }

    // `child` is undefined until a session event or a parent lookup settles it.
    const state = { child: undefined, optOutPending: false, commandTurn: false, context: undefined };
    sessions.set(sessionID, state);
    if (sessions.size > maxSessions) {
      sessions.delete(sessions.keys().next().value);
    }
    return state;
  }

  /** Whether a session is a subagent session, asking the host once when no event said so. */
  async function isChildSession(sessionID, state) {
    if (state.child === undefined && sessionParent) {
      try {
        const parentID = await withTimeout(Promise.resolve(sessionParent(sessionID)), PARENT_LOOKUP_TIMEOUT_MS);
        state.child = isSessionID(parentID);
      } catch {
        // Unknown for now: treat this prompt as a main session's and ask again next time.
      }
    }
    return state.child === true;
  }

  /**
   * Begin background work without blocking plugin load: generate role agents and cache their routing note,
   * and when `checkForUpdate` run one quiet update check that toasts any notice. The returned promise
   * settles when both finish and never rejects.
   */
  function start({ checkForUpdate = true } = {}) {
    const agents = hookText(["sync-agents"], BACKGROUND_TIMEOUT_MS).then(text => {
      if (text) {
        routingNote = text;
      }
    });

    const update = checkForUpdate
      ? hookText(["update-check"], BACKGROUND_TIMEOUT_MS).then(text => {
        if (text?.trim()) {
          notify(text.trim());
        }
      })
      : undefined;

    return Promise.all([agents, update]).then(() => undefined);
  }

  /** Track subagent (child) sessions so they get no workflow context, and forget deleted sessions. */
  function onEvent(event) {
    const info = event?.properties?.info;
    if (!isSessionID(info?.id)) {
      return;
    }

    if (event.type === "session.created") {
      sessionState(info.id).child = isSessionID(info.parentID);
    } else if (event.type === "session.deleted") {
      sessions.delete(info.id);
    }
  }

  /**
   * Refresh the cached workflow context for the prompt being submitted, consuming a pending opt-out.
   * The prompt of a `/useful-skills` command is skipped: it neither consumes the opt-out nor changes the
   * cached context. A `/us-ignore-workflow` prompt is the one its own opt-out applies to.
   */
  async function onChatMessage(sessionID) {
    if (!isSessionID(sessionID)) {
      return;
    }

    const state = sessionState(sessionID);
    if (state.commandTurn) {
      state.commandTurn = false;
      return;
    }

    if (await isChildSession(sessionID, state)) {
      return;
    }

    const optOut = state.optOutPending;
    state.optOutPending = false;
    state.context = await contextText(optOut) ?? unknownSettingsContext();
  }

  /**
   * Append cached context to a session's system prompt; nothing before its first prompt or in a child session.
   * V1 transform input carries only the session and model, so title and compaction requests for a main
   * session also receive the context; they cannot be told apart from prompt turns.
   */
  function systemTransform(sessionID, system) {
    const state = isSessionID(sessionID) ? existingState(sessionID) : undefined;
    if (!Array.isArray(system) || !state || state.child || state.context === undefined) {
      return;
    }

    system.push(state.context);
    if (routingNote) {
      system.push(routingNote);
    }
  }

  /** Throw the denial reason for a dangerous or malformed bash command; other tools pass. */
  function beforeTool(tool, args) {
    if (tool !== "bash") {
      return;
    }

    const denial = commandGuardDenial(args?.command);
    if (denial) {
      throw new Error(denial);
    }
  }

  /** Redact secrets in a tool result in place, assigning only the fields that changed. */
  function afterTool(output) {
    if (!output || typeof output !== "object") {
      return;
    }

    for (const field of REDACTED_FIELDS) {
      if (!Object.hasOwn(output, field)) {
        continue;
      }

      const redacted = redactValue(output[field]);
      if (redacted !== output[field]) {
        output[field] = redacted;
      }
    }
  }

  async function commandText(argument) {
    const notice = LONG_COMMAND_NOTICES.get(argument.split(/\s+/).join(" "));
    const timeoutMs = notice ? LONG_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    if (notice) {
      notify(notice);
    }

    try {
      // command-core tokenizes and bounds the raw argument text.
      const args = argument ? [argument] : [];
      const { exitCode, stdout, stderr } = await run(script("command.js"), args, { cwd: directory, timeoutMs });
      const text = (stdout.trim() ? stdout : stderr).trimEnd() || NO_OUTPUT;
      return resultText(exitCode, redactValue(text));
    } catch (error) {
      if (error instanceof NodeUnavailable) {
        return notRunText(NODE_REQUIRED);
      }

      return notRunText(redactValue(error instanceof Error ? error.message : String(error)));
    }
  }

  /**
   * Handle a user-run command before its prompt is sent. `/useful-skills` runs in a subprocess and its result
   * replaces `parts` in place (the host keeps the array, not a reassignment); its prompt is marked so
   * onChatMessage skips it. `/us-ignore-workflow` marks the session's next prompt (its own) as opted out
   * and leaves its prompt unchanged.
   */
  async function onCommand(name, sessionID, args, parts) {
    if (name === IGNORE_COMMAND) {
      if (isSessionID(sessionID)) {
        sessionState(sessionID).optOutPending = true;
      }
      return;
    }

    if (name !== COMMAND || !Array.isArray(parts)) {
      return;
    }

    if (isSessionID(sessionID)) {
      sessionState(sessionID).commandTurn = true;
    }

    const text = await commandText(typeof args === "string" ? args.trim() : "");
    parts.length = 0;
    parts.push({ type: "text", text });
  }

  return { start, onEvent, onChatMessage, systemTransform, beforeTool, afterTool, onCommand };
}
