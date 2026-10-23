import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when Node runs the module at `importMetaUrl` as the entry script, including through a symlinked
 * install path. Call it with the caller's own `import.meta.url`.
 */
export function invokedDirectly(importMetaUrl) {
  if (!process.argv[1]) {
    return false;
  }

  const self = fileURLToPath(importMetaUrl);
  try {
    return realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return process.argv[1] === self;
  }
}
