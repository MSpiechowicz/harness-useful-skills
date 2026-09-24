import { stripVTControlCharacters } from "node:util";
import { redactText } from "./resources.js";

const RESOURCE_KINDS = ["skills", "commands", "agents", "rules"];
const MAX_DIAGNOSTIC_CHARS = 240;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const cleaned = redactText(stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim());
  return cleaned.length <= MAX_DIAGNOSTIC_CHARS ? cleaned : `${cleaned.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…`;
}

function inventory(label, value) {
  const counts = RESOURCE_KINDS.map(kind => Number.isSafeInteger(value?.[kind]) && value[kind] >= 0 ? value[kind] : "?");
  return `  ${label}: ${counts.map((count, index) => `${count} ${RESOURCE_KINDS[index]}`).join(", ")}`;
}

function nativeStatus(memory) {
  if (!record(memory)) {
    return "Unavailable — terminal cannot inspect the OMP profile.";
  }

  const native = memory.native;
  if (!record(native)) {
    return "Unavailable — no native-memory status was returned.";
  }

  const observation = record(native.observation) ? native.observation : undefined;
  const observedError = diagnostic(observation?.error);
  if (observedError) {
    return `Error — ${observedError}`;
  }

  if (observation?.backend === "off" || observation?.active === false) {
    return "Disabled";
  }

  if (native.ok === true || observation?.active === true) {
    return "Ready";
  }

  const error = diagnostic(native.error);
  if (error && !/backend is unavailable/i.test(error)) {
    return `Error — ${error}`;
  }

  const message = diagnostic(observation?.message);
  if (message) {
    return `Error — ${message}`;
  }

  return "Unavailable";
}

function graphStatus(memory) {
  if (!record(memory)) {
    return "Unavailable";
  }

  const graph = memory.graph;
  if (!record(graph)) {
    return "Unavailable — no graph status was returned.";
  }

  const error = diagnostic(graph.error);
  if (error) {
    return `Error — ${error}`;
  }

  if (!graph.available) {
    return "Not built";
  }

  const nodes = graph.snapshot?.nodes;
  const edges = graph.snapshot?.edges;
  if (Number.isSafeInteger(nodes) && nodes >= 0 && Number.isSafeInteger(edges) && edges >= 0) {
    return `Ready — ${nodes} nodes, ${edges} edges`;
  }

  return "Ready";
}

function dependencyStatus(memory) {
  if (!record(memory)) {
    return "Unavailable";
  }

  const dependency = memory.graph?.dependency;
  if (!record(dependency)) {
    return "Unavailable — no dependency status was returned.";
  }

  const reason = diagnostic(dependency.reason);
  if (dependency.ready === true || dependency.state === "ready") {
    return "Ready";
  }

  if (dependency.state === "missing") {
    return "Not installed";
  }

  if (dependency.state === "partial") {
    return "Incomplete";
  }

  if (dependency.state === "unsupported") {
    return reason ? `Unsupported — ${reason}` : "Unsupported";
  }

  if (dependency.state === "unknown") {
    return reason ? `Error — ${reason}` : "Unavailable";
  }

  return reason ? `Error — ${reason}` : "Unavailable";
}

/** Format passive resource and profile status without exposing implementation paths or raw observations. */
export function formatDoctor({ core, library, safety, memory } = {}) {
  return [
    "Useful Skills doctor",
    "Resources",
    inventory("Core", core),
    inventory("Reference library", library),
    `Safety: ${safety === true ? "Enabled" : "Disabled"}`,
    "Memory",
    `  Native: ${nativeStatus(memory)}`,
    `  Graph: ${graphStatus(memory)}`,
    `  Dependencies: ${dependencyStatus(memory)}`,
    ...(memory?.error && !memory.native && !memory.graph ? [`  Status: Error — ${diagnostic(memory.error)}`] : []),
    ...(!record(memory) ? ["Run /useful-skills doctor in OMP for current profile memory status."] : []),
    "Read-only: no setup, installation, or build.",
  ].join("\n");
}
