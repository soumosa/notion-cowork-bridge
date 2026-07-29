import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as createHttpRequest,
} from "node:http";
import { connect as connectTcp } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const IS_WINDOWS = process.platform === "win32";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A temp directory, not two levels above the repo. The suite deletes its
// workspace on the way out, and pointing that at a real directory in someone's
// home is a bad thing to ship in a file people are told to read.
const WORKSPACE_ROOT =
  process.env.TEST_WORKSPACE_ROOT ||
  // realpath, because macOS hands out /var/folders/... which is a symlink to
  // /private/var/folders/..., and the server resolves symlinks before it
  // compares. Without this every path looks like it is outside the workspace.
  realpathSync(mkdtempSync(path.join(tmpdir(), "notion-bridge-workspace-")));
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

function publicHttp(requestPath, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = createHttpRequest({
      host: "127.0.0.1",
      port: PORT,
      path: requestPath,
      method,
      headers: {
        host: "public.example.test",
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

function publicWebSocket(requestPath, cookie, host = "public.example.test") {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(PORT, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket preview handshake timed out."));
    }, 5_000);
    socket.once("connect", () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        `Cookie: ${cookie}`,
        "",
        "",
      ].join("\r\n"));
    });
    socket.once("data", (chunk) => {
      clearTimeout(timer);
      const response = chunk.toString("utf8");
      socket.destroy();
      resolve(response);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
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

  networkProbe = createHttpServer((request, response) => {
    if (request.url === "/browser-fixture") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <button id="counter" onclick="this.textContent = 'Count ' + (Number(this.dataset.count || 0) + 1); this.dataset.count = Number(this.dataset.count || 0) + 1">Count 0</button>
        <input id="upload" type="file" aria-label="Upload fixture">
        <script>console.log("browser fixture ready")</script>`);
      return;
    }
    if (request.url === "/echo") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          body,
          contentLength: request.headers["content-length"] || null,
        }));
      });
      return;
    }
    if (request.url === "/redirect-away") {
      response.writeHead(302, { location: "https://example.com/" });
      response.end();
      return;
    }
    if (request.url === "/cookie") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "set-cookie": [
          "__Host-notion_preview=attacker; Path=/; Secure",
          "app_session=allowed; Path=/",
        ],
      });
      response.end("cookie fixture");
      return;
    }
    // The content type matters: without it PowerShell's Invoke-WebRequest
    // cannot tell the body is text and hands back a byte array instead.
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("network-ok");
  });
  networkProbe.on("upgrade", (request, socket) => {
    if (request.url !== "/hmr") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.end([
      "HTTP/1.1 101 Switching Protocols",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "",
      "",
    ].join("\r\n"));
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
      MCP_ALLOWED_HOSTS: "public.example.test",
      MCP_NGROK_PREVIEW_URL: "",
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

test("browser references click elements and upload workspace files", async (t) => {
  const status = parseToolText(await callTool("browser_status"));
  if (!status.available) {
    t.skip("Chrome, Chromium, or Edge is not installed on this test machine.");
    return;
  }
  const uploadPath = `${RELATIVE_DIR}/browser-upload.txt`;
  await writeFile(path.join(TEST_DIRECTORY, "browser-upload.txt"), "upload fixture");
  const opened = parseToolText(await callTool("browser_open", {
    port: networkProbePort,
    path: "/browser-fixture",
  }));
  try {
    const snapshot = parseToolText(await callTool("browser_snapshot", { session_id: opened.session_id }));
    const button = snapshot.items.find((item) => item.tag === "button");
    const upload = snapshot.items.find((item) => item.type === "file");
    assert.ok(button?.ref);
    assert.ok(upload?.ref);

    const clicked = parseToolText(await callTool("browser_interact", {
      session_id: opened.session_id,
      action: "click",
      ref: button.ref,
    }));
    assert.equal(
      clicked.items.some((item) => item.tag === "button" && item.text === "Count 1"),
      true,
    );
    const refreshedUpload = clicked.items.find((item) => item.type === "file");
    assert.ok(refreshedUpload?.ref);
    const staleUpload = await callTool("browser_upload", {
      session_id: opened.session_id,
      ref: upload.ref,
      path: uploadPath,
    });
    assert.equal(staleUpload.isError, true);
    assert.equal(
      JSON.parse(staleUpload.content.find((item) => item.type === "text").text).code,
      "E_STALE_REF",
    );

    const uploaded = parseToolText(await callTool("browser_upload", {
      session_id: opened.session_id,
      ref: refreshedUpload.ref,
      path: uploadPath,
    }));
    assert.equal(typeof uploaded, "object", uploaded);
    assert.equal(uploaded.uploaded, uploadPath);
    const uploadedName = parseToolText(await callTool("browser_eval", {
      session_id: opened.session_id,
      script: "document.querySelector('#upload').files[0].name",
    }));
    assert.equal(uploadedName.value, "browser-upload.txt");

    const image = await callTool("browser_screenshot", { session_id: opened.session_id });
    assert.equal(image.isError, undefined);
    assert.equal(image.content[0].type, "image");
  } finally {
    await callTool("browser_close", { session_id: opened.session_id });
  }
});

test("browser_eval accepts statement blocks without an IIFE", async (t) => {
  const status = parseToolText(await callTool("browser_status"));
  if (!status.available) {
    t.skip("Chrome, Chromium, or Edge is not installed on this test machine.");
    return;
  }
  const opened = parseToolText(await callTool("browser_open", {
    port: networkProbePort,
    path: "/browser-fixture",
  }));
  try {
    const result = parseToolText(await callTool("browser_eval", {
      session_id: opened.session_id,
      script: "const answer = 40 + 2; return answer;",
    }));
    assert.equal(result.value, 42);
  } finally {
    await callTool("browser_close", { session_id: opened.session_id });
  }
});

test("capture_screenshot saves a fresh PNG without hanging on Chrome descendants", async (t) => {
  const status = parseToolText(await callTool("browser_status"));
  if (!status.available) {
    t.skip("Chrome, Chromium, or Edge is not installed on this test machine.");
    return;
  }
  const outputPath = `${RELATIVE_DIR}/compatibility-screenshot.png`;
  const captured = parseToolText(await callTool("capture_screenshot", {
    port: networkProbePort,
    path: "/browser-fixture",
    output_path: outputPath,
    width: 800,
    height: 600,
  }));
  assert.equal(captured.path, outputPath);
  const bytes = await readFile(path.join(TEST_DIRECTORY, "compatibility-screenshot.png"));
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("capture_screenshot preserves an existing file when navigation is blocked", async (t) => {
  const status = parseToolText(await callTool("browser_status"));
  if (!status.available) {
    t.skip("Chrome, Chromium, or Edge is not installed on this test machine.");
    return;
  }
  const filename = "failed-screenshot.png";
  const outputPath = `${RELATIVE_DIR}/${filename}`;
  await writeFile(path.join(TEST_DIRECTORY, filename), "keep this");
  const result = await callTool("capture_screenshot", {
    port: networkProbePort,
    path: "/redirect-away",
    output_path: outputPath,
    width: 800,
    height: 600,
  });
  assert.equal(result.isError, true);
  assert.equal(await readFile(path.join(TEST_DIRECTORY, filename), "utf8"), "keep this");
});

test("http_request supplies Content-Length for a string body", async () => {
  const result = parseToolText(await callTool("http_request", {
    port: networkProbePort,
    path: "/echo",
    method: "POST",
    headers: { "Content-Length": "999" },
    body: "hello body",
    mode: "text",
  }));
  const echoed = JSON.parse(result.body);
  assert.equal(echoed.body, "hello body");
  assert.equal(echoed.contentLength, String(Buffer.byteLength("hello body")));
});

test("advertises exactly the tools it means to", async () => {
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
      "browser_close",
      "browser_console",
      "browser_eval",
      "browser_interact",
      "browser_network",
      "browser_open",
      "browser_screenshot",
      "browser_snapshot",
      "browser_status",
      "browser_upload",
      "capture_screenshot",
      "create_directory",
      "delete_path",
      "edit_text_file",
      "glob_files",
      "http_probe",
      "http_request",
      "list_background_processes",
      "list_files",
      "move_path",
      "read_bytes",
      "read_media_file",
      "read_process_output",
      "read_text_file",
      "run_terminal_command",
      "search_text",
      "share_preview",
      "start_background_process",
      "stop_background_process",
      "stop_preview",
      "workspace_info",
      "write_text_file",
    ],
  );
});

// Adding a tool is the moment to decide whether it is destructive and whether
// it reaches the network. Declaring it is cheap; discovering it later is not.
test("every tool declares a title, a description and full annotations", async () => {
  const client = new Client({ name: "contract", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
  );
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();

  for (const tool of tools) {
    assert.ok(tool.description, `${tool.name} has no description`);
    assert.ok(tool.title || tool.annotations?.title, `${tool.name} has no title`);
    for (const hint of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ]) {
      assert.equal(
        typeof tool.annotations?.[hint],
        "boolean",
        `${tool.name} does not declare ${hint}`,
      );
    }
  }
  const readMedia = tools.find((tool) => tool.name === "read_media_file");
  assert.equal(readMedia.annotations.readOnlyHint, true);
  assert.equal(readMedia.annotations.destructiveHint, false);
  const capture = tools.find((tool) => tool.name === "capture_screenshot");
  assert.equal(capture.annotations.readOnlyHint, false);
  assert.equal(capture.annotations.destructiveHint, true);
});

test("share_preview securely multiplexes one preview on the existing MCP host", async () => {
  assert.equal((await publicHttp("/")).status, 404);
  const shared = parseToolText(await callTool("share_preview", {
    port: networkProbePort,
    ttl_minutes: 1,
    confirm_public: true,
    allow_unmanaged: true,
  }));
  const bootstrap = new URL(shared.url);
  assert.equal(bootstrap.origin, "https://public.example.test");

  const anonymous = await publicHttp("/");
  assert.equal(anonymous.status, 404);

  const authenticated = await publicHttp(bootstrap.pathname);
  assert.equal(authenticated.status, 302);
  assert.equal(authenticated.headers.location, "/");
  const cookie = authenticated.headers["set-cookie"][0].split(";", 1)[0];
  assert.match(cookie, /^__Host-notion_preview=/);

  const reused = await publicHttp(bootstrap.pathname);
  assert.equal(reused.status, 404);

  const root = await publicHttp("/", { headers: { cookie } });
  assert.equal(root.status, 200);
  assert.equal(root.body, "network-ok");
  assert.equal(root.headers["cache-control"], "no-store");
  assert.equal(root.headers["referrer-policy"], "no-referrer");

  const cookieAttempt = await publicHttp("/cookie", { headers: { cookie } });
  assert.deepEqual(cookieAttempt.headers["set-cookie"], [
    "app_session=allowed; Path=/",
  ]);

  const forbidden = await publicHttp("/%2540fs/private/file", {
    headers: { cookie },
  });
  assert.equal(forbidden.status, 404);

  const mcp = await publicHttp("/mcp", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
    },
  });
  assert.equal(mcp.status, 401);
  assert.match(mcp.body, /Unauthorized/);
  const health = await publicHttp("/health", { headers: { cookie } });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: "ok" });

  const second = await callTool("share_preview", {
    port: networkProbePort,
    ttl_minutes: 1,
    confirm_public: true,
    allow_unmanaged: true,
  });
  assert.equal(second.isError, true);
  assert.equal(
    JSON.parse(second.content.find((item) => item.type === "text").text).code,
    "E_BUSY",
  );

  const wrongHost = await publicWebSocket("/hmr", cookie, "evil.example.test");
  assert.match(wrongHost, /^HTTP\/1\.1 404 Not Found/);
  const websocket = await publicWebSocket("/hmr", cookie);
  assert.match(websocket, /^HTTP\/1\.1 101 Switching Protocols/);

  const stopped = parseToolText(await callTool("stop_preview", { id: shared.id }));
  assert.equal(stopped.stopped, 1);
  assert.equal((await publicHttp("/", { headers: { cookie } })).status, 404);
  const revokedWebSocket = await publicWebSocket("/hmr", cookie);
  assert.match(revokedWebSocket, /^HTTP\/1\.1 404 Not Found/);
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
  for (const [event, needle] of [
    ["write_text_file", "audited.txt"],
    ["create_directory", "audited-dir"],
  ]) {
    for (const phase of ["start", "finish"]) {
      assert.ok(
        records.some(
          (entry) =>
            entry.event === `${event}.${phase}` && entry.path.includes(needle),
        ),
        `no ${event}.${phase} record for ${needle}`,
      );
    }
  }

  // The start record is the one that survives a crash, so it has to come first.
  const startIndex = records.findIndex((e) => e.event === "write_text_file.start");
  const finishIndex = records.findIndex((e) => e.event === "write_text_file.finish");
  assert.ok(startIndex >= 0 && startIndex < finishIndex);
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

// ---------------------------------------------------------------------------
// Auth edge cases. Only "no header at all" was covered above; a wrong token
// of the same length as the real one is the case that actually exercises
// timingSafeEqual rather than the length check that runs before it.
// ---------------------------------------------------------------------------

function initializeRequestBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "auth-edge-case-test", version: "1.0.0" },
    },
  });
}

async function postWithAuthHeader(headerValue) {
  const headers = { "content-type": "application/json" };
  if (headerValue !== undefined) headers.Authorization = headerValue;
  return fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers,
    body: initializeRequestBody(),
  });
}

test("rejects a wrong token of the same length as the real one", async () => {
  // Same length as TOKEN means the length check in authorized() passes and
  // timingSafeEqual itself has to be the thing that says no.
  const sameLengthWrongToken = "z".repeat(TOKEN.length);
  assert.notEqual(sameLengthWrongToken, TOKEN);
  const response = await postWithAuthHeader(`Bearer ${sameLengthWrongToken}`);
  assert.equal(response.status, 401);
});

test("rejects a wrong token of a different length", async () => {
  const response = await postWithAuthHeader("Bearer too-short-to-be-right");
  assert.equal(response.status, 401);
});

test("rejects a malformed Authorization header", async () => {
  const response = await postWithAuthHeader("NotBearer whatever-this-is");
  assert.equal(response.status, 401);
});

test("rejects a lowercase bearer scheme", async () => {
  // HTTP scheme names are conventionally case-insensitive, but authorized()
  // does an exact string comparison against "Bearer <token>", so this is
  // expected to fail rather than a bug to fix.
  const response = await postWithAuthHeader(`bearer ${TOKEN}`);
  assert.equal(response.status, 401);
});

test("authentication failures are written to the audit log", async () => {
  const before = (await readAuditRecords()).filter((r) => r.event === "auth.failure").length;
  const response = await postWithAuthHeader("Bearer some-wrong-token-that-is-not-the-real-one");
  assert.equal(response.status, 401);

  const records = await readAuditRecords();
  const failures = records.filter((r) => r.event === "auth.failure");
  assert.ok(failures.length > before, "expected at least one new auth.failure record");
  const latest = failures.at(-1);
  assert.equal(typeof latest.source, "string");
  assert.equal(typeof latest.failureCount, "number");
  assert.equal(typeof latest.delayMs, "number");
  // The bearer token must never appear in the log, including in a failure record.
  const raw = await readFile(auditPath, "utf8");
  assert.equal(raw.includes(TOKEN), false);
});

// ---------------------------------------------------------------------------
// Limits and truncation. Matches the constants in src/lib/config.js; kept
// literal here rather than imported so this file never has to import
// MCP_AUTH_TOKEN-checking modules into the test process itself.
// ---------------------------------------------------------------------------

const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 1000;

test("the write cap admits exactly the limit and rejects one byte more", async () => {
  const atCap = parseToolText(
    await callTool("write_text_file", {
      path: `${RELATIVE_DIR}/write-cap-exact.txt`,
      content: "a".repeat(MAX_WRITE_BYTES),
    }),
  );
  assert.equal(atCap.bytesWritten, MAX_WRITE_BYTES);

  const overCap = await callTool("write_text_file", {
    path: `${RELATIVE_DIR}/write-cap-over.txt`,
    content: "a".repeat(MAX_WRITE_BYTES + 1),
  });
  assert.equal(overCap.isError, true);
  assert.match(parseToolText(overCap), /E_TOO_LARGE/);
});

test("the read cap admits a file one byte under the limit and rejects one over", async () => {
  await callTool("write_text_file", {
    path: `${RELATIVE_DIR}/read-cap-under.txt`,
    content: "a".repeat(MAX_READ_BYTES - 1),
  });
  const under = parseToolText(
    await callTool("read_text_file", { path: `${RELATIVE_DIR}/read-cap-under.txt` }),
  );
  assert.equal(under.text.length, MAX_READ_BYTES - 1);

  await callTool("write_text_file", {
    path: `${RELATIVE_DIR}/read-cap-over.txt`,
    content: "a".repeat(MAX_READ_BYTES + 1),
  });
  const over = await callTool("read_text_file", { path: `${RELATIVE_DIR}/read-cap-over.txt` });
  assert.equal(over.isError, true);
  assert.match(parseToolText(over), /E_TOO_LARGE/);
});

// A file of exactly MAX_READ_BYTES used to be rejected when its last line had
// no trailing newline: the line accounting charged a separator byte after every
// emitted line, including the last one. N lines carry N-1 separators, so both
// shapes of the same file size have to read.
test("a file of exactly the read cap reads whether or not it ends with a newline", async () => {
  await callTool("write_text_file", {
    path: `${RELATIVE_DIR}/read-cap-no-newline.txt`,
    content: "a".repeat(MAX_READ_BYTES),
  });
  const noTrailingNewline = parseToolText(
    await callTool("read_text_file", { path: `${RELATIVE_DIR}/read-cap-no-newline.txt` }),
  );
  assert.equal(noTrailingNewline.text.length, MAX_READ_BYTES);

  await callTool("write_text_file", {
    path: `${RELATIVE_DIR}/read-cap-with-newline.txt`,
    content: `${"a".repeat(MAX_READ_BYTES - 1)}\n`,
  });
  const withTrailingNewline = parseToolText(
    await callTool("read_text_file", { path: `${RELATIVE_DIR}/read-cap-with-newline.txt` }),
  );
  assert.equal(withTrailingNewline.text.length, MAX_READ_BYTES - 1);
});

test("list_files truncates at MAX_LIST_ENTRIES and reports truncated: true", async () => {
  const manyFilesDir = path.join(TEST_DIRECTORY, "many-files");
  await mkdir(manyFilesDir, { recursive: true });
  const extra = 25;
  for (let i = 0; i < MAX_LIST_ENTRIES + extra; i += 1) {
    await writeFile(path.join(manyFilesDir, `f${i}.txt`), "");
  }

  const listed = parseToolText(
    await callTool("list_files", { path: `${RELATIVE_DIR}/many-files`, depth: 0 }),
  );
  assert.equal(listed.entries.length, MAX_LIST_ENTRIES);
  assert.equal(listed.truncated, true);
});

test(
  "a UTF-8 emoji round-trips exactly through write_text_file and read_text_file",
  async () => {
    const content = "hello 😀 world — café résumé 中文\n";
    await callTool("write_text_file", { path: `${RELATIVE_DIR}/emoji.txt`, content });
    const read = parseToolText(
      await callTool("read_text_file", { path: `${RELATIVE_DIR}/emoji.txt` }),
    );
    assert.equal(read.text, content.trimEnd());
    assert.equal(read.hasTrailingNewline, true);
  },
);

test("run_terminal_command truncates combined output over the limit and marks outputTruncated", async () => {
  const command = IS_WINDOWS
    ? "$w=[Console]::OpenStandardOutput();$b=[System.Text.Encoding]::UTF8.GetBytes('START-');$w.Write($b,0,$b.Length);" +
      "$line=[System.Text.Encoding]::UTF8.GetBytes([char]::ConvertFromUtf32(0x1F600)+\"`n\");" +
      "for($i=0;$i -lt 100000;$i++){$w.Write($line,0,$line.Length)};" +
      "$e=[System.Text.Encoding]::UTF8.GetBytes('-END');$w.Write($e,0,$e.Length);$w.Flush()"
    : "printf 'START-'; yes 😀 | head -n 100000; printf -- '-END'";
  const result = parseToolText(
    await callTool("run_terminal_command", { command, cwd: ".", timeout_ms: 20_000 }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputTruncated, true);
  assert.ok(result.stdout.startsWith("START-"));
  assert.ok(result.stdout.endsWith("-END"));
  // The head/tail cut points fall inside the repeated multi-byte character
  // (a 4-byte emoji does not evenly divide the head or tail budget), so this
  // is exactly the shape of input that used to turn into U+FFFD when
  // truncation just sliced bytes and called .toString("utf8"). None should
  // appear now that the collector holds back an incomplete character
  // instead of emitting a replacement for it.
  assert.equal(result.stdout.includes("�"), false);
});

test("run_terminal_command accepts a command of exactly 20,000 characters and rejects one longer", async () => {
  const prefix = IS_WINDOWS ? "Write-Output 'command-cap-ok'; #" : "printf 'command-cap-ok'; #";
  const padTo = (length) => prefix + "x".repeat(length - prefix.length);

  const atCap = padTo(20_000);
  assert.equal(atCap.length, 20_000);
  const atCapResult = parseToolText(
    await callTool("run_terminal_command", { command: atCap, cwd: ".", timeout_ms: 10_000 }),
  );
  assert.equal(atCapResult.exitCode, 0);
  assert.equal(atCapResult.stdout.trim(), "command-cap-ok");

  const overCap = padTo(20_001);
  const overCapResult = await callTool("run_terminal_command", {
    command: overCap,
    cwd: ".",
    timeout_ms: 10_000,
  });
  assert.equal(overCapResult.isError, true);
  assert.match(parseToolText(overCapResult), /20000|too big/i);
});

// ---------------------------------------------------------------------------
// Concurrency. The lock now queues for up to ~10 seconds instead of failing
// immediately, so two quick commands fired at once should both succeed
// rather than one of them getting E_BUSY.
// ---------------------------------------------------------------------------

test("two simultaneous run_terminal_command calls both complete rather than one failing fast", async () => {
  const [first, second] = await Promise.all([
    callTool("run_terminal_command", { command: "echo concurrency-one", cwd: ".", timeout_ms: 15_000 }),
    callTool("run_terminal_command", { command: "echo concurrency-two", cwd: ".", timeout_ms: 15_000 }),
  ]);
  const firstResult = parseToolText(first);
  const secondResult = parseToolText(second);
  assert.equal(first.isError, undefined);
  assert.equal(second.isError, undefined);
  assert.equal(firstResult.exitCode, 0);
  assert.equal(secondResult.exitCode, 0);
  assert.equal(firstResult.stdout.trim(), "concurrency-one");
  assert.equal(secondResult.stdout.trim(), "concurrency-two");
});

// ---------------------------------------------------------------------------
// Filesystem correctness.
// ---------------------------------------------------------------------------

test(
  "a 0755 file survives a rewrite with its mode intact",
  { skip: windowsOnly("POSIX permission bits are not meaningful on Windows.") },
  async () => {
    const target = path.join(TEST_DIRECTORY, "executable.sh");
    await writeFile(target, "#!/bin/sh\necho original\n");
    await chmod(target, 0o755);

    await callTool("write_text_file", {
      path: `${RELATIVE_DIR}/executable.sh`,
      content: "#!/bin/sh\necho replaced\n",
    });

    const mode = (await stat(target)).mode & 0o777;
    assert.equal(mode, 0o755);
  },
);

test("a write that fails at the rename step leaves no leftover temp file behind", async () => {
  // Writing to a path that already exists as a directory reaches the rename
  // step (the temp file is created successfully) and fails there with
  // EISDIR, which is exactly the failure mode a leftover temp file would
  // come from if the cleanup on that path were missing.
  const dirPath = `${RELATIVE_DIR}/rename-failure-dir`;
  await callTool("create_directory", { path: dirPath });

  const result = await callTool("write_text_file", { path: dirPath, content: "x" });
  assert.equal(result.isError, true);
  assert.match(parseToolText(result), /E_IS_DIRECTORY/);

  const siblingEntries = await readdir(TEST_DIRECTORY);
  const leftoverTempFiles = siblingEntries.filter((name) => name.startsWith(".notion-mcp-write-"));
  assert.deepEqual(leftoverTempFiles, []);
});

test("create_directory refuses to create a directory whose parent does not exist", async () => {
  const result = await callTool("create_directory", {
    path: `${RELATIVE_DIR}/no-such-parent/child`,
  });
  assert.equal(result.isError, true);
  assert.match(parseToolText(result), /E_NOT_FOUND/);

  await assert.rejects(stat(path.join(TEST_DIRECTORY, "no-such-parent", "child")));
});

test("concurrent writes to the same path never produce a partial or mixed file", async () => {
  const relative = `${RELATIVE_DIR}/concurrent-target.txt`;
  const size = 200_000; // large enough that a naive write would take measurable time
  const payloads = ["A", "B", "C", "D", "E"].map((char) => char.repeat(size));

  const results = await Promise.all(
    payloads.map((content) => callTool("write_text_file", { path: relative, content })),
  );
  for (const result of results) {
    assert.equal(result.isError, undefined, "every concurrent write should succeed");
  }

  const finalContent = await readFile(path.join(TEST_DIRECTORY, "concurrent-target.txt"), "utf8");
  // Whichever write landed last, the file must be entirely one of the five
  // payloads - never a splice of two of them, and never short.
  assert.equal(finalContent.length, size);
  const firstChar = finalContent[0];
  assert.ok(["A", "B", "C", "D", "E"].includes(firstChar));
  assert.equal(finalContent, firstChar.repeat(size));
});
