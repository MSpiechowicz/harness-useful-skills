/**
 * Recognizes the prompts of the installed markdown commands `/useful-skills` and `/us-ignore-workflow`.
 * OpenCode 1.x lets a plugin intercept a command by name. OpenCode 2.x does not: a markdown command in the
 * config directory always wins over a plugin command of the same name, so the plugin recognizes the prompt
 * the host builds from the command's template instead.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const COMMANDS = ["useful-skills", "us-ignore-workflow"];
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const ARGUMENTS = "$ARGUMENTS";

/**
 * The text every prompt of a command starts with: its template without frontmatter, without a trailing
 * `$ARGUMENTS` placeholder, and trimmed. Undefined when the template cannot be recognized safely.
 */
function leadOf(markdown) {
  const template = markdown.replace(FRONTMATTER, "").trim();
  const lead = template.endsWith(ARGUMENTS) ? template.slice(0, -ARGUMENTS.length).trimEnd() : template;
  return lead && !lead.includes(ARGUMENTS) ? lead : undefined;
}

/**
 * Read the command templates in `directory` and return `match(text)`: `{ name, args }` for the prompt the host
 * builds from one of them (the template, then what the user typed after the command), else undefined.
 * Templates that are missing or unusable are never matched.
 */
export async function loadCommandMatcher(directory) {
  const leads = new Map();
  for (const name of COMMANDS) {
    try {
      const lead = leadOf(await readFile(path.join(directory, `${name}.md`), "utf8"));
      if (lead) {
        leads.set(name, lead);
      }
    } catch {
      // No template, so the host has no such command to recognize.
    }
  }

  return text => {
    if (typeof text !== "string") {
      return undefined;
    }

    for (const [name, lead] of leads) {
      const rest = text.slice(lead.length);
      if (text.startsWith(lead) && (rest === "" || /^\s/.test(rest))) {
        return { name, args: rest.trim() };
      }
    }

    return undefined;
  };
}
