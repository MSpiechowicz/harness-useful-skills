import { lstatSync, mkdirSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { gitWorkTreeRoot, readWorkflowSnapshot, STAGES } from "../workflow-settings.js";
import { opencodeConfigDir } from "./paths.js";

const KEYS = Object.freeze(["workflow", ...STAGES]);

/** True only when `file` does not exist; any other inspection failure is left for the store to report. */
async function isMissing(file) {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

/**
 * The snapshot of a profile that has never saved a setting: every key enabled by default. The repository workflow
 * file has no path until the store exists, so it stays undefined.
 */
async function defaultSnapshot(configDir, cwd) {
  const values = Object.fromEntries(KEYS.map(key => [key, true]));
  const sources = Object.fromEntries(KEYS.map(key => [key, "default"]));
  const errors = {};
  const snapshot = { directory: path.join(configDir, "useful-skills", "workflow-settings"), scopeRoot: undefined, workflowFile: undefined, values, errors, sources };

  try {
    snapshot.scopeRoot = (await gitWorkTreeRoot(cwd)) ?? await realpath(cwd);
  } catch (error) {
    values.workflow = undefined;
    errors.workflow = error.message;
    sources.workflow = "error";
  }

  return snapshot;
}

/**
 * OpenCode workflow settings: the shared file store under the user config dir for both install scopes.
 * A saved file wins; without one a setting is enabled. There is no plugin-option tier. A config dir that does
 * not exist yet holds no saved settings.
 */
export async function readOpenCodeWorkflow({ environment = process.env, cwd } = {}) {
  const configDir = opencodeConfigDir(environment);
  if (await isMissing(configDir)) {
    return defaultSnapshot(configDir, cwd);
  }

  return readWorkflowSnapshot({ configDir, cwd });
}

/**
 * The config dir that holds the settings store, created with default permissions when it does not exist yet so
 * a first setting can be saved; the store itself creates its owner-only `useful-skills` directory below it.
 */
export function ensureOpenCodeConfigDir(environment = process.env) {
  const configDir = opencodeConfigDir(environment);
  if (!lstatSync(configDir, { throwIfNoEntry: false })) {
    mkdirSync(configDir, { recursive: true });
  }

  return configDir;
}
