import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOT =
  process.env.TEST_WORKSPACE_ROOT || path.resolve(PROJECT_ROOT, "../..");
const PORT = 33210;
const TOKEN = "local-test-token-0123456789-0123456789";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_DIRECTORY = path.join(
  WORKSPACE_ROOT,
  "work",
  "notion-cowork-bridge-security-test",
);

let child;
let networkProbe;
let networkProbePort;

function bunSkipReason() {
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  return probe.status === 0 ? false : "Bun is not installed on this machine.";
}

function parseToolText(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Tool returned no text content.");
  return result.isError ? text : JSON.parse(text);
}

async function callTool(name, args = {}) {
  const client = new Client({
    name: "notion-cowork-bridge-test",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    },
  );
  await client.connect(transport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become healthy.");
}

before(async () => {
  await mkdir(TEST_DIRECTORY, { recursive: true });
  networkProbe = createHttpServer((_request, response) => {
    response.end("network-ok");
  });
  await new Promise((resolve, reject) => {
    networkProbe.once("error", reject);
    networkProbe.listen(0, "127.0.0.1", resolve);
  });
  networkProbePort = networkProbe.address().port;
  child = spawn(process.execPath, ["src/server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MCP_AUTH_TOKEN: TOKEN,
      MCP_PORT: String(PORT),
      MCP_WORKSPACE_ROOT: WORKSPACE_ROOT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForHealth();
});

after(async () => {
  child?.kill("SIGTERM");
  await new Promise((resolve) => networkProbe?.close(resolve));
  await rm(TEST_DIRECTORY, { recursive: true, force: true });
});

test("rejects unauthenticated MCP requests", async () => {
  const response = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "unauthorized-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(response.status, 401);
});

test("advertises the expected six tools", async () => {
  const client = new Client({ name: "tool-list-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
  );
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "create_directory",
      "list_files",
      "read_text_file",
      "run_terminal_command",
      "workspace_info",
      "write_text_file",
    ],
  );
});

test("writes, reads, and lists a workspace file", async () => {
  const relative = "work/notion-cowork-bridge-security-test/roundtrip.txt";
  const written = parseToolText(
    await callTool("write_text_file", { path: relative, content: "alpha\nbeta\n" }),
  );
  assert.equal(written.bytesWritten, 11);

  const read = parseToolText(
    await callTool("read_text_file", { path: relative, start_line: 2, end_line: 2 }),
  );
  assert.equal(read.text, "beta");

  const listed = parseToolText(
    await callTool("list_files", {
      path: "work/notion-cowork-bridge-security-test",
      depth: 0,
    }),
  );
  assert.equal(listed.entries[0].path, relative);
});

test("rejects path traversal and bridge self-modification", async () => {
  const traversal = await callTool("read_text_file", { path: "../../.ssh/config" });
  assert.equal(traversal.isError, true);
  assert.match(parseToolText(traversal), /escapes the configured workspace/i);

  const protectedWrite = await callTool("write_text_file", {
    path: path.join(PROJECT_ROOT, "package.json"),
    content: "{}",
  });
  assert.equal(protectedWrite.isError, true);
  assert.match(parseToolText(protectedWrite), /workspace-relative path/i);
});

test("does not follow symlinks", async () => {
  const linkPath = path.join(TEST_DIRECTORY, "outside-link");
  await rm(linkPath, { force: true });
  await import("node:fs/promises").then(({ symlink }) =>
    symlink(homedir(), linkPath),
  );
  const result = await callTool("list_files", {
    path: "work/notion-cowork-bridge-security-test/outside-link",
  });
  assert.equal(result.isError, true);
  assert.match(parseToolText(result), /symbolic links are not allowed/i);
});

test("terminal uses the normal home and PATH without inheriting the auth token", async () => {
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command:
        "printf 'terminal-ok' > command.txt; printf '%s|%s' \"${MCP_AUTH_TOKEN-unset}\" \"$HOME\"",
      cwd: "work/notion-cowork-bridge-security-test",
      timeout_ms: 10_000,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `unset|${process.env.HOME}`);
  assert.equal(
    await readFile(path.join(TEST_DIRECTORY, "command.txt"), "utf8"),
    "terminal-ok",
  );
});

test("terminal can read elsewhere in the user home folder", async () => {
  assert.equal((await stat(homedir())).isDirectory(), true);
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command: 'test -r "$HOME"',
      cwd: ".",
      timeout_ms: 10_000,
    }),
  );
  assert.equal(result.exitCode, 0);
});

test("terminal can write outside the workspace", async () => {
  const target = path.join(tmpdir(), "notion-cowork-bridge-unrestricted-test");
  await rm(target, { force: true });
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command: `printf unrestricted > ${target}`,
      cwd: ".",
      timeout_ms: 10_000,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(target, "utf8"), "unrestricted");
  await rm(target, { force: true });
});

test("terminal has network access", async () => {
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command: `curl --fail --silent --max-time 3 http://127.0.0.1:${networkProbePort}`,
      cwd: ".",
      timeout_ms: 10_000,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "network-ok");
});

test("terminal can run Bun and install a project", { skip: bunSkipReason() }, async () => {
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command:
        "mkdir -p work/notion-cowork-bridge-security-test/bun-smoke && cd work/notion-cowork-bridge-security-test/bun-smoke && printf '{\"name\":\"bun-smoke\",\"version\":\"1.0.0\",\"dependencies\":{\"is-number\":\"7.0.0\"}}\\n' > package.json && bun install",
      cwd: ".",
      timeout_ms: 30_000,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout + result.stderr, /bun install/i);
  assert.equal(
    (await stat(path.join(TEST_DIRECTORY, "bun-smoke", "bun.lock"))).isFile(),
    true,
  );
});
