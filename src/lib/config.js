/**
 * Everything the bridge reads from the environment, plus every limit it
 * enforces. Nothing here touches the network or the filesystem beyond reading
 * the package manifest, so importing this module is safe from any other file.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";

export const SERVER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** One version number for the whole bridge, taken from the package manifest. */
export const VERSION = JSON.parse(
  readFileSync(path.join(SERVER_ROOT, "package.json"), "utf8"),
).version;

export function parseInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

/** Per-platform place for logs and other state the user does not edit. */
export function stateDir() {
  if (IS_WINDOWS) {
    const base =
      process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
    return path.join(base, "notion-cowork-bridge");
  }
  if (IS_MACOS) {
    return path.join(homedir(), "Library", "Logs", "notion-cowork-bridge");
  }
  const base =
    process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(base, "notion-cowork-bridge");
}

export function resolveShell() {
  const override = process.env.MCP_SHELL;
  if (override) return override;
  if (IS_WINDOWS) return "powershell.exe";
  if (process.env.SHELL?.startsWith("/")) return process.env.SHELL;
  return IS_MACOS ? "/bin/zsh" : "/bin/bash";
}

/** Each shell family wants the command handed over differently. */
export function shellArguments(shell, command) {
  const name = path.basename(shell).toLowerCase().replace(/\.exe$/, "");
  if (name === "cmd") return ["/d", "/s", "/c", command];
  if (name === "powershell" || name === "pwsh") {
    return ["-NoProfile", "-NonInteractive", "-Command", command];
  }
  return ["-lc", command];
}

// Names the start scripts and the installers use. A child process does not
// need any of them, and several of them are a signposted route back to the
// bearer token: TOKEN_FILE says where it is on disk, KEYCHAIN_* says how to
// ask the OS for it. Stealing the token buys re-entry that survives noticing
// the intrusion and cleaning the machine, so the whole family goes.
const STRIPPED_ENVIRONMENT_NAMES = new Set([
  "TOKEN_FILE",
  "KEYCHAIN_ACCOUNT",
  "KEYCHAIN_SERVICE",
  "RUNTIME_ROOT",
  "NOTION_COWORK_CONFIG",
]);
const STRIPPED_ENVIRONMENT_PREFIXES = ["MCP_", "NGROK_"];

/** The environment a terminal command inherits: the user's, minus the token trail. */
export function commandEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    const upper = name.toUpperCase();
    if (
      STRIPPED_ENVIRONMENT_NAMES.has(upper) ||
      STRIPPED_ENVIRONMENT_PREFIXES.some((prefix) => upper.startsWith(prefix))
    ) {
      delete environment[name];
    }
  }
  return environment;
}

/** Every bridge-spawned child gets the same scrubbed environment. */
export const childEnvironment = commandEnvironment;

export const DEFAULT_WORKSPACE_ROOT = path.join(
  homedir(),
  "Desktop",
  "notion-workspace",
);
export const WORKSPACE_ROOT = path.resolve(
  process.env.MCP_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
);
export const CONTROL_ROOT = SERVER_ROOT;
export const COMMAND_SHELL = resolveShell();
export const STATE_DIR = stateDir();
export const AUDIT_PATH =
  process.env.MCP_AUDIT_LOG || path.join(STATE_DIR, "audit.jsonl");

export const HOST = "127.0.0.1";
export const PORT = parseInteger(process.env.MCP_PORT, 3210, 1, 65535);
export const ALLOWED_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  ...String(process.env.MCP_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
]);
export const PUBLIC_HOST =
  [...ALLOWED_HOSTS].find(
    (value) => value !== "127.0.0.1" && value !== "localhost" && value !== "::1",
  ) || "";
export const PUBLIC_ORIGIN = PUBLIC_HOST ? `https://${PUBLIC_HOST}` : "";

export const MAX_READ_BYTES = 256 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_LIST_ENTRIES = 1_000;
export const MAX_DIFF_BYTES = 256 * 1024;
export const MAX_SEARCH_PATTERN_BYTES = 1_000;
export const SEARCH_TIMEOUT_MS = 10_000;

export const MAX_BACKGROUND_PROCESSES = parseInteger(
  process.env.MCP_MAX_BACKGROUND_PROCESSES,
  8,
  1,
  32,
);
export const BACKGROUND_LOG_LIMIT_BYTES = parseInteger(
  process.env.MCP_BACKGROUND_LOG_LIMIT_BYTES,
  50 * 1024 * 1024,
  1024 * 1024,
  1024 * 1024 * 1024,
);
export const BACKGROUND_TOTAL_LOG_LIMIT_BYTES = parseInteger(
  process.env.MCP_BACKGROUND_TOTAL_LOG_LIMIT_BYTES,
  200 * 1024 * 1024,
  BACKGROUND_LOG_LIMIT_BYTES,
  4 * 1024 * 1024 * 1024,
);
export const BACKGROUND_RETENTION_HOURS = parseInteger(
  process.env.MCP_BACKGROUND_RETENTION_HOURS,
  24,
  1,
  24 * 30,
);
export const MAX_PREVIEWS = parseInteger(process.env.MCP_MAX_PREVIEWS, 1, 1, 2);
export const PREVIEW_TTL_SECONDS = parseInteger(
  process.env.MCP_PREVIEW_TTL_SECONDS,
  3600,
  60,
  24 * 3600,
);
export const NGROK_API_URL = process.env.MCP_NGROK_API_URL || "http://127.0.0.1:4040";
function parseOptionalHttpsOrigin(value, name) {
  if (value === undefined || value === "") return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS origin.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin without credentials, a path, query, or fragment.`);
  }
  return url.origin;
}

// A distinct preview endpoint remains supported when one is available. Without
// one, preview.js safely multiplexes one authenticated preview on PUBLIC_ORIGIN
// while permanently reserving /mcp and /health for the bridge.
export const NGROK_PREVIEW_URL = parseOptionalHttpsOrigin(
  process.env.MCP_NGROK_PREVIEW_URL,
  "MCP_NGROK_PREVIEW_URL",
);
export const MAX_BROWSER_SESSIONS = parseInteger(
  process.env.MCP_MAX_BROWSER_SESSIONS,
  1,
  1,
  2,
);
export const BROWSER_IDLE_SECONDS = parseInteger(
  process.env.MCP_BROWSER_IDLE_SECONDS,
  600,
  60,
  3600,
);
export const BROWSER_TTL_SECONDS = parseInteger(
  process.env.MCP_BROWSER_TTL_SECONDS,
  1800,
  60,
  24 * 3600,
);

// A one MiB file becomes a larger JSON string once escaped, so the request
// body ceiling has to sit comfortably above MAX_WRITE_BYTES or the advertised
// write limit is unreachable again.
export const JSON_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
export const AUDIT_KEEP_FILES = 5;

// Slowloris protection through the tunnel. Only the receiving side of a
// request is bounded; a tool call may still take as long as its own timeout.
export const HEADERS_TIMEOUT_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const KEEP_ALIVE_TIMEOUT_MS = 15_000;

export const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
if (AUTH_TOKEN.length < 32) {
  throw new Error("MCP_AUTH_TOKEN must be at least 32 characters.");
}
