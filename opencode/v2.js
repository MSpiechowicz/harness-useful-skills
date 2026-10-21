/**
 * OpenCode plugin API V2 entry. It only maps V2 hook shapes onto opencode/session.js, like v1.js does for V1.
 * Its default export is the V2 plugin definition `{ id, setup }`; entry.js combines it with the V1 plugin.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCommandMatcher } from "./command-prompt.js";
import { createRunScope } from "./node-runner.js";
import { createSession } from "./session.js";

const RUNTIME_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COMMANDS_DIRECTORY = path.join(RUNTIME_ROOT, "opencode", "commands");

/**
 * The parent ID of a session from the host, undefined for a main session. Rejects when the host cannot
 * answer. Only the prompt hook calls it: during plugin setup the host is not ready.
 */
async function sessionParent(ctx, sessionID) {
  if (typeof ctx.session?.get !== "function") {
    throw new Error("The session API is unavailable.");
  }

  const info = await ctx.session.get({ sessionID });
  if (!info || typeof info !== "object") {
    throw new Error("The session lookup failed.");
  }

  return info.parentID;
}

/** Follow session creation and deletion events until `signal` aborts; an unavailable stream is not an error. */
async function followSessions(ctx, session, signal) {
  try {
    for await (const event of ctx.event.subscribe({ signal })) {
      if (event?.type === "session.created") {
        session.sessionCreated(event.data?.sessionID, event.data?.parentID);
      } else if (event?.type === "session.deleted") {
        session.sessionDeleted(event.data?.sessionID);
      }
    }
  } catch {
    // Without events, a prompt in an unknown session asks the host for its parent once.
  }
}

/** Run a session hook callback without ever rejecting: the host treats a rejected V2 session hook as a defect. */
async function quietly(action) {
  try {
    await action();
  } catch {
    // The hook only adds guidance; the turn continues without it.
  }
}

async function setup(ctx) {
  const runs = createRunScope();
  const session = createSession({
    directory: ctx.location?.directory,
    runtimeRoot: RUNTIME_ROOT,
    run: runs.run,
    sessionParent: sessionParent.bind(undefined, ctx),
  });
  const matchCommand = await loadCommandMatcher(COMMANDS_DIRECTORY);

  /**
   * Refresh the session's workflow context for a prompt. A prompt the host built from a command template runs
   * that command first, but only in a main session: a subagent prompt is written by a model, and settings
   * change only from commands the user types.
   */
  async function onPrompt(event) {
    const command = matchCommand(event?.prompt?.text);
    if (command && await session.isMainSession(event.sessionID)) {
      if (command.name === "useful-skills") {
        // The result replaces the prompt; this prompt neither refreshes the context nor consumes an opt-out.
        event.prompt.text = await session.runUsefulSkills(command.args);
        return;
      }

      session.ignoreWorkflow(event.sessionID);
    }

    await session.onChatMessage(event?.sessionID);
  }

  // V2 plugins have no toast: the quiet update check would have nowhere to report, so only role agents sync.
  const started = setTimeout(() => session.start({ checkForUpdate: false }), 0);
  const events = new AbortController();
  void followSessions(ctx, session, events.signal);

  await ctx.session.hook("prompt", event => quietly(() => onPrompt(event)));
  await ctx.session.hook("context", event => quietly(() => {
    const parts = session.systemContext(event?.sessionID).map(text => ({ type: "text", text }));
    event.system.push(...parts);
  }));

  // A rejection from the before hook fails that one tool call; the after hook only rewrites a finished result.
  await ctx.tool.hook("execute.before", async event => session.beforeTool(event?.tool, event?.input));
  await ctx.tool.hook("execute.after", async event => {
    if (event?.status === "completed") {
      session.afterTool(event.result);
    }
  });

  return async () => {
    clearTimeout(started);
    events.abort();
    await runs.terminate();
  };
}

export default { id: "useful-skills", setup };
