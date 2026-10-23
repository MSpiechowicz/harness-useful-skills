import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { displayPath, MOUNT_INFO, mountScopeBlocker, parseMountInfo, readMountInfo } from "./graph-mounts.js";
import { isPathWithin } from "./path-boundary.js";

export { mountScopeBlocker, parseMountInfo, readMountInfo };

export const SCOPE_HOME_UNKNOWN = "home directory cannot be determined safely";
export const SCOPE_COVERS_HOME = "workspace includes a home directory or is the filesystem root";
export const SCOPE_UNREADABLE = "workspace directory identity cannot be checked";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Host services used by scope checks; tests replace any of them. */
export function scopeSystem(system = {}) {
  return {
    homedir: system.homedir ?? os.homedir,
    userInfo: system.userInfo ?? os.userInfo,
    stat: system.stat ?? stat,
    realpath: system.realpath ?? realpath,
    readMountInfo: system.readMountInfo ?? readMountInfo,
    platform: system.platform ?? process.platform,
  };
}

/**
 * Home directories to protect: the $HOME-derived home, the account's password-database home, and any
 * caller-supplied home. An unavailable $HOME reads as "" so it blocks the build; a missing account entry
 * is skipped because $HOME still protects.
 */
function protectedHomes(system, home) {
  const homes = [];

  try {
    homes.push(system.homedir());
  } catch {
    homes.push("");
  }

  try {
    homes.push(system.userInfo().homedir);
  } catch {
    // No password-database entry for this user.
  }

  if (home !== undefined) {
    homes.push(home);
  }

  return homes;
}

/** Device and inode of `file` as a comparable key, or undefined when it cannot be read. */
async function identity(system, file) {
  try {
    const { dev, ino } = await system.stat(file, { bigint: true });
    return `${dev}:${ino}`;
  } catch {
    return undefined;
  }
}

/** Identities of `directory` and every ancestor up to the filesystem root. */
async function lineageIdentities(system, directory) {
  const identities = new Set();
  let current = directory;

  while (true) {
    const key = await identity(system, current);
    if (key) {
      identities.add(key);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return identities;
    }

    current = parent;
  }
}

function canonicalPath(file) {
  return realpath(file).catch(() => path.resolve(file));
}

/**
 * Canonical protected homes, every spelling of them (as configured and canonical), and the identities of
 * each home, its ancestors, and the filesystem root.
 */
async function protectedState(system, home) {
  const homes = protectedHomes(system, home);
  const unsafeHome = homes.some(candidate => typeof candidate !== "string" || !path.isAbsolute(candidate));
  if (unsafeHome) {
    return { reason: SCOPE_HOME_UNKNOWN };
  }

  const canonicalHomes = await Promise.all(homes.map(canonicalPath));
  const identities = new Set();
  for (const homeDirectory of canonicalHomes) {
    for (const key of await lineageIdentities(system, homeDirectory)) {
      identities.add(key);
    }
  }

  return { homes: canonicalHomes, homePaths: [...new Set([...homes, ...canonicalHomes])], identities };
}

/**
 * Refuse workspace roots that are the filesystem root or are, or contain, any protected home directory.
 * Containment is checked by canonical path and by device/inode identity, which also catches a home
 * directory, one of its ancestors, or the filesystem root reached through a bind mount or second mount.
 */
export async function workspaceScopeBlocker(roots, scope = {}) {
  const system = scopeSystem(scope.system);
  const state = await protectedState(system, scope.home);
  if (state.reason) {
    return state.reason;
  }

  const canonicalRoots = await Promise.all(roots.map(canonicalPath));
  const filesystemRoot = canonicalRoots.some(root => root === path.parse(root).root);
  const coversHome = state.homes.some(homeDirectory => canonicalRoots.some(root => isPathWithin(root, homeDirectory)));
  if (filesystemRoot || coversHome) {
    return SCOPE_COVERS_HOME;
  }

  const rootIdentities = await Promise.all(canonicalRoots.map(root => identity(system, root)));
  if (rootIdentities.includes(undefined)) {
    return SCOPE_UNREADABLE;
  }

  for (const root of canonicalRoots) {
    const key = await identity(system, path.parse(root).root);
    if (key) {
      state.identities.add(key);
    }
  }

  if (rootIdentities.some(key => state.identities.has(key))) {
    return SCOPE_COVERS_HOME;
  }

  return undefined;
}

/** Record the workspace identity and protected identities checked again around and after extraction. */
export async function pinWorkspace(workspace, scope = {}) {
  const system = scopeSystem(scope.system);
  const state = await protectedState(system, scope.home);
  if (state.reason) {
    throw new Error(state.reason);
  }

  const canonical = await realpath(workspace);
  const { dev, ino } = await system.stat(canonical, { bigint: true });
  const rootIdentity = await identity(system, path.parse(canonical).root);
  if (rootIdentity) {
    state.identities.add(rootIdentity);
  }

  return Object.freeze({ realpath: canonical, dev, ino, protectedIdentities: state.identities, checked: new Map() });
}

/** Throw when the pinned workspace path now resolves elsewhere or names a different directory. */
export async function assertWorkspaceUnchanged(pin, scope = {}) {
  const system = scopeSystem(scope.system);
  let current;
  let details;

  try {
    current = await realpath(pin.realpath);
    details = await system.stat(pin.realpath, { bigint: true });
  } catch (error) {
    throw new Error(`Workspace directory cannot be re-checked during the graph build: ${errorMessage(error)}`);
  }

  if (current !== pin.realpath || details.dev !== pin.dev || details.ino !== pin.ino) {
    throw new Error("Workspace directory changed during the graph build.");
  }
}

/**
 * Read, parse, and apply the mount rules. Linux must provide a readable, well-formed mount table (a
 * missing one means /proc is masked); other platforms have none and skip these checks.
 */
export async function workspaceMountBlocker(workspace, scope = {}) {
  const system = scopeSystem(scope.system);
  const state = await protectedState(system, scope.home);
  if (state.reason) {
    return state.reason;
  }

  let mounts;

  try {
    const text = await system.readMountInfo();
    if (text === undefined && system.platform === "linux") {
      return `mount table cannot be checked: ${MOUNT_INFO} is missing`;
    }

    if (text === undefined) {
      return undefined;
    }

    mounts = parseMountInfo(text);
  } catch (error) {
    return `mount table cannot be checked: ${errorMessage(error)}`;
  }

  return mountScopeBlocker(workspace, mounts, { homes: state.homePaths, identities: state.identities, system });
}

async function entryScopeError(entry, pin, system) {
  const relative = displayPath(path.relative(pin.realpath, entry));
  let details;

  try {
    details = await system.stat(entry, { bigint: true });
  } catch (error) {
    return `cannot be checked at ${relative}: ${errorMessage(error)}`;
  }

  if (pin.protectedIdentities.has(`${details.dev}:${details.ino}`)) {
    return `passes through a mount of a protected home directory at ${relative}`;
  }

  if (details.dev !== pin.dev) {
    return `lies on a different device than the workspace at ${relative} (a nested mount or btrfs subvolume)`;
  }

  return undefined;
}

/**
 * Refuse a canonical source path when it, or any directory between the workspace and it, sits on another
 * device or is a protected home reached through a bind mount. Results are cached on the per-build pin.
 */
export async function sourceScopeError(resolvedSourcePath, pin, scope = {}) {
  const system = scopeSystem(scope.system);
  const display = displayPath(path.relative(pin.realpath, resolvedSourcePath));
  if (resolvedSourcePath === pin.realpath || !isPathWithin(pin.realpath, resolvedSourcePath)) {
    return `Graph node source file resolves outside the workspace: ${display}`;
  }

  const entries = [];
  for (let current = resolvedSourcePath; current !== pin.realpath; current = path.dirname(current)) {
    entries.unshift(current);
  }

  for (const entry of entries) {
    if (!pin.checked.has(entry)) {
      pin.checked.set(entry, await entryScopeError(entry, pin, system));
    }

    const reason = pin.checked.get(entry);
    if (reason) {
      return `Graph node source file ${display} ${reason}.`;
    }
  }

  return undefined;
}
