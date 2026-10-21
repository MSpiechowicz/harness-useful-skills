/**
 * The OpenCode 2 commands `/useful-skills` and `/us-ignore-workflow`. They run from the command invocation the
 * host hands the plugin, never from prompt text, so only a user-run command reaches the helpers.
 *
 * OpenCode 2 builds the command list from transforms applied in registration order, and the markdown commands
 * the installer ships are registered by a host plugin that starts after this one: they would replace plugin
 * commands of the same name. The plugin therefore registers its commands again whenever the host's command list
 * no longer shows them, so they are always the last registration. The markdown files stay as the fallback: their
 * text tells the model nothing ran.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const USEFUL_SKILLS = "useful-skills";
const IGNORE_WORKFLOW = "us-ignore-workflow";
const USEFUL_SKILLS_DESCRIPTION = "Useful Skills status, settings, and diagnostics";
const IGNORE_WORKFLOW_DESCRIPTION = "Skip the Useful Skills workflow stages for one development request";
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

// Registrations in a row that the host list did not confirm before the plugin stops: another plugin may own the names.
const MAX_UNCONFIRMED = 5;

/** The prompt template of the markdown command `name` in `directory` without frontmatter, or undefined. */
async function loadTemplate(directory, name) {
  try {
    const markdown = await readFile(path.join(directory, `${name}.md`), "utf8");
    const template = markdown.replace(FRONTMATTER, "").trim();
    return template.includes("$ARGUMENTS") ? template : undefined;
  } catch {
    return undefined;
  }
}

/** The entries of a `command.list` answer, which is the array itself or wraps it in `data`. */
function commandList(answer) {
  const list = Array.isArray(answer) ? answer : answer?.data;
  return Array.isArray(list) ? list : [];
}

/**
 * Keep the plugin's commands registered. `refresh()` checks the host's command list and registers them again
 * when another registration replaced them; call it after setup and on every `command.updated` event. A command
 * runs only in a main session: settings change only from commands the user types.
 */
export async function createCommands({ ctx, session, directory }) {
  const ignoreTemplate = await loadTemplate(directory, IGNORE_WORKFLOW);

  /** Run the command through the session handlers and send what it produced as the session's prompt. */
  async function execute(name, input, promptText) {
    const sessionID = input?.sessionID;
    if (!(await session.isMainSession(sessionID))) {
      throw new Error(`/${name} runs only in a main session.`);
    }

    const args = typeof input.prompt?.text === "string" ? input.prompt.text : "";
    const parts = [];
    await session.onCommand(name, sessionID, args, parts);
    await ctx.session.prompt({
      ...input.prompt,
      sessionID,
      text: promptText(args, parts),
      delivery: input.delivery,
    });
  }

  const definitions = [
    {
      name: USEFUL_SKILLS,
      description: USEFUL_SKILLS_DESCRIPTION,
      execute: input => execute(USEFUL_SKILLS, input, (_args, parts) => parts[0].text),
    },
  ];

  if (ignoreTemplate) {
    definitions.push({
      name: IGNORE_WORKFLOW,
      description: IGNORE_WORKFLOW_DESCRIPTION,
      execute: input => execute(IGNORE_WORKFLOW, input, args => ignoreTemplate.replaceAll("$ARGUMENTS", () => args.trim()).trim()),
    });
  }

  let registration;
  let unconfirmed = 0;
  let stopped = false;
  let queue = Promise.resolve();

  async function ensure() {
    if (stopped || typeof ctx.command?.transform !== "function" || typeof ctx.command.list !== "function") {
      return;
    }

    const listed = commandList(await ctx.command.list());
    const registered = definitions.every(definition => (
      listed.some(item => item?.name === definition.name && item.description === definition.description)
    ));
    if (registered) {
      unconfirmed = 0;
      return;
    }

    if (unconfirmed >= MAX_UNCONFIRMED) {
      return;
    }

    unconfirmed += 1;
    const previous = registration;
    registration = await ctx.command.transform(editor => {
      for (const definition of definitions) {
        editor.add(definition);
      }
    });
    await previous?.dispose();
  }

  return {
    /** Serialized and never rejecting: an unavailable command API only leaves the markdown fallback in place. */
    refresh() {
      queue = queue.then(ensure).catch(() => {});
      return queue;
    },

    async stop() {
      stopped = true;
      await queue;
      await registration?.dispose().catch(() => {});
    },
  };
}
