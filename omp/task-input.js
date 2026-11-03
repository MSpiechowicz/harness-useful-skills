// OMP's `task` tool checks several optional fields by presence: a per-call `model` is refused while
// `task.perCallModel` is off (its default), `sourceSession` only for the `seance` agent, `task` and
// `taskFile` only one at a time. It counts an empty value as present, so `"model": []` or
// `"sourceSession": ""` makes the whole call fail. Models that fill every schema field send exactly
// that, although the skills tell them to leave unused fields out. An empty optional field never
// means anything, so it is dropped before OMP sees the call: at the top level and in every entry of
// `tasks`. The fields that make a call (`agent`, `name`, `task`, `context`, and the required `solutionSpace`) are never dropped, so a
// real mistake still gets OMP's own error, and a field with a value is always left alone.

/** The fields a call is made of: kept even when empty. */
const CORE_FIELDS = new Set(["agent", "name", "task", "context", "tasks", "solutionSpace"]);

/** True for a value that says nothing: null, a blank string, an empty list or an empty object. */
function isEmpty(value) {
  if (value === null) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim() === "";
  }

  if (Array.isArray(value)) {
    return value.every((entry) => entry === null || (typeof entry === "string" && entry.trim() === ""));
  }

  return typeof value === "object" && Object.keys(value).length === 0;
}

/** `object` without its empty optional fields, and whether anything was dropped. */
function withoutEmptyFields(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    return { value: object, changed: false };
  }

  const kept = Object.entries(object).filter(([key, value]) => CORE_FIELDS.has(key) || !isEmpty(value));

  if (kept.length === Object.keys(object).length) {
    return { value: object, changed: false };
  }

  return { value: Object.fromEntries(kept), changed: true };
}

/**
 * The input a `task` call should run with when it carries empty optional fields (top level or in
 * any entry of `tasks`), else undefined so the call runs unchanged.
 */
export function taskInputWithoutEmptyFields(input) {
  const top = withoutEmptyFields(input);
  let changed = top.changed;
  let next = top.value;

  if (next && typeof next === "object" && Array.isArray(next.tasks)) {
    const tasks = next.tasks.map((task) => {
      const entry = withoutEmptyFields(task);
      changed ||= entry.changed;
      return entry.value;
    });

    if (changed) {
      next = { ...next, tasks };
    }
  }

  return changed ? next : undefined;
}
