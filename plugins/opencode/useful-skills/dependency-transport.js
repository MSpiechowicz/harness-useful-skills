import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";

import { isApprovedUrl } from "./dependency-policy.js";

const DOWNLOAD_MAX_BYTES = 128 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Dependency setup was cancelled.");
  }
}

export async function download(url, digest, target, signal, fetcher) {
  let current = new URL(url);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    throwIfAborted(signal);
    const response = await fetcher(current.href, { redirect: "manual", signal });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) {
        throw new Error("Dependency download exceeded the approved redirect limit.");
      }

      current = new URL(location, current);
      if (!isApprovedUrl(current)) {
        throw new Error("Dependency download redirected to an unapproved location.");
      }

      await response.body?.cancel();
      continue;
    }

    if (!response.ok || !response.body) {
      throw new Error(`Dependency download failed (HTTP ${response.status}).`);
    }

    const output = await open(target, "wx", 0o600);
    let completed = false;

    try {
      const digestState = createHash("sha256");
      const reader = response.body.getReader();
      let total = 0;

      for (;;) {
        throwIfAborted(signal);
        const next = await reader.read();
        if (next.done) {
          break;
        }

        total += next.value.length;
        if (total > DOWNLOAD_MAX_BYTES) {
          throw new Error("Dependency download exceeded the size limit.");
        }

        digestState.update(next.value);
        for (let offset = 0; offset < next.value.length;) {
          const written = await output.write(next.value, offset);
          offset += written.bytesWritten;
        }
      }

      if (digestState.digest("hex") !== digest) {
        throw new Error("Dependency download checksum did not match committed metadata.");
      }

      completed = true;
      return;
    } finally {
      await output.close();
      if (!completed) {
        await unlink(target).catch(() => {});
      }
    }
  }
}
