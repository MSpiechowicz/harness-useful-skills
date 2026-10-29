import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { DATA_DIRECTORY } from "./names.js";

const HASH_DIRECTORY = /^[0-9a-f]{64}$/;
const RETIRED_DIRECTORIES = Object.freeze(["generations", "runtime"]);
const RETIRED_POINTER = "current.json";
const LEGACY_STAGE_FILE = "graphify-memory.json";
const STAGE_FILE = "code-graph.json";
const MAX_SETTING_BYTES = 4096;
const PRIVATE_FILE_MODE = 0o600;

let logged = false;

function ownedByUser(details) {
  return typeof process.getuid !== "function" || details.uid === process.getuid();
}

async function realDirectory(target) {
  const details = await lstat(target).catch(() => undefined);
  return details?.isDirectory() && !details.isSymbolicLink() && ownedByUser(details) ? details : undefined;
}

async function removeIfDirectory(target) {
  if (!await realDirectory(target)) return false;
  // rm unlinks a symbolic link inside the tree instead of following it.
  await rm(target, { recursive: true, force: true });
  return true;
}

async function removePointer(target) {
  const details = await lstat(target).catch(() => undefined);
  if (!details?.isFile() || details.isSymbolicLink() || !ownedByUser(details)) return false;
  await unlink(target);
  return true;
}

async function retireWorkspaceDirectory(directory) {
  let removed = false;
  for (const name of RETIRED_DIRECTORIES) {
    removed = await removeIfDirectory(path.join(directory, name)) || removed;
  }
  removed = await removePointer(path.join(directory, RETIRED_POINTER)) || removed;
  // Only a folder this run emptied goes: an empty one made by another process may be about to receive facts.
  if (removed) await rmdir(directory).catch(() => {});
  return removed;
}

/**
 * Remove what the retired Graphify integration stored below `profile`: the managed dependency environment and, in each
 * workspace's memory folder, the graph generations, runtime and active pointer. Only fixed names are touched and links
 * are never followed. Facts, notes and settings stay. Idempotent, never throws; returns whether anything was removed.
 */
export async function retireGraphifyData(profile) {
  let removed = false;
  try {
    const base = path.join(profile, DATA_DIRECTORY);
    if (!await realDirectory(base) || await realpath(base) !== base) return false;

    removed = await removeIfDirectory(path.join(base, "dependencies"));

    const memory = path.join(base, "memory");
    if (await realDirectory(memory) && await realpath(memory) === memory) {
      for (const name of await readdir(memory)) {
        if (!HASH_DIRECTORY.test(name)) continue;
        const directory = path.join(memory, name);
        if (!await realDirectory(directory)) continue;
        removed = await retireWorkspaceDirectory(directory) || removed;
      }
    }

    const settings = path.join(base, "workflow-settings");
    const details = await realDirectory(settings);
    const privateEnough = process.platform === "win32" || (details && (details.mode & 0o077) === 0);
    if (details && privateEnough && await realpath(settings) === settings) await migrateStageFiles(settings);
  } catch {
    // Retirement is best effort: a failure leaves the data for the next start.
  }

  if (removed && !logged) {
    logged = true;
    console.error("harness-useful-skills: removed data left by the retired Graphify integration.");
  }
  return removed;
}

async function readBoolean(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(MAX_SETTING_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_SETTING_BYTES) return undefined;
    const text = buffer.subarray(0, length).toString("utf8");
    const value = JSON.parse(text);
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Carry a saved `graphify-memory` stage switch over to `code-graph` in the workflow settings directory `dir`.
 * The new file is published atomically (mode 0600) only when it is missing, then the legacy file goes. An invalid,
 * symlinked or otherwise non-regular legacy file is left alone. Never throws; returns whether the legacy file moved.
 */
export async function migrateStageFiles(dir) {
  try {
    const legacy = path.join(dir, LEGACY_STAGE_FILE);
    const target = path.join(dir, STAGE_FILE);
    const details = await lstat(legacy).catch(() => undefined);
    if (!details?.isFile() || details.isSymbolicLink()) return false;

    const value = await readBoolean(legacy);
    if (value === undefined) return false;

    if (!await lstat(target).catch(() => undefined)) {
      const temporary = path.join(dir, `.${randomUUID()}.stage.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await link(temporary, target);
      } catch (error) {
        // Another process published it first; its value wins.
        if (error?.code !== "EEXIST") throw error;
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }

    await unlink(legacy);
    return true;
  } catch {
    return false;
  }
}
