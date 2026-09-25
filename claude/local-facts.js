import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { prepareStorage } from "../graph-storage.js";
import { workspaceMemoryPaths } from "../graphify.js";

// JSON.stringify can escape each UTF-16 code unit as six ASCII bytes (e.g. \\u0000).
const MAX_FACT_BYTES = 16_384 * 6 + 128;
const MAX_FACT_FILES = 10_000;
const FACT_FILE = /^0\d{4}\.json$/;
const TEMP_FILE = /^\.[0-9a-f-]{36}\.json\.tmp$/;

async function factsDirectory(paths, create = false) {
  const directory = path.join(paths.directory, "claude-facts");

  if (create) {
    await prepareStorage(paths);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (!create && error?.code === "ENOENT") return undefined;
    throw error;
  }

  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
    throw new Error("Claude facts directory must be a private non-symlink directory.");
  }

  return directory;
}

async function readFact(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_FACT_BYTES || (details.mode & 0o077) !== 0) {
      throw new Error("Claude fact must be a private regular file within the size limit.");
    }

    const fact = JSON.parse(await handle.readFile("utf8"));
    if (typeof fact?.content !== "string" || !fact.content.trim() || fact.content.length > 16_384) {
      throw new Error("Claude fact is invalid.");
    }
    return fact.content;
  } finally {
    await handle.close();
  }
}

async function publishFact(directory, temporary) {
  const entries = (await readdir(directory)).filter(name => !TEMP_FILE.test(name));
  if (entries.length > MAX_FACT_FILES || entries.some(name => !FACT_FILE.test(name))) {
    throw new Error("Claude facts storage contains unexpected or excessive entries.");
  }
  if (entries.length === MAX_FACT_FILES) {
    throw new Error("Claude facts storage is full.");
  }

  // Atomic hard links claim one of the finite slots without a read-modify-write lock.
  // The temporary inode is complete and synced before it can become searchable.
  for (let attempt = 0; attempt < MAX_FACT_FILES; attempt++) {
    const slot = (entries.length + attempt) % MAX_FACT_FILES;
    const destination = path.join(directory, `${String(slot).padStart(5, "0")}.json`);
    try {
      await link(temporary, destination);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (entries.length === MAX_FACT_FILES - 1) {
        const current = (await readdir(directory)).filter(name => FACT_FILE.test(name));
        if (current.length === MAX_FACT_FILES) {
          throw new Error("Claude facts storage is full.");
        }
      }
    }
  }

  throw new Error("Claude facts storage is full.");
}

/** Each fact is a separate immutable, atomic file: concurrent processes never overwrite one another. */
export function createLocalFacts({ cwd, agentDir }) {
  async function pathsForAction() {
    return workspaceMemoryPaths({ cwd, agentDir });
  }

  return Object.freeze({
    async status() {
      const paths = await pathsForAction();
      await factsDirectory(paths);
      return { backend: "claude-local-facts", active: true, writable: "unknown", searchable: true };
    },

    async search(query, { limit = 8 } = {}) {
      const paths = await pathsForAction();
      const directory = await factsDirectory(paths);
      if (!directory) return { backend: "claude-local-facts", query, count: 0, items: [] };

      const entries = (await readdir(directory)).filter(name => !TEMP_FILE.test(name));
      if (entries.length > MAX_FACT_FILES || entries.some(name => !FACT_FILE.test(name))) {
        throw new Error("Claude facts storage contains unexpected or excessive entries.");
      }

      const items = [];
      const needle = query.toLocaleLowerCase();
      for (const name of entries.sort().reverse()) {
        const content = await readFact(path.join(directory, name));
        if (content.toLocaleLowerCase().includes(needle)) {
          items.push({ content });
          if (items.length === Math.min(8, limit)) break;
        }
      }
      return { backend: "claude-local-facts", query, count: items.length, items };
    },

    async save({ content }) {
      const paths = await pathsForAction();
      const directory = await factsDirectory(paths, true);
      const temporary = path.join(directory, `.${randomUUID()}.json.tmp`);
      const payload = JSON.stringify({ content });
      if (Buffer.byteLength(payload, "utf8") > MAX_FACT_BYTES) {
        throw new Error("Claude fact exceeds the storage size limit.");
      }

      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await handle.writeFile(payload);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await publishFact(directory, temporary);
      } finally {
        await rm(temporary, { force: true });
      }

      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return { backend: "claude-local-facts", stored: 1 };
    },
  });
}
