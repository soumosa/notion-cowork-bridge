/**
 * `MCP_AUTH_TOKEN` shorter than 32 characters must stop the server from
 * starting at all, not just from authenticating requests - the README's
 * troubleshooting section leans on that guarantee. This spawns the real
 * server entry point as a child process (rather than importing config.js
 * in-process) so the exit code and stderr are exactly what a user running
 * the bridge from a terminal or a service manager would see.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The token check happens at import time, before the server ever tries to
// bind a port, so these never actually listen on anything - no port needs
// to be free for them to run.
function tryBoot(token, overrides = {}) {
  return spawnSync(process.execPath, ["src/server.js"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, MCP_AUTH_TOKEN: token, ...overrides },
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("refuses to start with no MCP_AUTH_TOKEN at all", () => {
  const env = { ...process.env };
  delete env.MCP_AUTH_TOKEN;
  const result = spawnSync(process.execPath, ["src/server.js"], {
    cwd: PROJECT_ROOT,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MCP_AUTH_TOKEN must be at least 32 characters/);
});

test("refuses to start with a token under 32 characters", () => {
  const result = tryBoot("short-token");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MCP_AUTH_TOKEN must be at least 32 characters/);
});

test("refuses to start with a token exactly one character short of 32", () => {
  const result = tryBoot("a".repeat(31));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MCP_AUTH_TOKEN must be at least 32 characters/);
});

test("refuses a preview endpoint that is not a plain HTTPS origin", () => {
  const result = tryBoot("a".repeat(32), {
    MCP_NGROK_PREVIEW_URL: "http://preview.example.test/has-a-path",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MCP_NGROK_PREVIEW_URL must be an HTTPS origin/);
});

test("starts with a token exactly 32 characters long", async () => {
  // A real boot, to confirm the 32-character boundary is inclusive and this
  // isn't just "every short token fails". Polls /health rather than sleeping
  // a fixed amount, and is killed the moment it answers.
  const port = 34_712;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, MCP_AUTH_TOKEN: "a".repeat(32), MCP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 80 && !healthy; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        healthy = response.ok;
      } catch {
        // Still starting.
      }
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, "server did not become healthy with a 32-character token");
  } finally {
    child.kill("SIGTERM");
  }
});
