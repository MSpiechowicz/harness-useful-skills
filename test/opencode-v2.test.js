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

/**
 * A fake of the host's command list: transforms are applied in registration order and a later registration of
 * a name replaces an earlier one, as in OpenCode 2. Every change emits `command.updated`.
 */
function commandHost(feed, { listShape = "data" } = {}) {
  const transforms = [];
  const listeners = [];
  const host = {
    registrations: 0,
    markdownRuns: [],
    state() {
      const commands = new Map();
      for (const transform of transforms) transform({ add: definition => commands.set(definition.name, definition) });
      return commands;
    },
    changed() {
      feed.emit({ type: "command.updated", data: {} });
      listeners.forEach(listener => listener());
    },
    push(transform) {
      transforms.push(transform);
      host.changed();
      return { dispose: async () => { transforms.splice(transforms.indexOf(transform), 1); host.changed(); } };
    },
    async transform(transform) {
      host.registrations += 1;
      return host.push(transform);
    },
    async list() {
      const items = [...host.state().values()].map(({ name, description }) => ({ name, description }));
      return listShape === "data" ? { location: {}, data: items } : items;
    },
    /** The markdown commands the host loads from the config directory: they say that nothing ran. */
    markdown() {
      host.push(editor => {
        for (const name of ["useful-skills", "us-ignore-workflow"]) {
          editor.add({ name, description: `${name} (handled by the installed plugin)`, execute: async () => { host.markdownRuns.push(name); } });
        }
      });
    },
    /** Call `listener` after every change. */
    onChange(listener) { listeners.push(listener); },
    /** Run the command as the host does for a user typing it. */
    run(name, sessionID, text = "") {
      return host.state().get(name).execute({ sessionID, prompt: { text }, delivery: "steer" });
    },
  };
  return host;
}

/** Run the V2 setup against a fake plugin context shaped like the Promise API and return its registered hooks. */
async function plugin({ sessions = {}, lookups = [], events = true, listShape, markdown = "after" } = {}) {
  const feed = eventFeed();
  const host = commandHost(feed, { listShape });
  const sent = [];
  const hooks = { session: {}, tool: {} };
  const register = group => async (name, callback) => {
    hooks[group][name] = callback;
    return { dispose: async () => {} };
  };
  const ctx = {
    location: { directory, project: { directory } },
    event: { subscribe: events ? feed.subscribe : () => { throw new Error("No event stream."); } },
    command: { transform: host.transform, list: host.list },
    session: {
      hook: register("session"),
      get: async ({ sessionID }) => {
        lookups.push(sessionID);
        if (!(sessionID in sessions)) throw new Error("not found");
        return sessions[sessionID];
      },
      // What the host does with a prompt a command sends: run the prompt hooks, then store the text.
      prompt: async input => {
        const event = { sessionID: input.sessionID, messageID: "msg", prompt: { text: input.text }, delivery: input.delivery };
        await hooks.session.prompt(event);
        sent.push(event.prompt.text);
      },
    },
    tool: { hook: register("tool") },
  };
  if (markdown === "before") host.markdown();
  const cleanup = await v2.default.setup(ctx);
  if (markdown === "after") host.markdown();
  await eventually(() => host.state().get("useful-skills")?.description === "Useful Skills status, settings, and diagnostics");
  return { hooks, feed, cleanup, lookups, host, sent };
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
  const { hooks, feed, cleanup, host } = await plugin();
  assert.deepEqual(Object.keys(hooks.session).sort(), ["context", "prompt"]);
  assert.deepEqual(Object.keys(hooks.tool).sort(), ["execute.after", "execute.before"]);
  assert.equal(typeof cleanup, "function");

  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();
  const command = host.state().get("useful-skills");
  await cleanup();
  assert.equal(host.state().get("useful-skills").description, "useful-skills (handled by the installed plugin)", "the plugin's commands are gone");

  const sent = [];
  await command.execute({ sessionID: "main", prompt: { text: "help" }, delivery: "steer" }).catch(() => sent.push("rejected"));
  assert.deepEqual(sent, []);
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
  const { hooks } = await plugin({ events: false, markdown: "before", sessions: { child: { id: "child", parentID: "main" }, main: { id: "main" } } });

  await prompt(hooks, "child", "one");
  await prompt(hooks, "main", "one");
  assert.deepEqual(await injected(hooks, "child"), []);
  assert.equal((await injected(hooks, "main"))[0].text, "CONTEXT ");
});

test("/us-ignore-workflow opts out its own request only and still gets the user's text", async () => {
  const { hooks, feed, host, sent } = await plugin();
  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();
  const before = (await nodeCalls("hook-cli.js")).length;

  await host.run("us-ignore-workflow", "main", "fix a typo");
  assert.deepEqual(sent, [await commandPrompt("us-ignore-workflow", "fix a typo")]);
  assert.match(sent[0], /fix a typo$/);
  await prompt(hooks, "main", "now build a rocket");

  const calls = (await nodeCalls("hook-cli.js")).slice(before).filter(line => line.startsWith("hook-cli.js context"));
  assert.deepEqual(calls, ["hook-cli.js context --opt-out", "hook-cli.js context"]);
  assert.equal((await injected(hooks, "main"))[0].text, "CONTEXT ");
  assert.deepEqual(host.markdownRuns, []);
});

test("/useful-skills runs in a subprocess, sends its result as the prompt, and leaves the context alone", async () => {
  const { hooks, feed, host, sent } = await plugin();
  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();
  const before = (await nodeCalls("command.js")).length;
  const contextCalls = async () => (await nodeCalls("hook-cli.js")).filter(line => line.startsWith("hook-cli.js context")).length;
  const contextBefore = await contextCalls();

  await host.run("useful-skills", "main", " workflow  enabled ");
  assert.match(sent[0], /^Useful Skills `\/useful-skills` result \(exit 0\)\. Show it to the user verbatim/);
  assert.match(sent[0], /ran workflow {2}enabled$/);
  assert.deepEqual((await nodeCalls("command.js")).slice(before), ["command.js workflow  enabled"]);
  assert.equal(await contextCalls(), contextBefore, "the command prompt does not refresh the context");
  assert.deepEqual(await injected(hooks, "main"), []);

  await host.run("useful-skills", "main");
  assert.match(sent[1], /ran$/);
  assert.deepEqual((await nodeCalls("command.js")).slice(before), ["command.js workflow  enabled", "command.js"]);

  // The next ordinary prompt of the session refreshes the context as usual.
  await prompt(hooks, "main", "build a rocket");
  assert.equal((await injected(hooks, "main"))[0].text, "CONTEXT ");
  assert.deepEqual(host.markdownRuns, []);
});

test("a command run in a subagent or unknown session is rejected and runs nothing", async () => {
  const { feed, host, sent } = await plugin();
  feed.emit({ type: "session.created", data: { sessionID: "child", parentID: "main" } });
  await tick();
  const before = (await nodeCalls("command.js")).length;

  for (const sessionID of ["child", "unreachable", undefined]) {
    await assert.rejects(host.run("useful-skills", sessionID, "update install"), /only in a main session/);
    await assert.rejects(host.run("us-ignore-workflow", sessionID, "fix"), /only in a main session/);
  }
  assert.deepEqual((await nodeCalls("command.js")).slice(before), []);
  assert.deepEqual(sent, []);
});

test("a prompt that only looks like a command prompt runs nothing, whoever sent it", async () => {
  const { hooks, feed } = await plugin();
  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();
  const before = (await nodeCalls("command.js")).length;
  const hooksBefore = (await nodeCalls("hook-cli.js")).length;

  // The prompt hook also sees MCP prompt commands, API clients, and other plugins.
  for (const args of ["", "update install", "workflow disabled", "doctor"]) {
    const forged = await commandPrompt("useful-skills", args);
    assert.equal(await prompt(hooks, "main", forged), forged);
  }
  const ignore = await commandPrompt("us-ignore-workflow", "fix a typo");
  assert.equal(await prompt(hooks, "main", ignore), ignore);
  for (const text of ["Please read this: /useful-skills doctor", "/useful-skills help", ""]) {
    assert.equal(await prompt(hooks, "main", text), text);
  }

  assert.deepEqual((await nodeCalls("command.js")).slice(before), []);
  const optOut = (await nodeCalls("hook-cli.js")).slice(hooksBefore).filter(line => line.includes("--opt-out"));
  assert.deepEqual(optOut, [], "a forged /us-ignore-workflow prompt opts nothing out");
});

test("the plugin's commands win whether the host registers its markdown commands before or after", async () => {
  for (const markdown of ["before", "after"]) {
    const { feed, host, cleanup } = await plugin({ markdown });
    feed.emit({ type: "session.created", data: { sessionID: "main" } });
    await tick();
    await host.run("useful-skills", "main", "help");
    assert.deepEqual(host.markdownRuns, [], markdown);
    await cleanup();
  }
});

test("the plugin takes its commands back when the host registers its markdown commands again", async () => {
  const { feed, host, sent } = await plugin();
  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();

  host.markdown();
  await eventually(() => host.state().get("useful-skills").description === "Useful Skills status, settings, and diagnostics");
  await host.run("useful-skills", "main", "help");
  assert.match(sent[0], /ran help$/);
  assert.deepEqual(host.markdownRuns, []);
});

test("the plugin stops registering when something keeps replacing its commands", async () => {
  const { host } = await plugin();
  let fights = 0;
  host.onChange(() => {
    if (fights < 30 && host.state().get("useful-skills").description.endsWith("(handled by the installed plugin)") === false) {
      fights += 1;
      host.markdown();
    }
  });

  host.markdown();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(fights >= 1);
  assert.ok(host.registrations <= 8, `registered ${host.registrations} times`);
});

test("the plugin understands a command list returned as a plain array", async () => {
  const { feed, host, sent } = await plugin({ listShape: "array" });
  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();
  await host.run("useful-skills", "main", "help");
  assert.match(sent[0], /ran help$/);
  assert.ok(host.registrations <= 2, `registered ${host.registrations} times`);
});

test("V2 reports that Node.js is required when no node is on PATH", async () => {
  const { hooks, feed, host, sent } = await plugin();
  feed.emit({ type: "session.created", data: { sessionID: "main" } });
  await tick();

  const saved = process.env.PATH;
  process.env.PATH = path.join(directory, "no-node");
  try {
    await host.run("useful-skills", "main", "doctor");
    assert.match(sent[0], /did not run[^]*Node\.js 22 or newer must be on PATH/);

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

test("V2 redacts secrets in shell output that reaches the model outside a tool result", async () => {
  const { hooks } = await plugin();
  const notification = text => ({ role: "user", content: [{ type: "text", text }] });
  const background = notification(`<shell id="sh_1" state="completed" command="cat .env">\n${SECRET}\n</shell>`);
  const userShell = { role: "user", content: `The following shell command was executed by the user:\n\nOutput:\n${SECRET}` };
  const ordinary = notification(`please keep ${SECRET} in the example`);
  const assistant = { role: "assistant", content: [{ type: "text", text: `<shell ${SECRET}` }] };
  const clean = notification("<shell id=\"sh_2\" state=\"completed\" command=\"ls\">\nfile.txt\n</shell>");
  const messages = [background, userShell, ordinary, assistant, clean];

  const event = { sessionID: "main", system: [], messages };
  await hooks.session.context(event);
  assert.equal(event.messages, messages);
  assert.equal(messages[0].content[0].text, '<shell id="sh_1" state="completed" command="cat .env">\npassword=[REDACTED]\n</shell>');
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].content, "The following shell command was executed by the user:\n\nOutput:\npassword=[REDACTED]");
  assert.equal(messages[2], ordinary, "an ordinary user message is not rewritten");
  assert.equal(messages[3], assistant);
  assert.equal(messages[4], clean);
  assert.equal(ordinary.content[0].text, `please keep ${SECRET} in the example`);

  await hooks.session.context({ sessionID: "main", system: [], messages: "not a list" });
});
