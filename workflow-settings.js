import { createHash, randomUUID } from "node:crypto";
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

async function boundedText(handle, limit, label) {
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
    if (!bytesRead) {
      break;
    }
    length += bytesRead;
  }
  if (length > limit) {
    throw new Error(`${label} exceeds the size limit.`);
  }
  return buffer.subarray(0, length).toString("utf8");
}

async function inspectGitDirectory(directory) {
  const canonical = await realpath(directory);
  if (canonical !== path.resolve(directory)) {
    throw new Error("Git directory must not contain symbolic links.");
  }
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isDirectory() || !(details.mode & 0o444) || !(details.mode & 0o111)) {
      throw new Error("Git directory must be readable and searchable.");
    }
  } finally {
    await handle.close();
  }
}

async function scopeRoot(cwd) {
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("An active workspace directory is required.");
  }
  let canonical;
  try {
    canonical = await realpath(cwd);
    if (!(await lstat(canonical)).isDirectory()) {
      throw new Error("Not a directory.");
    }
  } catch {
    throw new Error("Cannot resolve active workspace directory.");
  }

  for (let directory = canonical; ; directory = path.dirname(directory)) {
    const marker = path.join(directory, ".git");
    let details;
    try {
      details = await lstat(marker);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error("Cannot inspect workspace Git marker.");
      }
    }
    if (details) {
      try {
        if (details.isDirectory() && !details.isSymbolicLink()) {
          await inspectGitDirectory(marker);
        } else if (details.isFile() && !details.isSymbolicLink()) {
          const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || !(opened.mode & 0o444)) {
              throw new Error("Git marker must be a readable regular file.");
            }
            const text = await boundedText(handle, MAX_SETTING_BYTES, "Git marker");
            const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(text);
            if (!match || !match[1].trim()) {
              throw new Error("Git marker must contain one gitdir path.");
            }
            await inspectGitDirectory(path.resolve(directory, match[1]));
          } finally {
            await handle.close();
          }
        } else {
          throw new Error("Git marker must be a non-symlink directory or regular file.");
        }
      } catch {
        throw new Error("Cannot safely resolve workspace Git marker.");
      }
      // Key the checkout, never a worktree/submodule's shared administrative directory.
      return directory;
    }
    if (directory === path.dirname(directory)) {
      return canonical;
    }
  }
}

function repositoryDirectory(directory, root) {
  return path.join(directory, "repositories", createHash("sha256").update(root).digest("hex"));
}

async function profileDirectory(agentDir) {
  if (typeof agentDir !== "string" || !agentDir) {
    throw new Error("An agent profile directory is required.");
  }

  let profile;
  try {
    profile = await realpath(agentDir);
  } catch {
    throw new Error("Cannot resolve agent profile directory.");
  }

  if (path.resolve(agentDir) !== profile) {
    throw new Error("Agent profile paths must not contain symbolic links.");
  }

  const details = await lstat(profile);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Agent profile must be a real directory.");
  }

  return profile;
}

function settingDirectory(profile) {
  return path.join(profile, "useful-skills", "workflow-settings");
}

function validateKey(key) {
  if (!KEYS.includes(key)) {
    throw new Error("Unknown workflow setting.");
  }
}

async function readAncestor(directory) {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw new Error("Cannot inspect managed workflow directory.");
  }

  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Managed workflow ancestor must be a non-symlink directory.");
  }

  if ((details.mode & 0o077) !== 0) {
    throw new Error("Managed workflow ancestor must be private.");
  }

  return true;
}

async function privateChild(parent, name) {
  const directory = path.join(parent, name);
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  // Open the directory itself, not a symlink destination, before changing its permissions.
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isDirectory()) {
      throw new Error("Managed workflow ancestor must be a non-symlink directory.");
    }
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
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error("Workflow setting must be a non-symlink regular file.");
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { value: true, source: "default" };
    }
    if (error?.code) {
      throw new Error("Cannot inspect workflow setting safely.");
    }
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
    if (!details.isFile()) {
      throw new Error("Workflow setting must be a regular file.");
    }

    const value = JSON.parse(await boundedText(handle, MAX_SETTING_BYTES, "Workflow setting"));
    if (typeof value !== "boolean") {
      throw new Error("Workflow setting must contain a JSON boolean.");
    }

    return { value, source: "file" };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Workflow setting must contain a JSON boolean.");
    }

    if (error?.code) {
      throw new Error("Cannot read workflow setting safely.");
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export async function readWorkflowSettings({ agentDir, cwd } = {}) {
  const profile = await profileDirectory(agentDir);
  const directory = settingDirectory(profile);
  const values = Object.fromEntries(KEYS.map(key => [key, true]));
  const errors = {};
  // Per key: "file" (read from an existing file), "default" (no file) or "error".
  const sources = Object.fromEntries(KEYS.map(key => [key, "default"]));
  const snapshot = { directory, scopeRoot: undefined, workflowFile: undefined, values, errors, sources };
  try {
    snapshot.scopeRoot = await scopeRoot(cwd);
    snapshot.workflowFile = path.join(repositoryDirectory(directory, snapshot.scopeRoot), "workflow.json");
  } catch (error) {
    values.workflow = undefined;
    errors.workflow = error.message;
    sources.workflow = "error";
  }

  try {
    if (!await readAncestor(path.dirname(directory)) || !await readAncestor(directory)) {
      return snapshot;
    }
  } catch (error) {
    for (const key of KEYS) {
      values[key] = undefined;
      errors[key] = error.message;
      sources[key] = "error";
    }
    return snapshot;
  }

  for (const key of STAGES) {
    try {
      ({ value: values[key], source: sources[key] } = await readSetting(directory, key));
    } catch (error) {
      values[key] = undefined;
      errors[key] = error.message;
      sources[key] = "error";
    }
  }
  if (snapshot.workflowFile) {
    try {
      const local = path.dirname(snapshot.workflowFile);
      if (await readAncestor(path.dirname(local)) && await readAncestor(local)) {
        ({ value: values.workflow, source: sources.workflow } = await readSetting(local, "workflow"));
      }
    } catch (error) {
      values.workflow = undefined;
      errors.workflow = error.message;
      sources.workflow = "error";
    }
  }

  return snapshot;
}

export async function writeWorkflowSetting({ agentDir, cwd, key, enabled } = {}) {
  validateKey(key);
  if (typeof enabled !== "boolean") {
    throw new Error("Workflow setting enabled must be a boolean.");
  }

  const profile = await profileDirectory(agentDir);
  const root = key === "workflow" ? await scopeRoot(cwd) : undefined;
  let directory = await privateChild(await privateChild(profile, "useful-skills"), "workflow-settings");
  if (root) {
    directory = await privateChild(await privateChild(directory, "repositories"), path.basename(repositoryDirectory(directory, root)));
  }
  const target = path.join(directory, `${key}.json`);
  try {
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error("Workflow setting target must be a non-symlink regular file.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
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
    if (handle) {
      await handle.close();
    }

    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new Error("Cannot clean workflow settings temporary file.", { cause: new AggregateError([error, cleanupError]) });
    }

    throw error;
  }
  return enabled;
}
