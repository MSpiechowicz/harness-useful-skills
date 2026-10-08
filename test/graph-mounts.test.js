import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mountScopeBlocker, parseMountInfo, readMountInfo } from "../graph-mounts.js";
import { mountLine } from "./helpers/graph-fixture.js";

const HOME = "/home/user";
const ROOT_IDENTITY = "1:2";
const HOME_IDENTITY = "1:100";
const IDENTITIES = new Set([ROOT_IDENTITY, "1:10", HOME_IDENTITY]);

function escapeMountField(value) {
  return value.replace(/[ \t\n\\]/g, (character) => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`);
}

/** One mountinfo line with an explicit filesystem type, source, and super options. */
function mountEntry(mountPoint, fstype, source, options = "rw") {
  return `91 1 0:51 / ${escapeMountField(mountPoint)} rw,relatime - ${fstype} ${escapeMountField(source)} ${options}\n`;
}

function overlay(mountPoint, layers) {
  return mountEntry(mountPoint, "overlay", "overlay", `rw,relatime,${layers}`);
}

/**
 * A synthetic filesystem: `identities` maps readable paths to "dev:ino" and `links` maps paths to their
 * canonical target. Unlisted paths cannot be read, like container layers that are only visible on the host.
 */
function fakeSystem({ identities = {}, links = {} } = {}) {
  const resolve = file => links[file] ?? file;

  return {
    stat: async (file) => {
      const key = identities[file] ?? identities[resolve(file)];
      if (!key) {
        throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      }

      const [dev, ino] = key.split(":").map(BigInt);
      return { dev, ino };
    },
    realpath: async file => resolve(file),
  };
}

function check(workspace, text, filesystem = {}) {
  return mountScopeBlocker(workspace, parseMountInfo(text), { homes: [HOME], identities: IDENTITIES, system: fakeSystem(filesystem) });
}

const ROOT = mountLine("/");
const refusedOverlay = at => `workspace is on an overlay mount at ${at} whose layers include a home directory`;

test("mountinfo parsing decodes every octal escape, skips optional fields, and rejects malformed lines", () => {
  const text = [
    "67 1 0:32 /@ / rw,noatime shared:1 - btrfs /dev/nvme0n1p2 rw,subvol=/@",
    "90 67 0:50 /a\\134b /mnt/with\\040space\\011tab\\012line\\054comma rw shared:9 master:2 propagate_from:1 - fuse.sshfs host:/x\\040y rw",
    "",
  ].join("\n");

  assert.deepEqual(parseMountInfo(text), [
    { mountPoint: "/", root: "/@", fstype: "btrfs", source: "/dev/nvme0n1p2", options: "rw,subvol=/@" },
    { mountPoint: "/mnt/with space\ttab\nline,comma", root: "/a\\b", fstype: "fuse.sshfs", source: "host:/x y", options: "rw" },
  ]);

  const malformed = [
    "67 1 0:32 /@ / rw,noatime shared:1 btrfs /dev/root rw",
    "x 1 0:32 / / rw - ext4 /dev/root rw",
    "67 1 032 / / rw - ext4 /dev/root rw",
    "67 1 0:32 / relative rw - ext4 /dev/root rw",
    "67 1 0:32 / / rw - ext4 /dev/root",
    "67 1 0:32 / / rw - ext4 /dev/root rw extra",
  ];
  for (const line of malformed) {
    assert.throws(() => parseMountInfo(`${ROOT}${line}\n`), /line 2 is malformed/, line);
  }
});

test("reading the mount table is bounded and only a missing table is skipped", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "us-graph-mounts-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const table = path.join(root, "mountinfo");
  await writeFile(table, ROOT.repeat(4));

  assert.equal(await readMountInfo(table), ROOT.repeat(4));
  assert.equal(await readMountInfo(path.join(root, "absent")), undefined);
  await assert.rejects(readMountInfo(table, 64), /exceeds the 64-byte safety limit/);
  await assert.rejects(readMountInfo(root), /Mount table cannot be read/);

  if (process.getuid?.() !== 0) {
    await chmod(table, 0);
    await assert.rejects(readMountInfo(table), /Mount table cannot be read: .*EACCES/);
  }
});

test("the host mount table parses when the platform provides one", async t => {
  const text = await readMountInfo();
  if (text === undefined) {
    t.skip("no /proc/self/mountinfo on this platform");
    return;
  }

  assert.ok(parseMountInfo(text).some(mount => mount.mountPoint === "/"));
});

test("nested mounts and tables that do not list the workspace's mount are refused", async () => {
  assert.equal(await check("/repo", ROOT + mountLine("/repo2") + mountLine("/repo")), undefined);
  assert.equal(await check("/repo", mountLine("/repo/vendor/data")), "workspace contains a nested mount at /repo/vendor/data");
  assert.equal(await check("/repo", mountLine("/repo/odd\nname\\x")), "workspace contains a nested mount at /repo/odd\\u{a}name\\\\x");
  assert.equal(
    await check("/repo", overlay("/repo", "lowerdir=/srv/l,upperdir=/srv/u,workdir=/srv/w") + mountLine("/repo/node_modules")),
    "workspace contains a nested mount at /repo/node_modules",
  );

  const unlisted = "mount table does not list the workspace's mount (for example a masked /proc or a chroot)";
  assert.equal(await check("/repo", ""), unlisted);
  assert.equal(await check("/repo", mountLine("/srv") + mountLine("/repo2")), unlisted);
});

test("overlay layers that are or contain a home directory are refused, including escaped spellings", async () => {
  for (const workspace of ["/ov/user", "/ov/user/repo"]) {
    assert.equal(await check(workspace, ROOT + overlay("/ov", "lowerdir=/home,upperdir=/srv/u,workdir=/srv/w")), refusedOverlay("/ov"), workspace);
  }

  const homeLayers = [
    "lowerdir=/home/user,upperdir=/srv/u,workdir=/srv/w",
    "lowerdir=/srv/a:/home/user/,upperdir=/srv/u,workdir=/srv/w",
    "lowerdir=/srv/a,upperdir=/home,workdir=/srv/w",
    "lowerdir=/srv/a,upperdir=/srv/u,workdir=/",
    "lowerdir+=/srv/a,lowerdir+=/home,upperdir=/srv/u,workdir=/srv/w",
    "lowerdir=/srv/a,datadir+=/home/user,upperdir=/srv/u,workdir=/srv/w",
    "lowerdir=/srv/a::/home/user",
    "lowerdir=/srv/odd\\054name:/home/user",
    "lowerdir=/srv/a,upperdir=/home/us\\134er,workdir=/srv/w",
    // The kernel reads "/srv/x\\:/home/us\er" as the layers "/srv/x\" and "/home/user".
    "lowerdir=/srv/x\\134\\134:/home/us\\134er",
  ];
  for (const layers of homeLayers) {
    assert.equal(await check("/ws", ROOT + overlay("/ws", layers)), refusedOverlay("/ws"), layers);
  }

  const escapedHomes = ["/home/my user", "/home/a:b"];
  const escaped = ["lowerdir=/srv/x:/home/my\\040user", "lowerdir=/srv/x:/home/a\\134:b", "lowerdir=/srv/x:/home/a\\134\\072b"];
  for (const layers of escaped) {
    const reason = await mountScopeBlocker("/ws", parseMountInfo(overlay("/ws", layers)), { homes: escapedHomes, system: fakeSystem() });
    assert.equal(reason, refusedOverlay("/ws"), layers);
  }
});

test("overlays with no identifiable or with relative layers are refused", async () => {
  assert.equal(await check("/ws", ROOT + overlay("/ws", "rw")), "workspace is on an overlay mount at /ws whose layers cannot be identified");

  const relative = "workspace is on an overlay mount at /ws whose layers include a relative path";
  for (const layers of ["lowerdir=l/ABC:/srv/a,upperdir=/srv/u,workdir=/srv/w", "lowerdir=/srv/a,upperdir=/srv/u,workdir=w", "lowerdir=/srv/a,upperdir="]) {
    assert.equal(await check("/ws", ROOT + overlay("/ws", layers)), relative, layers);
  }
});

test("a layer or FUSE source that is a symlink, bind mount, or mount backed by a home directory is refused", async () => {
  const symlinked = { identities: { "/srv/link": "9:1" }, links: { "/srv/link": HOME } };
  assert.equal(await check("/ws", ROOT + overlay("/ws", "lowerdir=/srv/link")), undefined);
  assert.equal(await check("/ws", ROOT + overlay("/ws", "lowerdir=/srv/link"), symlinked), refusedOverlay("/ws"));

  for (const target of [HOME, "/home", "/"]) {
    const bound = { identities: { "/srv/bind": { [HOME]: HOME_IDENTITY, "/home": "1:10", "/": ROOT_IDENTITY }[target] } };
    assert.equal(await check("/ws", ROOT + overlay("/ws", "lowerdir=/srv/a:/srv/bind"), bound), refusedOverlay("/ws"), target);
  }

  const lowerOverlay = overlay("/srv/lower", "lowerdir=/home/user,upperdir=/srv/u,workdir=/srv/w");
  const stacked = ROOT + lowerOverlay + overlay("/ws", "lowerdir=/srv/lower/x,upperdir=/srv/u2,workdir=/srv/w2");
  assert.equal(
    await check("/ws/repo", stacked, { identities: { "/srv/lower/x": "5:7" } }),
    "workspace is on an overlay mount at /ws, which is backed by an overlay mount at /srv/lower whose layers include a home directory",
  );

  const fuseHome = ROOT + mountEntry("/srv/fusehome", "fuse.bindfs", HOME) + overlay("/ws", "lowerdir=/srv/fusehome/sub");
  assert.equal(
    await check("/ws", fuseHome, { identities: { "/srv/fusehome/sub": "6:3" } }),
    "workspace is on an overlay mount at /ws, which is backed by the fuse.bindfs mount at /srv/fusehome whose source includes a home directory",
  );

  const fuseLink = ROOT + mountEntry("/mnt/b", "fuse.bindfs", "/srv/link");
  assert.equal(await check("/mnt/b/repo", fuseLink, symlinked), "workspace is on the fuse.bindfs mount at /mnt/b whose source includes a home directory");
});

test("backing mounts are traced to a fixed depth and each mount is checked once", async () => {
  const chain = length => {
    let text = ROOT + overlay("/ws", "lowerdir=/m1/x");
    const identities = {};
    for (let index = 1; index <= length; index++) {
      const next = index === length ? "/srv/plain" : `/m${index + 1}/x`;
      text += overlay(`/m${index}`, `lowerdir=${next}`);
      identities[`/m${index}/x`] = `7:${index}`;
    }

    return check("/ws", text, { identities });
  };

  assert.equal(await chain(8), undefined);
  assert.equal(await chain(10), "workspace is on an overlay mount at /ws, which is backed by an overlay mount at /m9 whose backing mounts nest too deeply to check");

  const cycle = ROOT + overlay("/ws", "lowerdir=/a/x:/ws/y") + overlay("/a", "lowerdir=/b/x") + overlay("/b", "lowerdir=/a/z");
  const identities = { "/a/x": "8:1", "/b/x": "8:2", "/a/z": "8:3", "/ws/y": "8:4" };
  assert.equal(await check("/ws", cycle, { identities }), undefined);
});

test("unreadable layers are allowed unless their path is or contains a home directory", async () => {
  const containerRoot = mountEntry("/", "overlay", "overlay", [
    "rw,relatime,lowerdir=/var/lib/docker/overlay2/l/ABC:/var/lib/docker/overlay2/l/DEF",
    "upperdir=/var/lib/docker/overlay2/123/diff,workdir=/var/lib/docker/overlay2/123/work",
  ].join(","));
  assert.equal(await check("/workspaces/app", containerRoot), undefined);
  assert.equal(await check("/workspaces/app", containerRoot + mountLine("/workspaces/app")), undefined);

  assert.equal(await check("/ws", ROOT + overlay("/ws", "lowerdir=/srv/a\\134:b:/srv/c,upperdir=/srv/u,workdir=/srv/w")), undefined);
  assert.equal(await check("/ws", ROOT + overlay("/ws", "lowerdir=/home/user/layers/l1,upperdir=/home/user/layers/u,workdir=/home/user/layers/w")), undefined);
  assert.equal(await check("/ws", ROOT + overlay("/ws", "lowerdir=/home")), refusedOverlay("/ws"));
});

test("every mount at or above the workspace is checked, including ones shadowed by a deeper mount", async () => {
  const homeRootOverlay = overlay("/", "lowerdir=/home,upperdir=/srv/u,workdir=/srv/w");
  assert.equal(await check("/workspaces/app", homeRootOverlay + mountLine("/workspaces")), refusedOverlay("/"));
  assert.equal(await check("/workspaces/app", homeRootOverlay), refusedOverlay("/"));

  const shadowed = ROOT + overlay("/ws", "lowerdir=/home/user,upperdir=/srv/u,workdir=/srv/w") + mountLine("/ws/repo");
  assert.equal(await check("/ws/repo", shadowed), refusedOverlay("/ws"));

  const stackedOnWorkspace = mountLine("/ws") + overlay("/ws", "lowerdir=/home/user,upperdir=/srv/u,workdir=/srv/w") + mountLine("/ws");
  assert.equal(await check("/ws/repo", ROOT + stackedOnWorkspace), refusedOverlay("/ws"));
});

test("FUSE and network mounts are refused only when their local source reaches a home directory", async () => {
  for (const [fstype, source] of [["fuse.bindfs", "/home/user"], ["fuse.bindfs", "/home"], ["fuse", "/"], ["fuseblk", "/home/user"], ["nfs4", "/home"]]) {
    for (const workspace of ["/mnt/b", "/mnt/b/repo"]) {
      assert.equal(
        await check(workspace, ROOT + mountEntry("/mnt/b", fstype, source)),
        `workspace is on the ${fstype} mount at /mnt/b whose source includes a home directory`,
        `${fstype} ${source} ${workspace}`,
      );
    }
  }

  const allowed = [
    ["fuse.sshfs", "user@host:/x"],
    ["fuse.bindfs", "/srv/projects"],
    ["fuse.bindfs", "/home/user/projects"],
    ["fuseblk", "/dev/sdb1"],
    ["nfs4", "host:/export/home"],
    ["virtiofs", "myfs"],
    ["ext4", "/home/user"],
  ];
  for (const [fstype, source] of allowed) {
    const filesystem = { identities: { "/srv/projects": "4:4", "/dev/sdb1": "0:5" } };
    assert.equal(await check("/mnt/b/repo", ROOT + mountEntry("/mnt/b", fstype, source), filesystem), undefined, `${fstype} ${source}`);
  }
});
