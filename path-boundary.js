import path from "node:path";

/** Include the parent itself, but never a sibling, ancestor or escaped path. */
export function isPathWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (
    !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative)
  );
}

/** True when `value` is a plain repository-relative POSIX path: no empty, '.', '..', or '.git' (any case) segment, no backslash or NUL, already normalized. */
export function isPlainRelativePath(value) {
  if (value.includes("\\") || value.includes("\0")) return false;
  if (value.split("/").some(segment => segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git")) return false;
  return path.posix.normalize(value) === value;
}
