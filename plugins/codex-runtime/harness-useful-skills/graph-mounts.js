import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { isPathWithin } from "./path-boundary.js";

export const MOUNT_INFO = "/proc/self/mountinfo";
const MAX_MOUNT_INFO_BYTES = 4 * 1024 * 1024;
const MOUNT_INFO_CHUNK_BYTES = 64 * 1024;
const OCTAL_ESCAPE = /\\([0-7]{3})/g;
const SINGLE_LAYER_OPTIONS = new Set(["upperdir", "workdir", "lowerdir+", "datadir+"]);
const SOURCE_BACKED_FILESYSTEMS = new Set(["fuse", "fuseblk", "nfs", "nfs4", "cifs", "smb3", "9p", "virtiofs", "sshfs"]);
const MAX_BACKING_DEPTH = 8;
const REACHES_HOME = "home";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Show a path with backslashes and control, format, or separator characters escaped. */
export function displayPath(value) {
  return value.replace(/[\\\p{C}\p{Zl}\p{Zp}]/gu, (character) => {
    if (character === "\\") {
      return "\\\\";
    }

    return `\\u{${character.codePointAt(0).toString(16)}}`;
  });
}

/** Decode the kernel's octal escapes (`\ooo`) in one mountinfo field. */
function decodeMountField(value) {
  return value.replace(OCTAL_ESCAPE, (_match, code) => String.fromCharCode(Number.parseInt(code, 8)));
}

function parseMountLine(line) {
  const fields = line.split(" ");
  const separator = fields.indexOf("-", 6);
  if (separator < 0 || fields.length !== separator + 4) {
    return undefined;
  }

  const [id, parent, device, root, mountPoint] = fields;
  const fstype = decodeMountField(fields[separator + 1]);
  const validNumbers = /^\d+$/.test(id) && /^\d+$/.test(parent) && /^\d+:\d+$/.test(device);
  const decodedMountPoint = decodeMountField(mountPoint);
  if (!validNumbers || !root || !path.isAbsolute(decodedMountPoint) || !fstype) {
    return undefined;
  }

  return {
    mountPoint: decodedMountPoint,
    root: decodeMountField(root),
    fstype,
    source: decodeMountField(fields[separator + 2]),
    options: fields[separator + 3],
  };
}

/** Parse Linux mountinfo text; any malformed line rejects the whole table. */
export function parseMountInfo(text) {
  const mounts = [];

  for (const [index, line] of text.split("\n").entries()) {
    if (!line) {
      continue;
    }

    const mount = parseMountLine(line);
    if (!mount) {
      throw new Error(`Mount table line ${index + 1} is malformed.`);
    }

    mounts.push(mount);
  }

  return mounts;
}

/** Read this process's mount table, bounded; undefined when the platform has none. */
export async function readMountInfo(file = MOUNT_INFO, maxBytes = MAX_MOUNT_INFO_BYTES) {
  let handle;

  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }

    throw new Error(`Mount table cannot be read: ${errorMessage(error)}`);
  }

  try {
    const chunks = [];
    const buffer = Buffer.alloc(MOUNT_INFO_CHUNK_BYTES);
    let total = 0;

    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) {
        return Buffer.concat(chunks, total).toString("utf8");
      }

      total += bytesRead;
      if (total > maxBytes) {
        throw new Error(`Mount table exceeds the ${maxBytes}-byte safety limit.`);
      }

      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } catch (error) {
    throw new Error(`Mount table cannot be read: ${errorMessage(error)}`);
  } finally {
    await handle.close();
  }
}

/**
 * Split a decoded lowerdir list as the kernel does: a backslash escapes the next character and an unescaped
 * colon separates layers. Empty segments, such as the "::" separator before data-only layers, are skipped.
 */
function splitLowerdirs(value) {
  const layers = [];
  let layer = "";

  for (let index = 0; index < value.length; index++) {
    const character = value[index];

    if (character === "\\") {
      index++;
      layer += value[index] ?? "";
    } else if (character === ":") {
      layers.push(layer);
      layer = "";
    } else {
      layer += character;
    }
  }

  layers.push(layer);
  return layers.filter(Boolean);
}

/**
 * Overlay layer paths named in the super options, after the kernel's octal escapes are decoded. A
 * single-layer option is kept both as shown and with backslash escapes removed, because kernels differ on
 * whether they unescape it; an extra reading can only add a refusal.
 */
function overlayLayers(options) {
  const layers = [];

  for (const option of options.split(",")) {
    const separator = option.indexOf("=");
    const key = option.slice(0, separator);
    const value = decodeMountField(option.slice(separator + 1));

    if (separator > 0 && key === "lowerdir") {
      layers.push(...splitLowerdirs(value));
    } else if (separator > 0 && SINGLE_LAYER_OPTIONS.has(key)) {
      layers.push(value, value.replace(/\\(.)/gs, "$1"));
    }
  }

  return [...new Set(layers)];
}

function sourceBackedFilesystem(fstype) {
  return SOURCE_BACKED_FILESYSTEMS.has(fstype) || fstype.startsWith("fuse.");
}

function coversHome(directory, homes) {
  return homes.some(home => isPathWithin(directory, home));
}

function mountLabel(mount) {
  const at = displayPath(mount.mountPoint);
  return mount.fstype === "overlay" ? `an overlay mount at ${at}` : `the ${displayPath(mount.fstype)} mount at ${at}`;
}

/**
 * Trace one local backing path (an overlay layer or a FUSE source). It reaches a home when its path, canonical
 * path, or device/inode identity is a protected home, one of its ancestors, or `/`; otherwise the mounts at or
 * above its canonical path are checked in turn. A path that cannot be read here (such as a container's layers
 * on the host) cannot be identified and is allowed.
 */
async function backingPathVerdict(file, checker, depth) {
  if (coversHome(file, checker.homes)) {
    return REACHES_HOME;
  }

  let details;

  try {
    details = await checker.system.stat(file, { bigint: true });
  } catch {
    return undefined;
  }

  if (checker.identities.has(`${details.dev}:${details.ino}`)) {
    return REACHES_HOME;
  }

  const canonical = await checker.system.realpath(file).catch(() => file);
  if (coversHome(canonical, checker.homes)) {
    return REACHES_HOME;
  }

  return mountsVerdict(canonical, checker, depth + 1);
}

/** The first refusal among the not yet checked mounts at or above `directory`, including stacked entries. */
async function mountsVerdict(directory, checker, depth) {
  for (const mount of checker.mounts) {
    if (checker.visited.has(mount) || !isPathWithin(mount.mountPoint, directory)) {
      continue;
    }

    if (depth > MAX_BACKING_DEPTH) {
      return { mount, problem: "whose backing mounts nest too deeply to check" };
    }

    checker.visited.add(mount);
    const verdict = await mountVerdict(mount, checker, depth);
    if (verdict) {
      return verdict;
    }
  }

  return undefined;
}

/**
 * Refuse an overlay with no identifiable layers, a relative layer, or a layer that reaches a home; and a FUSE
 * or network mount whose local absolute source reaches a home (bindfs-style). Remote, tagged, or device
 * sources cannot be traced and are allowed.
 */
async function mountVerdict(mount, checker, depth) {
  if (mount.fstype === "overlay") {
    const layers = overlayLayers(mount.options);
    if (!layers.length) {
      return { mount, problem: "whose layers cannot be identified" };
    }

    if (layers.some(layer => !path.isAbsolute(layer))) {
      return { mount, problem: "whose layers include a relative path" };
    }

    for (const layer of layers) {
      const verdict = await backingPathVerdict(layer, checker, depth);
      if (verdict === REACHES_HOME) {
        return { mount, problem: "whose layers include a home directory" };
      }

      if (verdict) {
        return verdict;
      }
    }

    return undefined;
  }

  if (!sourceBackedFilesystem(mount.fstype) || !path.isAbsolute(mount.source)) {
    return undefined;
  }

  const verdict = await backingPathVerdict(mount.source, checker, depth);
  if (verdict === REACHES_HOME) {
    return { mount, problem: "whose source includes a home directory" };
  }

  return verdict;
}

/**
 * Refuse a workspace that contains another mount, that no listed mount contains (an incomplete table), or
 * that sits on or under any mount whose backing reaches a protected home. Every entry at or above the
 * workspace is checked, not only the visible one, and layers are traced through the mounts beneath them up
 * to a fixed depth. Entries match by mount-point path, never by device number, because btrfs subvolumes
 * share devices. `protection` holds the home paths, the protected device/inode identities, and the
 * `stat`/`realpath` used to trace layers.
 */
export async function mountScopeBlocker(workspace, mounts, protection = {}) {
  const containing = [];

  for (const mount of mounts) {
    if (mount.mountPoint !== workspace && isPathWithin(workspace, mount.mountPoint)) {
      return `workspace contains a nested mount at ${displayPath(mount.mountPoint)}`;
    }

    if (isPathWithin(mount.mountPoint, workspace)) {
      containing.push(mount);
    }
  }

  if (!containing.length) {
    return "mount table does not list the workspace's mount (for example a masked /proc or a chroot)";
  }

  const checker = {
    mounts,
    homes: protection.homes ?? [],
    identities: protection.identities ?? new Set(),
    system: { stat, realpath, ...protection.system },
    visited: new Set(containing),
  };

  for (const mount of containing) {
    const verdict = await mountVerdict(mount, checker, 0);
    if (!verdict) {
      continue;
    }

    const through = verdict.mount === mount ? "" : `, which is backed by ${mountLabel(verdict.mount)}`;
    return `workspace is on ${mountLabel(mount)}${through} ${verdict.problem}`;
  }

  return undefined;
}
