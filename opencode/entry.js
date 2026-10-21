/**
 * The plugin definition OpenCode loads from `<config>/plugins/useful-skills.js`, whatever its plugin API. Each
 * loader reads the default export and ignores the fields it does not know:
 * - OpenCode 1.x detects a default export with an `id` and calls its `server`.
 * - OpenCode 2.x requires a default export with an `id` and a `setup`.
 * A V1-only module fails on 2.x and a V2-only one on 1.x, so the file carries both.
 */
import { UsefulSkills } from "./v1.js";
import v2 from "./v2.js";

export default { id: v2.id, server: UsefulSkills, setup: v2.setup };
