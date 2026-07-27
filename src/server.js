import { timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WORKSPACE_ROOT = path.join(homedir(), "Desktop", "notion-workspace");
const WORKSPACE_ROOT = path.resolve(
  process.env.MCP_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
);
const CONTROL_ROOT = SERVER_ROOT;
const COMMAND_SHELL =
  process.env.SHELL?.startsWith("/") ? process.env.SHELL : "/bin/zsh";
const PORT = parseInteger(process.env.MCP_PORT, 3210, 1, 65535);
const HOST = "127.0.0.1";
const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_LIST_ENTRIES = 1_000;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const ALLOWED_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  ...String(process.env.MCP_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
]);

let commandInFlight = false;

if (AUTH_TOKEN.length < 32) {
  throw new Error("MCP_AUTH_TOKEN must be at least 32 characters.");
}

function parseInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveWorkspacePath(userPath = ".") {
  if (typeof userPath !== "string" || userPath.includes("\0")) {
    throw new Error("Path must be a text value without null bytes.");
  }
  if (path.isAbsolute(userPath)) {
    throw new Error("Use a workspace-relative path, not an absolute path.");
  }
  const resolved = path.resolve(WORKSPACE_ROOT, userPath || ".");
  if (!isInside(WORKSPACE_ROOT, resolved)) {
    throw new Error("Path escapes the configured workspace.");
  }
  return resolved;
}

function assertWritableTarget(target) {
  if (isInside(CONTROL_ROOT, target)) {
    throw new Error("The MCP bridge's own files are protected from modification.");
  }
}

async function assertNoSymlinkSegments(target, { allowMissingLeaf = false } = {}) {
  const relative = path.relative(WORKSPACE_ROOT, target);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = WORKSPACE_ROOT;

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed: ${path.relative(WORKSPACE_ROOT, current)}`);
      }
    } catch (error) {
      if (
        error?.code === "ENOENT" &&
        allowMissingLeaf &&
        index === segments.length - 1
      ) {
        return;
      }
      throw error;
    }
  }
}

async function resolveExistingPath(userPath = ".") {
  const candidate = resolveWorkspacePath(userPath);
  await assertNoSymlinkSegments(candidate);
  const canonical = await realpath(candidate);
  if (!isInside(WORKSPACE_ROOT, canonical)) {
    throw new Error("Resolved path escapes the configured workspace.");
  }
  return canonical;
}

async function listWorkspaceDirectory(userPath, depth, includeHidden) {
  const root = await resolveExistingPath(userPath);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error("The requested path is not a directory.");
  }

  const entries = [];
  async function walk(directory, level) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      if (!includeHidden && child.name.startsWith(".")) continue;
      if (entries.length >= MAX_LIST_ENTRIES) return;

      const fullPath = path.join(directory, child.name);
      const relativePath = path.relative(WORKSPACE_ROOT, fullPath) || ".";
      let type = "other";
      if (child.isDirectory()) type = "directory";
      else if (child.isFile()) type = "file";
      else if (child.isSymbolicLink()) type = "symlink";

      const item = { path: relativePath, type };
      if (type === "file") {
        item.size = (await lstat(fullPath)).size;
      }
      entries.push(item);

      if (type === "directory" && level < depth) {
        await walk(fullPath, level + 1);
      }
    }
  }

  await walk(root, 0);
  return {
    path: path.relative(WORKSPACE_ROOT, root) || ".",
    entries,
    truncated: entries.length >= MAX_LIST_ENTRIES,
  };
}

async function readWorkspaceFile(userPath, startLine, endLine) {
  const target = await resolveExistingPath(userPath);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("The requested path is not a regular file.");
  if (info.size > MAX_READ_BYTES) {
    throw new Error(`File exceeds the ${MAX_READ_BYTES}-byte read limit.`);
  }

  const buffer = await readFile(target);
  if (buffer.includes(0)) {
    throw new Error("Binary files are not supported by read_text_file.");
  }
  const lines = buffer.toString("utf8").split(/\r?\n/);
  const from = startLine ?? 1;
  const to = Math.min(endLine ?? lines.length, lines.length);
  if (from > to && lines.length > 0) {
    throw new Error("start_line must be less than or equal to end_line.");
  }

  return {
    path: path.relative(WORKSPACE_ROOT, target),
    startLine: from,
    endLine: to,
    totalLines: lines.length,
    text: lines.slice(from - 1, to).join("\n"),
  };
}

async function writeWorkspaceFile(userPath, content) {
  const target = resolveWorkspacePath(userPath);
  assertWritableTarget(target);
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`Content exceeds the ${MAX_WRITE_BYTES}-byte write limit.`);
  }

  const parent = path.dirname(target);
  await assertNoSymlinkSegments(parent);
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory()) throw new Error("The parent path is not a directory.");
  await assertNoSymlinkSegments(target, { allowMissingLeaf: true });

  const temporary = path.join(
    parent,
    `.notion-mcp-write-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const handle = await open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  return {
    path: path.relative(WORKSPACE_ROOT, target),
    bytesWritten: Buffer.byteLength(content, "utf8"),
  };
}

async function createWorkspaceDirectory(userPath) {
  const target = resolveWorkspacePath(userPath);
  assertWritableTarget(target);
  const parent = path.dirname(target);
  await assertNoSymlinkSegments(parent);
  await mkdir(target, { recursive: false });
  return { path: path.relative(WORKSPACE_ROOT, target), created: true };
}

function commandEnvironment() {
  const environment = { ...process.env };
  delete environment.MCP_AUTH_TOKEN;
  return environment;
}

async function runCommand(command, cwdPath, timeoutMs) {
  if (commandInFlight) {
    throw new Error("Another terminal command is already running. Try again after it finishes.");
  }
  commandInFlight = true;

  try {
    const cwd = await resolveExistingPath(cwdPath);
    const cwdInfo = await stat(cwd);
    if (!cwdInfo.isDirectory()) throw new Error("cwd must be a directory.");

    const timeout = Math.min(timeoutMs, MAX_COMMAND_TIMEOUT_MS);

    return await new Promise((resolve, reject) => {
      const child = spawn(COMMAND_SHELL, ["-lc", command], {
        cwd,
        env: commandEnvironment(),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let outputTruncated = false;
      let timedOut = false;

      const append = (current, chunk) => {
        const remaining = MAX_COMMAND_OUTPUT_BYTES - current.length;
        if (remaining <= 0) {
          outputTruncated = true;
          return current;
        }
        if (chunk.length > remaining) outputTruncated = true;
        return Buffer.concat([current, chunk.subarray(0, remaining)]);
      };

      child.stdout.on("data", (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = append(stderr, chunk);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeout);

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          command,
          cwd: path.relative(WORKSPACE_ROOT, cwd) || ".",
          exitCode: code,
          signal,
          timedOut,
          outputTruncated,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
        });
      });
    });
  } finally {
    commandInFlight = false;
  }
}

function createServer() {
  const server = new McpServer(
    {
      name: "notion-local-workspace",
      version: "1.0.0",
    },
    {
      instructions:
        "File tools are limited to one local workspace. Terminal commands run as the current macOS user without a sandbox: they have normal filesystem and network access and may invoke installed developer tools. Every terminal command is consequential.",
    },
  );

  server.registerTool(
    "workspace_info",
    {
      title: "Workspace access policy",
      description: "Show the local workspace boundary and enforced limits.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      textResult({
        workspaceRoot: WORKSPACE_ROOT,
        fileReadLimitBytes: MAX_READ_BYTES,
        fileWriteLimitBytes: MAX_WRITE_BYTES,
        terminalTimeoutLimitMs: MAX_COMMAND_TIMEOUT_MS,
        terminalShell: COMMAND_SHELL,
        terminalNetworkAccess: true,
        terminalUserHomeOutsideWorkspaceReadAccess: true,
        terminalSystemFileReadAccess: true,
        terminalOutsideWorkspaceWriteAccess: true,
        terminalBridgeFileAccess: true,
        terminalAuthTokenInherited: false,
        fileToolsWorkspaceScoped: true,
      }),
  );

  server.registerTool(
    "list_files",
    {
      title: "List workspace files",
      description:
        "List files and folders within the configured workspace. Symbolic links are shown but never followed.",
      inputSchema: {
        path: z.string().default(".").describe("Workspace-relative directory path."),
        depth: z.number().int().min(0).max(4).default(1),
        include_hidden: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: userPath, depth, include_hidden }) => {
      try {
        return textResult(await listWorkspaceDirectory(userPath, depth, include_hidden));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "read_text_file",
    {
      title: "Read a workspace text file",
      description:
        "Read all or part of a UTF-8 text file within the configured workspace.",
      inputSchema: {
        path: z.string().min(1).describe("Workspace-relative file path."),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: userPath, start_line, end_line }) => {
      try {
        return textResult(await readWorkspaceFile(userPath, start_line, end_line));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "write_text_file",
    {
      title: "Write a workspace text file",
      description:
        "Create or replace a UTF-8 text file inside the configured workspace. The MCP bridge's own files cannot be modified.",
      inputSchema: {
        path: z.string().min(1).describe("Workspace-relative file path."),
        content: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: userPath, content }) => {
      try {
        return textResult(await writeWorkspaceFile(userPath, content));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "create_directory",
    {
      title: "Create a workspace folder",
      description:
        "Create one folder inside an existing workspace directory. Parent folders are not created implicitly.",
      inputSchema: {
        path: z.string().min(1).describe("Workspace-relative folder path."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: userPath }) => {
      try {
        return textResult(await createWorkspaceDirectory(userPath));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "run_terminal_command",
    {
      title: "Run an unrestricted terminal command",
      description:
        "Run a command with the current macOS user's normal shell, PATH, HOME, filesystem access, and network access. Commands start inside the selected workspace directory but are not confined to it. The bridge authentication token is removed from the child environment. Output is capped and a timeout is enforced.",
      inputSchema: {
        command: z.string().min(1).max(20_000),
        cwd: z.string().default(".").describe("Workspace-relative working directory."),
        timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(MAX_COMMAND_TIMEOUT_MS)
          .default(30_000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, cwd, timeout_ms }) => {
      try {
        return textResult(await runCommand(command, cwd, timeout_ms));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

function authorized(req) {
  const presented = req.headers.authorization || "";
  const expected = `Bearer ${AUTH_TOKEN}`;
  const presentedBuffer = Buffer.from(presented);
  const expectedBuffer = Buffer.from(expected);
  return (
    presentedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(presentedBuffer, expectedBuffer)
  );
}

const app = createMcpExpressApp({
  host: HOST,
  allowedHosts: [...ALLOWED_HOSTS],
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "notion-local-workspace" });
});

app.use("/mcp", (req, res, next) => {
  if (!authorized(req)) {
    res.set("WWW-Authenticate", 'Bearer realm="notion-local-workspace"');
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  next();
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    res.on("close", async () => {
      await transport.close();
      await server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").send("Method Not Allowed");
});

app.delete("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").send("Method Not Allowed");
});

const httpServer = app.listen(PORT, HOST, (error) => {
  if (error) throw error;
  console.log(`Notion local MCP listening on http://${HOST}:${PORT}/mcp`);
  console.log(`Workspace: ${WORKSPACE_ROOT}`);
  console.log(`Allowed hosts: ${[...ALLOWED_HOSTS].join(", ")}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
