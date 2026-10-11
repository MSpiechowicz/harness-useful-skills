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
  RELEASE_API,
  checkUpdate,
  githubToken,
  installUpdate,
  isNewerVersion,
  latestRelease,
} from "../updater.js";

async function packageAt(root, version) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "harness-useful-skills", version }));
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

test("resolves a GitHub token from the environment, then the GitHub CLI", async () => {
  const cli = async () => "gho_fromcli\n";
  assert.equal(await githubToken({ GH_TOKEN: "ghp_first", GITHUB_TOKEN: "ghp_second" }, cli), "ghp_first");
  assert.equal(await githubToken({ GITHUB_TOKEN: "ghp_second" }, cli), "ghp_second");
  assert.equal(await githubToken({}, cli), "gho_fromcli");
  assert.equal(await githubToken({ GITHUB_TOKEN: "bad token\r\nX-Injected: 1" }, async () => null), null);
  assert.equal(await githubToken({}, async () => null), null);
});

test("sends the token only to the release API and never follows redirects", async () => {
  const requests = [];
  await latestRelease(async (url, init) => {
    requests.push({ url, init });
    return stableRelease()();
  }, "ghp_secret");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, RELEASE_API);
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers.Authorization, "Bearer ghp_secret");

  const anonymous = [];
  await latestRelease(async (url, init) => {
    anonymous.push(init.headers);
    return stableRelease()();
  });
  assert.equal("Authorization" in anonymous[0], false);
});

test("retries anonymously once when GitHub rejects the token", async () => {
  const auth = [];
  const release = await latestRelease(async (_url, init) => {
    auth.push(init.headers.Authorization ?? null);
    return auth.length === 1 ? new Response("{}", { status: 401 }) : stableRelease()();
  }, "ghp_expired");
  assert.deepEqual(auth, ["Bearer ghp_expired", null]);
  assert.equal(release.version, "1.0.1");
});

test("explains a rate-limited release lookup", async () => {
  const limited = async () => new Response("{}", {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) },
  });
  await assert.rejects(latestRelease(limited), /rate limit reached\. Try again after .+gh auth login/);
  await assert.rejects(latestRelease(limited, "ghp_valid"), (error) => /rate limit reached/.test(error.message) && !/gh auth login/.test(error.message));
  await assert.rejects(latestRelease(async () => new Response("{}", { status: 403 })), /HTTP 403/);
});

test("authenticates the update check with the resolved token", async (t) => {
  const { home, installed } = await fixture(t);
  const auth = [];
  const report = await checkUpdate({
    root: installed,
    cwd: home,
    token: async () => "gho_login",
    fetcher: async (_url, init) => {
      auth.push(init.headers.Authorization);
      return stableRelease()();
    },
    runner: async () => JSON.stringify(listing(installed)),
  });
  assert.deepEqual(auth, ["Bearer gho_login"]);
  assert.equal(report.updateAvailable, true);
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
