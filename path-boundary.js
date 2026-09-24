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
