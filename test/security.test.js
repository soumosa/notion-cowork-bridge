import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const IS_WINDOWS = process.platform === "win32";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOT =
  process.env.TEST_WORKSPACE_ROOT || path.resolve(PROJECT_ROOT, "../..");
const PORT = 33210;
const TOKEN = "local-test-token-0123456789-0123456789";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const RELATIVE_DIR = path.posix.join("work", "notion-cowork-bridge-security-test");
const TEST_DIRECTORY = path.join(
  WORKSPACE_ROOT,
  "work",
  "notion-cowork-bridge-security-test",
);

let child;
let networkProbe;
let networkProbePort;
let auditDirectory;
let auditPath;

function bunSkipReason() {
  // The Bun case is written in POSIX shell, so it only runs where that shell is.
  if (IS_WINDOWS) return "The Bun case uses POSIX shell syntax.";
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  return probe.status === 0 ? false : "Bun is not installed on this machine.";
}

function windowsOnly(reason = "Windows-only path rules.") {
  return IS_WINDOWS ? false : reason;
}

/**
 * The suite exercises the real shell, so the commands themselves have to be
 * written twice. Everything else about each test is identical.
 */
const shellCommands = {
  writeFileAndEcho: IS_WINDOWS
    ? "Set-Content -NoNewline -Path command.txt -Value 'terminal-ok'; " +
      "$t = if ($env:MCP_AUTH_TOKEN) { $env:MCP_AUTH_TOKEN } else { 'unset' }; " +
      "Write-Output \"$t|$env:USERPROFILE\""
    : "printf 'terminal-ok' > command.txt; " +
      'printf \'%s|%s\' "${MCP_AUTH_TOKEN-unset}" "$HOME"',
  readHome: IS_WINDOWS
    ? "if (Test-Path $env:USERPROFILE) { exit 0 } else { exit 1 }"
    : 'test -r "$HOME"',
  writeOutside: (target) =>
    IS_WINDOWS
      ? `Set-Content -NoNewline -Path '${target}' -Value 'unrestricted'`
      : `printf unrestricted > '${target}'`,
  fetchUrl: (url) =>
    IS_WINDOWS
      ? `(Invoke-WebRequest -UseBasicParsing -Uri '${url}' -TimeoutSec 3).Content`
      : `curl --fail --silent --max-time 3 ${url}`,
};

const expectedHome = IS_WINDOWS ? process.env.USERPROFILE : process.env.HOME;

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

async function readAuditRecords() {
  const raw = await readFile(auditPath, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
  auditDirectory = await mkdtemp(path.join(tmpdir(), "notion-bridge-audit-"));
  auditPath = path.join(auditDirectory, "audit.jsonl");

  networkProbe = createHttpServer((_request, response) => {
    // The content type matters: without it PowerShell's Invoke-WebRequest
    // cannot tell the body is text and hands back a byte array instead.
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
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
      MCP_AUDIT_LOG: auditPath,
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
  await rm(auditDirectory, { recursive: true, force: true });
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

test("the health endpoint does not name the service", async () => {
  const response = await fetch(`${BASE_URL}/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: "ok" });
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

test("workspace_info reports the platform and the audit log location", async () => {
  const info = parseToolText(await callTool("workspace_info"));
  assert.equal(info.platform, process.platform);
  assert.equal(info.auditLog, auditPath);
  assert.equal(info.fileToolsWorkspaceScoped, true);
  assert.equal(info.terminalAuthTokenInherited, false);
});

test("writes, reads, and lists a workspace file", async () => {
  const relative = `${RELATIVE_DIR}/roundtrip.txt`;
  const written = parseToolText(
    await callTool("write_text_file", { path: relative, content: "alpha\nbeta\n" }),
  );
  assert.equal(written.bytesWritten, 11);

  const read = parseToolText(
    await callTool("read_text_file", { path: relative, start_line: 2, end_line: 2 }),
  );
  assert.equal(read.text, "beta");

  const listed = parseToolText(
    await callTool("list_files", { path: RELATIVE_DIR, depth: 0 }),
  );
  assert.equal(listed.entries.some((entry) => entry.type === "file"), true);
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

test("rejects Windows drive-relative paths", { skip: windowsOnly() }, async () => {
  const result = await callTool("read_text_file", { path: "C:windows/win.ini" });
  assert.equal(result.isError, true);
  assert.match(parseToolText(result), /drive-relative/i);
});

test(
  "rejects NTFS alternate data streams",
  { skip: windowsOnly() },
  async () => {
    const result = await callTool("write_text_file", {
      path: `${RELATIVE_DIR}/notes.txt:hidden`,
      content: "x",
    });
    assert.equal(result.isError, true);
    assert.match(parseToolText(result), /colons are not allowed/i);
  },
);

test(
  "rejects Windows reserved device names",
  { skip: windowsOnly() },
  async () => {
    const result = await callTool("write_text_file", {
      path: `${RELATIVE_DIR}/CON`,
      content: "x",
    });
    assert.equal(result.isError, true);
    assert.match(parseToolText(result), /reserved device name/i);
  },
);

test("does not follow symlinks", async () => {
  const linkPath = path.join(TEST_DIRECTORY, "outside-link");
  await rm(linkPath, { force: true });
  const { symlink } = await import("node:fs/promises");
  try {
    await symlink(homedir(), linkPath, "junction");
  } catch (error) {
    // Unprivileged Windows accounts cannot always create links.
    if (IS_WINDOWS && (error.code === "EPERM" || error.code === "EACCES")) return;
    throw error;
  }
  const result = await callTool("list_files", {
    path: `${RELATIVE_DIR}/outside-link`,
  });
  assert.equal(result.isError, true);
  assert.match(parseToolText(result), /symbolic links are not allowed/i);
});

test("terminal uses the normal home and PATH without inheriting the auth token", async () => {
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command: shellCommands.writeFileAndEcho,
      cwd: RELATIVE_DIR,
      timeout_ms: 20_000,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), `unset|${expectedHome}`);
  assert.equal(
    await readFile(path.join(TEST_DIRECTORY, "command.txt"), "utf8"),
    "terminal-ok",
  );
});

test("every terminal command is written to the audit log", async () => {
  const marker = `audit-probe-${Date.now()}`;
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command: `echo ${marker}`,
      cwd: RELATIVE_DIR,
      timeout_ms: 20_000,
    }),
  );
  assert.equal(result.exitCode, 0);

  const records = await readAuditRecords();
  const started = records.find(
    (entry) =>
      entry.event === "run_terminal_command.start" &&
      entry.command.includes(marker),
  );
  const finished = records.find(
    (entry) =>
      entry.event === "run_terminal_command.finish" &&
      entry.command.includes(marker),
  );

  assert.ok(started, "expected a start record");
  assert.ok(finished, "expected a finish record");
  assert.equal(finished.exitCode, 0);
  assert.equal(typeof finished.durationMs, "number");
  assert.ok(Date.parse(started.time) > 0);

  // The bearer token must never reach the log.
  const raw = await readFile(auditPath, "utf8");
  assert.equal(raw.includes(TOKEN), false);
});

test("audit log records writes and directory creation", async () => {
  await callTool("write_text_file", {
    path: `${RELATIVE_DIR}/audited.txt`,
    content: "logged",
  });
  await callTool("create_directory", { path: `${RELATIVE_DIR}/audited-dir` });

  const records = await readAuditRecords();
  assert.ok(
    records.some(
      (entry) =>
        entry.event === "write_text_file" && entry.path.includes("audited.txt"),
    ),
  );
  assert.ok(
    records.some(
      (entry) =>
        entry.event === "create_directory" &&
        entry.path.includes("audited-dir"),
    ),
  );
});

test("terminal can read elsewhere in the user home folder", async () => {
  assert.equal((await stat(homedir())).isDirectory(), true);
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command: shellCommands.readHome,
      cwd: ".",
      timeout_ms: 20_000,
    }),
  );
  assert.equal(result.exitCode, 0);
});

test("terminal can write outside the workspace", async () => {
  const target = path.join(tmpdir(), "notion-cowork-bridge-unrestricted-test");
  await rm(target, { force: true });
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command: shellCommands.writeOutside(target),
      cwd: ".",
      timeout_ms: 20_000,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal((await readFile(target, "utf8")).trim(), "unrestricted");
  await rm(target, { force: true });
});

test("terminal has network access", async () => {
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command: shellCommands.fetchUrl(`http://127.0.0.1:${networkProbePort}`),
      cwd: ".",
      timeout_ms: 20_000,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "network-ok");
});

test("enforces the command timeout", async () => {
  const sleep = IS_WINDOWS ? "Start-Sleep -Seconds 10" : "sleep 10";
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command: sleep,
      cwd: ".",
      timeout_ms: 1_000,
    }),
  );
  assert.equal(result.timedOut, true);
});

test("terminal can run Bun and install a project", { skip: bunSkipReason() }, async () => {
  const result = parseToolText(
    await callTool("run_terminal_command", {
      command:
        "mkdir -p work/notion-cowork-bridge-security-test/bun-smoke && cd work/notion-cowork-bridge-security-test/bun-smoke && printf '{\"name\":\"bun-smoke\",\"version\":\"1.0.0\",\"dependencies\":{\"is-number\":\"7.0.0\"}}\\n' > package.json && bun install",
      cwd: ".",
      timeout_ms: 60_000,
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout + result.stderr, /bun install/i);
  assert.equal(
    (await stat(path.join(TEST_DIRECTORY, "bun-smoke", "bun.lock"))).isFile(),
    true,
  );
});
