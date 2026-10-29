import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { migrateDataDirectory } from "./data-migration.js";
import { retireGraphifyData } from "./graphify-retirement.js";
import { DATA_DIRECTORY } from "./names.js";
import { isPathWithin } from "./path-boundary.js";

const PRIVATE_MODE = 0o700;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function existingDirectory(directory, description) {
  const details = await lstat(directory);

  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${description} must be a non-symlink directory.`);
  }

  return details;
}

async function checkExistingManagedPath(paths) {
  const directories = [
    path.join(paths.agentDir, DATA_DIRECTORY),
    path.dirname(paths.directory),
    paths.directory,
  ];

  for (const current of directories) {
    try {
      await existingDirectory(current, "Managed memory path");
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }
}

async function privateChild(parent, name) {
  const directory = path.join(parent, name);

  try {
    await existingDirectory(directory, "Managed memory ancestor");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    try {
      await mkdir(directory, { mode: PRIVATE_MODE });
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") {
        throw mkdirError;
      }
    }
  }

  const details = await existingDirectory(directory, "Managed memory ancestor");
  await chmod(directory, PRIVATE_MODE);

  if ((details.mode & 0o077) !== 0) {
    const verified = await existingDirectory(directory, "Managed memory ancestor");

    if ((verified.mode & 0o077) !== 0) {
      throw new Error("Managed memory ancestors must be private.");
    }
  }

  return directory;
}

/** Create the private per-workspace directory chain below the profile, refusing symlinked or shared ancestors. */
export async function prepareStorage(paths) {
  await existingDirectory(paths.agentDir, "Agent profile directory");
  const featureRoot = await privateChild(paths.agentDir, DATA_DIRECTORY);
  const memoryRoot = await privateChild(featureRoot, "memory");
  const directory = await privateChild(memoryRoot, paths.workspaceHash);

  if (directory !== paths.directory) {
    throw new Error("Managed memory path did not remain canonical.");
  }
}

/**
 * The canonical storage paths for a workspace. Read-only callers (status, search, doctor --check) leave `retire` unset
 * so they write nothing. Writers pass `retire: true` to remove data the retired Graphify integration left behind.
 */
export async function workspaceMemoryPaths({ cwd, agentDir, retire = false }) {
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("A workspace cwd is required.");
  }

  if (typeof agentDir !== "string" || !agentDir) {
    throw new Error("An agent profile directory is required.");
  }
  let workspace;
  let profile;

  try {
    workspace = await realpath(cwd);
    profile = await realpath(agentDir);
  } catch (error) {
    throw new Error(`Cannot resolve workspace or agent profile: ${errorMessage(error)}`);
  }
  if (path.resolve(agentDir) !== profile) {
    throw new Error("Agent profile paths must not contain symbolic links.");
  }

  await existingDirectory(workspace, "Workspace directory");
  await existingDirectory(profile, "Agent profile directory");

  // Memory saved under the name used before the rename moves to the current name before the first read.
  migrateDataDirectory(profile);
  // Writers remove data the retired Graphify integration left behind; facts and notes are never touched.
  if (retire) await retireGraphifyData(profile);

  const workspaceHash = createHash("sha256").update(workspace).digest("hex");
  const directory = path.join(profile, DATA_DIRECTORY, "memory", workspaceHash);
  if (isPathWithin(workspace, directory)) {
    throw new Error("Managed memory storage must be outside the workspace.");
  }

  const paths = Object.freeze({
    workspace,
    workspaceHash,
    agentDir: profile,
    directory,
    notes: path.join(directory, "notes.md"),
  });

  await checkExistingManagedPath(paths);
  return paths;
}
