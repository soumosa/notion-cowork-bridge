#!/usr/bin/env node
/**
 * Zero-install trial path. No ngrok, no launchd/systemd/Scheduled Task
 * registration, nothing written outside this checkout. Generates a
 * throwaway token, starts the server bound to 127.0.0.1, and prints a
 * curl you can paste straight into a terminal.
 *
 * Loads .env with --env-file when one exists, for anyone who wants to
 * override the port or workspace without passing flags. The token is
 * always freshly generated here, on purpose: this is a trial, not a place
 * to echo a real secret into your scrollback.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(REPO_ROOT, ".env");

function readEnvValue(key) {
  if (!existsSync(ENV_FILE)) return undefined;
  const line = readFileSync(ENV_FILE, "utf8")
    .split("\n")
    .find((entry) => entry.trim().startsWith(`${key}=`));
  return line ? line.slice(line.indexOf("=") + 1).trim() : undefined;
}

const token = randomBytes(32).toString("hex");
const port = process.env.MCP_PORT || readEnvValue("MCP_PORT") || "3210";

const nodeArgs = [];
if (existsSync(ENV_FILE)) {
  nodeArgs.push(`--env-file=${ENV_FILE}`);
}
nodeArgs.push(path.join(REPO_ROOT, "src", "server.js"));

const child = spawn(process.execPath, nodeArgs, {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    MCP_AUTH_TOKEN: token,
    MCP_PORT: port,
  },
});

console.log("");
console.log("Notion Cowork Bridge -- dev trial mode");
console.log("No ngrok tunnel, no service registered. Listening on 127.0.0.1 only.");
console.log("");
console.log(`Local URL:     http://127.0.0.1:${port}/mcp`);
console.log(`Health check:  http://127.0.0.1:${port}/health`);
console.log(`Token (this run only): ${token}`);
console.log("");
console.log("Try it once the server is up:");
console.log(`  curl -sS http://127.0.0.1:${port}/mcp \\`);
console.log(`    -H "Authorization: Bearer ${token}" \\`);
console.log('    -H "Content-Type: application/json" \\');
console.log('    -H "Accept: application/json, text/event-stream" \\');
console.log(
  `    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0.0"}}}'`,
);
console.log("");
console.log("Press Ctrl+C to stop.");
console.log("");

function forward(signal) {
  child.kill(signal);
}
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
