import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SECRET = "pass" + "word=" + "synthetic-example-value-12345";
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

// A stand-in `node` on PATH answers every Useful Skills subprocess and logs its arguments, so these tests drive
// the V2 entry end to end without running the real helpers.
const directory = await mkdtemp(path.join(os.tmpdir(), "useful-skills-v2-"));
const bin = path.join(directory, "bin");
const log = path.join(directory, "node.log");
await mkdir(bin);
await writeFile(path.join(bin, "node"), `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  *hook-cli.js)
    case "$2" in
      context) printf '{"text":"CONTEXT %s"}' "$3" ;;
      sync-agents) printf '{"text":"ROUTING"}' ;;
      *) printf '{"text":""}' ;;
    esac ;;
  *command.js) printf 'ran %s' "$2" ;;
esac
`);
await chmod(path.join(bin, "node"), 0o755);
process.env.PATH = bin;
test.after(() => rm(directory, { recursive: true, force: true }));

const entry = await import("../opencode/entry.js");
const v1 = await import("../opencode/v1.js");
const v2 = await import("../opencode/v2.js");

const tick = () => new Promise(resolve => setImmediate(resolve));

/** The subprocess calls whose script is `script` ("hook-cli.js" or "command.js"), with the script path shortened. */
async function nodeCalls(script) {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter(line => line.includes(`/${script}`)).map(line => line.replace(/^\S*\//, ""));
}

/** Poll until `check` returns a truthy value, so tests do not depend on how long a subprocess takes. */
async function eventually(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("The condition never became true.");
}

/** The prompt text OpenCode builds from an installed command template and what the user typed after it. */
async function commandPrompt(name, input = "") {
  const markdown = await readFile(path.join(ROOT, "opencode", "commands", `${name}.md`), "utf8");
  const template = markdown.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", () => input).trim();
  return (input.trim() ? `${template}\n\n${input}` : template).trim();
}

/** A pushable event stream that ends when its signal aborts, like ctx.event.subscribe. */
function eventFeed() {
  const queue = [];
  let wake;
  return {
    emit(event) {
      queue.push(event);
      wake?.();
    },
    subscribe({ signal } = {}) {
      return (async function* () {
        while (!signal?.aborted) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          await new Promise(resolve => {
            wake = resolve;
            signal?.addEventListener("abort", resolve, { once: true });
          });
        }
      })();
    },
  };
}

/** Run the V2 setup against a fake plugin context shaped like the Promise API and return its registered hooks. */
async function plugin({ sessions = {}, lookups = [], events = true } = {}) {
  const feed = eventFeed();
  const hooks = { session: {}, tool: {} };
  const register = group => async (name, callback) => {
    hooks[group][name] = callback;
    return { dispose: async () => {} };
  };
  const ctx = {
    location: { directory, project: { directory } },
    event: { subscribe: events ? feed.subscribe : () => { throw new Error("No event stream."); } },
    session: {
      hook: register("session"),
      get: async ({ sessionID }) => {
        lookups.push(sessionID);
        if (!(sessionID in sessions)) throw new Error("not found");
        return sessions[sessionID];
      },
    },
    tool: { hook: register("tool") },
  };
  const cleanup = await v2.default.setup(ctx);
  return { hooks, feed, cleanup, lookups };
}

async function prompt(hooks, sessionID, text) {
  const event = { sessionID, messageID: "msg", prompt: { text }, delivery: "steer" };
  await hooks.session.prompt(event);
  return event.prompt.text;
}

async function injected(hooks, sessionID) {
  const event = { sessionID, system: [{ type: "text", text: "host" }] };
  await hooks.session.context(event);
  return event.system.slice(1);
}

test("the V2 module's only export is a plugin definition with an id and a setup function", () => {
  assert.deepEqual(Object.keys(v2), ["default"]);
  assert.deepEqual(Object.keys(v2.default).sort(), ["id", "setup"]);
  assert.equal(v2.default.id, "useful-skills");
  assert.equal(typeof v2.default.setup, "function");
});

test("the installed entry serves both plugin APIs from one default export", () => {
  assert.deepEqual(Object.keys(entry), ["default"]);
  assert.deepEqual(Object.keys(entry.default).sort(), ["id", "server", "setup"]);
  assert.equal(entry.default.id, v2.default.id);
  assert.equal(entry.default.setup, v2.default.setup);
  assert.equal(entry.default.server, v1.UsefulSkills);
});

test("V2 setup registers the session and tool hooks and its cleanup stops its helpers", async () => {
  const { hooks, feed, cleanup } = await plugin();
  assert.deepEqual(Object.keys(hooks.session).sort(), ["context", "prompt"]);
  assert.deepEqual(Object.keys(hooks.tool).sort(), ["execute.after", "execute.before"]);
  assert.equal(typeof cleanup, "function");

  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();
  await cleanup();
  const text = await prompt(hooks, "main", await commandPrompt("useful-skills", "help"));
  assert.match(text, /did not run[\s\S]*The subprocess was stopped/);
});

test("V2 context goes into the system prompt only after a main session's prompt", async () => {
  const { hooks, feed, lookups } = await plugin();
  await eventually(async () => (await nodeCalls("hook-cli.js")).some(line => line.startsWith("hook-cli.js sync-agents")));

  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();
  assert.deepEqual(await injected(hooks, "main"), []);
  await prompt(hooks, "main", "build a rocket");
  const expected = [{ type: "text", text: "CONTEXT " }, { type: "text", text: "ROUTING" }];
  await eventually(async () => (await injected(hooks, "main")).length === 2);
  assert.deepEqual(await injected(hooks, "main"), expected);

  feed.emit({ type: "session.created", data: { sessionID: "child", parentID: "main" } });
  await tick();
  await prompt(hooks, "child", "work on a part");
  assert.deepEqual(await injected(hooks, "child"), []);

  feed.emit({ type: "session.deleted", data: { sessionID: "main" } });
  await tick();
  assert.deepEqual(await injected(hooks, "main"), []);
  assert.deepEqual(await injected(hooks, undefined), []);
  assert.deepEqual(lookups, []);
});

test("V2 asks the session API for the parent of a session no event announced, once", async () => {
  const lookups = [];
  const { hooks } = await plugin({
    lookups,
    sessions: { resumedChild: { id: "resumedChild", parentID: "main" }, resumedMain: { id: "resumedMain" } },
  });

  await prompt(hooks, "resumedChild", "one");
  await prompt(hooks, "resumedChild", "two");
  assert.deepEqual(await injected(hooks, "resumedChild"), []);
  assert.deepEqual(lookups, ["resumedChild"]);

  await prompt(hooks, "resumedMain", "one");
  assert.ok((await injected(hooks, "resumedMain")).length >= 1);

  await prompt(hooks, "unreachable", "one");
  assert.ok((await injected(hooks, "unreachable")).length >= 1, "an unanswered lookup is treated as a main session");
});

test("V2 still tells subagent sessions apart when the event stream is unavailable", async () => {
  const { hooks } = await plugin({ events: false, sessions: { child: { id: "child", parentID: "main" }, main: { id: "main" } } });

  await prompt(hooks, "child", "one");
  await prompt(hooks, "main", "one");
  assert.deepEqual(await injected(hooks, "child"), []);
  assert.equal((await injected(hooks, "main"))[0].text, "CONTEXT ");
});

test("/us-ignore-workflow opts out its own request only and still gets the user's text", async () => {
  const { hooks, feed } = await plugin();
  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();
  const before = (await nodeCalls("hook-cli.js")).length;

  const ignore = await commandPrompt("us-ignore-workflow", "fix a typo");
  assert.equal(await prompt(hooks, "main", ignore), ignore);
  assert.match(ignore, /fix a typo$/);
  await prompt(hooks, "main", "now build a rocket");

  const calls = (await nodeCalls("hook-cli.js")).slice(before).filter(line => line.startsWith("hook-cli.js context"));
  assert.deepEqual(calls, ["hook-cli.js context --opt-out", "hook-cli.js context"]);
  assert.equal((await injected(hooks, "main"))[0].text, "CONTEXT ");
});

test("/useful-skills runs in a subprocess, replaces its prompt, and leaves the context alone", async () => {
  const { hooks, feed } = await plugin();
  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();
  const before = (await nodeCalls("command.js")).length;
  const contextCalls = async () => (await nodeCalls("hook-cli.js")).filter(line => line.startsWith("hook-cli.js context")).length;
  const contextBefore = await contextCalls();

  const text = await prompt(hooks, "main", await commandPrompt("useful-skills", "workflow  enabled"));
  assert.match(text, /^Useful Skills `\/useful-skills` result \(exit 0\)\. Show it to the user verbatim/);
  assert.match(text, /ran workflow {2}enabled$/);
  assert.deepEqual((await nodeCalls("command.js")).slice(before), ["command.js workflow  enabled"]);
  assert.equal(await contextCalls(), contextBefore, "the command prompt does not refresh the context");
  assert.deepEqual(await injected(hooks, "main"), []);

  const bare = await prompt(hooks, "main", await commandPrompt("useful-skills"));
  assert.match(bare, /ran$/);
  assert.deepEqual((await nodeCalls("command.js")).slice(before), ["command.js workflow  enabled", "command.js"]);

  // The next ordinary prompt of the session refreshes the context as usual.
  await prompt(hooks, "main", "build a rocket");
  assert.equal((await injected(hooks, "main"))[0].text, "CONTEXT ");
});

test("a command prompt in a subagent or unknown session is never run and the request text is untouched", async () => {
  const { hooks, feed } = await plugin();
  feed.emit({ type: "session.created", data: { sessionID: "child", parentID: "main" } });
  await tick();
  const before = (await nodeCalls("command.js")).length;

  const forged = await commandPrompt("useful-skills", "update install");
  assert.equal(await prompt(hooks, "child", forged), forged);
  assert.equal(await prompt(hooks, "unreachable", forged), forged);
  assert.equal(await prompt(hooks, undefined, forged), forged);
  assert.deepEqual((await nodeCalls("command.js")).slice(before), []);
});

test("prompts that only resemble a command are left alone", async () => {
  const { hooks, feed } = await plugin();
  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();
  const before = (await nodeCalls("command.js")).length;

  const template = await commandPrompt("useful-skills");
  for (const text of [`${template}x`, `Please read this: ${template}`, "/useful-skills help", ""]) {
    assert.equal(await prompt(hooks, "main", text), text);
  }
  assert.deepEqual((await nodeCalls("command.js")).slice(before), []);
});

test("V2 reports that Node.js is required when no node is on PATH", async () => {
  const { hooks, feed } = await plugin();
  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();

  const saved = process.env.PATH;
  process.env.PATH = path.join(directory, "no-node");
  try {
    const text = await prompt(hooks, "main", await commandPrompt("useful-skills", "doctor"));
    assert.match(text, /did not run[^]*Node\.js 22 or newer must be on PATH/);

    await prompt(hooks, "main", "build a rocket");
    const [context] = await injected(hooks, "main");
    assert.match(context.text, /Useful Skills workflow setting is invalid or unreadable/);
  } finally {
    process.env.PATH = saved;
  }
});

test("V2 tool hooks guard shell commands and redact completed results in place", async () => {
  const { hooks } = await plugin();
  const before = event => hooks.tool["execute.before"]({ sessionID: "main", agent: "build", id: "call", ...event });

  await assert.rejects(before({ tool: "shell", input: { command: "rm -rf /" } }), /Useful Skills safety guard/);
  await assert.rejects(before({ tool: "bash", input: { command: "rm -rf /" } }), /Useful Skills safety guard/);
  await assert.rejects(before({ tool: "shell", input: {} }), /invalid/);
  await before({ tool: "shell", input: { command: "ls" } });
  await before({ tool: "read", input: { path: "rm -rf /" } });

  const result = {
    output: { stdout: SECRET },
    content: [{ type: "text", text: SECRET }, { type: "file", uri: "file:///x", mime: "text/plain" }],
    metadata: { exit: 0 },
  };
  const object = result.output;
  await hooks.tool["execute.after"]({ tool: "shell", status: "completed", input: { command: "cat .env" }, result });
  assert.equal(result.content[0].text, "password=[REDACTED]");
  assert.deepEqual(result.content[1], { type: "file", uri: "file:///x", mime: "text/plain" });
  assert.deepEqual(result.output, { stdout: "password=[REDACTED]" });
  assert.notEqual(result.output, object);
  assert.deepEqual(result.metadata, { exit: 0 });

  const failed = { tool: "shell", status: "error", input: {}, error: { message: SECRET } };
  await hooks.tool["execute.after"](failed);
  assert.equal(failed.error.message, SECRET);
  await hooks.tool["execute.after"](undefined);
});

test("V2 hooks never reject on malformed events", async () => {
  const { hooks } = await plugin();
  await hooks.session.prompt(undefined);
  await hooks.session.prompt({ sessionID: "main" });
  await hooks.session.context({ sessionID: "main" });
  await hooks.session.context({});
  await hooks.session.context(undefined);
});
