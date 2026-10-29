import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { prepareStorage, workspaceMemoryPaths } from "./memory-paths.js";

// JSON.stringify can escape each UTF-16 code unit as six ASCII bytes (e.g. \\u0000).
const MAX_FACT_BYTES = 16_384 * 6 + 128;
const MAX_FACT_FILES = 10_000;
const FACT_FILE = /^0\d{4}\.json$/;
const TEMP_FILE = /^\.[0-9a-f-]{36}\.json\.tmp$/;

async function factsDirectory(paths, host, create = false) {
  const directory = path.join(paths.directory, host.directory);

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
    throw new Error(`${host.label} facts directory must be a private non-symlink directory.`);
  }

  return directory;
}

async function readFact(file, label) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_FACT_BYTES || (details.mode & 0o077) !== 0) {
      throw new Error(`${label} fact must be a private regular file within the size limit.`);
    }

    const fact = JSON.parse(await handle.readFile("utf8"));
    if (typeof fact?.content !== "string" || !fact.content.trim() || fact.content.length > 16_384) {
      throw new Error(`${label} fact is invalid.`);
    }
    return fact.content;
  } finally {
    await handle.close();
  }
}

async function publishFact(directory, temporary, label) {
  const entries = (await readdir(directory)).filter(name => !TEMP_FILE.test(name));
  if (entries.length > MAX_FACT_FILES || entries.some(name => !FACT_FILE.test(name))) {
    throw new Error(`${label} facts storage contains unexpected or excessive entries.`);
  }
  if (entries.length === MAX_FACT_FILES) {
    throw new Error(`${label} facts storage is full.`);
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
          throw new Error(`${label} facts storage is full.`);
        }
      }
    }
  }

  throw new Error(`${label} facts storage is full.`);
}

/**
 * Each fact is a separate immutable, atomic file: concurrent processes never overwrite one another.
 * `host` names the adapter: `label` prefixes error messages, `backend` is reported in every result,
 * and `directory` is the facts folder name inside the workspace memory directory.
 */
export function createLocalFacts({ cwd, agentDir, host }) {
  async function pathsForAction(retire = false) {
    return workspaceMemoryPaths({ cwd, agentDir, retire });
  }

  return Object.freeze({
    async status() {
      const paths = await pathsForAction();
      await factsDirectory(paths, host);
      return { backend: host.backend, active: true, writable: "unknown", searchable: true };
    },

    /** Report whether the private facts directory exists, without creating anything. */
    async inspect() {
      const paths = await pathsForAction();
      return { exists: Boolean(await factsDirectory(paths, host)) };
    },

    /** Create the private facts directory only when it is missing. */
    async ensure() {
      const paths = await pathsForAction(true);
      if (await factsDirectory(paths, host)) {
        return { created: false };
      }

      await factsDirectory(paths, host, true);
      return { created: true };
    },

    async search(query, { limit = 8 } = {}) {
      const paths = await pathsForAction();
      const directory = await factsDirectory(paths, host);
      if (!directory) return { backend: host.backend, query, count: 0, items: [] };

      const entries = (await readdir(directory)).filter(name => !TEMP_FILE.test(name));
      if (entries.length > MAX_FACT_FILES || entries.some(name => !FACT_FILE.test(name))) {
        throw new Error(`${host.label} facts storage contains unexpected or excessive entries.`);
      }

      const items = [];
      const needle = query.toLocaleLowerCase();
      for (const name of entries.sort().reverse()) {
        const content = await readFact(path.join(directory, name), host.label);
        if (content.toLocaleLowerCase().includes(needle)) {
          items.push({ content });
          if (items.length === Math.min(8, limit)) break;
        }
      }
      return { backend: host.backend, query, count: items.length, items };
    },

    async save({ content }) {
      const paths = await pathsForAction(true);
      const directory = await factsDirectory(paths, host, true);
      const temporary = path.join(directory, `.${randomUUID()}.json.tmp`);
      const payload = JSON.stringify({ content });
      if (Buffer.byteLength(payload, "utf8") > MAX_FACT_BYTES) {
        throw new Error(`${host.label} fact exceeds the storage size limit.`);
      }

      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await handle.writeFile(payload);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await publishFact(directory, temporary, host.label);
      } finally {
        await rm(temporary, { force: true });
      }

      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return { backend: host.backend, stored: 1 };
    },
  });
}
