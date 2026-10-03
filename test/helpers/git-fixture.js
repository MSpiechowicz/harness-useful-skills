import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function git(directory, ...args) {
  // Do not let user repository overrides or configuration affect synthetic fixtures.
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    XDG_CONFIG_HOME: path.join(directory, ".git-fixture-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  return execute("git", [
    "-C", directory,
    "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgsign=false",
    "-c", "init.templateDir=",
    "-c", "user.name=Workflow Test",
    "-c", "user.email=workflow@example.invalid",
    ...args,
  ], { env });
}
