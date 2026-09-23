import { spawn } from "node:child_process";

// This process inherits the coordinator's advisory lock on fd 3. It is launched
// in its own process group and continues supervising if the coordinator dies.
const [duration, file, ...args] = process.argv.slice(2);
const timeoutMs = Number(duration);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !file?.startsWith("/")) {
  console.error("Invalid setup watchdog invocation.");
  process.exit(2);
}

let stopping = false;
let escalation;
const child = spawn(file, args, {
  cwd: process.cwd(),
  env: process.env,
  detached: false,
  shell: false,
  stdio: ["ignore", "inherit", "inherit", 3],
});

function terminate() {
  if (stopping) return;
  stopping = true;
  // Child and watchdog share the group. The coordinator's cancellation also
  // signals this group, including any grandchildren that retained fd 3.
  try { process.kill(-process.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  escalation = setTimeout(() => {
    try { process.kill(-process.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, 1_000);
}

process.on("SIGTERM", terminate);
const deadline = setTimeout(terminate, timeoutMs);
child.once("error", (error) => {
  clearTimeout(deadline);
  clearTimeout(escalation);
  console.error(`Cannot start setup writer: ${error.message}`);
  process.exitCode = 127;
});
child.once("close", (code, signal) => {
  clearTimeout(deadline);
  clearTimeout(escalation);
  if (signal) process.exitCode = 128 + (signal === "SIGTERM" ? 15 : 9);
  else process.exitCode = code ?? 1;
});
