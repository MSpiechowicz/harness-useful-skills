import { randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";

import { LEGACY_DATA_DIRECTORY } from "./legacy-names.js";
import { DATA_DIRECTORY } from "./names.js";

/**
 * Folders at the top of a data directory that are not carried over: the Graphify environment holds absolute
 * paths, so a moved copy would not run. It is a cache that setup rebuilds on demand.
 */
const REBUILT_FOLDERS = Object.freeze(["dependencies"]);

const lstatOrUndefined = target => lstatSync(target, { throwIfNoEntry: false });

/** Copy `source` to a name that does not exist yet, atomically: a reader never sees a partial file. */
function copyNew(source, target) {
  const temporary = `${target}.${randomUUID()}.migrate.tmp`;
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, lstatSync(source).mode & 0o777);
    linkSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Move one regular file: copy it when the target lacks it, and remove it only when the target holds the same bytes. */
function moveFile(source, target, kept) {
  if (!lstatOrUndefined(target)) {
    try {
      copyNew(source, target);
    } catch (error) {
      // Another process copied it first; the comparison below decides.
      if (error?.code !== "EEXIST") throw error;
    }
  }

  if (lstatOrUndefined(target)?.isFile() && readFileSync(source).equals(readFileSync(target))) {
    rmSync(source);
  } else {
    kept.push(source);
  }
}

/** Remove a directory when nothing is left in it; a kept file, a skipped cache or a concurrent move leaves it as it is. */
function removeEmptyDirectory(directory) {
  try {
    rmdirSync(directory);
  } catch {
    // Not empty or already gone.
  }
}

/**
 * Move the directory `source` into `target`, merging with whatever is there. A file that differs from the one in
 * the target, a link and anything that is not a plain file or directory stay in `source` and are added to `kept`.
 */
function moveTree(source, target, kept, skipped = []) {
  const found = lstatOrUndefined(target);
  if (found && !found.isDirectory()) {
    kept.push(source);
    return;
  }

  if (!found) {
    mkdirSync(target, { mode: 0o700 });
    chmodSync(target, lstatSync(source).mode & 0o777);
  }

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);

    if (skipped.includes(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      moveTree(from, to, kept);
    } else if (entry.isFile()) {
      moveFile(from, to, kept);
    } else {
      kept.push(from);
    }
  }

  removeEmptyDirectory(source);
}

/**
 * Move a data directory from its legacy location to the current one without losing data. Each file is copied first
 * and removed from `legacy` only when the copy is identical, so a failure, or a file that exists in both places with
 * different content (a models.yml the user edited), leaves the original where it was. Never throws.
 * Returns `{ kept }`, the paths left in `legacy` on purpose, and `error` when something failed.
 */
export function migrateDirectory(legacy, current) {
  try {
    const source = lstatOrUndefined(legacy);
    if (!source) {
      return { kept: [] };
    }

    if (!source.isDirectory()) {
      return { kept: [legacy] };
    }

    mkdirSync(path.dirname(current), { recursive: true });
    const kept = [];
    moveTree(legacy, current, kept, REBUILT_FOLDERS);
    if (kept.length === 0) {
      for (const folder of REBUILT_FOLDERS) {
        rmSync(path.join(legacy, folder), { recursive: true, force: true });
      }

      removeEmptyDirectory(legacy);
    }

    return { kept };
  } catch (error) {
    return { kept: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Move `<parent>/<legacy name>` (workflow settings, models.yml, memory) to `<parent>/<current name>`. */
export function migrateDataDirectory(parent) {
  return migrateDirectory(path.join(parent, LEGACY_DATA_DIRECTORY), path.join(parent, DATA_DIRECTORY));
}
