import { Buffer } from "node:buffer";

const MAX_ERROR_BYTES = 8 * 1024;

export function truncateUtf8(value, maximum) {
  const bytes = Buffer.from(String(value), "utf8");

  if (bytes.length <= maximum) {
    return { value: bytes.toString("utf8"), truncated: false };
  }

  return {
    value: new TextDecoder("utf-8").decode(bytes.subarray(0, maximum), { stream: true }),
    truncated: true,
  };
}

export function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return truncateUtf8(message, MAX_ERROR_BYTES).value;
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
