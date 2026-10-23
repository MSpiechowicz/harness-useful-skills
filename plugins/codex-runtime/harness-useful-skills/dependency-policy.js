import path from "node:path";

const APPROVED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

export function platformKey(platform, arch) {
  if (platform === "linux" && arch === "x64") {
    return "linux-x64";
  }

  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }

  return undefined;
}

export function isApprovedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (!url.port || url.port === "443")
      && APPROVED_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function safeArchivePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) {
    return false;
  }

  const normalized = path.posix.normalize(value.replace(/\/$/, ""));
  return !path.posix.isAbsolute(value)
    && normalized !== "."
    && normalized !== ".."
    && !normalized.startsWith("../");
}

function safeFileName(value) {
  return typeof value === "string" && safeArchivePath(value) && !value.includes("/");
}

export function validateManifest(value, platform, arch) {
  const key = platformKey(platform, arch);
  if (!key) {
    throw new Error(`Managed Graphify setup is unsupported on ${platform}/${arch}.`);
  }

  const uv = value?.uv?.platforms?.[key];
  const python = value?.python?.platforms?.[key];
  const valid = value?.schemaVersion === 1
    && value?.uv?.version === "0.12.17"
    && value?.python?.version === "3.12.14"
    && value?.python?.build === "20260901"
    && value?.graphify?.package === "graphifyy"
    && value?.graphify?.version === "0.9.65"
    && uv?.archive === "tar.gz"
    && safeArchivePath(uv?.executable)
    && isApprovedUrl(uv?.url)
    && isDigest(uv?.sha256)
    && isApprovedUrl(python?.url)
    && isApprovedUrl(python?.mirror)
    && safeFileName(python?.archive)
    && isDigest(python?.sha256)
    && value.graphify.sha256 === "e4c1ef6967d5a090b315f9b18b5255d9a0dead0c24a7620e7dffeaa443395535";

  if (!valid) {
    throw new Error("Committed dependency metadata is invalid.");
  }

  return Object.freeze({
    ...value,
    key,
    uv: Object.freeze({ ...uv }),
    python: Object.freeze({ ...python, version: value.python.version, build: value.python.build }),
  });
}

export function archiveEntries(listing, platform) {
  const entries = [];

  for (const line of listing.split("\n")) {
    if (!line) {
      continue;
    }

    const match = platform === "darwin"
      ? line.match(/^([\-dlh])[\-rwxstST]{9}[+@.]?\s+\d+\s+\S+\s+\S+\s+\d+\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})\s+(.+)$/)
      : line.match(/^([\-dlh])\S*\s+.*?\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);

    if (!match) {
      throw new Error("Dependency archive has an unsupported entry format.");
    }

    const [, type, rest] = match;
    const marker = type === "l" ? " -> " : type === "h" ? " link to " : undefined;
    const [name, linkTarget] = marker ? rest.split(marker, 2) : [rest];

    if (!safeArchivePath(name)) {
      throw new Error("Dependency archive contains an unsafe path.");
    }

    if (marker) {
      if (!linkTarget || linkTarget.includes("\0") || path.posix.isAbsolute(linkTarget)) {
        throw new Error("Dependency archive contains an unsafe link target.");
      }

      const destination = path.posix.normalize(path.posix.join(path.posix.dirname(name), linkTarget));
      if (destination === ".." || destination.startsWith("../")) {
        throw new Error("Dependency archive contains an unsafe link target.");
      }
    }

    entries.push({ type, name });
  }

  return entries;
}
