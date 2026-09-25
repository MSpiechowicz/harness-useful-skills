import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MARKETPLACE,
  PLUGIN_ID,
  RELEASE_BASE,
  UpdateError,
  checkUpdate,
  installUpdate,
  isNewerVersion,
  latestRelease,
} from "../updater.js";

async function packageAt(root, version) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "oh-my-pi-useful-skills", version }));
}

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "useful-skills-updater-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const installed = path.join(home, "installed-1.0.0");
  await packageAt(installed, "1.0.0");
  return { home, installed };
}

function listing(root, version = "1.0.0", scope = "user") {
  return {
    marketplace: [{
      id: PLUGIN_ID,
      scope,
      entries: [{ scope, installPath: root, version }],
    }],
  };
}

function stableRelease(version = "1.0.1") {
  return async () => new Response(JSON.stringify({
    draft: false,
    prerelease: false,
    tag_name: `v${version}`,
  }), { status: 200 });
}

test("compares stable semantic versions without lexical ordering", () => {
  assert.equal(isNewerVersion("1.10.0", "1.9.9"), true);
  assert.equal(isNewerVersion("1.0.0", "1.0.0"), false);
  assert.equal(isNewerVersion("1.0.0", "2.0.0"), false);
  assert.throws(() => isNewerVersion("1.0.1-rc.1", "1.0.0"), UpdateError);
});

test("rejects unstable or malformed latest-release metadata", async () => {
  await assert.rejects(
    latestRelease(async () => new Response(JSON.stringify({ draft: false, prerelease: true, tag_name: "v1.0.1-rc.1" }))),
    /published stable release/,
  );
  await assert.rejects(
    latestRelease(async () => new Response("not json", { status: 200 })),
    /invalid release metadata/,
  );
  assert.deepEqual(
    await latestRelease(stableRelease()),
    { version: "1.0.1", tag: "v1.0.1", url: `${RELEASE_BASE}v1.0.1` },
  );
});


test("legacy marketplace installation checks releases at the renamed repository", async (t) => {
  const { home, installed } = await fixture(t);
  const oldApi = "https://api.github.com/repos/MSpiechowicz/oh-my-pi-useful-skills/releases/latest";
  const canonicalApi = "https://api.github.com/repos/MSpiechowicz/harness-useful-skills/releases/latest";
  const fetched = [];
  const report = await checkUpdate({
    root: installed,
    cwd: home,
    runner: async (_file, args) => {
      assert.deepEqual(args, ["plugin", "list", "--json"]);
      return JSON.stringify(listing(installed));
    },
    fetcher: async (url, options) => {
      fetched.push(url);
      assert.equal(options.redirect, "error");
      if (url === oldApi) {
        return new Response(null, { status: 301, headers: { Location: canonicalApi } });
      }
      if (url === canonicalApi) {
        return new Response(JSON.stringify({
          draft: false,
          prerelease: false,
          tag_name: "v1.0.1",
        }), { status: 200 });
      }
      throw new Error(`Unexpected release endpoint: ${url}`);
    },
  });

  assert.deepEqual(fetched, [canonicalApi]);
  assert.equal(report.currentVersion, "1.0.0");
  assert.equal(report.latestVersion, "1.0.1");
  assert.equal(report.updateAvailable, true);
  assert.equal(report.managed, true);
  assert.equal(report.releaseUrl, "https://github.com/MSpiechowicz/harness-useful-skills/releases/tag/v1.0.1");
});

test("refuses an unsafe source checkout before fetching or mutating native OMP", async (t) => {
  const { home, installed } = await fixture(t);
  const sourceCheckout = path.join(home, "source-checkout");
  await packageAt(sourceCheckout, "1.0.0");
  const calls = [];
  await assert.rejects(
    installUpdate({
      root: sourceCheckout,
      cwd: home,
      fetcher: async () => { throw new Error("network must not be reached"); },
      runner: async (_file, args) => {
        calls.push(args);
        return JSON.stringify(listing(installed));
      },
    }),
    /Source checkouts are never overwritten/,
  );
  assert.deepEqual(calls, [["plugin", "list", "--json"]]);
});

test("confirms a newer installation after the scoped native upgrade", async (t) => {
  const { home, installed } = await fixture(t);
  const upgraded = path.join(home, "installed-1.0.1");
  await packageAt(upgraded, "1.0.1");
  let registry = listing(installed);
  const calls = [];
  const report = await installUpdate({
    root: installed,
    cwd: home,
    fetcher: stableRelease(),
    runner: async (_file, args) => {
      calls.push(args);
      if (args.join(" ") === "plugin list --json") {
        return JSON.stringify(registry);
      }
      if (args.join(" ") === `plugin marketplace update ${MARKETPLACE}`) {
        return "";
      }
      if (args.join(" ") === `plugin upgrade ${PLUGIN_ID} --scope user`) {
        registry = listing(upgraded, "1.0.1");
        return "";
      }
      throw new Error(`unexpected native command: ${args.join(" ")}`);
    },
  });
  assert.equal(report.updated, true);
  assert.equal(report.currentVersion, "1.0.1");
  assert.equal(report.updateAvailable, false);
});

test("does not report successful upgrade when native OMP leaves the old version installed", async (t) => {
  const { home, installed } = await fixture(t);
  const calls = [];
  await assert.rejects(
    installUpdate({
      root: installed,
      cwd: home,
      fetcher: stableRelease(),
      runner: async (_file, args) => {
        calls.push(args);
        if (args.join(" ") === "plugin list --json") {
          return JSON.stringify(listing(installed));
        }
        if (args.join(" ") === `plugin marketplace update ${MARKETPLACE}`) {
          return "";
        }
        if (args.join(" ") === `plugin upgrade ${PLUGIN_ID} --scope user`) {
          return "";
        }
        throw new Error("unexpected command");
      },
    }),
    /did not install a newer stable useful-skills release/,
  );
  assert.equal(calls.at(-1).join(" "), "plugin list --json");
});

test("refuses multiple active installations even when one matches the running root", async (t) => {
  const { home, installed } = await fixture(t);
  const other = path.join(home, "other");
  await packageAt(other, "1.0.0");
  const registry = { marketplace: [
    ...listing(installed).marketplace,
    ...listing(other, "1.0.0", "project").marketplace,
  ] };
  await assert.rejects(installUpdate({
    root: installed,
    fetcher: async () => { throw new Error("network must not be reached"); },
    runner: async (_file, args) => {
      assert.deepEqual(args, ["plugin", "list", "--json"]);
      return JSON.stringify(registry);
    },
  }), UpdateError);
});

test("does not accept an upgrade still behind the advertised release", async (t) => {
  const { home, installed } = await fixture(t);
  const stale = path.join(home, "stale-upgrade");
  await packageAt(stale, "1.0.1");
  let registry = listing(installed);
  await assert.rejects(installUpdate({
    root: installed,
    fetcher: stableRelease("1.0.2"),
    runner: async (_file, args) => {
      if (args.join(" ") === "plugin list --json") {
        return JSON.stringify(registry);
      }
      if (args[1] === "upgrade") {
        registry = listing(stale, "1.0.1");
      }
      return "";
    },
  }), UpdateError);
});
