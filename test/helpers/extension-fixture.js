import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import usefulSkills from "../../extension.js";

export async function fixture(t, hasUI = true, memoryAction, sharedAgentDir) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "us-extension-"));
  const root = path.join(parent, "workspace");
  const agentDir = sharedAgentDir ?? path.join(parent, "profile");
  await mkdir(root);
  if (!sharedAgentDir) {
    await mkdir(agentDir);
  }

  t.after(() => rm(parent, { recursive: true, force: true }));

  const commands = new Map();
  const events = new Map();
  const tools = new Map();
  const messages = [];
  const timers = [];
  const selectResponses = [];
  const selections = [];

  usefulSkills({
    setLabel() {},
    pi: { getAgentDir: () => agentDir },
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: definition => tools.set(definition.name, definition),
    on: (name, callback) => events.set(name, callback),
    sendMessage: (message, options) => messages.push({ message: message.content, options }),
  }, { memoryAction });

  let currentSession = "session-one";
  const ctx = {
    cwd: root, hasUI,
    sessionManager: { getSessionId: () => currentSession },
    ui: {
      notify: (message, level) => messages.push({ message, level }),
      select: async (title, choices) => {
        selections.push({ title, choices });
        return selectResponses.shift();
      },
    },
    setTimeout: callback => timers.push(callback),
  };

  return {
    root, agentDir, commands, events, tools, messages, timers, selectResponses, selections, ctx,
    switchSession: id => {
      currentSession = id;
    },
  };
}
