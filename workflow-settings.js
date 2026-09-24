import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

export const STAGES = Object.freeze([
  "research", "plan", "review", "security-review", "backend-memory", "graphify-memory",
]);
const KEYS = Object.freeze(["workflow", ...STAGES]);
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_SETTING_BYTES = 4096;

async function profileDirectory(agentDir) {
  if (typeof agentDir !== "string" || !agentDir) throw new Error("An agent profile directory is required.");
  let profile;
  try {
    profile = await realpath(agentDir);
  } catch {
    throw new Error("Cannot resolve agent profile directory.");
  }
  if (path.resolve(agentDir) !== profile) throw new Error("Agent profile paths must not contain symbolic links.");
  const details = await lstat(profile);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Agent profile must be a real directory.");
  return profile;
}

function settingDirectory(profile) {
  return path.join(profile, "useful-skills", "workflow-settings");
}

function validateKey(key) {
  if (!KEYS.includes(key)) throw new Error("Unknown workflow setting.");
}

async function readAncestor(directory) {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("Cannot inspect managed workflow directory.");
  }
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Managed workflow ancestor must be a non-symlink directory.");
  if ((details.mode & 0o077) !== 0) throw new Error("Managed workflow ancestor must be private.");
  return true;
}

async function privateChild(parent, name) {
  const directory = path.join(parent, name);
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  // Open the directory itself, not a symlink destination, before changing its permissions.
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isDirectory()) throw new Error("Managed workflow ancestor must be a non-symlink directory.");
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
  } finally {
    await handle.close();
  }
  return directory;
}

async function readSetting(directory, key) {
  const file = path.join(directory, `${key}.json`);
  try {
    const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Workflow setting must be a non-symlink regular file.");
  } catch (error) {
    if (error?.code === "ENOENT") return { value: true };
    if (error?.code) throw new Error("Cannot inspect workflow setting safely.");
    throw error;
  }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error("Cannot open workflow setting safely.");
  }
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error("Workflow setting must be a regular file.");
    if (details.size > MAX_SETTING_BYTES) throw new Error("Workflow setting exceeds the size limit.");
    const value = JSON.parse(await handle.readFile("utf8"));
    if (typeof value !== "boolean") throw new Error("Workflow setting must contain a JSON boolean.");
    return { value };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Workflow setting must contain a JSON boolean.");
    if (error?.code) throw new Error("Cannot read workflow setting safely.");
    throw error;
  } finally {
    await handle.close();
  }
}

export async function readWorkflowSettings({ agentDir } = {}) {
  const profile = await profileDirectory(agentDir);
  const directory = settingDirectory(profile);
  const values = Object.fromEntries(KEYS.map(key => [key, true]));
  const errors = {};
  try {
    if (!await readAncestor(path.dirname(directory)) || !await readAncestor(directory)) {
      return { directory, values, errors };
    }
  } catch (error) {
    for (const key of KEYS) {
      values[key] = undefined;
      errors[key] = error.message;
    }
    return { directory, values, errors };
  }
  for (const key of KEYS) {
    try {
      values[key] = (await readSetting(directory, key)).value;
    } catch (error) {
      values[key] = undefined;
      errors[key] = error.message;
    }
  }
  return { directory, values, errors };
}

export async function writeWorkflowSetting({ agentDir, key, enabled } = {}) {
  validateKey(key);
  if (typeof enabled !== "boolean") throw new Error("Workflow setting enabled must be a boolean.");
  const profile = await profileDirectory(agentDir);
  const directory = await privateChild(await privateChild(profile, "useful-skills"), "workflow-settings");
  const target = path.join(directory, `${key}.json`);
  try {
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Workflow setting target must be a non-symlink regular file.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    await handle.writeFile(JSON.stringify(enabled));
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch (error) {
    if (handle) await handle.close();
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new Error("Cannot clean workflow settings temporary file.", { cause: new AggregateError([error, cleanupError]) });
    }
    throw error;
  }
  return enabled;
}
