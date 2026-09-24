import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { graphValidationError } from "./graph-validation.js";
import { errorMessage, isObject } from "./graph-safety.js";
import { minimalEnvironment } from "./process.js";

const MAX_GRAPH_BYTES = 512 * 1024 * 1024;
const MAX_POINTER_BYTES = 4 * 1024;
export const PRIVATE_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

async function regularFile(file, description) {
  const details = await lstat(file);

  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${description} must be a regular file.`);
  }

  return details;
}

export async function graphContents(graphPath, workspace) {
  let details;

  try {
    details = await regularFile(graphPath, "Active graph");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { available: false };
    }

    return { available: false, error: `Cannot inspect active graph: ${errorMessage(error)}` };
  }

  if (details.size > MAX_GRAPH_BYTES) {
    return { available: false, error: "Active graph exceeds the 512 MiB safety limit." };
  }

  try {
    const text = await readFile(graphPath, "utf8");
    const contents = JSON.parse(text);
    const error = graphValidationError(contents, workspace);

    if (error) {
      return { available: false, error };
    }

    return { available: true, contents, text };
  } catch (error) {
    return { available: false, error: `Active graph is invalid: ${errorMessage(error)}` };
  }
}

export async function writeAtomic(file, contents, beforeRename) {
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, contents, { mode: PRIVATE_FILE_MODE });
    beforeRename?.();
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function existingDirectory(directory, description) {
  const details = await lstat(directory);

  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${description} must be a non-symlink directory.`);
  }

  return details;
}

export async function checkExistingManagedPath(paths) {
  const directories = [
    path.join(paths.agentDir, "useful-skills"),
    path.dirname(paths.directory),
    paths.directory,
    paths.generations,
    paths.runtime,
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

export async function prepareStorage(paths) {
  await existingDirectory(paths.agentDir, "Agent profile directory");
  const featureRoot = await privateChild(paths.agentDir, "useful-skills");
  const memoryRoot = await privateChild(featureRoot, "memory");
  const directory = await privateChild(memoryRoot, paths.workspaceHash);
  const generations = await privateChild(directory, "generations");
  const runtime = await privateChild(directory, "runtime");

  if (directory !== paths.directory || generations !== paths.generations || runtime !== paths.runtime) {
    throw new Error("Managed memory path did not remain canonical.");
  }

  try {
    const current = await lstat(paths.current);

    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error("Active graph pointer must be a regular file.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function graphEnvironment(paths, python) {
  const home = path.join(paths.runtime, "home");
  const cache = path.join(paths.runtime, "cache");
  const tmp = path.join(paths.runtime, "tmp");

  return {
    home,
    cache,
    tmp,
    environment: minimalEnvironment({ home, cache, tmp, pathEntries: [path.dirname(python)] }),
  };
}

export async function prepareRuntime(paths, python) {
  await prepareStorage(paths);
  const environment = graphEnvironment(paths, python);
  await Promise.all([
    privateChild(paths.runtime, "home"),
    privateChild(paths.runtime, "cache"),
    privateChild(paths.runtime, "tmp"),
  ]);
  return environment;
}

export async function activeSnapshot(paths) {
  let pointer;

  try {
    const details = await regularFile(paths.current, "Active graph pointer");

    if (details.size > MAX_POINTER_BYTES) {
      return { available: false, error: "Active graph pointer exceeds the safety limit." };
    }

    pointer = JSON.parse(await readFile(paths.current, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { available: false };
    }

    return { available: false, error: `Active graph pointer is invalid: ${errorMessage(error)}` };
  }

  if (!isObject(pointer)
    || typeof pointer.generation !== "string"
    || !/^[A-Za-z0-9-]{1,80}$/.test(pointer.generation)) {
    return { available: false, error: "Active graph pointer has an invalid generation." };
  }

  const directory = path.join(paths.generations, pointer.generation);

  try {
    await existingDirectory(directory, "Active graph generation");
  } catch (error) {
    return { available: false, error: `Active graph generation is invalid: ${errorMessage(error)}` };
  }

  const graph = await graphContents(path.join(directory, "graph.json"), paths.workspace);

  if (!graph.available) {
    return graph;
  }

  const snapshot = path.join(directory, "snapshot.json");

  try {
    await regularFile(snapshot, "Active graph metadata");
    const metadata = JSON.parse(await readFile(snapshot, "utf8"));

    if (!isObject(metadata) || metadata.generation !== pointer.generation) {
      return { available: false, error: "Active graph metadata does not match its generation." };
    }

    return {
      ...graph,
      metadata,
      active: {
        generation: pointer.generation,
        directory,
        graph: path.join(directory, "graph.json"),
        snapshot,
        pointer: paths.current,
      },
    };
  } catch (error) {
    return { available: false, error: `Active graph metadata is invalid: ${errorMessage(error)}` };
  }
}
