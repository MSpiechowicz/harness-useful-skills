/**
 * OpenCode plugin API V1 entry. It only maps V1 hook shapes onto opencode/session.js; every export of
 * this module must be a plugin function, so it exports nothing else.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunScope } from "./node-runner.js";
import { createSession } from "./session.js";

const RUNTIME_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// One quiet update check per OpenCode process, however many project instances load the plugin.
let updateCheckStarted = false;

/**
 * The parent ID of a session from the host, undefined for a main session. Rejects when the host cannot
 * answer. Only prompt hooks call it: during plugin initialization the host server is not ready.
 */
async function sessionParent(client, id) {
  if (typeof client?.session?.get !== "function") {
    throw new Error("The session API is unavailable.");
  }

  const response = await client.session.get({ path: { id } });
  if (!response?.data || typeof response.data !== "object") {
    throw new Error("The session lookup failed.");
  }

  return response.data.parentID;
}

export const UsefulSkills = async ({ directory, client } = {}) => {
  // This instance's subprocesses, ended by its dispose hook. In the TUI the plugin runs in a Worker that the
  // host terminates right after disposing every instance, without an exit event the runner could act on.
  const runs = createRunScope();
  const session = createSession({
    directory,
    runtimeRoot: RUNTIME_ROOT,
    run: runs.run,
    toast: text => client?.tui?.showToast?.({ body: { message: text, variant: "info" } }),
    sessionParent: id => sessionParent(client, id),
  });

  const checkForUpdate = !updateCheckStarted;
  updateCheckStarted = true;

  // The host awaits plugin initialization before the instance is usable, so start work after it returns.
  setTimeout(() => session.start({ checkForUpdate }), 0);

  return {
    dispose: () => runs.terminate(),
    event: async input => session.onEvent(input?.event),
    "chat.message": async input => session.onChatMessage(input?.sessionID),
    "experimental.chat.system.transform": async (input, output) => session.systemTransform(input?.sessionID, output?.system),
    "command.execute.before": async (input, output) => (
      session.onCommand(input?.command, input?.sessionID, input?.arguments, output?.parts)
    ),
    "tool.execute.before": async (input, output) => session.beforeTool(input?.tool, output?.args),
    "tool.execute.after": async (_input, output) => session.afterTool(output),
  };
};
